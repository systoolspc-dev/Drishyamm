"""Per-camera homography for pixel -> ground-plane (meter) mapping (Phase 2).

Essential for turning head counts into people/m² and for making density
thresholds comparable across cameras. The cross-scene AUC-collapse finding
(0.704 -> 0.499) is exactly why per-camera calibration is mandatory, not optional.
"""
from __future__ import annotations

import numpy as np


class Homography:
    """3x3 homography mapping image pixels to ground-plane meters."""

    def __init__(self, matrix: np.ndarray | None = None) -> None:
        self.matrix = np.asarray(matrix, dtype=float) if matrix is not None else None

    @classmethod
    def from_points(cls, image_pts: np.ndarray, world_pts: np.ndarray) -> "Homography":
        """Fit a homography from >=4 pixel<->meter correspondences."""
        import cv2

        H, _ = cv2.findHomography(np.asarray(image_pts), np.asarray(world_pts))
        return cls(H)

    def pixels_to_meters(self, pts: np.ndarray) -> np.ndarray:
        """Map Nx2 pixel coords to Nx2 ground-plane meter coords."""
        if self.matrix is None:
            raise ValueError("Homography not calibrated")
        pts = np.asarray(pts, dtype=float)
        hom = np.hstack([pts, np.ones((len(pts), 1))])
        out = (self.matrix @ hom.T).T
        return out[:, :2] / out[:, 2:3]
