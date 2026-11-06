from __future__ import annotations

import datetime as dt
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import Text, cast, desc, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import current_tenant_id, db_session, operator_id
from vms_face.domain.enums import EventKind, PersonRole
from vms_face.domain.models import Camera, DetectionEvent, FaceEnrollment, Person
from vms_face.services import audit as audit_log

router = APIRouter(prefix="/personnel", tags=["personnel"])


@router.get("/search")
async def search_personnel(
    q: str | None = Query(None, description="Search by name, external ID, department, or metadata"),
    role: PersonRole | None = Query(None),
    active_only: bool = Query(True),
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(db_session),
    actor: str = Depends(operator_id),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    started = time.perf_counter()
    query = _clean_query(q)

    # Tenant scope is now mandatory — derived from the authenticated principal,
    # not a query string. The "all tenants" path (formerly tenant_id=None) is
    # gone; only an admin token can cross tenants and that's a separate route.
    base_filters = [Person.tenant_id == tenant_id]
    if active_only:
        base_filters.append(Person.is_active.is_(True))
    if role is not None:
        base_filters.append(Person.role == role)
    if query:
        like = f"%{query}%"
        base_filters.append(
            or_(
                Person.full_name.ilike(like),
                Person.external_id.ilike(like),
                cast(Person.metadata_json, Text).ilike(like),
            )
        )

    stmt = select(Person).where(*base_filters).order_by(Person.full_name.asc()).limit(limit).offset(offset)
    persons = list((await session.execute(stmt)).scalars().all())
    person_ids = [p.id for p in persons]

    total_stmt = select(func.count()).select_from(Person).where(*base_filters)
    total = int((await session.execute(total_stmt)).scalar_one() or 0)

    enrollment_counts = await _enrollment_counts(session, person_ids)
    camera_counts = await _camera_counts(session, person_ids)
    latest_events = await _latest_events(session, person_ids)
    stats = await _stats(session, tenant_id=tenant_id)

    items = [
        _person_payload(
            person,
            enrollment_count=enrollment_counts.get(person.id, 0),
            cameras_seen=camera_counts.get(person.id, 0),
            latest=latest_events.get(person.id),
        )
        for person in persons
    ]

    search_ms = round((time.perf_counter() - started) * 1000, 1)
    stats["search_ms"] = search_ms

    await audit_log.record(
        actor=f"user:{actor}",
        actor_kind="user",
        action="personnel_search",
        tenant_id=tenant_id,
        target_type="personnel",
        reason="personnel name search",
        metadata={
            "q": query,
            "role": role.value if role else None,
            "active_only": active_only,
            "result_count": len(items),
            "total": total,
            "search_ms": search_ms,
        },
    )

    return {
        "query": query,
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": items,
        "stats": stats,
    }


async def _enrollment_counts(session: AsyncSession, person_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not person_ids:
        return {}
    rows = await session.execute(
        select(FaceEnrollment.person_id, func.count(FaceEnrollment.id))
        .where(FaceEnrollment.person_id.in_(person_ids))
        .group_by(FaceEnrollment.person_id)
    )
    return {person_id: int(count or 0) for person_id, count in rows.all()}


async def _camera_counts(session: AsyncSession, person_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not person_ids:
        return {}
    rows = await session.execute(
        select(DetectionEvent.person_id, func.count(distinct(DetectionEvent.camera_id)))
        .where(DetectionEvent.person_id.in_(person_ids))
        .group_by(DetectionEvent.person_id)
    )
    return {person_id: int(count or 0) for person_id, count in rows.all() if person_id is not None}


async def _latest_events(session: AsyncSession, person_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, Any]]:
    if not person_ids:
        return {}

    ranked = (
        select(
            DetectionEvent.id.label("event_id"),
            DetectionEvent.person_id.label("person_id"),
            DetectionEvent.camera_id.label("camera_id"),
            DetectionEvent.track_id.label("track_id"),
            DetectionEvent.kind.label("kind"),
            DetectionEvent.similarity.label("similarity"),
            DetectionEvent.snapshot_uri.label("snapshot_uri"),
            DetectionEvent.occurred_at.label("occurred_at"),
            func.row_number()
            .over(
                partition_by=DetectionEvent.person_id,
                order_by=DetectionEvent.occurred_at.desc(),
            )
            .label("rn"),
        )
        .where(DetectionEvent.person_id.in_(person_ids))
        .subquery()
    )

    rows = await session.execute(
        select(
            ranked.c.event_id,
            ranked.c.person_id,
            ranked.c.camera_id,
            ranked.c.track_id,
            ranked.c.kind,
            ranked.c.similarity,
            ranked.c.snapshot_uri,
            ranked.c.occurred_at,
            Camera.code,
            Camera.name,
            Camera.location,
            Camera.zone,
        )
        .outerjoin(Camera, Camera.id == ranked.c.camera_id)
        .where(ranked.c.rn == 1)
        .order_by(desc(ranked.c.occurred_at))
    )

    latest: dict[uuid.UUID, dict[str, Any]] = {}
    for row in rows.mappings():
        person_id = row["person_id"]
        if person_id is None:
            continue
        latest[person_id] = dict(row)
    return latest


async def _stats(session: AsyncSession, *, tenant_id: uuid.UUID | None) -> dict[str, Any]:
    filters = [Person.is_active.is_(True)]
    if tenant_id is not None:
        filters.append(Person.tenant_id == tenant_id)

    total_people = int((await session.execute(select(func.count()).select_from(Person).where(*filters))).scalar_one() or 0)

    enrolled_stmt = (
        select(func.count(distinct(FaceEnrollment.person_id)))
        .join(Person, Person.id == FaceEnrollment.person_id)
        .where(*filters)
    )
    enrolled_people = int((await session.execute(enrolled_stmt)).scalar_one() or 0)

    now = dt.datetime.now(dt.UTC)
    live_since = now - dt.timedelta(minutes=3)
    live_stmt = (
        select(func.count(distinct(DetectionEvent.person_id)))
        .join(Person, Person.id == DetectionEvent.person_id)
        .where(*filters, DetectionEvent.occurred_at >= live_since)
    )
    live_tracking = int((await session.execute(live_stmt)).scalar_one() or 0)

    review_since = now - dt.timedelta(hours=24)
    review_stmt = (
        select(func.count(distinct(Person.id)))
        .outerjoin(DetectionEvent, DetectionEvent.person_id == Person.id)
        .where(
            *filters,
            or_(
                Person.role == PersonRole.BLACKLIST,
                (DetectionEvent.kind == EventKind.ALERT) & (DetectionEvent.occurred_at >= review_since),
            ),
        )
    )
    needs_review = int((await session.execute(review_stmt)).scalar_one() or 0)

    return {
        "total_people": total_people,
        "enrolled_people": enrolled_people,
        "live_tracking": live_tracking,
        "needs_review": needs_review,
    }


def _person_payload(
    person: Person,
    *,
    enrollment_count: int,
    cameras_seen: int,
    latest: dict[str, Any] | None,
) -> dict[str, Any]:
    metadata = person.metadata_json or {}
    latest_at = latest.get("occurred_at") if latest else None
    status = _status(person, latest)
    camera_name = latest.get("name") if latest else None
    camera_code = latest.get("code") if latest else None
    camera_location = latest.get("location") if latest else None
    zone = latest.get("zone") if latest else None

    return {
        "id": str(person.id),
        "tenant_id": str(person.tenant_id),
        "external_id": person.external_id,
        "full_name": person.full_name,
        "role": person.role.value,
        "role_label": person.role.value.replace("_", " ").title(),
        "department": _metadata_text(metadata, "department", "dept", "course", "class", default="Not assigned"),
        "group": _metadata_text(metadata, "group", "batch", "designation", default=None),
        "status": status,
        "is_active": bool(person.is_active),
        "enrollment_count": int(enrollment_count),
        "cameras_seen": int(cameras_seen),
        "last_seen_at": latest_at,
        "last_seen_label": _relative_time(latest_at),
        "last_camera_id": str(latest["camera_id"]) if latest and latest.get("camera_id") else None,
        "last_camera_code": camera_code,
        "last_camera_name": camera_name,
        "location": camera_location or zone or camera_name or "No recent camera",
        "zone": zone,
        "latest_event_id": str(latest["event_id"]) if latest and latest.get("event_id") else None,
        "latest_event_kind": latest["kind"].value if latest and latest.get("kind") else None,
        "track_id": latest.get("track_id") if latest else None,
        "similarity": float(latest["similarity"]) if latest and latest.get("similarity") is not None else None,
        "snapshot_uri": latest.get("snapshot_uri") if latest else None,
        "created_at": person.created_at,
        "updated_at": person.updated_at,
        "metadata": metadata,
    }


def _status(person: Person, latest: dict[str, Any] | None) -> str:
    if person.role == PersonRole.BLACKLIST:
        return "alert"
    if not person.is_active:
        return "offline"
    if not latest:
        return "offline"
    kind = latest.get("kind")
    if kind == EventKind.ALERT:
        return "alert"
    occurred_at = latest.get("occurred_at")
    if isinstance(occurred_at, dt.datetime):
        age = dt.datetime.now(dt.UTC) - _ensure_aware(occurred_at)
        if age <= dt.timedelta(minutes=3):
            return "live"
    return "offline"


def _relative_time(value: dt.datetime | None) -> str:
    if value is None:
        return "No recent sighting"
    age = dt.datetime.now(dt.UTC) - _ensure_aware(value)
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
