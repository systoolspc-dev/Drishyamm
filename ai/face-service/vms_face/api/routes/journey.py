from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import time
import uuid
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import (
    current_tenant_id,
    db_session,
    operator_id,
    qdrant_appearance,
    recognizer,
    runtime,
)
from vms_face.config import settings
from vms_face.core.exceptions import InferenceError
from vms_face.domain.enums import EventKind
from vms_face.domain.models import Camera, DetectionEvent, Person
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.qdrant import QdrantStore
from vms_face.infra.recognizers import Recognizer
from vms_face.journey import body as jbody
from vms_face.journey import embed as jembed
from vms_face.journey import fusion as jfusion
from vms_face.journey import geo as jgeo
from vms_face.journey import pdf as jpdf
from vms_face.journey import stitch_jobs
from vms_face.journey.cluster import collapse
from vms_face.journey.contracts import (
    Candidate,
    ClusterRequest,
    ClusterResponse,
    JobCreateResponse,
    JobStatus,
    JobStatusResponse,
    SearchResponse,
    StitchRequest,
)
from vms_face.journey.search import query_appearance
from vms_face.journey.window import parse_window_or_default
from vms_face.services import audit as audit_log
from vms_face.services.reid import expand_global_identity

router = APIRouter(prefix="/journey", tags=["journey"])

# Forensic-search defaults (person-tracker parity). Overridable via settings.
_DEFAULT_WINDOW = getattr(settings, "journey_default_window", "7d")
_DEFAULT_THRESHOLD = float(getattr(settings, "journey_similarity_threshold", 0.50))
_DEFAULT_TOP_K = int(getattr(settings, "journey_search_top_k", 5000))
# Burned-in clock labels (time_label / first_seen_label) must be IST regardless
# of which container renders them — the stitch worker runs UTC, so a bare
# .astimezone() rendered those labels 5:30 behind. Pin the display zone.
_DISPLAY_TZ = ZoneInfo(getattr(settings, "display_timezone", "Asia/Kolkata"))


