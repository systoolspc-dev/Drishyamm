"""Camera sharding across several `smart-cam-ai` processes.

Measured 2026-09-21 (docs/FACE_SYSTEM_DESIGN.md, Phase 2): with inference in
the `smart-cam-infer` service a shard is decode + tracking, and what limits
it is its own event loop starving behind the per-camera decode threads —
loop lag 2 ms at 7 cameras, 10-16 ms at 13, 20-35 ms at 15. So the layout is
many small shards, each owning a bounded subset of the cameras.

Ownership: shard 0 is the *primary* — it alone runs the process-wide
singletons (backend forwarder, alert forwarder, alerts / cam-state
subscribers, retention, reid worker, known-faces bootstrap) and it is the
address the VMS backend talks to. With `ai_shard_primary_owns_cameras`
false it owns no cameras and shards 1..N-1 share them. A start/stop request
for a camera another shard owns is forwarded to that shard verbatim (same
path, body and Authorization) and its answer returned, so callers never
need to know the layout.

Assignment (`ai_shard_assignment`):
  hash      — `camera.id.int % N`: stable, no coordination, but 43 cameras
              over 4 shards landed 15/7/8/13 and the 15-shard ran at 3x the
              loop lag of the 7-shard.
  balanced  — sticky least-loaded: the first shard to ask about a camera
              records `camera -> least-loaded shard` in the Redis hash
              `vms:shard:owners` (HSETNX, so concurrent askers agree);
              lookups are cached 10 s; a deleted camera is released. To
              re-spread after changing the shard count: `DEL
              vms:shard:owners` in Redis and restart the shards. Falls back
              to hashing if Redis is unreachable.

With AI_SHARD_COUNT=1 (the default) nothing here changes behaviour.
"""
from __future__ import annotations

import threading
import time
import uuid
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException, Request, Response

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)

_HOP_HEADER = "x-ai-shard-hop"
_OWNERS_KEY = "vms:shard:owners"
_CACHE_TTL = 10.0

_redis = None
_redis_lock = threading.Lock()
_cache: dict[str, tuple[int, float]] = {}


def peers() -> list[str]:
    return [p.strip().rstrip("/") for p in (settings.ai_shard_peers or "").split(",") if p.strip()]


def shard_count() -> int:
    n = int(settings.ai_shard_count or 0)
    if n <= 0:
        n = len(peers()) or 1
    return max(1, n)


def shard_index() -> int:
    return max(0, int(settings.ai_shard_index or 0)) % shard_count()


def is_primary() -> bool:
    return shard_index() == 0


def camera_shards() -> list[int]:
    """The shard indexes that run cameras."""
    n = shard_count()
    if n > 1 and not settings.ai_shard_primary_owns_cameras:
        return list(range(1, n))
    return list(range(n))


def _hash_owner(camera_id: uuid.UUID) -> int:
    shards = camera_shards()
    return shards[camera_id.int % len(shards)]


def _r():
    global _redis
    if _redis is None:
        with _redis_lock:
            if _redis is None:
                import redis as syncredis
                _redis = syncredis.from_url(
                    settings.redis_url, decode_responses=True, socket_timeout=1.0, socket_connect_timeout=1.0
                )
    return _redis


def _balanced_owner(camera_id: uuid.UUID) -> int:
    key = str(camera_id)
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and hit[1] > now:
        return hit[0]
    shards = camera_shards()
    r = _r()
    raw = r.hget(_OWNERS_KEY, key)
    owner = int(raw) if raw is not None else None
    if owner is not None and owner not in shards:
        # A layout change (shard count shrank): forget the stale owner.
        r.hdel(_OWNERS_KEY, key)
        owner = None
    if owner is None:
        counts = {s: 0 for s in shards}
        for v in r.hvals(_OWNERS_KEY):
            try:
                counts[int(v)] = counts.get(int(v), 0) + 1
            except ValueError:
                pass
        preferred = _hash_owner(camera_id)
        # Least loaded; ties go to the hash owner so an empty map still spreads
        # deterministically when every shard assigns at boot at once.
        pick = min(shards, key=lambda s: (counts.get(s, 0), s != preferred, s))
        if r.hsetnx(_OWNERS_KEY, key, pick):
            owner = pick
            log.info("camera assigned to shard", camera_id=key, shard=pick, load=counts)
        else:
            owner = int(r.hget(_OWNERS_KEY, key) or pick)
    _cache[key] = (owner, now + _CACHE_TTL)
    return owner


