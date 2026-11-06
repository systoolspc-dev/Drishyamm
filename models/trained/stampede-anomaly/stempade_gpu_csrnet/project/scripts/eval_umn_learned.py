#!/usr/bin/env python
"""Honest UMN eval: learned fusion with leave-one-scene-out cross-validation.

Instead of hand-tuned 'crush' priors, we feed per-camera-normalized motion features
to a logistic-regression fuser and LEARN the weights. Each scene is normalized by its
OWN normal-head baseline (per-camera calibration, as in deployment). We train on two
scenes and test on the third — the test scene is never seen, so the number is honest
and non-circular (labels come from the burned-in red overlay, not from motion).
"""
from __future__ import annotations

import cv2
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from stempade.motion import MotionAnalyzer

SCENES = {
    "scene1": ("data/umn/scene1.avi", "data/umn/scene1.labels.txt", 525),
    "scene2": ("data/umn/scene2.avi", "data/umn/scene2.labels.txt", 1806 - 1453),
    "scene3": ("data/umn/scene3.avi", "data/umn/scene3.labels.txt", 6195 - 5597),
}
FEATS = ["speed", "acceleration", "convergence", "divergence",
         "kinetic_energy", "angular_entropy", "order_parameter"]


def scene_features(video, labels_path, first_event):
    """Return per-camera-normalized feature matrix X and labels y for one scene."""
    y = np.loadtxt(labels_path).astype(int).ravel()
    an = MotionAnalyzer()
    cap = cv2.VideoCapture(video)
    rows, yy = [], []
    idx = 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        f = an.process(fr)
        if f is not None:
            rows.append([f[k] for k in FEATS])
            yy.append(y[idx] if idx < len(y) else 0)
        idx += 1
    cap.release()
    X = np.array(rows, dtype=float)
    yy = np.array(yy)

    # per-camera normalization: z-score using this scene's NORMAL head only
    normal_end = max(20, first_event - 20)
    mu = X[:normal_end].mean(axis=0)
    sd = X[:normal_end].std(axis=0) + 1e-6
    Xn = (X - mu) / sd
    return Xn, yy


def main():
    data = {name: scene_features(*cfg) for name, cfg in SCENES.items()}

    print("Leave-one-scene-out (train on 2 scenes, test on the unseen 3rd):\n")
    aucs = []
    for test in SCENES:
        Xtr = np.vstack([data[s][0] for s in SCENES if s != test])
        ytr = np.concatenate([data[s][1] for s in SCENES if s != test])
        Xte, yte = data[test]
        clf = LogisticRegression(max_iter=2000, class_weight="balanced")
        clf.fit(Xtr, ytr)
        p = clf.predict_proba(Xte)[:, 1]
        auc = roc_auc_score(yte, p)
        aucs.append(auc)
        print(f"  test={test}:  AUC={auc:.4f}   (trained on the other two)")

    print(f"\n  mean held-out AUC = {np.mean(aucs):.4f}")
    # show what it learned (sign = which features mean danger)
    clf = LogisticRegression(max_iter=2000, class_weight="balanced")
    Xall = np.vstack([data[s][0] for s in SCENES])
    yall = np.concatenate([data[s][1] for s in SCENES])
    clf.fit(Xall, yall)
    print("\n  learned feature weights (positive = signals danger):")
    for k, w in sorted(zip(FEATS, clf.coef_[0]), key=lambda t: -abs(t[1])):
        print(f"    {k:16s} {w:+.2f}")


if __name__ == "__main__":
    main()
