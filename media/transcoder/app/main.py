"""smart-cam-transcoder — FastAPI control plane over the FFmpeg
subprocess manager.

API surface:
    GET  /health                       — liveness probe
    GET  /transcoders                  — list every running transcoder + state
    GET  /transcoders/{camera_id}      — one transcoder's state + recent logs
    POST /transcoders/{camera_id}      — start (idempotent)
    DELETE /transcoders/{camera_id}    — stop

This service has no auth of its own. It binds to the docker-internal
network only — backend talks to it via `http://smart-cam-transcoder:8004`.
Production exposure (if needed) goes through smart-cam-backend, same
pattern as person-tracker and face-reconstruct.
"""
from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import transcoder
from .config import settings

app = FastAPI(title="smart-cam-transcoder", version="0.1.0")


# ── Schemas ───────────────────────────────────────────────────────────

class StartRequest(BaseModel):
    bitrate_kbps: Optional[int] = None


class TranscoderOut(BaseModel):
    camera_id: str
    src_path: str
    dst_path: str
    bitrate_kbps: int
    running: bool
    started_at: Optional[float] = None
    restart_count: int = 0
    last_exit_code: Optional[int] = None


class TranscoderDetail(TranscoderOut):
    recent_logs: list[str]


def _state_to_out(s: transcoder.TranscoderState) -> TranscoderOut:
    return TranscoderOut(
        camera_id=s.camera_id,
        src_path=s.src_path,
        dst_path=s.dst_path,
        bitrate_kbps=s.bitrate_kbps,
        running=(s.process is not None and s.process.returncode is None),
        started_at=s.started_at,
        restart_count=s.restart_count,
        last_exit_code=s.last_exit_code,
    )


# ── Routes ────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "smart-cam-transcoder", "version": app.version}


@app.get("/transcoders", response_model=list[TranscoderOut])
def list_transcoders():
    return [_state_to_out(s) for s in transcoder.list_states()]


@app.get("/transcoders/{camera_id}", response_model=TranscoderDetail)
def get_transcoder(camera_id: str):
    state = transcoder.get(camera_id)
    if not state:
        raise HTTPException(404, f"no transcoder for camera {camera_id}")
    out = _state_to_out(state)
    return TranscoderDetail(**out.model_dump(), recent_logs=list(state.last_log_lines))


@app.post("/transcoders/{camera_id}", response_model=TranscoderOut, status_code=201)
def start_transcoder(camera_id: str, req: StartRequest = StartRequest()):
    try:
        state = transcoder.start(camera_id, bitrate_kbps=req.bitrate_kbps)
    except RuntimeError as e:
        # Capacity exceeded — bubble back as 503 so the backend can
        # surface "out of encoder slots" cleanly to the operator.
        raise HTTPException(503, str(e)) from e
    return _state_to_out(state)


@app.delete("/transcoders/{camera_id}", status_code=200)
async def stop_transcoder(camera_id: str):
    stopped = await transcoder.stop(camera_id)
    if not stopped:
        raise HTTPException(404, f"no transcoder for camera {camera_id}")
    return {"stopped": True, "camera_id": camera_id}


@app.get("/")
def root():
    return {
        "service": "smart-cam-transcoder",
        "version": app.version,
        "port": settings.port,
        "mediamtx_base": settings.mediamtx_rtsp_base,
        "clean_path_suffix": settings.clean_path_suffix,
    }
