from __future__ import annotations

import numpy as np

from vms_face.core.logging import get_logger

log = get_logger(__name__)


class InsightFaceArcRecognizer:
    """Default recognizer. Reuses the embedding `FaceAnalysis.get()` already
    computes during detection — no extra forward pass.

    This backend is meaningless without `FaceRuntime(run_recognition=True)`;
    pair them in the factory."""

    embedding_dim = 512
    name = "insightface_arc"

    def embed(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        # The orchestrator should always call reuse_existing first for this
        # backend. If it falls through to embed(), something is misconfigured —
        # we don't keep an independent embedder around to honor the request.
        log.warning(
            "insightface_arc.embed called explicitly; this should not happen on the hot path. "
            "Make sure FaceRuntime is configured with run_recognition=True."
        )
        return None

    async def embed_async(
        self, frame_bgr: np.ndarray, landmarks_5: np.ndarray
    ) -> np.ndarray | None:
        # No standalone embedder for this backend; delegate to embed() (which
        # warns + returns None). This keeps the call-site signature uniform.
        return self.embed(frame_bgr, landmarks_5)

    def reuse_existing(self, existing: np.ndarray | None) -> np.ndarray | None:
        return existing
