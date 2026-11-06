"""
calibrator.py — a LEARNED confidence: P(read is correct | what we know about it).

The hand formula (agreement × √OCR-conf × evidence) is a guess. Every officer
label is a ground-truth sample of "was this read right, given its features" —
so fit a small logistic regression on those features and use its output as
the confidence the console shows and the gate that decides what is posted.
Signals that are useless as gates on their own (the verifier's 0.06 vs 0.07)
still carry information inside the model. Pure numpy: the worker applies it
at 30 cameras/s without sklearn; the trainer fits it every cycle.

    Calibrator.featurize(meta_features)  → x
    Calibrator.fit(X, y)                 → coefficients (L2-regularised, standardised inputs)
    Calibrator.predict(x)                → probability in (0, 1)
    save(path) / load(path)              → models/calibrator.json (hot-reloaded by the worker)
"""

from __future__ import annotations

import json
import math
import os

import numpy as np

# Feature order is the contract between worker (writes meta.features) and model.
FEATURES = [
    "agreement",
    "mean_conf",
    "min_conf",
    "readers_agree",
    "n_frames",
    "reads",
    "crop_h",
    "crop_w",
    "sharpness",
    "motion_len",
    "has_motion",
    "is_dark",
    "is_glare",
    "inverted",
    "low_contrast",
    "plate_len",
    "template_prior",
    "verify_score",
    "quality",
    "alt_margin",
    "two_row",
    "orphan",
    "det_conf",
]
DEFAULTS = {
    "readers_agree": 0.5,
    "verify_score": 0.0,
    "template_prior": -1.0,
    "alt_margin": 0.0,
    "det_conf": 0.5,
}


def featurize(f: dict | None) -> np.ndarray:
    f = f or {}
    x = []
    for k in FEATURES:
        v = f.get(k, DEFAULTS.get(k, 0.0))
        if v is None:
            v = DEFAULTS.get(k, 0.0)
        x.append(float(bool(v)) if isinstance(v, bool) else float(v))
    x = np.asarray(x, np.float64)
    # tame heavy tails before standardisation
    for i, k in enumerate(FEATURES):
        if k in ("sharpness", "crop_h", "crop_w", "motion_len", "reads", "n_frames"):
            x[i] = math.log1p(max(0.0, x[i]))
    return x


class Calibrator:
    def __init__(self):
        self.coef = np.zeros(len(FEATURES))
        self.intercept = 0.0
        self.mean = np.zeros(len(FEATURES))
        self.std = np.ones(len(FEATURES))
        self.meta: dict = {}

    # ── fit ──
    def fit(
        self, X: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 600, lr: float = 0.2
    ) -> "Calibrator":
        X = np.asarray(X, np.float64)
        y = np.asarray(y, np.float64)
        self.mean = X.mean(0)
        self.std = X.std(0) + 1e-6
        Z = (X - self.mean) / self.std
        n, d = Z.shape
        w = np.zeros(d)
        b = 0.0
        # class balance: weight the rarer class up so a 90 % correct set can't be solved by "always yes"
        pos = max(1.0, y.sum())
        neg = max(1.0, n - y.sum())
        sw = np.where(y > 0.5, n / (2 * pos), n / (2 * neg))
        for _ in range(iters):
            p = 1.0 / (1.0 + np.exp(-(Z @ w + b)))
            g = (p - y) * sw
            gw = Z.T @ g / n + l2 * w / n
            gb = g.mean()
            w -= lr * gw
            b -= lr * gb
        self.coef, self.intercept = w, b
        return self

    # ── apply ──
    def predict(self, x: np.ndarray) -> float:
        z = (np.asarray(x, np.float64) - self.mean) / self.std
        return float(1.0 / (1.0 + math.exp(-float(z @ self.coef + self.intercept))))

    def predict_features(self, f: dict | None) -> float:
        return self.predict(featurize(f))

    # ── io ──
    def save(self, path: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "features": FEATURES,
                    "coef": self.coef.tolist(),
                    "intercept": self.intercept,
                    "mean": self.mean.tolist(),
                    "std": self.std.tolist(),
                    "meta": self.meta,
                },
                fh,
                indent=1,
            )

    @classmethod
    def load(cls, path: str) -> "Calibrator | None":
        try:
            with open(path, encoding="utf-8") as fh:
                d = json.load(fh)
            if d.get("features") != FEATURES:
                return None  # feature contract changed — ignore the stale model
            c = cls()
            c.coef = np.asarray(d["coef"], np.float64)
            c.intercept = float(d["intercept"])
            c.mean = np.asarray(d["mean"], np.float64)
            c.std = np.asarray(d["std"], np.float64)
            c.meta = d.get("meta", {})
            return c
        except Exception:  # noqa: BLE001
            return None


