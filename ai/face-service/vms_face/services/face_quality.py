from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from vms_face.config import settings
from vms_face.core.metrics import QUALITY_REJECTS
from vms_face.domain.enums import QualityReject
from vms_face.infra.insightface_runtime import FaceObservation


@dataclass(slots=True)
class QualityVerdict:
    passed: bool
    score: float            # composite 0..1, higher = better
    rejected_for: QualityReject | None = None
    blur_var: float | None = None
    brightness: float | None = None


class FaceQualityGate:
    """Multi-criterion gate. Cheap to compute; runs before the embedding step
    in the pipeline so we don't waste GPU cycles on bad crops.

    Inputs come from FaceObservation (geometry, det_score, pose) and the raw
    frame for blur/brightness measurement on the cropped face region."""

    def __init__(
        self,
        *,
        min_face_px: int | None = None,
        min_det_score: float | None = None,
        max_blur_var: float | None = None,
        max_yaw_deg: float | None = None,
        max_pitch_deg: float | None = None,
        min_brightness: float | None = None,
        max_brightness: float | None = None,
    ) -> None:
        self.min_face_px = min_face_px or settings.quality_min_face_px
        self.min_det_score = min_det_score or settings.quality_min_det_score
        self.max_blur_var = max_blur_var if max_blur_var is not None else settings.quality_max_blur_var
        self.max_yaw_deg = max_yaw_deg or settings.quality_max_yaw_deg
        self.max_pitch_deg = max_pitch_deg or settings.quality_max_pitch_deg
        self.min_brightness = min_brightness if min_brightness is not None else settings.quality_min_brightness
        self.max_brightness = max_brightness if max_brightness is not None else settings.quality_max_brightness

    def evaluate(self, frame_bgr: np.ndarray, obs: FaceObservation) -> QualityVerdict:
        # 1. size
        face_px = min(obs.width, obs.height)
        if face_px < self.min_face_px:
            QUALITY_REJECTS.labels(reason=QualityReject.TOO_SMALL.value).inc()
            return QualityVerdict(False, 0.0, QualityReject.TOO_SMALL)

        # 2. detector confidence
        if obs.det_score < self.min_det_score:
            QUALITY_REJECTS.labels(reason=QualityReject.LOW_DET_SCORE.value).inc()
            return QualityVerdict(False, 0.0, QualityReject.LOW_DET_SCORE)

        # 3. pose
        if obs.yaw_deg is not None and abs(obs.yaw_deg) > self.max_yaw_deg:
            QUALITY_REJECTS.labels(reason=QualityReject.EXTREME_POSE.value).inc()
            return QualityVerdict(False, 0.0, QualityReject.EXTREME_POSE)
        if obs.pitch_deg is not None and abs(obs.pitch_deg) > self.max_pitch_deg:
            QUALITY_REJECTS.labels(reason=QualityReject.EXTREME_POSE.value).inc()
            return QualityVerdict(False, 0.0, QualityReject.EXTREME_POSE)

        # 4. blur + brightness on the crop. Skip the expensive Laplacian when
        #    blur enforcement is disabled — at 100 faces × 30 fps that saves
        #    3000 ops/sec on the calling thread.
        crop = _safe_crop(frame_bgr, obs.bbox)
        if crop.size == 0:
            QUALITY_REJECTS.labels(reason=QualityReject.TOO_SMALL.value).inc()
            return QualityVerdict(False, 0.0, QualityReject.TOO_SMALL)

        # Downsample large crops to a fixed 64x64 before the Laplacian /
        # brightness aggregates. Both metrics are robust to this — Laplacian
        # variance differs by a near-constant factor, and the mean is
        # invariant to area. Cuts CPU for these ops by ~10x on big faces.
        ch, cw = crop.shape[:2]
        if ch > 96 or cw > 96:
            qcrop = cv2.resize(crop, (64, 64), interpolation=cv2.INTER_AREA)
        else:
            qcrop = crop
        gray = cv2.cvtColor(qcrop, cv2.COLOR_BGR2GRAY)
        blur_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if self.max_blur_var > 0 and blur_var < self.max_blur_var:
            QUALITY_REJECTS.labels(reason=QualityReject.BLURRY.value).inc()
            return QualityVerdict(False, 0.0, QualityReject.BLURRY, blur_var, None)

        brightness = float(gray.mean())
        if brightness < self.min_brightness or brightness > self.max_brightness:
            QUALITY_REJECTS.labels(reason=QualityReject.LOW_BRIGHTNESS.value).inc()
            return QualityVerdict(False, 0.0, QualityReject.LOW_BRIGHTNESS, blur_var, brightness)

        # composite score: weighted blend of det_score, size, blur, brightness centeredness
        size_score = min(1.0, face_px / max(160.0, self.min_face_px * 2))
        blur_score = min(1.0, blur_var / 200.0)
        bright_score = 1.0 - abs(brightness - 128.0) / 128.0
        composite = (
            0.45 * obs.det_score
            + 0.25 * size_score
            + 0.20 * blur_score
            + 0.10 * bright_score
        )
        return QualityVerdict(True, float(composite), None, blur_var, brightness)


def _safe_crop(frame: np.ndarray, bbox: np.ndarray) -> np.ndarray:
    h, w = frame.shape[:2]
    x1 = max(0, int(bbox[0]))
    y1 = max(0, int(bbox[1]))
    x2 = min(w, int(bbox[2]))
    y2 = min(h, int(bbox[3]))
    if x2 <= x1 or y2 <= y1:
        return np.zeros((0, 0, 3), dtype=frame.dtype)
    return frame[y1:y2, x1:x2]
