"""
Train YOLOv11s on the Roboflow "No Helmet" dataset.

The export only contains a `train` split (5000 images = 1000 source video frames
x 5 Roboflow augmentations), so this script builds a leak-free validation split:
  * all augmented copies of a frame stay in the same split
  * the val set is the last contiguous block of frames from each video, so
    near-identical neighbouring frames don't straddle train/val

No files are copied: the split is written as image-path lists (splits/*.txt) and a
generated data yaml (splits/data_split.yaml) that points at them.

Usage:
    pip install ultralytics
    python train_yolo11s.py                       # defaults below
    python train_yolo11s.py --epochs 150 --batch 32 --imgsz 640
    python train_yolo11s.py --resume              # resume last run
"""

import argparse
import re
from collections import defaultdict
from pathlib import Path

import yaml
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent
TRAIN_IMAGES = ROOT / "train" / "images"
SPLIT_DIR = ROOT / "splits"
CLASS_NAMES = ["No Helmet"]

# e.g. vid2_frame01000_jpg.rf.7b630d0753c3cf9ed8de6f9abf8d8165.jpg
FRAME_RE = re.compile(r"^(?P<video>.+?)_frame(?P<frame>\d+)_")


def build_split(val_fraction: float) -> Path:
    """Write train/val image lists grouped by video and source frame; return yaml path."""
    frames = defaultdict(lambda: defaultdict(list))  # video -> frame -> [image paths]
    for img in sorted(TRAIN_IMAGES.glob("*.jpg")):
        m = FRAME_RE.match(img.name)
        if not m:
            raise ValueError(f"Unexpected filename format: {img.name}")
        frames[m["video"]][int(m["frame"])].append(img)

    train_imgs, val_imgs = [], []
    for video, by_frame in sorted(frames.items()):
        ordered = sorted(by_frame)
        n_val = max(1, round(len(ordered) * val_fraction))
        val_frames = set(ordered[-n_val:])  # tail block of each video
        for f in ordered:
            (val_imgs if f in val_frames else train_imgs).extend(by_frame[f])
        print(f"  {video}: {len(ordered) - n_val} train frames, {n_val} val frames")

    SPLIT_DIR.mkdir(exist_ok=True)
    (SPLIT_DIR / "train.txt").write_text("\n".join(p.as_posix() for p in train_imgs) + "\n")
    (SPLIT_DIR / "val.txt").write_text("\n".join(p.as_posix() for p in val_imgs) + "\n")

    data_yaml = SPLIT_DIR / "data_split.yaml"
    data_yaml.write_text(yaml.safe_dump({
        "path": ROOT.as_posix(),
        "train": (SPLIT_DIR / "train.txt").as_posix(),
        "val": (SPLIT_DIR / "val.txt").as_posix(),
        "nc": len(CLASS_NAMES),
        "names": CLASS_NAMES,
    }, sort_keys=False))

    print(f"  -> {len(train_imgs)} train images, {len(val_imgs)} val images")
    return data_yaml


def parse_args():
    p = argparse.ArgumentParser(description="Train YOLOv11s on the No Helmet dataset")
    p.add_argument("--model", default="yolo11s.pt", help="pretrained weights (auto-downloaded)")
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--imgsz", type=int, default=960)
    p.add_argument("--batch", type=int, default=32, help="-1 = auto-fit to GPU memory")
    p.add_argument("--device", default="0", help="'0' for first GPU, 'cpu' for CPU")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--patience", type=int, default=30, help="early-stop epochs without improvement")
    p.add_argument("--val-fraction", type=float, default=0.15)
    p.add_argument("--project", default=str(ROOT / "runs"))
    p.add_argument("--name", default="yolo11s_no_helmet")
    p.add_argument("--resume", action="store_true", help="resume the last run with this name")
    return p.parse_args()


def main():
    args = parse_args()

    if args.resume:
        last = Path(args.project) / args.name / "weights" / "last.pt"
        YOLO(last).train(resume=True)
        return

    print("Building train/val split...")
    data_yaml = build_split(args.val_fraction)

    model = YOLO(args.model)
    model.train(
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        workers=args.workers,
        patience=args.patience,
        project=args.project,
        name=args.name,
        exist_ok=False,
        pretrained=True,
        optimizer="auto",
        cos_lr=True,
        close_mosaic=10,
        # Roboflow already applied brightness/blur/noise; keep Ultralytics' default
        # geometric augs, but no vertical flips (people aren't upside down).
        flipud=0.0,
        fliplr=0.5,
        amp=True,
        cache=True,  # ~5k images fits easily in RAM
        seed=0,
        plots=True,
    )

    # Final evaluation on the held-out frames with the best checkpoint
    best = Path(model.trainer.save_dir) / "weights" / "best.pt"
    metrics = YOLO(best).val(data=str(data_yaml), imgsz=args.imgsz, device=args.device)
    print(f"\nBest weights: {best}")
    print(f"mAP50: {metrics.box.map50:.4f}  mAP50-95: {metrics.box.map:.4f}")


if __name__ == "__main__":  # required on Windows for dataloader workers
    main()
