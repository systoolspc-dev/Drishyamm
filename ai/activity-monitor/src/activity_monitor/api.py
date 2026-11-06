"""FastAPI application exposing head counts + a live MJPEG preview over REST."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import AppConfig
from .manager import StreamManager

log = logging.getLogger("activity_monitor.api")

FRONTEND_DIR = Path(__file__).resolve().parent / "web"


def create_app(config: AppConfig) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        manager = StreamManager(config)
        manager.start()
        app.state.manager = manager
        log.info("pipeline ready")
        try:
            yield
        finally:
            manager.stop()
            log.info("pipeline stopped")

    app = FastAPI(title="Activity Monitor API", version=__import__("activity_monitor").__version__,
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

    @app.get("/conversations")
    def conversations():
        """Who is talking to whom — pairs of person IDs per stream."""
        return mgr(app).conversations()

    @app.get("/count/{stream_id}")
    def count_one(stream_id: str):
        snap = mgr(app).get(stream_id)
        if snap is None:
            raise HTTPException(status_code=404, detail=f"unknown stream {stream_id!r}")
        return snap

    # ---- Per-person over-time (the "who / how many / how long") ----------
    @app.get("/activity/people")
    def activity_people():
        """Per-person totals for today: seconds in each state, phone-usage count
        + minutes, current live state. Sorted by phone time."""
        return mgr(app).activity_people()

    @app.get("/activity/sessions")
    def activity_sessions(limit: int = 100, date: str | None = None):
        """Completed phone-usage sessions (evidence log): who, when, how long."""
        return mgr(app).activity_sessions(limit=limit, date=date)

    @app.get("/activity/history")
    def activity_history(days: int = 7):
        """Per-person daily totals over the last `days` (trends over time)."""
        return mgr(app).activity_history(days=days)

    # ---- In/out attendance (line crossing) ------------------------------
    @app.get("/activity/attendance")
    def activity_attendance():
        """Intelligent per-person attendance: first entry, in/out counts, total
        time inside, and who is currently inside (from vms_face recognition)."""
        return mgr(app).attendance()

    @app.get("/activity/crossings")
    def activity_crossings(limit: int = 200, date: str | None = None):
        """Complete entry/exit feed — every crossing (recognised + unknown)."""
        return mgr(app).activity_crossings(limit=limit, date=date)

    @app.post("/activity/attendance/reset")
    def activity_reset(prefix: str | None = None):
        """Clear attendance from memory + DB — all, or only names starting with
        `prefix` (e.g. ?prefix=TEST_ for test cleanup)."""
        return mgr(app).reset_attendance(prefix)

    @app.get("/activity/alerts")
    def activity_alerts(limit: int = 100, date: str | None = None, tier: str | None = None):
        """Policy alerts (watchlist / stranger / after-hours), newest first, + today's counts."""
        return mgr(app).alerts(limit=limit, date=date, tier=tier)

    @app.post("/activity/alerts/{alert_id}/ack")
    def activity_ack_alert(alert_id: int):
        return mgr(app).ack_alert(alert_id)

    @app.post("/activity/alerts/clear")
    def activity_clear_alerts():
        return mgr(app).clear_alerts()

    @app.get("/activity/metrics")
    def activity_metrics(date: str | None = None):
        """Detection-funnel health for an IST day (default today): dedup ratio,
        recognition rate per camera, session sanity."""
        return mgr(app).health_metrics(date=date)

    # ---- Real-time person tracker ----------------------------------------
    @app.get("/track/live")
    def track_live():
        """All live tracks: who is where right now + camera occupancy map."""
        return mgr(app).track_live()

    @app.get("/track/live/{name}")
    def track_live_one(name: str):
        """One person's full track: status, current camera, hop-by-hop trail."""
        return mgr(app).track_live(name)

    @app.get("/track/graph")
    def track_graph():
        """The learned movement graph (camera adjacency + median walk times)."""
        return mgr(app).track_graph()

    @app.post("/track/reset")
    def track_reset():
        return mgr(app).track_reset()

    @app.get("/activity/events")
    def activity_events(types: str | None = None, camera: str | None = None,
                        name: str | None = None, date: str | None = None, limit: int = 300):
        """Unified event log — attendance + alerts merged, newest-first. `types` is a
        CSV subset of {attendance,alert}."""
        tlist = [t.strip() for t in types.split(",")] if types else None
        return mgr(app).event_log(types=tlist, camera=camera, name=name, date=date, limit=limit)

    @app.get("/activity/cameras")
    def activity_cameras():
        """Cameras currently running the pose/phone activity pipeline (+ live status)."""
        return mgr(app).activity_cameras()

    @app.post("/activity/cameras")
    def activity_set_cameras(payload: dict = Body(...)):
        """Set the FULL desired activity-camera list (runtime, no restart):
        {cameras:[{id, name, source, vms_camera}]}. Adds/removes workers to match."""
        return mgr(app).reconcile_streams(payload.get("cameras") or [])

    @app.get("/activity/line")
    def activity_get_line(camera: str | None = None):
        """The in/out line for a camera_code (null until drawn)."""
        return mgr(app).get_line(camera)

    @app.put("/activity/line")
    def activity_set_line(payload: dict = Body(...)):
        """Save the in/out line: {camera:<camera_code>, line:{x1,y1,x2,y2,inside_x,inside_y}} (normalised 0..1)."""
        return mgr(app).set_line(payload.get("camera"), payload.get("line"))

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
