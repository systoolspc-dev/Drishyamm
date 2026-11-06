"""Owns the shared detectors and all stream workers; aggregates their state."""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from threading import Lock

from .config import AppConfig
from .model import Detector
from .stream_worker import StreamWorker

log = logging.getLogger("headcount.manager")


class StreamManager:
    def __init__(self, config: AppConfig):
        self.config = config
        self._started_at = time.time()
        # Cap torch's intra-op threads BEFORE any model loads. Torch defaults
        # to every core, so one CPU inference starves co-tenant services; a
        # small cap keeps latency close while sharing the box politely.
        if config.pipeline.torch_threads > 0:
            try:
                import torch
                torch.set_num_threads(config.pipeline.torch_threads)
                log.info("torch intra-op threads capped at %d", config.pipeline.torch_threads)
            except Exception:  # noqa: BLE001 — a cap failure must never block startup
                log.warning("could not cap torch threads", exc_info=True)
        # Load each detector once and share it across all stream workers.
        self.detectors = [Detector(dc) for dc in config.detectors]
        self._model_lock = Lock()  # shared hardware → serialize inference
        self._reconcile_lock = Lock()  # serialize dynamic add/remove of workers
        self.workers: dict[str, StreamWorker] = {}
        for stream in config.streams:
            self.workers[stream.id] = StreamWorker(
                stream, self.detectors, self._model_lock, config.pipeline,
                preview=config.api.preview, jpeg_quality=config.api.jpeg_quality,
                preview_banner=config.api.preview_banner,
            )

    def start(self) -> None:
        log.info("starting %d stream worker(s) with %d detector(s)",
                 len(self.workers), len(self.detectors))
        for w in self.workers.values():
            w.start()

    def stop(self) -> None:
        log.info("stopping stream workers")
        for w in self.workers.values():
            w.stop()
        for w in self.workers.values():
            w.join(timeout=5.0)

    def reconcile(self, streams) -> None:
        """Dynamically match the running workers to the desired stream set —
        start workers for newly-enabled cameras, stop workers for ones removed.
        Called by the dynamic source poller as users toggle headcount per camera."""
        with self._reconcile_lock:
            desired = {s.id: s for s in streams}
            # Stop + drop workers no longer wanted.
            for sid in list(self.workers):
                if sid not in desired:
                    w = self.workers.pop(sid)
                    w.stop()
                    w.join(timeout=3.0)
                    log.info("head-count: removed camera %s", sid)
            # Restart workers whose configuration changed — a camera keeps its
            # id when the operator edits its counting zone or source, so
            # comparing ids alone would leave the old settings running for ever.
            for sid, stream in desired.items():
                w = self.workers.get(sid)
                if w is None:
                    continue
                if getattr(w, "cfg", None) is not None and w.cfg != stream:
                    w.stop()
                    w.join(timeout=3.0)
                    self.workers.pop(sid, None)
                    log.info("head-count: settings changed for %s — restarting", sid)

            # Start workers for newly-added cameras.
            for sid, stream in desired.items():
                if sid not in self.workers:
                    w = StreamWorker(
                        stream, self.detectors, self._model_lock, self.config.pipeline,
                        preview=self.config.api.preview, jpeg_quality=self.config.api.jpeg_quality,
                        preview_banner=self.config.api.preview_banner,
                    )
                    self.workers[sid] = w
                    w.start()
                    log.info("head-count: added camera %s (%s)", sid, stream.name or sid)

    # -- queries used by the API ------------------------------------------
    def get(self, stream_id: str) -> dict | None:
        w = self.workers.get(stream_id)
        return w.snapshot() if w else None

    def worker(self, stream_id: str):
        return self.workers.get(stream_id)

    def all_snapshots(self) -> list[dict]:
        return [w.snapshot() for w in self.workers.values()]

    def counts(self) -> dict:
        snaps = self.all_snapshots()
        per_stream = {s["id"]: s["counts"] for s in snaps}
        totals: dict[str, int] = defaultdict(int)
        for s in snaps:
            for label, n in s["counts"].items():
                totals[label] += n
        return {
            "counts": per_stream,
            "totals": dict(totals),
            "streams_online": sum(1 for s in snaps if s["connected"]),
            "streams_total": len(snaps),
        }

    def health(self) -> dict:
        snaps = self.all_snapshots()
        online = sum(1 for s in snaps if s["connected"])
        status = "healthy" if online == len(snaps) and snaps else (
            "degraded" if online > 0 else "unhealthy"
        )
        return {
            "status": status,
            "uptime_seconds": round(time.time() - self._started_at, 1),
            "device": self.detectors[0].device if self.detectors else "n/a",
            "detectors": [{"id": d.id, "label": d.label} for d in self.detectors],
            "streams_online": online,
            "streams_total": len(snaps),
            "version": __import__("headcount").__version__,
        }
