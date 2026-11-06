"""Match worker.

Consumes FaceCandidate messages from `vms.detections` (Redis Streams),
runs Qdrant ANN search against the enrolled gallery, writes a
DetectionEvent row, publishes an alert onto `vms.alerts` for the
WebSocket fanout, and (if enabled) appends the pooled embedding to the
appearance log for forensic search.

Resilience features (post-2026-05-08):

  * Concurrency. A semaphore lets `match_worker_concurrency` candidates
    process in parallel inside the same async loop. Each task takes its
    own slot of GPU/Postgres/Redis budget; the consumer-group machinery
    upstream still distributes work across worker processes.

  * Dead-letter queue. Any exception during processing routes the original
    payload onto `vms.detections.dlq` together with the error string and
    the original entry id, then ACKs the source entry. Poison messages no
    longer disappear silently.

  * XAUTOCLAIM recovery. A periodic task reclaims stuck pending entries
    that have been idle in another (likely dead) consumer for longer than
    `match_worker_autoclaim_min_idle_ms`.

  * Single transaction per event. Person lookup + DetectionEvent insert
    + audit log insert all share one Postgres session.

Run multiple instances for horizontal scale; Redis distributes work via
the consumer group. Workers are stateless and can be killed at any time.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import os
import signal
import socket
import uuid

from redis.exceptions import ConnectionError as RedisConnectionError, TimeoutError as RedisTimeoutError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from vms_face.config import settings
from vms_face.core.logging import configure_logging, get_logger
from vms_face.core.metrics import (
    DLQ_DEPTH,
    MATCH_WORKER_AUTOCLAIM,
    MATCH_WORKER_INFLIGHT,
    MATCH_WORKER_PROCESSED,
    QUEUE_DEPTH,
    WORKER_ALIVE,
)
from vms_face.core.system_metrics import run_system_metrics
from vms_face.core.tracing import (
    extract_context,
    init_tracing,
    instrument_redis,
    instrument_sqlalchemy,
    shutdown_tracing,
    use_extracted,
)
from vms_face.domain.enums import EventKind, PersonRole
from vms_face.domain.models import DetectionEvent, Person
from vms_face.domain.schemas import FaceCandidate, MatchResult
from vms_face.infra.postgres import session_scope
from vms_face.infra.qdrant import get_qdrant_appearance, get_qdrant_enrolled
from vms_face.infra.recognizers import get_recognizer
from vms_face.infra.redis_bus import get_bus
from vms_face.services import audit as audit_log
from vms_face.services.face_matcher import FaceMatcher
from vms_face.services.face_learning import maybe_queue_sample
from vms_face.services.gallery_cache import GalleryCacheManager

log = get_logger(__name__)


def _consumer_name() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


# ── Watchlist auto-enhance helper ─────────────────────────────────────
#
# Used from _process_one() when EventKind.ALERT fires + the operator
# has watchlist_auto_enhance on. We:
#   1. Parse the s3:// URI of the original snapshot.
#   2. Pull the JPEG bytes from MinIO via the existing ObjectStore.
#   3. POST them to the face-reconstruct service.
#   4. Upload the enhanced PNG back to MinIO at <orig_key>_enhanced.png.
#   5. Return the new s3 URI so the alert payload can carry it.
#
# Returns None on any failure — the caller falls back to the original
# snapshot_uri so a misconfigured / down enhance service never breaks
# alerting itself.
_enhance_client = None


def _get_enhance_client():
    """Shared httpx.AsyncClient. Lazily built so importing match_worker
    in a test process doesn't require an event loop or network."""
    global _enhance_client
    if _enhance_client is None:
        import httpx
        # Watchlist hits are rare and the operator looks at every one;
        # we can afford a longer timeout than the per-event pump path.
        _enhance_client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=1.0, read=10.0, write=2.0, pool=1.0),
        )
    return _enhance_client


def _parse_s3_uri(uri: str) -> tuple[str | None, str | None]:
    if not uri or not uri.startswith("s3://"):
        return None, None
    _, _, rest = uri.partition("s3://")
    bucket, _, key = rest.partition("/")
    return (bucket or None), (key or None)


