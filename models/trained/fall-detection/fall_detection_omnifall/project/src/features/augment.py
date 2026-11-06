"""Feature-space data augmentation for training the fall classifier.

Operates directly on the 39-dim per-frame feature vectors (see normalize.py),
so you can retrain a more robust model from the existing windows.npz WITHOUT
re-running pose extraction. Augmentations target the real failure modes we saw:

  * horizontal flip  -> left/right-fall symmetry, doubles effective data
  * keypoint dropout -> occlusion / partial visibility (the s2_06-style misses)
  * coordinate noise -> pose-estimator jitter

Feature layout (must match normalize.extract_features):
  [0:34]  17 keypoints x (x, y):  x_i = [2i], y_i = [2i+1]  (hip-centered, scaled)
  [34]    sin(trunk_angle)   [35] cos(trunk_angle)
  [36]    aspect ratio       [37] vertical pos   [38] mean confidence
"""
from __future__ import annotations
import numpy as np

# COCO-17 left/right pairs to swap on a horizontal mirror (nose has no pair).
_LR_PAIRS = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16)]


def _flip(w: np.ndarray) -> np.ndarray:
    """Mirror left-right. trunk-angle sin/cos are mirror-invariant (the angle is
    computed from |dx|,|dy|), so only the coordinates change."""
    out = w.copy()
    coords = out[:, :34].reshape(len(out), 17, 2)
    coords[:, :, 0] *= -1.0                       # negate x about the hip center
    for a, b in _LR_PAIRS:                         # swap left/right keypoints
        coords[:, [a, b], :] = coords[:, [b, a], :]
    out[:, :34] = coords.reshape(len(out), 34)
    return out


def augment_window(w: np.ndarray, rng: np.random.Generator,
                   p_flip: float = 0.5, p_drop: float = 0.1,
                   noise_std: float = 0.01) -> np.ndarray:
    """Return an augmented copy of a (T, 39) window."""
    w = w.astype(np.float32).copy()
    if rng.random() < p_flip:
        w = _flip(w)
    # occlusion: drop a keypoint for the WHOLE window (persistent, like a real
    # body part being off-screen or behind furniture)
    for i in range(17):
        if rng.random() < p_drop:
            w[:, 2 * i:2 * i + 2] = 0.0
    # jitter only the coordinate block, not the engineered scalars
    w[:, :34] += rng.normal(0, noise_std, size=(w.shape[0], 34)).astype(np.float32)
    return w