@router.get("/map")
async def journey_map(
    person_id: uuid.UUID | None = Query(None),
    q: str | None = Query(None, description="Resolve a person by name/external ID, then return their journey"),
    camera_id: uuid.UUID | None = Query(None, description="Seed camera for track-based re-id journey"),
    track_id: str | None = Query(None, description="Seed track for track-based re-id journey"),
    since_hours: int = Query(24, ge=1, le=24 * 30),
    limit: int = Query(250, ge=1, le=1000),
    max_depth: int = Query(5, ge=1, le=20),
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    started = time.perf_counter()
    since = dt.datetime.now(dt.UTC) - dt.timedelta(hours=since_hours)
    query = _clean_query(q)

    mode = "latest"
    subject: Person | None = None
    seed: dict[str, Any] | None = None
    events: list[dict[str, Any]] = []

    if camera_id is not None or track_id:
        if camera_id is None or not track_id:
            raise HTTPException(400, "camera_id and track_id are both required for track journey")
        mode = "track"
        cam = await session.get(Camera, camera_id)
        if cam is None:
            raise HTTPException(404, "seed camera not found")
        # Seed camera must belong to the caller's tenant; cross-tenant journey
        # construction was the original tenancy hole.
        if cam.tenant_id != tenant_id:
            raise HTTPException(404, "seed camera not found")
        seed_tenant_id = tenant_id
        members = await expand_global_identity(
            session,
            tenant_id=seed_tenant_id,
            seed_track_id=track_id,
            seed_camera_id=camera_id,
            max_depth=max_depth,
        )
        events = await _events_for_members(session, tenant_id=seed_tenant_id, members=members, since=since, limit=limit)
        subject = await _subject_from_events(session, events)
        seed = {"camera_id": str(camera_id), "track_id": track_id, "members": len(members)}
    else:
        if person_id is not None:
            mode = "person"
            subject = await session.get(Person, person_id)
            if subject is None:
                raise HTTPException(404, "person not found")
        elif query:
            mode = "search"
            subject = await _resolve_person(session, q=query, tenant_id=tenant_id)
        else:
            subject = await _latest_person_with_events(session, tenant_id=tenant_id, since=since)

        if subject is not None:
            events = await _events_for_person(session, person_id=subject.id, since=since, limit=limit)

    stops = _events_to_stops(events)
    timeline = _stops_to_timeline(stops)
    summary = _summary(stops, event_count=len(events), subject=subject, search_ms=(time.perf_counter() - started) * 1000)

    await audit_log.record(
        actor=f"user:{actor}",
        actor_kind="user",
        action="journey_map",
        tenant_id=subject.tenant_id if subject else tenant_id,
        target_type="person" if subject else "track",
        target_id=str(subject.id) if subject else track_id,
        reason="journey mapping",
        metadata={
            "mode": mode,
            "q": query,
            "camera_id": str(camera_id) if camera_id else None,
            "track_id": track_id,
            "events": len(events),
            "stops": len(stops),
            "since_hours": since_hours,
            "search_ms": summary["search_ms"],
        },
    )

    return {
        "mode": mode,
        "query": query,
        "seed": seed,
        "subject": _subject_payload(subject),
        "summary": summary,
        "stops": stops,
        "timeline": timeline,
        "raw_event_count": len(events),
    }


async def _resolve_person(session: AsyncSession, *, q: str, tenant_id: uuid.UUID | None) -> Person | None:
    like = f"%{q}%"
    filters = [
        Person.is_active.is_(True),
        or_(Person.full_name.ilike(like), Person.external_id.ilike(like)),
    ]
    if tenant_id is not None:
        filters.append(Person.tenant_id == tenant_id)
    row = await session.execute(select(Person).where(*filters).order_by(Person.full_name.asc()).limit(1))
    return row.scalars().first()


async def _latest_person_with_events(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID | None,
    since: dt.datetime,
) -> Person | None:
    stmt = (
        select(Person)
        .join(DetectionEvent, DetectionEvent.person_id == Person.id)
        .where(Person.is_active.is_(True), DetectionEvent.occurred_at >= since)
        .order_by(desc(DetectionEvent.occurred_at))
        .limit(1)
    )
    if tenant_id is not None:
        stmt = stmt.where(Person.tenant_id == tenant_id)
    row = await session.execute(stmt)
    return row.scalars().first()


async def _events_for_person(
    session: AsyncSession,
    *,
    person_id: uuid.UUID,
    since: dt.datetime,
    limit: int,
) -> list[dict[str, Any]]:
    rows = await session.execute(
        select(
            DetectionEvent,
            Camera.id.label("cam_id"),
            Camera.code,
            Camera.name,
            Camera.location,
            Camera.zone,
        )
        .outerjoin(Camera, Camera.id == DetectionEvent.camera_id)
        .where(DetectionEvent.person_id == person_id, DetectionEvent.occurred_at >= since)
        .order_by(DetectionEvent.occurred_at.asc())
        .limit(limit)
    )
    return [_event_row(row) for row in rows.all()]


async def _events_for_members(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    members: list[tuple[str, uuid.UUID]],
    since: dt.datetime,
    limit: int,
) -> list[dict[str, Any]]:
    if not members:
        return []
    member_filter = or_(
        *[
            and_(DetectionEvent.track_id == track, DetectionEvent.camera_id == camera)
            for track, camera in members
        ]
    )
    rows = await session.execute(
        select(
            DetectionEvent,
            Camera.id.label("cam_id"),
            Camera.code,
            Camera.name,
            Camera.location,
            Camera.zone,
        )
        .outerjoin(Camera, Camera.id == DetectionEvent.camera_id)
        .where(
            DetectionEvent.tenant_id == tenant_id,
            DetectionEvent.occurred_at >= since,
            member_filter,
        )
        .order_by(DetectionEvent.occurred_at.asc())
        .limit(limit)
    )
    return [_event_row(row) for row in rows.all()]


async def _subject_from_events(session: AsyncSession, events: list[dict[str, Any]]) -> Person | None:
    for event in reversed(events):
        person_id = event.get("person_id")
        if person_id:
            return await session.get(Person, uuid.UUID(str(person_id)))
    return None


def _event_row(row: Any) -> dict[str, Any]:
    ev: DetectionEvent = row[0]
    camera_id = row.cam_id or ev.camera_id
    return {
        "event_id": str(ev.id),
        "tenant_id": str(ev.tenant_id),
        "person_id": str(ev.person_id) if ev.person_id else None,
        "camera_id": str(camera_id),
        "camera_code": row.code,
        "camera_name": row.name,
        "location": row.location,
        "zone": row.zone,
        "track_id": ev.track_id,
        "kind": ev.kind.value,
        "similarity": float(ev.similarity) if ev.similarity is not None else None,
        "quality_score": float(ev.quality_score) if ev.quality_score is not None else None,
        "snapshot_uri": ev.snapshot_uri,
        "bbox": ev.bbox,
        "occurred_at": ev.occurred_at,
    }


def _events_to_stops(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stops: list[dict[str, Any]] = []
    camera_aliases: dict[str, str] = {}
    for event in events:
        camera_id = event["camera_id"]
        if stops and stops[-1]["camera_id"] == camera_id:
            stops[-1]["last_seen_at"] = _iso(event["occurred_at"])
            stops[-1]["event_count"] += 1
            stops[-1]["duration_sec"] = _duration_sec(stops[-1]["first_seen_at"], stops[-1]["last_seen_at"])
            stops[-1]["latest_event_id"] = event["event_id"]
            stops[-1]["latest_kind"] = event["kind"]
            if event.get("snapshot_uri"):
                stops[-1]["snapshot_uri"] = event["snapshot_uri"]
            if event["kind"] == EventKind.ALERT.value:
                stops[-1]["type"] = "alert"
            stops[-1]["note"] = _stop_note(stops[-1])
            continue

        label = _camera_label(event, camera_aliases)
        zone = _area_label(event)
        point = _map_point(camera_id, len(stops))
        kind = event["kind"]
        stop = {
            "camera_id": camera_id,
            "camera_code": event.get("camera_code"),
            "camera_name": event.get("camera_name"),
            "label": label,
            "zone": zone,
            "type": "alert" if kind == EventKind.ALERT.value else "start" if not stops else "normal",
            "first_seen_at": _iso(event["occurred_at"]),
            "last_seen_at": _iso(event["occurred_at"]),
            "duration_sec": 0,
            "event_count": 1,
            "track_id": event.get("track_id"),
            "latest_event_id": event.get("event_id"),
            "latest_kind": kind,
            "snapshot_uri": event.get("snapshot_uri"),
            "x": point["x"],
            "y": point["y"],
        }
        stop["note"] = _stop_note(stop)
        stops.append(stop)
    return stops


def _stops_to_timeline(stops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "event_id": stop.get("latest_event_id"),
            "camera_id": stop["camera_id"],
            "camera": stop["label"],
            "zone": stop["zone"],
            "track_id": stop.get("track_id"),
            "kind": stop.get("latest_kind"),
            "type": stop["type"],
            "time": stop["last_seen_at"],
            "time_label": _time_label(stop.get("last_seen_at")),
            "first_seen_at": stop.get("first_seen_at"),
            "last_seen_at": stop.get("last_seen_at"),
            "duration_sec": stop.get("duration_sec", 0),
            "duration_label": _duration_label(int(stop.get("duration_sec") or 0)),
            "event_count": stop.get("event_count", 0),
            "snapshot_uri": stop.get("snapshot_uri"),
            "note": stop["note"],
        }
        for stop in reversed(stops)
    ]


def _summary(
    stops: list[dict[str, Any]],
    event_count: int,
    subject: Person | None,
    *,
    search_ms: float,
) -> dict[str, Any]:
    first = stops[0]["first_seen_at"] if stops else None
    last = stops[-1]["last_seen_at"] if stops else None
    return {
        "first_seen_at": first,
        "first_seen_label": _time_label(first),
        "last_seen_at": last,
        "last_seen_label": _relative_time(last),
        "cameras_visited": len({stop["camera_id"] for stop in stops}),
        "stops": len(stops),
        "events": int(event_count),
        "total_duration_sec": _duration_sec(first, last),
        "total_duration_label": _duration_label(_duration_sec(first, last)),
        "alerts": len([item for item in stops if item.get("type") == "alert"]),
        "identity": "Known" if subject else "Unknown",
        "search_ms": round(search_ms, 1),
    }


def _subject_payload(subject: Person | None) -> dict[str, Any] | None:
    if subject is None:
        return None
    metadata = subject.metadata_json or {}
    return {
        "id": str(subject.id),
        "tenant_id": str(subject.tenant_id),
        "external_id": subject.external_id,
        "full_name": subject.full_name,
        "role": subject.role.value,
        "role_label": subject.role.value.replace("_", " ").title(),
        "department": _metadata_text(metadata, "department", "dept", "course", "class", default="Not assigned"),
        "group": _metadata_text(metadata, "group", "batch", "designation", default=None),
        "is_active": subject.is_active,
        "metadata": metadata,
    }


def _camera_label(event: dict[str, Any], camera_aliases: dict[str, str]) -> str:
    camera_id = str(event.get("camera_id") or "")
    for value in (event.get("camera_name"), event.get("camera_code")):
        if _is_human_camera_label(value):
            return str(value).strip()
    if camera_id not in camera_aliases:
        camera_aliases[camera_id] = f"Camera {len(camera_aliases) + 1:02d}"
    return camera_aliases[camera_id]


def _area_label(event: dict[str, Any]) -> str:
    for value in (event.get("zone"), event.get("location")):
        if value is not None and str(value).strip():
            return str(value).strip()
    return "Area not mapped"


def _stop_note(stop: dict[str, Any]) -> str:
    camera = stop.get("label") or "this camera"
    area = stop.get("zone") or "this area"
    count = int(stop.get("event_count") or 0)
    duration = _duration_label(int(stop.get("duration_sec") or 0))
    if stop.get("type") == "alert":
        return f"Needs review at {camera} in {area}"
    if count <= 1:
        return f"Seen once at {camera}"
    if duration == "0 sec":
        return f"Seen {count} times at {camera}"
    return f"Seen {count} times at {camera} over {duration}"


def _is_human_camera_label(value: Any) -> bool:
    if value is None:
        return False
    text = str(value).strip()
    if not text:
        return False
    compact = text.replace("-", "").replace("_", "")
    if len(compact) >= 16 and all(ch in "0123456789abcdefABCDEF" for ch in compact):
        return False
    if text.lower() in {"unknown", "none", "null"}:
        return False
    return True


def _map_point(camera_id: str, index: int) -> dict[str, int]:
    digest = hashlib.sha1(camera_id.encode("utf-8")).digest()
    x = 12 + digest[0] % 76
    y = 20 + digest[1] % 62
    # Keep very long routes readable by gently advancing repeated points.
    x = max(10, min(90, x + (index % 4) * 2 - 3))
    y = max(14, min(86, y + (index % 3) * 2 - 2))
    return {"x": x, "y": y}


def _duration_sec(start: str | None, end: str | None) -> int:
    if not start or not end:
        return 0
    try:
        a = dt.datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        b = dt.datetime.fromisoformat(str(end).replace("Z", "+00:00"))
        return max(0, int((b - a).total_seconds()))
    except Exception:
        return 0


def _duration_label(seconds: int) -> str:
    if seconds <= 0:
        return "0 sec"
    if seconds < 60:
        return f"{seconds} sec"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min"
    hours = minutes // 60
    return f"{hours} hr {minutes % 60} min"


def _relative_time(value: str | dt.datetime | None) -> str:
    if value is None:
        return "No sightings"
    if isinstance(value, str):
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return value
    else:
        parsed = value
    age = dt.datetime.now(dt.UTC) - _ensure_aware(parsed)
    seconds = max(0, int(age.total_seconds()))
    if seconds < 60:
        return "Live now"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} hr ago"
    days = hours // 24
    return f"{days} day ago" if days == 1 else f"{days} days ago"


