"""Cross-camera ReID query API.

Two question shapes the operator UI asks:

  1. "Show me everywhere this track has been linked." — graph traversal
     over `track_links` from a seed (track_id, camera_id), returning the
     connected component and a per-camera timeline of sightings.

  2. "Who is this face on the map?" — given a track on a calibrated
     camera, project the bbox foot point to world ground coordinates so
     a campus map can plot it next to other cameras' detections.

Both are read-only; writes happen exclusively in the ReID worker.
"""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import current_tenant_id, db_session
from vms_face.domain.models import Camera, DetectionEvent, TrackLink
from vms_face.services.geometry import (
    bbox_foot_to_ground,
    load_calibration,
)
from vms_face.services.reid import expand_global_identity

router = APIRouter(prefix="/reid", tags=["reid"])


@router.get("/track/{camera_id}/{track_id}")
async def reid_track(
    camera_id: uuid.UUID,
    track_id: str,
    max_depth: int = Query(5, ge=1, le=20),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Return the connected component of `track_links` containing this
    seed (track_id, camera_id), plus a chronological timeline of every
    DetectionEvent rolled up across the linked tracks.

    This is the operator-facing answer to "is this person also that
    person?": one global identity stitched across cameras."""

    # The seed camera must belong to the caller's tenant; we no longer
    # adopt the camera's tenant_id implicitly (that was the journey hole).
    cam = await session.get(Camera, camera_id)
    if cam is None or cam.tenant_id != tenant_id:
        raise HTTPException(404, "camera not found")

    members = await expand_global_identity(
        session,
        tenant_id=tenant_id,
        seed_track_id=track_id,
        seed_camera_id=camera_id,
        max_depth=max_depth,
    )

    # Pull every detection_event for these (track, camera) pairs in chrono order.
    if not members:
        return {"members": [], "timeline": []}
    member_filter = or_(
        *[
            ((DetectionEvent.track_id == t) & (DetectionEvent.camera_id == c))
            for t, c in members
        ]
    )
    rows = (
        await session.execute(
            select(DetectionEvent)
            .where(DetectionEvent.tenant_id == tenant_id, member_filter)
            .order_by(DetectionEvent.occurred_at.asc())
        )
    ).scalars().all()

    timeline = []
    for ev in rows:
        timeline.append(
            {
                "event_id": str(ev.id),
                "camera_id": str(ev.camera_id),
                "track_id": ev.track_id,
                "kind": ev.kind.value,
                "person_id": str(ev.person_id) if ev.person_id else None,
                "similarity": ev.similarity,
                "snapshot_uri": ev.snapshot_uri,
                "bbox": ev.bbox,
                "occurred_at": ev.occurred_at.isoformat() if ev.occurred_at else None,
            }
        )

    return {
        "tenant_id": str(tenant_id),
        "seed": {"track_id": track_id, "camera_id": str(camera_id)},
        "members": [
            {"track_id": t, "camera_id": str(c)} for t, c in members
        ],
        "timeline": timeline,
    }


@router.get("/links/recent")
async def list_recent_links(
    limit: int = Query(50, le=500),
    since: dt.datetime | None = Query(None),
    min_similarity: float = Query(0.0),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> list[dict[str, Any]]:
    """Recent cross-camera linking activity. Useful for an "operations" view
    that shows where the ReID worker is making connections."""
    stmt = select(TrackLink).where(
        TrackLink.tenant_id == tenant_id,
        TrackLink.similarity >= min_similarity,
    )
    if since is not None:
        stmt = stmt.where(TrackLink.created_at >= since)
    stmt = stmt.order_by(TrackLink.created_at.desc()).limit(limit)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        {
            "id": str(link.id),
            "a": {
                "track_id": link.a_track_id,
                "camera_id": str(link.a_camera_id),
                "occurred_at": link.a_occurred_at.isoformat() if link.a_occurred_at else None,
                "event_id": str(link.a_event_id) if link.a_event_id else None,
            },
            "b": {
                "track_id": link.b_track_id,
                "camera_id": str(link.b_camera_id),
                "occurred_at": link.b_occurred_at.isoformat() if link.b_occurred_at else None,
                "event_id": str(link.b_event_id) if link.b_event_id else None,
            },
            "similarity": link.similarity,
            "link_kind": link.link_kind,
            "created_at": link.created_at.isoformat() if link.created_at else None,
        }
        for link in rows
    ]


@router.get("/ground/{event_id}")
async def event_ground_position(
    event_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Project a DetectionEvent's bbox foot to world ground coordinates
    using the source camera's calibration. The campus map UI uses this to
    plot a moving dot per global identity."""
    ev = await session.get(DetectionEvent, event_id)
    if ev is None or ev.tenant_id != tenant_id:
        raise HTTPException(404, "event not found")
    if not ev.bbox:
        raise HTTPException(422, "event has no bbox")
    cam = await session.get(Camera, ev.camera_id)
    if cam is None:
        raise HTTPException(422, "source camera missing")
    cal = load_calibration(cam.config_json)
    if cal is None:
        raise HTTPException(422, "camera has no calibration")
    pos = bbox_foot_to_ground(cal, ev.bbox)
    if pos is None:
        raise HTTPException(422, "ray does not intersect ground plane")
    x, y, z = pos
    return {
        "event_id": str(event_id),
        "camera_id": str(ev.camera_id),
        "track_id": ev.track_id,
        "occurred_at": ev.occurred_at.isoformat() if ev.occurred_at else None,
        "world": {"x": x, "y": y, "z": z, "units": cal.units},
    }
