"""Legacy compatibility router for `smart-cam-app/AiFeed.jsx`.

The frontend was built against the old `insightface_api.py` shape and hardcodes
`http://localhost:8001`. This router re-implements those endpoints on top of
the new `vms_face` services so the existing UI works unchanged. Endpoints:

  POST /set-camera               (FormData: monitor_id)
  GET  /status
  GET  /logs
  POST /upload                   (FormData: name, file)
  GET  /api/detections/{camera_id}
  WS   /ws?camera_id=...

Internally these all map to the proper REST API (tenants, persons, cameras,
streams, search). When the frontend hits an unknown `monitor_id`, we
auto-create a Camera in the default tenant using the MediaMTX RTSP template.

Race-safe upserts use Postgres `INSERT ... ON CONFLICT` so two concurrent
`/set-camera` calls for the same monitor_id can never produce a 500.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import (
    Request,
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from vms_face.api.deps import (
    bus,
    current_principal,
    db_session,
    enrollment,
    legacy_api_key_ok,
    objects,
    operator_id,
    quality_gate,
    recognizer,
    runtime,
    state_publisher,
)
from vms_face.core.security import Principal, dev_bypass_allowed
from vms_face.api.routes.streams import _RUNNING
from vms_face.config import settings
from vms_face.core.exceptions import InferenceError
from vms_face.core.logging import get_logger
from vms_face.core.metrics import ACTIVE_CAMERAS
from vms_face.domain.enums import CameraStatus, PersonRole
from vms_face.domain.models import Camera, DetectionEvent, Person, Tenant
from vms_face.infra.detection_cache import LatestDetectionCache, get_detection_cache
from vms_face.infra.detection_state import StatePublisher, get_state_publisher
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.minio_store import ObjectStore, get_object_store
from vms_face.infra.postgres import session_scope
from vms_face.infra.recognizers import Recognizer, get_recognizer
from vms_face.infra.redis_bus import RedisBus, get_bus
from vms_face.pipeline.orchestrator import StreamContext, StreamOrchestrator
from vms_face.services.enrollment import EnrollmentService
from vms_face.services.detection_zones import normalize_zones
from vms_face.services.face_quality import FaceQualityGate
from vms_face.services.sharding import forward_to_owner, owns
from vms_face.services.known_faces_bootstrap import bootstrap_known_faces, KNOWN_FACES_DIR

log = get_logger(__name__)

# Every legacy HTTP endpoint requires the configured X-API-Key. The frontend
# (AiFeed.jsx) doesn't issue JWTs, so we keep this router behind a single
# pre-shared secret. WebSocket auth is handled in-handler since FastAPI doesn't
# propagate router-level deps to WS routes the same way — see _ws_legacy_auth.
router = APIRouter(tags=["legacy-compat"], dependencies=[Depends(legacy_api_key_ok)])


async def _ws_legacy_auth(websocket: WebSocket) -> bool:
    """Authenticate a legacy WebSocket. Returns True if the connection should
    proceed, False if it was closed with a 1008 policy violation.

    Mirrors `legacy_api_key_ok` but for WS:
      - dev bypass: VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true → allow.
      - X-API-Key header matching LEGACY_API_KEY → allow.
      - `?api_key=` query string (browsers can't set headers on WS opens
        from <script>; query param is the only portable channel) → allow.
      - anything else → close with 1008 and return False."""
    if dev_bypass_allowed():
        return True
    expected = (settings.legacy_api_key or "").strip()
    if not expected:
        await websocket.close(code=1008, reason="legacy router disabled")
        return False
    header_key = websocket.headers.get("x-api-key")
    query_key = websocket.query_params.get("api_key")
    provided = (header_key or query_key or "").strip()
    if provided != expected:
        await websocket.close(code=1008, reason="invalid api key")
        return False
    return True


# ───────── helpers ─────────

async def _get_default_tenant(session: AsyncSession) -> Tenant:
    """Race-safe upsert via INSERT ... ON CONFLICT DO NOTHING.

    Two concurrent first-time API calls used to crash on the unique-name
    constraint; now the second caller's INSERT becomes a no-op and both
    fall through to the SELECT."""
    name = settings.default_tenant_name
    rows = await session.execute(select(Tenant).where(Tenant.name == name))
    tenant = rows.scalar_one_or_none()
    if tenant is not None:
        return tenant

    tenant_id = uuid.uuid4()
    stmt = (
        pg_insert(Tenant)
        .values(id=tenant_id, name=name)
        .on_conflict_do_nothing(index_elements=[Tenant.name])
    )
    await session.execute(stmt)
    await session.commit()

    rows = await session.execute(select(Tenant).where(Tenant.name == name))
    tenant = rows.scalar_one_or_none()
    if tenant is None:
        # Should not happen — a winner must exist.
        raise HTTPException(500, "tenant upsert failed")
    return tenant


async def _ensure_tenant_by_id(session: AsyncSession, tid: uuid.UUID) -> Tenant:
    """Race-safe get-or-create of the tenant a JWT points at. The backend mints
    tokens whose `tid` is a deterministic per-organization UUID; the row may not
    exist yet the first time that org touches the AI, so we upsert it."""
    rows = await session.execute(select(Tenant).where(Tenant.id == tid))
    tenant = rows.scalar_one_or_none()
    if tenant is not None:
        return tenant
    stmt = (
        pg_insert(Tenant)
        .values(id=tid, name=f"org:{tid}")
        .on_conflict_do_nothing(index_elements=[Tenant.id])
    )
    await session.execute(stmt)
    await session.commit()
    rows = await session.execute(select(Tenant).where(Tenant.id == tid))
    tenant = rows.scalar_one_or_none()
    if tenant is None:
        raise HTTPException(500, "tenant upsert failed")
    return tenant


async def request_tenant(
    session: AsyncSession = Depends(db_session),
    principal: Principal = Depends(current_principal),
) -> Tenant:
    """Tenant scope for a legacy write: the org tenant carried by the backend's
    per-organization JWT (`tid` claim). In dev-bypass mode `current_principal`
    resolves to the shared default tenant, preserving old single-tenant
    behaviour until every caller sends a token. This is THE seam that gives each
    organization its own isolated face gallery / person list / cameras."""
    return await _ensure_tenant_by_id(session, principal.tenant_id)


async def _resolve_or_create_camera(
    session: AsyncSession,
    monitor_id: str,
    *,
    tenant: Tenant,
    target_fps: float | None = None,
    detection_input_size: int | None = None,
    detection_zones: list[dict] | None = None,
) -> tuple[Camera, bool]:
    runtime_changed = False
    rtsp_url = settings.mediamtx_rtsp_template.format(
        host=settings.mediamtx_rtsp_host,
        port=settings.mediamtx_rtsp_port,
        monitor_id=monitor_id,
    )
    rows = await session.execute(
        select(Camera).where(Camera.tenant_id == tenant.id, Camera.code == monitor_id)
    )
    cam = rows.scalar_one_or_none()
    if cam is None:
        fps = target_fps if target_fps is not None else settings.target_fps
        det_size = detection_input_size if detection_input_size is not None else settings.insightface_det_size
        cam_id = uuid.uuid4()
        stmt = (
            pg_insert(Camera)
            .values(
                id=cam_id,
                tenant_id=tenant.id,
                code=monitor_id,
                name=monitor_id,
                rtsp_url=rtsp_url,
                target_fps=fps,
                detection_input_size=det_size,
                enabled=True,
                config_json={"detection_zones": normalize_zones(detection_zones)},
            )
            .on_conflict_do_nothing(index_elements=["tenant_id", "code"])
        )
        await session.execute(stmt)
        await session.commit()
        rows = await session.execute(
            select(Camera).where(Camera.tenant_id == tenant.id, Camera.code == monitor_id)
        )
        cam = rows.scalar_one_or_none()
        if cam is None:
            raise HTTPException(500, "camera upsert failed")
        runtime_changed = True
        log.info("auto-created camera", monitor_id=monitor_id, rtsp=rtsp_url)
    else:
        changed = False
        if cam.rtsp_url != rtsp_url:
            cam.rtsp_url = rtsp_url
            changed = True
            runtime_changed = True
        if target_fps is not None and abs(float(cam.target_fps or 0) - float(target_fps)) > 0.01:
            cam.target_fps = float(target_fps)
            changed = True
            runtime_changed = True
        if detection_input_size is not None and int(cam.detection_input_size or 0) != int(detection_input_size):
            cam.detection_input_size = int(detection_input_size)
            changed = True
            runtime_changed = True
        if detection_zones is not None:
            next_config = dict(cam.config_json or {})
            next_zones = normalize_zones(detection_zones)
            if next_config.get("detection_zones") != next_zones:
                next_config["detection_zones"] = next_zones
                cam.config_json = next_config
                changed = True
                runtime_changed = True
        if changed:
            cam.enabled = True
            cam.status = CameraStatus.OFFLINE
            await session.commit()
            await session.refresh(cam)
            log.info(
                "updated legacy camera runtime profile",
                monitor_id=monitor_id,
                rtsp=rtsp_url,
                target_fps=cam.target_fps,
                detection_input_size=cam.detection_input_size,
            )
    if cam.rtsp_url != rtsp_url:
        cam.rtsp_url = rtsp_url
        await session.commit()
        await session.refresh(cam)
        runtime_changed = True
        log.info("updated legacy camera rtsp", monitor_id=monitor_id, rtsp=rtsp_url)
    return cam, runtime_changed


def _is_running(camera_id: uuid.UUID) -> bool:
    return camera_id in _RUNNING


async def _stop_camera_internal(camera_id: uuid.UUID, *, mark_offline: bool = True) -> None:
    pair = _RUNNING.get(camera_id)
    if pair is None:
        if mark_offline:
            async with session_scope() as session:
                cam = await session.get(Camera, camera_id)
                if cam is not None:
                    cam.status = CameraStatus.OFFLINE
        return

    task, orch = pair
    await orch.stop()
    try:
        await asyncio.wait_for(task, timeout=5)
    except asyncio.TimeoutError:
        task.cancel()
    finally:
        _RUNNING.pop(camera_id, None)
        ACTIVE_CAMERAS.set(len(_RUNNING))

    if mark_offline:
        async with session_scope() as session:
            cam = await session.get(Camera, camera_id)
            if cam is not None:
                cam.status = CameraStatus.OFFLINE


async def _stop_other_running_cameras(keep_camera_id: uuid.UUID) -> None:
    others = [camera_id for camera_id in list(_RUNNING.keys()) if camera_id != keep_camera_id]
    if not others:
        return
    await asyncio.gather(
        *(_stop_camera_internal(camera_id) for camera_id in others),
        return_exceptions=True,
    )


async def _start_camera_internal(cam: Camera) -> None:
    """Shared launch path used by /set-camera AND the API startup
    reconciler. Constructs an orchestrator + state publisher and registers
    it in `_RUNNING`. Idempotent."""
    if cam.id in _RUNNING:
        return
    if not owns(cam.id):
        # Belongs to another process (services/sharding.py); the public
        # handlers forward there, the reconciler filters before calling.
        log.info("camera owned by another shard; not starting here", camera_id=str(cam.id))
        return

    rt = FaceRuntime.shared()
    rec = get_recognizer()
    rbus = get_bus()
    obj = get_object_store()
    qg = FaceQualityGate()
    publisher = get_state_publisher()

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
        # Operator-driven footfall settings; see services/footfall.py. None
        # when the operator hasn't enabled it yet — the orchestrator then
        # skips all footfall code paths for this camera.
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
    _RUNNING[cam.id] = (task, orch)
    ACTIVE_CAMERAS.set(len(_RUNNING))

    async def _flag_online() -> None:
        async with session_scope() as session:
            db_cam = await session.get(Camera, cam.id)
            if db_cam is not None:
                db_cam.status = CameraStatus.ONLINE

    await _flag_online()

    def _on_done(_t: asyncio.Task) -> None:
        _RUNNING.pop(cam.id, None)
        ACTIVE_CAMERAS.set(len(_RUNNING))

    task.add_done_callback(_on_done)


# ───────── endpoints ─────────

@router.post("/set-camera")
async def set_camera(
    request: Request,
    monitor_id: str = Form(...),
    target_fps: float | None = Form(None),
    detection_input_size: int | None = Form(None),
    detection_zones: str | None = Form(None),
    session: AsyncSession = Depends(db_session),
    tenant: Tenant = Depends(request_tenant),
    rt: FaceRuntime = Depends(runtime),
    rec: Recognizer = Depends(recognizer),
    rbus: RedisBus = Depends(bus),
    obj: ObjectStore = Depends(objects),
    qg: FaceQualityGate = Depends(quality_gate),
    publisher: StatePublisher = Depends(state_publisher),
) -> dict[str, Any]:
    """Frontend posts this when the user picks a camera. Idempotent: if the
    stream is already running we return the running status without
    relaunching. The camera is created under the caller's ORG tenant, so the
    live pipeline recognises against that organization's gallery."""
    fps = max(1.0, min(12.0, float(target_fps))) if target_fps is not None else None
    det_size = max(320, min(1280, int(detection_input_size))) if detection_input_size is not None else None
    zones = _parse_detection_zones(detection_zones)
    cam, runtime_changed = await _resolve_or_create_camera(
        session,
        monitor_id,
        tenant=tenant,
        target_fps=fps,
        detection_input_size=det_size,
        detection_zones=zones,
    )
    if not owns(cam.id):
        return await forward_to_owner(request, cam.id)
    if settings.legacy_single_active_camera:
        await _stop_other_running_cameras(cam.id)

    if _is_running(cam.id):
        if runtime_changed:
            await _stop_camera_internal(cam.id, mark_offline=False)
            await _start_camera_internal(cam)
            return {
                "ok": True,
                "monitor_id": monitor_id,
                "camera_id": str(cam.id),
                "source": cam.rtsp_url,
                "status": "restarted",
                "target_fps": cam.target_fps,
                "detection_input_size": cam.detection_input_size,
            }
        return {
            "ok": True,
            "monitor_id": monitor_id,
            "camera_id": str(cam.id),
            "source": cam.rtsp_url,
            "status": "already_running",
        }

    await _start_camera_internal(cam)

    return {
        "ok": True,
        "monitor_id": monitor_id,
        "camera_id": str(cam.id),
        "source": cam.rtsp_url,
        "status": "starting",
        "target_fps": cam.target_fps,
        "detection_input_size": cam.detection_input_size,
    }


