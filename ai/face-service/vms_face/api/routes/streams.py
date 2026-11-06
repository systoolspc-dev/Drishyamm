from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status

from vms_face.services.sharding import forward_to_owner, owns
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import (
    bus,
    current_tenant_id,
    db_session,
    objects,
    quality_gate,
    recognizer,
    runtime,
    state_publisher,
)
from vms_face.config import settings
from vms_face.core.logging import get_logger
from vms_face.core.metrics import ACTIVE_CAMERAS
from vms_face.domain.enums import CameraStatus
from vms_face.domain.models import Camera
from vms_face.infra.detection_state import StatePublisher
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.minio_store import ObjectStore
from vms_face.infra.recognizers import Recognizer
from vms_face.infra.redis_bus import RedisBus
from vms_face.pipeline.orchestrator import StreamContext, StreamOrchestrator
from vms_face.services.face_quality import FaceQualityGate

router = APIRouter(prefix="/streams", tags=["streams"])
log = get_logger(__name__)


# Single-process registry of running stream tasks. In Phase 4 (multi-node) this
# moves to Redis with leader election so cameras are sharded across workers.
_RUNNING: dict[uuid.UUID, tuple[asyncio.Task, StreamOrchestrator]] = {}


@router.post("/{camera_id}/start", status_code=status.HTTP_202_ACCEPTED)
async def start_stream(
    request: Request,
    camera_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
    rbus: RedisBus = Depends(bus),
    obj: ObjectStore = Depends(objects),
    qg: FaceQualityGate = Depends(quality_gate),
    publisher: StatePublisher = Depends(state_publisher),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    cam = await session.get(Camera, camera_id)
    if cam is None or cam.tenant_id != tenant_id:
        raise HTTPException(404, "camera not found")
    if not owns(camera_id):
        return await forward_to_owner(request, camera_id)
    if camera_id in _RUNNING:
        return {"camera_id": str(camera_id), "status": "already_running"}

    ctx = StreamContext(
        tenant_id=cam.tenant_id,
        camera_id=cam.id,
        camera_code=cam.code,
        rtsp_url=cam.rtsp_url,
        target_fps=cam.target_fps,
        embed_every_n=settings.embed_every_n_frames,
        snapshot_top_k=settings.snapshot_top_k_per_track,
        zone=cam.zone,
        detection_input_size=cam.detection_input_size,
        detection_zones=(cam.config_json or {}).get("detection_zones"),
        footfall_config=(cam.config_json or {}).get("footfall"),
    )
    orch = StreamOrchestrator(
        ctx,
        recognizer=rec,
        bus=rbus,
        objects=obj,
        quality=qg,
        state_publisher=publisher,
    )
    task = asyncio.create_task(orch.run(), name=f"stream-{cam.code}")
    _RUNNING[camera_id] = (task, orch)
    ACTIVE_CAMERAS.set(len(_RUNNING))

    cam.status = CameraStatus.ONLINE
    await session.commit()

    def _on_done(_t: asyncio.Task) -> None:
        _RUNNING.pop(camera_id, None)
        ACTIVE_CAMERAS.set(len(_RUNNING))

    task.add_done_callback(_on_done)
    return {"camera_id": str(camera_id), "status": "starting"}


@router.post("/{camera_id}/stop", status_code=status.HTTP_202_ACCEPTED)
async def stop_stream(
    request: Request,
    camera_id: uuid.UUID,
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    cam = await session.get(Camera, camera_id)
    if cam is None or cam.tenant_id != tenant_id:
        raise HTTPException(404, "camera not found")
    if not owns(camera_id):
        return await forward_to_owner(request, camera_id)
    pair = _RUNNING.get(camera_id)
    if pair is None:
        raise HTTPException(404, "stream not running")
    task, orch = pair
    await orch.stop()
    try:
        await asyncio.wait_for(task, timeout=10)
    except asyncio.TimeoutError:
        task.cancel()

    cam.status = CameraStatus.OFFLINE
    await session.commit()
    return {"camera_id": str(camera_id), "status": "stopped"}


@router.get("")
async def list_running_streams(
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    """List active streams scoped to the caller's tenant. We re-read the camera
    rows for the running ids and filter — `_RUNNING` is process-local and not
    keyed by tenant."""
    if not _RUNNING:
        return {"active": [], "count": 0}
    rows = await session.execute(
        select(Camera.id).where(
            Camera.id.in_(list(_RUNNING.keys())),
            Camera.tenant_id == tenant_id,
        )
    )
    visible = [str(r) for r in rows.scalars()]
    return {"active": visible, "count": len(visible)}


@router.get("/debug")
async def debug_pipeline(
    session: AsyncSession = Depends(db_session),
    tenant_id: uuid.UUID = Depends(current_tenant_id),
) -> dict:
    """Per-camera orchestrator state for "why aren't boxes showing up?"
    diagnosis. Returns frames-ingested, observations-found, candidates-
    published, and seconds-since-last-event for every stream this tenant
    has running. If the detection chain is broken anywhere, the gap is
    visible in one curl response. Tenant-scoped so an operator can't
    introspect another tenant's pipeline."""
    if not _RUNNING:
        return {"streams": [], "count": 0}
    rows = await session.execute(
        select(Camera.id).where(
            Camera.id.in_(list(_RUNNING.keys())),
            Camera.tenant_id == tenant_id,
        )
    )
    visible_ids = {r for r in rows.scalars()}
    streams = []
    for cam_id, (task, orch) in _RUNNING.items():
        if cam_id not in visible_ids:
            continue
        try:
            snapshot = orch.stats()
        except Exception as e:
            snapshot = {"camera_id": str(cam_id), "stats_error": str(e)}
        snapshot["task_done"] = task.done()
        if task.done():
            try:
                exc = task.exception()
                snapshot["task_exception"] = str(exc) if exc else None
            except Exception:
                snapshot["task_exception"] = "unable to retrieve"
        streams.append(snapshot)
    return {"streams": streams, "count": len(streams)}
