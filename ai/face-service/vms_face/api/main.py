from __future__ import annotations

import asyncio
import faulthandler
import sys
import time
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import select

from vms_face import __version__
from vms_face.api.routes import cameras, edge, embed, events, footfall, journey, learning, legacy, personnel, persons, reid, search, streams, tenants, ws
from vms_face.config import settings
from vms_face.core.executors import shutdown_all
from vms_face.core.logging import configure_logging, get_logger
from vms_face.core.metrics import BUILD_INFO
from vms_face.core.system_metrics import run_system_metrics
from vms_face.core.tracing import (
    init_tracing,
    instrument_fastapi,
    instrument_redis,
    instrument_sqlalchemy,
    shutdown_tracing,
)
from vms_face.domain.enums import CameraStatus
from vms_face.domain.models import Camera
from vms_face.infra.alerts_subscriber import run_alerts_subscriber
from vms_face.infra.backend_forwarder import run_backend_forwarder
from vms_face.infra.alert_backend_forwarder import run_alert_backend_forwarder
from vms_face.infra.detection_state import run_cam_state_subscriber
from vms_face.infra.insightface_runtime import FaceRuntime
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.postgres import session_scope
from vms_face.infra.qdrant import close_all as close_qdrant, get_qdrant_appearance, get_qdrant_enrolled
from vms_face.infra.redis_bus import get_bus
from vms_face.services.footfall import get_registry as get_footfall_registry
from vms_face.services.known_faces_bootstrap import schedule_bootstrap
from vms_face.services import sharding
from vms_face.workers.reid_worker import run_worker as run_reid_worker
from vms_face.workers.retention_worker import run_retention_worker

# A native crash (libav, CUDA, ORT) prints every thread's Python stack to
# stderr instead of just "Segmentation fault".
faulthandler.enable()

log = get_logger(__name__)


async def _reconcile_streams() -> None:
    """On API startup, re-launch in-process orchestrators for every camera
    we previously left in `ONLINE` state. Without this, an API restart kills
    every running stream and nothing brings them back."""
    if not settings.restart_online_streams_on_startup:
        log.info("reconciler: disabled by settings")
        return

    try:
        from vms_face.api.routes.legacy import _start_camera_internal  # local import — avoids cycles
    except Exception as e:
        log.warning("reconciler: legacy start unavailable", err=str(e))
        return

    async with session_scope() as session:
        rows = await session.execute(
            select(Camera).where(Camera.enabled.is_(True), Camera.status == CameraStatus.ONLINE)
        )
        cams = list(rows.scalars())
        if sharding.is_primary():
            sharding.prune({str(c.id) for c in cams})
        # Only this shard's cameras; the others restart theirs (sharding.owns).
        cameras_to_restart = [c for c in cams if sharding.owns(c.id)]

    if not cameras_to_restart:
        log.info("reconciler: no cameras to restart")
        return
    log.info("reconciler: restarting cameras", count=len(cameras_to_restart), **sharding.describe())
    for cam in cameras_to_restart:
        try:
            await _start_camera_internal(cam)
        except Exception as e:
            log.warning("reconciler: failed to restart camera", camera_id=str(cam.id), err=str(e))



