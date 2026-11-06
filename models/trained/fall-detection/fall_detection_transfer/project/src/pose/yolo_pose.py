"""YOLO-pose backend: multi-person keypoints + built-in tracking.

Uses Ultralytics YOLOv8/v11-pose with ByteTrack. `model.track(...persist=True)`
keeps identities stable across consecutive frames of one stream, which is what
lets us maintain a separate keypoint history per person for the fall classifier.
"""
from __future__ import annotations
import numpy as np

import config
from .base import PoseEstimator, TrackedPose


def _resolve_device(requested):
    """Honor the configured device, but fall back gracefully off a CUDA box
    (e.g. a dev Mac) so the same code runs locally and on the GPU server."""
    import torch
    if requested in ("cpu",):
        return "cpu"
    if torch.cuda.is_available():
        return requested                      # 0 / "0" / "cuda" on the server
    if torch.backends.mps.is_available():
        return "mps"                          # Apple Silicon dev machine
    return "cpu"


class YoloPoseEstimator(PoseEstimator):
    def __init__(
        self,
        weights: str = config.YOLO_POSE_WEIGHTS,
        tracker: str = config.YOLO_TRACKER,
        conf: float = config.YOLO_CONF,
        device=config.YOLO_DEVICE,
    ):
        from ultralytics import YOLO  # imported lazily so `import config` stays cheap

        self.model = YOLO(weights)
        self.tracker = tracker
        self.conf = conf
        self.device = _resolve_device(device)

    def track(self, frame_bgr: np.ndarray) -> list[TrackedPose]:
        h, w = frame_bgr.shape[:2]
        # persist=True -> tracker keeps state between calls on the same stream.
        results = self.model.track(
            frame_bgr,
            persist=True,
            tracker=self.tracker,
            conf=self.conf,
            device=self.device,
            verbose=False,
        )
        out: list[TrackedPose] = []
        if not results:
            return out
        r = results[0]
        if r.keypoints is None or r.boxes is None or len(r.boxes) == 0:
            return out

        kxy = r.keypoints.xy.cpu().numpy()          # (N, 17, 2) pixel coords
        kconf = (
            r.keypoints.conf.cpu().numpy()          # (N, 17)
            if r.keypoints.conf is not None
            else np.ones(kxy.shape[:2], dtype=np.float32)
        )
        boxes = r.boxes.xyxy.cpu().numpy()          # (N, 4) pixel
        det_conf = r.boxes.conf.cpu().numpy()       # (N,)
        ids = (
            r.boxes.id.cpu().numpy().astype(int)    # (N,)
            if r.boxes.id is not None
            else np.full(len(boxes), -1, dtype=int)
        )

        for i in range(len(boxes)):
            # Build (17, 3) as (y, x, score) with coords normalized to [0, 1].
            kp = np.zeros((config.N_KEYPOINTS, 3), dtype=np.float32)
            kp[:, 0] = kxy[i, :, 1] / max(h, 1)     # y
            kp[:, 1] = kxy[i, :, 0] / max(w, 1)      # x
            kp[:, 2] = kconf[i]
            bbox = boxes[i].astype(np.float32).copy()
            bbox[[0, 2]] /= max(w, 1)
            bbox[[1, 3]] /= max(h, 1)
            out.append(
                TrackedPose(
                    track_id=int(ids[i]),
                    keypoints=kp,
                    bbox=bbox,
                    score=float(det_conf[i]),
                )
            )
        return out

    def reset(self) -> None:
        # Ultralytics resets tracker state when persist=False is next passed,
        # or on a new model.track session. Reinit is the clean way per stream.
        pass
