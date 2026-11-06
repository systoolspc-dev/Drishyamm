"""Score a trained model on any prepared windows.npz (window-level metrics).

Used mainly to measure honest IN-THE-WILD performance on OOPS (of-itw): prepare
that set separately, then

    python -m src.model.eval_npz --data data_prepared_itw/windows.npz \
        --model models/fall_cnn_omnifall.pt

Prints sensitivity (recall of falls — the key number), specificity, precision,
F1 at a sweep of thresholds so you can see the trade-off, and highlights the
operating point closest to the deployed FALL_PROB_THRESHOLD.
"""
from __future__ import annotations
import argparse
from pathlib import Path

import numpy as np
import torch

import config
from src.model.model import build_model
from src.model.train import _device, _metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="windows.npz to score")
    ap.add_argument("--model", type=Path, default=config.FALL_CLASSIFIER_PATH)
    ap.add_argument("--batch", type=int, default=512)
    args = ap.parse_args()

    d = np.load(args.data, allow_pickle=True)
    X, y = d["X"].astype(np.float32), d["y"].astype(np.float32)
    print(f"loaded {args.data.name}: X={X.shape} "
          f"(falls={int(y.sum())}, normal={int((y == 0).sum())})")

    device = _device()
    ckpt = torch.load(args.model, map_location=device)
    model = build_model(ckpt["n_features"]).to(device)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    probs = np.empty(len(X), dtype=np.float32)
    with torch.no_grad():
        for i in range(0, len(X), args.batch):
            xb = torch.from_numpy(X[i:i + args.batch]).to(device)
            probs[i:i + args.batch] = torch.sigmoid(model(xb)).cpu().numpy().ravel()

    print(f"\nmodel: {args.model.name}   (deployed threshold = "
          f"{config.FALL_PROB_THRESHOLD})")
    print(f"{'thr':>5} {'sens':>6} {'spec':>6} {'prec':>6} {'f1':>6}")
    for thr in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]:
        m = _metrics(y, probs, thr)
        star = "  <- deployed" if abs(thr - config.FALL_PROB_THRESHOLD) < 1e-6 else ""
        print(f"{thr:5.1f} {m['sensitivity']:6.3f} {m['specificity']:6.3f} "
              f"{m['precision']:6.3f} {m['f1']:6.3f}{star}")


if __name__ == "__main__":
    main()
