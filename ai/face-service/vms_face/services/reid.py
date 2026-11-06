"""Cross-camera ReID service.

Given a freshly-detected appearance (track_id, camera_id, embedding,
occurred_at), find recent appearances on *other* cameras whose embedding
cosine-matches above the configured threshold and emit `track_links` rows
joining them. Persisted links form an undirected graph whose connected
components are interpreted as a single global identity.

This is a face-similarity-only ReID (not person-body). For face-only
campus surveillance with frontal/quasi-frontal views it's sufficient.
A body ReID model (OSNet etc.) is the natural next layer; the data flow
here is structured so that adding a body track-link writer alongside
emits compatible rows.
"""
from __future__ import annotations
import datetime as dt
import uuid
from typing import Any

from qdrant_client.http.models import FieldCondition, Range
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.domain.models import DetectionEvent, TrackLink
from vms_face.infra.qdrant import QdrantStore

log = get_logger(__name__)


async def find_cross_camera_matches(
    appearance: QdrantStore,
    *,
    tenant_id: uuid.UUID,
    embedding: list[float],
    camera_id: uuid.UUID,
    occurred_at: dt.datetime,
    top_k: int | None = None,
    window_sec: int | None = None,
    threshold: float | None = None,
    same_camera_dedup_sec: int | None = None,
) -> list[dict[str, Any]]:
    """Return appearance points (in the past `window_sec` seconds) that:
      * belong to the same tenant
      * cosine-match above `threshold`
      * occurred on a *different* camera, OR the same camera but more than
        `same_camera_dedup_sec` ago (intra-camera tracks are merged by
        the local Kalman tracker, so we don't want to double-count)
    """
    top_k = top_k or settings.reid_top_k
    window_sec = window_sec or settings.reid_window_sec
    threshold = threshold if threshold is not None else settings.reid_min_similarity
    same_camera_dedup_sec = (
        same_camera_dedup_sec
        if same_camera_dedup_sec is not None
        else settings.reid_same_camera_dedup_sec
    )

    since_ts = int((occurred_at - dt.timedelta(seconds=window_sec)).timestamp())
    upper_ts = int(occurred_at.timestamp())

    extra = [
        FieldCondition(key="occurred_at_ts", range=Range(gte=since_ts, lte=upper_ts))
    ]

    raw = await appearance.search(
        tenant_id=tenant_id,
        vector=embedding,
        top_k=top_k,
        score_threshold=threshold,
        extra_must=extra,
    )

    out: list[dict[str, Any]] = []
    for r in raw:
        payload = r["payload"] or {}
        cand_camera = payload.get("camera_id")
        cand_ts = payload.get("occurred_at_ts")
        if cand_camera is None:
            continue
        # Same-camera dedup: only allow if the candidate is older than the
        # dedup window (older same-camera reappearances *might* be a
        # missed-tracker re-id and we want to surface them).
        if str(cand_camera) == str(camera_id):
            if cand_ts is None or upper_ts - int(cand_ts) < same_camera_dedup_sec:
                continue
        out.append(r)
    return out


