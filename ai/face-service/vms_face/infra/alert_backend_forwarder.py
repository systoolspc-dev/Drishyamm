"""Persisted-alert bridge: `vms.alerts` stream → backend /api/internal/ai/events.

The match worker XADDs one message to `vms.alerts` for EVERY detection
(match / unknown / blacklist-alert). This forwarder consumes that stream and
POSTs only the MEANINGFUL ones to the main VMS backend as persisted ai_events,
which the backend turns into an in-app alert + a phone push:

    match worker  --XADD vms.alerts-->  (this)  --POST /ai/events-->  backend
                                                  backend → ai_events + push

What is forwarded (product decision 2026-07-09):
    kind == "alert"    → watchlist / blacklist hit   → severity "critical"
    kind == "unknown"  → unrecognised person         → severity "warning"
Routine recognised faces (kind == "match") are NOT forwarded — they ride the
ephemeral overlay channel (see backend_forwarder.py) and must never become
alerts. Persisting a row per recognised face is exactly what flooded the alerts
panel once.

Anti-flood: a per-(user, camera, kind, subject) cooldown means a person standing
in view creates ONE ai_events row, not one per frame. The backend ALSO dedups
the push; this dedups the persisted row so the alerts list stays clean. This is
the same split-brain-safe rule as the overlay throttle, applied to persistence.

Mapping / auth are identical to backend_forwarder.py:
    - `camera_code` in the alert payload IS the backend's `monitorId`.
    - `/api/internal/cameras` (service-token auth) returns `{monitorId, userId}`.
    - Auth via `X-Service-Token: <SERVICE_TOKEN>`.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.infra.redis_bus import get_bus

log = get_logger(__name__)

# kind -> (backend eventType, severity). Only these kinds are forwarded.
_KIND_MAP: dict[str, tuple[str, str]] = {
    "alert": ("person.alert", "critical"),    # blacklist / watchlist hit
    "unknown": ("person.unknown", "warning"),  # unrecognised person
}

_GROUP = "backend-alert-forwarder"
_CONSUMER = "alert-fwd-1"


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
        out: dict[str, str] = {}
        for c in r.json().get("cameras", []) or []:
            mid, uid = c.get("monitorId"), c.get("userId")
            if mid and uid:
                out[str(mid)] = str(uid)
        return out
    except Exception as e:  # noqa: BLE001 — never let a refresh error kill the loop
        log.warning("alert-forwarder: camera map refresh failed", err=str(e))
        return {}


async def _post_event(
    client: httpx.AsyncClient, base: str, token: str, body: dict[str, Any]
) -> None:
    """POST one persisted alert. Best-effort — a failed POST drops one alert
    rather than blocking the stream."""
    try:
        r = await client.post(
            f"{base}/api/internal/ai/events",
            headers={"X-Service-Token": token},
            json=body,
            timeout=6.0,
        )
        if r.status_code >= 300:
            log.warning("alert-forwarder: event rejected",
                        status=r.status_code, body=r.text[:200])
    except Exception as e:  # noqa: BLE001
        log.warning("alert-forwarder: event POST failed", err=str(e))


def _build_body(p: dict[str, Any], user_id: str, event_type: str, severity: str) -> dict[str, Any]:
    kind = p.get("kind")
    return {
        "userId": user_id,
        "monitorId": str(p.get("camera_code")),
        "eventType": event_type,
        "severity": severity,
        "ts": p.get("occurred_at"),  # ISO string; backend does new Date(evt.ts)
        "bbox": p.get("bbox"),
        "trackId": p.get("track_id"),
        "confidence": p.get("similarity"),
        "payload": {
            "matchedName": p.get("person_name"),
            "personId": p.get("person_id"),
            "role": "blacklist" if kind == "alert" else None,
            "similarity": p.get("similarity"),
            "snapshotUri": p.get("snapshot_uri"),
            "kind": kind,
        },
    }


def _spatial_cell(bbox: Any, cell_px: int = 64) -> str | None:
    """Quantize a bbox foot-point (bottom-centre) to a coarse grid cell so a
    STATIONARY unknown maps to a stable dedup key across re-tracks — instead of
    the volatile track_id, which changes every time they move slightly (framework
    §2 rung R3). Returns None if the bbox is missing/invalid."""
    try:
        x1, y1, x2, y2 = (float(v) for v in list(bbox)[:4])
    except (TypeError, ValueError):
        return None
    cx = (x1 + x2) / 2.0
    fy = max(y1, y2)  # foot-point = bottom edge
    return f"cell:{int(cx // cell_px)}:{int(fy // cell_px)}"


async def run_alert_backend_forwarder(stop: asyncio.Event) -> None:
    """Background task: vms.alerts → POST /api/internal/ai/events. Started from
    the API lifespan next to run_backend_forwarder."""
    if not settings.backend_alert_forward_enabled:
        log.info("alert forwarder disabled (backend_alert_forward_enabled=false)")
        return
    if settings.cache_backend == "local":
        log.info("alert forwarder disabled (cache_backend=local, no Redis)")
        return

    base = (settings.backend_url or "").rstrip("/")
    token = settings.service_token or ""
    if not base or not token:
        log.warning("alert forwarder OFF: BACKEND_URL / SERVICE_TOKEN not set — "
                    "watchlist/unknown alerts will not reach the phone")
        return

    cooldown = float(settings.backend_alert_cooldown_sec)
    refresh_sec = float(settings.backend_forward_camera_refresh_sec)
    bus = get_bus()

    # dedup key -> monotonic expiry. Pruned when it grows large.
    seen: dict[str, float] = {}

    log.info("alert backend forwarder started",
             stream=settings.redis_stream_alerts, backend=base)
    try:
        async with httpx.AsyncClient() as client:
            cam_user = await _load_camera_user_map(client, base, token)
            last_refresh = time.monotonic()
            if not cam_user:
                log.warning("alert-forwarder: camera map empty on start (will retry)")

            async for entry_id, p in bus.consume_alerts_as(_GROUP, _CONSUMER):
                try:
                    now = time.monotonic()
                    if now - last_refresh >= refresh_sec:
                        fresh = await _load_camera_user_map(client, base, token)
                        if fresh:
                            cam_user = fresh
                        last_refresh = now

                    kind = str(p.get("kind") or "")
                    mapped = _KIND_MAP.get(kind)
                    if not mapped:
                        continue  # match / detection / health — not an alert

                    monitor_id = str(p.get("camera_code") or "")
                    if not monitor_id:
                        continue
                    user_id = cam_user.get(monitor_id)
                    if not user_id:
                        continue  # camera not yet in the map (new cam within refresh window)

                    # R1 stable identity, else R3 spatial cell (NEVER the volatile
                    # track_id — that re-tracks on slight movement and defeats dedup).
                    cell = _spatial_cell(p.get("bbox"), int(getattr(settings, "positional_dedup_cell_px", 64)))
                    subject = p.get("person_id") or cell or "unknown"
                    dkey = f"{user_id}:{monitor_id}:{kind}:{subject}"
                    exp = seen.get(dkey)
                    if exp and exp > now:
                        continue  # within cooldown — don't persist a duplicate row
                    if len(seen) > 4096:
                        seen = {k: v for k, v in seen.items() if v > now}
                    seen[dkey] = now + cooldown

                    event_type, severity = mapped
                    body = _build_body(p, user_id, event_type, severity)
                    await _post_event(client, base, token, body)
                finally:
                    await bus.ack_alert(_GROUP, entry_id)

                if stop.is_set():
                    break
    finally:
        log.info("alert backend forwarder stopped")
