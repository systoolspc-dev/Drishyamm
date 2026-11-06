"""
train_calibrator.py — fit the learned confidence on officer labels.

Every label is a sample of "was this read correct, given its features"
(agreement, OCR confidences, reader agreement, frames, crop size, blur,
scenario flags, template rarity, verifier score, quality …). A logistic
model on those replaces the hand formula and the hand-set thresholds with a
probability. Promoted to models/calibrator.json only if cross-validated AUC
beats the heuristic confidence's AUC on the same labels; the worker
hot-reloads it within a minute.

Weights: every label row carries anpr_labels.weight (human 1.0, auto 0.5).
It is used as a SAMPLE WEIGHT — each row's gradient contribution is scaled
by it (WeightedCalibrator below; calibrator.py's fit is plain numpy). The
promotion gate (CV AUC vs heuristic AUC) is judged on HUMAN rows only: auto
rows were picked by the heuristic confidence itself (≥ 0.9, all 'correct'),
so scoring on them would flatter both sides.

    python train_calibrator.py --backend http://trinetra-backend:5000
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time

import numpy as np
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from calibrator import FEATURES, Calibrator, auc, featurize  # noqa: E402

MIN_N = int(os.getenv("ANPR_CAL_MIN_N", "30"))
MIN_EACH = int(os.getenv("ANPR_CAL_MIN_EACH", "8"))


class WeightedCalibrator(Calibrator):
    """Calibrator.fit with per-sample weights (same model, same regulariser,
    same class balancing — the sample weight multiplies each row's gradient)."""

    def fit(
        self,
        X: np.ndarray,
        y: np.ndarray,
        sw: np.ndarray | None = None,  # type: ignore[override]
        l2: float = 1.0,
        iters: int = 600,
        lr: float = 0.2,
    ) -> "WeightedCalibrator":
        X = np.asarray(X, np.float64)
        y = np.asarray(y, np.float64)
        w_s = np.ones(len(y)) if sw is None else np.asarray(sw, np.float64)
        self.mean = X.mean(0)
        self.std = X.std(0) + 1e-6
        Z = (X - self.mean) / self.std
        n, d = Z.shape
        w = np.zeros(d)
        b = 0.0
        pos = max(1.0, float((w_s * y).sum()))
        neg = max(1.0, float((w_s * (1 - y)).sum()))
        tot = float(w_s.sum())
        cls = np.where(y > 0.5, tot / (2 * pos), tot / (2 * neg))
        g_scale = cls * w_s
        for _ in range(iters):
            p = 1.0 / (1.0 + np.exp(-(Z @ w + b)))
            g = (p - y) * g_scale
            gw = Z.T @ g / n + l2 * w / n
            gb = g.mean()
            w -= lr * gw
            b -= lr * gb
        self.coef, self.intercept = w, b
        return self


def cross_validate_weighted(
    X: np.ndarray, y: np.ndarray, sw: np.ndarray, k: int = 5, seed: int = 7
) -> np.ndarray:
    """Out-of-fold predictions for every row, models fitted with the weights."""
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(y))
    folds = np.array_split(idx, min(k, len(y)))
    preds = np.zeros(len(y))
    for i in range(len(folds)):
        test = folds[i]
        train = np.concatenate([folds[j] for j in range(len(folds)) if j != i])
        m = WeightedCalibrator().fit(X[train], y[train], sw[train])
        preds[test] = [m.predict(X[t]) for t in test]
    return preds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default=os.getenv("ANPR_BACKEND_URL", "http://localhost:5000"))
    ap.add_argument("--email", default=os.getenv("ANPR_EMAIL", "<redacted>"))
    ap.add_argument("--password", default=os.getenv("ANPR_PASSWORD", "<redacted>"))
    ap.add_argument("--out", default=os.path.join(HERE, "models", "calibrator.json"))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    b = a.backend.rstrip("/")
    tok = None
    for i in range(4):
        lr = requests.post(f"{b}/api/auth/login", json={"email": a.email, "password": a.password}, timeout=20)
        if lr.status_code in (409, 429) and i < 3:  # back-to-back logins in the trainer cycle
            time.sleep(2.0 * (i + 1))
            continue
        lr.raise_for_status()
        tok = lr.json()["token"]
        break
    if not tok:
        sys.exit("[calibrator] login failed")
    exp = requests.get(
        f"{b}/api/ai/anpr/labels/export",
        params={"include_auto": 0},
        headers={"Authorization": f"Bearer {tok}"},
        timeout=60,
    ).json()
    X, y, heur, sw, human = [], [], [], [], []
    for it in exp.get("items", []):
        f = it.get("features")
        if not f or it.get("verdict") not in ("correct", "wrong", "not_plate"):
            continue
        src = it.get("source") or "human"
        X.append(featurize(f))
        y.append(1.0 if it["verdict"] == "correct" else 0.0)
        heur.append(float(it.get("confidence") or 0.0))
        sw.append(
            float(it.get("weight") if it.get("weight") is not None else (1.0 if src == "human" else 0.5))
        )
        human.append(src == "human")
    X, y, heur, sw, human = (
        np.array(X),
        np.array(y),
        np.array(heur),
        np.array(sw),
        np.array(human, dtype=bool),
    )
    n, pos = len(y), int(y.sum()) if len(y) else 0
    n_h = int(human.sum()) if n else 0
    pos_h = int(y[human].sum()) if n_h else 0
    print(
        f"[calibrator] {n} labelled reads with features ({pos} correct / {n - pos} wrong); "
        f"{n_h} human (weight 1.0: {pos_h} correct / {n_h - pos_h} wrong) + {n - n_h} auto (weight 0.5, all correct)"
    )
    # the class minimum is on HUMAN rows: auto rows are never 'wrong', so they can't satisfy it
    if n < MIN_N or pos_h < MIN_EACH or n_h - pos_h < MIN_EACH:
        print(f"[calibrator] need ≥{MIN_N} labels with ≥{MIN_EACH} human labels of each class — waiting")
        return 0
    preds = cross_validate_weighted(X, y, sw)
    # judged on the officers' rows only (auto rows were chosen by the heuristic itself)
    cv_auc = auc(y[human], preds[human])
    cv_acc = float(((preds[human] >= 0.5) == (y[human] >= 0.5)).mean())
    h_auc = auc(y[human], heur[human])
    print(
        f"[calibrator] cross-validated AUC {cv_auc:.3f} (acc {cv_acc:.3f}) vs heuristic confidence AUC {h_auc:.3f}  [on {n_h} human labels]"
    )
    if not a.force and not (cv_auc == cv_auc and cv_auc > max(0.6, h_auc)):
        print(
            "[calibrator] NOT promoted — does not beat the heuristic yet; label more (especially wrong reads)"
        )
        return 0
    m = WeightedCalibrator().fit(X, y, sw)
    m.meta = {
        "n": n,
        "pos": pos,
        "n_human": n_h,
        "n_auto": n - n_h,
        "weighted_n": round(float(sw.sum()), 1),
        "cv_auc": round(cv_auc, 3),
        "cv_acc": round(cv_acc, 3),
        "judged_on": "human",
        "heuristic_auc": round(float(h_auc), 3) if h_auc == h_auc else None,
        "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    m.save(a.out)
    top = sorted(zip(FEATURES, np.round(m.coef, 2)), key=lambda kv: -abs(kv[1]))[:6]
    print(f"[calibrator] PROMOTED → {a.out}; strongest signals: {top}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
