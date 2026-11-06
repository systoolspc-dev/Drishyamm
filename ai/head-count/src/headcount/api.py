"""FastAPI application exposing head counts + a live MJPEG preview over REST."""

from __future__ import annotations

import logging
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import AppConfig
from .forwarder import start_forwarder
from .manager import StreamManager
from .source import start_source

log = logging.getLogger("headcount.api")

FRONTEND_DIR = Path(__file__).resolve().parent / "web"


def create_app(config: AppConfig) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        manager = StreamManager(config)
        manager.start()
        app.state.manager = manager
        # Dynamic camera source — add/remove workers as users toggle headcount
        # per camera in the VMS (populates from the backend camera registry).
        stop_source = threading.Event()
        app.state.source = start_source(manager, config.source, stop_source)
        # Forward live counts to the VMS backend (occupancy gauge + alerts).
        stop_forward = threading.Event()
        app.state.forwarder = start_forwarder(manager, config.forward, stop_forward)
        log.info("pipeline ready")
        try:
            yield
        finally:
            stop_source.set()
            stop_forward.set()
            manager.stop()
            log.info("pipeline stopped")

    app = FastAPI(title="Head Count API", version=__import__("headcount").__version__,
                  lifespan=lifespan)

    # Allow the dashboard to be opened from any origin / a plain file:// during dev.
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    )

    def mgr(app: FastAPI) -> StreamManager:
        return app.state.manager

    # ---- JSON endpoints -------------------------------------------------
    @app.get("/health")
    def health():
        h = mgr(app).health()
        code = 200 if h["status"] in ("healthy", "degraded") else 503
        return JSONResponse(h, status_code=code)

    @app.get("/count")
    def count_all():
        return mgr(app).counts()

    @app.get("/streams")
    def streams():
        return {"streams": mgr(app).all_snapshots()}

    @app.get("/count/{stream_id}")
    def count_one(stream_id: str):
        snap = mgr(app).get(stream_id)
        if snap is None:
            raise HTTPException(status_code=404, detail=f"unknown stream {stream_id!r}")
        return snap

    # ---- Live preview ---------------------------------------------------
    def _require_worker(stream_id: str):
        w = mgr(app).worker(stream_id)
        if w is None:
            raise HTTPException(status_code=404, detail=f"unknown stream {stream_id!r}")
        if not w.preview:
            raise HTTPException(status_code=503, detail="preview disabled (api.preview=false)")
        return w

    @app.get("/snapshot/{stream_id}")
    def snapshot(stream_id: str):
        """Single latest annotated JPEG frame."""
        w = _require_worker(stream_id)
        jpg = w.get_jpeg()
        if jpg is None:
            raise HTTPException(status_code=503, detail="no frame yet")
        return Response(jpg, media_type="image/jpeg")

    @app.get("/video/{stream_id}")
    def video(stream_id: str):
        """Multipart MJPEG stream of the annotated feed (drop-in for an <img> src)."""
        w = _require_worker(stream_id)
        interval = 1.0 / config.api.preview_fps

        def frames():
            while True:
                jpg = w.get_jpeg()
                if jpg is not None:
                    yield (b"--frame\r\nContent-Type: image/jpeg\r\n"
                           b"Content-Length: " + str(len(jpg)).encode() + b"\r\n\r\n"
                           + jpg + b"\r\n")
                time.sleep(interval)

        return StreamingResponse(
            frames(), media_type="multipart/x-mixed-replace; boundary=frame"
        )

    # ---- Dashboard (static frontend) ------------------------------------
    # Mounted last so it doesn't shadow the API routes above.
    if FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="dashboard")
        log.info("dashboard served from %s at /", FRONTEND_DIR)

    return app
