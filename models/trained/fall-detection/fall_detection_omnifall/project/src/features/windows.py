"""Sliding-window builder: turn a per-frame feature sequence into fixed-length
temporal windows for the classifier. A fall is motion over ~2s, so the model
always sees a window, never a single frame.
"""
from __future__ import annotations
import numpy as np

import config


def make_windows(
    feats: np.ndarray,
    labels: np.ndarray | None = None,
    size: int = config.WINDOW_SIZE,
    stride: int = config.WINDOW_STRIDE,
):
    """feats: (T, F) per-frame features.
    labels: optional (T,) per-frame 0/1. A window is labeled 1 if ANY frame in
    it is a fall frame (falls are brief; we don't want to dilute them).

    Returns (windows, win_labels) where windows is (N, size, F). If labels is
    None, win_labels is None (inference / unlabeled use).
    """
    T = len(feats)
    if T < size:
        return np.empty((0, size, feats.shape[1]), np.float32), (
            None if labels is None else np.empty((0,), np.float32)
        )

    idx = range(0, T - size + 1, stride)
    windows = np.stack([feats[i : i + size] for i in idx]).astype(np.float32)
    if labels is None:
        return windows, None
    win_labels = np.array(
        [1.0 if labels[i : i + size].max() > 0 else 0.0 for i in idx],
        dtype=np.float32,
    )
    return windows, win_labels
