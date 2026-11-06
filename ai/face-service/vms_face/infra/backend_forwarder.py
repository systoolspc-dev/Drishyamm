"""Backend live-overlay bridge.

Why this exists
---------------
vms_face detects faces and publishes per-frame bounding boxes to Redis
(`vms.cam.state:*`) for its own legacy AiFeed page. The main VMS backend + React
player draw their live boxes from a different channel: the backend fans out a
socket event to the viewing user, and `AIOverlay.jsx` renders it. Nothing in
vms_face fed that channel, so no box ever reached the player even though
detection was healthy.

This module is that bridge. Crucially it feeds the **ephemeral** overlay path,
NOT the persisted events path:

    AI  --POST /api/internal/ai/overlay-->  backend
    backend  --emit socket.io 'ai.live'-->  AIOverlay.jsx  (draws boxes, no DB)

An earlier version POSTed one persisted `ai_events` row per box, which flooded
the alerts panel with "warning" rows. Live overlay boxes are display-only and
must never become alerts, so we send one throwaway whole-frame message per
camera at a modest rate. Meaningful, persisted events (watchlist hits, etc.)
are a separate concern handled by the AI's own recognition pipeline.

Mapping / auth
--------------
- `camera_code` in the cam-state payload IS the backend's `monitorId`.
- `/api/internal/cameras` (service-token auth) returns `{monitorId, userId}`.
- Auth via `X-Service-Token: <SERVICE_TOKEN>`.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx
from prometheus_client import Histogram

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.infra.redis_bus import get_bus

log = get_logger(__name__)

_STATE_CODE = {"unknown": "u", "provisional": "p", "confirmed": "c"}
_bytes_stat = [0, 0, 0.0]   # bytes, frames, last log (monotonic)
OVERLAY_FRAME_BYTES = Histogram(
    "vms_overlay_frame_bytes", "Bytes per overlay frame POSTed to the backend",
    buckets=(64, 128, 256, 384, 512, 768, 1024, 2048, 4096),
)

_PATTERN = settings.redis_cam_state_channel + ":*"


def _track_id(v: Any) -> str | None:
    """Track id as the opaque string it actually is.

    Tracker ids look like "t00000047" (FaceTracker.track_id is a str), so the
    previous int() coercion raised ValueError on EVERY real id and silently
    yielded None. The overlay therefore received trackId=null for every box,
    which cost the UI its only stable identity for a face: without it the client
    falls back to array position, and because emitted box order is not stable
    between frames, one box's DOM node gets reused for a different person — the
    box visibly jumps across the frame.

    The persisted path already learned this (AIEvent.trackId is STRING(64),
    migrated after integer inserts 500'd); this ephemeral path kept the
    coercion. Pass the id through untouched.
    """
    if v is None:
        return None
    s = str(v)
    return s[:64] if s else None


async def _load_camera_user_map(
    client: httpx.AsyncClient, base: str, token: str
) -> dict[str, str]:
    """monitorId (camera_code) -> userId, from /api/internal/cameras."""
    try:
        r = await client.get(
            f"{base}/api/internal/cameras",
            headers={"X-Service-Token": token},
            timeout=10.0,
        )
        r.raise_for_status()
        data = r.json()
        out: dict[str, str] = {}
        for c in data.get("cameras", []) or []:
            mid = c.get("monitorId")
            uid = c.get("userId")
            if mid and uid:
                out[str(mid)] = str(uid)
        return out
    except Exception as e:  # noqa: BLE001 — never let a refresh error kill the loop
        log.warning("forwarder: camera map refresh failed", err=str(e))
        return {}


async def _load_viewers(
    client: httpx.AsyncClient, base: str, token: str
) -> list[str] | None:
    """monitorIds with a browser drawing the overlay right now, or None when
    the backend could not answer (callers then leave the last set alone)."""
    try:
        r = await client.get(
            f"{base}/api/internal/ai/viewers",
            headers={"X-Service-Token": token, "Authorization": f"Bearer {token}"},
            timeout=5.0,
        )
        if r.status_code != 200:
            return None
        ids = (r.json() or {}).get("monitorIds") or []
        return [str(x) for x in ids]
    except Exception:  # noqa: BLE001
        return None


async def _publish_viewers(bus, monitor_ids: list[str]) -> None:
    """Mirror the watched set into Redis for every orchestrator in every shard.
    The sentinel keeps the key present when nobody is watching, so an empty
    list is distinguishable from a dead feed (services/overlay_viewers.py)."""
    from vms_face.services.overlay_viewers import SENTINEL
    key = settings.overlay_viewers_key
    pipe = bus.client.pipeline()
    pipe.delete(key)
    pipe.sadd(key, SENTINEL, *monitor_ids)
    pipe.expire(key, int(settings.overlay_viewers_ttl_sec))
    await pipe.execute()


async def _post_overlay(
    client: httpx.AsyncClient, base: str, token: str, body: dict[str, Any]
) -> None:
    """Fire one ephemeral overlay frame. Best-effort — the overlay tolerates
    dropped frames, so a failed POST just means one skipped update."""
    try:
        r = await client.post(
            f"{base}/api/internal/ai/overlay",
            headers={"X-Service-Token": token},
            json=body,
            timeout=5.0,
        )
        if r.status_code >= 300:
            log.warning(
                "forwarder: overlay rejected", status=r.status_code, body=r.text[:200]
            )
    except Exception as e:  # noqa: BLE001
        log.warning("forwarder: overlay POST failed", err=str(e))


async def run_backend_forwarder(stop: asyncio.Event) -> None:
    """Background task: cam-state boxes -> POST /api/internal/ai/overlay. Started
    from the API lifespan next to the cam-state subscriber."""
    if not settings.backend_forward_enabled:
        log.info("backend forwarder disabled (backend_forward_enabled=false)")
        return
    if settings.cache_backend == "local":
        log.info("backend forwarder disabled (cache_backend=local, no Redis)")
        return

    base = (settings.backend_url or "").rstrip("/")
    token = settings.service_token or ""
    if not base or not token:
        log.warning(
            "backend forwarder OFF: BACKEND_URL / SERVICE_TOKEN not set — "
            "the live overlay will have no boxes"
        )
        return

    min_gap = float(settings.backend_overlay_min_interval_sec)
    refresh_sec = float(settings.backend_forward_camera_refresh_sec)
    max_boxes = int(settings.backend_forward_max_boxes_per_frame)
    min_gconf = float(settings.backend_overlay_min_gender_conf)

    bus = get_bus()
    pubsub = bus.client.pubsub()
    await pubsub.psubscribe(_PATTERN)

    # last overlay POST time (monotonic) per monitorId — the whole frame is
    # throttled as a unit, not per-track.
    last_sent: dict[str, float] = {}
    # so we can send a single "cleared" frame when a camera stops having boxes
    had_boxes: dict[str, bool] = {}
    # viewer gating: who is watching what, mirrored to Redis for the shards
    gating = bool(settings.overlay_viewer_gating)
    watched: set[str] | None = None
    last_viewers = 0.0
    viewers_every = float(settings.overlay_viewers_poll_sec)

    log.info("backend forwarder started (ephemeral overlay)", pattern=_PATTERN, backend=base)
    try:
        async with httpx.AsyncClient() as client:
            cam_user = await _load_camera_user_map(client, base, token)
            last_refresh = time.monotonic()
            if not cam_user:
                log.warning("forwarder: camera map empty on start (will retry)")

            while not stop.is_set():
                now = time.monotonic()
                if now - last_refresh >= refresh_sec:
                    fresh = await _load_camera_user_map(client, base, token)
                    if fresh:
                        cam_user = fresh
                    last_refresh = now
                if gating and now - last_viewers >= viewers_every:
                    ids = await _load_viewers(client, base, token)
                    last_viewers = now
                    if ids is not None:
                        watched = set(ids)
                        try:
                            await _publish_viewers(bus, ids)
                        except Exception as e:  # noqa: BLE001
                            log.debug("forwarder: viewers publish failed", err=str(e))

                try:
                    msg = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=1.0
                    )
                except Exception as e:  # noqa: BLE001
                    log.warning("forwarder pubsub error", err=str(e))
                    await asyncio.sleep(0.5)
                    continue
                if msg is None:
                    continue
                try:
                    payload = json.loads(msg.get("data") or "")
                except Exception:
                    continue
                if payload.get("event") != "frame":
                    continue

                monitor_id = str(payload.get("camera_code") or "")
                if not monitor_id:
                    continue
                user_id = cam_user.get(monitor_id)
                if not user_id:
                    continue
                # Nobody drawing this camera's overlay: the POST would be
                # thrown away by the browser side, so don't make it. (A None
                # `watched` means the feed is down — fail open and forward.)
                if gating and watched is not None and monitor_id not in watched:
                    had_boxes[monitor_id] = bool(payload.get("boxes"))
                    continue

                raw_boxes = payload.get("boxes") or []

                # Throttle per camera. A cleared frame (boxes just went empty)
                # is always allowed through once so the overlay wipes promptly.
                boxes_now = bool(raw_boxes)
                is_clear_edge = had_boxes.get(monitor_id, False) and not boxes_now
                if not is_clear_edge and now - last_sent.get(monitor_id, 0.0) < min_gap:
                    continue
                last_sent[monitor_id] = now
                had_boxes[monitor_id] = boxes_now

                out_boxes = []
                for box in raw_boxes[:max_boxes]:
                    x1, y1, x2, y2 = box.get("x1"), box.get("y1"), box.get("x2"), box.get("y2")
                    if None in (x1, y1, x2, y2):
                        continue
                    name = box.get("name")
                    # Gender only when the track vote is strongly agreed; age is
                    # never sent (unreliable on CCTV crops).
                    gconf = box.get("gender_conf")
                    gender = box.get("gender") if (gconf is not None and gconf >= min_gconf) else None
                    out_boxes.append({
                        "bbox": [float(x1), float(y1), float(x2), float(y2)],
                        "trackId": _track_id(box.get("track_id")),
                        "name": name,
                        "gender": gender,
                        "conf": (float(box["conf"]) if box.get("conf") is not None else None),
                        # Identity latch state so the player can render a
                        # provisional name differently from a confirmed one.
                        # "unknown" | "provisional" | "confirmed".
                        "identityState": box.get("identity_state") or "unknown",
                    })

                body = {
                    "userId": user_id,
                    "monitorId": monitor_id,
                    "ts": int(time.time() * 1000),
                    "frameW": int(payload.get("frame_w") or 0),
                    "frameH": int(payload.get("frame_h") or 0),
                }
                if settings.overlay_compact_frames:
                    body["v"] = 2
                    body["b"] = [
                        [b["trackId"], *(int(round(v)) for v in b["bbox"]),
                         (int(round(b["conf"] * 100)) if b.get("conf") is not None else None),
                         b.get("name"), b.get("gender"), _STATE_CODE.get(b.get("identityState"), "u")]
                        for b in out_boxes
                    ]
                else:
                    body["boxes"] = out_boxes
                nbytes = len(json.dumps(body, separators=(",", ":")))
                OVERLAY_FRAME_BYTES.observe(nbytes)
                _bytes_stat[0] += nbytes
                _bytes_stat[1] += 1
                if now - _bytes_stat[2] > 60.0 and _bytes_stat[1]:
                    log.info("overlay frames", frames=_bytes_stat[1], avg_bytes=int(_bytes_stat[0] / _bytes_stat[1]),
                             compact=bool(settings.overlay_compact_frames))
                    _bytes_stat[:] = [0, 0, now]
                asyncio.create_task(_post_overlay(client, base, token, body))
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
        log.info("backend forwarder stopped")
