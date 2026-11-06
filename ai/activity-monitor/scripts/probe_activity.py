#!/usr/bin/env python3
"""Test & tune per-person activity (working / on_phone / distracted) on an image.

Use this to validate thresholds on real footage from the target camera BEFORE
trusting the live pipeline:

    python probe_activity.py path/to/frame.jpg
    python probe_activity.py frame.jpg --yaw 0.45          # try a stricter yaw threshold
    python probe_activity.py frame.jpg --out result.jpg    # where to save annotated image

It prints each person's yaw + inferred state and writes an annotated image so you
can eyeball whether 'working' vs 'distracted' matches reality, then copy the
chosen --yaw / thresholds into config.yaml under `activity:`.
"""

import argparse

import cv2

from activity_monitor.activity import ActivityAnalyzer, WORKING, NOT_WORKING, ON_PHONE, TALKING
from activity_monitor.config import load_config
from activity_monitor.model import Detector

COLORS = {WORKING: (0, 200, 0), ON_PHONE: (0, 165, 255),
          TALKING: (255, 170, 0), NOT_WORKING: (0, 0, 255)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--config", default="config/config.yaml")
    ap.add_argument("--tilt", type=float, default=None, help="override posture_tilt_max (deg)")
    ap.add_argument("--out", default="activity_probe.jpg")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.tilt is not None:
        cfg.activity.posture_tilt_max = args.tilt
    cfg.activity.hold_seconds = 0.0  # single frame → no temporal smoothing

    analyzer = ActivityAnalyzer(cfg.activity)

    # Phone boxes from the configured phone detector (if present).
    phone_boxes = []
    phone_dc = next((d for d in cfg.detectors if d.id == cfg.activity.phone_detector_id), None)
    img = cv2.imread(args.image)
    if img is None:
        raise SystemExit(f"could not read image: {args.image}")
    if phone_dc:
        pdet = Detector(phone_dc)
        phone_boxes = pdet.infer(img).boxes.xyxy.tolist()

    people = analyzer.analyze(img, phone_boxes, now=0.0)
    print(f"\n{len(people)} people | head_down={cfg.activity.posture_head_down}"
          f" tilt_max={cfg.activity.posture_tilt_max}°\n")
    print(f"{'id':>3}  {'head_lift':>9}  {'tilt':>6}  {'state':>12}")
    for p in people:
        ps = p.get("posture", {})
        hl, tilt = ps.get("head_lift"), ps.get("tilt")
        print(f"{p['id']:>3}  {str(hl):>9}  {str(tilt):>6}  {p['instant']:>12}")
        x1, y1, x2, y2 = p["box"]
        color = COLORS.get(p["instant"], (200, 200, 200))
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 3)
        label = f"#{p['id']} {p['instant']}"
        cv2.putText(img, label, (x1, max(0, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX,
                    0.9, color, 2, cv2.LINE_AA)

    cv2.imwrite(args.out, img)
    print(f"\nannotated -> {args.out}")
    print("If states are wrong, adjust --tilt and re-run; then set activity.posture_tilt_max in config.yaml")


if __name__ == "__main__":
    main()
