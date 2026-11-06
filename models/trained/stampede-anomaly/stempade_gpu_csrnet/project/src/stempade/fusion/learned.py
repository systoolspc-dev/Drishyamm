"""Learned fusion (Phase 5).

Replaces the hand-weighted risk sum with a model trained offline on labeled events
collected from real streams (stream -> collect -> human-label -> retrain offline ->
validate -> redeploy frozen). We use logistic regression: light enough to train on
CPU, calibrated probabilities in [0,1], and interpretable coefficients — no GPU
needed. Swap in a torch MLP later if the feature set grows.

The trained model is a drop-in for RiskFuser.combine: it takes the same sub-score
dict and returns a risk score in [0, 1].
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

# canonical sub-score order so vectors are stable across train/infer
FEATURE_ORDER = ["motion", "density", "clustering", "rules"]


def _vectorize(sub_scores: dict[str, float]) -> np.ndarray:
    return np.array([sub_scores.get(k, 0.0) for k in FEATURE_ORDER], dtype=float)


class LearnedFuser:
    """Logistic-regression fuser compatible with RiskFuser's interface."""

    def __init__(self, model=None) -> None:
        self.model = model

    def combine(self, sub_scores: dict[str, float]) -> float:
        x = _vectorize(sub_scores).reshape(1, -1)
        return float(self.model.predict_proba(x)[0, 1])

    # --- persistence -------------------------------------------------------
    def save(self, path: str | Path) -> None:
        import joblib
        joblib.dump({"model": self.model, "features": FEATURE_ORDER}, path)

    @classmethod
    def load(cls, path: str | Path) -> "LearnedFuser":
        import joblib
        return cls(model=joblib.load(path)["model"])

    # --- training ----------------------------------------------------------
    @classmethod
    def fit(cls, sub_score_rows: list[dict[str, float]], labels: list[int]) -> "LearnedFuser":
        from sklearn.linear_model import LogisticRegression

        X = np.vstack([_vectorize(r) for r in sub_score_rows])
        y = np.asarray(labels, dtype=int)
        model = LogisticRegression(max_iter=1000, class_weight="balanced")
        model.fit(X, y)
        return cls(model=model)

    def coefficients(self) -> dict[str, float]:
        return dict(zip(FEATURE_ORDER, self.model.coef_[0].tolist()))
