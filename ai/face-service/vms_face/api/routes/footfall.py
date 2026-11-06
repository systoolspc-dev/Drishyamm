"""REST API for the customer-footfall feature.

Exposes the data the frontend Footfall page reads and the per-camera toggle
that lets the operator turn counting on/off.

  GET  /footfall/cameras                  — one row per camera with live
                                            in-memory counts + persisted
                                            today-so-far totals from Postgres.
  GET  /footfall/cameras/{id}             — single-camera detail.
  GET  /footfall/cameras/{id}/config      — current footfall config block.
  PUT  /footfall/cameras/{id}/config      — update toggle, line (a->b, any
                                            angle), direction, falls. Returns
                                            the stored config (after coercion
                                            to safe ranges).
  GET  /footfall/timeseries               — per-minute/hour/day series for
                                            the chart, optionally filtered to
                                            one camera.
  GET  /footfall/export.csv               — CSV export of the minute buckets
                                            for the date range, in operator-
                                            friendly columns.

All routes are tenant-scoped via `current_tenant_id` and require a JWT (or
dev-bypass in local dev). Cameras outside the tenant are 404.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import uuid
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import current_tenant_id, db_session
from vms_face.core.logging import get_logger
from vms_face.domain.models import Camera, FootfallMinuteBucket
from vms_face.services.footfall import FootfallConfig, parse_line, get_registry
from vms_face.services.sharding import forward_to_owner, owns

log = get_logger(__name__)

router = APIRouter(prefix="/footfall", tags=["footfall"])


# ── Helpers ────────────────────────────────────────────────────────────


def _today_midnight_utc() -> dt.datetime:
    """Start of the current UTC day. We use UTC so multi-region deployments
    don't have to agree on a zone — the frontend renders in local time."""
    now = dt.datetime.now(dt.timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


async def _camera_or_404(
    session: AsyncSession,
    camera_id: uuid.UUID,
    tenant_id: uuid.UUID,
) -> Camera:
    cam = await session.get(Camera, camera_id)
    if cam is None or cam.tenant_id != tenant_id:
        raise HTTPException(404, "camera not found")
    return cam


# ── Live snapshot ──────────────────────────────────────────────────────


@router.get("/cameras")
async def list_cameras(
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """One row per camera in this tenant, joined with today's persisted
    totals + the in-memory session counters. The frontend uses this to
    render the per-camera table on the Footfall page."""
    # All cameras owned by this tenant. We list ALL cameras (not just
    # those with footfall enabled) so the UI can show an explicit
    # "not tracking" hint next to each, with a quick link to flip it on.
    rows = await session.execute(
        select(Camera.id, Camera.code, Camera.name, Camera.status, Camera.config_json)
        .where(Camera.tenant_id == tenant_id)
        .order_by(Camera.name.asc())
    )
    cameras = rows.all()

    # Per-camera today-so-far totals from Postgres. One query for all
    # cameras in this tenant, grouped by camera_id.
    midnight = _today_midnight_utc()
    today_rows = await session.execute(
        select(
            FootfallMinuteBucket.camera_id,
            func.sum(FootfallMinuteBucket.in_count).label("in_total"),
            func.sum(FootfallMinuteBucket.out_count).label("out_total"),
            func.sum(FootfallMinuteBucket.falls_count).label("falls_total"),
        )
        .where(FootfallMinuteBucket.tenant_id == tenant_id)
        .where(FootfallMinuteBucket.bucket_minute >= midnight)
        .group_by(FootfallMinuteBucket.camera_id)
    )
    today_by_cam = {r.camera_id: r for r in today_rows.all()}

    # Live (since-process-start) counters from the in-memory registry.
    live = get_registry().live_snapshot()

    items: list[dict[str, Any]] = []
    for cam_id, code, name, status, config_json in cameras:
        cfg_block = (config_json or {}).get("footfall") or {}
        cfg = FootfallConfig.from_camera_config({"footfall": cfg_block})
        today = today_by_cam.get(cam_id)
        live_state = live.get(cam_id)
        items.append({
            "camera_id": str(cam_id),
            "camera_code": code,
            "camera_name": name,
            "camera_status": getattr(status, "value", str(status)),
            "footfall_enabled": cfg.enabled,
            "line": cfg.line,
            "line_y_frac": cfg.line_y_frac,
            "direction": cfg.direction,
            "falls_enabled": cfg.falls_enabled,
            "today": {
                "in":    int(today.in_total or 0) if today else 0,
                "out":   int(today.out_total or 0) if today else 0,
                "falls": int(today.falls_total or 0) if today else 0,
            },
            "session": {
                "in":    int(live_state["in_count_session"]) if live_state else 0,
                "out":   int(live_state["out_count_session"]) if live_state else 0,
                "falls": int(live_state["falls_count_session"]) if live_state else 0,
                "active_tracks": int(live_state["active_tracks"]) if live_state else 0,
                "last_update_age_sec": live_state["last_update_age_sec"] if live_state else None,
            },
        })

    # Building-wide tile values: sums of today's persisted counts. We don't
    # mix in "session" because the in-memory counter resets on process
    # restart and would mislead operators reading a 24-hour total.
    totals = {
        "in":    sum(it["today"]["in"]    for it in items),
        "out":   sum(it["today"]["out"]   for it in items),
        "falls": sum(it["today"]["falls"] for it in items),
        "cameras_tracking": sum(1 for it in items if it["footfall_enabled"]),
        "cameras_total":    len(items),
    }

    return {"totals_today": totals, "cameras": items, "ts": dt.datetime.now(dt.timezone.utc).isoformat()}


@router.get("/cameras/{camera_id}")
async def camera_detail(
    camera_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    cam = await _camera_or_404(session, camera_id, tenant_id)
    cfg = FootfallConfig.from_camera_config(cam.config_json)

    midnight = _today_midnight_utc()
    r = await session.execute(
        select(
            func.sum(FootfallMinuteBucket.in_count),
            func.sum(FootfallMinuteBucket.out_count),
            func.sum(FootfallMinuteBucket.falls_count),
        )
        .where(FootfallMinuteBucket.camera_id == camera_id)
        .where(FootfallMinuteBucket.bucket_minute >= midnight)
    )
    in_t, out_t, falls_t = r.one()
    live = get_registry().live_snapshot().get(camera_id)
    return {
        "camera_id": str(cam.id),
        "camera_code": cam.code,
        "camera_name": cam.name,
        "camera_status": getattr(cam.status, "value", str(cam.status)),
        "config": cfg.to_json(),
        "today": {
            "in":    int(in_t or 0),
            "out":   int(out_t or 0),
            "falls": int(falls_t or 0),
        },
        "session": {
            "in":    int(live["in_count_session"]) if live else 0,
            "out":   int(live["out_count_session"]) if live else 0,
            "falls": int(live["falls_count_session"]) if live else 0,
            "active_tracks": int(live["active_tracks"]) if live else 0,
        },
    }


# ── Per-camera config CRUD ─────────────────────────────────────────────


@router.get("/cameras/{camera_id}/config")
async def get_config(
    camera_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    cam = await _camera_or_404(session, camera_id, tenant_id)
    return FootfallConfig.from_camera_config(cam.config_json).to_json()


@router.put("/cameras/{camera_id}/config")
async def put_config(
    request: Request,
    camera_id: uuid.UUID,
    payload: dict = Body(...),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Update the footfall block in cameras.config_json. Coerces values to
    safe ranges; a line too short to be a line is refused. Re-registers the
    in-memory tracker with fresh config so the changes take effect on the
    next frame.

    Body: {enabled?, line?: {a:[x,y], b:[x,y]} (0..1), direction?:
    "right_is_in"|"left_is_in" (relative to a->b on screen), falls_enabled?}.
    The pre-angle {line_y_frac, down_is_in|up_is_in} is still accepted."""
    cam = await _camera_or_404(session, camera_id, tenant_id)
    # The tracker that counts lives in the shard running this camera; a
    # save handled anywhere else would land in the database but leave that
    # camera counting on the old line until it restarted.
    if not owns(cam.id):
        return await forward_to_owner(request, cam.id)

    incoming = {
        "enabled":      payload.get("enabled"),
        "line":         payload.get("line"),
        "line_y_frac":  payload.get("line_y_frac"),
        "direction":    payload.get("direction"),
        "falls_enabled":payload.get("falls_enabled"),
    }
    incoming = {k: v for k, v in incoming.items() if v is not None}
    if "line" in incoming and parse_line(incoming["line"]) is None:
        raise HTTPException(422, "line must be {a:[x,y], b:[x,y]} in 0..1, at least 3% of the frame long")

    # Merge with current to preserve fields the caller omitted.
    stored = dict((cam.config_json or {}).get("footfall") or {})
    if "line_y_frac" in incoming and "line" not in incoming:
        # A pre-angle client moved its level line: that replaces the segment.
        stored.pop("line", None)
    merged = {**stored, **incoming}
    cfg = FootfallConfig.from_camera_config({"footfall": merged})
    sanitized = cfg.to_json()

    # Write back the *sanitized* config so cameras.config_json never carries
    # values the runtime would reject.
    new_config = dict(cam.config_json or {})
    new_config["footfall"] = sanitized
    await session.execute(
        update(Camera).where(Camera.id == cam.id).values(config_json=new_config)
    )
    await session.commit()

    # Reflect the new config in the running tracker. If the orchestrator
    # for this camera isn't up, configure_camera is harmless — the next
    # camera start will pick the config up from config_json regardless.
    await get_registry().configure_camera(cam.id, cam.tenant_id, cfg)

    log.info(
        "footfall config updated",
        camera=cam.code,
        enabled=cfg.enabled,
        line=cfg.line,
        direction=cfg.direction,
    )
    return sanitized


# ── Time-series for the chart ──────────────────────────────────────────


_GRANULARITY_SECONDS = {"minute": 60, "hour": 3600, "day": 86400}


@router.get("/timeseries")
async def timeseries(
    granularity: str = Query("hour", regex="^(minute|hour|day)$"),
    from_iso: str | None = Query(None, alias="from"),
    to_iso: str | None = Query(None, alias="to"),
    camera_id: uuid.UUID | None = Query(None),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict[str, Any]:
    """Bucketed time-series. Default range = last 24 hours, hourly. The
    SQL groups by `date_trunc(<granularity>, bucket_minute)` so a single
    query covers any window size."""
    now = dt.datetime.now(dt.timezone.utc)
    to_dt = _parse_iso(to_iso, default=now)
    from_dt = _parse_iso(from_iso, default=to_dt - dt.timedelta(hours=24))
    if from_dt >= to_dt:
        raise HTTPException(400, "from must be before to")

    bucket_expr = func.date_trunc(granularity, FootfallMinuteBucket.bucket_minute)
    stmt = (
        select(
            bucket_expr.label("bucket"),
            func.sum(FootfallMinuteBucket.in_count).label("in_count"),
            func.sum(FootfallMinuteBucket.out_count).label("out_count"),
            func.sum(FootfallMinuteBucket.falls_count).label("falls_count"),
        )
        .where(FootfallMinuteBucket.tenant_id == tenant_id)
        .where(FootfallMinuteBucket.bucket_minute >= from_dt)
        .where(FootfallMinuteBucket.bucket_minute < to_dt)
        .group_by(bucket_expr)
        .order_by(bucket_expr.asc())
    )
    if camera_id is not None:
        stmt = stmt.where(FootfallMinuteBucket.camera_id == camera_id)

    rows = (await session.execute(stmt)).all()
    points = [
        {
            "bucket":      r.bucket.isoformat(),
            "in_count":    int(r.in_count or 0),
            "out_count":   int(r.out_count or 0),
            "falls_count": int(r.falls_count or 0),
        }
        for r in rows
    ]
    return {
        "granularity": granularity,
        "from": from_dt.isoformat(),
        "to":   to_dt.isoformat(),
        "camera_id": str(camera_id) if camera_id else None,
        "points": points,
    }


# ── CSV export ─────────────────────────────────────────────────────────


@router.get("/export.csv")
async def export_csv(
    from_iso: str | None = Query(None, alias="from"),
    to_iso: str | None = Query(None, alias="to"),
    camera_id: uuid.UUID | None = Query(None),
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> StreamingResponse:
    """Streaming CSV of the minute buckets. We stream so a 30-day export
    on a busy mall (~4.3M rows max) doesn't allocate it all in memory."""
    now = dt.datetime.now(dt.timezone.utc)
    to_dt = _parse_iso(to_iso, default=now)
    from_dt = _parse_iso(from_iso, default=to_dt - dt.timedelta(days=1))
    if from_dt >= to_dt:
        raise HTTPException(400, "from must be before to")

    stmt = (
        select(
            FootfallMinuteBucket.bucket_minute,
            FootfallMinuteBucket.camera_id,
            FootfallMinuteBucket.in_count,
            FootfallMinuteBucket.out_count,
            FootfallMinuteBucket.falls_count,
            Camera.code.label("camera_code"),
            Camera.name.label("camera_name"),
        )
        .join(Camera, Camera.id == FootfallMinuteBucket.camera_id)
        .where(FootfallMinuteBucket.tenant_id == tenant_id)
        .where(FootfallMinuteBucket.bucket_minute >= from_dt)
        .where(FootfallMinuteBucket.bucket_minute < to_dt)
        .order_by(FootfallMinuteBucket.bucket_minute.asc())
    )
    if camera_id is not None:
        stmt = stmt.where(FootfallMinuteBucket.camera_id == camera_id)

    # Pre-execute so we can stream rows as they arrive. The chunked
    # iterator avoids loading the whole result set in memory.
    result = await session.stream(stmt)

    async def _emit():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["bucket_minute_utc", "camera_code", "camera_name", "in_count", "out_count", "falls_count"])
        yield buf.getvalue().encode()
        buf.seek(0); buf.truncate()
        async for row in result:
            writer.writerow([
                row.bucket_minute.isoformat(),
                row.camera_code or "",
                row.camera_name or "",
                int(row.in_count or 0),
                int(row.out_count or 0),
                int(row.falls_count or 0),
            ])
            yield buf.getvalue().encode()
            buf.seek(0); buf.truncate()

    filename = f"footfall_{from_dt.date()}_to_{to_dt.date()}.csv"
    return StreamingResponse(
        _emit(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Helpers ────────────────────────────────────────────────────────────


def _parse_iso(value: str | None, *, default: dt.datetime) -> dt.datetime:
    if not value:
        return default
    try:
        out = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if out.tzinfo is None:
            # Treat naive timestamps as UTC — matches what the chart sends.
            out = out.replace(tzinfo=dt.timezone.utc)
        return out
    except ValueError:
        raise HTTPException(400, f"invalid timestamp: {value!r}")
