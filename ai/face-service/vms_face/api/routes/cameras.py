from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status

from vms_face.services.sharding import forward_to_owner, owns, release
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import current_tenant_id, db_session
from vms_face.core.logging import get_logger
from vms_face.domain.models import Camera
from vms_face.domain.schemas import CameraCreate, CameraOut, CameraUpdate
from vms_face.services.geometry import CameraCalibration, bbox_foot_to_ground, image_to_ground


def _ensure_tenant_match(model_tenant_id: uuid.UUID, principal_tenant_id: uuid.UUID) -> None:
    """A 404 (not 403) for cross-tenant lookups so we don't leak the existence
    of resources in other tenants — same body shape as a genuine miss."""
    if model_tenant_id != principal_tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "camera not found")


log = get_logger(__name__)

router = APIRouter(prefix="/cameras", tags=["cameras"])


@router.post("", response_model=CameraOut, status_code=status.HTTP_201_CREATED)
async def create_camera(
    payload: CameraCreate,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> CameraOut:
    # tenant_id is derived from the verified JWT — payload.tenant_id is only
    # tolerated when it agrees with the principal. Mismatches are 403'd
    # rather than silently rebound to prevent confused-deputy bugs.
    if payload.tenant_id != tenant_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "tenant_id does not match token")
    cam = Camera(
        tenant_id=tenant_id,
        code=payload.code,
        name=payload.name,
        rtsp_url=payload.rtsp_url,
        location=payload.location,
        zone=payload.zone,
        target_fps=payload.target_fps,
        detection_input_size=payload.detection_input_size,
        enabled=payload.enabled,
        config_json=payload.config,
    )
    session.add(cam)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(409, "camera code already exists for tenant") from e
    await session.refresh(cam)
    return CameraOut.model_validate(cam)


