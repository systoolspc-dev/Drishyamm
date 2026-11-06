"""Which cameras have someone watching the live overlay right now.

The VMS backend knows (every AIOverlay tells its socket `ai.watch`); the AI's
backend forwarder polls `GET /api/internal/ai/viewers` and mirrors the answer
into one Redis set, `vms:overlay:viewers`, with a short TTL. Every orchestrator
in every shard reads that set through this module — one fetch per process
per refresh period, shared by all its cameras — and publishes boxes at full
rate only for watched cameras.

Fail-open: if the set is missing (feed dead, feature off, Redis blip) every
camera counts as watched, so a fault degrades to today's behaviour, never to
a blank overlay. The forwarder always writes a sentinel member so an empty
viewer list is still a present key.
"""
from __future__ import annotations

import asyncio
import time

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)

SENTINEL = "_"

_watched: set[str] | None = None      # None = no feed -> fail open
_fetched_at: float = 0.0
_lock = asyncio.Lock()


async def _refresh() -> None:
    global _watched, _fetched_at
    from vms_face.infra.redis_bus import get_bus

    try:
        members = await get_bus().client.smembers(settings.overlay_viewers_key)
    except Exception as e:  # noqa: BLE001
        log.debug("overlay viewers: redis read failed; failing open", err=str(e))
        _watched = None
        _fetched_at = time.monotonic()
        return
    if not members:
        _watched = None                # key absent: feed is not alive
    else:
        _watched = {m.decode() if isinstance(m, bytes) else str(m) for m in members} - {SENTINEL}
    _fetched_at = time.monotonic()


async def is_watched(camera_code: str) -> bool:
    """True when a browser is drawing this camera's overlay, or when the
    viewer feed is unavailable (fail-open)."""
    if not settings.overlay_viewer_gating:
        return True
    if time.monotonic() - _fetched_at >= float(settings.overlay_viewers_poll_sec):
        async with _lock:
            if time.monotonic() - _fetched_at >= float(settings.overlay_viewers_poll_sec):
                await _refresh()
    if _watched is None:
        return True
    return camera_code in _watched


def snapshot() -> dict:
    return {"gating": bool(settings.overlay_viewer_gating), "watched": sorted(_watched) if _watched is not None else None,
            "age_s": round(time.monotonic() - _fetched_at, 1) if _fetched_at else None}
