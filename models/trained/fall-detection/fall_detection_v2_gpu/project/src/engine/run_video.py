"""Phase-1 deliverable: run the fall engine on a video file (or RTSP URL) and
produce an annotated output video + a JSON event log. This is how you validate
the detection core before wiring up the production services.

Usage:
    python -m src.engine.run_video --video clip.mp4 --out annotated.mp4
    python -m src.engine.run_video --video rtsp://... --show          # live
    python -m src.engine.run_video --video clip.mp4 --pose-only       # no model

Colors:  green = normal,  orange = candidate (possible fall),  red = FALL.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

import config
from src.pose.factory import get_pose_estimator

_COLORS = {"normal": (0, 200, 0), "candidate": (0, 165, 255), "fall": (0, 0, 255)}


def _draw(frame, poses, status):
    h, w = frame.shape[:2]
    for p in poses:
        st, prob = status.get(p.track_id, (None, 0.0))
        name = st.value if st else "normal"
        color = _COLORS[name]
        # keypoints
        for i in range(config.N_KEYPOINTS):
            if p.keypoints[i, 2] >= config.KP_CONF_THRESHOLD:
                cx, cy = int(p.keypoints[i, 1] * w), int(p.keypoints[i, 0] * h)
                cv2.circle(frame, (cx, cy), 3, color, -1)
        for a, b in config.EDGES:
            if (p.keypoints[a, 2] >= config.KP_CONF_THRESHOLD
                    and p.keypoints[b, 2] >= config.KP_CONF_THRESHOLD):
                pa = (int(p.keypoints[a, 1] * w), int(p.keypoints[a, 0] * h))
                pb = (int(p.keypoints[b, 1] * w), int(p.keypoints[b, 0] * h))
                cv2.line(frame, pa, pb, color, 2)
        x1, y1, x2, y2 = (p.bbox * np.array([w, h, w, h])).astype(int)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        label = f"id{p.track_id} {name} {prob:.2f}"
        cv2.putText(frame, label, (x1, max(y1 - 8, 12)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
        if name == "fall":
            cv2.putText(frame, "FALL DETECTED", (x1, y2 + 24),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, _COLORS["fall"], 2)
    return frame


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True, help="video file path or RTSP URL")
    ap.add_argument("--out", type=Path, default=None, help="annotated output video")
    ap.add_argument("--events", type=Path, default=Path("events.json"))
    ap.add_argument("--model", type=Path, default=config.FALL_CLASSIFIER_PATH)
    ap.add_argument("--backend", default=config.POSE_BACKEND)
    ap.add_argument("--pose-only", action="store_true", help="skip fall model")
    ap.add_argument("--show", action="store_true", help="display live window")
    args = ap.parse_args()

    estimator = get_pose_estimator(args.backend)
    engine = None
    if not args.pose_only:
        from src.engine.detector import FallEngine
        engine = FallEngine(args.model)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise SystemExit(f"cannot open {args.video}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or config.TARGET_FPS

    writer = None
    if args.out:
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        writer = cv2.VideoWriter(str(args.out),
                                 cv2.VideoWriter_fourcc(*"mp4v"),
                                 config.TARGET_FPS, (w, h))

    events_log, kept, idx = [], 0, 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if int(idx * config.TARGET_FPS / src_fps) < kept:
            idx += 1
            continue
        t_sec = kept / config.TARGET_FPS
        poses = estimator.track(frame)
        status = {}
        if engine:
            status, events = engine.process(poses, t_sec)
            for e in events:
                rec = {"track_id": e.track_id, "time_sec": round(e.time_sec, 2),
                       "bbox": [round(float(v), 4) for v in e.bbox]}
                events_log.append(rec)
                print(f"[FALL] t={rec['time_sec']}s  person id{rec['track_id']}")
        frame = _draw(frame, poses, status)
        if writer:
            writer.write(frame)
        if args.show:
            cv2.imshow("fall-detection", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
        kept += 1
        idx += 1

    cap.release()
    if writer:
        writer.release()
    if args.show:
        cv2.destroyAllWindows()
    args.events.write_text(json.dumps(events_log, indent=2))
    print(f"\nDone. {len(events_log)} fall event(s). Log -> {args.events}"
          + (f", video -> {args.out}" if args.out else ""))


if __name__ == "__main__":
    main()
