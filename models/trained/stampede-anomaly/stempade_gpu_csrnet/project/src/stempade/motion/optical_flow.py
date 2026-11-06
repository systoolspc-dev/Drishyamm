"""Dense optical flow.

Farneback baseline (as used in the 2024 Eng. Appl. of AI stampede paper).
RAFT is a Phase-1 upgrade path.
"""
from __future__ import annotations

import cv2
import numpy as np


def farneback_flow(prev_gray: np.ndarray, curr_gray: np.ndarray, **params) -> np.ndarray:
    """Compute dense Farneback optical flow between two grayscale frames.

    Returns an ``(H, W, 2)`` array of ``(dx, dy)`` displacement per pixel.
    """
    defaults = dict(
        pyr_scale=0.5, levels=3, winsize=15,
        iterations=3, poly_n=5, poly_sigma=1.2, flags=0,
    )
    defaults.update(params)
    return cv2.calcOpticalFlowFarneback(prev_gray, curr_gray, None, **defaults)
