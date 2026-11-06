from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.core.security import AuthError, Principal, decode_token, dev_bypass_allowed
from vms_face.infra.redis_bus import get_bus

router = APIRouter()
log = get_logger(__name__)


async def _ws_authenticate(websocket: WebSocket) -> Principal | None:
    """Resolve the principal for a WebSocket request. Browsers can't set the
    `Authorization` header on WS, so we accept the token via:
      1. `Sec-WebSocket-Protocol: bearer, <token>` (preferred), or
      2. `?token=<jwt>` query string fallback.
    Returns None and closes the socket on failure."""
    token: str | None = None
    proto = websocket.headers.get("sec-websocket-protocol")
    if proto:
        parts = [p.strip() for p in proto.split(",")]
        if len(parts) >= 2 and parts[0].lower() == "bearer":
            token = parts[1]
    if token is None:
        token = websocket.query_params.get("token")

    if not token:
        if dev_bypass_allowed():
            return None  # dev mode tolerates missing tokens
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="missing token")
        return None
    try:
        return decode_token(token)
    except AuthError as e:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason=str(e)[:120])
        return None


@router.websocket("/ws/alerts")
async def alerts_websocket(websocket: WebSocket) -> None:
    """Live fan-out of match-worker alerts.

    The match worker publishes onto redis_stream_alerts; this socket tails the
    stream and forwards each entry to every connected client filtered to the
    caller's tenant. For thousands of cameras you would also put a Redis
    Pub/Sub fanout in front to scale connections horizontally."""
    principal = await _ws_authenticate(websocket)
    if principal is None and not dev_bypass_allowed():
        return
    tenant_id = str(principal.tenant_id) if principal else None
    await websocket.accept()
    bus = get_bus()
    last_id = "$"  # tail from now
    try:
        while True:
            resp = await bus.client.xread({settings.redis_stream_alerts: last_id}, count=64, block=2000)
            if not resp:
                # send keepalive to keep proxies happy
                await websocket.send_json({"type": "ping"})
                continue
            for _stream, entries in resp:
                for entry_id, fields in entries:
                    last_id = entry_id
                    try:
                        payload = json.loads(fields["data"])
                    except Exception:
                        continue
                    # Tenant-scope the fanout: skip alerts that don't belong
                    # to this principal's tenant. Cheap; admins can opt out
                    # by issuing a token with role=admin if you wire that
                    # check in (left for later — minimal blast radius today).
                    if tenant_id is not None and str(payload.get("tenant_id")) != tenant_id:
                        continue
                    await websocket.send_json({"type": "alert", "id": entry_id, "data": payload})
    except WebSocketDisconnect:
        log.info("ws client disconnected")
    except Exception as e:
        log.warning("ws error", err=str(e))
        try:
            await websocket.close()
        except Exception:
            pass


@router.websocket("/ws/stream/{camera_id}")
async def camera_stream_websocket(websocket: WebSocket, camera_id: str) -> None:
    """Reserved for future use: stream raw / annotated frames per camera.
    Phase 2 hooks DeepStream's `nvmsgbroker` JSON output here."""
    principal = await _ws_authenticate(websocket)
    if principal is None and not dev_bypass_allowed():
        return
    await websocket.accept()
    try:
        await websocket.send_json({"type": "info", "msg": "not yet implemented", "camera_id": camera_id})
        await asyncio.sleep(1.0)
    finally:
        await websocket.close()
