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
from src.features.augment import augment_window


class WindowDataset(torch.utils.data.Dataset):
    """Training dataset with optional on-the-fly feature-space augmentation.
    Augmentation is re-sampled every epoch, so the model effectively sees far
    more variation than the raw windows.npz contains."""
    def __init__(self, X, y, augment=False, seed=config.RANDOM_SEED):
        self.X = X.astype(np.float32)
        self.y = y.astype(np.float32)
        self.augment = augment
        self.rng = np.random.default_rng(seed)

    def __len__(self):
        return len(self.X)

    def __getitem__(self, i):
        x = self.X[i]
        if self.augment:
            x = augment_window(x, self.rng)
        return torch.from_numpy(x), torch.tensor(self.y[i])


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
    ap.add_argument("--augment", action="store_true", default=True,
                    help="on-the-fly feature augmentation (flip/dropout/noise)")
    ap.add_argument("--no-augment", dest="augment", action="store_false")
    ap.add_argument("--holdout", default=None,
                    help="comma-separated subject ids to force into validation "
                         "(e.g. 's2,v10'); default = random subject split")
    args = ap.parse_args()

    torch.manual_seed(config.RANDOM_SEED)
    np.random.seed(config.RANDOM_SEED)

    data = np.load(args.data, allow_pickle=True)
    X, y, groups = data["X"], data["y"], data["groups"]
    print(f"windows: {X.shape}, falls={int(y.sum())}, normal={int((y==0).sum())}")

    # split by subject so no person appears in both train and val
    if args.holdout:
        hold = set(s.strip() for s in args.holdout.split(","))
        va = np.where(np.isin(groups, list(hold)))[0]
        tr = np.where(~np.isin(groups, list(hold)))[0]
        print(f"held-out subjects: {sorted(hold)}")
    else:
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

    ds = WindowDataset(X[tr], y[tr], augment=args.augment)
    dl = torch.utils.data.DataLoader(ds, batch_size=config.BATCH_SIZE, shuffle=True)
    print(f"augmentation: {'ON' if args.augment else 'off'}")

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
