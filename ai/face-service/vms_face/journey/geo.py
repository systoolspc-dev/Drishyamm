"""Build the map.json the dashboard draws on its Leaflet map.

Rewritten from person-tracker's geo.py: cameras + coordinates now live in THIS
service's Postgres (Camera.lat/lng added in migration 0006), so we read them
locally instead of calling smart-cam-backend over HTTP with a service token.

Returns:
  {
    "stops": [{sighting_id, camera_id, camera_code, name, lat, lng, time, snapshot_uri}, ...],
    "path":  [[lat, lng], ...]   # ordered by sighting time, nulls dropped
  }
Cameras without coordinates appear in `stops` with lat/lng=null.
"""
from __future__ import annotations

import json
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.domain.models import Camera


async def build_path(job: dict, *, session: AsyncSession) -> dict:
    request = json.loads(job.get("request") or "{}")
    sightings = request.get("sightings", [])
    if not sightings:
        return {"stops": [], "path": []}

    cam_ids: set[uuid.UUID] = set()
    for s in sightings:
        cid = s.get("camera_id")
        if cid:
            try:
                cam_ids.add(uuid.UUID(str(cid)))
            except ValueError:
                continue

    coords: dict[str, dict] = {}
    if cam_ids:
        rows = await session.execute(
            select(Camera.id, Camera.code, Camera.name, Camera.lat, Camera.lng).where(Camera.id.in_(cam_ids))
        )
        for cid, code, name, lat, lng in rows.all():
            coords[str(cid)] = {"camera_code": code, "name": name, "lat": lat, "lng": lng}

    stops = []
    for s in sightings:
        cid = str(s.get("camera_id"))
        c = coords.get(cid, {})
        stops.append({
            "sighting_id": s.get("sighting_id"),
            "camera_id": cid,
            "camera_code": s.get("camera_code") or c.get("camera_code"),
            "name": c.get("name") or s.get("camera_code") or cid,
            "lat": c.get("lat"),
            "lng": c.get("lng"),
            "time": s.get("started_at"),
            "snapshot_uri": s.get("best_snapshot_uri"),
        })

    path = [[s["lat"], s["lng"]] for s in stops if s["lat"] is not None and s["lng"] is not None]
    return {"stops": stops, "path": path}