async def _loop_lag_probe(stop: asyncio.Event, period: float = 0.1) -> None:
    """Records how late a 100 ms timer fires (metrics.LOOP_LAG)."""
    from vms_face.core.metrics import LOOP_LAG
    while not stop.is_set():
        t0 = time.perf_counter()
        await asyncio.sleep(period)
        LOOP_LAG.observe(max(0.0, time.perf_counter() - t0 - period))


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()

    # Cross-field config sanity (e.g. batched detect ↔ recognizer backend
    # compatibility). Fails loudly here so we don't ship a deploy that's
    # silently producing zero matches.
    settings.assert_consistent()

    # Tracing must init BEFORE the auto-instrumentations attach so the
    # provider is in place. The instrument_* calls are no-ops when OTel is
    # disabled. We also delay the SQLAlchemy hook until after the engine
    # has been imported (postgres module imports it at module load time).
    init_tracing("api")
    instrument_fastapi(app)
    instrument_redis()
    from vms_face.infra.postgres import get_engine
    instrument_sqlalchemy(get_engine())

    log.info("vms_face starting", version=__version__, env=settings.vms_env)
    BUILD_INFO.info({"version": __version__, "env": settings.vms_env})

    # Camera credential encryption posture check: invoking encryption_enabled()
    # forces the key validator to run, so a malformed VMS_CAMERA_CRED_KEY
    # crashes startup instead of corrupting writes silently.
    from vms_face.core.crypto import encryption_enabled
    if encryption_enabled():
        log.info("camera credential encryption: enabled (AES-256-GCM)")
    else:
        log.warning(
            "camera credential encryption: DISABLED (VMS_CAMERA_CRED_KEY unset). "
            "Camera passwords in rtsp_url are stored plaintext.",
        )

    # Auth posture check: in stage/prod a missing or short JWT secret means
    # every protected route fails closed (503), which is correct but worth
    # surfacing on boot so it's not a surprise to operators. Dev with the
    # opt-in bypass flag is allowed but flagged.
    from vms_face.core.security import jwt_configured
    if not jwt_configured():
        if settings.vms_env == "dev" and settings.vms_jwt_dev_bypass:
            log.warning(
                "JWT auth disabled (VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true). "
                "Every protected route binds to the default tenant. NEVER use this in prod.",
            )
        else:
            log.error(
                "VMS_JWT_SECRET is unset or too short (need >= 32 chars). "
                "All protected routes will return 503 until configured.",
                env=settings.vms_env,
            )
    if not (settings.legacy_api_key or "").strip():
        log.info("LEGACY_API_KEY unset; legacy router (/set-camera, /upload, /status, /logs) is disabled")

    stop_signal = asyncio.Event()
    background: list[asyncio.Task] = []
    background.append(asyncio.create_task(_loop_lag_probe(stop_signal), name="loop-lag-probe"))
    if float(settings.python_switch_interval) > 0:
        sys.setswitchinterval(float(settings.python_switch_interval))
        log.info("python switch interval set", seconds=float(settings.python_switch_interval))

    # Warmup the InsightFace model is opt-in: in the production deployment
    # (API + separate orchestrator processes) the API never runs detection
    # itself, so loading buffalo_l here just wastes ~600 MB of GPU memory.
    # Single-process dev (API also runs in-process orchestrators) should set
    # API_WARMUP_FACE_RUNTIME=true so the first frame doesn't cold-start.
    if settings.api_warmup_face_runtime:
        FaceRuntime.shared()
    else:
        log.info("skipping FaceRuntime warmup (API_WARMUP_FACE_RUNTIME=false)")

    # ensure infra is ready
    enrolled = get_qdrant_enrolled()
    await enrolled.ensure_collection()
    if settings.qdrant_appearance_enabled:
        appearance = get_qdrant_appearance()
        await appearance.ensure_collection()

    objects = get_object_store()
    objects.ensure_buckets()

    bus = get_bus()
    redis_ok = await bus.ping()
    if not redis_ok:
        log.warning("redis not reachable on startup; continuing without bus tasks")
    elif not sharding.is_primary():
        # Bus-fed singletons — the WS alert fan-out, the cam-state cache behind
        # /ws and people-count, and the two backend forwarders — run once, on
        # shard 0. A second copy would POST every overlay and alert twice.
        log.info("secondary shard: bus singletons left to shard 0", **sharding.describe())
    else:
        background.append(asyncio.create_task(
            run_alerts_subscriber(stop_signal),
            name="alerts-subscriber",
        ))
        if settings.cache_backend != "local":
            background.append(asyncio.create_task(
                run_cam_state_subscriber(stop_signal),
                name="cam-state-subscriber",
            ))
            # Live-overlay bridge: forwards per-frame boxes to the main VMS
            # backend's /api/internal/ai/events so AIOverlay.jsx can draw them.
            background.append(asyncio.create_task(
                run_backend_forwarder(stop_signal),
                name="backend-forwarder",
            ))
            # Persisted-alert bridge: watchlist/unknown events on vms.alerts →
            # /api/internal/ai/events → in-app alert + phone push (deduped).
            background.append(asyncio.create_task(
                run_alert_backend_forwarder(stop_signal),
                name="alert-backend-forwarder",
            ))

    if settings.system_metrics_enabled:
        background.append(asyncio.create_task(
            run_system_metrics(stop_signal),
            name="system-metrics",
        ))

    if settings.retention_worker_enabled and sharding.is_primary():
        background.append(asyncio.create_task(
            run_retention_worker(stop_signal),
            name="retention-worker",
        ))

    if settings.reid_worker_enabled and redis_ok and sharding.is_primary():
        background.append(asyncio.create_task(
            run_reid_worker(stop_signal),
            name="reid-worker",
        ))

    # Warm the genderage head before any camera starts: its first build takes
    # the box-wide CUDA gate (infra/cuda_gate.py) and must not land on the
    # event loop mid-stream.
    if settings.face_attributes_enabled and sharding.camera_shards() and sharding.shard_index() in sharding.camera_shards():
        try:
            from vms_face.infra.genderage import get_genderage_estimator
            await asyncio.get_running_loop().run_in_executor(None, get_genderage_estimator)
        except Exception as e:  # noqa: BLE001
            log.warning("genderage warm-up failed", err=str(e))

    # Restart any orchestrators we previously had running. Do this AFTER
    # the cam-state subscriber so the live overlay is wired up.
    try:
        await _reconcile_streams()
    except Exception as e:
        log.warning("stream reconciler failed", err=str(e))

    # Bootstrap the on-disk known_faces gallery in the background.
    bootstrap_task = schedule_bootstrap() if sharding.is_primary() else None

    # Spin up the footfall flusher. It's a single asyncio task that wakes
    # every ~5s, drains the in-memory per-camera delta buffers and UPSERTs
    # them into footfall_minute_buckets. Cheap when no camera has the
    # toggle on (nothing in the buffers → no SQL).
    footfall_registry = get_footfall_registry()
    footfall_registry.start()

    try:
        yield
    finally:
        log.info("vms_face shutting down")
        stop_signal.set()
        for t in background:
            t.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await t
        if bootstrap_task is not None and not bootstrap_task.done():
            bootstrap_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await bootstrap_task
        # Drain the footfall flusher BEFORE Postgres is shut down so the
        # final batch of in-memory deltas lands on disk. aclose() does a
        # last best-effort _flush_once() internally.
        with suppress(Exception):
            await footfall_registry.aclose()
        await close_qdrant()
        await bus.close()
        shutdown_all(wait=False)
        shutdown_tracing()