async def _enhance_watchlist_snapshot(snapshot_uri: str) -> str | None:
    bucket, key = _parse_s3_uri(snapshot_uri)
    if not bucket or not key:
        return None

    from vms_face.infra.minio_store import get_object_store
    store = get_object_store()
    # Download the original JPEG. ObjectStore wraps minio-py which is
    # sync, so we hop to a thread to avoid blocking the asyncio loop.
    loop = asyncio.get_running_loop()
    try:
        original = await loop.run_in_executor(
            None, lambda: store._client.get_object(bucket, key).read(),  # noqa: SLF001
        )
    except Exception as e:
        log.debug("enhance: pull original failed", uri=snapshot_uri, err=str(e))
        return None

    # POST to /api/reconstruct. The service returns base64 PNG strings.
    try:
        client = _get_enhance_client()
        url = settings.face_reconstruct_url.rstrip("/") + "/api/reconstruct"
        files = {"file": ("face.jpg", original, "image/jpeg")}
        data  = {"fidelity_weight": str(settings.watchlist_auto_enhance_fidelity)}
        r = await client.post(url, files=files, data=data)
        r.raise_for_status()
        body = r.json()
        # Use `reconstruction_image` (true CodeFormer + Real-ESRGAN output).
        # `final_enhanced_image` is only stage-3 of pipeline.py's classical
        # forensic pre-pass and looks barely different from the input.
        after_b64 = (body or {}).get("reconstruction_image") or (body or {}).get("final_enhanced_image")
        if not after_b64:
            return None
        import base64
        enhanced = base64.b64decode(after_b64)
    except Exception as e:
        log.debug("enhance: POST /api/reconstruct failed", err=str(e))
        return None

    # Upload to MinIO at a derived key. Same bucket so retention policies
    # cover it; .png suffix because the upstream returns PNG.
    enhanced_key = key.rsplit(".", 1)[0] + "_enhanced.png"
    try:
        await loop.run_in_executor(
            None, lambda: store.put_bytes(bucket, enhanced_key, enhanced),
        )
    except Exception as e:
        log.warning("enhance: upload back failed", key=enhanced_key, err=str(e))
        return None

    return f"s3://{bucket}/{enhanced_key}"


def _candidate_matchable(candidate: FaceCandidate) -> bool:
    extra = candidate.extra or {}
    if candidate.quality_score < settings.match_min_quality:
        return False
    if float(extra.get("face_px") or 0.0) < settings.match_min_face_px:
        return False
    blur_var = extra.get("blur_var")
    if blur_var is None or float(blur_var) < settings.match_min_blur_var:
        return False
    return True


