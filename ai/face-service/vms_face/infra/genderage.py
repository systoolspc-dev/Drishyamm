"""On-demand genderage attribute head.

Two problems with letting FaceAnalysis run the genderage head implicitly:

  1. Cost scales wrong. Inside `FaceAnalysis.get()` the head runs on every
     face on every frame — but a track's gender doesn't change. After a
     handful of good-quality samples the answer is settled and every further
     call is wasted GPU.
  2. The batched SCRFD path (PIPELINE_BATCHED_INFERENCE=true) bypasses
     `FaceAnalysis.get()` entirely, so observations come back with
     gender=None and the feature silently disappears in exactly the
     deployment mode recommended for scale.

This module loads the same `genderage.onnx` that ships inside the
insightface model bundle (it is already on disk — the bundle zip unpacks
all heads regardless of `allowed_modules`) and exposes a single
`estimate(frame, bbox)` call the orchestrator invokes only while a track's
attribute vote still needs samples (see services/track_attributes.py).

Failure posture mirrors infra/person_detector.py: any load or inference
failure logs, latches the estimator off, and returns None — gender degrades
to "unknown", never crashes the pipeline.
"""
from __future__ import annotations

import os.path as osp
from glob import glob
from threading import Lock
from typing import Any

import numpy as np

from vms_face.core.logging import get_logger

log = get_logger(__name__)


def _default_model_path(model_name: str) -> str | None:
    """Locate genderage.onnx inside the already-downloaded insightface
    bundle (~/.insightface/models/<name>/). Returns None if absent."""
    model_dir = osp.join(osp.expanduser("~/.insightface"), "models", model_name)
    hits = sorted(glob(osp.join(model_dir, "*genderage*.onnx")))
    return hits[0] if hits else None


class GenderAgeEstimator:
    """Thin thread-safe wrapper over insightface's Attribute model."""

    def __init__(
        self,
        model_path: str,
        *,
        providers: list[str] | None = None,
        ctx_id: int = 0,
    ) -> None:
        # Deferred imports — this module must stay importable without
        # insightface installed (docs / tooling contexts).
        from insightface import model_zoo
        from insightface.app.common import Face

        self._face_cls = Face
        from vms_face.infra.cuda_gate import cuda_init_gate
        with cuda_init_gate("genderage session"):
            self._model = model_zoo.get_model(model_path, providers=providers)
        if self._model is None or getattr(self._model, "taskname", "") != "genderage":
            raise RuntimeError(
                f"{model_path} did not load as a genderage attribute model "
                f"(taskname={getattr(self._model, 'taskname', None)!r})"
            )
        self._model.prepare(ctx_id=ctx_id)
        self._call_lock = Lock()
        log.info("genderage estimator loaded", path=model_path, ctx_id=ctx_id)

    def estimate(
        self,
        frame_bgr: np.ndarray,
        bbox: np.ndarray,
        kps: np.ndarray | None = None,
    ) -> tuple[int, float] | None:
        """Run genderage on one face region. Returns (gender, age) with the
        insightface convention (gender: 1=male, 0=female), or None on any
        failure. The Attribute model aligns its own crop from the bbox."""
        if frame_bgr is None or frame_bgr.size == 0:
            return None
        face: Any = self._face_cls(bbox=np.asarray(bbox, dtype=np.float32))
        if kps is not None:
            face.kps = np.asarray(kps, dtype=np.float32)
        try:
            with self._call_lock:
                gender, age = self._model.get(frame_bgr, face)
        except Exception as e:
            log.warning("genderage inference failed", err=str(e))
            return None
        return int(gender), float(age)


# ── Module-level singleton + lazy init (same pattern as person_detector) ────

_instance: GenderAgeEstimator | None = None
_unavailable = False
_instance_lock = Lock()


def get_genderage_estimator() -> GenderAgeEstimator | None:
    """Process-wide singleton. Returns None when face attributes are disabled
    or the model can't be found/loaded — callers MUST handle None (gender
    simply stays unknown)."""
    from vms_face.config import settings  # avoid circular import at module load

    global _instance, _unavailable
    if not settings.face_attributes_enabled:
        return None
    if _instance is not None:
        return _instance
    if _unavailable:
        return None
    with _instance_lock:
        if _instance is not None or _unavailable:
            return _instance
        path = _default_model_path(settings.insightface_model)
        if not path:
            log.warning(
                "genderage.onnx not found in the insightface bundle; "
                "face attributes will stay unknown",
                model=settings.insightface_model,
            )
            _unavailable = True
            return None
        try:
            _instance = GenderAgeEstimator(
                path,
                providers=settings.providers_list,
                ctx_id=settings.insightface_ctx_id,
            )
        except Exception as e:
            log.warning("genderage estimator init failed; disabling", err=str(e))
            _unavailable = True
            return None
        return _instance


def reset_genderage_estimator() -> None:
    """Test/reload helper. Forces the next get to rebuild."""
    global _instance, _unavailable
    with _instance_lock:
        _instance = None
        _unavailable = False