app = FastAPI(
    title="drisyam VMS face service",
    version=__version__,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict:
    """Posture report rather than a thumbs-up. Returns the configuration that
    decides whether protected routes will work, plus a cheap reachability
    probe for Redis. Callers can read this with `curl localhost:8001/healthz`
    to diagnose 401/502s without grepping the log."""
    from vms_face.core.security import dev_bypass_allowed, jwt_configured
    from vms_face.core.crypto import encryption_enabled
    from vms_face.api.routes.streams import _RUNNING

    redis_ok = False
    try:
        redis_ok = await get_bus().ping()
    except Exception:
        redis_ok = False

    auth_mode = (
        "dev-bypass" if dev_bypass_allowed()
        else "jwt" if jwt_configured()
        else "MISCONFIGURED"
    )

    return {
        "status": "ok" if auth_mode != "MISCONFIGURED" else "degraded",
        "version": __version__,
        "env": settings.vms_env,
        "auth": {
            "mode": auth_mode,
            "jwt_configured": jwt_configured(),
            "dev_bypass": dev_bypass_allowed(),
            "legacy_router_open": (
                bool(settings.legacy_api_key) or dev_bypass_allowed()
            ),
        },
        "downstream": {
            "redis": "ok" if redis_ok else "unreachable",
        },
        "pipeline": {
            "active_streams": len(_RUNNING),
            "recognizer_backend": settings.recognizer_backend,
            "detection_input_size": settings.insightface_det_size,
            "batched_inference": settings.pipeline_batched_inference,
            "camera_cred_encryption": encryption_enabled(),
        },
    }


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


app.include_router(tenants.router)
app.include_router(persons.router)
app.include_router(personnel.router)
app.include_router(cameras.router)
app.include_router(streams.router)
app.include_router(events.router)
app.include_router(search.router)
app.include_router(learning.router)
app.include_router(journey.router)
app.include_router(ws.router)
app.include_router(reid.router)
app.include_router(legacy.router)
app.include_router(footfall.router)
# /api/embed/face — used by person-tracker for query-face embedding.
app.include_router(embed.router)
app.include_router(edge.router)