def auc(y: np.ndarray, p: np.ndarray) -> float:
    """Rank AUC (Mann–Whitney)."""
    y = np.asarray(y)
    p = np.asarray(p)
    pos, neg = p[y > 0.5], p[y <= 0.5]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    order = np.argsort(np.concatenate([pos, neg]))
    ranks = np.empty(len(order))
    ranks[order] = np.arange(1, len(order) + 1)
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def cross_validate(X: np.ndarray, y: np.ndarray, k: int = 5, seed: int = 7) -> dict:
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(y))
    folds = np.array_split(idx, min(k, len(y)))
    preds = np.zeros(len(y))
    for i in range(len(folds)):
        test = folds[i]
        train = np.concatenate([folds[j] for j in range(len(folds)) if j != i])
        m = Calibrator().fit(X[train], y[train])
        preds[test] = [m.predict(X[t]) for t in test]
    acc = float(((preds >= 0.5) == (y >= 0.5)).mean())
    return {"cv_auc": auc(y, preds), "cv_acc": acc, "n": int(len(y)), "pos": int(y.sum())}


if __name__ == "__main__":
    # sanity: synthetic data where agreement and quality drive correctness
    rng = np.random.default_rng(0)
    n = 400
    feats = []
    ys = []
    for _ in range(n):
        f = {
            "agreement": rng.uniform(0.5, 1),
            "mean_conf": rng.uniform(0.4, 1),
            "min_conf": rng.uniform(0.2, 1),
            "readers_agree": rng.uniform(0.3, 1),
            "n_frames": rng.integers(3, 8),
            "reads": rng.integers(3, 20),
            "crop_h": rng.uniform(20, 90),
            "crop_w": rng.uniform(50, 300),
            "sharpness": rng.uniform(50, 2000),
            "motion_len": rng.uniform(0, 12),
            "has_motion": rng.random() < 0.3,
            "is_dark": rng.random() < 0.3,
            "is_glare": rng.random() < 0.2,
            "inverted": rng.random() < 0.3,
            "low_contrast": rng.random() < 0.3,
            "plate_len": 10,
            "template_prior": 0.0,
            "verify_score": rng.uniform(-0.1, 0.3),
            "quality": rng.uniform(0.05, 1),
            "alt_margin": rng.uniform(0, 1),
            "two_row": False,
            "orphan": rng.random() < 0.3,
        }
        logit = (
            4 * (f["agreement"] - 0.75)
            + 3 * (f["quality"] - 0.4)
            + 2 * (f["readers_agree"] - 0.6)
            - 1.5 * f["is_dark"]
        )
        ys.append(float(rng.random() < 1 / (1 + math.exp(-logit))))
        feats.append(featurize(f))
    X, y = np.array(feats), np.array(ys)
    print("cv:", cross_validate(X, y))
    m = Calibrator().fit(X, y)
    print("top weights:", sorted(zip(FEATURES, np.round(m.coef, 2)), key=lambda kv: -abs(kv[1]))[:6])
