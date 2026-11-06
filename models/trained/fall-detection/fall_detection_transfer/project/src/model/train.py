"""Stage 4: train the temporal fall classifier.

Splits windows by SOURCE VIDEO (no leakage), handles class imbalance (falls are
rarer), and reports the metrics that matter for a medical alarm — sensitivity
(recall of falls) above all, plus specificity/precision/F1.

Usage:
    python -m src.model.train --data data_prepared/windows.npz --out models/fall_cnn.keras
"""
from __future__ import annotations
import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from sklearn.model_selection import GroupShuffleSplit

import config
from src.model.model import build_model


def _device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def _metrics(y_true, y_prob, thr=0.5):
    y_pred = (y_prob >= thr).astype(int)
    tp = int(((y_pred == 1) & (y_true == 1)).sum())
    tn = int(((y_pred == 0) & (y_true == 0)).sum())
    fp = int(((y_pred == 1) & (y_true == 0)).sum())
    fn = int(((y_pred == 0) & (y_true == 1)).sum())
    eps = 1e-9
    return {
        "sensitivity": tp / (tp + fn + eps),   # recall of falls — most important
        "specificity": tn / (tn + fp + eps),
        "precision": tp / (tp + fp + eps),
        "f1": 2 * tp / (2 * tp + fp + fn + eps),
        "accuracy": (tp + tn) / (tp + tn + fp + fn + eps),
        "tp": tp, "tn": tn, "fp": fp, "fn": fn,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=Path("data_prepared/windows.npz"))
    ap.add_argument("--out", type=Path, default=config.FALL_CLASSIFIER_PATH)
    ap.add_argument("--epochs", type=int, default=config.EPOCHS)
    args = ap.parse_args()

    torch.manual_seed(config.RANDOM_SEED)
    np.random.seed(config.RANDOM_SEED)

    data = np.load(args.data, allow_pickle=True)
    X, y, groups = data["X"], data["y"], data["groups"]
    print(f"windows: {X.shape}, falls={int(y.sum())}, normal={int((y==0).sum())}")

    # split by video so no clip appears in both train and val
    gss = GroupShuffleSplit(n_splits=1, test_size=config.VAL_SPLIT,
                            random_state=config.RANDOM_SEED)
    tr, va = next(gss.split(X, y, groups))
    dev = _device()
    print(f"device: {dev}  train={len(tr)}  val={len(va)}")

    Xtr = torch.tensor(X[tr]); ytr = torch.tensor(y[tr])
    Xva = torch.tensor(X[va]); yva = torch.tensor(y[va])

    model = build_model(X.shape[2]).to(dev)

    # class imbalance -> weight the positive (fall) class
    n_pos, n_neg = float(ytr.sum()), float((ytr == 0).sum())
    pos_weight = torch.tensor([n_neg / max(n_pos, 1.0)], device=dev)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    opt = torch.optim.Adam(model.parameters(), lr=config.LEARNING_RATE)

    ds = torch.utils.data.TensorDataset(Xtr, ytr)
    dl = torch.utils.data.DataLoader(ds, batch_size=config.BATCH_SIZE, shuffle=True)

    best_sens = -1.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        for xb, yb in dl:
            xb, yb = xb.to(dev), yb.to(dev)
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            opt.step()

        model.eval()
        with torch.no_grad():
            prob = torch.sigmoid(model(Xva.to(dev))).cpu().numpy()
        m = _metrics(yva.numpy(), prob)
        print(f"epoch {epoch:3d}  loss {loss.item():.3f}  "
              f"sens {m['sensitivity']:.3f}  spec {m['specificity']:.3f}  "
              f"prec {m['precision']:.3f}  f1 {m['f1']:.3f}")

        # keep the model with best sensitivity that still has usable precision
        if m["sensitivity"] >= best_sens and m["precision"] > 0.3:
            best_sens = m["sensitivity"]
            args.out.parent.mkdir(parents=True, exist_ok=True)
            torch.save({"state_dict": model.state_dict(),
                        "n_features": X.shape[2]}, args.out)

    print(f"\nBest val sensitivity: {best_sens:.3f}  ->  saved {args.out}")


if __name__ == "__main__":
    main()
