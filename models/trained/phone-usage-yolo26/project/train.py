"""Train YOLO26 on the phone-and-no-phone dataset.

Usage:
    python train.py                                  # sensible defaults
    python train.py --model yolo26s.pt --epochs 200
    python train.py --batch 32 --imgsz 640 --device 0
    python train.py --resume                         # continue last run

The Windows `if __name__ == "__main__"` guard is required — Ultralytics spawns
dataloader worker processes and will otherwise re-import/re-run this module.
"""

import argparse
from pathlib import Path

import torch
from ultralytics import YOLO


def pick_device(requested):
    """Return the device to train on. 'auto' -> CUDA GPU, else Apple MPS, else CPU."""
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return 0
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="dataset/data.yaml", help="dataset yaml")
    ap.add_argument("--model", default="yolo26m.pt",
                    help="pretrained weights or model yaml "
                         "(yolo26n/s/m/l/x.pt; use .yaml to train from scratch)")
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8,
                    help="batch size; use -1 for auto (~60%% GPU memory)")
    ap.add_argument("--device", default="auto",
                    help="'auto', a CUDA index like 0 or 0,1, 'mps', or 'cpu'")
    ap.add_argument("--workers", type=int, default=8, help="dataloader workers")
    ap.add_argument("--project", default="runs/detect", help="output root")
    ap.add_argument("--name", default="phone_yolo26", help="run name")
    ap.add_argument("--resume", action="store_true",
                    help="resume the most recent interrupted run")
    ap.add_argument("--patience", type=int, default=50,
                    help="early-stop patience (epochs without improvement)")
    args = ap.parse_args()

    if not Path(args.data).exists():
        raise SystemExit(f"data yaml not found: {args.data} (run converter.py first)")

    device = pick_device(args.device)
    if device == "cpu":
        print("WARNING: training on CPU — this will be extremely slow for this "
              "dataset. Install a CUDA build of torch and use a GPU.")

    model = YOLO(args.model)

    model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=device,
        workers=args.workers,
        project=args.project,
        name=args.name,
        patience=args.patience,
        resume=args.resume,
        plots=True,       # save curves / confusion matrix / sample batches
        val=True,         # validate on the 'val' split each epoch
    )

    # Final evaluation on the held-out test split (not seen during training/val).
    print("\nEvaluating best weights on the test split...")
    metrics = model.val(data=args.data, split="test", imgsz=args.imgsz, device=device)
    print(f"test mAP50-95: {metrics.box.map:.4f}   mAP50: {metrics.box.map50:.4f}")
    print(f"best weights: {Path(args.project) / args.name / 'weights' / 'best.pt'}")


if __name__ == "__main__":
    main()
