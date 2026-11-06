"""
collect_crops.py — harvest real plate crops from the live feeds (dataset flywheel seed).

Runs anywhere the plate detector runs — the plain AI image is enough (it uses
open-image-models' YOLOv9 plate detector, falling back to models/best.onnx or
best.pt). Writes:

    data/crops/raw/<cam>_<frame>_<k>.jpg   plate crop (6-12 % pad)
    data/crops/raw/index.jsonl             one line per crop: camera, ts, det
                                           conf, bbox, blur/night assessment
    data/frames/<cam>_<frame>.jpg          one full frame every --frame-every
                                           (for future detector fine-tuning)

Usage (inside the container, from this folder):
    python collect_crops.py --cams corp8_13,corp8_07 --frames 300 --every 4
    python collect_crops.py --source /path/clip.mp4 --name clip1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import plate_enhance as enh  # noqa: E402
from worker import hls_for  # noqa: E402


def load_detector(conf: float):
    """→ callable(frame) -> list[(x1,y1,x2,y2,conf)]"""
    try:
        from open_image_models import LicensePlateDetector

        det = LicensePlateDetector(detection_model="yolo-v9-t-384-license-plate-end2end")

        def run(frame):
            out = []
            for d in det.predict(frame):
                c = float(getattr(d, "confidence", 0.0) or 0.0)
                if c < conf:
                    continue
                bb = d.bounding_box
                out.append((float(bb.x1), float(bb.y1), float(bb.x2), float(bb.y2), c))
            return out

        print("[collect] detector: open-image-models yolo-v9-t-384", flush=True)
        return run
    except Exception as e:  # noqa: BLE001
        print(f"[collect] open-image-models unavailable ({e}); trying local model", flush=True)
    onnx = os.path.join(HERE, "models", "best.onnx")
    if os.path.exists(onnx):
        from yolo_onnx import YoloOnnx

        m = YoloOnnx(onnx, conf=conf)
        print(f"[collect] detector: {onnx} ({m.provider})", flush=True)
        return lambda f: [tuple(r[:5]) for r in m(f)]
    from ultralytics import YOLO

    m = YOLO(os.path.join(HERE, "models", "best.pt"))
    print("[collect] detector: ultralytics best.pt", flush=True)

    def run(frame):
        r = m.predict(frame, conf=conf, verbose=False)[0]
        if r.boxes is None:
            return []
        return [(*map(float, b.xyxy[0].tolist()), float(b.conf[0])) for b in r.boxes]

    return run


def collect(name: str, url: str, det, out_dir: str, frames: int, every: int, frame_every: int, min_w: int):
    from video_source import VideoSource

    try:
        src = VideoSource(url, max_reconnects=5)
    except Exception as e:  # noqa: BLE001
        print(f"[collect] {name}: cannot open {url}: {e}", flush=True)
        return 0
    os.makedirs(out_dir, exist_ok=True)
    frames_dir = os.path.join(os.path.dirname(out_dir.rstrip("/\\")), "..", "frames")
    frames_dir = os.path.normpath(frames_dir)
    os.makedirs(frames_dir, exist_ok=True)
    index = open(os.path.join(out_dir, "index.jsonl"), "a", encoding="utf-8")
    n_saved = 0
    i = 0
    t0 = time.time()
    while i < frames:
        got = src.read(timeout=30)
        if got is None:
            break
        frame = got[0]
        if frame is None:
            if time.time() - t0 > 120 and i == 0:
                break
            continue
        i += 1
        if i % every:
            continue
        if frame_every and i % frame_every == 0:
            cv2.imwrite(
                os.path.join(frames_dir, f"{name}_{i:06d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 92]
            )
        h, w = frame.shape[:2]
        for k, (x1, y1, x2, y2, c) in enumerate(det(frame)):
            if x2 - x1 < min_w:
                continue
            px, py = int((x2 - x1) * 0.06) + 2, int((y2 - y1) * 0.12) + 2
            crop = frame[
                max(0, int(y1) - py) : min(h, int(y2) + py), max(0, int(x1) - px) : min(w, int(x2) + px)
            ]
            if crop.size == 0:
                continue
            fn = f"{name}_{i:06d}_{k}.jpg"
            cv2.imwrite(os.path.join(out_dir, fn), crop, [cv2.IMWRITE_JPEG_QUALITY, 95])
            a = enh.assess(crop)
            index.write(
                json.dumps(
                    {
                        "file": fn,
                        "camera": name,
                        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                        "frame": i,
                        "det_conf": round(c, 3),
                        "bbox": [int(x1), int(y1), int(x2), int(y2)],
                        "frame_size": [w, h],
                        **a.as_dict(),
                    }
                )
                + "\n"
            )
            n_saved += 1
    index.close()
    src.close()
    print(
        f"[collect] {name}: {i} frames read ({src.backend}), {n_saved} crops saved to {out_dir}", flush=True
    )
    return n_saved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cams", default=os.getenv("ANPR_CAMERAS", "corp8_13"))
    ap.add_argument("--source", default=None, help="file/rtsp/hls url instead of --cams")
    ap.add_argument("--name", default="src")
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--every", type=int, default=4)
    ap.add_argument("--frame-every", type=int, default=60)
    ap.add_argument("--conf", type=float, default=0.30)
    ap.add_argument("--min-w", type=int, default=24)
    ap.add_argument("--out", default=os.path.join(HERE, "data", "crops", "raw"))
    args = ap.parse_args()
    det = load_detector(args.conf)
    total = 0
    if args.source:
        total += collect(
            args.name, args.source, det, args.out, args.frames, args.every, args.frame_every, args.min_w
        )
    else:
        for cam in [c.strip() for c in args.cams.split(",") if c.strip()]:
            url = hls_for(cam) or cam
            total += collect(cam, url, det, args.out, args.frames, args.every, args.frame_every, args.min_w)
    print(f"[collect] done: {total} crops", flush=True)


if __name__ == "__main__":
    main()
