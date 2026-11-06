"""Batched SCRFD detection.

Pairs with `infra.batcher.AsyncBatcher` to dispatch (B, 3, H, W) tensors at
the SCRFD ONNX level instead of one image per call. The single-image path
through `FaceAnalysis.get(frame)` cannot batch — its preprocessing and post-
processing are baked into the per-image method.

What we do:
  1. Reuse the SCRFD model already loaded into the FaceAnalysis app
     (`app.det_model`). That gives us the warm session, the configured
     input_size, mean/std, anchor center cache, threshold, and FPN strides
     without re-loading or re-tuning anything.
  2. For each frame, letterbox to input_size with a per-frame (scale, dx, dy)
     so we can map detections back to original-image coordinates.
  3. Stack the letterboxed frames into one blob and run the session once.
  4. For each batch index, decode FPN heads (scores, bbox dist, kps dist)
     using the cached anchor centers, apply the score threshold, and run
     per-image NMS. Map back to original coordinates.

Risks and how they're handled:
  - SCRFD post-processing changing across insightface versions: we read the
    attribute names that have been stable in insightface since 0.4 (input_size,
    input_mean, input_std, fmc, _feat_stride_fpn, _num_anchors, use_kps,
    center_cache). If any are missing we raise InferenceError and the caller
    falls back to per-image detection.
  - Detection regression vs the per-image path: at the same det_size we use
    the same letterbox + same decode. Verified against insightface's
    `SCRFD.forward` reference implementation.

This file is loaded only when `pipeline_batched_inference=True` and the
underlying detector is SCRFD. AdaFace embedding (PR #14) uses the same
batcher primitive but a much simpler shape — the alignment work is done
upstream.
"""
from __future__ import annotations

from typing import Any

import cv2
import numpy as np

from vms_face.config import settings
from vms_face.core.exceptions import InferenceError
from vms_face.core.logging import get_logger
from vms_face.infra.insightface_runtime import FaceObservation

log = get_logger(__name__)


# ────────────────────────────────────────────────────────────────────────────
# SCRFD math (from insightface.model_zoo.scrfd, restated for clarity)
# ────────────────────────────────────────────────────────────────────────────


