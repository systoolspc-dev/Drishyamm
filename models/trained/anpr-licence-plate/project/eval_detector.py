"""
eval_detector.py — plate DETECTOR evaluation on a YOLO-format folder.

    images/<split>/*.jpg + labels/<split>/*.txt (class cx cy w h, normalised) + data.yaml
    or  --images DIR --labels DIR

Two views of the same model:
  1. mAP50 / mAP50-95 from ultralytics `YOLO(weights).val(...)` — the standard number.
  2. A SMALL-OBJECT breakdown the standard number hides: predictions are matched to
     GT boxes greedily at IoU ≥ 0.5 (anpr_metrics.match_boxes) and recall is reported
     per GT box height bucket (<20, 20–30, 30–45, ≥45 px in the image's own pixels —
     the worker's saved frames are 1280 px wide), plus precision at the worker's
     operating point (ANPR_PLATE_CONF, 0.30), false positives per image and per
     NEGATIVE image (an image with no GT box: OSD captions, signboards, stickers),
     and AP@0.5 recomputed from all predictions as a cross-check of (1).

WHAT COUNTS AS GROUND TRUTH. data/train/det is built by export_labels.py from the
worker's own confirmed detections (records/*_frame.jpg + the bbox the detector
produced). Scoring the detector on its own output measures agreement with
itself, not accuracy: boxes it missed are not in the set at all, and every box
it drew is "right" by construction. So this script REFUSES that folder unless
--allow-self-labels is passed, and then stamps every number with
independent_gt=false. Independent GT means: boxes drawn BY HAND on frames the
model never trained on, including NEGATIVES — vehicles with text (dealer
stickers, "BUGATTI" decals), shop signs, OSD captions, railings — so false
positives can be counted at all. ~200 frames across cameras, day and night,
with every plate boxed (tiny ones included) is the minimum useful set.

Run inside the worker container from this folder:
    python eval_detector.py --data /path/to/independent/data.yaml --split val
    python eval_detector.py --data data/train/det/data.yaml --allow-self-labels   # self-agreement only
Writes data/eval/detector_<stamp>.json.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import anpr_metrics as M  # noqa: E402

H_EDGES = [20, 30, 45]
H_LABELS = ["<20px", "20-30px", "30-45px", ">=45px"]
SELF_LABEL_MSG = "NOT MEASURED — labels are the worker's own detections, not independent ground truth"


def is_self_labelled(path: str) -> bool:
    p = os.path.normpath(os.path.abspath(path)).replace("\\", "/")
    return "/data/train/det" in p or p.endswith("/train/det")


def resolve(args, out_dir: str):
    """→ (yaml_path, images_dir, labels_dir, split)."""
    import yaml

    if args.data:
        with open(args.data, encoding="utf-8") as f:
            y = yaml.safe_load(f)
        root = y.get("path") or os.path.dirname(os.path.abspath(args.data))
        rel = y.get(args.split)
        if not rel:
            sys.exit(f"{args.data} has no '{args.split}' entry")
        images_dir = rel if os.path.isabs(rel) else os.path.join(root, rel)
        labels_dir = args.labels or images_dir.replace(
            f"{os.sep}images{os.sep}", f"{os.sep}labels{os.sep}"
        ).replace("/images/", "/labels/")
        if labels_dir == images_dir:
            labels_dir = os.path.join(
                os.path.dirname(os.path.dirname(images_dir)), "labels", os.path.basename(images_dir)
            )
        return args.data, images_dir, labels_dir, args.split
    if not (args.images and args.labels):
        sys.exit("give --data data.yaml or --images DIR --labels DIR")
    images_dir, labels_dir = os.path.abspath(args.images), os.path.abspath(args.labels)
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, "detector_tmp_data.yaml")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(
            f"path: {os.path.dirname(images_dir)}\ntrain: {images_dir}\nval: {images_dir}\nnames:\n  0: plate\n"
        )
    return tmp, images_dir, labels_dir, "val"


def load_gt(label_path: str, w: int, h: int) -> list[tuple[float, float, float, float]]:
    boxes = []
    if not os.path.exists(label_path):
        return boxes
    with open(label_path, encoding="utf-8") as f:
        for ln in f:
            parts = ln.split()
            if len(parts) < 5:
                continue
            cx, cy, bw, bh = (float(v) for v in parts[1:5])
            boxes.append(((cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h))
    return boxes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", help="YOLO data.yaml")
    ap.add_argument("--images", help="images dir (with --labels, instead of --data)")
    ap.add_argument("--labels", help="labels dir")
    ap.add_argument("--split", default="val", choices=["val", "train", "test"])
    ap.add_argument(
        "--weights", default=os.getenv("ANPR_PLATE_MODEL", os.path.join(HERE, "models", "best.pt"))
    )
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument(
        "--conf",
        type=float,
        default=float(os.getenv("ANPR_PLATE_CONF", "0.30")),
        help="operating-point confidence",
    )
    ap.add_argument("--iou-thr", type=float, default=0.5)
    ap.add_argument("--device", default=os.getenv("ANPR_DEVICE", "0"))
    ap.add_argument("--max-images", type=int, default=0, help="limit the breakdown pass (0 = all)")
    ap.add_argument(
        "--allow-self-labels",
        action="store_true",
        help="score data/train/det anyway (self-agreement, NOT accuracy)",
    )
    ap.add_argument("--out", default=os.path.join(HERE, "data", "eval"))
    args = ap.parse_args()

    yaml_path, images_dir, labels_dir, split = resolve(args, args.out)
    self_labelled = is_self_labelled(images_dir)
    if self_labelled and not args.allow_self_labels:
        print(SELF_LABEL_MSG)
        print(
            f"  ({images_dir} is export_labels.py's own output; see the docstring for what independent GT requires,"
            f" or pass --allow-self-labels to measure self-agreement only)"
        )
        sys.exit(3)
    if self_labelled:
        print(
            "WARNING: "
            + SELF_LABEL_MSG
            + " — every number below is SELF-AGREEMENT, stamped independent_gt=false"
        )

    images = sorted(
        glob.glob(os.path.join(images_dir, "*.jpg"))
        + glob.glob(os.path.join(images_dir, "*.jpeg"))
        + glob.glob(os.path.join(images_dir, "*.png"))
    )
    if not images:
        sys.exit(f"no images under {images_dir}")
    if args.max_images:
        images = images[: args.max_images]
    print(
        f"detector {args.weights}  data {yaml_path} split {split}  images {len(images)}  labels {labels_dir}"
    )

    from ultralytics import YOLO

    device = int(args.device) if str(args.device).isdigit() else args.device
    model = YOLO(args.weights)
    stamp = time.strftime("%Y%m%d-%H%M%S")

    # ── 1. ultralytics val ──
    print("ultralytics val …")
    t0 = time.time()
    # workers=0: the container's /dev/shm is too small for the DataLoader's worker processes
    # ("DataLoader worker exited unexpectedly"); in-process loading is fine for a few hundred frames
    res = model.val(
        data=yaml_path,
        imgsz=args.imgsz,
        device=device,
        split=split,
        verbose=False,
        plots=False,
        project=os.path.join(args.out, "detector_val"),
        name=stamp,
        exist_ok=True,
        workers=0,
    )
    ul = {
        "map50": float(res.box.map50),
        "map50_95": float(res.box.map),
        "precision": float(res.box.mp),
        "recall": float(res.box.mr),
        "val_s": round(time.time() - t0, 1),
    }
    print(
        f"  mAP50 {ul['map50']:.3f}  mAP50-95 {ul['map50_95']:.3f}  P {ul['precision']:.3f}  R {ul['recall']:.3f}  ({ul['val_s']} s)"
    )

    # ── 2. predictions → small-object breakdown ──
    print(f"prediction pass for the height breakdown (conf ≥ 0.001 kept; operating point {args.conf:g}) …")
    preds_all: dict[str, list] = {}
    gts_all: dict[str, list] = {}
    sizes: dict[str, tuple[int, int]] = {}
    t0 = time.time()
    for p in images:
        r = model.predict(p, imgsz=args.imgsz, conf=0.001, iou=0.7, device=device, verbose=False)[0]
        h, w = r.orig_shape
        sizes[p] = (w, h)
        boxes = r.boxes.xyxy.cpu().numpy().tolist() if r.boxes is not None and len(r.boxes) else []
        confs = r.boxes.conf.cpu().numpy().tolist() if r.boxes is not None and len(r.boxes) else []
        preds_all[p] = [(tuple(b), float(c)) for b, c in zip(boxes, confs)]
        stem = os.path.splitext(os.path.basename(p))[0]
        gts_all[p] = load_gt(os.path.join(labels_dir, stem + ".txt"), w, h)
    pred_s = round(time.time() - t0, 1)
    ap_all = M.ap_at_iou(preds_all, gts_all, args.iou_thr)

    buckets = {lab: {"n_gt": 0, "tp": 0, "fp": 0} for lab in H_LABELS}
    fp_per_image, fp_neg_images, n_neg, tp = [], 0, 0, 0
    n_pred_op = 0
    for p in images:
        preds = [(b, c) for b, c in preds_all[p] if c >= args.conf]
        n_pred_op += len(preds)
        gts = gts_all[p]
        m = M.match_boxes([b for b, _ in preds], [c for _, c in preds], gts, args.iou_thr)
        matched_gt = {gi for _, gi, _ in m["matches"]}
        for gi, g in enumerate(gts):
            lab = M.bucket_of(g[3] - g[1], H_EDGES, H_LABELS)
            buckets[lab]["n_gt"] += 1
            if gi in matched_gt:
                buckets[lab]["tp"] += 1
        for pi in m["fp"]:
            b = preds[pi][0]
            buckets[M.bucket_of(b[3] - b[1], H_EDGES, H_LABELS)]["fp"] += 1
        tp += len(m["matches"])
        fp_per_image.append(len(m["fp"]))
        if not gts:
            n_neg += 1
            if m["fp"]:
                fp_neg_images += 1
    n_gt = sum(b["n_gt"] for b in buckets.values())
    fp = sum(fp_per_image)
    prec, rec = M.precision_recall(tp, fp, n_gt - tp)
    op = {
        "conf": args.conf,
        "iou_thr": args.iou_thr,
        "n_images": len(images),
        "n_gt": n_gt,
        "n_pred": n_pred_op,
        "tp": tp,
        "fp": fp,
        "fn": n_gt - tp,
        "precision": prec,
        "recall": rec,
        "fp_per_image": fp / len(images),
        "negative_images": n_neg,
        "negative_images_with_fp": fp_neg_images,
        "fp_rate_on_negatives": (fp_neg_images / n_neg) if n_neg else None,
        "buckets": {
            lab: {
                **b,
                "recall": (b["tp"] / b["n_gt"]) if b["n_gt"] else None,
                "precision": (b["tp"] / (b["tp"] + b["fp"])) if (b["tp"] + b["fp"]) else None,
            }
            for lab, b in buckets.items()
        },
    }

    print(
        f"\n=== plate detector — {os.path.basename(args.weights)} on {images_dir} ({len(images)} images, {n_gt} GT boxes, "
        f"{n_neg} negatives) — independent_gt={'false' if self_labelled else 'true'} ==="
    )
    print(
        f"  ultralytics: mAP50 {ul['map50']:.3f}   mAP50-95 {ul['map50_95']:.3f}   P {ul['precision']:.3f}   R {ul['recall']:.3f}"
    )
    print(
        f"  anpr_metrics AP@{args.iou_thr:g} over all predictions: {ap_all['ap']:.3f}   (n_pred {ap_all['n_pred']}, {pred_s} s)"
    )
    print(
        f"  operating point conf ≥ {args.conf:g}: precision {M.fmt(prec, 'pct')}  recall {M.fmt(rec, 'pct')}  "
        f"tp {tp} fp {fp} fn {n_gt - tp}  FP/image {op['fp_per_image']:.3f}  "
        f"FP on negatives {fp_neg_images}/{n_neg}"
        + (f" = {M.fmt(op['fp_rate_on_negatives'], 'pct')}" if n_neg else " (no negative images in the set)")
    )
    print("  by GT box height (image pixels):")
    print(
        M.format_table(
            [{"bucket": lab, **b} for lab, b in op["buckets"].items()],
            [
                ("bucket", "height"),
                ("n_gt", "GT"),
                ("tp", "TP"),
                ("fp", "FP(pred h)"),
                ("recall", "recall"),
                ("precision", "precision"),
            ],
            pct={"recall", "precision"},
        ).replace("\n", "\n    ")
    )
    if self_labelled:
        print(
            "  "
            + SELF_LABEL_MSG
            + " (self-agreement only; the recall column cannot see plates the detector never drew)"
        )

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"detector_{stamp}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "kind": "detector",
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "weights": args.weights,
                "data": yaml_path,
                "images_dir": images_dir,
                "labels_dir": labels_dir,
                "split": split,
                "imgsz": args.imgsz,
                "independent_gt": not self_labelled,
                "caveat": SELF_LABEL_MSG if self_labelled else None,
                "ultralytics": ul,
                "ap_all_predictions": ap_all,
                "operating_point": op,
                "height_buckets_px": {"edges": H_EDGES, "labels": H_LABELS},
            },
            f,
            indent=1,
            default=str,
        )
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
