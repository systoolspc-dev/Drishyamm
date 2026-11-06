"""Background task running inside the API process: tails the Redis alerts
stream emitted by match workers and patches person names into the
`LatestDetectionCache`. The orchestrator's per-frame writes pick up the
patched names and the AiFeed UI shows green named boxes once a track is
identified.

This is decoupled from the match worker process — the API only consumes
alerts, never produces them, so multiple API replicas + multiple match
workers can run side by side.
"""
from __future__ import annotations

import asyncio
import json

from redis.asyncio.client import Redis

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.infra.detection_cache import get_detection_cache
from vms_face.infra.redis_bus import get_bus

log = get_logger(__name__)


async def run_alerts_subscriber(stop: asyncio.Event) -> None:
    cache = get_detection_cache()
    bus = get_bus()
    client: Redis = bus.client

    last_id = "$"   # tail from now; we don't replay backlog
    log.info("alerts subscriber starting", stream=settings.redis_stream_alerts)

    while not stop.is_set():
        try:
            resp = await client.xread(
                {settings.redis_stream_alerts: last_id},
                count=64,
                block=2000,
            )
        except Exception as e:
            log.warning("alerts subscriber xread failed", err=str(e))
            await asyncio.sleep(1.0)
            continue

        if not resp:
            continue
        for _stream, entries in resp:
            for entry_id, fields in entries:
                last_id = entry_id
                try:
                    payload = json.loads(fields["data"])
                except Exception:
                    continue
                camera_id = payload.get("camera_id")
                track_id = payload.get("track_id")
                if not camera_id or not track_id:
                    continue

                name = payload.get("person_name") or "Unknown"
                conf = payload.get("similarity")
                try:
                    conf_f = float(conf) if conf is not None else None
                except (TypeError, ValueError):
                    conf_f = None
                await cache.patch_name(
                    str(camera_id),
                    str(track_id),
                    name=str(name),
                    conf=conf_f,
                )

    log.info("alerts subscriber stopped")
