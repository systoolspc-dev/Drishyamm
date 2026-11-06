from __future__ import annotations

import datetime as dt
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import current_tenant_id, db_session
from vms_face.domain.enums import EventKind
from vms_face.domain.models import DetectionEvent
from vms_face.domain.schemas import DetectionEventOut

router = APIRouter(prefix="/events", tags=["events"])


@router.get("", response_model=list[DetectionEventOut])
async def list_events(
    camera_id: uuid.UUID | None = Query(None),
    person_id: uuid.UUID | None = Query(None),
    kind: EventKind | None = Query(None),
    since: dt.datetime | None = Query(None),
    until: dt.datetime | None = Query(None),
    limit: int = Query(100, le=500),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> list[DetectionEventOut]:
    stmt = select(DetectionEvent).where(DetectionEvent.tenant_id == tenant_id)
    if camera_id:
        stmt = stmt.where(DetectionEvent.camera_id == camera_id)
    if person_id:
        stmt = stmt.where(DetectionEvent.person_id == person_id)
    if kind:
        stmt = stmt.where(DetectionEvent.kind == kind)
    if since:
        stmt = stmt.where(DetectionEvent.occurred_at >= since)
    if until:
        stmt = stmt.where(DetectionEvent.occurred_at <= until)
    stmt = stmt.order_by(DetectionEvent.occurred_at.desc()).limit(limit).offset(offset)
    rows = (await session.execute(stmt)).scalars().all()
    return [DetectionEventOut.model_validate(r) for r in rows]
