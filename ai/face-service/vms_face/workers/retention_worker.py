"""Retention worker — DPDP Act 2023 compliance.

Periodically deletes:
  * `detection_events` rows older than `retention_event_days`.
  * MinIO snapshots older than `retention_snapshot_days` (excluding
    `flagged=true` events; we don't yet wire this flag, but the worker
    is structured so the future hook is a one-line filter change).
  * `audit_log` rows older than `retention_audit_log_days`.
  * Appearance Qdrant points older than `retention_event_days` (best-effort
    via Qdrant's range delete on `occurred_at_ts`).

Idempotent. Safe to run as a singleton (intra-cluster locking via Postgres
advisory lock would be added in Phase 4 K8s; for now we expect one
replica). Run as:

    python -m vms_face.workers.retention_worker
"""
from __future__ import annotations

import asyncio
import datetime as dt
import signal

from sqlalchemy import delete

from vms_face.config import settings
from vms_face.core.logging import configure_logging, get_logger
from vms_face.core.metrics import RETENTION_DELETED, WORKER_ALIVE
from vms_face.core.tracing import (
    init_tracing,
    instrument_sqlalchemy,
    shutdown_tracing,
)
from vms_face.domain.models import AuditLog, DetectionEvent
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.postgres import session_scope
from vms_face.infra.qdrant import get_qdrant_appearance

log = get_logger(__name__)


async def _prune_detection_events(now: dt.datetime) -> int:
    cutoff = now - dt.timedelta(days=settings.retention_event_days)
    async with session_scope() as session:
        result = await session.execute(
            delete(DetectionEvent).where(DetectionEvent.occurred_at < cutoff)
        )
    deleted = int(result.rowcount or 0)
    if deleted:
        RETENTION_DELETED.labels(target="detection_events").inc(deleted)
        log.info("retention: pruned detection_events", deleted=deleted, cutoff=cutoff.isoformat())
    return deleted


async def _prune_audit_log(now: dt.datetime) -> int:
    cutoff = now - dt.timedelta(days=settings.retention_audit_log_days)
    async with session_scope() as session:
        result = await session.execute(delete(AuditLog).where(AuditLog.occurred_at < cutoff))
    deleted = int(result.rowcount or 0)
    if deleted:
        RETENTION_DELETED.labels(target="audit_log").inc(deleted)
        log.info("retention: pruned audit_log", deleted=deleted, cutoff=cutoff.isoformat())
    return deleted


async def _prune_appearance_qdrant(now: dt.datetime) -> int:
    cutoff = now - dt.timedelta(days=settings.retention_event_days)
    appearance = get_qdrant_appearance()
    try:
        await appearance.delete_older_than(cutoff)
    except Exception as e:
        log.warning("retention: appearance qdrant prune failed", err=str(e))
        return 0
    RETENTION_DELETED.labels(target="appearance_qdrant").inc()
    return 1


def _prune_minio_snapshots_blocking(now: dt.datetime) -> int:
    """Recursive prune in the snapshots bucket. We rely on the deterministic
    `{tenant}/{camera}/{track}/{YYYYMMDDTHHMMSS}_{rand}.jpg` key shape we
    write in the orchestrator — not parsing the date from the key itself
    but using the object's last_modified time which MinIO sets on PUT."""
    objects = get_object_store()
    cutoff = now - dt.timedelta(days=settings.retention_snapshot_days)
    deleted = 0
    try:
        # Direct minio client access; ObjectStore doesn't expose list/delete.
        from minio.deleteobjects import DeleteObject  # type: ignore

        client = objects._client  # noqa: SLF001 — internal access acceptable here
        bucket = settings.minio_bucket_snapshots
        if not client.bucket_exists(bucket):
            return 0
        cutoff_aware = cutoff if cutoff.tzinfo else cutoff.replace(tzinfo=dt.timezone.utc)
        to_delete = []
        for obj in client.list_objects(bucket, recursive=True):
            modified = obj.last_modified
            if modified is None:
                continue
            if modified.tzinfo is None:
                modified = modified.replace(tzinfo=dt.timezone.utc)
            if modified < cutoff_aware:
                to_delete.append(DeleteObject(obj.object_name))
            if len(to_delete) >= 1000:
                errors = list(client.remove_objects(bucket, to_delete))
                deleted += len(to_delete) - len(errors)
                to_delete = []
        if to_delete:
            errors = list(client.remove_objects(bucket, to_delete))
            deleted += len(to_delete) - len(errors)
    except Exception as e:
        log.warning("retention: minio prune failed", err=str(e))
        return 0
    return deleted


async def _prune_minio_snapshots(now: dt.datetime) -> int:
    loop = asyncio.get_running_loop()
    deleted = await loop.run_in_executor(None, _prune_minio_snapshots_blocking, now)
    if deleted:
        RETENTION_DELETED.labels(target="snapshots").inc(deleted)
        log.info("retention: pruned snapshots", deleted=deleted)
    return deleted


async def _tick() -> None:
    now = dt.datetime.now(dt.timezone.utc)
    log.info("retention sweep starting", at=now.isoformat())
    try:
        await _prune_detection_events(now)
    except Exception as e:
        log.warning("retention: detection_events failed", err=str(e))
    try:
        await _prune_audit_log(now)
    except Exception as e:
        log.warning("retention: audit_log failed", err=str(e))
    try:
        await _prune_appearance_qdrant(now)
    except Exception as e:
        log.warning("retention: appearance qdrant failed", err=str(e))
    try:
        await _prune_minio_snapshots(now)
    except Exception as e:
        log.warning("retention: minio failed", err=str(e))
    log.info("retention sweep done")


async def run_retention_worker(stop: asyncio.Event | None = None) -> None:
    configure_logging()
    init_tracing("retention-worker")
    from vms_face.infra.postgres import get_engine
    instrument_sqlalchemy(get_engine())
    if not settings.retention_worker_enabled:
        log.info("retention worker disabled by config")
        return
    if stop is None:
        stop = asyncio.Event()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                signal.signal(sig, lambda *_: stop.set())

    interval = max(60.0, float(settings.retention_worker_interval_sec))
    log.info("retention worker started", interval_sec=interval)
    import socket as _socket
    host = _socket.gethostname()
    WORKER_ALIVE.labels(component="retention-worker", host=host).set(1)
    try:
        # First sweep happens on startup so deployments don't sit unpruned
        # waiting for the first interval to elapse.
        while not stop.is_set():
            try:
                await _tick()
            except Exception as e:
                log.warning("retention tick failed", err=str(e))
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except asyncio.TimeoutError:
                continue
    finally:
        WORKER_ALIVE.labels(component="retention-worker", host=host).set(0)
        shutdown_tracing()
        log.info("retention worker stopped")


if __name__ == "__main__":
    asyncio.run(run_retention_worker())
