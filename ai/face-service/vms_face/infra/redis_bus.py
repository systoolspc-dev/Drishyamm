from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import redis.asyncio as aioredis
from redis.asyncio.client import Redis
from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.core.tracing import inject_context

log = get_logger(__name__)

# Produce-side resilience: an XADD that hits a transient Redis blip must not
# silently lose the detection. The consumer-group / DLQ / XAUTOCLAIM machinery
# only protects entries ALREADY in the stream — this covers the gap before an
# entry lands. Short bounded retry so a brief hiccup recovers; a sustained
# outage still fails fast-ish and surfaces to the caller.
_XADD_RETRIES = 3
_XADD_BACKOFF_SEC = (0.05, 0.15, 0.3)


class RedisBus:
    """Wrapper around Redis Streams + Pub/Sub for inter-process events.

    Streams (durable, consumer-group-distributed):
      - settings.redis_stream_detections      pipeline -> match worker
      - settings.redis_stream_alerts          match worker -> websocket fanout
      - settings.redis_stream_detections_dlq  poison messages from match worker

    Channels (best-effort live overlay):
      - {redis_cam_state_channel}:{camera_id}  per-camera frame state
                                                (no replay; subscribers tail)

    Keys:
      - {redis_cam_state_key_prefix}{camera_id}  latest snapshot for late
                                                  subscribers / polling.
                                                  TTL = redis_cam_state_ttl_sec.
    """

    def __init__(self) -> None:
        self._client: Redis = aioredis.from_url(settings.redis_url, decode_responses=True)

    @property
    def client(self) -> Redis:
        return self._client

    async def ping(self) -> bool:
        try:
            return bool(await self._client.ping())
        except Exception:
            return False

    async def ensure_consumer_group(self, stream: str, group: str) -> None:
        try:
            await self._client.xgroup_create(name=stream, groupname=group, id="$", mkstream=True)
            log.info("created redis consumer group", stream=stream, group=group)
        except aioredis.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise

    # ── Stream publishers ───────────────────────────────────────────────────

    async def _xadd_retrying(self, stream: str, fields: dict[str, Any], *, maxlen: int) -> str:
        """XADD with a short bounded retry on transient connection/timeout
        errors. Non-transient errors (bad payload, etc.) raise immediately.
        On exhausted retries the final error propagates so the caller logs it —
        but the common blip recovers here and the detection is not lost."""
        last: Exception | None = None
        for attempt in range(_XADD_RETRIES):
            try:
                return await self._client.xadd(stream, fields, maxlen=maxlen, approximate=True)
            except (RedisConnectionError, RedisTimeoutError) as e:
                last = e
                if attempt < _XADD_RETRIES - 1:
                    log.warning("xadd transient failure; retrying",
                                stream=stream, attempt=attempt + 1, err=str(e))
                    await asyncio.sleep(_XADD_BACKOFF_SEC[attempt])
        log.error("xadd failed after retries; entry lost", stream=stream, err=str(last))
        raise last  # type: ignore[misc]

    async def publish_detection(self, payload: dict[str, Any]) -> str:
        # Stamp the active OTel trace into payload.extra._trace so the match
        # worker can parent its span on the originating frame. No-op when
        # tracing is disabled.
        extra = payload.get("extra")
        if isinstance(extra, dict):
            inject_context(extra)
        return await self._xadd_retrying(
            settings.redis_stream_detections,
            {"data": json.dumps(payload, default=str)},
            maxlen=int(settings.redis_stream_detections_maxlen),
        )

    async def publish_alert(self, payload: dict[str, Any]) -> str:
        inject_context(payload)
        return await self._xadd_retrying(
            settings.redis_stream_alerts,
            {"data": json.dumps(payload, default=str)},
            maxlen=int(settings.redis_stream_alerts_maxlen),
        )

    async def publish_dlq(self, payload: dict[str, Any], *, error: str, original_id: str) -> str:
        return await self._client.xadd(
            settings.redis_stream_detections_dlq,
            {
                "data": json.dumps(payload, default=str),
                "error": error[:512],
                "original_id": original_id,
            },
            maxlen=50_000,
            approximate=True,
        )

    # ── Stream consumers ────────────────────────────────────────────────────

    async def consume_detections(
        self,
        consumer: str,
        *,
        count: int = 16,
        block_ms: int = 2000,
    ) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Match-worker consumer (shared `match-workers` group)."""
        async for entry_id, payload in self._consume_group(
            settings.redis_stream_detections,
            settings.redis_consumer_group,
            consumer,
            count=count,
            block_ms=block_ms,
        ):
            yield entry_id, payload

    async def consume_detections_as(
        self,
        group: str,
        consumer: str,
        *,
        count: int = 16,
        block_ms: int = 2000,
    ) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Generic consumer-group iterator. Used by the ReID worker, which
        joins its own group (`reid-workers`) so it sees every candidate
        without competing with match workers."""
        async for entry_id, payload in self._consume_group(
            settings.redis_stream_detections, group, consumer,
            count=count, block_ms=block_ms,
        ):
            yield entry_id, payload

    async def consume_alerts_as(
        self,
        group: str,
        consumer: str,
        *,
        count: int = 32,
        block_ms: int = 2000,
    ) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Generic consumer-group iterator over the `vms.alerts` stream. Used by
        the backend alert forwarder, which joins its OWN group so it sees every
        alert without competing with the WS alerts subscriber. Group is created
        at id='$' (tail-from-now), so a restart never replays the backlog."""
        async for entry_id, payload in self._consume_group(
            settings.redis_stream_alerts, group, consumer,
            count=count, block_ms=block_ms,
        ):
            yield entry_id, payload

    async def ack_alert(self, group: str, entry_id: str) -> None:
        await self._client.xack(settings.redis_stream_alerts, group, entry_id)

    async def _consume_group(
        self,
        stream: str,
        group: str,
        consumer: str,
        *,
        count: int,
        block_ms: int,
    ) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        await self.ensure_consumer_group(stream, group)
        while True:
            resp = await self._client.xreadgroup(
                groupname=group,
                consumername=consumer,
                streams={stream: ">"},
                count=count,
                block=block_ms,
            )
            if not resp:
                continue
            for _stream, entries in resp:
                for entry_id, fields in entries:
                    try:
                        payload = json.loads(fields["data"])
                    except (KeyError, json.JSONDecodeError):
                        log.warning(
                            "malformed stream entry",
                            entry_id=entry_id,
                            group=group,
                        )
                        await self._client.xack(stream, group, entry_id)
                        continue
                    yield entry_id, payload

    async def ack_for(self, group: str, entry_id: str) -> None:
        await self._client.xack(settings.redis_stream_detections, group, entry_id)

    async def autoclaim_detections(
        self,
        consumer: str,
        *,
        min_idle_ms: int,
        count: int = 64,
    ) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Reclaim pending entries that have been idle in another consumer
        for longer than `min_idle_ms`. Yields the same shape as
        consume_detections so the caller's processing loop is identical."""
        stream = settings.redis_stream_detections
        group = settings.redis_consumer_group
        await self.ensure_consumer_group(stream, group)
        cursor = "0-0"
        while True:
            try:
                resp = await self._client.xautoclaim(
                    name=stream,
                    groupname=group,
                    consumername=consumer,
                    min_idle_time=min_idle_ms,
                    start_id=cursor,
                    count=count,
                )
            except aioredis.ResponseError as e:
                log.warning("xautoclaim failed", err=str(e))
                return
            if not resp:
                return
            cursor = resp[0] if resp else "0-0"
            entries = resp[1] if len(resp) > 1 else []
            if not entries:
                return
            for entry_id, fields in entries:
                if not fields:
                    # Orphaned tombstone; ack and move on.
                    await self._client.xack(stream, group, entry_id)
                    continue
                try:
                    payload = json.loads(fields["data"])
                except (KeyError, json.JSONDecodeError):
                    await self._client.xack(stream, group, entry_id)
                    continue
                yield entry_id, payload

    async def ack(self, entry_id: str) -> None:
        await self._client.xack(
            settings.redis_stream_detections,
            settings.redis_consumer_group,
            entry_id,
        )

    async def stream_depth(self, stream: str) -> int:
        try:
            return int(await self._client.xlen(stream))
        except Exception:
            return 0

    # ── Cam-state pub/sub (non-durable live overlay) ───────────────────────

    @staticmethod
    def cam_state_key(camera_id: str) -> str:
        return f"{settings.redis_cam_state_key_prefix}{camera_id}"

    @staticmethod
    def cam_state_channel(camera_id: str) -> str:
        return f"{settings.redis_cam_state_channel}:{camera_id}"

    async def publish_cam_state(self, camera_id: str, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, default=str)
        # SETEX so that subscribers joining late can pick up the latest known
        # snapshot from a single GET, and the key auto-expires when the stream
        # stops publishing.
        await self._client.setex(
            self.cam_state_key(camera_id),
            settings.redis_cam_state_ttl_sec,
            body,
        )
        await self._client.publish(self.cam_state_channel(camera_id), body)

    async def get_cam_state(self, camera_id: str) -> dict[str, Any] | None:
        body = await self._client.get(self.cam_state_key(camera_id))
        if not body:
            return None
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return None

    async def clear_cam_state(self, camera_id: str) -> None:
        await self._client.delete(self.cam_state_key(camera_id))

    # ── Verdict feedback (match worker → orchestrator, non-durable) ────────

    @staticmethod
    def verdict_channel(camera_id: str) -> str:
        return f"{settings.redis_verdict_channel}:{camera_id}"

    async def publish_verdict(self, camera_id: str, payload: dict[str, Any]) -> None:
        """Tell the orchestrator that owns `camera_id` what the 1:N said about a
        track. Fire-and-forget on purpose: if the orchestrator misses one, its
        identity latch simply asks again on its own timer."""
        await self._client.publish(
            self.verdict_channel(str(camera_id)),
            json.dumps(payload, default=str),
        )

    # ── Gallery change notifications (enrolment → local gallery caches) ────

    @staticmethod
    def gallery_changed_channel() -> str:
        return settings.redis_gallery_changed_channel

    @staticmethod
    def gallery_version_key(tenant_id: Any) -> str:
        return f"{settings.redis_gallery_version_key_prefix}{tenant_id}"

    async def publish_gallery_changed(self, tenant_id: Any, *, reason: str) -> None:
        """Best-effort nudge for every local gallery cache to reload, and a bump
        of the tenant's monotonic gallery version (what edge nodes poll).
        Callers must not fail on an error — the caches also reload on a timer."""
        try:
            version = await self._client.incr(self.gallery_version_key(tenant_id))
            await self._client.publish(
                self.gallery_changed_channel(),
                json.dumps(
                    {"tenant_id": str(tenant_id), "reason": reason, "version": int(version)},
                    default=str,
                ),
            )
        except Exception as e:  # noqa: BLE001 — never fail an enrolment over a nudge
            log.warning("gallery-changed publish failed", err=str(e), reason=reason)

    async def gallery_version(self, tenant_id: Any) -> int:
        """Current gallery version for a tenant; 0 if it has never changed
        since the counter was introduced (edges then pull once and wait)."""
        try:
            v = await self._client.get(self.gallery_version_key(tenant_id))
            return int(v) if v else 0
        except Exception:
            return 0

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except AttributeError:
            await self._client.close()


_bus: RedisBus | None = None


def get_bus() -> RedisBus:
    global _bus
    if _bus is None:
        _bus = RedisBus()
    return _bus
