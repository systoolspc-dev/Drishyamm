"""Client side of the inference service, and the runtime facade that lets an
orchestrator use it without knowing.

Why a service: one process per box saturates around 20 cameras while the GPU
sits at 12–34% (docs/FACE_SYSTEM_DESIGN.md, Phase 1 load tests). Camera
workers keep decode, tracking, latching and overlays; every detect and embed
goes over one multiplexed TCP connection per process to `workers/infer_server`,
which batches across all cameras of all workers on a single set of TensorRT
sessions.

Two clients live here. `InferClient` is the async one the pipeline uses:
one connection per process, requests multiplexed by id. `SyncInferClient`
is a plain blocking socket for the few callers that run `detect()` /
`embed()` synchronously (API routes, enrollment): they call from the event
loop thread, so they cannot wait on the async client without deadlocking it.

Outage policy (`RemoteFaceRuntime`): while the service is unreachable frames
are skipped — the tracker coasts — and only after
`infer_service_fallback_after_sec` do workers load local models, so a
restart of the service never makes N workers each pull a copy of every
engine into VRAM.
"""
from __future__ import annotations

import asyncio
import socket
import threading
import time
from typing import Any
from urllib.parse import urlparse

import numpy as np

from vms_face.config import settings
from prometheus_client import Histogram

from vms_face.core.logging import get_logger
from vms_face.infra.infer_proto import array_from, array_meta, pack, read_message, read_message_sync

log = get_logger(__name__)

CLIENT_PHASE = Histogram(
    "vms_infer_client_seconds", "Inference client time per request, by phase",
    ["phase"], buckets=(0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0),
)


class InferUnavailable(RuntimeError):
    """The service is down or timed out; the caller decides what to do."""


def _parse(url: str) -> tuple[str, int]:
    """INFER_SERVICE_URL may list several services (comma-separated); a
    process sticks to one, chosen by its shard index, so M services split N
    shards evenly and each service keeps its own batchers warm."""
    urls = [u.strip() for u in str(url).split(",") if u.strip()]
    if len(urls) > 1:
        from vms_face.services import sharding
        url = urls[sharding.shard_index() % len(urls)]
    else:
        url = urls[0] if urls else ""
    u = urlparse(url if "://" in url else f"tcp://{url}")
    return u.hostname or "127.0.0.1", int(u.port or settings.infer_service_port)


