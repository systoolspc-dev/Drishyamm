#!/usr/bin/env python
"""Evaluate the pipeline on the UMN benchmark, per scene, with per-camera baselines.

Labels are the dataset's own burned-in 'Abnormal Crowd Activity' red overlay
(non-circular ground truth). Each scene is treated as its own camera: the baseline
is calibrated on that scene's NORMAL head only, then the full scene is scored.
"""
from __future__ import annotations

import numpy as np
from sklearn.metrics import roc_auc_score

from stempade.config import load_config
from stempade.calibration import estimate_baseline
from stempade.pipeline import StampedePipeline

SCENES = {
    "scene1": {"video": "data/umn/scene1.avi", "labels": "data/umn/scene1.labels.txt",
               "first_event": 525},
    "scene2": {"video": "data/umn/scene2.avi", "labels": "data/umn/scene2.labels.txt",
               "first_event": 1806 - 1453},
    "scene3": {"video": "data/umn/scene3.avi", "labels": "data/umn/scene3.labels.txt",
               "first_event": 6195 - 5597},
}


def main():
    cfg = load_config()
    cfg["ingestion"]["target_fps"] = 30      # native fps -> 1:1 frame/label alignment
    cfg["ingestion"]["resize"] = [320, 240]
    cfg["fusion"]["temporal_persistence_sec"] = 0.5   # UMN events are short (1-7s)

    all_scores, all_labels = [], []
    for name, s in SCENES.items():
        labels = np.loadtxt(s["labels"]).astype(int).ravel()
        # calibrate on the normal head only (leave a 20-frame margin before onset)
        bl = estimate_baseline(s["video"], target_fps=30, resize=(320, 240),
                               max_frames=max(50, s["first_event"] - 20))
        pipe = StampedePipeline(cfg, baseline=bl)
        scores = np.array([st.score for st in pipe.run(s["video"])])
        n = min(len(scores), len(labels))
        scores, y = scores[:n], labels[:n]
        auc = roc_auc_score(y, scores) if y.min() != y.max() else float("nan")
        all_scores.append(scores); all_labels.append(y)
        print(f"{name}: frames={n}  abnormal={y.sum():4d}  AUC={auc:.4f}")

    S = np.concatenate(all_scores); Y = np.concatenate(all_labels)
    print(f"\nOVERALL  frames={len(S)}  abnormal={Y.sum()}  AUC={roc_auc_score(Y, S):.4f}")


if __name__ == "__main__":
    main()
