"""The inference service: one process that owns the GPU for a whole box.

    python -m vms_face.workers.infer_server

Accepts framed requests (infra/infer_proto.py) from any number of camera
workers over TCP and answers three ops:

    info    -> which recognizer / detector input this box runs, so clients
               label candidates with the right embedding space
    detect  -> BGR frame -> [n, 15] float32 rows: x1 y1 x2 y2 score kps(5x2).
               Pipeline frames arrive pre-letterboxed and go through the
               cross-camera batcher; `sync: true` requests (API routes,
               enrollment) take the per-call max_faces / det_thresh path.
    embed   -> [n, 112, 112, 3] uint8 aligned crops -> [n, 512] float32

It is the same FaceRuntime and recognizer the workers used to run in-process
(TensorRT, static export, thread caps — infra/ort_session.py), so results are
identical to the local path; what changes is that detect requests from every
camera of every worker share the batchers and sessions of ONE process.
Prometheus metrics on INFER_SERVICE_METRICS_PORT.
"""
from __future__ import annotations

import asyncio
import faulthandler
import functools
import signal
import time

import numpy as np

from vms_face.config import settings
from vms_face.core.logging import configure_logging, get_logger
from prometheus_client import Counter, Histogram
from vms_face.infra.infer_proto import array_from, pack, read_message

log = get_logger(__name__)

REQUESTS = Counter("vms_infer_requests_total", "Inference service requests", ["op", "outcome"])
LATENCY = Histogram("vms_infer_request_seconds", "Inference service request time (server side)", ["op"],
                    buckets=(0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0))
# Client send time -> fully read here (containers share the host clock):
# the socket hop itself, write + transfer + parse.
TRANSIT = Histogram("vms_infer_transit_seconds", "Client send to server read complete", ["op"],
                    buckets=(0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0))


