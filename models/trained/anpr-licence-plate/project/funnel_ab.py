"""funnel_ab.py — A/B the plate DETECTOR on the real frames the reader saved.

The number that decides "10 cars → 10 plates" is not OCR accuracy, it is the
funnel in front of it: of the vehicles the vehicle detector boxes, how many get
a plate box at all, and how many of those plates are tall enough to read
(≥ 24 px). This script measures exactly that for one or more plate detectors on
the same frames with the same vehicle boxes, at the worker's own confidence
(ANPR_PLATE_CONF, 0.30), so a retrained detector is judged on the cameras it
will actually serve — not on its own validation split.

Run inside the trainer (or the worker, briefly — it shares the GPU):

    docker exec -w /srv/anpr trinetra-anpr-trainer python funnel_ab.py
    docker exec -w /srv/anpr trinetra-anpr-trainer python funnel_ab.py \
        --frames "data/records/2026-09-1*/*/*_frame.jpg" --per-camera 8 \
        --model current=models/best.pt --model retrained=models/best_ft.pt --conf 0.30

Output, per model:  plate boxes | inside a vehicle box (% of vehicles) |
readable ≥ 24 px (% of vehicles) | median plate height px — and, with
--per-camera-report, the same per camera so a re-aim / zoom candidate stands
out. Measured 10 Sep 2026 on 116 frames / 559 vehicles: current best.pt 19 % /
15 % readable, median 30 px.
"""

from __future__ import annotations

import argparse
import collections
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cv2  # noqa: E402
from ultralytics import YOLO  # noqa: E402

VEH_CLASSES = [2, 3, 5, 7]  # car, motorcycle, bus, truck (COCO)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "--frames",
        default=os.path.join(HERE, "data", "records", "2026-*", "*", "*_frame.jpg"),
        help="glob of saved full frames (default: every records/<date>/<camera>/*_frame.jpg)",
    )
    ap.add_argument("--per-camera", type=int, default=8, help="frames sampled per camera (spread over time)")
    ap.add_argument(
        "--model",
        action="append",
        default=[],
        help="label=path of a plate detector; repeatable (default: current=models/best.pt, retrained=models/best_ft.pt)",
    )
    ap.add_argument("--vehicle-model", default=os.path.join(HERE, "models", "yolov8n.pt"))
    ap.add_argument(
        "--conf",
        type=float,
        default=float(os.getenv("ANPR_PLATE_CONF", "0.30")),
        help="plate detector confidence (the worker's ANPR_PLATE_CONF)",
    )
    ap.add_argument("--vehicle-conf", type=float, default=0.15)
    ap.add_argument("--readable-px", type=int, default=24, help="plate height that counts as readable")
    ap.add_argument("--per-camera-report", action="store_true", help="also print the funnel per camera")
    args = ap.parse_args()

    models = args.model or [
        f"current={os.path.join(HERE, 'models', 'best.pt')}",
        f"retrained={os.path.join(HERE, 'models', 'best_ft.pt')}",
    ]

    frames = sorted(glob.glob(args.frames), key=os.path.getmtime)
    bycam: dict[str, list[str]] = collections.defaultdict(list)
    for f in frames:
        bycam[os.path.basename(os.path.dirname(f))].append(f)
    sample: list[str] = []
    for cam, fs in bycam.items():
        step = max(1, len(fs) // max(1, args.per_camera))
        sample += fs[::step][: args.per_camera]
    if not sample:
        print(f"no frames match {args.frames}")
        return 2
    print(f"frames: {len(sample)}  cameras: {len(bycam)}  plate conf: {args.conf}")

    veh = YOLO(args.vehicle_model)
    veh_boxes: dict[str, list] = {}
    for f in sample:
        img = cv2.imread(f)
        if img is None:
            continue
        r = veh.predict(img, conf=args.vehicle_conf, classes=VEH_CLASSES, imgsz=640, verbose=False)[0]
        veh_boxes[f] = r.boxes.xyxy.tolist()
    n_veh = sum(len(v) for v in veh_boxes.values())
    print(f"vehicles detected (shared across models): {n_veh}")

    for spec in models:
        label, _, path = spec.partition("=")
        if not path:
            label, path = os.path.basename(spec), spec
        if not os.path.exists(path):
            print(f"{label:<12} -> {path} missing")
            continue
        pla = YOLO(path)
        tot = dict(boxes=0, owned=0, readable=0)
        heights: list[float] = []
        percam: dict[str, dict] = collections.defaultdict(lambda: dict(veh=0, owned=0, readable=0, h=[]))
        for f, vb in veh_boxes.items():
            cam = os.path.basename(os.path.dirname(f))
            percam[cam]["veh"] += len(vb)
            img = cv2.imread(f)
            p = pla.predict(img, conf=args.conf, imgsz=640, verbose=False)[0]
            for x1, y1, x2, y2 in p.boxes.xyxy.tolist():
                tot["boxes"] += 1
                h = y2 - y1
                heights.append(h)
                cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
                if any(a <= cx <= c and b <= cy <= d for (a, b, c, d) in vb):
                    tot["owned"] += 1
                    percam[cam]["owned"] += 1
                    percam[cam]["h"].append(h)
                    if h >= args.readable_px:
                        tot["readable"] += 1
                        percam[cam]["readable"] += 1
        heights.sort()
        med = heights[len(heights) // 2] if heights else 0
        print(
            "%-12s plate boxes %4d | inside a vehicle box %4d (%3.0f%% of vehicles) | readable >=%dpx %4d (%3.0f%% of vehicles) | median plate h %2.0f px"
            % (
                label,
                tot["boxes"],
                tot["owned"],
                100 * tot["owned"] / max(1, n_veh),
                args.readable_px,
                tot["readable"],
                100 * tot["readable"] / max(1, n_veh),
                med,
            )
        )
        if args.per_camera_report:
            for cam in sorted(percam):
                c = percam[cam]
                hs = sorted(c["h"])
                cm = hs[len(hs) // 2] if hs else 0
                verdict = "re-aim / zoom" if c["veh"] and (c["readable"] / c["veh"] < 0.05 or cm < 18) else ""
                print(
                    "    %-14s vehicles %4d | plated %3d (%3.0f%%) | readable %3d (%3.0f%%) | median %2.0f px  %s"
                    % (
                        cam,
                        c["veh"],
                        c["owned"],
                        100 * c["owned"] / max(1, c["veh"]),
                        c["readable"],
                        100 * c["readable"] / max(1, c["veh"]),
                        cm,
                        verdict,
                    )
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
