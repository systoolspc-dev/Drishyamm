"""smart-cam-sfu-bridge — FastAPI control plane over the per-camera
RTSP→LiveKit publisher pool.

API surface (mirrors smart-cam-transcoder):
    GET    /health                       — liveness probe
    GET    /                             — service info + config
    GET    /publishers                   — list every running publisher + state
    GET    /publishers/{camera_id}       — one publisher's state + recent logs
    POST   /publishers/{camera_id}       — start (idempotent); body { use_clean? }
    DELETE /publishers/{camera_id}       — stop

This service is docker-internal only — backend talks to it via
`http://smart-cam-sfu-bridge:8005`. Authentication is not needed at
the network boundary; the backend's admin endpoint is the operator-
facing gate.

This is a Phase 4 SCAFFOLD. The actual FFmpeg WHIP publishing requires
FFmpeg ≥ 8.0 (`-f whip` muxer — it is NOT in the 7.1 release; the Docker
image copies a static 8.0 build and fails the build if the muxer is
missing). On a build without it the supervisor logs errors; the fallback
path using the `livekit-rtc` Python SDK lands next session.
"""
from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import publisher
from .config import settings


app = FastAPI(title="smart-cam-sfu-bridge", version="0.1.0")


# ── Schemas ───────────────────────────────────────────────────────────

class StartRequest(BaseModel):
    # When true, source from cam_<id>_clean (Phase 3 transcoded) instead
    # of cam_<id> (raw camera-pushed). Backend supervisor sets this when
    # the camera also has Phase 3 transcoding enabled.
    use_clean: bool = False


class PublisherOut(BaseModel):
    camera_id: str
    room_name: str
    src_path: str
    use_clean: bool
    running: bool
    started_at: Optional[float] = None
    restart_count: int = 0
    last_exit_code: Optional[int] = None


class PublisherDetail(PublisherOut):
    recent_logs: list[str]


def _state_to_out(s: publisher.PublisherState) -> PublisherOut:
    return PublisherOut(
        camera_id=s.camera_id,
        room_name=s.room_name,
        src_path=s.src_path,
        use_clean=s.use_clean,
        running=(s.process is not None and s.process.returncode is None),
        started_at=s.started_at,
        restart_count=s.restart_count,
        last_exit_code=s.last_exit_code,
    )


# ── Routes ────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "smart-cam-sfu-bridge",
        "version": app.version,
        "livekit_configured": bool(settings.livekit_url and settings.livekit_api_key and settings.livekit_api_secret),
    }


@app.get("/")
def root():
    return {
        "service": "smart-cam-sfu-bridge",
        "version": app.version,
        "port": settings.port,
        "mediamtx_base": settings.mediamtx_rtsp_base,
        "livekit_url": settings.livekit_url or "(unset)",
        "running_publishers": len(publisher.list_states()),
    }


@app.get("/publishers", response_model=list[PublisherOut])
def list_publishers():
    return [_state_to_out(s) for s in publisher.list_states()]


@app.get("/publishers/{camera_id}", response_model=PublisherDetail)
def get_publisher(camera_id: str):
    state = publisher.get(camera_id)
    if not state:
        raise HTTPException(404, f"no publisher for camera {camera_id}")
    base = _state_to_out(state)
    return PublisherDetail(**base.model_dump(), recent_logs=list(state.last_log_lines))


@app.post("/publishers/{camera_id}", response_model=PublisherOut, status_code=201)
def start_publisher(camera_id: str, req: StartRequest = StartRequest()):
    try:
        state = publisher.start(camera_id, use_clean=req.use_clean)
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e
    return _state_to_out(state)


@app.delete("/publishers/{camera_id}", status_code=200)
async def stop_publisher(camera_id: str):
    stopped = await publisher.stop(camera_id)
    if not stopped:
        raise HTTPException(404, f"no publisher for camera {camera_id}")
    return {"stopped": True, "camera_id": camera_id}
