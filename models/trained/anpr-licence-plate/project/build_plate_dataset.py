"""build_plate_dataset.py — package Trinetra's real Indian number-plate data as
one fine-tune dataset zip. Runs inside the ANPR trainer container:

    docker exec -w /srv/anpr trinetra-anpr-trainer python /tmp/build_plate_dataset.py \
        --out /srv/anpr/dataset_build --zip /srv/anpr/trinetra-plate-dataset-<date>.zip

Sources, in order of trust:
  1. HUMAN  — officer verdicts (Check reads page) materialised by export_labels.py
              in data/train/ocr (train_meta.csv says source=human) and the two
              held-out audit sets data/labelled_audit, data/labelled_cur.
  2. AUTO   — the reader's own confirmed reads from data/records (volume) and
              export/records (host copy): tier confirmed, high agreement, several
              frames, strict Indian format. De-duplicated per plate so one vehicle
              parked in front of one camera for a week does not dominate.
Output layout (fast-plate-ocr + YOLO, both trainable by the repo's scripts):
  ocr/images/*.jpg, ocr/train.csv, ocr/val.csv (image_path,plate_text), ocr/manifest.csv
  eval/audit/*.jpg + labels.csv, eval/current/*.jpg + labels.csv   (never train on these)
  detector/images/{train,val}/*.jpg, detector/labels/{train,val}/*.txt, detector/data.yaml
  README.md, plate_formats.json
"""

from __future__ import annotations

import argparse
import csv
import glob
import hashlib
import json
import os
import random
import re
import shutil
import sys
import zipfile
from collections import Counter, defaultdict

HERE = "/srv/anpr"
STRICT = re.compile(r"^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$")  # GJ01AB1234, GJ1A1234, DL3CAB1234
BH = re.compile(r"^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$")  # 23BH6826J (Bharat series)


def norm(p: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(p or "").upper())


def plate_ok(p: str) -> bool:
    return bool(STRICT.match(p) or BH.match(p))


