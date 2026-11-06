from __future__ import annotations

import os
import threading
from pathlib import Path

import numpy as np
import onnxruntime as ort

from vms_face.config import settings
from vms_face.core.exceptions import InferenceError
from vms_face.core.logging import get_logger
from vms_face.infra.aligner import norm_crop
from vms_face.infra.batcher import AsyncBatcher

log = get_logger(__name__)


class BatchedArcFaceRecognizer:
    """Standalone, batched ArcFace — the same weights and the same vectors as
    the default `insightface_arc` backend, but decoupled from detection.

    **Why this exists.** `InsightFaceArcRecognizer` does not embed anything; it
    returns the vector `FaceAnalysis.get()` already computed during detection.
    InsightFace computes that for *every detected face, on every detect call,
    one face at a time*::

        for i in range(bboxes.shape[0]):          # per face
            for taskname, model in self.models.items():
                model.get(img, face)              # one forward pass, batch of 1

    So every gate the orchestrator applies *after* detection — the quality
    verdict, `embed_every_n_frames`, `pool.would_admit()` — saves zero GPU.
    They all sit behind `reuse_existing()`, handing back a vector that was
    already paid for. The live service proved it: `vms_embed_latency_seconds_count`
    sat at 0 and `vms_embed_skipped_total` never recorded a sample.

    Pairing this backend with `FaceRuntime(run_recognition=False)` makes those
    gates bite and lets in-flight crops across cameras share one ONNX call.
    Measured on an RTX PRO 5000 (2026-09-19), 6 real faces, alignment included::

        per-face  get_feat x6 = 22.82 ms   (3.803 ms/face)   <- the old path
        batched   get_feat(6) =  5.10 ms   (0.850 ms/face)   <- this path

    **The vectors are identical, so the enrolled gallery survives untouched.**
    That is the whole point of building on InsightFace's own ``ArcFaceONNX``
    rather than reimplementing the preprocessing: it keeps
    ``cv2.dnn.blobFromImages``, ``input_mean/input_std = 127.5`` and
    ``swapRB=True`` byte-identical, on byte-identical weights. Measured against
    the old path on 6 enrolled faces, cosine was 1.0 to seven decimals (the
    ~1e-4 absolute spread is float32 GPU kernel non-determinism, not a
    different vector). No re-enrolment, no threshold recalibration.

    `name` therefore stays ``insightface_arc``: the FaceCandidate payload's
    ``recognizer`` field describes the *embedding space*, which has not changed.
    Swapping between this backend and the old one is safe in both directions.

    Selected with ``RECOGNIZER_BACKEND=insightface_batched``. Because that value
    is absent from the run-recognition list in `FaceRuntime.__init__`, choosing
    it also stops the detector loading the recognition head — which is what
    drops model VRAM from one 174 MB copy *per replica* to one shared copy.
    """

    embedding_dim = 512
    # Deliberately the same as InsightFaceArcRecognizer — same weights, same
    # preprocessing, same vectors. See the class docstring.
    name = "insightface_arc"

    def __init__(
        self,
        model_path: str | Path | None = None,
        providers: list[str] | None = None,
    ) -> None:
        path = Path(model_path) if model_path else self._resolve_model_path()
        if not path.exists():
            raise InferenceError(
                f"ArcFace ONNX not found at {path}. Set ARCFACE_MODEL_PATH, or make sure "
                f"INSIGHTFACE_MODEL={settings.insightface_model!r} is present under "
                f"~/.insightface/models/."
            )

        # Thread budget, TensorRT/CUDA/CPU order and the engine cache are
        # decided once for the whole process in infra/ort_session.py. FP16 for
        # this session is gated separately (tensorrt_fp16_recognizer) because
        # its vectors must stay parity-identical to the enrolled gallery.
        from vms_face.infra.ort_session import make_session

        session = make_session(path, requested=providers, kind="recognizer")

        # Build InsightFace's own wrapper around OUR session. Its __init__
        # re-reads the ONNX graph to pick input_mean/input_std (0/1 for mxnet
        # exports, 127.5/127.5 otherwise) — the exact branch the in-detector
        # path takes. Reimplementing that is how embeddings silently drift.
        from insightface.model_zoo.arcface_onnx import ArcFaceONNX

        self._arc = ArcFaceONNX(str(path), session=session)
        self._session = session

        # ORT reports TensorrtExecutionProvider as *available* in images that
        # lack libnvinfer — it then silently falls back to CUDA. Log what the
        # session actually bound to, never what was requested.
        active = session.get_providers()
        log.info(
            "batched arcface loaded",
            path=str(path),
            provider=active[0] if active else "unknown",
            input_mean=self._arc.input_mean,
            input_std=self._arc.input_std,
            input_size=self._arc.input_size,
        )
        if active and active[0] == "CPUExecutionProvider":
            log.warning(
                "batched arcface is running on CPU; expect ~20x the latency. "
                "Check the CUDA execution provider is installed in this image.",
            )

        # Lazy: pipeline_batched_inference can flip at runtime (tests, ops
        # toggle), and a deployment that never enables it should not pay for
        # the batcher's machinery.
        self._batcher: AsyncBatcher | None = None
        self._batcher_lock = threading.Lock()
        # ORT serializes within a session anyway, but `get_feat` mutates no
        # state we share, so the lock only guards the batched flush against
        # concurrent per-image callers fighting over the same session.
        self._run_lock = threading.Lock()

    @staticmethod
    def _resolve_model_path() -> Path:
        """Locate `w600k_r50.onnx` the same way FaceAnalysis locates it, so a
        deployment that already has buffalo_l on disk needs no new config."""
        explicit = (getattr(settings, "arcface_model_path", "") or "").strip()
        if explicit:
            return Path(explicit)

        name = settings.insightface_model
        try:
            from insightface.utils.storage import ensure_available

            model_dir = Path(ensure_available("models", name, root="~/.insightface"))
        except Exception:  # pragma: no cover - offline / API drift
            model_dir = Path(os.path.expanduser("~/.insightface/models")) / name

        # buffalo_l ships the recognition head as w600k_r50.onnx; buffalo_s as
        # w600k_mbf.onnx. Pick whichever recognition ONNX is actually present
        # instead of hard-coding one pack's filename.
        for candidate in ("w600k_r50.onnx", "w600k_mbf.onnx"):
            p = model_dir / candidate
            if p.exists():
                return p
        return model_dir / "w600k_r50.onnx"

    # ── shared helpers ────────────────────────────────────────────────────

    @staticmethod
    def _l2_norm(emb: np.ndarray) -> np.ndarray | None:
        n = float(np.linalg.norm(emb))
        if n <= 0:
            return None
        return (emb / n).astype(np.float32)

    def _align(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        try:
            return norm_crop(frame_bgr, landmarks_5, image_size=self._arc.input_size[0])
        except Exception as e:
            log.warning("arcface alignment failed", err=str(e))
            return None

    # ── synchronous single-image path ─────────────────────────────────────

    def embed(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        if landmarks_5 is None:
            return None
        aligned = self._align(frame_bgr, landmarks_5)
        if aligned is None:
            return None
        return self.embed_aligned(aligned)

    def embed_aligned(self, aligned_bgr: np.ndarray) -> np.ndarray | None:
        """Embed a crop that is ALREADY on the canonical 112x112 template —
        what an edge node sends to /edge/embed after aligning locally."""
        out = self.embed_aligned_batch([aligned_bgr])
        return out[0] if out else None

    def embed_aligned_batch(self, aligned_crops: list[np.ndarray]) -> list[np.ndarray | None]:
        if not aligned_crops:
            return []
        try:
            with self._run_lock:
                out = self._arc.get_feat(list(aligned_crops))
        except Exception as e:
            log.warning("arcface inference failed", err=str(e), batch=len(aligned_crops))
            return [None] * len(aligned_crops)
        embeddings = np.asarray(out, dtype=np.float32).reshape(len(aligned_crops), -1)
        if embeddings.shape[1] != self.embedding_dim:
            log.warning(
                "arcface unexpected embedding dim",
                got=embeddings.shape[1], expected=self.embedding_dim,
            )
            return [None] * len(aligned_crops)
        return [self._l2_norm(row) for row in embeddings]

    # ── batched async path ────────────────────────────────────────────────

    def _ensure_batcher(self) -> AsyncBatcher:
        if self._batcher is not None:
            return self._batcher
        with self._batcher_lock:
            if self._batcher is None:
                from vms_face.core.executors import get_gpu_pool

                self._batcher = AsyncBatcher[np.ndarray, "np.ndarray | None"](
                    flush_fn=self._run_batch,
                    max_size=int(settings.batch_embed_max),
                    window_sec=max(0.0, float(settings.batch_embed_window_ms) / 1000.0),
                    stage="embed",
                    # Dedicated inference pool, not asyncio's 32-thread default.
                    executor=get_gpu_pool(),
                )
            return self._batcher

    def _run_batch(self, aligned_crops: list[np.ndarray]) -> list[np.ndarray | None]:
        """Stack pre-aligned crops into one ONNX call. `get_feat` already takes
        a list and builds the batch blob itself — batching here costs nothing
        in fidelity, which is why the vectors stay identical."""
        if not aligned_crops:
            return []
        try:
            with self._run_lock:
                out = self._arc.get_feat(aligned_crops)
        except Exception as e:
            log.warning(
                "arcface batched inference failed", err=str(e), batch=len(aligned_crops)
            )
            return [None] * len(aligned_crops)
        embeddings = np.asarray(out, dtype=np.float32)
        if (
            embeddings.ndim != 2
            or embeddings.shape[0] != len(aligned_crops)
            or embeddings.shape[1] != self.embedding_dim
        ):
            log.warning(
                "arcface batched output shape unexpected",
                shape=tuple(embeddings.shape),
                batch=len(aligned_crops),
            )
            return [None] * len(aligned_crops)
        return [self._l2_norm(row) for row in embeddings]

    async def embed_async(
        self, frame_bgr: np.ndarray, landmarks_5: np.ndarray
    ) -> np.ndarray | None:
        if landmarks_5 is None:
            return None
        if not settings.pipeline_batched_inference:
            # Off-flag: the caller's run_in_executor wrapper covers threading.
            return self.embed(frame_bgr, landmarks_5)
        aligned = self._align(frame_bgr, landmarks_5)
        if aligned is None:
            return None
        return await self._ensure_batcher().submit(aligned)

    def reuse_existing(self, existing: np.ndarray | None) -> np.ndarray | None:
        """Always None — the whole point is that the detector no longer embeds.

        Returning the detector's vector here would re-arm the exact waste this
        backend exists to remove: the orchestrator would skip `embed()` and the
        quality/pool gates would go back to saving nothing."""
        return None
