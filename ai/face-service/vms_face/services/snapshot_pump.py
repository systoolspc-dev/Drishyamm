"""Bounded per-camera snapshot uploader.

Replaces the unbounded `asyncio.create_task(_upload_snapshot(...))` in the
orchestrator. Each StreamOrchestrator owns one SnapshotPump:

  - submit(crop_bgr, key) is non-blocking. When the queue is full we drop the
    OLDEST queued item (because freshness > completeness for live evidence)
    and increment SNAPSHOT_QUEUE_DROPPED.
  - N background workers consume the queue and call into ObjectStore via the
    shared io_pool. Failures are logged, not retried — live snapshots that
    miss MinIO are still represented by their FaceCandidate row.
  - aclose() cancels workers and drains pending items so shutdown is clean.

The crop is JPEG-encoded inline before submit() so the queue holds bytes,
not BGR ndarrays. This keeps memory bounded at:
  bytes_per_jpeg(~30-80 KB) * snapshot_pump_queue_size
"""
from __future__ import annotations

import asyncio
import time
from contextlib import suppress
from dataclasses import dataclass

import cv2
import numpy as np

from vms_face.config import settings
from vms_face.core.executors import get_io_pool
from vms_face.core.logging import get_logger
from vms_face.core.metrics import (
    SNAPSHOT_QUEUE_DEPTH,
    SNAPSHOT_QUEUE_DROPPED,
    SNAPSHOT_QUEUE_INFLIGHT,
    SNAPSHOT_UPLOAD_LATENCY,
)
from vms_face.infra.minio_store import ObjectStore

log = get_logger(__name__)


@dataclass(slots=True)
class _PendingUpload:
    bucket: str
    key: str
    data: bytes


def _encode_jpeg(crop_bgr: np.ndarray, quality: int | None = None) -> bytes | None:
    """JPEG-encode a face crop. Quality default comes from settings — operators
    can tune `SNAPSHOT_JPEG_QUALITY` for the file-size / fidelity trade-off."""
    if crop_bgr is None or crop_bgr.size == 0:
        return None
    q = int(quality if quality is not None else settings.snapshot_jpeg_quality)
    q = max(40, min(100, q))   # clamp; below 40 the artifacts are visible
    ok, buf = cv2.imencode(".jpg", crop_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), q])
    if not ok:
        return None
    return buf.tobytes()


