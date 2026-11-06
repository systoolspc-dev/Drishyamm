"""
train_detector.py — fine-tune the plate DETECTOR on our frames. Step 2b.

Uses the frames the worker saves next to every confirmed plate
(records/<date>/<cam>/*_frame.jpg + bbox) and the officer verdicts:
'correct'/'wrong' reads = a real plate box, 'not_plate' = a negative image
(the OSD caption, a shop sign). Starts from models/best.pt (the generic
Roboflow-trained YOLOv8) and writes models/best_ft.pt only if mAP50 on our
val frames improves. Point ANPR_PLATE_MODEL at it to deploy.

    docker run --rm --gpus all -v "$PWD/trinetra-ai/app/anpr_worker:/srv/anpr" -w /srv/anpr \
        trinetra/anpr-worker:latest python train_detector.py --epochs 40
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "data", "train", "det", "data.yaml"))
    ap.add_argument("--base", default=os.path.join(HERE, "models", "best.pt"))
    ap.add_argument("--out", default=os.path.join(HERE, "models", "best_ft.pt"))
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--min-images", type=int, default=60)
    ap.add_argument("--device", default=os.getenv("ANPR_DEVICE", "0"))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    det_dir = os.path.dirname(args.data)
    n_train = len(glob.glob(os.path.join(det_dir, "images", "train", "*.jpg")))
    n_val = len(glob.glob(os.path.join(det_dir, "images", "val", "*.jpg")))
    print(f"[det] {n_train} train / {n_val} val frames")
    if n_train < args.min_images:
        sys.exit(
            f"[det] only {n_train} frames (< {args.min_images}) — let the worker run longer / label more"
        )

    from ultralytics import YOLO

    device = int(args.device) if str(args.device).isdigit() else args.device
    base = YOLO(args.base)
    print("[det] base model val on OUR frames …")
    base_map = float(base.val(data=args.data, imgsz=args.imgsz, device=device, verbose=False).box.map50)

    model = YOLO(args.base)
    res = model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        project=os.path.join(HERE, "data", "train", "det_runs"),
        name="plate_ft",
        exist_ok=True,
        patience=12,
        lr0=0.002,
        lrf=0.05,
        warmup_epochs=1,
        freeze=4,
        verbose=False,
        # plates are small + elongated: keep mosaic, drop flips that never happen on a road
        fliplr=0.0,
        flipud=0.0,
        degrees=5.0,
        scale=0.3,
    )
    best_pt = os.path.join(str(res.save_dir), "weights", "best.pt")
    ft_map = float(
        YOLO(best_pt).val(data=args.data, imgsz=args.imgsz, device=device, verbose=False).box.map50
    )
    print(f"[det] mAP50 on our val frames: base {base_map:.3f} → fine-tuned {ft_map:.3f}")
    if args.force or ft_map > base_map:
        shutil.copyfile(best_pt, args.out)
        print(
            f"[det] PROMOTED → {args.out}   (set ANPR_PLATE_MODEL=/srv/anpr/models/best_ft.pt and restart anpr-worker)"
        )
    else:
        print(f"[det] NOT promoted (kept at {best_pt}); needs more frames / labels")


if __name__ == "__main__":
    main()