class InferServer:
    def __init__(self) -> None:
        # This process must build LOCAL models even if the shared env points
        # workers at a service (that would be us).
        settings.infer_service_role = "server"
        from vms_face.core.executors import get_gpu_pool
        from vms_face.infra.insightface_runtime import FaceRuntimePool
        from vms_face.infra.recognizers import get_recognizer

        # local=True: never route to a service (that would be ourselves),
        # whatever the shared env says.
        self._pool_get = functools.partial(FaceRuntimePool.get, local=True)
        self._runtime = self._pool_get(settings.insightface_det_size)
        # Touch every replica now so the engines load before the first frame.
        for _ in range(max(1, int(settings.insightface_runtime_replicas)) - 1):
            self._pool_get(settings.insightface_det_size)
        self._recognizer = get_recognizer()
        self._executor = get_gpu_pool()
        # Warm the per-image (API / enrollment) detector path too: its engine
        # is separate from the batched one and would otherwise load on the
        # first enrollment call, seconds after a worker's socket timed out.
        try:
            self._runtime.detect(np.zeros((360, 640, 3), dtype=np.uint8), max_faces=1)
        except Exception as e:  # noqa: BLE001
            log.warning("sync detect warm-up failed", err=str(e))
        self._requests = 0
        self._conns = 0
        # The loop keeps only weak refs to tasks; hold ours until done.
        self._tasks: set[asyncio.Task] = set()

    def info(self) -> dict:
        return {
            "recognizer": getattr(self._recognizer, "name", "insightface_arc"),
            "det_size": self._runtime.det_size,
            "det_input": list(self._runtime._det_input()),
            "replicas": int(settings.insightface_runtime_replicas),
            "batched": bool(settings.pipeline_batched_inference),
        }

    @staticmethod
    def _rows(obs: list) -> tuple[dict, bytes]:
        if not obs:
            return {"n": 0}, b""
        rows = np.empty((len(obs), 15), dtype=np.float32)
        for i, o in enumerate(obs):
            rows[i, :4] = o.bbox
            rows[i, 4] = o.det_score
            rows[i, 5:15] = (o.landmark_5.reshape(-1) if o.landmark_5 is not None else np.zeros(10, np.float32))
        return {"n": len(obs)}, rows.tobytes()

    async def _detect(self, meta: dict, payload: bytes) -> tuple[dict, bytes]:
        frame = array_from(meta, payload)
        # Round-robin across replicas per request (each has its own
        # cross-camera batcher, so N replicas = N batches in flight).
        rt = self._pool_get(int(meta.get("det_size") or settings.insightface_det_size))
        if meta.get("sync"):
            loop = asyncio.get_running_loop()
            fn = functools.partial(rt.detect, frame, max_faces=int(meta.get("max_faces") or 0),
                                   det_thresh=meta.get("det_thresh"))
            return self._rows(await loop.run_in_executor(self._executor, fn))
        return self._rows(await rt.detect_async(frame))

    async def _embed(self, meta: dict, payload: bytes) -> tuple[dict, bytes]:
        crops = array_from(meta, payload)
        loop = asyncio.get_running_loop()
        vecs = await loop.run_in_executor(self._executor, self._recognizer.embed_aligned_batch, list(crops))
        out = np.zeros((len(crops), 512), dtype=np.float32)
        ok = []
        for i, v in enumerate(vecs):
            if v is not None:
                out[i] = v
                ok.append(True)
            else:
                ok.append(False)
        return {"n": len(crops), "ok_mask": ok}, out.tobytes()

    async def _process(self, header: dict, payload: bytes, writer: asyncio.StreamWriter, wlock: asyncio.Lock) -> None:
        rid = header.get("id")
        op = str(header.get("op"))
        t0 = time.perf_counter()
        try:
            if op == "detect":
                meta, body = await self._detect(header, payload)
            elif op == "embed":
                meta, body = await self._embed(header, payload)
            elif op == "info":
                meta, body = self.info(), b""
            else:
                raise ValueError(f"unknown op {op!r}")
            meta.setdefault("ok", True)
            REQUESTS.labels(op=op, outcome="ok").inc()
        except Exception as e:  # noqa: BLE001 - one bad request must not kill the connection
            log.warning("inference request failed", op=op, err=str(e))
            meta, body = {"ok": False, "error": str(e)[:300]}, b""
            REQUESTS.labels(op=op, outcome="error").inc()
        LATENCY.labels(op=op).observe(time.perf_counter() - t0)
        meta["id"] = rid
        try:
            async with wlock:
                writer.write(pack(meta, body))
                await writer.drain()
        except (ConnectionError, OSError):
            return  # worker went away mid-request; its reconnect resends
        self._requests += 1

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        wlock = asyncio.Lock()
        announced = False
        try:
            while True:
                header, payload = await read_message(reader)
                if "t" in header:
                    TRANSIT.labels(op=str(header.get("op"))).observe(max(0.0, time.time() - float(header["t"])))
                if not announced:
                    # Announce on the first request, not on connect: the
                    # docker healthcheck opens and closes a socket every 10 s.
                    announced = True
                    self._conns += 1
                    log.info("worker connected", peer=str(peer), connections=self._conns)
                task = asyncio.create_task(self._process(header, payload, writer, wlock))
                self._tasks.add(task)
                task.add_done_callback(self._tasks.discard)
        except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:  # noqa: BLE001
            log.warning("worker connection error", peer=str(peer), err=str(e))
        finally:
            writer.close()
            if announced:
                self._conns -= 1
                log.info("worker disconnected", peer=str(peer), connections=self._conns)

    async def _report(self) -> None:
        last = 0
        while True:
            await asyncio.sleep(30)
            now = self._requests
            log.info("inference service", req_per_s=round((now - last) / 30.0, 1), connections=self._conns)
            last = now


async def main() -> None:
    faulthandler.enable()
    configure_logging()
    port = int(settings.infer_service_port)
    try:
        from prometheus_client import start_http_server
        start_http_server(int(settings.infer_service_metrics_port))
    except Exception as e:  # noqa: BLE001
        log.warning("metrics endpoint unavailable", err=str(e))
    srv = InferServer()
    server = await asyncio.start_server(srv.handle, host="0.0.0.0", port=port, limit=1 << 20)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    log.info("inference service listening", port=port, **srv.info())
    asyncio.create_task(srv._report())
    async with server:
        await stop.wait()
    log.info("inference service stopping")


if __name__ == "__main__":
    asyncio.run(main())