async def emit_track_link(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    a_track_id: str,
    a_camera_id: uuid.UUID,
    a_event_id: uuid.UUID | None,
    a_occurred_at: dt.datetime,
    b_track_id: str,
    b_camera_id: uuid.UUID,
    b_event_id: uuid.UUID | None,
    b_occurred_at: dt.datetime,
    similarity: float,
    person_id: uuid.UUID | None = None,
    metadata: dict[str, Any] | None = None,
) -> bool:
    """Idempotent insert. Returns True if a new row was created.

    We canonicalize the pair so (a, b) and (b, a) collapse: the older
    sighting becomes `a`, the newer becomes `b`. This keeps the unique
    constraint deterministic regardless of which side called us first."""
    if a_occurred_at > b_occurred_at:
        a_track_id, b_track_id = b_track_id, a_track_id
        a_camera_id, b_camera_id = b_camera_id, a_camera_id
        a_event_id, b_event_id = b_event_id, a_event_id
        a_occurred_at, b_occurred_at = b_occurred_at, a_occurred_at

    if a_track_id == b_track_id and a_camera_id == b_camera_id:
        return False

    stmt = (
        pg_insert(TrackLink)
        .values(
            id=uuid.uuid4(),
            tenant_id=tenant_id,
            a_track_id=a_track_id,
            a_camera_id=a_camera_id,
            a_event_id=a_event_id,
            a_occurred_at=a_occurred_at,
            b_track_id=b_track_id,
            b_camera_id=b_camera_id,
            b_event_id=b_event_id,
            b_occurred_at=b_occurred_at,
            similarity=float(similarity),
            link_kind="cosine_face",
            person_id=person_id,
            metadata_json=metadata or {},
        )
        .on_conflict_do_nothing(
            index_elements=[
                "a_track_id", "a_camera_id", "b_track_id", "b_camera_id",
            ]
        )
    )
    try:
        result = await session.execute(stmt)
        await session.flush()
        return bool(result.rowcount or 0)
    except IntegrityError:
        await session.rollback()
        return False


async def expand_global_identity(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    seed_track_id: str,
    seed_camera_id: uuid.UUID,
    max_depth: int = 5,
) -> list[tuple[str, uuid.UUID]]:
    """BFS over the track_links graph from a seed (track_id, camera_id),
    returning every (track_id, camera_id) in the same connected component.

    Bounded by `max_depth` hops to keep query time reasonable on a busy
    deployment (a true global identity rarely needs more than 2-3 hops in
    a 10-minute window)."""
    seen: set[tuple[str, str]] = {(seed_track_id, str(seed_camera_id))}
    frontier: list[tuple[str, uuid.UUID]] = [(seed_track_id, seed_camera_id)]
    for _ in range(max_depth):
        if not frontier:
            break
        next_frontier: list[tuple[str, uuid.UUID]] = []
        for tid, cid in frontier:
            rows = await session.execute(
                select(
                    TrackLink.a_track_id,
                    TrackLink.a_camera_id,
                    TrackLink.b_track_id,
                    TrackLink.b_camera_id,
                ).where(
                    TrackLink.tenant_id == tenant_id,
                    (
                        ((TrackLink.a_track_id == tid) & (TrackLink.a_camera_id == cid))
                        | ((TrackLink.b_track_id == tid) & (TrackLink.b_camera_id == cid))
                    ),
                )
            )
            for at, ac, bt, bc in rows:
                for cand in ((at, ac), (bt, bc)):
                    key = (cand[0], str(cand[1]))
                    if key in seen:
                        continue
                    seen.add(key)
                    next_frontier.append(cand)
        frontier = next_frontier

    out: list[tuple[str, uuid.UUID]] = []
    for tid, cid in seen:
        out.append((tid, uuid.UUID(cid)))
    return out


async def lookup_recent_event_id(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    camera_id: uuid.UUID,
    track_id: str,
    around: dt.datetime,
    window_sec: int = 60,
) -> uuid.UUID | None:
    """Best-effort lookup of the DetectionEvent row that produced this
    track's most recent appearance — used to populate `a_event_id`/
    `b_event_id` so the UI can pivot from a link to the underlying event."""
    lo = around - dt.timedelta(seconds=window_sec)
    hi = around + dt.timedelta(seconds=window_sec)
    rows = await session.execute(
        select(DetectionEvent.id)
        .where(
            DetectionEvent.tenant_id == tenant_id,
            DetectionEvent.camera_id == camera_id,
            DetectionEvent.track_id == track_id,
            DetectionEvent.occurred_at >= lo,
            DetectionEvent.occurred_at <= hi,
        )
        .order_by(DetectionEvent.occurred_at.desc())
        .limit(1)
    )
    row = rows.first()
    return row[0] if row else None