async def _process_one(
    entry_id: str,
    payload: dict,
    matcher: FaceMatcher,
    consumer: str,
) -> None:
    candidate = FaceCandidate.model_validate(payload)
    bus = get_bus()
    matchable = _candidate_matchable(candidate)
    if matchable:
        result = await matcher.match_one(
            tenant_id=candidate.tenant_id,
            embedding=candidate.embedding,
            camera_id=candidate.camera_id,
        )
    else:
        result = MatchResult(person_id=None, similarity=0.0)

    person_full_name: str | None = None
    role: PersonRole | None = None
    event_id: uuid.UUID | None = None

    async with session_scope() as session:
        if result.person_id is not None:
            person = await session.get(Person, result.person_id)
            if person is not None:
                role = person.role
                person_full_name = person.full_name
        else:
            person = None

        if result.person_id is None:
            kind = EventKind.UNKNOWN
        elif role == PersonRole.BLACKLIST:
            kind = EventKind.ALERT
        else:
            kind = EventKind.MATCH

        # ── Verdict back to the orchestrator — BEFORE any DB write ─────────
        # This is the time-to-identity path: the identity latch on the track
        # needs the answer now, not after the event row, audit log, learning
        # sample and appearance upsert have all committed. Best-effort: a
        # publish failure must never DLQ the candidate, and a missed message
        # only means the latch asks again on its own timer.
        try:
            await bus.publish_verdict(
                str(candidate.camera_id),
                {
                    "camera_id": str(candidate.camera_id),
                    "track_id": candidate.track_id,
                    # A candidate the worker refused to match (quality floors)
                    # is NOT a miss — the latch must not count it as one.
                    "skipped": not matchable,
                    "person_id": str(result.person_id) if result.person_id else None,
                    "person_name": person_full_name,
                    "similarity": float(result.similarity),
                    "ambiguous": bool(result.ambiguous),
                    "kind": kind.value,
                    "tier": result.tier,
                    "occurred_at": candidate.occurred_at.isoformat(),
                    "latch_reason": (candidate.extra or {}).get("latch_reason"),
                },
            )
        except Exception as e:  # noqa: BLE001
            log.debug("verdict publish failed", err=str(e), track_id=candidate.track_id)

        event = DetectionEvent(
            tenant_id=candidate.tenant_id,
            camera_id=candidate.camera_id,
            track_id=candidate.track_id,
            kind=kind,
            person_id=result.person_id,
            similarity=result.similarity,
            det_score=candidate.det_score,
            quality_score=candidate.quality_score,
            bbox=candidate.bbox,
            snapshot_uri=candidate.snapshot_uri,
            extra=candidate.extra,
            occurred_at=candidate.occurred_at,
        )
        session.add(event)
        await session.flush()
        event_id = event.id

        # DPDP audit: log every automated 1:N hit (binding biometric data
        # to an identity). Misses are not logged here — they're already
        # captured in detection_events.
        if result.person_id is not None:
            await audit_log.record_match(
                tenant_id=candidate.tenant_id,
                person_id=result.person_id,
                similarity=result.similarity,
                camera_id=candidate.camera_id,
                track_id=candidate.track_id,
                session=session,
            )

        await maybe_queue_sample(
            session,
            candidate=candidate,
            result=result,
            event_id=event_id,
            person=person,
        )

    # Appearance-log upsert (forensic search) — outside the SQL transaction
    # so a Qdrant hiccup doesn't roll back the event.
    if event_id is not None:
        ex = candidate.extra or {}
        # Forward the forensic-fusion signals into the appearance payload so the
        # journey can fuse face+body and apply pose/quality weighting. (Previously
        # only `recognizer` was kept, which left body/clothing fusion starved.)
        appearance_extra = {"recognizer": ex.get("recognizer")}
        for k in ("body_vec", "upper_color", "lower_color", "upper_rgb", "lower_rgb",
                  "yaw", "pitch", "face_px"):
            v = ex.get(k)
            if v is not None:
                appearance_extra[k] = v
        if candidate.quality_score is not None:
            appearance_extra["quality_score"] = float(candidate.quality_score)
        await matcher.log_appearance(
            tenant_id=candidate.tenant_id,
            camera_id=candidate.camera_id,
            embedding=candidate.embedding,
            occurred_at=candidate.occurred_at,
            event_id=event_id,
            person_id=result.person_id,
            track_id=candidate.track_id,
            extra=appearance_extra,
        )

    # Watchlist-hit auto-enhance. For ALERT events only — these are rare
    # (only fire when someone on the watchlist is seen), so a 1-2 s
    # round-trip to CodeFormer is fine. We replace the MinIO snapshot
    # in-place with the enhanced PNG so EVERY downstream consumer (the
    # Alerts page modal, the AI Feed, audit exports) shows the cleaned
    # face — operators reviewing a watchlist hit on a low-quality CCTV
    # frame need the best evidence possible.
    enhanced_uri: str | None = None
    if (
        settings.watchlist_auto_enhance
        and kind == EventKind.ALERT
        and candidate.snapshot_uri
    ):
        try:
            enhanced_uri = await _enhance_watchlist_snapshot(candidate.snapshot_uri)
        except Exception as e:
            log.warning(
                "watchlist auto-enhance failed; using original",
                event_id=str(event_id) if event_id else None,
                err=str(e),
            )

    # Publish alert for the WebSocket fan-out.
    await bus.publish_alert(
        {
            "event_id": str(event_id) if event_id else None,
            "tenant_id": str(candidate.tenant_id),
            "camera_id": str(candidate.camera_id),
            "track_id": candidate.track_id,
            "kind": kind.value,
            "person_id": str(result.person_id) if result.person_id else None,
            "person_name": person_full_name,
            "similarity": result.similarity,
            "occurred_at": candidate.occurred_at.isoformat(),
            "snapshot_uri": enhanced_uri or candidate.snapshot_uri,
            # Preserve the original so audit / forensics still have it if
            # an operator ever questions whether the enhanced version
            # invented features.
            "snapshot_original_uri": candidate.snapshot_uri if enhanced_uri else None,
            "snapshot_enhanced": bool(enhanced_uri),
            "bbox": candidate.bbox,
            "frame_w": candidate.extra.get("frame_w"),
            "frame_h": candidate.extra.get("frame_h"),
            "gender": candidate.extra.get("gender"),
            "camera_code": candidate.extra.get("camera_code"),
        }
    )

    MATCH_WORKER_PROCESSED.labels(consumer=consumer, outcome="ok").inc()


