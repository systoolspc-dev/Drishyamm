from __future__ import annotations

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


class AdaFaceONNXRecognizer:
    """AdaFace recognizer (CVPR 2022). Operates on 112x112 RGB faces aligned
    via the standard ArcFace 5-point template. Output is 512-D L2-normed.

    Why AdaFace over ArcFace for surveillance:
      - Loss adaptively down-weights low-quality samples during training,
        making it the strongest open-source recognizer on TinyFace
        (Rank-1 = 72.29% on R100 / WebFace12M).
      - Pretrained checkpoints ship for IR-50, IR-101 (R100); we recommend
        the ir101_webface12m ONNX export.

    Setup:
      1. Get the AdaFace PyTorch checkpoint from https://github.com/mk-minchul/AdaFace
         (e.g. `adaface_ir101_webface12m.ckpt`).
      2. Export to ONNX with the official `convert_to_onnx.py` script in that
         repo, or grab a community export.
      3. Place the ONNX file somewhere readable; set `ADAFACE_MODEL_PATH` in
         `.env` to its absolute path.

    Preprocessing convention matches the AdaFace repo's official inference
    example (`mk-minchul/AdaFace/inference.py:to_input`):
        np_img[:,:,::-1]                    # PIL-RGB → BGR
        ((bgr / 255.0) - 0.5) / 0.5         # = bgr/127.5 - 1.0
        transpose(2, 0, 1)                  # CHW
    The model expects **BGR** input. cv2 already gives us BGR, so we do NOT
    convert to RGB. (An earlier revision had this wrong; the bug measurably
    hurt AdaFace recognition accuracy on TinyFace-style probes.)"""

    embedding_dim = 512
    name = "adaface"

    def __init__(self, model_path: str | Path, providers: list[str] | None = None) -> None:
        path = Path(model_path)
        if not path.exists():
            raise InferenceError(
                f"AdaFace model not found at {path}. "
                f"See infra/recognizers/adaface.py docstring for setup instructions."
            )

        # Process-wide session policy (infra/ort_session.py); recognizer FP16
        # stays gated on tensorrt_fp16_recognizer like the ArcFace backend.
        from vms_face.infra.ort_session import make_session

        self._session = make_session(path, requested=providers, kind="recognizer")

        inputs = self._session.get_inputs()
        if not inputs:
            raise InferenceError("AdaFace ONNX has no inputs")
        self._input_name = inputs[0].name

        # Validate input shape; AdaFace expects (1, 3, 112, 112)
        shape = inputs[0].shape
        if len(shape) != 4 or shape[1] != 3:
            log.warning("AdaFace ONNX input shape unusual", shape=shape)

        log.info(
            "adaface loaded",
            path=str(path),
            providers=self._session.get_providers(),
            input_name=self._input_name,
        )

        # Lazy-init batcher: pipeline_batched_inference may flip at runtime
        # (tests, ops toggle), so we create it on first embed_async call. The
        # underlying ORT session is the same one used by the per-image path.
        self._batcher: AsyncBatcher | None = None
        self._batcher_lock = threading.Lock()

    # ── single-image preprocessing (shared by sync + batch paths) ──────────

    @staticmethod
    def _preprocess(aligned_bgr: np.ndarray) -> np.ndarray:
        """Aligned 112x112 BGR uint8 → (3, 112, 112) float32 in [-1, 1]."""
        x = (aligned_bgr.astype(np.float32) / 127.5) - 1.0
        return np.transpose(x, (2, 0, 1))

    @staticmethod
    def _l2_norm(emb: np.ndarray) -> np.ndarray | None:
        n = float(np.linalg.norm(emb))
        if n <= 0:
            return None
        return (emb / n).astype(np.float32)

    def _align(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        try:
            return norm_crop(frame_bgr, landmarks_5, image_size=112)
        except Exception as e:
            log.warning("adaface alignment failed", err=str(e))
            return None

    # ── synchronous single-image path (existing behavior) ──────────────────

    def embed(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        if landmarks_5 is None:
            return None
        aligned = self._align(frame_bgr, landmarks_5)
        if aligned is None:
            return None
        return self.embed_aligned(aligned)

    def embed_aligned(self, aligned_bgr: np.ndarray) -> np.ndarray | None:
        """Embed an already-aligned 112x112 BGR crop (edge → /edge/embed)."""
        # AdaFace expects BGR (see class docstring). cv2 already gives us BGR,
        # so we use it as-is — no channel reorder.
        x = self._preprocess(aligned_bgr)[None, ...]   # (1, 3, 112, 112)
        try:
            out = self._session.run(None, {self._input_name: x})
        except Exception as e:
            log.warning("adaface inference failed", err=str(e))
            return None
        emb = np.asarray(out[0]).astype(np.float32).reshape(-1)
        if emb.size != self.embedding_dim:
            log.warning("adaface unexpected embedding dim", got=emb.size, expected=self.embedding_dim)
            return None
        return self._l2_norm(emb)

    def embed_aligned_batch(self, aligned_crops: list[np.ndarray]) -> list[np.ndarray | None]:
        return self._run_batch(list(aligned_crops))

    # ── batched async path (PR #14) ─────────────────────────────────────────

    def _ensure_batcher(self) -> AsyncBatcher:
        """First-touch lazy init; safe under concurrent submitters."""
        if self._batcher is not None:
            return self._batcher
        with self._batcher_lock:
            if self._batcher is None:
                self._batcher = AsyncBatcher[np.ndarray, "np.ndarray | None"](
                    flush_fn=self._run_batch,
                    max_size=int(settings.batch_embed_max),
                    window_sec=max(0.0, float(settings.batch_embed_window_ms) / 1000.0),
                    stage="embed",
                )
            return self._batcher

    def _run_batch(self, aligned_crops: list[np.ndarray]) -> list[np.ndarray | None]:
        """Stack pre-aligned (112,112,3) BGR crops into one ONNX call. Returns
        a parallel list of L2-normed embeddings or None on per-row failure."""
        if not aligned_crops:
            return []
        batch = np.stack([self._preprocess(c) for c in aligned_crops], axis=0)
        try:
            out = self._session.run(None, {self._input_name: batch})
        except Exception as e:
            log.warning("adaface batched inference failed", err=str(e), batch=len(aligned_crops))
            return [None] * len(aligned_crops)
        embeddings = np.asarray(out[0]).astype(np.float32)
        if embeddings.ndim != 2 or embeddings.shape[0] != len(aligned_crops) or embeddings.shape[1] != self.embedding_dim:
            log.warning(
                "adaface batched output shape unexpected",
                shape=embeddings.shape,
                batch=len(aligned_crops),
            )
            return [None] * len(aligned_crops)
        return [self._l2_norm(row) for row in embeddings]

    async def embed_async(
        self,
        frame_bgr: np.ndarray,
        landmarks_5: np.ndarray,
    ) -> np.ndarray | None:
        """Coalescing async embedding. When pipeline_batched_inference is on,
        in-flight requests across cameras share one ONNX call; otherwise we
        fall through to the synchronous embed() in a thread."""
        if landmarks_5 is None:
            return None
        if not settings.pipeline_batched_inference:
            # Off-feature-flag: just call the sync path. Caller's run_in_executor
            # wrapper covers the threading.
            return self.embed(frame_bgr, landmarks_5)
        aligned = self._align(frame_bgr, landmarks_5)
        if aligned is None:
            return None
        batcher = self._ensure_batcher()
        return await batcher.submit(aligned)

    def reuse_existing(self, existing: np.ndarray | None) -> np.ndarray | None:
        # AdaFace embeddings are NOT interchangeable with ArcFace's, even
        # though both are 512-D. Always re-embed.
        return None
