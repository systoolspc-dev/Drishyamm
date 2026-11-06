"""Measure detection rate vs detector input size (and optional 2x2 tiling).

Answers one question with evidence: are we losing faces because the detector
input is too small for the source resolution? Downscaling a 6000px group photo
to 960px shrinks a 200px face to ~32px — under the reliable-detection floor.

    python -m vms_face.eval.det_size_sweep --dir /tmp/eval_data/probe \
        --sizes 960 1280 1600 2048 --limit 40 --tile
"""
from __future__ import annotations

import argparse
import glob
import time

import cv2
import numpy as np
from insightface.app import FaceAnalysis


def load(size: int) -> FaceAnalysis:
    app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection"])
    app.prepare(ctx_id=0, det_size=(size, size))
    return app


def detect_tiled(app: FaceAnalysis, img: np.ndarray, overlap: float = 0.2) -> int:
    """2x2 overlapping tiles (SAHI-style). Counts faces per tile — approximate
    (no cross-tile dedup), so read it as 'did tiling surface more faces?'."""
    h, w = img.shape[:2]
    th, tw = int(h * (0.5 + overlap / 2)), int(w * (0.5 + overlap / 2))
    total = 0
    for y in (0, h - th):
        for x in (0, w - tw):
            total += len(app.get(img[y:y + th, x:x + tw]))
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--sizes", type=int, nargs="+", default=[960, 1280, 1600, 2048])
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--tile", action="store_true", help="also test 2x2 tiling at base size")
    args = ap.parse_args()

    files = sorted(glob.glob(f"{args.dir}/*"))[: args.limit]
    if not files:
        raise SystemExit(f"no images in {args.dir}")
    imgs = [(f.split("/")[-1], cv2.imread(f)) for f in files]
    imgs = [(n, im) for n, im in imgs if im is not None]
    print(f"images: {len(imgs)}  (e.g. {imgs[0][1].shape[1]}x{imgs[0][1].shape[0]})\n")
    print(f"{'det_size':>10} {'found>=1':>10} {'rate':>7} {'faces':>7} {'ms/img':>8}")
    print("-" * 46)

    base_rate = None
    for size in args.sizes:
        app = load(size)
        hits = faces = 0
        t0 = time.time()
        for _, im in imgs:
            n = len(app.get(im))
            faces += n
            hits += n > 0
        ms = (time.time() - t0) * 1000 / len(imgs)
        rate = hits / len(imgs)
        base_rate = base_rate if base_rate is not None else rate
        print(f"{size:>10} {hits:>10} {rate:>7.3f} {faces:>7} {ms:>8.1f}")

    if args.tile:
        app = load(args.sizes[0])
        hits = faces = 0
        t0 = time.time()
        for _, im in imgs:
            n = detect_tiled(app, im)
            faces += n
            hits += n > 0
        ms = (time.time() - t0) * 1000 / len(imgs)
        print(f"{'tiled2x2':>10} {hits:>10} {hits/len(imgs):>7.3f} {faces:>7} {ms:>8.1f}"
              f"   (base det_size={args.sizes[0]})")

    print("\nRead: 'rate' is the ceiling on recall — a face never detected can never match.")


if __name__ == "__main__":
    main()
