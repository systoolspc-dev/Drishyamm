"""Detection-state pub/sub.

The orchestrator (per-camera processing loop) is the producer of "what's
visible right now" data. The API process is the consumer that fans this
state out to WebSocket clients (`AiFeed.jsx`). When both live in the same
Python process they can share an in-memory cache; when they live in
different processes (the documented Phase 1 deployment with
`python -m vms_face.pipeline.run_stream`) they cannot.

We solve this with a uniform Redis-backed contract:

  Publisher (orchestrator side)
    StatePublisher.write_frame(camera_id, payload)
      → SETEX  vms:cam:state:{id}     (TTL = redis_cam_state_ttl_sec)
      → PUBLISH vms.cam.state:{id}    (live overlay subscribers)

  Subscriber (API side)
    StateSubscriber listens on PSUBSCRIBE vms.cam.state:* and forwards
    every message to the local LatestDetectionCache, which keeps existing
    WebSocket fan-out logic unchanged.

A "local" backend is also provided — same interface, no Redis hop —
for ease of single-process testing.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable, Protocol

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.infra.detection_cache import LatestDetectionCache, get_detection_cache
from vms_face.infra.redis_bus import RedisBus, get_bus

log = get_logger(__name__)


# ── Publisher protocol & implementations ──────────────────────────────────


class StatePublisher(Protocol):
    async def write_frame(
        self,
        camera_id: str,
        *,
        boxes: list[dict[str, Any]],
        frame_w: int,
        frame_h: int,
        running: bool = True,
        active_tracks: int = 0,
        persons_present: int = 0,
        camera_code: str = "",
    ) -> None: ...

    async def patch_name(
        self,
        camera_id: str,
        track_id: str,
        *,
        name: str,
        conf: float | None = None,
    ) -> None: ...

    async def mark_offline(self, camera_id: str) -> None: ...


class LocalStatePublisher:
    """Direct in-memory publisher. Use only when API + orchestrator share a
    process. Equivalent behavior to the legacy code path."""

    def __init__(self, cache: LatestDetectionCache | None = None) -> None:
        self._cache = cache or get_detection_cache()

    async def write_frame(self, camera_id, *, boxes, frame_w, frame_h, running=True, active_tracks=0, persons_present=0, camera_code=""):
        # camera_code is only needed by the cross-process Redis payload (the
        # backend forwarder maps it to monitorId). The local cache keys on
        # camera_id, so it's ignored here.
        await self._cache.write_frame(
            camera_id,
            boxes=boxes,
            frame_w=frame_w,
            frame_h=frame_h,
            running=running,
            active_tracks=active_tracks,
            persons_present=persons_present,
        )

    async def patch_name(self, camera_id, track_id, *, name, conf=None):
        await self._cache.patch_name(camera_id, track_id, name=name, conf=conf)

    async def mark_offline(self, camera_id):
        await self._cache.mark_offline(camera_id)


class RedisStatePublisher:
    """Cross-process publisher. Persists last snapshot in a SETEX'd key (so a
    late subscriber can resync) and PUBLISHes it on a per-camera channel."""

    EVENT_FRAME = "frame"
    EVENT_PATCH_NAME = "patch_name"
    EVENT_OFFLINE = "offline"

    def __init__(self, bus: RedisBus | None = None) -> None:
        self._bus = bus or get_bus()

    async def write_frame(self, camera_id, *, boxes, frame_w, frame_h, running=True, active_tracks=0, persons_present=0, camera_code=""):
        payload = {
            "event": self.EVENT_FRAME,
            "camera_id": str(camera_id),
            # camera_code == the backend's monitorId. Carried so the backend
            # forwarder can POST /api/internal/ai/events without a DB lookup.
            "camera_code": str(camera_code or ""),
            "boxes": boxes,
            "frame_w": int(frame_w),
            "frame_h": int(frame_h),
            "running": bool(running),
            "active_tracks": int(active_tracks),
            "persons_present": int(persons_present),
        }
        await self._bus.publish_cam_state(str(camera_id), payload)

    async def patch_name(self, camera_id, track_id, *, name, conf=None):
        payload = {
            "event": self.EVENT_PATCH_NAME,
            "camera_id": str(camera_id),
            "track_id": str(track_id),
            "name": str(name),
            "conf": float(conf) if conf is not None else None,
        }
        # patch_name is an event, not a snapshot — publish without rewriting
        # the cached snapshot.
        await self._bus.client.publish(
            self._bus.cam_state_channel(str(camera_id)),
            json.dumps(payload, default=str),
        )

    async def mark_offline(self, camera_id):
        payload = {
            "event": self.EVENT_OFFLINE,
            "camera_id": str(camera_id),
            "running": False,
        }
        await self._bus.client.publish(
            self._bus.cam_state_channel(str(camera_id)),
            json.dumps(payload, default=str),
        )
        await self._bus.clear_cam_state(str(camera_id))


def get_state_publisher() -> StatePublisher:
    if settings.cache_backend == "local":
        return LocalStatePublisher()
    return RedisStatePublisher()


# ── Subscriber: forwards Redis messages into the local LatestDetectionCache.


_PATTERN = settings.redis_cam_state_channel + ":*"


async def run_cam_state_subscriber(
    stop: asyncio.Event,
    *,
    cache: LatestDetectionCache | None = None,
    on_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> None:
    """Background task running inside the API process. PSUBSCRIBES to all
    `vms.cam.state:*` channels and routes events into the local cache, which
    drives the WebSocket fan-out the legacy AiFeed page consumes."""
    if settings.cache_backend == "local":
        log.info("cam-state subscriber disabled (cache_backend=local)")
        return

    cache = cache or get_detection_cache()
    bus = get_bus()
    pubsub = bus.client.pubsub()
    await pubsub.psubscribe(_PATTERN)
    log.info("cam-state subscriber started", pattern=_PATTERN)
    try:
        while not stop.is_set():
            try:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            except Exception as e:
                log.warning("cam-state pubsub error", err=str(e))
                await asyncio.sleep(0.5)
                continue
            if msg is None:
                continue
            try:
                payload = json.loads(msg.get("data") or "")
            except Exception:
                continue
            kind = payload.get("event")
            cam_id = str(payload.get("camera_id", ""))
            if not cam_id:
                continue
            try:
                if kind == RedisStatePublisher.EVENT_FRAME:
                    await cache.write_frame(
                        cam_id,
                        boxes=list(payload.get("boxes") or []),
                        frame_w=int(payload.get("frame_w") or 0),
                        frame_h=int(payload.get("frame_h") or 0),
                        running=bool(payload.get("running", True)),
                        active_tracks=int(payload.get("active_tracks") or 0),
                        persons_present=int(payload.get("persons_present") or 0),
                    )
                elif kind == RedisStatePublisher.EVENT_PATCH_NAME:
                    track_id = str(payload.get("track_id", ""))
                    name = str(payload.get("name", "Unknown"))
                    conf = payload.get("conf")
                    await cache.patch_name(cam_id, track_id, name=name, conf=conf)
                elif kind == RedisStatePublisher.EVENT_OFFLINE:
                    await cache.mark_offline(cam_id)
            except Exception as e:
                log.warning("cam-state apply failed", err=str(e), event=kind, camera_id=cam_id)
            if on_event is not None:
                try:
                    await on_event(payload)
                except Exception:
                    pass
    finally:
        try:
            await pubsub.punsubscribe(_PATTERN)
        except Exception:
            pass
        try:
            await pubsub.aclose()
        except Exception:
            try:
                await pubsub.close()
            except Exception:
                pass
        log.info("cam-state subscriber stopped")
