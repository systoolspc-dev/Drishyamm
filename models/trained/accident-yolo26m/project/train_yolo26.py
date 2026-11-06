"""
Fine-tune YOLO26 on the Roboflow "Accident" dataset.

Usage (from c:\projects\accident):
    venv\Scripts\python.exe train_yolo26.py                      # defaults
    venv\Scripts\python.exe train_yolo26.py --model yolo26m.pt --epochs 150
    venv\Scripts\python.exe train_yolo26.py --batch -1           # auto-batch (60% VRAM)
    venv\Scripts\python.exe train_yolo26.py --resume             # continue last run

Dataset: 6,963 train / 1,991 val / 997 test images, 2 classes (Accident, Non Accident).
"""

import argparse
import shutil
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
DATASET_DIR = ROOT / "Accident.v1i.yolo26 (1)"
GENERATED_YAML = ROOT / "accident_data.yaml"


def build_data_yaml() -> tuple[Path, dict]:
    """Rewrite Roboflow's data.yaml with absolute paths.

    Roboflow ships `train: ../train/images`, which Ultralytics resolves relative to
    the yaml's own folder and therefore points one directory too high. We emit a
    corrected copy next to this script instead of editing the dataset in place.
    """
    src = DATASET_DIR / "data.yaml"
    if not src.exists():
        raise FileNotFoundError(f"Dataset yaml not found: {src}")

    with src.open("r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    cfg["path"] = str(DATASET_DIR)
    cfg["train"] = "train/images"
    cfg["val"] = "valid/images"
    cfg["test"] = "test/images"
    cfg.pop("roboflow", None)

    for split in ("train", "val", "test"):
        split_dir = DATASET_DIR / cfg[split]
        if not split_dir.is_dir():
            raise FileNotFoundError(f"Missing split directory: {split_dir}")

    with GENERATED_YAML.open("w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, sort_keys=False, allow_unicode=True)

    print(f"[data] {GENERATED_YAML}")
    print(f"[data] root={cfg['path']}  nc={cfg['nc']}  names={cfg['names']}")
    return GENERATED_YAML, cfg


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fine-tune YOLO26 on the Accident dataset.")

    # model / run
    p.add_argument("--model", default="yolo26s.pt",
                   help="Pretrained checkpoint: yolo26n/s/m/l/x.pt (downloaded on first use).")
    p.add_argument("--project", default=str(ROOT / "runs" / "detect"))
    p.add_argument("--name", default="accident_yolo26s")
    p.add_argument("--resume", action="store_true", help="Resume from the run's last.pt.")

    # schedule
    p.add_argument("--epochs", type=int, default=100)
    p.add_argument("--patience", type=int, default=25, help="Early-stop after N epochs without improvement.")
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--batch", type=int, default=32,
                   help="Images per batch. Use -1 for auto-batch based on free VRAM.")

    # hardware
    p.add_argument("--device", default="0", help="'0', '0,1', or 'cpu'.")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--cache", default="False", choices=["False", "ram", "disk"],
                   help="Cache images to speed up epochs. 'ram' needs ~ dataset size in memory.")
    p.add_argument("--amp", action="store_true", default=True, help="Mixed precision (on by default).")
    p.add_argument("--no-amp", dest="amp", action="store_false")

    # optimisation
    # NOTE: 'auto' selects MuSGD whenever epochs*batches_per_epoch > 10000, and MuSGD is
    # broken in ultralytics 8.4.137 (muon.py:99 calls .view() on a non-contiguous tensor).
    # This dataset always exceeds that threshold, so we default to AdamW instead.
    p.add_argument("--optimizer", default="AdamW", choices=["auto", "SGD", "Adam", "AdamW"])
    p.add_argument("--lr0", type=float, default=None,
                   help="Initial LR. Default: 0.01 for SGD, else Ultralytics' auto formula "
                        "0.002*5/(4+nc). Ignored when optimizer=auto.")
    p.add_argument("--lrf", type=float, default=0.01, help="Final LR as a fraction of lr0.")
    p.add_argument("--cos-lr", action="store_true", default=True)
    p.add_argument("--freeze", type=int, default=None,
                   help="Freeze the first N layers (e.g. 10) for a lighter fine-tune.")

    # post-training
    p.add_argument("--skip-test", action="store_true", help="Do not evaluate on the test split.")
    p.add_argument("--export", default=None, choices=["onnx", "engine", "torchscript", "openvino"],
                   help="Export the best weights after training.")

    return p.parse_args()


