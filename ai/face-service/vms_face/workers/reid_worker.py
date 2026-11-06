"""Cross-camera ReID worker.

Reads FaceCandidates from the same `vms.detections` stream as the match
worker, but joins a separate consumer group (`reid-workers`) so it sees
every candidate independently. For each candidate we:

  1. Search the appearance Qdrant collection for similar embeddings within
     the configured time window, excluding same-camera intra-track noise.
  2. For each cosine-match above threshold, emit a `track_links` row
     binding the two appearances. Idempotent on the (a, b) pair so
     duplicate emissions are no-ops.

This worker is best-effort: dropped candidates produce no link but do not
break correctness — the next candidate from camera B will still find the
appearance from camera A as long as it's still within the window. The
worker therefore acks aggressively on processing failure (after logging),
relying on the redundancy of multi-frame fusion to give us another chance.

For Phase 2 this stays single-process; horizontal scale comes free (just
launch more workers in the same `reid-workers` group).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import os
import signal
import socket
import time
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.config import settings
from vms_face.core.logging import configure_logging, get_logger
from vms_face.core.tracing import (
    init_tracing,
    instrument_redis,
    instrument_sqlalchemy,
    shutdown_tracing,
)
from vms_face.core.metrics import (
    REID_LATENCY,
    REID_LINKS_EMITTED,
    REID_PROCESSED,
    WORKER_ALIVE,
)
from vms_face.core.system_metrics import run_system_metrics
from vms_face.domain.schemas import FaceCandidate
from vms_face.infra.postgres import session_scope
from vms_face.infra.qdrant import get_qdrant_appearance
from vms_face.infra.redis_bus import get_bus
from vms_face.services.reid import (
    emit_track_link,
    find_cross_camera_matches,
    lookup_recent_event_id,
)

log = get_logger(__name__)


def _consumer_name() -> str:
    return f"reid-{socket.gethostname()}-{os.getpid()}"


async def _process_candidate(
    payload: dict,
    *,
    consumer: str,
) -> None:
    t0 = time.perf_counter()
    try:
        candidate = FaceCandidate.model_validate(payload)
    except Exception as e:
        log.warning("reid: malformed candidate", err=str(e))
        REID_PROCESSED.labels(consumer=consumer, outcome="error").inc()
        return

    appearance = get_qdrant_appearance()
    try:
        hits = await find_cross_camera_matches(
            appearance,
            tenant_id=candidate.tenant_id,
            embedding=candidate.embedding,
            camera_id=candidate.camera_id,
            occurred_at=candidate.occurred_at,
        )
    except Exception as e:
        log.warning("reid: appearance search failed", err=str(e))
        REID_PROCESSED.labels(consumer=consumer, outcome="error").inc()
        REID_LATENCY.observe(time.perf_counter() - t0)
        return

    if not hits:
        REID_PROCESSED.labels(consumer=consumer, outcome="nomatch").inc()
        REID_LATENCY.observe(time.perf_counter() - t0)
        return

    new_links = 0
    async with session_scope() as session:  # type: AsyncSession
        # Resolve the current candidate's event_id (best effort — the match
        # worker may not have written it yet, in which case we leave None).
        b_event_id = await lookup_recent_event_id(
            session,
            tenant_id=candidate.tenant_id,
            camera_id=candidate.camera_id,
            track_id=candidate.track_id,
            around=candidate.occurred_at,
        )
        for h in hits:
            payload_h = h["payload"] or {}
            cand_camera = payload_h.get("camera_id")
            cand_track = payload_h.get("track_id")
            cand_event = payload_h.get("event_id")
            cand_ts = payload_h.get("occurred_at")
            if not cand_camera or not cand_track or not cand_ts:
                continue
            try:
                a_camera_id = uuid.UUID(cand_camera)
                a_event_id = uuid.UUID(cand_event) if cand_event else None
                a_occurred_at = dt.datetime.fromisoformat(cand_ts)
            except Exception:
                continue
            try:
                created = await emit_track_link(
                    session,
                    tenant_id=candidate.tenant_id,
                    a_track_id=str(cand_track),
                    a_camera_id=a_camera_id,
                    a_event_id=a_event_id,
                    a_occurred_at=a_occurred_at,
                    b_track_id=candidate.track_id,
                    b_camera_id=candidate.camera_id,
                    b_event_id=b_event_id,
                    b_occurred_at=candidate.occurred_at,
                    similarity=h["score"],
                    metadata={"point_id": str(h["point_id"])},
                )
            except Exception as e:
                log.warning("reid: emit_track_link failed", err=str(e))
                continue
            if created:
                new_links += 1

    if new_links:
        REID_LINKS_EMITTED.labels(consumer=consumer).inc(new_links)
        REID_PROCESSED.labels(consumer=consumer, outcome="matched").inc()
    else:
        REID_PROCESSED.labels(consumer=consumer, outcome="nomatch").inc()
    REID_LATENCY.observe(time.perf_counter() - t0)


async def _heartbeat(stop: asyncio.Event) -> None:
    host = socket.gethostname()
    while not stop.is_set():
        WORKER_ALIVE.labels(component="reid-worker", host=host).set(1)
        try:
            await asyncio.wait_for(stop.wait(), timeout=10.0)
        except asyncio.TimeoutError:
            continue
    WORKER_ALIVE.labels(component="reid-worker", host=host).set(0)


async def run_worker(stop: asyncio.Event | None = None) -> None:
    configure_logging()
    init_tracing("reid-worker")
    instrument_redis()
    from vms_face.infra.postgres import get_engine
    instrument_sqlalchemy(get_engine())
    if not settings.reid_worker_enabled:
        log.info("reid worker disabled by config")
        return

    consumer = _consumer_name()
    log.info(
        "reid worker starting",
        consumer=consumer,
        window_sec=settings.reid_window_sec,
        threshold=settings.reid_min_similarity,
    )

    if stop is None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                signal.signal(sig, lambda *_: stop.set())

    bus = get_bus()
    appearance = get_qdrant_appearance()
    await appearance.ensure_collection()

    sysmetrics_task = asyncio.create_task(run_system_metrics(stop), name="reid-sysmetrics")
    heartbeat_task = asyncio.create_task(_heartbeat(stop), name="reid-heartbeat")

    inflight: set[asyncio.Task] = set()
    sem = asyncio.Semaphore(max(1, int(settings.match_worker_concurrency)))

    async def _safe(entry_id: str, payload: dict) -> None:
        async with sem:
            try:
                await _process_candidate(payload, consumer=consumer)
            finally:
                try:
                    await bus.ack_for(settings.reid_consumer_group, entry_id)
                except Exception as e:
                    log.warning("reid: ack failed", entry_id=entry_id, err=str(e))

    try:
        async for entry_id, payload in bus.consume_detections_as(
            settings.reid_consumer_group, consumer
        ):
            if stop.is_set():
                break
            t = asyncio.create_task(_safe(entry_id, payload))
            inflight.add(t)
            t.add_done_callback(inflight.discard)
    finally:
        log.info("reid worker draining", inflight=len(inflight))
        if inflight:
            await asyncio.gather(*inflight, return_exceptions=True)
        for t in (sysmetrics_task, heartbeat_task):
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        await appearance.close()
        await bus.close()
        shutdown_tracing()
        log.info("reid worker stopped")


if __name__ == "__main__":
    asyncio.run(run_worker())