def _distance2bbox(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    """Decode (cx, cy) + (left, top, right, bottom) distances → [x1, y1, x2, y2]."""
    x1 = points[:, 0] - distance[:, 0]
    y1 = points[:, 1] - distance[:, 1]
    x2 = points[:, 0] + distance[:, 2]
    y2 = points[:, 1] + distance[:, 3]
    return np.stack([x1, y1, x2, y2], axis=-1)


def _distance2kps(points: np.ndarray, distance: np.ndarray) -> np.ndarray:
    """Decode 5-point landmark distances. distance: (N, 10) — alternating
    (dx_i, dy_i) for i in [0..4]. Output: (N, 5, 2) absolute coords."""
    n_points = distance.shape[1] // 2
    out = []
    for i in range(n_points):
        dx = points[:, 0] + distance[:, i * 2]
        dy = points[:, 1] + distance[:, i * 2 + 1]
        out.append(np.stack([dx, dy], axis=-1))
    return np.stack(out, axis=1)


def _nms_per_image(boxes_with_scores: np.ndarray, iou_thresh: float) -> list[int]:
    """Greedy NMS. Input rows: [x1, y1, x2, y2, score]. Returns kept indices
    in descending score order."""
    if boxes_with_scores.size == 0:
        return []
    x1 = boxes_with_scores[:, 0]
    y1 = boxes_with_scores[:, 1]
    x2 = boxes_with_scores[:, 2]
    y2 = boxes_with_scores[:, 3]
    scores = boxes_with_scores[:, 4]

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
        inter_w = np.maximum(0.0, xx2 - xx1)
        inter_h = np.maximum(0.0, yy2 - yy1)
        inter = inter_w * inter_h
        iou = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[iou <= iou_thresh]
    return keep


# ────────────────────────────────────────────────────────────────────────────
# Letterbox: pad-and-resize while preserving aspect, record per-frame inverse
# ────────────────────────────────────────────────────────────────────────────


def _letterbox(frame_bgr: np.ndarray, target_w: int, target_h: int) -> tuple[np.ndarray, float, float, float]:
    """Resize `frame_bgr` to fit inside (target_w, target_h) with aspect
    preserved, then top-left-pad with zeros. Returns (resized, scale, dx, dy)
    where dx/dy are pad offsets and `original_xy = (resized_xy - (dx, dy)) / scale`.

    SCRFD's reference implementation uses top-left padding (no centering),
    so detections always sit in the upper-left of the canvas. We match that
    exactly so the anchor-center math is unchanged."""
    h, w = frame_bgr.shape[:2]
    if w == target_w and h == target_h:
        # Already the canvas (a worker pre-letterboxed it for the inference
        # service): nothing to resize, nothing to pad, no copy.
        return frame_bgr, 1.0, 0.0, 0.0
    scale = min(target_w / max(1, w), target_h / max(1, h))
    new_w = int(round(w * scale))
    new_h = int(round(h * scale))
    if new_w != w or new_h != h:
        resized = cv2.resize(frame_bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    else:
        resized = frame_bgr
    canvas = np.zeros((target_h, target_w, 3), dtype=frame_bgr.dtype)
    canvas[:new_h, :new_w] = resized
    return canvas, float(scale), 0.0, 0.0


# ────────────────────────────────────────────────────────────────────────────
# BatchedSCRFD
# ────────────────────────────────────────────────────────────────────────────


class BatchedSCRFD:
    """Pulls SCRFD model state out of an existing FaceAnalysis and exposes
    `detect_batch(frames)` returning a parallel list of FaceObservation lists.

    Throws InferenceError on construction if the detector under FaceAnalysis
    isn't SCRFD or if the attribute names we need have changed in the
    insightface release in use. The caller (FaceRuntime) is expected to fall
    back to per-image detection in that case so a model upgrade can't take
    the whole pipeline down."""

    def __init__(self, face_analysis: Any, *, nms_thresh: float = 0.4) -> None:
        det = getattr(face_analysis, "det_model", None)
        if det is None:
            raise InferenceError("FaceAnalysis has no det_model; cannot batch")

        # The handful of attributes we depend on. Any AttributeError here
        # means the upstream insightface API moved under us.
        try:
            self._session = det.session
            self._input_name = det.input_name
            self._output_names = det.output_names
            self._input_size: tuple[int, int] = tuple(det.input_size)   # (W, H)
            self._input_mean = float(det.input_mean)
            self._input_std = float(det.input_std)
            self._fmc = int(det.fmc)
            self._feat_stride_fpn = list(det._feat_stride_fpn)
            self._num_anchors = int(det._num_anchors)
            self._use_kps = bool(det.use_kps)
        except AttributeError as e:
            raise InferenceError(f"SCRFD attributes missing: {e}") from e

        # The batch dimension must actually be free. The stock buffalo_l
        # `det_10g.onnx` pins it: its input is [1, 3, '?', '?'] — height and
        # width are symbolic but batch is a hard 1. Stacking two frames then
        # fails inside session.run with INVALID_ARGUMENT, and
        # `_run_batched_detect` re-raises everything that isn't a CUDA fault,
        # so the camera's detect loop dies rather than degrading.
        #
        # Detect it here instead, where the contract is "raise InferenceError
        # and the caller falls back to per-image detection" — FaceRuntime
        # latches `_batched_unavailable` and never retries. That makes
        # PIPELINE_BATCHED_INFERENCE safe to enable for the embed path on a
        # model pack whose detector cannot batch.
        #
        # Exporting SCRFD with a dynamic batch axis is what lifts this.
        try:
            batch_dim = self._session.get_inputs()[0].shape[0]
        except Exception:  # pragma: no cover - defensive; shape introspection
            batch_dim = None
        if isinstance(batch_dim, int) and batch_dim == 1:
            raise InferenceError(
                "SCRFD ONNX has a fixed batch dimension of 1 "
                f"(input shape {self._session.get_inputs()[0].shape}); batched detect is "
                "impossible with this export. Falling back to per-image detection. "
                "Re-export the detector with a dynamic batch axis to enable it."
            )

        # Preprocessing in the graph (ort_session.ensure_u8_detector): the
        # session takes the uint8 BGR canvas straight from _letterbox. Falls
        # back to blobFromImage on any trouble, so a model pack without the
        # batched static export still batches the old way.
        self._u8 = False
        model_file = getattr(det, "model_file", None)
        if bool(settings.detector_u8_input) and model_file and "batchN" in str(model_file):
            try:
                from vms_face.infra.ort_session import ensure_u8_detector, make_session
                u8_path = ensure_u8_detector(model_file, mean=self._input_mean, std=self._input_std)
                have = set(self._session.get_providers())
                requested = ["CUDAExecutionProvider", "CPUExecutionProvider"] if have & {"CUDAExecutionProvider", "TensorrtExecutionProvider"} else ["CPUExecutionProvider"]
                sess = make_session(u8_path, requested=requested, kind="detector_u8")
                first = sess.get_inputs()[0]
                if first.type == "tensor(uint8)":
                    self._session = sess
                    self._input_name = first.name
                    self._u8 = True
            except Exception as e:  # noqa: BLE001
                log.warning("uint8 detector unavailable; preprocessing on CPU", err=str(e))

        # det_thresh is set by FaceAnalysis.prepare(); fall back to a
        # reasonable default if the build didn't expose it.
        self._det_thresh = float(getattr(det, "det_thresh", 0.5))
        self._nms_thresh = float(nms_thresh)
        # Cache anchor centers per (height, width, stride) so we don't
        # regenerate them on every call. Shared with insightface's own cache
        # via reference where possible.
        self._anchor_cache: dict[tuple[int, int, int], np.ndarray] = {}
        cache_attr = getattr(det, "center_cache", None)
        if isinstance(cache_attr, dict):
            self._anchor_cache = cache_attr

    @property
    def input_size(self) -> tuple[int, int]:
        return self._input_size

    @property
    def uint8_input(self) -> bool:
        return self._u8

    # ── preprocessing ──────────────────────────────────────────────────────

    def _preprocess(self, frame_bgr: np.ndarray) -> tuple[np.ndarray, float, float, float]:
        """Letterbox + cv2.dnn.blobFromImage normalize for ONE frame.
        Returns ((3, H, W) blob, scale, dx, dy)."""
        target_w, target_h = self._input_size
        canvas, scale, dx, dy = _letterbox(frame_bgr, target_w, target_h)
        if self._u8:
            return canvas, scale, dx, dy   # the graph does the rest on the GPU
        # blobFromImage handles BGR→CHW + (x - mean) / std. We pass swapRB=True
        # so the SCRFD model (which expects RGB inputs at the network level)
        # receives properly ordered channels — insightface's per-image path
        # does the same swap inside its blobFromImage call.
        blob = cv2.dnn.blobFromImage(
            canvas,
            1.0 / self._input_std,
            (target_w, target_h),
            (self._input_mean, self._input_mean, self._input_mean),
            swapRB=True,
        )[0]   # blobFromImage returns (1, 3, H, W); take the [0] slice
        return blob, scale, dx, dy

    def _anchor_centers(self, height: int, width: int, stride: int) -> np.ndarray:
        key = (height, width, stride)
        cached = self._anchor_cache.get(key)
        if cached is not None:
            return cached
        anchor_centers = np.stack(
            np.mgrid[:height, :width][::-1], axis=-1
        ).astype(np.float32)
        anchor_centers = (anchor_centers * stride).reshape((-1, 2))
        if self._num_anchors > 1:
            anchor_centers = np.stack(
                [anchor_centers] * self._num_anchors, axis=1
            ).reshape((-1, 2))
        self._anchor_cache[key] = anchor_centers
        return anchor_centers

    # ── public batched detect ──────────────────────────────────────────────

    def detect_batch(
        self,
        frames: list[np.ndarray],
        *,
        threshold: float | None = None,
    ) -> list[list[FaceObservation]]:
        """Run SCRFD over a batch of BGR frames. Returns one list of
        FaceObservation per input frame, in the same order."""
        if not frames:
            return []
        thr = float(threshold if threshold is not None else self._det_thresh)
        target_w, target_h = self._input_size

        # Preprocess and stack. Per-frame inverse transforms recorded so we
        # can map detections back to native pixel coords.
        blobs: list[np.ndarray] = []
        inverses: list[tuple[float, float, float]] = []
        for f in frames:
            blob, scale, dx, dy = self._preprocess(f)
            blobs.append(blob)
            inverses.append((scale, dx, dy))
        batched = np.stack(blobs, axis=0)   # (B, 3, H, W) float, or (B, H, W, 3) uint8

        try:
            outputs = self._session.run(self._output_names, {self._input_name: batched})
        except Exception as e:
            log.warning("SCRFD batched session.run failed", err=str(e), batch=len(frames))
            raise

        # Outputs come back per FPN level. SCRFD's layout per level:
        #   index 0..fmc-1            : classification scores  (B, A*H*W, 1)
        #   index fmc..2*fmc-1        : bbox regression dists  (B, A*H*W, 4)
        #   index 2*fmc..3*fmc-1      : 5-pt landmark dists    (B, A*H*W, 10)
        # Some exports ship (B, A, H*W, ...) — we reshape defensively.
        per_image: list[list[FaceObservation]] = []
        for b in range(len(frames)):
            scale, dx, dy = inverses[b]
            scores_all: list[np.ndarray] = []
            bboxes_all: list[np.ndarray] = []
            kpss_all: list[np.ndarray] = []
            nb = len(frames)
            for idx, stride in enumerate(self._feat_stride_fpn):
                # The buffalo_l export flattens batch and anchors together:
                # every Reshape is [-1, C], so outputs arrive as (B*A, C)
                # rows, image-major (verified: a batch of two gives 2x16320
                # rows at 960x544 and the first half equals the single run).
                # Reshaping to (B, A, C) first covers that AND an export that
                # already carries the batch axis.
                scores_arr = np.asarray(outputs[idx]).reshape(nb, -1)
                bbox_arr = np.asarray(outputs[idx + self._fmc]).reshape(nb, -1, 4)
                scores = scores_arr[b]
                bbox_preds = bbox_arr[b] * stride
                if self._use_kps:
                    kps_arr = np.asarray(outputs[idx + self._fmc * 2]).reshape(nb, -1, 10)
                    kps_preds = kps_arr[b] * stride
                else:
                    kps_preds = None

                feat_h = target_h // stride
                feat_w = target_w // stride
                anchor_centers = self._anchor_centers(feat_h, feat_w, stride)

                pos = np.where(scores >= thr)[0]
                if pos.size == 0:
                    continue
                pos_scores = scores[pos]
                pos_centers = anchor_centers[pos]
                pos_bboxes = _distance2bbox(pos_centers, bbox_preds[pos])
                scores_all.append(pos_scores.reshape(-1, 1))
                bboxes_all.append(pos_bboxes)
                if kps_preds is not None:
                    pos_kps = _distance2kps(pos_centers, kps_preds[pos])
                    kpss_all.append(pos_kps)

            if not bboxes_all:
                per_image.append([])
                continue
            scores = np.concatenate(scores_all, axis=0)
            bboxes = np.concatenate(bboxes_all, axis=0)
            kpss = np.concatenate(kpss_all, axis=0) if kpss_all else None

            # NMS in input-image coordinates.
            packed = np.concatenate([bboxes, scores], axis=1)
            keep = _nms_per_image(packed, self._nms_thresh)
            if not keep:
                per_image.append([])
                continue

            kept_boxes = bboxes[keep]
            kept_scores = scores[keep]
            kept_kpss = kpss[keep] if kpss is not None else None

            # Map back from letterboxed coords to original-image coords.
            inv = 1.0 / max(scale, 1e-6)
            kept_boxes = (kept_boxes - np.array([dx, dy, dx, dy], dtype=kept_boxes.dtype)) * inv
            if kept_kpss is not None:
                kept_kpss = (kept_kpss - np.array([dx, dy], dtype=kept_kpss.dtype)) * inv

            obs_list: list[FaceObservation] = []
            for i in range(kept_boxes.shape[0]):
                bbox = kept_boxes[i].astype(np.float32)
                landmarks = (
                    kept_kpss[i].astype(np.float32) if kept_kpss is not None else None
                )
                # The batched path doesn't run buffalo_l's auxiliary heads
                # (genderage / pose / embedding) — those run in the per-image
                # FaceAnalysis path. Downstream callers that depend on those
                # fields must use the un-batched runtime; the orchestrator
                # only requires bbox + det_score + landmark_5 and re-embeds
                # via the recognizer anyway.
                obs_list.append(
                    FaceObservation(
                        bbox=bbox,
                        det_score=float(kept_scores[i, 0]),
                        landmark_5=landmarks,
                        embedding=None,
                        yaw_deg=None,
                        pitch_deg=None,
                        age=None,
                        gender=None,
                    )
                )
            per_image.append(obs_list)
        return per_image
