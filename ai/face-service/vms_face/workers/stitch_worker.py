"""RQ worker that renders a journey: clips → overlay → concat → MP4 + PDF,
persists the Journey, and emits journey.events.

Run:  python -m vms_face.workers.stitch_worker

Ported from person-tracker/app/workers/stitch_worker.py with the P1d fixes:
ensure the output bucket exists at startup (the worker never runs the API
lifespan); enforce stitch_max_total_sec; persist a Journey + emit Kafka after
upload; idempotent on RQ retry (skip if the job already produced a journey);
video/report/map URLs use the /journey/stitch/* prefix."""
from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

from redis import Redis
from rq import Connection, Worker

from vms_face.config import settings
from vms_face.core.logging import configure_logging, get_logger
from vms_face.infra.minio_store import get_object_store
from vms_face.journey import events, pdf, persistence, stitch_jobs, video
from vms_face.journey.contracts import Sighting
from vms_face.journey.timefmt import fmt_local

configure_logging()
log = get_logger(__name__)


def process_job(job_id_str: str) -> None:
    """Top-level RQ callable. Never raises — failures land in the job hash."""
    job_id = uuid.UUID(job_id_str)
    job = stitch_jobs.get_job_sync(job_id)
    if job is None:
        log.error("stitch job not found", job_id=job_id_str)
        return

    # Idempotency: an RQ retry of an already-completed job must not re-render
    # or re-persist (which would mint a duplicate Unknown person + journey).
    if job.get("status") == "done" and job.get("journey_id"):
        log.info("stitch job already done; skipping", job_id=job_id_str)
        return

    stitch_jobs.update_job_sync(job_id, status="rendering", progress=0.0, message="extracting clips")

    request = json.loads(job["request"])
    sightings = [Sighting(**s) for s in request.get("sightings", [])]
    include_overlays = request.get("include_overlays", True)

    # Highlight-reel cap: a person can re-visit one camera dozens of times, which
    # makes a long, repetitive video. Keep the N highest-confidence stops, then put
    # them back in chronological order so the journey still reads start→end.
    max_clips = int(getattr(settings, "stitch_max_clips", 0) or 0)
    if max_clips > 0 and len(sightings) > max_clips:
        top = sorted(sightings, key=lambda s: s.best_similarity, reverse=True)[:max_clips]
        sightings = sorted(top, key=lambda s: s.started_at)
        log.info("stitch capped to top stops", kept=len(sightings), requested=len(request.get("sightings", [])))

    workdir = video.work_dir()
    clip_paths: list[Path] = []
    budget = float(settings.stitch_max_total_sec)
    used = 0.0
    truncated = False
    try:
        # ── Phase 1: extract one clip per sighting (within the time budget) ──
        for i, s in enumerate(sightings, start=1):
            if used >= budget:
                truncated = True
                log.warning("stitch budget reached; truncating", used=used, budget=budget,
                            rendered=len(clip_paths), total=len(sightings))
                break
            stitch_jobs.update_job_sync(
                job_id, progress=0.05 + 0.65 * (i / max(1, len(sightings))),
                message=f"extracting clip {i}/{len(sightings)}")
            raw_clip = workdir / f"raw_{i:04d}.mp4"
            if not video.extract_clip(sighting=s, out_path=raw_clip):
                continue
            clip = raw_clip
            if include_overlays:
                labeled = workdir / f"lab_{i:04d}.mp4"
                label = f"Cam {s.camera_code or s.camera_id}  {fmt_local(s.started_at)}  match {int(s.best_similarity*100)}%"
                if video.apply_overlay(src=raw_clip, dst=labeled, label=label):
                    clip = labeled
            clip_paths.append(clip)
            # Account for the CAPPED clip length (extract_clip trims to clip_max_sec)
            # so the budget reflects real output, not the full sighting span.
            clip_sec = min((s.ended_at - s.started_at).total_seconds(), float(settings.clip_max_sec))
            used += clip_sec + settings.clip_pad_before_sec + settings.clip_pad_after_sec

        if not clip_paths:
            stitch_jobs.update_job_sync(job_id, status="failed", progress=1.0,
                failed_reason="no clips could be extracted (no recordings cover the sighting times)")
            return

        # ── Phase 2: concat ─────────────────────────────────────────────────
        stitch_jobs.update_job_sync(job_id, progress=0.82, message="concatenating clips")
        stitched = workdir / "stitched.mp4"
        if not video.concat(clip_paths, out_path=stitched):
            stitch_jobs.update_job_sync(job_id, status="failed", progress=1.0,
                failed_reason="ffmpeg concat returned non-zero")
            return

        # ── Phase 3: upload MP4 + render PDF ────────────────────────────────
        store = get_object_store()
        bucket = settings.minio_bucket_output
        stitch_jobs.update_job_sync(job_id, progress=0.9, message="uploading mp4")
        video_key = f"videos/{job_id}.mp4"
        video_uri = store.put_bytes(bucket, video_key, stitched.read_bytes(), "video/mp4")

        report_key = f"reports/{job_id}.pdf"
        report_uri = f"s3://{bucket}/{report_key}"
        try:
            stitch_jobs.update_job_sync(job_id, progress=0.94, message="rendering report")
            pdf.render_for_job(job, key=report_key)
        except Exception as e:  # report is non-essential; MP4 already exists
            log.warning("pdf render failed (non-fatal)", err=str(e), job_id=job_id_str)
            report_uri = None

        # ── Phase 4: persist Journey + emit journey.events ──────────────────
        # tenant_id is stamped server-side by the enqueue route; guard against a
        # malformed/legacy payload rather than KeyError-crashing after the render.
        tenant_id = request.get("tenant_id")
        if not tenant_id:
            stitch_jobs.update_job_sync(job_id, status="failed", progress=1.0,
                failed_reason="job payload missing tenant_id")
            return
        stitch_jobs.update_job_sync(job_id, progress=0.97, message="saving journey")
        journey_id = persistence.persist_journey_sync(
            tenant_id=tenant_id,
            person_id=request.get("person_id"),
            created_by=request.get("created_by"),
            job_id=str(job_id),
            sightings=request.get("sightings", []),
            video_uri=video_uri,
            report_uri=report_uri,
            window_start=request.get("window_start"),
            window_end=request.get("window_end"),
        )

        events.emit_journey_event_sync({
            "event": "journey.stitched",
            "schema_version": 1,
            "journey_id": str(journey_id),
            "tenant_id": tenant_id,
            "person_id": request.get("person_id"),
            "is_unknown": request.get("person_id") is None,
            "mode": "forensic",
            "job_id": str(job_id),
            "status": "ready",
            "cameras_count": len({str(s.get("camera_id")) for s in request.get("sightings", [])}),
            "video_uri": video_uri,
            "report_uri": report_uri,
            "created_by": request.get("created_by"),
        })

        stitch_jobs.update_job_sync(
            job_id, status="done", progress=1.0,
            message=f"rendered {len(clip_paths)} clips" + (" (truncated to budget)" if truncated else ""),
            video_key=video_key, journey_id=str(journey_id),
            video_url=f"/journey/stitch/{job_id}/video",
            report_url=f"/journey/stitch/{job_id}/report.pdf",
            map_url=f"/journey/stitch/{job_id}/map.json",
        )
    except Exception as e:
        log.exception("stitch job failed", job_id=job_id_str)
        stitch_jobs.update_job_sync(job_id, status="failed", progress=1.0, failed_reason=str(e))
    finally:
        video.cleanup(workdir)


def main() -> None:
    # The worker bypasses the FastAPI lifespan, so create the output bucket here.
    try:
        get_object_store().ensure_bucket(settings.minio_bucket_output)
    except Exception as e:
        log.warning("could not pre-create output bucket", err=str(e))
    conn = Redis.from_url(settings.redis_url)
    log.info("journey stitch worker ready", queue=settings.stitch_queue_name)
    with Connection(conn):
        Worker([settings.stitch_queue_name]).work(with_scheduler=False)


if __name__ == "__main__":
    sys.exit(main())
