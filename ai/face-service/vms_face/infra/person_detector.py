"""YOLOv8-person detector.

Why this exists: SCRFD finds faces, which makes a great basis for *recognition*
but a poor basis for *occupancy*. A person walking into camera with their back
turned, a person briefly looking away, a person partially occluded by a desk
or another person — none of them register as a face but all of them are
physically present and an operator wants them counted.

This module is an optional second inference stage. When
`pipeline_person_detection_enabled=true` and `pipeline_person_model_path`
points at a YOLOv8 ONNX export, the orchestrator calls `detect(frame)` per
frame (or every N frames) and surfaces the count alongside the face overlay.

Model setup:
  1. Download Ultralytics YOLOv8n:
       pip install ultralytics
       yolo export model=yolov8n.pt format=onnx imgsz=640 simplify=True
     OR grab a pre-exported ONNX from:
       https://github.com/ultralytics/assets/releases (yolov8n.onnx)
  2. Place at `/srv/data/models/yolov8n.onnx` (already a Docker volume).
  3. Set `PIPELINE_PERSON_MODEL_PATH=/srv/data/models/yolov8n.onnx` in env.
  4. Set `PIPELINE_PERSON_DETECTION_ENABLED=true`.

Output: list of (x1, y1, x2, y2, score) tuples for COCO class 0 (person)
in the original frame's pixel coordinates.

Performance: yolov8n at 640×640 runs ~3-5 ms per image on Blackwell.
At 8 fps × 100 cameras = 800 calls/sec ≈ 4 s of GPU time / sec — within
budget when batched, tight otherwise. Use `pipeline_person_detect_every_n_frames`
to cap the rate per camera (default 2 = every other frame at 4 fps effective).
"""
from __future__ import annotations

from pathlib import Path
from threading import Lock
from typing import Iterable

import cv2
import numpy as np
import onnxruntime as ort

from vms_face.core.exceptions import InferenceError
from vms_face.core.logging import get_logger

log = get_logger(__name__)

# COCO class id for "person" in the YOLO/Ultralytics standard ordering.
_COCO_PERSON_CLASS = 0


def _letterbox(img: np.ndarray, target: int) -> tuple[np.ndarray, float, int, int]:
    """Resize image to fit inside (target, target) preserving aspect ratio,
    pad with grey. Returns (canvas, scale, dx, dy). Inverse mapping is:
        original_x = (canvas_x - dx) / scale
        original_y = (canvas_y - dy) / scale
    """
    h, w = img.shape[:2]
    scale = min(target / max(1, w), target / max(1, h))
    new_w, new_h = int(round(w * scale)), int(round(h * scale))
    if new_w != w or new_h != h:
        resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    else:
        resized = img
    canvas = np.full((target, target, 3), 114, dtype=np.uint8)   # YOLO's grey pad value
    dx = (target - new_w) // 2
    dy = (target - new_h) // 2
    canvas[dy:dy + new_h, dx:dx + new_w] = resized
    return canvas, float(scale), int(dx), int(dy)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thresh: float) -> list[int]:
    """Greedy NMS on (N, 4) xyxy boxes. Returns kept indices in score-desc order."""
    if boxes.size == 0:
        return []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]

    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[iou <= iou_thresh]
    return keep


