#!/usr/bin/env python3
"""Export the head model to an edge-optimized format.

On Jetson, TensorRT gives the biggest speedup:
    python export_model.py --format engine --half

On a Raspberry Pi (CPU), ONNX + onnxruntime is a good default:
    python export_model.py --format onnx

Then point config.yaml `model.weights` at the exported file (e.g. models/abel/best.engine).
Ultralytics loads .engine/.onnx transparently through the same YOLO() interface.
"""

import argparse

from ultralytics import YOLO

from activity_monitor.config import load_config
from activity_monitor.model import ensure_weights


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config/config.yaml")
    ap.add_argument("--detector", default=None,
                    help="detector id to export (default: all detectors)")
    ap.add_argument("--format", default="onnx",
                    choices=["onnx", "engine", "openvino", "ncnn", "torchscript"])
    ap.add_argument("--half", action="store_true", help="FP16 (CUDA/TensorRT)")
    ap.add_argument("--imgsz", type=int, default=None)
    args = ap.parse_args()

    cfg = load_config(args.config)
    detectors = [d for d in cfg.detectors if args.detector in (None, d.id)]
    if not detectors:
        raise SystemExit(f"no detector matching {args.detector!r} in {args.config}")

    for det in detectors:
        weights = ensure_weights(det)
        imgsz = args.imgsz or det.imgsz
        print(f"[{det.id}] exporting {weights} -> {args.format} (imgsz={imgsz}, half={args.half})")
        path = YOLO(weights).export(format=args.format, half=args.half, imgsz=imgsz)
        print(f"[{det.id}] done: {path}")
    print("Update each detector's `weights` in config.yaml to the exported paths.")


if __name__ == "__main__":
    main()