def _det_input_for(det_size: int) -> tuple[int, int]:
    """Same formula as FaceRuntime._det_input, so the client letterboxes to
    exactly the tensor the service's runtime of this size uses."""
    aspect = float(getattr(settings, "insightface_det_aspect", 0) or 0)
    if aspect <= 0:
        return (det_size, det_size)
    height = max(160, int((int(det_size / aspect) + 31) // 32) * 32)
    return (det_size, height)


def _rows_to_observations(header: dict[str, Any], body: bytes, scale: float) -> list:
    from vms_face.infra.insightface_runtime import FaceObservation

    n = int(header.get("n", 0))
    if n == 0:
        return []
    arr = array_from({"shape": [n, 15], "dtype": "float32"}, body)
    inv = np.float32(1.0 / scale)
    out: list[FaceObservation] = []
    for row in arr:
        out.append(FaceObservation(
            bbox=(row[:4] * inv).astype(np.float32),
            det_score=float(row[4]),
            landmark_5=(row[5:15].reshape(5, 2) * inv).astype(np.float32),
            embedding=None, yaw_deg=None, pitch_deg=None, age=None, gender=None,
        ))
    return out


def _letterbox_for_service(frame_bgr: np.ndarray, det_size: int) -> tuple[np.ndarray, float]:
    """Pre-letterbox on the worker: 4x fewer bytes than a 1080p frame, and the
    service's own letterbox of the result is an exact no-op (scale 1.0), so
    the detector sees the identical tensor it would have built locally."""
    from vms_face.infra.batched_scrfd import _letterbox

    tw, th = _det_input_for(det_size)
    h, w = frame_bgr.shape[:2]
    if w <= tw and h <= th:
        # Smaller than the input: send as is; the service upsamples exactly
        # like the local path would.
        return np.ascontiguousarray(frame_bgr), 1.0
    canvas, scale, _dx, _dy = _letterbox(frame_bgr, tw, th)
    return canvas, float(scale)


class InferClient:
    """Async client: one connection per process, requests multiplexed by id."""

    _instance: "InferClient | None" = None
    _instance_lock = threading.Lock()

    def __init__(self, url: str, timeout: float) -> None:
        self._host, self._port = _parse(url)
        self._timeout = float(timeout)
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._reader_task: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._next_id = 0
        self._wlock: asyncio.Lock | None = None
        self._conn_lock: asyncio.Lock | None = None
        self._down_until = 0.0
        self.down_since: float | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.info: dict[str, Any] = {}

    @classmethod
    def shared(cls) -> "InferClient":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls(settings.infer_service_url, settings.infer_service_timeout_sec)
            return cls._instance

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    def down_for(self) -> float:
        return 0.0 if self.down_since is None else time.monotonic() - self.down_since

    def _mark_down(self) -> None:
        now = time.monotonic()
        if self.down_since is None:
            self.down_since = now
        self._down_until = now + float(settings.infer_service_retry_sec)

    async def _ensure(self) -> None:
        if self.connected:
            return
        if time.monotonic() < self._down_until:
            raise InferUnavailable("inference service marked down; retry pending")
        if self._conn_lock is None:
            self._conn_lock = asyncio.Lock()
            self._wlock = asyncio.Lock()
        async with self._conn_lock:
            if self.connected:
                return
            try:
                self._reader, self._writer = await asyncio.wait_for(
                    asyncio.open_connection(self._host, self._port, limit=1 << 20), timeout=3.0
                )
            except Exception as e:  # noqa: BLE001
                self._mark_down()
                raise InferUnavailable(f"connect to {self._host}:{self._port} failed: {e}") from e
            self.loop = asyncio.get_running_loop()
            self._reader_task = asyncio.create_task(self._read_loop(), name="infer-client-reader")
            self.down_since = None
            try:
                self.info, _ = await self.request("info", {}, b"")
                log.info("inference service connected", host=self._host, port=self._port,
                         **{k: v for k, v in self.info.items() if k not in ("id", "ok")})
            except Exception as e:  # noqa: BLE001
                log.warning("inference service info failed", err=str(e))

    async def _read_loop(self) -> None:
        assert self._reader is not None
        try:
            while True:
                header, payload = await read_message(self._reader)
                fut = self._pending.pop(int(header.get("id", -1)), None)
                if fut is not None and not fut.done():
                    fut.set_result((header, payload))
        except Exception as e:  # noqa: BLE001 - connection dropped
            log.warning("inference service connection lost", err=str(e))
            self._fail_all(InferUnavailable(f"connection lost: {e}"))

    def _fail_all(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()
        if self._writer is not None:
            try:
                self._writer.close()
            except Exception:  # noqa: BLE001
                pass
        self._writer = None
        self._reader = None
        self._mark_down()

    async def request(self, op: str, meta: dict[str, Any], payload: bytes | memoryview) -> tuple[dict[str, Any], bytes]:
        await self._ensure()
        assert self._writer is not None and self._wlock is not None
        self._next_id += 1
        rid = self._next_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            t0 = time.perf_counter()
            async with self._wlock:
                t1 = time.perf_counter()
                self._writer.write(pack({"id": rid, "op": op, "t": time.time(), **meta}, payload))
                await self._writer.drain()
            t2 = time.perf_counter()
            header, body = await asyncio.wait_for(fut, timeout=self._timeout)
            t3 = time.perf_counter()
            CLIENT_PHASE.labels(phase="lock").observe(t1 - t0)
            CLIENT_PHASE.labels(phase="write").observe(t2 - t1)
            CLIENT_PHASE.labels(phase="wait").observe(t3 - t2)
        except asyncio.TimeoutError as e:
            self._pending.pop(rid, None)
            raise InferUnavailable(f"{op} timed out after {self._timeout}s") from e
        except InferUnavailable:
            raise
        except Exception as e:  # noqa: BLE001
            self._pending.pop(rid, None)
            self._fail_all(InferUnavailable(str(e)))
            raise InferUnavailable(str(e)) from e
        if not header.get("ok", True):
            raise RuntimeError(f"inference service error on {op}: {header.get('error')}")
        return header, body

    # ── ops ────────────────────────────────────────────────────────────────

    async def detect(self, frame_bgr: np.ndarray, det_size: int) -> list:
        """Pipeline detect: frame pre-letterboxed here, boxes/landmarks come
        back in frame coordinates."""
        from vms_face.core.executors import get_gpu_pool

        # ~1 ms of cv2 per 1080p frame; keep it off the loop thread (cv2
        # drops the GIL, so this parallelises across cameras too).
        send, scale = await asyncio.get_running_loop().run_in_executor(
            get_gpu_pool(), _letterbox_for_service, frame_bgr, det_size
        )
        header, body = await self.request("detect", {"det_size": det_size, **array_meta(send)}, memoryview(send))
        return _rows_to_observations(header, body, scale)

    async def embed_aligned(self, crops: list[np.ndarray]) -> list[np.ndarray | None]:
        """Aligned 112x112 BGR crops -> L2-normed 512-d vectors (None where
        the recognizer refused a crop)."""
        if not crops:
            return []
        batch = np.ascontiguousarray(np.stack(crops, axis=0).astype(np.uint8, copy=False))
        header, body = await self.request("embed", array_meta(batch), memoryview(batch))
        vecs = array_from({"shape": [len(crops), 512], "dtype": "float32"}, body)
        ok = header.get("ok_mask") or [True] * len(crops)
        return [vecs[i].copy() if ok[i] else None for i in range(len(crops))]


class SyncInferClient:
    """Blocking client for synchronous callers. Its own connection, one
    request at a time; reconnects once on a dead socket."""

    _instance: "SyncInferClient | None" = None
    _instance_lock = threading.Lock()

    def __init__(self, url: str, timeout: float) -> None:
        self._host, self._port = _parse(url)
        self._timeout = float(timeout)
        self._sock: socket.socket | None = None
        self._lock = threading.Lock()
        self._next_id = 0

    @classmethod
    def shared(cls) -> "SyncInferClient":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls(settings.infer_service_url, settings.infer_service_sync_timeout_sec)
            return cls._instance

    def _close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def request(self, op: str, meta: dict[str, Any], payload: bytes | memoryview) -> tuple[dict[str, Any], bytes]:
        with self._lock:
            last: Exception | None = None
            for _attempt in (0, 1):
                try:
                    if self._sock is None:
                        self._sock = socket.create_connection((self._host, self._port), timeout=3.0)
                        self._sock.settimeout(self._timeout)
                        self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    self._next_id += 1
                    self._sock.sendall(pack({"id": self._next_id, "op": op, **meta}, payload))
                    header, body = read_message_sync(self._sock)
                    if not header.get("ok", True):
                        raise RuntimeError(f"inference service error on {op}: {header.get('error')}")
                    return header, body
                except (OSError, ValueError, ConnectionError) as e:
                    last = e
                    self._close()
            raise InferUnavailable(f"{op} failed: {last}")

    def detect(self, frame_bgr: np.ndarray, det_size: int, *, max_faces: int = 0, det_thresh: float | None = None) -> list:
        """API-path detect: the raw frame goes over (insightface's own resize
        runs on the service, exactly as it does locally) with the per-call
        det_thresh / max_faces the enrollment and forensic routes rely on."""
        send = np.ascontiguousarray(frame_bgr)
        meta: dict[str, Any] = {"det_size": det_size, "max_faces": int(max_faces), "sync": True, **array_meta(send)}
        if det_thresh is not None:
            meta["det_thresh"] = float(det_thresh)
        header, body = self.request("detect", meta, memoryview(send))
        return _rows_to_observations(header, body, 1.0)

    def embed_aligned(self, crops: list[np.ndarray]) -> list[np.ndarray | None]:
        if not crops:
            return []
        batch = np.ascontiguousarray(np.stack(crops, axis=0).astype(np.uint8, copy=False))
        header, body = self.request("embed", array_meta(batch), memoryview(batch))
        vecs = array_from({"shape": [len(crops), 512], "dtype": "float32"}, body)
        ok = header.get("ok_mask") or [True] * len(crops)
        return [vecs[i].copy() if ok[i] else None for i in range(len(crops))]


class RemoteFaceRuntime:
    """What the orchestrator sees. Same surface as FaceRuntime for the calls
    the pipeline and the API make; inference happens in the service."""

    def __init__(self, det_size: int | None = None) -> None:
        self._det_size = int(det_size or settings.insightface_det_size)
        self._client = InferClient.shared()
        self._local = None
        self._local_lock = threading.Lock()
        self._skip_logged_at = 0.0

    @property
    def det_size(self) -> int:
        return self._det_size

    @property
    def degraded(self) -> bool:
        return not self._client.connected

    @property
    def runs_recognition(self) -> bool:
        return False

    def _det_input(self) -> tuple[int, int]:
        return _det_input_for(self._det_size)

    def _local_runtime(self):
        if self._local is None:
            with self._local_lock:
                if self._local is None:
                    from vms_face.infra.insightface_runtime import FaceRuntime
                    log.warning("inference service down too long; loading local models as fallback",
                                det_size=self._det_size, down_for_s=round(self._client.down_for(), 1))
                    self._local = FaceRuntime(det_size=self._det_size)
        return self._local

    def _on_unavailable(self, err: Exception) -> bool:
        """True = fall back to local models, False = skip this frame."""
        if self._local is not None:
            return True
        if self._client.down_for() >= float(settings.infer_service_fallback_after_sec):
            return True
        now = time.monotonic()
        if now - self._skip_logged_at > 5.0:
            self._skip_logged_at = now
            log.warning("inference service unavailable; skipping frames", err=str(err),
                        down_for_s=round(self._client.down_for(), 1))
        return False

    async def detect_async(self, frame_bgr: np.ndarray) -> list:
        if frame_bgr is None or frame_bgr.size == 0:
            return []
        try:
            return await self._client.detect(frame_bgr, self._det_size)
        except InferUnavailable as e:
            if self._on_unavailable(e):
                return await self._local_runtime().detect_async(frame_bgr)
            return []

    def detect(self, frame_bgr: np.ndarray, *, max_faces: int = 0, det_thresh: float | None = None) -> list:
        """Synchronous detect for API routes / enrollment (they call from the
        event-loop thread, so this must not wait on the async client)."""
        if frame_bgr is None or frame_bgr.size == 0:
            return []
        try:
            return SyncInferClient.shared().detect(frame_bgr, self._det_size, max_faces=max_faces, det_thresh=det_thresh)
        except InferUnavailable as e:
            if self._on_unavailable(e):
                return self._local_runtime().detect(frame_bgr, max_faces=max_faces, det_thresh=det_thresh)
            raise