@router.post("/stop-camera")
async def stop_camera(
    request: Request,
    monitor_id: str = Form(...),
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    """Stop face detection for one camera without deleting its camera row.

    This is used by the main backend when an operator removes a camera from
    the continuous AI detection list.
    """
    cam = await _lookup_camera_by_monitor_id(session, monitor_id)
    if cam is None:
        return {"ok": True, "monitor_id": monitor_id, "status": "not_found"}
    if not owns(cam.id):
        return await forward_to_owner(request, cam.id)

    await _stop_camera_internal(cam.id)
    return {
        "ok": True,
        "monitor_id": monitor_id,
        "camera_id": str(cam.id),
        "status": "stopped",
    }


@router.get("/status")
async def status(session: AsyncSession = Depends(db_session)) -> dict[str, Any]:
    """Frontend polls this every 2 seconds to render the engine-running pill.

    Old shape: { running, detecting, error, cameras: { [monitor_id]: {...} } }"""
    cache = get_detection_cache()
    rows = (await session.execute(select(Camera))).scalars().all()
    by_monitor: dict[str, dict[str, Any]] = {}
    for cam in rows:
        running = _is_running(cam.id)
        snap = cache.get(str(cam.id))
        by_monitor[cam.code] = {
            "running": bool(running),
            "detecting": bool(running) and bool(snap.get("running")),
            "source": cam.rtsp_url,
            "camera_id": str(cam.id),
            "fps": float(snap.get("fps") or 0.0),
            "persons": int(snap.get("persons") or len(snap.get("boxes", []))),
            "frames": int(snap.get("frames") or 0),
            "n_boxes": len(snap.get("boxes", [])),
            "error": None,
        }
    return {
        "engine": "vms_face",
        "running": len(_RUNNING) > 0,
        "detecting": len(_RUNNING) > 0,
        "error": None,
        "cameras": by_monitor,
    }


@router.get("/logs")
async def logs(
    limit: int = Query(50, le=200),
    session: AsyncSession = Depends(db_session),
    tenant: Tenant = Depends(request_tenant),
) -> list[dict[str, Any]]:
    """Frontend polls this every 3s for the right-pane timeline.

    Tenant-scoped: only this organization's detection events are returned.
    Without the filter every account saw every other account's face events
    (the cross-tenant alert leak, 2026-07-29)."""
    rows = (
        await session.execute(
            select(DetectionEvent)
            .where(DetectionEvent.tenant_id == tenant.id)
            .order_by(DetectionEvent.occurred_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    out: list[dict[str, Any]] = []
    name_cache: dict[uuid.UUID, str | None] = {}
    for ev in rows:
        name: str | None = None
        if ev.person_id is not None:
            if ev.person_id not in name_cache:
                p = await session.get(Person, ev.person_id)
                name_cache[ev.person_id] = p.full_name if p else None
            name = name_cache[ev.person_id]
        if name is None:
            name = "Unknown"
        out.append(
            {
                "id": str(ev.id),
                "name": name,
                "timestamp": ev.occurred_at.isoformat() if ev.occurred_at else None,
                "action": ev.kind.value,
                "camera_id": str(ev.camera_id),
                "track_id": ev.track_id,
                "similarity": ev.similarity,
                "snapshot_uri": ev.snapshot_uri,
                "gender": (ev.extra or {}).get("gender"),
            }
        )
    return out


@router.post("/upload")
async def upload(
    name: str = Form(...),
    file: UploadFile = File(...),
    session: AsyncSession = Depends(db_session),
    tenant: Tenant = Depends(request_tenant),
    enroller: EnrollmentService = Depends(enrollment),
    actor: str = Depends(operator_id),
) -> dict[str, Any]:
    """Frontend posts this from the 'Add Face' dialog. Maps to:
      - find-or-create Person under the caller's ORG tenant (race-safe)
      - enroll the uploaded image into that tenant's gallery
      - audit log entry"""
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(400, "empty file")

    full_name = name.strip()
    if not full_name:
        raise HTTPException(400, "name is required")

    rows = await session.execute(
        select(Person).where(Person.tenant_id == tenant.id, Person.full_name == full_name)
    )
    person = rows.scalar_one_or_none()
    if person is None:
        # Race-safe insert: tenant_id+external_id has a unique constraint;
        # full_name doesn't, so a duplicate full_name is allowed (different
        # people can share names — DPDP / RTI explicitly require this).
        person = Person(
            tenant_id=tenant.id,
            full_name=full_name,
            role=PersonRole.UNKNOWN,
            external_id=None,
        )
        session.add(person)
        await session.commit()
        await session.refresh(person)

    try:
        record = await enroller.enroll_image(
            session,
            person_id=person.id,
            image_bytes=image_bytes,
            source="upload",
            operator_id=actor,
        )
        await session.commit()
        await session.refresh(record)
    except InferenceError as e:
        raise HTTPException(422, str(e)) from e

    return {
        "ok": True,
        "person_id": str(person.id),
        "enrollment_id": str(record.id),
        "name": person.full_name,
    }


async def _person_for_name(session: AsyncSession, tenant: Tenant, name: str) -> Person:
    """Find-or-create a Person by name within a tenant (race-safe)."""
    full_name = (name or "").strip()[:255] or "Unknown"
    rows = await session.execute(
        select(Person).where(Person.tenant_id == tenant.id, Person.full_name == full_name)
    )
    person = rows.scalar_one_or_none()
    if person is None:
        person = Person(tenant_id=tenant.id, full_name=full_name, role=PersonRole.UNKNOWN, external_id=None)
        session.add(person)
        await session.commit()
        await session.refresh(person)
    return person


@router.post("/upload-dataset")
async def upload_dataset(
    file: UploadFile = File(...),
    session: AsyncSession = Depends(db_session),
    tenant: Tenant = Depends(request_tenant),
    enroller: EnrollmentService = Depends(enrollment),
    actor: str = Depends(operator_id),
) -> dict[str, Any]:
    """Bulk-enroll a ZIP of faces into the caller's ORG tenant — the automation
    behind 'upload a folder of people'.

    Layout: one sub-folder per person (folder name = the person's name) with
    their images inside; loose images at the archive root are enrolled under
    their filename stem. Each image → find-or-create Person (by name, in this
    tenant) → enroll into that tenant's gallery. Non-face / low-quality images
    are skipped and counted, never fatal. Once enrolled, the live pipeline
    (which scopes its gallery by Camera.tenant_id) starts recognising them."""
    import io
    import os as _os
    import zipfile

    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(400, "not a valid ZIP file") from None

    IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    enrolled = 0
    skipped = 0
    by_person: dict[str, int] = {}
    errors: list[str] = []
    person_cache: dict[str, Person] = {}

    for info in zf.infolist():
        if info.is_dir():
            continue
        parts = [
            seg for seg in info.filename.replace("\\", "/").split("/")
            if seg and not seg.startswith(".") and seg != "__MACOSX"
        ]
        if not parts:
            continue
        base = parts[-1]
        ext = _os.path.splitext(base)[1].lower()
        if ext not in IMG_EXT:
            continue
        person_name = parts[-2] if len(parts) >= 2 else _os.path.splitext(base)[0]
        try:
            data = zf.read(info)
            if not data:
                skipped += 1
                continue
            person = person_cache.get(person_name)
            if person is None:
                person = await _person_for_name(session, tenant, person_name)
                person_cache[person_name] = person
            await enroller.enroll_image(
                session, person_id=person.id, image_bytes=data, source="dataset", operator_id=actor,
            )
            await session.commit()
            enrolled += 1
            by_person[person.full_name] = by_person.get(person.full_name, 0) + 1
        except InferenceError as e:
            skipped += 1
            await session.rollback()
            if len(errors) < 20:
                errors.append(f"{base}: {e}")
        except Exception as e:  # noqa: BLE001 — one bad image must not abort the batch
            skipped += 1
            await session.rollback()
            if len(errors) < 20:
                errors.append(f"{base}: {e}")

    log.info("dataset enrolled", tenant=str(tenant.id), persons=len(by_person), enrolled=enrolled, skipped=skipped)
    return {
        "ok": True,
        "tenant": str(tenant.id),
        "persons": len(by_person),
        "enrolled": enrolled,
        "skipped": skipped,
        "by_person": by_person,
        "errors": errors,
    }


@router.get("/faces")
async def list_faces(
    session: AsyncSession = Depends(db_session),
    tenant: Tenant = Depends(request_tenant),
) -> dict[str, Any]:
    """List the watchlist people enrolled in the caller's org tenant, with a
    per-person enrollment (image) count. Powers the Face Watchlist grid."""
    from sqlalchemy import func as sa_func
    from vms_face.domain.models import FaceEnrollment as _FE

    rows = await session.execute(
        select(Person.id, Person.full_name, Person.role, sa_func.count(_FE.id))
        .select_from(Person)
        .outerjoin(_FE, _FE.person_id == Person.id)
        .where(Person.tenant_id == tenant.id)
        .group_by(Person.id, Person.full_name, Person.role)
        .order_by(Person.full_name)
    )
    faces = [
        {"person_id": str(pid), "name": name, "role": getattr(role, "value", str(role)), "images": int(cnt)}
        for (pid, name, role, cnt) in rows.all()
    ]
    return {"ok": True, "tenant": str(tenant.id), "count": len(faces), "faces": faces}


@router.delete("/faces")
async def delete_face_by_name(
    name: str = Query(...),
    user_id: str | None = Query(None),
    session: AsyncSession = Depends(db_session),
    tenant: Tenant = Depends(request_tenant),
    enroller: EnrollmentService = Depends(enrollment),
) -> dict[str, Any]:
    """Delete a watchlist person (by name) within the caller's org tenant:
    removes their gallery vectors + enrollment rows + the Person itself."""
    full_name = (name or "").strip()
    if not full_name:
        raise HTTPException(400, "name is required")
    rows = await session.execute(
        select(Person).where(Person.tenant_id == tenant.id, Person.full_name == full_name)
    )
    persons = rows.scalars().all()
    if not persons:
        raise HTTPException(404, "face not found")
    for p in persons:
        pid = p.id
        await session.delete(p)
        await session.commit()
        await enroller.delete_person_vectors(tenant_id=tenant.id, person_id=pid)
    return {"ok": True, "deleted": len(persons), "name": full_name}


@router.get("/api/detections/{camera_id}")
async def detections(
    camera_id: str,
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    """Frontend polls this every 1s as a fallback when the WebSocket is down."""
    cache = get_detection_cache()
    cam = await _lookup_camera_by_monitor_id(session, camera_id)
    if cam is None:
        return {"boxes": [], "frame_w": 0, "frame_h": 0, "running": False}

    snapshot = cache.get(str(cam.id))
    snapshot["running"] = _is_running(cam.id) and snapshot.get("running", False)
    return snapshot


@router.get("/api/cameras/{monitor_id}/mjpeg")
async def camera_mjpeg(monitor_id: str):
    """Live preview as MJPEG over multipart/x-mixed-replace.

    The whole reason this exists: MediaMTX's HLS muxer keeps crashing on
    our Hikvision streams with `unable to extract DTS: too many reordered
    frames` (a B-frame ordering issue inside MediaMTX's HLS implementation,
    not ours). MJPEG-over-multipart is what every commercial VMS ships
    for low-fps live previews (Frigate, Shinobi, BlueIris, Synology) for
    exactly this reason: it works with a bare `<img src=...>` in the
    browser, has no codec dependencies, no negotiation, and TCP
    naturally back-pressures slow viewers.

    Frame source: the SnapshotCache the orchestrator already populates
    on every processed frame. The cache self-throttles to ~4 fps, so we
    poll at 100 ms here and yield only when there's a NEW frame — that
    keeps idle CPU at zero and the visible frame rate at exactly what
    the cache produces.

    Headers:
      - `Cache-Control: no-store`     — never serve this stale
      - `X-Accel-Buffering: no`       — disable nginx/reverse-proxy
                                        buffering if anyone wraps this
      - `Content-Type` with the boundary token (must match the literal
                                        `--frame\r\n` separators below)
    """
    # snapshot_cache import stays function-local: the orchestrator hot
    # path also imports it lazily and we want the module load order to
    # be identical (avoids circular-import surprises if either side
    # grows new top-level deps).
    from vms_face.services.snapshot_cache import get_snapshot_cache

    cache = get_snapshot_cache()
    BOUNDARY = b"frame"

    async def generate():
        last_ts = 0.0
        # Emit a quick first frame if one is cached so the operator sees
        # something within the first 100 ms instead of staring at a blank
        # tile for a quarter second.
        try:
            while True:
                data, meta = cache.get(monitor_id)
                ts = float((meta or {}).get("ts", 0.0))
                if data and ts > last_ts:
                    last_ts = ts
                    yield (
                        b"--" + BOUNDARY + b"\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(data)).encode() + b"\r\n"
                        b"\r\n" + data + b"\r\n"
                    )
                # Poll every 100 ms — faster than 4 fps cache cadence so
                # we never sit on a fresh frame. The await yields to the
                # event loop so other handlers + the asyncio cancellation
                # path stay responsive.
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            # Client closed the socket (closed tab, navigated away). Let
            # the StreamingResponse unwind quietly.
            return

    return StreamingResponse(
        generate(),
        media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY.decode()}",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/api/cameras/{monitor_id}/snapshot.jpg")
async def camera_snapshot(monitor_id: str) -> Response:
    """Latest JPEG of the camera's decoded frame. Bypasses MediaMTX so the
    UI has a guaranteed-visible preview when the HLS muxer is crashed
    (the recurring "unable to extract DTS: too many reordered frames"
    issue with B-frame H.264 streams). The frontend polls this at ~4 fps
    as a fallback when its <video> element hasn't seen a frame in a while.

    Returns 404 with a tiny placeholder image when no frame is cached —
    e.g. camera offline, orchestrator not running yet, or the camera was
    just enabled and the first frame hasn't been encoded. The frontend
    treats 404 as "no preview yet" rather than an error.
    """
    from vms_face.services.snapshot_cache import get_snapshot_cache
    data, meta = get_snapshot_cache().get(monitor_id)
    if data is None:
        # 404 keeps the contract simple; `<img onError>` on the client
        # already handles this without flashing a broken-image icon.
        raise HTTPException(404, "no snapshot for this camera")
    headers = {
        # Bust caches per-frame: we replace the snapshot every ~250 ms,
        # the frontend bumps a `?t=` cache-buster on each poll, but in
        # case a proxy ignores that we tell it not to cache regardless.
        "Cache-Control": "no-store",
        "X-Snapshot-Frame-W": str((meta or {}).get("frame_w", 0)),
        "X-Snapshot-Frame-H": str((meta or {}).get("frame_h", 0)),
    }
    return Response(content=data, media_type="image/jpeg", headers=headers)


@router.get("/api/people-count")
async def people_count(
    session: AsyncSession = Depends(db_session),
) -> dict[str, Any]:
    """Aggregate per-camera people count for the dashboard tile.

    Returns:
      {
        "running_cameras": <int>,                       # cameras with active orchestrators
        "total":      <int>,                            # current people across all cameras
        "known":      <int>,                            # of which are recognised
        "unknown":    <int>,
        "smoothed_total": <int>,                        # 2s rolling max — better for UI
        "cameras": [
          {
            "camera_id": <uuid>,                        # internal UUID
            "monitor_id": <str>,                        # the public id AiFeed uses
            "code": <str>,                              # operator-set short name
            "total": <int>,
            "known": <int>,
            "unknown": <int>,
            "smoothed_total": <int>,
            "running": true,
          },
          ...
        ],
        "window_sec": 2.0,
        "ts": <unix>,
      }

    Cameras that have never published a frame, or have been marked offline,
    are excluded — `running_cameras` reflects active streams only."""
    cache = get_detection_cache()
    raw = cache.people_snapshot()

    # Decorate each camera with its monitor_id + operator-facing code. The
    # cache keys by internal UUID, the frontend speaks monitor_id.
    cam_ids = [c["camera_id"] for c in raw.get("cameras", [])]
    if cam_ids:
        try:
            cam_uuids = [uuid.UUID(c) for c in cam_ids]
        except ValueError:
            cam_uuids = []
        if cam_uuids:
            rows = await session.execute(select(Camera).where(Camera.id.in_(cam_uuids)))
            by_id = {str(r.id): r for r in rows.scalars()}
            for cam_entry in raw["cameras"]:
                row = by_id.get(cam_entry["camera_id"])
                if row is not None:
                    cam_entry["monitor_id"] = row.code
                    cam_entry["code"] = row.code
                    cam_entry["name"] = row.name
    return raw


@router.websocket("/ws")
async def ws_detections(
    websocket: WebSocket,
    camera_id: str = Query(..., alias="camera_id"),
) -> None:
    """Frontend opens this immediately after picking a camera."""
    # WS auth happens BEFORE accept so we can close with a 1008 policy
    # violation that the browser surfaces to the AiFeed reconnect logic.
    # FastAPI router-level deps don't propagate to @router.websocket, so
    # this gate is explicit. Dev mode (VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true)
    # short-circuits the check; prod requires X-API-Key header or
    # `?api_key=` query parameter.
    if not await _ws_legacy_auth(websocket):
        return
    await websocket.accept()

    async with session_scope() as session:
        cam = await _lookup_camera_by_monitor_id(session, camera_id)
    if cam is None:
        try:
            await websocket.send_json(
                {"boxes": [], "frame_w": 0, "frame_h": 0, "running": False, "error": "unknown_camera"}
            )
        finally:
            await websocket.close()
        return

    cache = get_detection_cache()
    cam_id_str = str(cam.id)
    await cache.subscribe(cam_id_str, websocket)
    log.info("ws connected", monitor_id=camera_id, camera_id=cam_id_str)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        log.info("ws disconnected", monitor_id=camera_id)
    except Exception as e:
        log.warning("ws error", err=str(e))
    finally:
        await cache.unsubscribe(cam_id_str, websocket)
        try:
            await websocket.close()
        except Exception:
            pass


@router.post("/reload-known-faces")
async def reload_known_faces() -> dict[str, Any]:
    stats = await bootstrap_known_faces()
    return {"ok": True, **stats}


@router.get("/known-faces-status")
async def known_faces_status(
    session: AsyncSession = Depends(db_session),
    tenant: Tenant = Depends(request_tenant),
) -> dict[str, Any]:
    import os
    from sqlalchemy import func as sa_func
    from vms_face.domain.models import FaceEnrollment as _FE

    persons_count = (
        await session.execute(
            select(sa_func.count()).select_from(Person).where(Person.tenant_id == tenant.id)
        )
    ).scalar_one()
    enrollments_count = (
        await session.execute(
            select(sa_func.count())
            .select_from(_FE)
            .join(Person, Person.id == _FE.person_id)
            .where(Person.tenant_id == tenant.id)
        )
    ).scalar_one()

    folder_files = 0
    if os.path.isdir(KNOWN_FACES_DIR):
        for f in os.listdir(KNOWN_FACES_DIR):
            if f.startswith(".") or "." not in f:
                continue
            ext = f.rsplit(".", 1)[-1].lower()
            if ext in {"jpg", "jpeg", "png", "webp", "bmp"}:
                folder_files += 1

    return {
        "ok": True,
        "tenant": tenant.name,
        "persons": int(persons_count),
        "enrollments": int(enrollments_count),
        "folder": KNOWN_FACES_DIR,
        "folder_files": folder_files,
    }


async def _lookup_camera_by_monitor_id(session: AsyncSession, monitor_id: str) -> Camera | None:
    """Try to interpret `monitor_id` as either a camera UUID or a camera code.

    Matched by `code` across ALL tenants: the code is the backend's globally
    unique monitorId, and this powers the no-JWT live-preview endpoints
    (detections / mjpeg / ws) which can't derive a tenant. Cameras now live
    under their org tenant rather than the shared default, so a default-scoped
    lookup would no longer find them."""
    try:
        as_uuid = uuid.UUID(monitor_id)
        cam = await session.get(Camera, as_uuid)
        if cam is not None:
            return cam
    except (ValueError, AttributeError):
        pass

    rows = await session.execute(
        select(Camera).where(Camera.code == monitor_id)
    )
    cams = rows.scalars().all()
    if not cams:
        return None
    # Same code can exist under more than one tenant during the migration to
    # per-org tenants (an old default-tenant row plus the new org-tenant one).
    # Prefer whichever is actually RUNNING an orchestrator so the live preview
    # reads the active stream, not the stale idle row.
    for cam in cams:
        if _is_running(cam.id):
            return cam
    return cams[0]


def _parse_detection_zones(value: str | None) -> list[dict] | None:
    if value is None or value == "":
        return None
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        raise HTTPException(400, "detection_zones must be valid JSON") from None
    return normalize_zones(loaded)
