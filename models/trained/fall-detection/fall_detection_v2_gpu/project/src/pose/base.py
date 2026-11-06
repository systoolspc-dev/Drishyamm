"""Common contract for every pose backend.

For CCTV we need MULTI-PERSON pose WITH stable track IDs (so each person's
keypoint history stays separate across frames). A backend returns a list of
TrackedPose per frame.

CONTRACT for keypoints: numpy array shape (17, 3), columns (y, x, score),
where y and x are normalized to [0, 1] relative to the frame and score is in
[0, 1]. Keypoint order is the fixed COCO-17 order (see config.KP).

Because YOLO-pose and MoveNet both emit COCO-17 keypoints, everything
downstream (normalize -> window -> classifier) is identical for either backend.
"""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np


@dataclass
class TrackedPose:
    track_id: int              # stable id from the tracker (-1 if untracked)
    keypoints: np.ndarray      # (17, 3) -> (y, x, score), normalized coords
    bbox: np.ndarray           # (4,) -> (x1, y1, x2, y2), normalized [0,1]
    score: float               # person detection confidence


class PoseEstimator:
    def track(self, frame_bgr: np.ndarray) -> list[TrackedPose]:
        """Return the tracked people detected in this frame.

        Must be called sequentially on consecutive frames of one stream so the
        underlying tracker can maintain identities.
        """
        raise NotImplementedError

    def reset(self) -> None:
        """Clear tracker state (call when a stream restarts)."""
        pass