def _time_label(value: str | dt.datetime | None) -> str:
    if value is None:
        return "--"
    if isinstance(value, str):
        try:
            value = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return value
    return _ensure_aware(value).astimezone(_DISPLAY_TZ).strftime("%I:%M %p").lstrip("0")
 

def _iso(value: dt.datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return _ensure_aware(value).isoformat().replace("+00:00", "Z")


def _ensure_aware(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=dt.UTC)
    return value.astimezone(dt.UTC)


def _metadata_text(metadata: dict[str, Any], *keys: str, default: str | None) -> str | None:
    for key in keys:
        value = metadata.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default


def _clean_query(value: str | None) -> str:
    if not value:
        return ""
    return " ".join(value.strip().split())[:128]


# ─────────────────────────────────────────────────────────────────────────────
# Forensic journey (centralized from person-tracker). Upload a face photo →
# embed in-process → ANN over vms_appearance → candidates → cluster → sightings.
# Cross-camera fusion (body + gates) and stitch land in P1b–P1d.
# ─────────────────────────────────────────────────────────────────────────────
def _parse_camera_ids(raw: str) -> list[uuid.UUID] | None:
    out: list[uuid.UUID] = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(uuid.UUID(part))
        except ValueError:
            raise HTTPException(400, f"invalid camera id {part!r}")
    return out or None


async def _attach_camera_codes(session: AsyncSession, candidates: list[dict]) -> None:
    """Enrich candidate dicts with the human camera code+name and the snapshot
    crop. The Qdrant appearance payload carries camera_id and event_id but NOT
    the camera name or snapshot_uri (the live pipeline writes those only to
    detection_events), so resolve both from Postgres in two batched queries."""
    if not candidates:
        return

    # 1) camera code + human name (so the UI shows "office 13 - Camera 03",
    #    not the raw monitor_id).
    cam_ids = {c["camera_id"] for c in candidates}
    rows = await session.execute(
        select(Camera.id, Camera.code, Camera.name).where(Camera.id.in_(cam_ids))
    )
    meta_by_id = {row[0]: (row[1], row[2]) for row in rows.all()}
    for c in candidates:
        code, name = meta_by_id.get(c["camera_id"], (None, None))
        if c.get("camera_code") is None:
            c["camera_code"] = code
        if c.get("camera_name") is None:
            c["camera_name"] = name

    # 2) snapshot crop — join event_id → detection_events.snapshot_uri for the
    #    candidates whose payload didn't already carry one (the common case for
    #    live appearances).
    event_ids: set[uuid.UUID] = set()
    for c in candidates:
        if not c.get("snapshot_uri") and c.get("event_id"):
            try:
                event_ids.add(uuid.UUID(str(c["event_id"])))
            except (ValueError, TypeError):
                continue
    if event_ids:
        rows = await session.execute(
            select(DetectionEvent.id, DetectionEvent.snapshot_uri).where(
                DetectionEvent.id.in_(event_ids)
            )
        )
        snap_by_event = {row[0]: row[1] for row in rows.all()}
        for c in candidates:
            if c.get("snapshot_uri"):
                continue
            try:
                ev = uuid.UUID(str(c["event_id"])) if c.get("event_id") else None
            except (ValueError, TypeError):
                ev = None
            if ev is not None:
                c["snapshot_uri"] = snap_by_event.get(ev)


@router.post("/search", response_model=SearchResponse)
async def journey_search(
    file: UploadFile = File(..., description="Face photo (JPEG/PNG)"),
    window_start: str | None = Form(default=None),
    window_end: str | None = Form(default=None),
    min_similarity: float | None = Form(default=None),
    camera_ids: str = Form(default=""),
    # Restrict the journey to specific cameras by their code/monitor_id (the
    # backend passes journey-enabled cameras here so the per-camera "Journey
    # mapping" toggle actually scopes the search). Resolved to UUIDs below.
    camera_codes: str = Form(default=""),
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
    appearance: QdrantStore | None = Depends(qdrant_appearance),
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> SearchResponse:
    if appearance is None:
        raise HTTPException(503, "appearance search is disabled (qdrant_appearance_enabled=false)")

    image_bytes = await file.read()
    try:
        query = jembed.embed_query_face(image_bytes, rt=rt, rec=rec)
    except jembed.NoFaceError as e:
        raise HTTPException(422, str(e)) from e
    except InferenceError as e:
        raise HTTPException(400, str(e)) from e

    start, end = parse_window_or_default(window_start, window_end, _DEFAULT_WINDOW)
    threshold = min_similarity if min_similarity is not None else _DEFAULT_THRESHOLD
    cam_filter = _parse_camera_ids(camera_ids) or []
    # Resolve any camera codes (monitor_ids) to this tenant's Camera UUIDs and
    # union into the filter — this is how the "Journey mapping" toggle scopes search.
    codes = [c.strip() for c in (camera_codes or "").split(",") if c.strip()]
    if codes:
        rows = await session.execute(
            select(Camera.id).where(Camera.tenant_id == tenant_id, Camera.code.in_(codes))
        )
        cam_filter.extend(r[0] for r in rows.all())
    cam_filter = list(dict.fromkeys(cam_filter)) or None  # dedupe; None = all cameras

    raw = await query_appearance(
        appearance,
        tenant_id=tenant_id,
        embedding=query.embedding,
        window_start=start,
        window_end=end,
        min_similarity=threshold,
        camera_ids=cam_filter,
        top_k=_DEFAULT_TOP_K,
    )
    await _attach_camera_codes(session, raw)
    body_used = _fuse_body(image_bytes, query.bbox, raw)
    raw.sort(key=lambda c: c["similarity"], reverse=True)
    candidates = [Candidate(**c) for c in raw]

    await audit_log.record(
        actor=f"user:{actor}",
        actor_kind="user",
        action="journey_search",
        tenant_id=tenant_id,
        target_type="journey",
        target_id=None,
        reason="forensic journey search",
        metadata={
            "candidates": len(candidates),
            "window_start": start.isoformat(),
            "window_end": end.isoformat(),
            "threshold": threshold,
            "cameras": [str(c) for c in cam_filter] if cam_filter else None,
        },
    )

    return SearchResponse(
        query_face_quality=query.det_score,
        candidates=candidates,
        window_start=start,
        window_end=end,
        total_matched=len(candidates),
        body_used=body_used,
    )


def _pose_face_confidence(yaw) -> float:
    """How much to trust a face embedding given its yaw (degrees). Frontal (≤20°)
    → 1.0; full profile (≥60°) → 0.35; linear between. Missing pose → assume
    frontal. Used to shift fusion weight from face to body for side-on faces."""
    if yaw is None:
        return 1.0
    a = abs(float(yaw))
    if a <= 20.0:
        return 1.0
    if a >= 60.0:
        return 0.35
    return 1.0 - (a - 20.0) / 40.0 * 0.65


def _fuse_body(image_bytes: bytes, face_bbox: list[float] | None, raw: list[dict]) -> bool:
    """Pose-aware face+body fusion. Extracts the query photo's clothing colour AND
    its OSNet body embedding, then for each candidate blends the face cosine
    (down-weighted when that candidate's face is profile) with the body signal
    (OSNet cosine + clothing-colour agreement). So a side/occluded face with a
    strong body match stays ranked high — the real-world case where face-only
    loses people — while frontal faces stay face-driven. Returns whether any body
    signal contributed."""
    weights = jfusion.FusionWeights.from_settings()
    try:
        import numpy as np

        from vms_face.services.enrollment import _decode_image
        # Shared decoder: HEIC/HEIF (iPhone) fall back to PIL, matching the
        # query-face path — body fusion must see the same formats search does.
        frame = _decode_image(image_bytes)
    except Exception:
        frame = None
        np = None
    q_attrs = jbody.extract_clothing(frame, face_bbox=face_bbox) if frame is not None else jbody.BodyAttributes()

    # Query OSNet body embedding over the person region anchored on the query face.
    q_body = None
    if frame is not None and face_bbox is not None and np is not None:
        be = jbody.BodyEmbedder.shared()
        if be.enabled:
            fh, fw = frame.shape[:2]
            qb = be.embed(frame, person_bbox=jbody.person_bbox_from_face(face_bbox, fw, fh))
            if qb is not None:
                q_body = np.asarray(qb, dtype=np.float32)

    body_used = False
    for c in raw:
        face_sim = c["similarity"]
        # OSNet body cosine — both vectors are L2-normalised, so dot == cosine.
        osnet_sim = None
        cb = c.get("body_vec")
        if q_body is not None and cb and np is not None:
            try:
                osnet_sim = float(np.dot(q_body, np.asarray(cb, dtype=np.float32)))
            except Exception:
                osnet_sim = None
        cand_attrs = jbody.BodyAttributes.from_payload(c)
        colour_sim = jbody.colour_similarity(q_attrs, cand_attrs)
        bterm = jfusion.body_term(osnet_sim, colour_sim, weights)

        fc = _pose_face_confidence(c.get("yaw"))
        c["face_similarity"] = face_sim
        c["body_similarity"] = bterm
        c["face_confidence"] = round(fc, 3)
        if bterm is None:
            c["similarity"] = face_sim  # no body signal — can't rescue a profile face
        else:
            # Pose-aware reweighting: the face weight lost to a profile face is
            # reallocated to the body term.
            wf = weights.w_face * fc
            wb = weights.w_body + weights.w_face * (1.0 - fc)
            denom = wf + wb
            c["similarity"] = (wf * face_sim + wb * bterm) / denom if denom else face_sim
            body_used = True
        c.pop("body_vec", None)  # strip the bulky vector before API/cluster
    return body_used


@router.post("/cluster", response_model=ClusterResponse)
async def journey_cluster(req: ClusterRequest) -> ClusterResponse:
    """Collapse raw candidates into per-camera sightings (sync, cheap)."""
    return ClusterResponse(sightings=collapse(req.candidates, window_sec=req.window_sec))


# ─────────────────────────────────────────────────────────────────────────────
# Stitch: render a journey video (MP4 + PDF + map) from sightings. Async enqueue
# to the RQ stitch worker; poll status; artifacts served via presigned MinIO URLs.
# ─────────────────────────────────────────────────────────────────────────────
async def _validate_and_stamp_cameras(
    session: AsyncSession, tenant_id: uuid.UUID, sightings: list[dict]
) -> None:
    """Reject sightings whose cameras don't belong to the caller's tenant
    (cross-tenant guard), and stamp each with camera_code (the MediaMTX
    monitor_id the worker needs to find recordings)."""
    cam_ids: set[uuid.UUID] = set()
    for s in sightings:
        try:
            cam_ids.add(uuid.UUID(str(s["camera_id"])))
        except (KeyError, ValueError):
            raise HTTPException(400, "every sighting needs a valid camera_id")
    rows = await session.execute(
        select(Camera.id, Camera.code).where(Camera.id.in_(cam_ids), Camera.tenant_id == tenant_id)
    )
    code_by_id = {r[0]: r[1] for r in rows.all()}
    if any(cid not in code_by_id for cid in cam_ids):
        # Generic message — do NOT echo which camera ids exist/belong elsewhere
        # (that would let a caller enumerate cameras across tenants).
        raise HTTPException(403, "access denied to one or more cameras")
    for s in sightings:
        s["camera_code"] = code_by_id[uuid.UUID(str(s["camera_id"]))]


async def _get_owned_job(job_id: uuid.UUID, tenant_id: uuid.UUID) -> dict:
    """Fetch a stitch job and enforce tenant ownership. Returns 404 (not 403)
    on a missing OR cross-tenant job so job existence is never leaked."""
    job = await stitch_jobs.get_job(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    req = json.loads(job.get("request") or "{}")
    if req.get("tenant_id") != str(tenant_id):
        raise HTTPException(404, "job not found")
    return job


@router.post("/stitch", response_model=JobCreateResponse, status_code=202)
async def enqueue_stitch(
    req: StitchRequest,
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> JobCreateResponse:
    if not req.sightings:
        raise HTTPException(400, "no sightings to stitch")

    sightings = [s.model_dump(mode="json") for s in req.sightings]
    await _validate_and_stamp_cameras(session, tenant_id, sightings)

    job_id = uuid.uuid4()
    payload = {
        "sightings": sightings,
        "include_overlays": req.include_overlays,
        "include_intro_card": req.include_intro_card,
        "person_id": str(req.person_id) if req.person_id else None,
        # Stamped server-side from the authenticated principal — the worker
        # trusts these for tenant attribution, so they MUST come from the JWT.
        "tenant_id": str(tenant_id),
        "created_by": actor,
    }
    await stitch_jobs.create_job(job_id, payload)
    await audit_log.record(
        actor=f"user:{actor}", actor_kind="user", action="journey_stitch_enqueue",
        tenant_id=tenant_id, target_type="journey", target_id=str(job_id),
        reason="forensic journey stitch", metadata={"sightings": len(sightings)},
    )
    return JobCreateResponse(job_id=job_id, status=JobStatus.queued, poll_url=f"/journey/stitch/{job_id}")


@router.get("/stitch/{job_id}", response_model=JobStatusResponse)
async def stitch_status(
    job_id: uuid.UUID, tenant_id: uuid.UUID = Depends(current_tenant_id)
) -> JobStatusResponse:
    job = await _get_owned_job(job_id, tenant_id)
    return JobStatusResponse(**job)


@router.get("/stitch/{job_id}/video")
async def stitch_video(job_id: uuid.UUID, tenant_id: uuid.UUID = Depends(current_tenant_id)):
    job = await _get_owned_job(job_id, tenant_id)
    if job.get("status") != "done":
        raise HTTPException(409, "video not ready")
    video_key = job.get("video_key")
    if not video_key:
        raise HTTPException(404, "no video for this job")
    # Stream the bytes through the API — do NOT 302 to a presigned MinIO URL.
    # The browser cannot resolve the internal `minio:9000` host, so a redirect
    # breaks both playback and download. Same reasoning as /journey/snapshot.
    store = get_object_store()
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(
            None, lambda: store.get_bytes(settings.minio_bucket_output, video_key)
        )
    except Exception:
        raise HTTPException(404, "video file not found")
    return Response(
        content=data,
        media_type="video/mp4",
        headers={
            "Content-Disposition": f'inline; filename="journey-{job_id}.mp4"',
            "Content-Length": str(len(data)),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=300",
        },
    )


@router.get("/stitch/{job_id}/report.pdf")
async def stitch_report(job_id: uuid.UUID, tenant_id: uuid.UUID = Depends(current_tenant_id)):
    job = await _get_owned_job(job_id, tenant_id)
    if job.get("status") != "done":
        raise HTTPException(409, "report not ready")
    store = get_object_store()
    report_key = f"reports/{job_id}.pdf"
    loop = asyncio.get_event_loop()
    if not store.object_exists(settings.minio_bucket_output, report_key):
        # Render on demand off the event loop (ReportLab + MinIO are blocking).
        await loop.run_in_executor(None, lambda: jpdf.render_for_job(job, key=report_key))
    # Relay bytes (not a presigned redirect) — the browser can't reach internal MinIO.
    try:
        data = await loop.run_in_executor(
            None, lambda: store.get_bytes(settings.minio_bucket_output, report_key)
        )
    except Exception:
        raise HTTPException(404, "report not found")
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="journey-{job_id}.pdf"',
            "Cache-Control": "private, max-age=300",
        },
    )


@router.get("/stitch/{job_id}/map.json")
async def stitch_map(
    job_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    job = await _get_owned_job(job_id, tenant_id)
    return await jgeo.build_path(job, session=session)


@router.get("/snapshot")
async def journey_snapshot(
    uri: str = Query(..., description="s3:// snapshot uri to stream"),
    _tenant_id: uuid.UUID = Depends(current_tenant_id),  # authn gate
):
    """Stream a snapshot crop from MinIO by its s3:// uri (replaces the former
    person-tracker /snapshot). Restricted to the known snapshot/output buckets so
    it can't be used to read arbitrary objects; the browser can't reach internal
    MinIO directly, so we relay the bytes (not a presigned redirect)."""
    store = get_object_store()
    bucket, key = store.parse_s3_uri(uri)
    if not bucket or not key:
        raise HTTPException(400, "invalid snapshot uri")
    allowed = {
        settings.minio_bucket_snapshots,
        settings.minio_bucket_output,
        settings.minio_bucket_enrollments,
    }
    if bucket not in allowed:
        raise HTTPException(403, "snapshot bucket not allowed")
    loop = asyncio.get_event_loop()
    try:
        data = await loop.run_in_executor(None, lambda: store.get_bytes(bucket, key))
    except Exception:
        raise HTTPException(404, "snapshot not found")
    return Response(content=data, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=300"})