def split_key(plate: str) -> float:
    """Stable per-plate split (every crop of a plate lands on one side)."""
    return int(hashlib.md5(plate.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF


def load_json(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def scan_records(roots: list[str]) -> dict[str, dict]:
    """Every read with a crop, keyed by the record basename (dedupes the host
    copy against the volume: same day/camera/file = same read)."""
    out: dict[str, dict] = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        for js in glob.glob(os.path.join(root, "20*", "*", "*.json")):
            base = js[:-5]
            key = os.path.relpath(base, root)
            if key in out:
                continue
            crop = base + "_plate.jpg"
            frame = base + "_frame.jpg"
            if not os.path.exists(crop):
                continue
            d = load_json(js)
            if not d or d.get("test"):
                continue
            feats = (d.get("meta") or {}).get("features") or {}
            assess = (d.get("meta") or {}).get("assessment") or {}
            plate = norm(d.get("plate"))
            out[key] = {
                "key": key,
                "crop": crop,
                "frame": frame if os.path.exists(frame) else None,
                "plate": plate,
                "camera": d.get("camera_code"),
                "camera_name": d.get("camera_name"),
                "ts": d.get("ts"),
                "day": key.split(os.sep)[0],
                "confidence": d.get("confidence"),
                "tier": feats.get("tier") or (d.get("meta") or {}).get("tier") or "confirmed",
                "frames": (d.get("meta") or {}).get("frames") or feats.get("n_frames"),
                "agreement": (d.get("meta") or {}).get("agreement") or feats.get("agreement"),
                "readers_agree": feats.get("readers_agree"),
                "crop_h": feats.get("crop_h") or assess.get("h"),
                "crop_w": feats.get("crop_w") or assess.get("w"),
                "scenario": assess.get("scenario"),
                "inverted": bool(feats.get("inverted")),
                "two_row": bool(feats.get("two_row")),
                "orphan": bool(feats.get("orphan")),
                "vehicle_type": d.get("vehicle_type"),
                "bbox": d.get("bbox"),
                "frame_w": (d.get("frame") or {}).get("w"),
                "frame_h": (d.get("frame") or {}).get("h"),
            }
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "dataset_build"))
    ap.add_argument("--zip", default=None)
    ap.add_argument(
        "--records",
        nargs="*",
        default=[os.path.join(HERE, "data", "records"), os.path.join(HERE, "export", "records")],
    )
    ap.add_argument("--train-ocr", default=os.path.join(HERE, "data", "train", "ocr"))
    ap.add_argument("--labelled", default=os.path.join(HERE, "data", "labelled"))
    ap.add_argument("--audit", default=os.path.join(HERE, "data", "labelled_audit"))
    ap.add_argument("--current", default=os.path.join(HERE, "data", "labelled_cur"))
    ap.add_argument(
        "--per-plate", type=int, default=4, help="auto crops kept per plate (spread over days/scenarios)"
    )
    ap.add_argument("--max-auto", type=int, default=6000)
    ap.add_argument("--det-per-plate", type=int, default=2)
    ap.add_argument("--max-det", type=int, default=2500)
    ap.add_argument("--min-agreement", type=float, default=0.95)
    ap.add_argument("--min-frames", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    random.seed(args.seed)

    out = args.out
    if os.path.exists(out):
        shutil.rmtree(out)
    for sub in (
        "ocr/images",
        "eval/audit",
        "eval/current",
        "detector/images/train",
        "detector/images/val",
        "detector/labels/train",
        "detector/labels/val",
    ):
        os.makedirs(os.path.join(out, sub), exist_ok=True)

    stats: dict = {
        "human": 0,
        "auto": 0,
        "auto_candidates": 0,
        "reads_seen": 0,
        "eval_audit": 0,
        "eval_current": 0,
        "det_train": 0,
        "det_val": 0,
        "det_neg": 0,
        "cameras": Counter(),
        "scenario": Counter(),
        "days": Counter(),
    }
    manifest: list[dict] = []
    ocr_rows: list[tuple[str, str, str, str]] = []  # (image_path, plate, split, source)
    seen_hash: set[str] = set()

    def add_crop(src: str, plate: str, source: str, meta: dict) -> str | None:
        with open(src, "rb") as f:
            h = hashlib.md5(f.read()).hexdigest()[:12]
        if h in seen_hash:
            return None
        seen_hash.add(h)
        name = f"{plate}_{h}.jpg"
        shutil.copyfile(src, os.path.join(out, "ocr", "images", name))
        split = "val" if (source == "human" and split_key(plate) < 0.15) else "train"
        ocr_rows.append((f"images/{name}", plate, split, source))
        manifest.append(
            {"image_path": f"images/{name}", "plate_text": plate, "split": split, "source": source, **meta}
        )
        return name

    # ── 1. HUMAN labels: the exporter's last materialisation (train_meta.csv) ──
    meta_csv = os.path.join(args.train_ocr, "train_meta.csv")
    human_plates: set[str] = set()
    if os.path.exists(meta_csv):
        with open(meta_csv, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if str(r.get("source", "")).lower() != "human":
                    continue
                img = os.path.join(args.train_ocr, r.get("image_path") or "")
                plate = norm(r.get("plate_text"))
                if not plate or not os.path.exists(img):
                    continue
                if add_crop(
                    img,
                    plate,
                    "human",
                    {
                        "camera": r.get("camera_code") or "",
                        "ts": r.get("ts") or "",
                        "confidence": "",
                        "tier": "human",
                        "frames": "",
                        "agreement": "",
                        "scenario": "",
                        "crop_h": "",
                        "note": "officer verdict",
                    },
                ):
                    stats["human"] += 1
                    human_plates.add(plate)
    # data/labelled/<PLATE>_<id>.jpg — the same officer crops in filename form (older exports)
    for p in glob.glob(os.path.join(args.labelled, "*.jpg")):
        plate = norm(os.path.basename(p).split("_")[0])
        if plate and add_crop(
            p,
            plate,
            "human",
            {
                "camera": "",
                "ts": "",
                "confidence": "",
                "tier": "human",
                "frames": "",
                "agreement": "",
                "scenario": "",
                "crop_h": "",
                "note": "officer verdict (labelled/)",
            },
        ):
            stats["human"] += 1
            human_plates.add(plate)

    # ── 2. held-out EVAL sets, verbatim (never for training) ──
    # Copied file-for-file (labels.csv stays `file,plate`, the audit manifest.csv
    # comes along), so ablation_preprocess.py reads them exactly as on the box.
    for name, src in (("audit", args.audit), ("current", args.current)):
        dst = os.path.join(out, "eval", name)
        if os.path.isdir(src):
            shutil.rmtree(dst)
            shutil.copytree(src, dst)
        lp = os.path.join(dst, "labels.csv")
        if os.path.exists(lp):
            with open(lp, newline="", encoding="utf-8") as f:
                stats[f"eval_{name}"] = sum(1 for _ in csv.DictReader(f))
        else:
            stats[f"eval_{name}"] = len(glob.glob(os.path.join(dst, "*.jpg")))

    # ── 3. AUTO labels from the records (de-duplicated per plate) ──
    reads = scan_records(args.records)
    stats["reads_seen"] = len(reads)
    by_plate: dict[str, list[dict]] = defaultdict(list)
    for r in reads.values():
        if not r["plate"] or not plate_ok(r["plate"]):
            continue
        if r["tier"] != "confirmed":
            continue
        if (r["agreement"] or 0) < args.min_agreement or (r["frames"] or 0) < args.min_frames:
            continue
        if r["readers_agree"] is False:
            continue
        by_plate[r["plate"]].append(r)
    stats["auto_candidates"] = sum(len(v) for v in by_plate.values())
    auto_picked: list[dict] = []
    for plate, rs in by_plate.items():
        # spread: prefer distinct (day, scenario) pairs, then highest confidence
        rs.sort(key=lambda r: (-(r["confidence"] or 0)))
        picked, seen_combo = [], set()
        for r in rs:
            combo = (r["day"], r["scenario"], r["camera"])
            if combo in seen_combo:
                continue
            seen_combo.add(combo)
            picked.append(r)
            if len(picked) >= args.per_plate:
                break
        auto_picked.extend(picked)
    random.shuffle(auto_picked)
    auto_picked = auto_picked[: args.max_auto]
    for r in auto_picked:
        if add_crop(
            r["crop"],
            r["plate"],
            "auto",
            {
                "camera": r["camera"] or "",
                "ts": r["ts"] or "",
                "confidence": r["confidence"],
                "tier": r["tier"],
                "frames": r["frames"],
                "agreement": r["agreement"],
                "scenario": r["scenario"] or "",
                "crop_h": r["crop_h"] or "",
                "note": "reader consensus (auto-label)",
            },
        ):
            stats["auto"] += 1
            stats["cameras"][r["camera"]] += 1
            stats["scenario"][r["scenario"] or "day"] += 1
            stats["days"][r["day"]] += 1

    # OCR csvs (fast-plate-ocr format). Human rows are duplicated ×2 in train,
    # the same 1.0 : 0.5 weighting the repo's exporter uses.
    with (
        open(os.path.join(out, "ocr", "train.csv"), "w", newline="", encoding="utf-8") as ft,
        open(os.path.join(out, "ocr", "val.csv"), "w", newline="", encoding="utf-8") as fv,
    ):
        wt, wv = csv.writer(ft), csv.writer(fv)
        wt.writerow(["image_path", "plate_text"])
        wv.writerow(["image_path", "plate_text"])
        for ip, pt, split, source in ocr_rows:
            if split == "val":
                wv.writerow([ip, pt])
            else:
                wt.writerow([ip, pt])
                if source == "human":
                    wt.writerow([ip, pt])
    with open(os.path.join(out, "ocr", "manifest.csv"), "w", newline="", encoding="utf-8") as f:
        cols = [
            "image_path",
            "plate_text",
            "split",
            "source",
            "camera",
            "ts",
            "confidence",
            "tier",
            "frames",
            "agreement",
            "scenario",
            "crop_h",
            "note",
        ]
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for m in manifest:
            w.writerow({k: m.get(k, "") for k in cols})

    # ── 4. DETECTOR set (YOLO): the frame + the plate box of the winning read ──
    try:
        import cv2  # noqa: WPS433
    except Exception:  # noqa: BLE001
        cv2 = None
    det_by_plate: dict[str, list[dict]] = defaultdict(list)
    for r in reads.values():
        if r["frame"] and r["bbox"] and r["plate"] and plate_ok(r["plate"]) and r["tier"] == "confirmed":
            det_by_plate[r["plate"]].append(r)
    det_rows: list[dict] = []
    for plate, rs in det_by_plate.items():
        rs.sort(key=lambda r: (-(r["confidence"] or 0)))
        seen_combo, n = set(), 0
        for r in rs:
            combo = (r["day"], r["camera"])
            if combo in seen_combo:
                continue
            seen_combo.add(combo)
            det_rows.append(r)
            n += 1
            if n >= args.det_per_plate:
                break
    random.shuffle(det_rows)
    det_rows = det_rows[: args.max_det]
    for r in det_rows:
        x1, y1, x2, y2 = [float(v) for v in r["bbox"][:4]]
        W, H = r["frame_w"], r["frame_h"]
        if (not W or not H) and cv2 is not None:
            img = cv2.imread(r["frame"])
            if img is None:
                continue
            H, W = img.shape[:2]
        if not W or not H:
            continue
        # the record bbox is in the SOURCE frame's coordinates; frames are saved at source size
        cx, cy, bw, bh = (x1 + x2) / 2 / W, (y1 + y2) / 2 / H, (x2 - x1) / W, (y2 - y1) / H
        if not (0 < cx < 1 and 0 < cy < 1 and 0 < bw < 1 and 0 < bh < 1):
            continue
        split = "val" if split_key(r["plate"]) < 0.12 else "train"
        name = f"{r['camera']}_{r['day']}_{os.path.basename(r['key'])}"
        shutil.copyfile(r["frame"], os.path.join(out, "detector", "images", split, name + ".jpg"))
        with open(os.path.join(out, "detector", "labels", split, name + ".txt"), "w") as f:
            f.write(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")
        stats[f"det_{split}"] += 1
    with open(os.path.join(out, "detector", "data.yaml"), "w") as f:
        # No `path:` key: Ultralytics then resolves train/val against this file's
        # folder. `path: .` resolved against the CWD / its datasets dir instead.
        f.write(
            "# paths are relative to this file (no path: key, so Ultralytics resolves them against this folder)\n"
            "train: images/train\nval: images/val\nnames:\n  0: plate\n"
        )

    # ── 5. plate formats + README ──
    pf = os.path.join(HERE, "plate_formats.json")
    if os.path.exists(pf):
        shutil.copyfile(pf, os.path.join(out, "plate_formats.json"))
    cams = ", ".join(f"{c} ({n})" for c, n in stats["cameras"].most_common())
    scen = ", ".join(f"{s}: {n}" for s, n in stats["scenario"].most_common())
    days = ", ".join(f"{d}: {n}" for d, n in sorted(stats["days"].items()))
    n_train = sum(1 for r in ocr_rows if r[2] == "train")
    n_val = sum(1 for r in ocr_rows if r[2] == "val")
    readme = f"""# Trinetra Indian number-plate dataset (real CCTV, Gujarat)

Built from the Trinetra ANPR reader's own evidence records on the Gujarat provider cameras
(corp8_*), packaged for fine-tuning a plate OCR and a plate detector. Every crop is a real
plate from a real road camera - no synthetic plates in this zip.

## What is inside

| folder | what | count |
|---|---|---|
| `ocr/images/` + `ocr/train.csv`, `ocr/val.csv` | plate crops with the plate text, fast-plate-ocr CSV format (`image_path,plate_text`) | {len(ocr_rows)} crops: {stats['human']} officer-verified + {stats['auto']} reader-consensus; train {n_train} / val {n_val} (val is officer-verified only) |
| `ocr/manifest.csv` | one row per crop: source (human/auto), camera, time, confidence, frames, agreement, scenario (day/night/glare/motion), crop height | |
| `eval/audit/` | held-out audit set, officer truth (`labels.csv`) - measure on it, NEVER train on it | {stats['eval_audit']} |
| `eval/current/` | held-out "current reader" set, officer truth, includes single-letter-series corrections | {stats['eval_current']} |
| `detector/` | YOLO set: full frames + `0 cx cy w h` plate boxes, `data.yaml` | train {stats['det_train']} / val {stats['det_val']} frames |
| `plate_formats.json` | the Indian plate grammar the reader decodes against (state codes, series shapes, BH series) | |

## How the labels were made

* **human** rows: an officer opened the read on the console's *Check reads* page and marked it
  correct, or wrong with the true plate typed in. These are authoritative. They appear twice in
  `train.csv` on purpose (weight 2 vs 1 for auto rows, the same ratio the production retrain uses).
* **auto** rows: the reader's own consensus over several frames - tier `confirmed`,
  per-character agreement >= {args.min_agreement}, >= {args.min_frames} frames, strict Indian format, two readers not in
  disagreement. De-duplicated: at most {args.per_plate} crops per plate, spread over different days,
  cameras and lighting, so one vehicle parked in front of one camera all week counts once.
  Auto rows never enter val. Measured on the audit set the production reader reads 83 % of crops
  exactly, so expect roughly 1 in 6 auto labels to carry a wrong character - the human rows and
  the eval sets are how you keep that honest.
* Cameras in the auto rows: {cams}
* Lighting: {scen}
* Days: {days}
* Detector boxes are the winning read's plate box from the reader's own detector (positives only,
  {stats['det_neg']} negatives). A detector trained on these reproduces the current detector; to
  teach it plates it MISSES, add hand-drawn boxes on frames where no read happened.

## Formats

* OCR: `image_path,plate_text` relative to `ocr/`; plate text is A-Z0-9 with no spaces
  (GJ01AB1234 style, 23BH6826J for Bharat series). Crops are the raw camera crop - no
  enhancement applied; the production reader enhances at inference, so train on raw.
* Detector: Ultralytics YOLO layout, one class `plate`, normalised `cx cy w h`; frames at
  source resolution (1920x1080 / 1280x720).

## Training with the Trinetra scripts (same formats)

    # OCR (fast-plate-ocr, CCT), evaluates against the deployed model before promoting
    python train_ocr.py --data <zip>/ocr --epochs 30
    # detector (Ultralytics YOLOv8), promotes only if mAP50 improves
    python train_detector.py --data <zip>/detector/data.yaml --epochs 40
    # honest score: exact-match on the held-out sets
    python ablation_preprocess.py --labelled <zip>/eval/audit

## Known limits, stated plainly

* One camera (Junagadh - Timbavadi Gate, corp8_06) produced most reads on these feeds; the
  per-plate cap limits it but the set is still Gujarat-heavy (GJ series). Night crops with IR
  bloom are the weakest scenario.
* Plates are personal data under India's DPDP Act. This zip is for model training by the
  Trinetra team only; do not publish or share it outside the project.

Built {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M')} by build_plate_dataset.py from
{stats['reads_seen']} evidence records ({stats['auto_candidates']} met the auto-label bar).
"""
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as f:
        f.write(readme)

    print(json.dumps({k: (dict(v) if isinstance(v, Counter) else v) for k, v in stats.items()}, indent=1))

    if args.zip:
        if os.path.exists(args.zip):
            os.remove(args.zip)
        with zipfile.ZipFile(args.zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for root, _, files in os.walk(out):
                for fn in files:
                    fp = os.path.join(root, fn)
                    z.write(fp, os.path.relpath(fp, out))
        print("zip:", args.zip, round(os.path.getsize(args.zip) / 1e6, 1), "MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
