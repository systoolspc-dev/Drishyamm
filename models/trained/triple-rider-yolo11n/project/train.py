"""Train a YOLO11 detector for the two rider-count classes in this dataset."""

from pathlib import Path

import torch
from ultralytics import YOLO


ROOT = Path(__file__).resolve().parent
DATA_YAML = ROOT / "data.yaml"


def main() -> None:
    if not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA GPU is unavailable. Install a CUDA-enabled PyTorch build and "
            "verify that the NVIDIA driver is working before training."
        )

    # Start from COCO-pretrained YOLO11n weights. This keeps setup lightweight
    # while allowing Ultralytics to download the weights on the first run.
    model = YOLO("yolo11n.pt")
    model.train(
        data=str(DATA_YAML),
        epochs=50,
        imgsz=640,
        batch=16,
        device=0,
        patience=10,
        workers=8,
        project=str(ROOT / "runs"),
        name="triple-rider-yolo11n",
        exist_ok=True,
        pretrained=True,
        plots=True,
        seed=42,
    )


if __name__ == "__main__":
    main()
