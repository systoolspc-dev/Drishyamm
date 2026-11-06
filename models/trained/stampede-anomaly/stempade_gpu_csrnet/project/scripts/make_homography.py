#!/usr/bin/env python
"""Build a per-camera homography (pixel -> ground-plane meters) from >=4 points.

Provide 4+ correspondences between image pixels and known ground coordinates in
meters (e.g. floor markings, tile corners, a measured rectangle). Saves a 3x3
matrix as JSON for use via `--homography`.

Usage:
    python scripts/make_homography.py \
        --pt 120 400  0 0 \
        --pt 520 400  10 0 \
        --pt 500 200  10 8 \
        --pt 140 200  0 8 \
        --out camera1.homography.json
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from stempade.calibration import Homography


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pt", nargs=4, type=float, action="append", required=True,
                    metavar=("PX", "PY", "MX", "MY"),
                    help="image px,py -> world meters mx,my (repeat >=4x)")
    ap.add_argument("--out", default="camera.homography.json")
    args = ap.parse_args()

    if len(args.pt) < 4:
        raise SystemExit("need at least 4 --pt correspondences")

    img = np.array([[p[0], p[1]] for p in args.pt])
    world = np.array([[p[2], p[3]] for p in args.pt])
    H = Homography.from_points(img, world)
    json.dump(H.matrix.tolist(), open(args.out, "w"), indent=2)
    print("saved", args.out)


if __name__ == "__main__":
    main()
