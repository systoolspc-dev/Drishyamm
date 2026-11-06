"""Standalone runner for a single camera. Useful for development.

Usage:
    python -m vms_face.pipeline.run_stream \
        --tenant-id 00000000-0000-0000-0000-000000000001 \
        --camera-id 00000000-0000-0000-0000-000000000010 \
        --camera-code GATE-01 \
        --source rtsp://user:pass@host/stream

When `cache_backend=redis` (default), the orchestrator publishes per-frame
state through Redis Pub/Sub so the API process's WebSocket fan-out picks
it up without sharing memory with this CLI."""
from __future__ import annotations

import asyncio
import uuid

import typer

from vms_face.config import settings
from vms_face.core.logging import configure_logging, get_logger
from vms_face.core.tracing import init_tracing, instrument_redis, shutdown_tracing
from vms_face.infra.detection_state import get_state_publisher
from vms_face.infra.minio_store import get_object_store
from vms_face.infra.qdrant import get_qdrant_enrolled
from vms_face.infra.recognizers import get_recognizer
from vms_face.infra.redis_bus import get_bus
from vms_face.pipeline.orchestrator import StreamContext, StreamOrchestrator
from vms_face.services.face_quality import FaceQualityGate

app = typer.Typer(add_completion=False)
log = get_logger(__name__)


@app.command()
def main(
    tenant_id: str = typer.Option(..., "--tenant-id"),
    camera_id: str = typer.Option(..., "--camera-id"),
    camera_code: str = typer.Option("CAM", "--camera-code"),
    source: str = typer.Option(..., "--source", help="RTSP URL or video file path"),
    target_fps: float = typer.Option(settings.target_fps, "--fps"),
    zone: str | None = typer.Option(None, "--zone"),
    det_size: int | None = typer.Option(None, "--det-size", help="SCRFD input pixels (override)"),
) -> None:
    configure_logging()
    settings.assert_consistent()
    init_tracing("orchestrator")
    instrument_redis()
    try:
        asyncio.run(_run(tenant_id, camera_id, camera_code, source, target_fps, zone, det_size))
    finally:
        shutdown_tracing()


async def _run(
    tenant_id: str,
    camera_id: str,
    camera_code: str,
    source: str,
    target_fps: float,
    zone: str | None,
    det_size: int | None,
) -> None:
    qdrant = get_qdrant_enrolled()
    await qdrant.ensure_collection()

    objects = get_object_store()
    objects.ensure_buckets()

    bus = get_bus()
    if not await bus.ping():
        raise RuntimeError("redis is not reachable")

    recognizer = get_recognizer()
    quality = FaceQualityGate()

    # run_stream.py is the headless / debug entrypoint — it doesn't look
    # at cameras.config_json. Footfall is therefore always disabled here;
    # the operator-facing path is api/routes/legacy.py (_start_camera_internal).
    ctx = StreamContext(
        tenant_id=uuid.UUID(tenant_id),
        camera_id=uuid.UUID(camera_id),
        camera_code=camera_code,
        rtsp_url=source,
        target_fps=target_fps,
        embed_every_n=settings.embed_every_n_frames,
        snapshot_top_k=settings.snapshot_top_k_per_track,
        zone=zone,
        detection_input_size=det_size,
        footfall_config=None,
    )
    orch = StreamOrchestrator(
        ctx,
        recognizer=recognizer,
        bus=bus,
        objects=objects,
        quality=quality,
        state_publisher=get_state_publisher(),
    )
    try:
        await orch.run()
    finally:
        await bus.close()
        await qdrant.close()


if __name__ == "__main__":
    app()
