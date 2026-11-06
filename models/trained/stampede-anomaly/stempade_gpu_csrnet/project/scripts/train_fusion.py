#!/usr/bin/env python
"""Train the learned fusion model (Phase 5) from labeled videos.

Light — logistic regression on the 4 sub-scores; runs fine on CPU. Collects
per-frame sub-scores by running the pipeline over each (video, labels) pair, then
fits a calibrated risk model and saves it. Point config `fusion.learned_model` at
the output to use it.

Usage:
    python scripts/train_fusion.py \
        --pair data/samples/sim.mp4 data/samples/sim.labels.txt \
        --pair data/umn/scene2.avi data/umn/scene2.labels.txt \
        --out weights/fusion_lr.joblib [--baseline baseline.json]
"""
from __future__ import annotations

import argparse

from stempade.config import load_config
from stempade.eval.harness import load_labels
from stempade.fusion.learned import LearnedFuser
from stempade.pipeline import StampedePipeline


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair", nargs=2, action="append", metavar=("VIDEO", "LABELS"),
                    required=True, help="video + per-frame 0/1 labels (repeatable)")
    ap.add_argument("--config", default=None)
    ap.add_argument("--baseline", default=None)
    ap.add_argument("--out", default="weights/fusion_lr.joblib")
    args = ap.parse_args()

    cfg = load_config(args.config)
    baseline = None
    if args.baseline:
        from stempade.calibration import Baseline
        baseline = Baseline.load(args.baseline)

    rows, labels = [], []
    for video, labels_path in args.pair:
        y = load_labels(labels_path)
        pipe = StampedePipeline(cfg, baseline=baseline)
        for st in pipe.run(video):
            if st.frame_idx < len(y) and st.sub_scores:
                rows.append(st.sub_scores)
                labels.append(int(y[st.frame_idx]))
        print(f"collected {len(rows)} frames after {video}")

    if len(set(labels)) < 2:
        raise SystemExit("need both normal and panic frames to train")

    fuser = LearnedFuser.fit(rows, labels)
    import os
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    fuser.save(args.out)
    print("saved", args.out)
    print("coefficients:", {k: round(v, 3) for k, v in fuser.coefficients().items()})


if __name__ == "__main__":
    main()
