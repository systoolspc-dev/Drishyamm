"""Stateful motion analyzer: consumes frames, emits per-frame motion features.

Holds the previous grayscale frame and previous speed so callers can just push
frames one at a time (works identically for offline video and live RTSP).
"""
from __future__ import annotations

import cv2
import numpy as np

from .optical_flow import farneback_flow
from .features import motion_features


class MotionAnalyzer:
    """Dense-flow motion analysis over a stream of frames."""

    def __init__(self, farneback_params: dict | None = None) -> None:
        self.params = farneback_params or {}
        self._prev_gray: np.ndarray | None = None
        self._prev_speed: float | None = None
        self.last_flow: np.ndarray | None = None  # (H,W,2) flow from the last process()

    @staticmethod
    def _gray(frame: np.ndarray) -> np.ndarray:
        if frame.ndim == 2:
            return frame
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    def reset(self) -> None:
        self._prev_gray = None
        self._prev_speed = None

    def process(self, frame: np.ndarray) -> dict[str, float] | None:
        """Push one frame. Returns motion features, or ``None`` for the very
        first frame (no flow computable yet)."""
        gray = self._gray(frame)
        if self._prev_gray is None:
            self._prev_gray = gray
            return None

        flow = farneback_flow(self._prev_gray, gray, **self.params)
        feats = motion_features(flow, prev_speed=self._prev_speed)

        self.last_flow = flow
        self._prev_gray = gray
        self._prev_speed = feats["speed"]
        return feats
