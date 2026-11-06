"""
Live head counting with YOLO.

Counts how many people (heads) are visible in a live video stream, frame by frame,
and draws a smoothed count on screen.

Usage:
    python count_heads.py                      # default webcam (source 0)
    python count_heads.py --source 1           # another camera index
    python count_heads.py --source rtsp://...  # IP / RTSP stream
    python count_heads.py --source video.mp4   # a video file
    python count_heads.py --weights yolov8n-head.pt   # use a head-trained model

By default this uses YOLO's person detection (COCO class 0). That works well for
sparse, well-separated people. For crowded scenes, pass a head-detection model
trained on CrowdHuman / SCUT-HEAD via --weights so occluded heads still count.

Press 'q' to quit.
"""

import argparse
from collections import deque

import cv2
import numpy as np
from ultralytics import YOLO


def parse_args():
    p = argparse.ArgumentParser(description="Live head counting with YOLO")
    p.add_argument("--source", default="0",
                   help="Camera index (e.g. 0), video file path, or stream URL")
    p.add_argument("--weights", default="models/abel/best.pt",
                   help="YOLO weights. Defaults to a CrowdHuman head-detection model. "
                        "Pass yolov8n.pt to count full-body persons instead")
    p.add_argument("--conf", type=float, default=0.35,
                   help="Confidence threshold (0-1). Lower = more detections/noise")
    p.add_argument("--smooth", type=int, default=5,
                   help="Rolling-median window (frames) to steady the count. 1 = off")
    p.add_argument("--imgsz", type=int, default=640, help="Inference image size")
    p.add_argument("--no-display", action="store_true",
                   help="Run headless: print counts, don't open a window")
    return p.parse_args()


def resolve_source(source: str):
    """Return an int for a camera index, else the string path/URL unchanged."""
    return int(source) if source.isdigit() else source


def find_person_class(model):
    """Class id to count. Prefer a 'head' class if the model has one, else 'person'."""
    names = {v.lower(): k for k, v in model.names.items()}
    if "head" in names:
        return names["head"], "head"
    if "person" in names:
        return names["person"], "person"
    # Single-class custom model: count everything.
    return None, model.names.get(0, "object")


def draw_overlay(frame, count, label):
    h, w = frame.shape[:2]
    text = f"{label}s: {count}"
    scale = max(0.8, w / 900)
    thick = max(2, int(scale * 2))
    (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
    cv2.rectangle(frame, (10, 10), (20 + tw, 30 + th + base), (0, 0, 0), -1)
    cv2.putText(frame, text, (15, 20 + th), cv2.FONT_HERSHEY_SIMPLEX,
                scale, (0, 255, 0), thick, cv2.LINE_AA)
    return frame


def main():
    args = parse_args()

    print(f"Loading model: {args.weights}")
    model = YOLO(args.weights)
    class_id, label = find_person_class(model)
    print(f"Counting class: '{label}'"
          + (f" (id {class_id})" if class_id is not None else " (all detections)"))

    source = resolve_source(args.source)
    classes = [class_id] if class_id is not None else None
    history = deque(maxlen=max(1, args.smooth))

    stream = model.predict(
        source=source,
        stream=True,
        conf=args.conf,
        imgsz=args.imgsz,
        classes=classes,
        verbose=False,
    )

    try:
        for result in stream:
            raw = len(result.boxes)
            history.append(raw)
            count = int(np.median(history))  # steadies frame-to-frame flicker

            if args.no_display:
                print(f"{label}s: {count}  (raw {raw})")
                continue

            frame = result.plot()  # draws detection boxes
            frame = draw_overlay(frame, count, label)
            cv2.imshow("Head count  (press q to quit)", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
