from __future__ import annotations

from typing import Protocol

import numpy as np


class Recognizer(Protocol):
    """Pluggable face-recognition backend.

    All recognizers in this codebase produce 512-D L2-normed embeddings so they
    can share the same Qdrant collection schema. If you add a backend that
    outputs a different dimensionality, give it a separate Qdrant collection.

    Three-method protocol:
      - `reuse_existing` lets the orchestrator reuse the embedding the detector
        already produced for free (when detector and recognizer are the same
        backend, e.g. buffalo_l). Saves a forward pass per face.
      - `embed` is the explicit alignment + forward pass — used when the
        recognizer is decoupled from the detector (e.g. AdaFace + SCRFD).
      - `embed_async` is an optional batched path. Backends that can stack
        aligned crops into one ONNX call (AdaFace) override this to coalesce
        in-flight requests across cameras; backends that can't (the InsightFace
        ArcFace head, which is not standalone) just delegate to embed().
    """

    embedding_dim: int
    name: str

    def embed(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        """Align the face using 5-point landmarks and return its L2-normed embedding.
        Returns None on failure (bad alignment, model error)."""
        ...

    def reuse_existing(self, existing: np.ndarray | None) -> np.ndarray | None:
        """If `existing` was produced by a compatible model, return it; else
        return None to signal that the orchestrator must re-embed via `embed()`."""
        ...

    async def embed_async(
        self, frame_bgr: np.ndarray, landmarks_5: np.ndarray
    ) -> np.ndarray | None:
        """Async embed that may coalesce with concurrent submitters. Default
        implementations should fall back to embed() under the hood when the
        feature flag is off, so call sites can use this unconditionally."""
        ...
