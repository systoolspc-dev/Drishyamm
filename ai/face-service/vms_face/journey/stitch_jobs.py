"""Redis job-state (plain JSON string) + RQ enqueue for stitch jobs.

Ported from person-tracker/app/infra/redis_client.py. Plain redis (async for
API routes, sync for the RQ worker) — NOT RedisBus, which is stream-only and has
no per-job status/result semantics. Job state is the ephemeral render progress;
the durable record is the Postgres Journey row written at the end of the job.

Corrections vs source: key prefix `vms:journey:stitch:job:`, queue name from
settings.stitch_queue_name, callable path `vms_face.workers.stitch_worker.process_job`,
job_timeout from settings.stitch_job_timeout_sec.
"""
from __future__ import annotations

import datetime as dt
import json
import uuid
from typing import Any

import redis as syncredis
import redis.asyncio as aioredis
from rq import Queue

from vms_face.config import settings

_sync: syncredis.Redis | None = None
_async: aioredis.Redis | None = None


def _get_sync() -> syncredis.Redis:
    global _sync
    if _sync is None:
        _sync = syncredis.from_url(settings.redis_url)
    return _sync


def _get_async() -> aioredis.Redis:
    global _async
    if _async is None:
        _async = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _async


def _key(job_id: uuid.UUID) -> str:
    return f"vms:journey:stitch:job:{job_id}"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


async def create_job(job_id: uuid.UUID, request_payload: dict[str, Any]) -> None:
    """Write the queued job hash and enqueue the render on RQ. request_payload
    MUST already carry tenant_id + created_by (the route stamps them)."""
    payload = {
        "job_id": str(job_id),
        "status": "queued",
        "progress": 0.0,
        "message": None,
        "video_url": None,
        "video_key": None,
        "report_url": None,
        "map_url": None,
        "journey_id": None,
        "failed_reason": None,
        "created_at": _now(),
        "updated_at": _now(),
        "request": json.dumps(request_payload),
    }
    await _get_async().set(_key(job_id), json.dumps(payload))
    q = Queue(settings.stitch_queue_name, connection=_get_sync())
    q.enqueue(
        "vms_face.workers.stitch_worker.process_job",
        str(job_id),
        job_timeout=settings.stitch_job_timeout_sec,
    )


async def get_job(job_id: uuid.UUID) -> dict | None:
    raw = await _get_async().get(_key(job_id))
    return json.loads(raw) if raw is not None else None


async def update_job(job_id: uuid.UUID, **fields: Any) -> None:
    raw = await _get_async().get(_key(job_id))
    if raw is None:
        return
    job = json.loads(raw)
    job.update(fields)
    job["updated_at"] = _now()
    await _get_async().set(_key(job_id), json.dumps(job))


# Sync variants for the RQ worker (runs outside an event loop).
def get_job_sync(job_id: uuid.UUID) -> dict | None:
    raw = _get_sync().get(_key(job_id))
    if raw is None:
        return None
    return json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))


def update_job_sync(job_id: uuid.UUID, **fields: Any) -> None:
    raw = _get_sync().get(_key(job_id))
    if raw is None:
        return
    job = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
    job.update(fields)
    job["updated_at"] = _now()
    _get_sync().set(_key(job_id), json.dumps(job))
