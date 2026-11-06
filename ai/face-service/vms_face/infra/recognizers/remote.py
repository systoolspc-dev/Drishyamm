"""Remote recognizer — the edge half of "detect-track-crop-only, server embeds".

An edge node running this backend does everything the server pipeline does
EXCEPT the recognizer forward pass: SCRFD, Kalman tracking, the quality gate,
the embedding pool and the identity latch all run locally. The few crops the
latch lets through (~2 per track) are aligned here with the canonical 5-point
template and POSTed to the server's ``/edge/embed``, which answers in the
server's own embedding space. Consequences that matter:

  * One embedding space per deployment. The edge never holds a model, so it
    can never disagree with the gallery.
  * Zero recognizer GPU on the edge. The detector is the only model there.
  * Bandwidth is a few KB per track, not per frame: a lossless 112x112 PNG is
    ~25 KB, and the latch already decided most frames need no embed at all.
  * A dead uplink degrades to "boxes without names": the circuit breaker makes
    embeds return None quickly, the latch keeps re-trying on its timers, and
    the tracker/overlay never stall.

``name`` is the SERVER's recognizer name (learned from ``/edge/info``) because
the field describes the embedding space, which is the server's.
"""
from __future__ import annotations

import base64
import threading
import time

import cv2
import httpx
import numpy as np

from vms_face.config import settings
from vms_face.core.exceptions import ConfigurationError
from vms_face.core.logging import get_logger
from vms_face.infra.aligner import norm_crop
from vms_face.infra.batcher import AsyncBatcher

log = get_logger(__name__)


