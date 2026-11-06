"""Per-camera latest-frame snapshot cache.

Purpose: serve a JPEG of the camera's most recent decoded frame on demand,
so the frontend has a guaranteed-visible live preview when MediaMTX HLS is
in one of its periodic muxer-crash states (B-frame DTS reorder failure).

Architecture choices:

  - **Encode once, serve many**. The orchestrator calls maybe_write() per
    frame; we throttle to ~4 fps so encoding cost is bounded even when
    every camera has a viewer. The HTTP handler does no encoding, just a
    dict read — keeps p95 response time in the low-millisecond range.

  - **Bytes-only cache**. We don't keep a reference to the raw BGR
    ndarray. JPEG bytes are immutable, cheap to copy across threads, and
    survive any PyAV buffer reuse. RAM footprint is the encoded size,
    typically 30–120 KB per camera at quality 60, so 23 cameras = ~3 MB.

  - **threading.Lock, not asyncio.Lock**. The orchestrator runs on its
    own asyncio task but calls into cv2 inside loop.run_in_executor when
    encoding (CPU-bound). The HTTP handler is asyncio. A regular Lock
    serializes both correctly without forcing the writer side to acquire
    an asyncio loop reference.

  - **No TTL**. The newest frame stays cached until overwritten; on
    camera shutdown the orchestrator calls forget(). A stale snapshot
    showing a frozen scene is more useful than no snapshot at all when
    diagnosing whether a camera went offline.
"""
from __future__ import annotations

import threading
import time
from typing import Any

import cv2

from vms_face.config import settings
import numpy as np

from vms_face.core.logging import get_logger

log = get_logger(__name__)

# How often we re-encode per camera. 250 ms = 4 fps, which matches the
# typical operator-eye refresh rate for surveillance previews. Cranking
# it tighter (e.g. 100 ms = 10 fps) doubles encode CPU for diminishing
# UX gain; relaxing it (e.g. 1 s = 1 fps) makes scenes feel laggy when
# viewers actively watch.
_MIN_ENCODE_INTERVAL_SEC = 0.25

# JPEG quality (0..100). 60 gives ~50 KB for 1080p with negligible
# perceptual loss on H.264-decoded source. Crank higher only if operators
# zoom into snapshots looking for evidence-grade detail.
_JPEG_QUALITY = 60


class SnapshotCache:
    def __init__(self) -> None:
        self._jpegs: dict[str, bytes] = {}
        self._meta: dict[str, dict[str, Any]] = {}    # ts, frame_w, frame_h
        self._last_encode_at: dict[str, float] = {}
        self._lock = threading.Lock()

    def maybe_write(self, camera_id: str, frame_bgr: np.ndarray) -> bool:
        """Encode + cache the frame if enough time has passed since the
        last encode for this camera. Returns True if a new JPEG was
        written. Safe to call from the orchestrator's hot path: the
        rate-limit check is a single dict lookup + comparison."""
        if frame_bgr is None or frame_bgr.size == 0:
            return False
        now = time.monotonic()
        # Cheap rate-limit check OUTSIDE the lock — the worst case under
        # contention is we double-encode for one frame, which doesn't
        # break correctness.
        last = self._last_encode_at.get(camera_id, 0.0)
        if now - last < max(_MIN_ENCODE_INTERVAL_SEC, float(settings.snapshot_cache_interval_sec)):
            return False

        # Encode a bounded-width copy, never the full frame. This is the
        # thumbnail fallback behind /snapshot.jpg; a 1080p JPEG at q60 costs
        # ~10-15 ms of CPU per encode and ran 4x/s per camera, which showed up
        # as the single largest per-frame cost in vms_pipeline_stage_seconds
        # (stage=overlay). A 640-wide copy encodes in ~1 ms.
        try:
            max_w = int(settings.snapshot_cache_max_width)
            if max_w > 0 and frame_bgr.shape[1] > max_w:
                scale = max_w / float(frame_bgr.shape[1])
                frame_bgr = cv2.resize(
                    frame_bgr, (max_w, max(1, int(round(frame_bgr.shape[0] * scale)))),
                    interpolation=cv2.INTER_AREA,
                )
            ok, buf = cv2.imencode(
                ".jpg", frame_bgr,
                [int(cv2.IMWRITE_JPEG_QUALITY), _JPEG_QUALITY],
            )
        except Exception as e:
            log.debug("snapshot encode failed", camera=camera_id, err=str(e))
            return False
        if not ok:
            return False

        data = buf.tobytes()
        h, w = frame_bgr.shape[:2]
        with self._lock:
            self._jpegs[camera_id] = data
            self._meta[camera_id] = {
                "ts": time.time(),
                "frame_w": int(w),
                "frame_h": int(h),
                "size_bytes": len(data),
            }
            self._last_encode_at[camera_id] = now
        return True

    def get(self, camera_id: str) -> tuple[bytes | None, dict[str, Any] | None]:
        with self._lock:
            data = self._jpegs.get(camera_id)
            meta = self._meta.get(camera_id)
        return data, (dict(meta) if meta else None)

    def forget(self, camera_id: str) -> None:
        """Drop the cached snapshot. Called from the orchestrator's
        shutdown path so a stopped camera doesn't keep returning a frozen
        frame indefinitely."""
        with self._lock:
            self._jpegs.pop(camera_id, None)
            self._meta.pop(camera_id, None)
            self._last_encode_at.pop(camera_id, None)


# Module-level singleton. Lazy so test imports don't trigger I/O.

_cache: SnapshotCache | None = None


def get_snapshot_cache() -> SnapshotCache:
    global _cache
    if _cache is None:
        _cache = SnapshotCache()
    return _cache
