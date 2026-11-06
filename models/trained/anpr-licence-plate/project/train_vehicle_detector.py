"""
train_vehicle_detector.py — make autos and bikes first-class: fine-tune the
VEHICLE detector on the India Driving Dataset (IDD) + our own camera frames.

Why: the stock yolov8n.pt is COCO — built from Western photos, it has NO
auto-rickshaw class (an auto flickers between car/truck/motorcycle or falls
below threshold) and gives distant two-wheelers 0.2–0.4 confidence. IDD
(IIIT Hyderabad, idd.insaan.iiit.ac.in — free for research, registration
required) has exactly the Indian classes: autorickshaw, motorcycle, rider,
truck, bus, car, vehicle fallback, annotated on real Indian roads.

What this does
  1. IDD detection archive (VOC-style XML) → YOLO labels in OUR taxonomy
     (vehicle_types.py): 0 car · 1 motorcycle · 2 autorickshaw · 3 bus ·
     4 truck · 5 vehicle · 6 bicycle (kept as a class so bicycles stop being
     called motorcycles; the worker never OCRs it).
  2. Optionally mixes in our own 1280-px frames (records/*/*/*_frame.jpg)
     PSEUDO-LABELLED by the current detector at ≥ 0.5 confidence — they cannot
     teach 'autorickshaw' (COCO never saw one) but they teach these cameras'
     viewpoints, so the fine-tune does not forget them.
  3. Fine-tunes from --base (yolov8n.pt), evaluates per class on the IDD val
     split, and PROMOTES to models/vehicle_ft.pt only if the shared classes
     (car/motorcycle/bus/truck) did not regress vs the base model (evaluated on
     the same val images with labels remapped to COCO ids) AND autorickshaw
     AP50 ≥ --min-auto-ap. Deploy with ANPR_VEHICLE_MODEL=/srv/anpr/models/vehicle_ft.pt
     (the worker derives its class filter and names from the model, so nothing
     else changes).

    docker run --rm --gpus all -v "$PWD/trinetra-ai/app/anpr_worker:/srv/anpr" \
        -v "D:/datasets/IDD_Detection:/idd:ro" -w /srv/anpr trinetra/anpr-worker:latest \
        python train_vehicle_detector.py --idd /idd --frames data/records --epochs 30

Expect a few hours on an A3000 for the full IDD (~31k frames); --max-images
caps it for a first run.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import random
import shutil
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from vehicle_types import from_detector  # noqa: E402

NAMES = ["car", "motorcycle", "autorickshaw", "bus", "truck", "vehicle", "bicycle"]
IDX = {n: i for i, n in enumerate(NAMES)}
# canonical → our index; 'rider' boxes are dropped (they sit on the motorcycle box)
COCO_REMAP = {"car": 2, "motorcycle": 3, "bus": 5, "truck": 7, "bicycle": 1}  # for the base-model comparison
IMG_EXT = (".jpg", ".jpeg", ".png")


def _find_images(root: str) -> dict[str, str]:
    """stem (relative, without extension) → absolute image path."""
    out = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f.lower().endswith(IMG_EXT):
                rel = os.path.relpath(os.path.join(dp, f), root)
                out[os.path.splitext(rel)[0].replace("\\", "/")] = os.path.join(dp, f)
    return out


def _parse_voc(xml_path: str) -> tuple[tuple[int, int], list[tuple[str, float, float, float, float]]]:
    t = ET.parse(xml_path).getroot()
    sz = t.find("size")
    w = int(float(sz.find("width").text)) if sz is not None else 0
    h = int(float(sz.find("height").text)) if sz is not None else 0
    boxes = []
    for o in t.findall("object"):
        nm = (o.findtext("name") or "").strip().lower()
        bb = o.find("bndbox")
        if bb is None:
            continue
        x1, y1, x2, y2 = (float(bb.findtext(k)) for k in ("xmin", "ymin", "xmax", "ymax"))
        boxes.append((nm, x1, y1, x2, y2))
    return (w, h), boxes


def _yolo_line(cls: int, x1, y1, x2, y2, w, h) -> str | None:
    if w <= 0 or h <= 0 or x2 <= x1 or y2 <= y1:
        return None
    cx, cy, bw, bh = (x1 + x2) / 2 / w, (y1 + y2) / 2 / h, (x2 - x1) / w, (y2 - y1) / h
    if bw < 0.004 or bh < 0.006:  # < ~5 px at 1280: not learnable, hurts recall metrics
        return None
    return f"{cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}"


def convert_idd(idd: str, out: str, max_images: int, seed: int) -> dict:
    """IDD_Detection/{Annotations,JPEGImages}(+train.txt/val.txt) → YOLO dataset."""
    ann_root = os.path.join(idd, "Annotations")
    img_root = os.path.join(idd, "JPEGImages")
    if not os.path.isdir(ann_root) or not os.path.isdir(img_root):
        sys.exit(f"[veh] {idd} must contain Annotations/ and JPEGImages/ (IDD detection layout)")
    images = _find_images(img_root)
    xmls = glob.glob(os.path.join(ann_root, "**", "*.xml"), recursive=True)
    rng = random.Random(seed)
    rng.shuffle(xmls)
    # official split when present, else 90/10 by sequence folder
    split_of: dict[str, str] = {}
    for name in ("train", "val"):
        lst = os.path.join(idd, f"{name}.txt")
        if os.path.exists(lst):
            for line in open(lst, encoding="utf-8"):
                s = line.strip().replace("\\", "/")
                if s:
                    split_of[os.path.splitext(s)[0]] = name
    stats = {"train": 0, "val": 0, "boxes": {n: 0 for n in NAMES}, "dropped": {}, "missing_images": 0}
    n_done = 0
    for xp in xmls:
        if max_images and n_done >= max_images:
            break
        rel = os.path.splitext(os.path.relpath(xp, ann_root))[0].replace("\\", "/")
        ip = images.get(rel)
        if ip is None:
            stats["missing_images"] += 1
            continue
        (w, h), boxes = _parse_voc(xp)
        if w == 0 or h == 0:
            try:
                import cv2

                im = cv2.imread(ip)
                h, w = im.shape[:2]
            except Exception:  # noqa: BLE001
                continue
        split = split_of.get(rel) or ("val" if (hash(rel.split("/")[0]) % 10 == 0) else "train")
        lines = []
        for nm, x1, y1, x2, y2 in boxes:
            canon = from_detector(nm)
            if nm == "bicycle":
                canon = "bicycle"
            if canon is None or canon not in IDX:
                stats["dropped"][nm] = stats["dropped"].get(nm, 0) + 1
                continue
            ln = _yolo_line(IDX[canon], x1, y1, x2, y2, w, h)
            if ln:
                lines.append(ln)
                stats["boxes"][canon] += 1
        if not lines:
            continue
        stem = rel.replace("/", "__")
        dst_img = os.path.join(out, "images", split, stem + os.path.splitext(ip)[1].lower())
        dst_lbl = os.path.join(out, "labels", split, stem + ".txt")
        os.makedirs(os.path.dirname(dst_img), exist_ok=True)
        os.makedirs(os.path.dirname(dst_lbl), exist_ok=True)
        if not os.path.exists(dst_img):
            try:
                os.symlink(ip, dst_img)
            except OSError:
                shutil.copyfile(ip, dst_img)
        with open(dst_lbl, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        stats[split] += 1
        n_done += 1
    return stats


def pseudo_label_frames(
    frames_dir: str, out: str, base_pt: str, device, max_frames: int, conf: float = 0.5
) -> int:
    """Our own camera frames, labelled by the current detector (COCO → taxonomy)."""
    from ultralytics import YOLO

    fr = sorted(glob.glob(os.path.join(frames_dir, "**", "*_frame.jpg"), recursive=True))
    if not fr:
        return 0
    random.Random(0).shuffle(fr)
    fr = fr[:max_frames] if max_frames else fr
    model = YOLO(base_pt)
    names = model.names
    n = 0
    for i, p in enumerate(fr):
        r = model.predict(p, conf=conf, device=device, verbose=False)[0]
        if r.boxes is None or len(r.boxes) == 0:
            continue
        h, w = r.orig_shape
        lines = []
        for xyxy, c in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.cls.cpu().numpy()):
            canon = from_detector(int(c), names)
            if canon is None or canon not in IDX:
                continue
            ln = _yolo_line(IDX[canon], *xyxy.tolist(), w, h)
            if ln:
                lines.append(ln)
        if not lines:
            continue
        split = "val" if i % 10 == 0 else "train"
        stem = "own__" + os.path.splitext(os.path.basename(p))[0] + f"_{i}"
        dst_img = os.path.join(out, "images", split, stem + ".jpg")
        dst_lbl = os.path.join(out, "labels", split, stem + ".txt")
        os.makedirs(os.path.dirname(dst_img), exist_ok=True)
        os.makedirs(os.path.dirname(dst_lbl), exist_ok=True)
        shutil.copyfile(p, dst_img)
        with open(dst_lbl, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        n += 1
    return n


def write_yaml(out: str) -> str:
    y = os.path.join(out, "data.yaml")
    with open(y, "w", encoding="utf-8") as f:
        f.write(f"path: {out}\ntrain: images/train\nval: images/val\nnames:\n")
        for i, n in enumerate(NAMES):
            f.write(f"  {i}: {n}\n")
    return y


def coco_view_of_val(out: str) -> str:
    """The same val images with labels remapped to COCO ids so the BASE model
    (80 COCO names) can be scored on the shared classes — apples to apples."""
    cv = os.path.join(out, "coco_view")
    os.makedirs(os.path.join(cv, "labels", "val"), exist_ok=True)
    img_src = os.path.join(out, "images", "val")
    img_dst = os.path.join(cv, "images", "val")
    if not os.path.exists(img_dst):
        try:
            os.symlink(img_src, img_dst, target_is_directory=True)
        except OSError:
            shutil.copytree(img_src, img_dst)
    for lp in glob.glob(os.path.join(out, "labels", "val", "*.txt")):
        lines = []
        for line in open(lp, encoding="utf-8"):
            parts = line.split()
            if not parts:
                continue
            nm = NAMES[int(parts[0])]
            if nm in COCO_REMAP:
                lines.append(" ".join([str(COCO_REMAP[nm])] + parts[1:]))
        with open(os.path.join(cv, "labels", "val", os.path.basename(lp)), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + ("\n" if lines else ""))
    y = os.path.join(cv, "data.yaml")
    from ultralytics.utils import yaml_load  # noqa: F401  (ultralytics present)

    coco_names = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
    with open(y, "w", encoding="utf-8") as f:
        f.write(f"path: {cv}\ntrain: images/val\nval: images/val\nnames:\n")
        for i in range(80):
            f.write(f"  {i}: {coco_names.get(i, f'c{i}')}\n")
    return y


def per_class_ap50(metrics, names_of_model: dict) -> dict[str, float]:
    """ultralytics DetMetrics → {class name: AP50} for the classes present in val."""
    out = {}
    try:
        idx = list(metrics.box.ap_class_index)
        ap50 = list(metrics.box.ap50)
        for ci, ap in zip(idx, ap50):
            out[str(names_of_model.get(int(ci), ci))] = float(ap)
    except Exception:  # noqa: BLE001
        pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--idd", required=True, help="IDD_Detection root (Annotations/, JPEGImages/)")
    ap.add_argument(
        "--frames", default="", help="our records dir with *_frame.jpg to pseudo-label (optional)"
    )
    ap.add_argument("--out", default=os.path.join(HERE, "data", "train", "vehicle"))
    ap.add_argument("--base", default=os.path.join(HERE, "models", "yolov8n.pt"))
    ap.add_argument("--promote-to", default=os.path.join(HERE, "models", "vehicle_ft.pt"))
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-images", type=int, default=0, help="cap IDD frames (0 = all)")
    ap.add_argument("--max-own", type=int, default=1500)
    ap.add_argument("--min-auto-ap", type=float, default=0.40)
    ap.add_argument("--device", default=os.getenv("ANPR_DEVICE", "0"))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    device = int(a.device) if str(a.device).isdigit() else a.device

    print(f"[veh] converting IDD from {a.idd} …")
    st = convert_idd(a.idd, a.out, a.max_images, a.seed)
    print(
        f"[veh] IDD: train {st['train']} / val {st['val']} images; boxes {st['boxes']}; dropped {st['dropped']}; missing images {st['missing_images']}"
    )
    if st["train"] < 200:
        sys.exit(
            "[veh] too few IDD frames converted — check the layout (Annotations/**/*.xml, JPEGImages/**/*.jpg)"
        )
    n_own = pseudo_label_frames(a.frames, a.out, a.base, device, a.max_own) if a.frames else 0
    print(f"[veh] own frames pseudo-labelled: {n_own}")
    data = write_yaml(a.out)

    from ultralytics import YOLO

    print("[veh] base model on the shared classes of IDD val …")
    base = YOLO(a.base)
    base_ap = per_class_ap50(
        base.val(data=coco_view_of_val(a.out), imgsz=a.imgsz, device=device, verbose=False, plots=False),
        base.names,
    )
    print(f"[veh] base AP50: {json.dumps({k: round(v, 3) for k, v in base_ap.items()})}")

    model = YOLO(a.base)
    res = model.train(
        data=data,
        epochs=a.epochs,
        imgsz=a.imgsz,
        batch=a.batch,
        device=device,
        project=os.path.join(HERE, "data", "train", "vehicle_runs"),
        name="idd_ft",
        exist_ok=True,
        patience=8,
        lr0=0.002,
        lrf=0.05,
        warmup_epochs=1,
        verbose=False,
        fliplr=0.5,
        flipud=0.0,
        degrees=3.0,
        scale=0.4,
        mosaic=1.0,
        close_mosaic=5,
        seed=a.seed,
    )
    best_pt = os.path.join(str(res.save_dir), "weights", "best.pt")
    ft = YOLO(best_pt)
    ft_ap = per_class_ap50(
        ft.val(data=data, imgsz=a.imgsz, device=device, verbose=False, plots=False), ft.names
    )
    print(f"[veh] fine-tuned AP50: {json.dumps({k: round(v, 3) for k, v in ft_ap.items()})}")

    shared = ["car", "motorcycle", "bus", "truck"]
    base_mean = sum(base_ap.get(k, 0.0) for k in shared) / len(shared)
    ft_mean = sum(ft_ap.get(k, 0.0) for k in shared) / len(shared)
    auto_ap = ft_ap.get("autorickshaw", 0.0)
    ok = ft_mean >= base_mean - 0.02 and auto_ap >= a.min_auto_ap
    print(
        f"[veh] shared-class mean AP50 base {base_mean:.3f} → fine-tuned {ft_mean:.3f}; autorickshaw AP50 {auto_ap:.3f} (need ≥ {a.min_auto_ap})"
    )
    report = {
        "base_ap50": base_ap,
        "ft_ap50": ft_ap,
        "shared_mean": {"base": base_mean, "ft": ft_mean},
        "autorickshaw_ap50": auto_ap,
        "promoted": bool(ok or a.force),
        "weights": best_pt,
        "idd": st,
        "own_frames": n_own,
        "names": NAMES,
    }
    os.makedirs(os.path.dirname(a.promote_to), exist_ok=True)
    with open(os.path.splitext(a.promote_to)[0] + ".report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    if ok or a.force:
        shutil.copyfile(best_pt, a.promote_to)
        with open(os.path.splitext(a.promote_to)[0] + ".names.json", "w", encoding="utf-8") as f:
            json.dump(NAMES, f)
        print(
            f"[veh] PROMOTED → {a.promote_to}   (set ANPR_VEHICLE_MODEL=/srv/anpr/models/vehicle_ft.pt and restart anpr-worker)"
        )
    else:
        print(
            f"[veh] NOT promoted (kept at {best_pt}) — more epochs / more IDD frames, or lower --min-auto-ap knowingly"
        )


if __name__ == "__main__":
    main()
