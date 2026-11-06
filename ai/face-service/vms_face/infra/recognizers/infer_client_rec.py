"""Recognizer backed by the inference service (infra/infer_client.py).

Aligns locally (the same `norm_crop` every other backend uses, so the crop
the service embeds is bit-identical to what a local embed would see), then
ships aligned 112x112 crops. Crops from all cameras in this process coalesce
in one request per batcher window. The vector space is the service's —
`name` is learned from it at connect time so candidate payloads carry the
right recognizer label.
"""
from __future__ import annotations

import asyncio
import threading

import numpy as np

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.infra.aligner import norm_crop
from vms_face.infra.batcher import AsyncBatcher
from vms_face.infra.infer_client import InferClient, InferUnavailable, SyncInferClient

log = get_logger(__name__)


class InferClientRecognizer:
    def __init__(self) -> None:
        self._client = InferClient.shared()
        self._batcher: AsyncBatcher | None = None
        self._batcher_lock = threading.Lock()
        self._local = None
        self._local_lock = threading.Lock()

    @property
    def name(self) -> str:
        n = self._client.info.get("recognizer") if self._client.info else None
        return str(n) if n else "insightface_arc"

    def _local_recognizer(self):
        if self._local is None:
            with self._local_lock:
                if self._local is None:
                    from vms_face.infra.recognizers.batched_arcface import BatchedArcFaceRecognizer
                    log.warning("inference service down too long; loading local recognizer as fallback")
                    self._local = BatchedArcFaceRecognizer(providers=settings.providers_list)
        return self._local

    def _fallback(self) -> bool:
        return self._local is not None or self._client.down_for() >= float(settings.infer_service_fallback_after_sec)

    @staticmethod
    def _align(frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        if landmarks_5 is None:
            return None
        try:
            return norm_crop(frame_bgr, landmarks_5, image_size=112)
        except Exception:  # noqa: BLE001
            return None

    def _ensure_batcher(self) -> AsyncBatcher:
        if self._batcher is None:
            with self._batcher_lock:
                if self._batcher is None:
                    from vms_face.core.executors import get_gpu_pool
                    self._batcher = AsyncBatcher[np.ndarray, "np.ndarray | None"](
                        flush_fn=self._flush,
                        max_size=int(settings.infer_client_embed_max),
                        window_sec=max(0.0, float(settings.infer_client_embed_window_ms) / 1000.0),
                        stage="embed",
                        executor=get_gpu_pool(),
                    )
        return self._batcher

    def _flush(self, crops: list[np.ndarray]) -> list[np.ndarray | None]:
        """Runs on the batcher's executor thread: one round trip per batch on
        the async client (the loop is free while this thread waits)."""
        loop = self._client.loop
        if loop is None or loop.is_closed():
            raise InferUnavailable("client loop not ready")
        return asyncio.run_coroutine_threadsafe(self._client.embed_aligned(crops), loop).result(
            timeout=float(settings.infer_service_timeout_sec) + 1.0
        )

    async def embed_async(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        aligned = self._align(frame_bgr, landmarks_5)
        if aligned is None:
            return None
        try:
            if self._client.loop is None:
                await self._client._ensure()
            return await self._ensure_batcher().submit(aligned)
        except InferUnavailable:
            if self._fallback():
                return await self._local_recognizer().embed_async(frame_bgr, landmarks_5)
            return None

    def embed(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        aligned = self._align(frame_bgr, landmarks_5)
        if aligned is None:
            return None
        return self.embed_aligned(aligned)

    def embed_aligned(self, aligned_bgr: np.ndarray) -> np.ndarray | None:
        try:
            vecs = SyncInferClient.shared().embed_aligned([aligned_bgr])
            return vecs[0] if vecs else None
        except InferUnavailable:
            if self._fallback():
                return self._local_recognizer().embed_aligned(aligned_bgr)
            raise

    def reuse_existing(self, existing: np.ndarray | None) -> np.ndarray | None:
        # The detector never carries an embedding in this shape; always embed.
        return None