def owner_of(camera_id: uuid.UUID) -> int:
    if shard_count() == 1:
        return 0
    if str(settings.ai_shard_assignment).lower() != "balanced":
        return _hash_owner(camera_id)
    try:
        return _balanced_owner(camera_id)
    except Exception as e:  # noqa: BLE001 - Redis down: fall back, never block a start
        log.warning("shard assignment lookup failed; hashing", camera_id=str(camera_id), err=str(e))
        return _hash_owner(camera_id)


def owns(camera_id: uuid.UUID) -> bool:
    return shard_count() == 1 or owner_of(camera_id) == shard_index()


def release(camera_id: uuid.UUID) -> None:
    """Forget a deleted camera's assignment so its slot goes to the next one."""
    _cache.pop(str(camera_id), None)
    if shard_count() == 1 or str(settings.ai_shard_assignment).lower() != "balanced":
        return
    try:
        _r().hdel(_OWNERS_KEY, str(camera_id))
    except Exception as e:  # noqa: BLE001
        log.warning("shard assignment release failed", camera_id=str(camera_id), err=str(e))


def prune(existing: set[str]) -> int:
    """Drop map entries for cameras that no longer exist (a delete whose owner
    was down never released its slot); stale entries skew least-loaded picks."""
    if shard_count() == 1 or str(settings.ai_shard_assignment).lower() != "balanced":
        return 0
    try:
        r = _r()
        stale = [k for k in r.hkeys(_OWNERS_KEY) if k not in existing]
        if stale:
            r.hdel(_OWNERS_KEY, *stale)
            for k in stale:
                _cache.pop(k, None)
            log.info("shard assignment pruned", removed=len(stale))
        return len(stale)
    except Exception as e:  # noqa: BLE001
        log.warning("shard assignment prune failed", err=str(e))
        return 0


def assignments() -> dict[str, int]:
    """Current camera -> shard map (balanced mode), for /streams/debug."""
    if shard_count() == 1 or str(settings.ai_shard_assignment).lower() != "balanced":
        return {}
    try:
        return {k: int(v) for k, v in _r().hgetall(_OWNERS_KEY).items()}
    except Exception:  # noqa: BLE001
        return {}


def peer_url(index: int) -> str | None:
    ps = peers()
    return ps[index] if 0 <= index < len(ps) else None


def describe() -> dict:
    return {"shard_index": shard_index(), "shard_count": shard_count(), "primary": is_primary(), "peers": peers(),
            "primary_owns_cameras": bool(settings.ai_shard_primary_owns_cameras),
            "assignment": str(settings.ai_shard_assignment)}


async def forward_to_owner(request: Request, camera_id: uuid.UUID) -> Response:
    """Replay this request on the shard that owns `camera_id` and hand its
    response back unchanged. One hop only: a request that already carries
    the hop header is refused rather than bounced around a misconfigured
    ring."""
    if request.headers.get(_HOP_HEADER):
        raise HTTPException(508, "shard forwarding loop: peers disagree about ownership")
    owner = owner_of(camera_id)
    base = peer_url(owner)
    if base is None:
        raise HTTPException(
            503, f"camera belongs to shard {owner} of {shard_count()} but AI_SHARD_PEERS has no entry for it",
        )
    url = base + request.url.path + (f"?{request.url.query}" if request.url.query else "")
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "connection", "transfer-encoding")
    }
    try:
        body = await request.body()
    except RuntimeError:
        # The handler's Form() fields already consumed the stream (starlette
        # caches the parsed form, not the bytes). Re-encode the string
        # fields; the owner parses urlencoded exactly like multipart.
        form = await request.form()
        body = urlencode([(k, v) for k, v in form.multi_items() if isinstance(v, str)]).encode()
        headers["content-type"] = "application/x-www-form-urlencoded"
    headers[_HOP_HEADER] = str(shard_index())
    log.info("forwarding to owning shard", camera_id=str(camera_id), owner=owner, method=request.method, path=request.url.path)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
            r = await client.request(request.method, url, content=body, headers=headers)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"shard {owner} unreachable: {e}") from e
    return Response(content=r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))