class YOLOPersonDetector:
    """ONNX-Runtime backed YOLOv8 person detector. Thread-safe via a single
    inference lock — ORT sessions are technically thread-safe but the layered
    state we read on either side of session.run isn't, and the GPU is faster
    served sequentially anyway."""

    def __init__(
        self,
        model_path: str | Path,
        *,
        providers: list[str] | None = None,
        det_size: int = 640,
        score_threshold: float = 0.35,
        iou_threshold: float = 0.45,
    ) -> None:
        path = Path(model_path)
        if not path.exists():
            raise InferenceError(
                f"YOLO person model not found at {path}. "
                f"See infra/person_detector.py docstring for setup instructions."
            )

        # Process-wide session policy: thread budget, TensorRT when loadable,
        # engine cache (infra/ort_session.py).
        from vms_face.infra.ort_session import make_session

        self._session = make_session(path, requested=providers, kind="generic")
        inputs = self._session.get_inputs()
        if not inputs:
            raise InferenceError("YOLO ONNX has no inputs")
        self._input_name = inputs[0].name
        self._det_size = int(det_size)
        self._score_threshold = float(score_threshold)
        self._iou_threshold = float(iou_threshold)
        self._call_lock = Lock()

        log.info(
            "yolov8-person loaded",
            path=str(path),
            providers=self._session.get_providers(),
            det_size=self._det_size,
            score_threshold=self._score_threshold,
        )

    def detect(self, frame_bgr: np.ndarray) -> list[tuple[float, float, float, float, float]]:
        """Detect persons in one BGR frame. Returns list of (x1,y1,x2,y2,score)
        in the original frame's pixel coordinates."""
        if frame_bgr is None or frame_bgr.size == 0:
            return []
        canvas, scale, dx, dy = _letterbox(frame_bgr, self._det_size)
        # YOLOv8 expects RGB float32 [0,1] in NCHW. cv2 gives BGR; swap.
        x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        x = np.transpose(x, (2, 0, 1))[None, ...]   # (1, 3, 640, 640)

        with self._call_lock:
            try:
                outputs = self._session.run(None, {self._input_name: x})
            except Exception as e:
                log.warning("yolov8-person inference failed", err=str(e))
                return []

        # YOLOv8 export format: shape (1, num_classes + 4, num_anchors).
        # The standard Ultralytics ONNX export gives (1, 84, 8400) for COCO:
        #   rows 0..3   = cxywh (relative to canvas)
        #   rows 4..83  = class scores
        # We extract person scores and threshold.
        pred = outputs[0]
        if pred.ndim != 3:
            log.warning("yolov8-person unexpected output ndim", shape=pred.shape)
            return []
        pred = pred[0]   # (84, 8400)
        if pred.shape[0] < 5:
            log.warning("yolov8-person output shape unexpected", shape=pred.shape)
            return []

        person_scores = pred[4 + _COCO_PERSON_CLASS]   # (8400,)
        keep_mask = person_scores >= self._score_threshold
        if not np.any(keep_mask):
            return []

        cxcywh = pred[:4, keep_mask].T        # (M, 4)
        scores = person_scores[keep_mask]      # (M,)

        # Decode cxywh → xyxy in canvas coordinates.
        cx, cy, w, h = cxcywh[:, 0], cxcywh[:, 1], cxcywh[:, 2], cxcywh[:, 3]
        x1 = cx - w * 0.5
        y1 = cy - h * 0.5
        x2 = cx + w * 0.5
        y2 = cy + h * 0.5
        boxes_canvas = np.stack([x1, y1, x2, y2], axis=1)

        keep = _nms(boxes_canvas, scores, self._iou_threshold)
        if not keep:
            return []

        kept_boxes = boxes_canvas[keep]
        kept_scores = scores[keep]

        # Map back from canvas to original-frame pixel coordinates.
        inv = 1.0 / max(scale, 1e-6)
        kept_boxes[:, [0, 2]] = (kept_boxes[:, [0, 2]] - dx) * inv
        kept_boxes[:, [1, 3]] = (kept_boxes[:, [1, 3]] - dy) * inv

        # Clip to frame bounds.
        h_img, w_img = frame_bgr.shape[:2]
        kept_boxes[:, [0, 2]] = np.clip(kept_boxes[:, [0, 2]], 0.0, float(w_img))
        kept_boxes[:, [1, 3]] = np.clip(kept_boxes[:, [1, 3]], 0.0, float(h_img))

        return [
            (float(b[0]), float(b[1]), float(b[2]), float(b[3]), float(s))
            for b, s in zip(kept_boxes, kept_scores)
        ]


# ── Module-level singleton + lazy init ────────────────────────────────────

_instance: YOLOPersonDetector | None = None
_instance_lock = Lock()


def get_person_detector():
    """Process-wide singleton. Returns None when the feature is disabled or
    the model file is missing — callers MUST handle the None case so a
    misconfigured deploy degrades gracefully instead of crashing the
    orchestrator at startup."""
    from vms_face.config import settings   # avoid circular import at module load

    global _instance
    if not settings.pipeline_person_detection_enabled:
        return None
    if _instance is not None:
        return _instance
    with _instance_lock:
        if _instance is not None:
            return _instance
        path = (settings.pipeline_person_model_path or "").strip()
        if not path:
            log.warning(
                "person detection enabled but PIPELINE_PERSON_MODEL_PATH is empty; disabling",
            )
            return None
        try:
            _instance = YOLOPersonDetector(
                path,
                providers=settings.providers_list,
                det_size=settings.pipeline_person_det_size,
                score_threshold=settings.pipeline_person_threshold,
            )
        except InferenceError as e:
            log.warning("person detector init failed; disabling", err=str(e))
            return None
        return _instance


def reset_person_detector() -> None:
    """Test/reload helper. Forces the next get_person_detector() to rebuild."""
    global _instance
    with _instance_lock:
        _instance = None
