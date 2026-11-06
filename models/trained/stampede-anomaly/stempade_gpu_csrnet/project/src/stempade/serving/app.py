"""FastAPI serving layer: runs one StreamWorker per camera, exposes status + a
live dashboard. Import of fastapi/uvicorn is lazy (Phase-4 optional deps)."""
from __future__ import annotations

from pathlib import Path

from ..config import load_config
from ..fusion import RiskLevel
from .alerting import AlertManager, LogSink, WebhookSink
from .worker import StreamWorker

_DASHBOARD = Path(__file__).parent / "dashboard.html"


def _build_workers(cfg: dict, manager: AlertManager) -> dict[str, StreamWorker]:
    cams = cfg.get("cameras")
    if not cams:  # single-camera fallback from ingestion.source
        cams = [{"name": "cam0", "source": cfg.get("ingestion", {}).get("source")}]

    workers: dict[str, StreamWorker] = {}
    for cam in cams:
        baseline = homography = None
        if cam.get("baseline"):
            from ..calibration import Baseline
            baseline = Baseline.load(cam["baseline"])
        if cam.get("homography"):
            import json
            import numpy as np
            from ..calibration import Homography
            homography = Homography(np.array(json.load(open(cam["homography"]))))
        workers[cam["name"]] = StreamWorker(
            cam["name"], cam["source"], cfg, manager,
            baseline=baseline, homography=homography)
    return workers


def create_app(cfg: dict):
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse, JSONResponse

    acfg = cfg.get("alerting", {})
    sinks = [LogSink()]
    if acfg.get("webhook_url"):
        sinks.append(WebhookSink(acfg["webhook_url"]))
    manager = AlertManager(
        sinks=sinks,
        min_level=RiskLevel[acfg.get("min_level", "HIGH")],
        cooldown_s=acfg.get("cooldown_s", 30.0),
    )
    workers = _build_workers(cfg, manager)

    app = FastAPI(title="stempade")

    @app.on_event("startup")
    def _start():
        for w in workers.values():
            w.start()

    @app.on_event("shutdown")
    def _stop():
        for w in workers.values():
            w.stop()

    @app.get("/api/status")
    def status():
        return JSONResponse({"cameras": [w.status() for w in workers.values()]})

    @app.get("/", response_class=HTMLResponse)
    def dashboard():
        return _DASHBOARD.read_text()

    return app


def serve(config_path: str | None = None, host: str = "0.0.0.0", port: int = 8000):
    import uvicorn

    cfg = load_config(config_path)
    uvicorn.run(create_app(cfg), host=host, port=port)