@router.get("", response_model=list[CameraOut])
async def list_cameras(
    enabled: bool | None = None,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> list[CameraOut]:
    stmt = select(Camera).where(Camera.tenant_id == tenant_id)
    if enabled is not None:
        stmt = stmt.where(Camera.enabled == enabled)
    stmt = stmt.order_by(Camera.code)
    rows = (await session.execute(stmt)).scalars().all()
    return [CameraOut.model_validate(c) for c in rows]


@router.get("/{camera_id}", response_model=CameraOut)
async def get_camera(
    camera_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> CameraOut:
    cam = await session.get(Camera, camera_id)
    if cam is None:
        raise HTTPException(404, "camera not found")
    _ensure_tenant_match(cam.tenant_id, tenant_id)
    return CameraOut.model_validate(cam)


@router.patch("/{camera_id}", response_model=CameraOut)
async def update_camera(
    camera_id: uuid.UUID,
    payload: CameraUpdate,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> CameraOut:
    cam = await session.get(Camera, camera_id)
    if cam is None:
        raise HTTPException(404, "camera not found")
    _ensure_tenant_match(cam.tenant_id, tenant_id)
    data = payload.model_dump(exclude_unset=True)
    if "config" in data:
        cam.config_json = data.pop("config")
    for k, v in data.items():
        setattr(cam, k, v)
    await session.commit()
    await session.refresh(cam)
    return CameraOut.model_validate(cam)


@router.delete("/{camera_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_camera(
    request: Request,
    camera_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> None:
    cam = await session.get(Camera, camera_id)
    if cam is None:
        raise HTTPException(404, "camera not found")
    _ensure_tenant_match(cam.tenant_id, tenant_id)
    if not owns(camera_id):
        # The owning shard holds the orchestrator (services/sharding.py);
        # let it stop that and delete the row, so nothing keeps pulling a
        # camera that no longer exists. If that shard is down, delete here:
        # its orchestrator dies with it, and its reconciler will not find
        # the row when it comes back.
        try:
            return await forward_to_owner(request, camera_id)
        except HTTPException as e:
            if e.status_code not in (502, 503):
                raise
            log.warning("owner shard unreachable; deleting camera locally", camera_id=str(camera_id), status=e.status_code)
    # Stop a running orchestrator first, in whichever registry started it.
    for stop in (_stop_running_stream, _stop_running_legacy):
        try:
            await stop(camera_id)
        except Exception:  # noqa: BLE001 - best effort; the row goes regardless
            pass
    await session.delete(cam)
    await session.commit()
    release(camera_id)


async def _stop_running_stream(camera_id: uuid.UUID) -> None:
    from vms_face.api.routes.streams import _RUNNING as running  # local: avoids an import cycle
    pair = running.pop(camera_id, None)
    if pair is not None:
        task, orch = pair
        await orch.stop()
        task.cancel()


async def _stop_running_legacy(camera_id: uuid.UUID) -> None:
    from vms_face.api.routes.legacy import _stop_camera_internal  # local: avoids an import cycle
    await _stop_camera_internal(camera_id, mark_offline=False)


# ── Calibration ──────────────────────────────────────────────────────────


@router.put("/{camera_id}/calibration")
async def set_calibration(
    camera_id: uuid.UUID,
    payload: CameraCalibration,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    """Set or replace the per-camera pinhole calibration. Stored under
    Camera.config_json["calibration"]; validated by the CameraCalibration
    Pydantic model. Run OpenCV calibrateCamera + solvePnP offline to
    produce these values."""
    cam = await session.get(Camera, camera_id)
    if cam is None:
        raise HTTPException(404, "camera not found")
    _ensure_tenant_match(cam.tenant_id, tenant_id)
    cfg = dict(cam.config_json or {})
    cfg["calibration"] = payload.model_dump()
    cam.config_json = cfg
    await session.commit()
    return {"ok": True, "camera_id": str(camera_id)}


@router.get("/{camera_id}/calibration", response_model=CameraCalibration)
async def get_calibration(
    camera_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> CameraCalibration:
    cam = await session.get(Camera, camera_id)
    if cam is None:
        raise HTTPException(404, "camera not found")
    _ensure_tenant_match(cam.tenant_id, tenant_id)
    raw = (cam.config_json or {}).get("calibration")
    if not raw:
        raise HTTPException(404, "camera has no calibration")
    return CameraCalibration.model_validate(raw)


@router.delete("/{camera_id}/calibration", status_code=status.HTTP_204_NO_CONTENT)
async def delete_calibration(
    camera_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> None:
    cam = await session.get(Camera, camera_id)
    if cam is None:
        raise HTTPException(404, "camera not found")
    _ensure_tenant_match(cam.tenant_id, tenant_id)
    cfg = dict(cam.config_json or {})
    cfg.pop("calibration", None)
    cam.config_json = cfg
    await session.commit()


@router.post("/{camera_id}/project/image-to-ground")
async def project_image_to_ground(
    camera_id: uuid.UUID,
    payload: dict,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    """Test/utility endpoint. Body may be either:
        {"u": <pixel_x>, "v": <pixel_y>}        — single pixel
        {"bbox": [x1, y1, x2, y2]}              — bbox foot point
    Returns {"x": X, "y": Y, "z": Z} in world coords, or 422 if the camera
    has no calibration / the ray is parallel to the ground."""
    cam = await session.get(Camera, camera_id)
    if cam is None:
        raise HTTPException(404, "camera not found")
    _ensure_tenant_match(cam.tenant_id, tenant_id)
    raw = (cam.config_json or {}).get("calibration")
    if not raw:
        raise HTTPException(422, "camera has no calibration")
    cal = CameraCalibration.model_validate(raw)

    if "bbox" in payload:
        bbox = payload["bbox"]
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            raise HTTPException(400, "bbox must be [x1, y1, x2, y2]")
        result = bbox_foot_to_ground(cal, bbox)
    elif "u" in payload and "v" in payload:
        result = image_to_ground(cal, float(payload["u"]), float(payload["v"]))
    else:
        raise HTTPException(400, "body must contain {u,v} or {bbox}")

    if result is None:
        raise HTTPException(422, "ray does not intersect the ground plane")
    x, y, z = result
    return {"x": x, "y": y, "z": z}