def main() -> None:
    args = parse_args()
    data_yaml, data_cfg = build_data_yaml()

    # Imported here so --help stays fast and does not pay the torch import cost.
    from ultralytics import YOLO

    weights = args.model
    if args.resume:
        last = Path(args.project) / args.name / "weights" / "last.pt"
        if not last.exists():
            raise FileNotFoundError(f"--resume given but no checkpoint at {last}")
        weights = str(last)
        print(f"[resume] {weights}")

    model = YOLO(weights)

    train_kwargs = dict(
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        workers=args.workers,
        cache=False if args.cache == "False" else args.cache,
        amp=args.amp,
        optimizer=args.optimizer,
        lrf=args.lrf,
        cos_lr=args.cos_lr,
        patience=args.patience,
        project=args.project,
        name=args.name,
        exist_ok=args.resume,
        resume=args.resume,
        pretrained=True,
        seed=0,
        deterministic=True,
        val=True,
        plots=True,
        save_period=10,          # keep a checkpoint every 10 epochs

        # Augmentation — tuned for dashcam/CCTV road scenes.
        hsv_h=0.015, hsv_s=0.7, hsv_v=0.4,
        degrees=0.0,             # road footage is gravity-aligned; rotation adds little
        translate=0.1,
        scale=0.5,
        shear=0.0,
        perspective=0.0,
        flipud=0.0,              # never see upside-down traffic
        fliplr=0.5,
        mosaic=1.0,
        close_mosaic=10,         # disable mosaic for the final 10 epochs
        mixup=0.0,
        erasing=0.4,
    )

    if args.optimizer != "auto":
        lr0 = args.lr0
        if lr0 is None:
            # Mirror the LR that optimizer='auto' would have derived for this class count.
            nc = int(data_cfg.get("nc", 80))
            lr0 = 0.01 if args.optimizer == "SGD" else round(0.002 * 5 / (4 + nc), 6)
        train_kwargs["lr0"] = lr0
        print(f"[train] optimizer={args.optimizer}  lr0={lr0}")
    if args.freeze is not None:
        train_kwargs["freeze"] = args.freeze

    print(f"[train] model={weights}  epochs={args.epochs}  imgsz={args.imgsz}  batch={args.batch}")
    results = model.train(**train_kwargs)

    save_dir = Path(results.save_dir)
    best = save_dir / "weights" / "best.pt"
    print(f"\n[done] run dir : {save_dir}")
    print(f"[done] best    : {best}")

    if not args.skip_test:
        print("\n[test] evaluating best.pt on the held-out test split ...")
        test_metrics = YOLO(str(best)).val(
            data=str(data_yaml),
            split="test",
            imgsz=args.imgsz,
            batch=args.batch if args.batch > 0 else 16,
            device=args.device,
            project=args.project,
            name=f"{args.name}_test",
            plots=True,
        )
        box = test_metrics.box
        print(f"[test] mAP50-95 : {box.map:.4f}")
        print(f"[test] mAP50    : {box.map50:.4f}")
        print(f"[test] precision: {box.mp:.4f}")
        print(f"[test] recall   : {box.mr:.4f}")
        for i, name in enumerate(test_metrics.names.values()):
            print(f"[test]   {name:<14} mAP50-95={box.maps[i]:.4f}")

    if args.export:
        print(f"\n[export] {args.export} ...")
        out = YOLO(str(best)).export(format=args.export, imgsz=args.imgsz, half=True)
        print(f"[export] {out}")

    final = ROOT / f"{args.name}_best.pt"
    shutil.copy2(best, final)
    print(f"\n[done] copied best weights -> {final}")


if __name__ == "__main__":
    main()
