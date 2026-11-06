"""Pick a pose backend by name. Keeps the rest of the code backend-agnostic."""
from __future__ import annotations

import config
from .base import PoseEstimator


def get_pose_estimator(backend: str = config.POSE_BACKEND, **kwargs) -> PoseEstimator:
    if backend == "yolo":
        from .yolo_pose import YoloPoseEstimator
        return YoloPoseEstimator(**kwargs)
    raise ValueError(
        f"Unknown pose backend '{backend}'. Use 'yolo' (multi-person CCTV)."
    )