class RemoteRecognizer:
    embedding_dim = 512
    name = "remote"

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        async_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base = (base_url or settings.edge_server_url or "").rstrip("/")
        if not self._base:
            raise ConfigurationError("RECOGNIZER_BACKEND=remote requires EDGE_SERVER_URL")
        self._token = token if token is not None else (settings.edge_server_token or "")
        self._timeout = httpx.Timeout(float(settings.edge_http_timeout_sec))
        self._fmt = "jpeg" if str(settings.edge_crop_format).lower() == "jpeg" else "png"
        self._jpeg_q = int(settings.edge_jpeg_quality)
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        # `transport` hooks exist for tests (httpx.MockTransport); production
        # uses the defaults.
        self._client = httpx.Client(base_url=self._base, headers=headers,
                                    timeout=self._timeout, transport=transport)
        self._aclient = httpx.AsyncClient(base_url=self._base, headers=headers,
                                          timeout=self._timeout, transport=async_transport)
        # Circuit breaker state.
        self._fail_threshold = max(1, int(settings.edge_breaker_fail_threshold))
        self._cooldown = max(0.0, float(settings.edge_breaker_cooldown_sec))
        self._consecutive_failures = 0
        self._open_until: float = 0.0
        self._breaker_lock = threading.Lock()

        self._batcher: AsyncBatcher | None = None
        self._batcher_lock = threading.Lock()

        self._learn_server_identity()

    # ── identity of the embedding space ───────────────────────────────────

    def _learn_server_identity(self) -> None:
        try:
            r = self._client.get("/edge/info")
            r.raise_for_status()
            info = r.json()
        except Exception as e:  # noqa: BLE001
            # Not fatal: the edge can start before the server is reachable.
            # The name stays "remote" until the first successful info call.
            log.warning("remote recognizer: /edge/info unavailable at start", err=str(e))
            return
        self.name = str(info.get("recognizer") or self.name)
        self.embedding_dim = int(info.get("embedding_dim") or self.embedding_dim)
        log.info("remote recognizer bound", server=self._base, recognizer=self.name,
                 embedding_dim=self.embedding_dim, crop_format=self._fmt)

    # ── helpers ───────────────────────────────────────────────────────────

    def _encode(self, aligned_bgr: np.ndarray) -> tuple[bytes, str]:
        if self._fmt == "jpeg":
            ok, buf = cv2.imencode(".jpg", aligned_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), self._jpeg_q])
            return (buf.tobytes() if ok else b""), "image/jpeg"
        ok, buf = cv2.imencode(".png", aligned_bgr, [int(cv2.IMWRITE_PNG_COMPRESSION), 3])
        return (buf.tobytes() if ok else b""), "image/png"

    def _align(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        try:
            return norm_crop(frame_bgr, landmarks_5, image_size=112)
        except Exception as e:  # noqa: BLE001
            log.warning("remote recognizer: alignment failed", err=str(e))
            return None

    @staticmethod
    def _l2(vec) -> np.ndarray | None:
        arr = np.asarray(vec, dtype=np.float32).reshape(-1)
        n = float(np.linalg.norm(arr))
        return (arr / n).astype(np.float32) if n > 0 else None

    # circuit breaker
    def _breaker_open(self) -> bool:
        return time.monotonic() < self._open_until

    def _record_ok(self) -> None:
        with self._breaker_lock:
            self._consecutive_failures = 0

    def _record_fail(self, err: str) -> None:
        with self._breaker_lock:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._fail_threshold and self._cooldown > 0:
                self._open_until = time.monotonic() + self._cooldown
                self._consecutive_failures = 0
                log.warning("remote recognizer: circuit open", cooldown_sec=self._cooldown, err=err)

    @property
    def circuit_open(self) -> bool:
        return self._breaker_open()

    # ── Recognizer protocol ───────────────────────────────────────────────

    def embed(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        if landmarks_5 is None or self._breaker_open():
            return None
        aligned = self._align(frame_bgr, landmarks_5)
        if aligned is None:
            return None
        payload, ctype = self._encode(aligned)
        if not payload:
            return None
        try:
            r = self._client.post("/edge/embed", files={"file": ("crop", payload, ctype)})
            r.raise_for_status()
            emb = self._l2(r.json()["embedding"])
        except Exception as e:  # noqa: BLE001
            self._record_fail(str(e))
            log.warning("remote recognizer: embed failed", err=str(e))
            return None
        self._record_ok()
        return emb

    def _ensure_batcher(self) -> AsyncBatcher:
        if self._batcher is not None:
            return self._batcher
        with self._batcher_lock:
            if self._batcher is None:
                self._batcher = AsyncBatcher[np.ndarray, "np.ndarray | None"](
                    flush_fn=self._run_batch_sync,
                    max_size=int(settings.batch_embed_max),
                    window_sec=max(0.0, float(settings.batch_embed_window_ms) / 1000.0),
                    stage="embed",
                )
            return self._batcher

    def _run_batch_sync(self, aligned_crops: list[np.ndarray]) -> list[np.ndarray | None]:
        """One HTTP round-trip for a batch of aligned crops (AsyncBatcher runs
        this on a thread). Network, not GPU — the default executor is fine."""
        if not aligned_crops:
            return []
        if self._breaker_open():
            return [None] * len(aligned_crops)
        crops_b64 = []
        for c in aligned_crops:
            payload, _ = self._encode(c)
            crops_b64.append(base64.b64encode(payload).decode("ascii"))
        try:
            r = self._client.post("/edge/embed/batch", json={"format": self._fmt, "crops": crops_b64})
            r.raise_for_status()
            rows = r.json()["embeddings"]
        except Exception as e:  # noqa: BLE001
            self._record_fail(str(e))
            log.warning("remote recognizer: batch embed failed", err=str(e), batch=len(aligned_crops))
            return [None] * len(aligned_crops)
        self._record_ok()
        if len(rows) != len(aligned_crops):
            return [None] * len(aligned_crops)
        return [self._l2(v) if v is not None else None for v in rows]

    async def embed_async(self, frame_bgr: np.ndarray, landmarks_5: np.ndarray) -> np.ndarray | None:
        if landmarks_5 is None:
            return None
        if not settings.pipeline_batched_inference:
            return self.embed(frame_bgr, landmarks_5)
        aligned = self._align(frame_bgr, landmarks_5)
        if aligned is None:
            return None
        return await self._ensure_batcher().submit(aligned)

    def reuse_existing(self, existing: np.ndarray | None) -> np.ndarray | None:
        # The edge detector never embeds; there is nothing to reuse.
        return None