async def _safe_process(
    entry_id: str,
    payload: dict,
    matcher: FaceMatcher,
    consumer: str,
    sem: asyncio.Semaphore,
) -> None:
    # Pull the originating frame's trace context out of FaceCandidate.extra so
    # the span we open here links to the orchestrator's publish span. No-op
    # when tracing is disabled.
    parent_ctx = extract_context(payload.get("extra") or {})
    async with sem:
        MATCH_WORKER_INFLIGHT.labels(consumer=consumer).inc()
        bus = get_bus()
        try:
            with use_extracted(
                "match_worker.process",
                parent_ctx,
                **{
                    "messaging.system": "redis-streams",
                    "messaging.message_id": entry_id,
                    "consumer": consumer,
                },
            ):
                await _process_one(entry_id, payload, matcher, consumer)
        except (SQLAlchemyError, Exception) as e:  # noqa: BLE001 — we route to DLQ
            log.exception("match failed; routing to DLQ", entry_id=entry_id, err=str(e))
            try:
                await bus.publish_dlq(payload, error=str(e), original_id=entry_id)
                MATCH_WORKER_PROCESSED.labels(consumer=consumer, outcome="dlq").inc()
            except Exception as e2:
                MATCH_WORKER_PROCESSED.labels(consumer=consumer, outcome="error").inc()
                log.error("DLQ publish failed", entry_id=entry_id, err=str(e2))
        finally:
            try:
                await bus.ack(entry_id)
            except Exception as e:
                log.warning("ack failed", entry_id=entry_id, err=str(e))
            MATCH_WORKER_INFLIGHT.labels(consumer=consumer).dec()


async def _depth_reporter(stop: asyncio.Event) -> None:
    bus = get_bus()
    while not stop.is_set():
        try:
            depth = await bus.stream_depth(settings.redis_stream_detections)
            QUEUE_DEPTH.labels(stream=settings.redis_stream_detections).set(depth)
            dlq_depth = await bus.stream_depth(settings.redis_stream_detections_dlq)
            DLQ_DEPTH.labels(stream=settings.redis_stream_detections_dlq).set(dlq_depth)
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            continue


async def _heartbeat(stop: asyncio.Event, consumer: str) -> None:
    host = socket.gethostname()
    while not stop.is_set():
        WORKER_ALIVE.labels(component="match-worker", host=host).set(1)
        try:
            await asyncio.wait_for(stop.wait(), timeout=10.0)
        except asyncio.TimeoutError:
            continue
    WORKER_ALIVE.labels(component="match-worker", host=host).set(0)


async def _autoclaim_loop(
    stop: asyncio.Event,
    consumer: str,
    matcher: FaceMatcher,
    sem: asyncio.Semaphore,
) -> None:
    bus = get_bus()
    interval = max(1.0, float(settings.match_worker_autoclaim_interval_sec))
    min_idle = max(1000, int(settings.match_worker_autoclaim_min_idle_ms))
    while not stop.is_set():
        reclaimed = 0
        try:
            async for entry_id, payload in bus.autoclaim_detections(
                consumer, min_idle_ms=min_idle, count=64
            ):
                reclaimed += 1
                asyncio.create_task(_safe_process(entry_id, payload, matcher, consumer, sem))
        except Exception as e:
            log.warning("autoclaim sweep failed", err=str(e))
        if reclaimed:
            MATCH_WORKER_AUTOCLAIM.labels(consumer=consumer).inc(reclaimed)
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue


