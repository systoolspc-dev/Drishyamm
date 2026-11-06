"""Stage 5: export the trained classifier to ONNX for the GPU server
(ONNX Runtime / TensorRT). YOLO-pose exports to TensorRT separately via
`yolo export model=yolov8s-pose.pt format=engine`.

Usage:
    python -m src.model.export_onnx --model models/fall_cnn.pt --out models/fall_cnn.onnx
"""
from __future__ import annotations
import argparse
from pathlib import Path

import torch

import config
from src.model.model import build_model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=Path, default=config.FALL_CLASSIFIER_PATH)
    ap.add_argument("--out", type=Path, default=config.MODELS_DIR / "fall_cnn.onnx")
    args = ap.parse_args()

    ckpt = torch.load(args.model, map_location="cpu")
    model = build_model(ckpt["n_features"])
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    dummy = torch.randn(1, config.WINDOW_SIZE, ckpt["n_features"])
    torch.onnx.export(
        model, dummy, str(args.out),
        input_names=["window"], output_names=["fall_logit"],
        dynamic_axes={"window": {0: "batch"}, "fall_logit": {0: "batch"}},
        opset_version=17,
    )
    print(f"exported -> {args.out}  (input: [batch, {config.WINDOW_SIZE}, "
          f"{ckpt['n_features']}])")


if __name__ == "__main__":
    main()