class SnapshotPump:
    def __init__(
        self,
        objects: ObjectStore,
        camera_label: str,
        *,
        queue_size: int | None = None,
        worker_count: int | None = None,
    ) -> None:
        self._objects = objects
        self._camera_label = camera_label
        size = max(1, int(queue_size if queue_size is not None else settings.snapshot_pump_queue_size))
        self._queue: asyncio.Queue[_PendingUpload] = asyncio.Queue(maxsize=size)
        self._workers: list[asyncio.Task] = []
        self._worker_count = max(1, int(worker_count if worker_count is not None else settings.snapshot_pump_workers))
        self._closed = False

    def start(self) -> None:
        if self._workers:
            return
        loop = asyncio.get_running_loop()
        for i in range(self._worker_count):
            t = loop.create_task(self._worker(), name=f"snapshot-pump-{self._camera_label}-{i}")
            self._workers.append(t)

    def submit(self, bucket: str, key: str, crop_bgr: np.ndarray) -> bool:
        """Encode + enqueue. Drops the oldest pending upload on overflow.
        Returns True if the item was accepted onto the queue."""
        if self._closed:
            return False
        data = _encode_jpeg(crop_bgr)
        if data is None:
            return False
        item = _PendingUpload(bucket=bucket, key=key, data=data)
        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            # Discard oldest; freshness > completeness for live evidence.
            with suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
                self._queue.task_done()
            SNAPSHOT_QUEUE_DROPPED.labels(camera_id=self._camera_label).inc()
            with suppress(asyncio.QueueFull):
                self._queue.put_nowait(item)
        SNAPSHOT_QUEUE_DEPTH.labels(camera_id=self._camera_label).set(self._queue.qsize())
        return True

    async def aclose(self) -> None:
        self._closed = True
        for t in self._workers:
            t.cancel()
        for t in self._workers:
            with suppress(asyncio.CancelledError, Exception):
                await t
        self._workers.clear()
        SNAPSHOT_QUEUE_DEPTH.labels(camera_id=self._camera_label).set(0)
        SNAPSHOT_QUEUE_INFLIGHT.labels(camera_id=self._camera_label).set(0)

    async def _worker(self) -> None:
        loop = asyncio.get_running_loop()
        cam = self._camera_label
        while True:
            item: _PendingUpload = await self._queue.get()
            SNAPSHOT_QUEUE_DEPTH.labels(camera_id=cam).set(self._queue.qsize())
            SNAPSHOT_QUEUE_INFLIGHT.labels(camera_id=cam).inc()
            t0 = time.perf_counter()
            try:
                # Per-event auto-enhance, if enabled. The face-reconstruct
                # service (CodeFormer + Real-ESRGAN) runs in a separate
                # container at FACE_RECONSTRUCT_URL — we POST the JPEG,
                # get back an enhanced PNG, and upload THAT to MinIO.
                # Strict timeout because we'd rather upload the original
                # than block the queue waiting for a slow GAN.
                payload = item.data
                if settings.snapshot_auto_enhance:
                    enhanced = await _maybe_enhance(item.data, cam)
                    if enhanced is not None:
                        payload = enhanced
                await loop.run_in_executor(
                    get_io_pool(),
                    self._objects.put_bytes,
                    item.bucket,
                    item.key,
                    payload,
                )
            except Exception as e:
                log.warning("snapshot pump upload failed", camera=cam, key=item.key, err=str(e))
            finally:
                SNAPSHOT_UPLOAD_LATENCY.observe(time.perf_counter() - t0)
                SNAPSHOT_QUEUE_INFLIGHT.labels(camera_id=cam).dec()
                self._queue.task_done()


# ── Auto-enhance helper ─────────────────────────────────────────────────
#
# Shared httpx client is lazily built on first call so the pump module
# stays importable without a running event loop (the registry singleton
# pattern matches what footfall.py and snapshot_cache.py do).
_enhance_client: "httpx.AsyncClient | None" = None


def _get_enhance_client() -> "httpx.AsyncClient":
    global _enhance_client
    if _enhance_client is None:
        import httpx
        # Tight timeouts: per-event enhance has to stay under ~300 ms
        # round-trip to keep up with the live pipeline. If the GAN service
        # is slower than that, we drop back to the un-enhanced JPEG so the
        # event still lands in MinIO.
        _enhance_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=0.5, read=2.0, write=1.0, pool=0.5),
        )
    return _enhance_client


async def _maybe_enhance(jpeg_bytes: bytes, camera: str) -> bytes | None:
    """POST jpeg_bytes to /api/reconstruct, return enhanced PNG bytes.
    Returns None on any failure (timeout, 5xx, malformed response) so the
    caller falls back to the original. Crucially the operator should
    rarely notice the difference: original is fine, enhanced is better."""
    try:
        client = _get_enhance_client()
        url = settings.face_reconstruct_url.rstrip("/") + "/api/reconstruct"
        files = {"file": ("face.jpg", jpeg_bytes, "image/jpeg")}
        data  = {"fidelity_weight": str(settings.snapshot_auto_enhance_fidelity)}
        r = await client.post(url, files=files, data=data)
        if r.status_code != 200:
            return None
        body = r.json()
        # Use `reconstruction_image` (the CodeFormer + Real-ESRGAN output),
        # NOT `final_enhanced_image` — the latter is just stage-3 of the
        # classical CV pre-pass (bilateral + CLAHE + Laplacian sharpen)
        # inside pipeline.py, which barely changes the image. The actual
        # GAN-restored result lives at `reconstruction_image`.
        after_b64 = (body or {}).get("reconstruction_image") or (body or {}).get("final_enhanced_image")
        if not after_b64:
            return None
        import base64
        return base64.b64decode(after_b64)
    except Exception as e:
        log.debug("auto-enhance skipped", camera=camera, err=str(e))
        return None
