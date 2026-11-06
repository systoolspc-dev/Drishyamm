#!/usr/bin/env python3
"""Render an annotated copy of a video: detections + per-person activity states.

    python render_video.py input.mp4 output.mp4

Runs each frame through the configured detectors + activity analyzer (with proper
temporal smoothing via frame timestamps) and draws state boxes, conversation lines,
and a live count banner. Produces a normal MP4 you can play/scrub in any viewer.
"""

import argparse

import cv2

from activity_monitor.config import load_config
from activity_monitor.model import Detector
from activity_monitor.activity import ActivityAnalyzer

STATE_COLORS = {
    "working": (0, 200, 0), "not_working": (0, 0, 255), "on_phone": (0, 165, 255),
    "talking": (255, 170, 0), "unknown": (170, 170, 170),
}


def draw(frame, people, phone_boxes, counts, fps):
    h, w = frame.shape[:2]
    scale = max(0.6, w / 1100)
    thick = max(1, int(scale * 2))

    for pb in phone_boxes:
        x1, y1, x2, y2 = (int(v) for v in pb)
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 165, 255), thick)

    centers = {p["id"]: ((p["box"][0] + p["box"][2]) // 2,
                         (p["box"][1] + p["box"][3]) // 2) for p in people}
    drawn = set()
    for p in people:
        for other in p.get("talking_with", []):
            key = tuple(sorted((p["id"], other)))
            if key in drawn or other not in centers:
                continue
            drawn.add(key)
            cv2.line(frame, centers[p["id"]], centers[other], (255, 170, 0), thick + 1, cv2.LINE_AA)

    for p in people:
        x1, y1, x2, y2 = p["box"]
        color = STATE_COLORS.get(p["state"], (170, 170, 170))
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, thick + 1)
        tag = f"#{p['id']} {p['state']}"
        (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, scale * 0.7, 2)
        cv2.rectangle(frame, (x1, y1 - th - 8), (x1 + tw + 6, y1), color, -1)
        cv2.putText(frame, tag, (x1 + 3, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX,
                    scale * 0.7, (0, 0, 0), 2, cv2.LINE_AA)

    banner = "  ".join(f"{k}: {v}" for k, v in counts.items()) + f"  |  {fps:.0f} FPS"
    (tw, th), base = cv2.getTextSize(banner, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
    cv2.rectangle(frame, (0, 0), (tw + 20, th + base + 16), (0, 0, 0), -1)
    cv2.putText(frame, banner, (10, th + 8), cv2.FONT_HERSHEY_SIMPLEX,
                scale, (0, 255, 0), thick, cv2.LINE_AA)
    return frame


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--config", default="config/config.yaml")
    args = ap.parse_args()

    cfg = load_config(args.config)
    phone_dc = next((d for d in cfg.detectors if d.id == cfg.activity.phone_detector_id), None)
    phone_det = Detector(phone_dc) if phone_dc else None
    analyzer = ActivityAnalyzer(cfg.activity)

    cap = cv2.VideoCapture(args.input)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    out = cv2.VideoWriter(args.output, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = idx / fps                       # timestamp drives temporal hysteresis
        phone_boxes = phone_det.infer(frame).boxes.xyxy.tolist() if phone_det else []
        people = analyzer.analyze(frame, phone_boxes, now=t)
        counts = ActivityAnalyzer.counts(people)
        out.write(draw(frame, people, phone_boxes, counts, fps))
        idx += 1
        if idx % 30 == 0:
            print(f"  {idx}/{total} frames", end="\r")

    cap.release()
    out.release()
    print(f"\nwrote {idx} frames -> {args.output}")


if __name__ == "__main__":
    main()
