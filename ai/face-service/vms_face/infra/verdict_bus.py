"""Verdict router: match-worker answers back to the orchestrator that owns the track.

The orchestrator publishes a FaceCandidate and, until now, never heard what
the match worker decided — names reached the overlay only through the API
process's alerts subscriber. The identity latch needs the answer at the
source, so it can stop embedding and stop querying for a track it has
identified.

    match worker ──PUBLISH vms.verdict:{camera_id}──▶ VerdictRouter ──▶ orchestrator.on_verdict()

One router per process (whatever hosts orchestrators — the API process in
the co-located deployment, or `run_stream.py`), one PSUBSCRIBE, dispatch by
`camera_id`. Orchestrators register on start and unregister on stop. A verdict
for a camera nobody here owns is ignored — another process owns it.

Best-effort by design. Redis pub/sub does not replay; a dropped message just
means the latch asks again on its next timer tick.
"""
from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Awaitable, Callable

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.infra.redis_bus import get_bus

log = get_logger(__name__)

Handler = Callable[[dict[str, Any]], Awaitable[None]]


class VerdictRouter:
    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    # ── registration ───────────────────────────────────────────────────────

    def register(self, camera_id: str, handler: Handler) -> None:
        self._handlers[str(camera_id)] = handler
        self._ensure_started()

    def unregister(self, camera_id: str) -> None:
        self._handlers.pop(str(camera_id), None)

    @property
    def cameras(self) -> list[str]:
        return list(self._handlers.keys())

    # ── lifecycle ──────────────────────────────────────────────────────────

    def _ensure_started(self) -> None:
        if self._task is not None and not self._task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            log.warning("verdict router: no running loop; will start on next register")
            return
        self._stop.clear()
        self._task = loop.create_task(self._run(), name="verdict-router")

    async def aclose(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run(self) -> None:
        pattern = f"{settings.redis_verdict_channel}:*"
        backoff = 0.5
        while not self._stop.is_set():
            bus = get_bus()
            pubsub = bus.client.pubsub()
            try:
                await pubsub.psubscribe(pattern)
                log.info("verdict router started", pattern=pattern)
                backoff = 0.5
                while not self._stop.is_set():
                    msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                    if msg is None:
                        continue
                    try:
                        payload = json.loads(msg.get("data") or "")
                    except Exception:
                        continue
                    handler = self._handlers.get(str(payload.get("camera_id", "")))
                    if handler is None:
                        continue
                    try:
                        await handler(payload)
                    except Exception as e:  # noqa: BLE001 — one bad verdict must not kill the router
                        log.warning("verdict handler failed", err=str(e), camera_id=payload.get("camera_id"))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("verdict router pubsub error; reconnecting", err=str(e), backoff=backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)
            finally:
                try:
                    await pubsub.punsubscribe(pattern)
                except Exception:
                    pass
                try:
                    await pubsub.aclose()
                except Exception:
                    try:
                        await pubsub.close()
                    except Exception:
                        pass
        log.info("verdict router stopped")


_lock = threading.Lock()
_router: VerdictRouter | None = None


def get_verdict_router() -> VerdictRouter:
    global _router
    if _router is None:
        with _lock:
            if _router is None:
                _router = VerdictRouter()
    return _router