async def run_worker() -> None:
    configure_logging()
    settings.assert_consistent()
    init_tracing("match-worker")
    instrument_redis()
    from vms_face.infra.postgres import get_engine
    instrument_sqlalchemy(get_engine())

    consumer = _consumer_name()
    log.info(
        "match worker starting",
        consumer=consumer,
        concurrency=settings.match_worker_concurrency,
        appearance_log=settings.match_worker_appearance_log,
    )

    bus = get_bus()
    enrolled = get_qdrant_enrolled()
    appearance = get_qdrant_appearance() if settings.qdrant_appearance_enabled else None
    await enrolled.ensure_collection()
    if appearance is not None:
        await appearance.ensure_collection()
    # Resolve threshold against the active recognizer; AdaFace and ArcFace
    # cosines are not comparable, see settings.effective_recognizer_threshold.
    rec_name = get_recognizer().name
    # L2/L3 gallery cache in front of Qdrant (docs/FACE_EDGE_REALTIME_PLAN.md §4).
    gallery: GalleryCacheManager | None = None
    if settings.gallery_cache_enabled:
        gallery = GalleryCacheManager(enrolled)
        await gallery.start()
    matcher = FaceMatcher(enrolled, appearance, recognizer_name=rec_name, gallery=gallery)
    log.info(
        "match worker recognizer threshold",
        recognizer=rec_name,
        threshold=matcher.threshold,
        gallery_cache=bool(gallery),
        gallery_vectors=gallery.gallery.size() if gallery else None,
    )

    stop = asyncio.Event()

    def _handle_sig(*_):
        log.info("match worker stop requested")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _handle_sig)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler for all signals
            signal.signal(sig, lambda *_: _handle_sig())

    sem = asyncio.Semaphore(max(1, int(settings.match_worker_concurrency)))
    sysmetrics_task = asyncio.create_task(run_system_metrics(stop), name="match-worker-sysmetrics")
    depth_task = asyncio.create_task(_depth_reporter(stop), name="match-worker-depth")
    heartbeat_task = asyncio.create_task(_heartbeat(stop, consumer), name="match-worker-heartbeat")
    autoclaim_task = asyncio.create_task(
        _autoclaim_loop(stop, consumer, matcher, sem),
        name="match-worker-autoclaim",
    )

    inflight: set[asyncio.Task] = set()

    try:
        # The consume loop must survive Redis blips. Before this, one
        # `redis.exceptions.TimeoutError` on XREADGROUP propagated out of the
        # generator, the process exited, and docker restarted it: ~5 s of no
        # matching plus a gallery reload, several times a day on a busy Redis.
        # Re-enter the consumer group with a bounded backoff instead; pending
        # entries are safe (XAUTOCLAIM picks them up).
        backoff = 0.5
        while not stop.is_set():
            try:
                async for entry_id, payload in bus.consume_detections(consumer):
                    if stop.is_set():
                        break
                    backoff = 0.5
                    t = asyncio.create_task(_safe_process(entry_id, payload, matcher, consumer, sem))
                    inflight.add(t)
                    t.add_done_callback(inflight.discard)
                break  # stop requested
            except (RedisConnectionError, RedisTimeoutError) as e:
                MATCH_WORKER_PROCESSED.labels(consumer=consumer, outcome="redis_reconnect").inc()
                log.warning("match worker: redis read failed; reconnecting", err=str(e), backoff=backoff)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=backoff)
                    break
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 10.0)
    finally:
        log.info("draining in-flight match tasks", inflight=len(inflight))
        if inflight:
            await asyncio.gather(*inflight, return_exceptions=True)
        for t in (sysmetrics_task, depth_task, heartbeat_task, autoclaim_task):
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        if gallery is not None:
            await gallery.aclose()
        await enrolled.close()
        if appearance is not None:
            await appearance.close()
        await bus.close()
        shutdown_tracing()
        log.info("match worker stopped")


if __name__ == "__main__":
    asyncio.run(run_worker())
