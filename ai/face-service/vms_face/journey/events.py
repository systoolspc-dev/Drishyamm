"""journey.events Kafka emission.

Emitted once per successful stitch, AFTER the Journey is persisted. The live-
journey folder (future) consumes this same topic to fold forensic journeys into
live identities.

Design notes (from the P1d adversarial review):
  * The RQ worker is sync, so we expose a sync entry point that runs a SHORT-LIVED
    event loop per call and builds+starts+stops a fresh AIOKafkaProducer inside it.
    We do NOT cache a producer in a module global — a producer bound to one
    asyncio.run() loop raises 'Event loop is closed' when reused in the next.
  * Empty bootstrap (dev) → logged no-op, so rendering still succeeds.
  * Best-effort: the journey is already committed; a Kafka failure (broker down /
    slow) is bounded by a timeout and never blocks the job reaching status=done.
"""
from __future__ import annotations

import asyncio
import json

from vms_face.config import settings
from vms_face.core.logging import get_logger

log = get_logger(__name__)

_EMIT_TIMEOUT_SEC = 10.0


async def _emit(payload: dict) -> None:
    from aiokafka import AIOKafkaProducer

    producer = AIOKafkaProducer(
        bootstrap_servers=settings.kafka_bootstrap_servers,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        key_serializer=lambda k: k.encode("utf-8") if k else None,
    )
    await producer.start()
    try:
        await producer.send_and_wait(
            settings.kafka_topic_journey_events,
            value=payload,
            key=str(payload.get("journey_id") or ""),
        )
    finally:
        await producer.stop()


def emit_journey_event_sync(payload: dict) -> None:
    """Best-effort emit from the sync RQ worker. Never raises."""
    if not settings.kafka_bootstrap_servers:
        log.info("kafka disabled; skipping journey.events emit", journey_id=payload.get("journey_id"))
        return
    try:
        asyncio.run(asyncio.wait_for(_emit(payload), timeout=_EMIT_TIMEOUT_SEC))
        log.info("emitted journey.events", journey_id=payload.get("journey_id"))
    except Exception as e:  # broker down/slow/unreachable — non-fatal
        log.warning("journey.events emit failed (non-fatal)", err=str(e),
                    journey_id=payload.get("journey_id"))
