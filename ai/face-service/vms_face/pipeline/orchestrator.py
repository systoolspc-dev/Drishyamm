from __future__ import annotations

import asyncio
import datetime as dt
import time
import uuid
from dataclasses import dataclass

from vms_face.config import settings
from vms_face.core.executors import get_gpu_pool, get_ingest_pool, get_io_pool
from vms_face.core.logging import get_logger
from vms_face.core.metrics import (
    CAMERA_FPS,
    DETECT_LATENCY,
    DETECTIONS,
    EMBED_FAILURES,
    EMBED_LATENCY,
    EMBED_SKIPPED,
    EMBEDDINGS,
    FRAMES_DROPPED,
    FRAMES_INGESTED,
    GENDERAGE_CALLS,
    LATCH_DECISIONS,
    LATCH_TRANSITIONS,
    MOTION_GATE_SKIPS,
    PIPELINE_FRAME_LATENCY,
    PIPELINE_STAGE_LATENCY,
    DETECTIONS_DROPPED_PRETRACK,
    QUALITY_LATENCY,
    REASSOCIATIONS,
    STREAM_HEALTHY,
    STREAM_RESTARTS,
    TIME_TO_IDENTITY,
    TRACKS_OPENED,
    VERDICTS_RECEIVED,
)
from vms_face.core.exceptions import StreamError
from vms_face.core.tracing import traced
from vms_face.domain.schemas import FaceCandidate
from vms_face.infra.detection_state import StatePublisher, get_state_publisher
from vms_face.infra.genderage import get_genderage_estimator
from vms_face.infra.insightface_runtime import FaceObservation, FaceRuntime, FaceRuntimePool
from vms_face.infra.minio_store import ObjectStore
from vms_face.infra.recognizers import Recognizer
from vms_face.infra.redis_bus import RedisBus
from vms_face.pipeline.ingest import Frame, RTSPIngest, make_ingest
from vms_face.infra.person_detector import get_person_detector
from vms_face.services.detection_zones import bbox_zone, normalize_zones
from vms_face.services.footfall import FootfallConfig, get_registry as get_footfall_registry
from vms_face.services.snapshot_cache import get_snapshot_cache
from vms_face.infra.verdict_bus import get_verdict_router
from vms_face.services.face_quality import FaceQualityGate
from vms_face.services.face_tracker import IOUTracker, TrackedFace
from vms_face.services.identity_latch import LatchState, RecentIdentityBank, Verdict
from vms_face.services.motion_gate import MotionGate
from vms_face.services.overlay_viewers import is_watched
from vms_face.services.snapshot_pump import SnapshotPump

log = get_logger(__name__)


def _gender_label(value: int | None) -> str | None:
    if value is None:
        return None
    # InsightFace genderage uses 1 for male and 0 for female.
    return "Male" if int(value) == 1 else "Female"


def _reviewable_gender_label(value: int | None, verdict, obs: FaceObservation) -> str | None:
    if verdict.score < 0.65:
        return None
    if verdict.blur_var is None or verdict.blur_var < 50.0:
        return None
    if min(obs.width, obs.height) < 100:
        return None
    return _gender_label(value)


@dataclass(slots=True)
class StreamContext:
    tenant_id: uuid.UUID
    camera_id: uuid.UUID
    camera_code: str
    rtsp_url: str
    target_fps: float
    embed_every_n: int = 5
    snapshot_top_k: int = 3
    zone: str | None = None
    detection_input_size: int | None = None   # honored via FaceRuntimePool
    detection_zones: list[dict] | None = None
    # Per-camera footfall settings (mirrored from cameras.config_json by the
    # caller that builds StreamContext — legacy.py / run_stream.py / etc.).
    # When None, the orchestrator skips all footfall code paths entirely; no
    # tracker is created, no person boxes are pushed to the registry.
    # The footfall flusher won't ever have rows from this camera until the
    # operator turns the toggle on.
    footfall_config: dict | None = None


class StreamOrchestrator:
    """Per-camera processing loop. Pulls frames from RTSPIngest, runs
    detect → quality → embed → track-pool → publish.

    Key design points (post-2026-05-08 hardening):

    1. Persistent ingest generator (RTSPIngest.read_frame) — target_fps now
       actually throttles instead of being silently ignored.

    2. Per-frame deadline. Each frame pull is wrapped in `wait_for(...,
       timeout=settings.pipeline_frame_timeout_sec)`. On timeout we increment
       FRAMES_DROPPED{reason="rtsp_stall"}, mark STREAM_HEALTHY=0, reopen
       the stream with exponential backoff. One bad camera cannot wedge the
       pool any more.

    3. embed_every_n + pool-warm-up gating. Re-embed on every quality-passing
       frame for the first `embed_every_n` frames of a track (warm-up), then
       only every N-th frame thereafter. Combined with the top-K
       quality-weighted pool, this is the temporal-fusion cosine-similarity
       pattern from the AdaFace literature: aggregate the K best embeddings
       per identity; query Qdrant against the pool's quality-weighted mean.

    4. Three-pool executor split: ingest_pool (RTSP I/O), gpu_pool
       (detect/embed dispatch), io_pool (snapshot upload, post-publish work).
       No single subsystem can starve another.

    5. Snapshot upload is fire-and-forget. The candidate is published with
       a deterministic snapshot URI; the actual upload runs on io_pool and
       completes asynchronously. Match worker doesn't block on MinIO.

    6. State publication via StatePublisher. The orchestrator does NOT touch
       the local LatestDetectionCache directly — it publishes to Redis (or a
       local sink, configurable). The API process subscribes and fans out
       to WebSockets.

    Latency tradeoff: first match for a brand-new identity is delayed by
    `track_min_hits_to_match - 1` frames (~250 ms at 8 FPS, min_hits=3).
    In exchange we cut single-frame match noise dramatically."""

    def __init__(
        self,
        ctx: StreamContext,
        *,
        runtime: FaceRuntime | None = None,
        recognizer: Recognizer,
        bus: RedisBus,
        objects: ObjectStore,
        quality: FaceQualityGate,
        state_publisher: StatePublisher | None = None,
    ) -> None:
        self._ctx = ctx
        # Per-camera det_size honored via FaceRuntimePool. If the caller
        # passes an explicit runtime that's used as-is (tests, DI overrides).
        if runtime is not None:
            self._runtime = runtime
        else:
            self._runtime = FaceRuntimePool.get(ctx.detection_input_size)
        self._recognizer = recognizer
        self._bus = bus
        self._objects = objects
        self._quality = quality
        self._tracker = IOUTracker()
        self._stop = asyncio.Event()
        self._frame_count = 0
        self._publish_count = 0
        self._frame_emas: float = 0.0
        self._last_frame_ts: float = 0.0
        # Cheap diagnostic counters surfaced via /debug/pipeline. They're
        # writes-only-this-thread on the hot path so no synchronization is
        # needed; readers see a slightly stale snapshot, which is fine.
        self._observations_total = 0
        self._observations_last_frame = 0
        self._last_observation_at: float = 0.0
        # Overlay publish-on-change state (see _update_overlay).
        self._overlay_last_publish: float = 0.0
        self._overlay_last_had_boxes: bool = False
        self._last_published_at: float = 0.0
        self._stream_opened_at: float = 0.0
        self._stream_open_attempts = 0
        # Reference to the current RTSPIngest (set by run() on each
        # (re)open). stats() reads decode counters from it for the
        # "is this camera healthy?" view in /streams/debug.
        self._ingest_ref = None  # type: ignore[assignment]
        self._frames_since_detect = 10**9   # detect on the very first frame
        self._current_cadence = max(1, int(settings.detect_every_n_frames))
        # YOLO person-count state. The detector is shared process-wide;
        # the count is per-camera. We refresh it every Nth frame to keep
        # GPU load proportional and reuse the last value in between, so
        # the badge in the UI doesn't blink.
        self._last_person_count = 0
        self._person_last_run_frame = -1
        self._publisher: StatePublisher = state_publisher or get_state_publisher()
        # Bounded fan-out for concurrent per-face processing within a single
        # frame; see _consume_loop. One semaphore per orchestrator (one per
        # camera) so noisy cameras don't starve quiet ones via a global cap.
        self._face_sem = asyncio.Semaphore(max(1, int(settings.pipeline_face_concurrency)))
        # Bounded snapshot uploader. Replaces the unbounded asyncio.create_task
        # pile-up the orchestrator used to do on every detection.
        self._snapshot_pump = SnapshotPump(self._objects, str(ctx.camera_id))
        # Pre-detect motion gate (roadmap E.3). Skips the SCRFD call on
        # static empty scenes; see services/motion_gate.py for the safety
        # rules that make this recall-neutral.
        self._motion_gate = MotionGate() if settings.motion_gate_enabled else None
        # L0 identity latch (docs/FACE_EDGE_REALTIME_PLAN.md §4). The latch
        # itself lives on each Track; this holds the per-camera pieces: the
        # feature flag and the bank of recently-dead identities used to
        # re-associate a track that reappears after a brief occlusion.
        self._latch_enabled = bool(settings.identity_latch_enabled)
        self._reassoc = RecentIdentityBank(
            ttl_sec=float(settings.identity_latch_reassoc_sec),
            min_cosine=float(settings.identity_latch_reassoc_min_cosine),
        )
        self._zones = normalize_zones(ctx.detection_zones)
        if self._zones:
            log.info(
                "camera detection zones active",
                camera=ctx.camera_code,
                zones=[z["name"] for z in self._zones],
            )
        # Footfall integration. The orchestrator already runs YOLOv8 person
        # detection (gated by `pipeline_person_detection_enabled`); we just
        # forward those boxes to the per-camera footfall counter when the
        # operator has turned the feature on for THIS camera. Importantly:
        # if person detection itself is off, footfall counts will sit at
        # zero — surfacing that as a UX hint in the API response so the
        # operator knows to enable person detection alongside.
        self._footfall_cfg = FootfallConfig.from_camera_config(
            {"footfall": ctx.footfall_config} if ctx.footfall_config else None
        )
        if self._footfall_cfg.enabled:
            asyncio.create_task(
                get_footfall_registry().configure_camera(
                    ctx.camera_id, ctx.tenant_id, self._footfall_cfg,
                ),
                name=f"footfall-config-{ctx.camera_code}",
            )
            log.info(
                "footfall enabled for camera",
                camera=ctx.camera_code,
                line=self._footfall_cfg.line,
                direction=self._footfall_cfg.direction,
                falls=self._footfall_cfg.falls_enabled,
            )

    async def stop(self) -> None:
        self._stop.set()

    def _detect_cadence(self) -> int:
        """Frames between detector runs (attention scheduling, settings).
        Undecided or empty scene -> the configured base cadence; every track
        latched to a known person -> attention_latched_every_n; only latched
        strangers -> attention_unknown_every_n."""
        base = max(1, int(settings.detect_every_n_frames))
        cadence = base
        if settings.attention_scheduling:
            tracks = self._tracker.tracks()
            if tracks:
                states = [t.identity.state for t in tracks]
                if not any(s in (LatchState.NEW, LatchState.CANDIDATE) for s in states):
                    if all(s is LatchState.LATCHED for s in states):
                        cadence = max(base, int(settings.attention_latched_every_n))
                    else:
                        cadence = max(base, int(settings.attention_unknown_every_n))
        self._current_cadence = cadence
        return cadence

    def stats(self) -> dict:
        """Lightweight snapshot of pipeline state for /debug/pipeline.
        No locks — readers see a slightly stale view, which is fine for a
        diagnostic surface. The fields are deliberately named to match
        common ops questions ("is this camera even open?", "is the
        detector finding anything?", "is data flowing to the bus?")."""
        now = time.time()

        def _seconds_since(ts: float) -> float | None:
            return round(now - ts, 2) if ts > 0 else None

        # Read decode health from the current ingest object, if any.
        decode_health: dict = {"available": False}
        ig = self._ingest_ref
        if ig is not None:
            ok = int(getattr(ig, "frames_decoded_ok", 0))
            fail = int(getattr(ig, "frames_decode_failed", 0))
            demux = int(getattr(ig, "packets_demux_failed", 0))
            dropped_old = int(getattr(ig, "_latest_dropped_count", 0))
            total = ok + fail
            decode_health = {
                "available": True,
                "frames_decoded_ok": ok,
                "frames_decode_failed": fail,
                "packets_demux_failed": demux,
                # Frames the reader thread overwrote before the orchestrator
                # could read them. Non-zero means the orchestrator is slower
                # than line-rate; drop-old mode keeps freshness regardless.
                "frames_dropped_old": dropped_old,
                "decode_success_pct": round((ok / total) * 100.0, 2) if total else None,
            }

        return {
            "camera_id": str(self._ctx.camera_id),
            "camera_code": self._ctx.camera_code,
            "rtsp_url_scheme": self._ctx.rtsp_url.split("://", 1)[0] if "://" in self._ctx.rtsp_url else None,
            "stream": {
                "opened_at_seconds_ago": _seconds_since(self._stream_opened_at),
                "open_attempts": self._stream_open_attempts,
                "frames_ingested_total": self._frame_count,
                "frames_per_second_ewma": round(self._frame_emas, 2),
                "last_frame_at_seconds_ago": _seconds_since(self._last_frame_ts),
            },
            "decode": decode_health,
            "detection": {
                "observations_total": self._observations_total,
                "observations_last_frame": self._observations_last_frame,
                "last_observation_at_seconds_ago": _seconds_since(self._last_observation_at),
            },
            "tracker": {
                "active_tracks": self._tracker.active_track_count,
            },
            "identity": self._identity_stats(),
            "publish": {
                "candidates_published_total": self._publish_count,
                "last_publish_at_seconds_ago": _seconds_since(self._last_published_at),
            },
            "runtime": {
                "recognizer": self._recognizer.name,
                "detector_det_size": self._runtime.det_size,
                "detector_degraded_to_cpu": self._runtime.degraded,
            },
            "config": {
                "target_fps": self._ctx.target_fps,
                "embed_every_n": self._ctx.embed_every_n,
                "snapshot_top_k": self._ctx.snapshot_top_k,
            },
        }

    def _identity_stats(self) -> dict:
        """Latch state census for /streams/debug — how many tracks are
        confirmed, provisional, negative-latched, and how big the
        re-association bank is."""
        counts = {"latched": 0, "candidate": 0, "unknown": 0, "new": 0}
        for tr in self._tracker.tracks_for_overlay(max_miss=10**9):
            counts[tr.identity.state.value] = counts.get(tr.identity.state.value, 0) + 1
        return {
            "enabled": self._latch_enabled,
            **counts,
            "reassoc_bank": len(self._reassoc),
        }

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        camera_label = str(self._ctx.camera_id)
        zone = self._ctx.zone or "default"
        log.info(
            "stream starting",
            camera=self._ctx.camera_code,
            source=self._ctx.rtsp_url,
            recognizer=self._recognizer.name,
            identity_latch=self._latch_enabled,
        )

        # Lazily start the snapshot pump now that we have a running loop.
        self._snapshot_pump.start()
        # Receive match-worker verdicts for our tracks (feeds the latch).
        if self._latch_enabled:
            try:
                get_verdict_router().register(camera_label, self.on_verdict)
            except Exception as e:  # noqa: BLE001 — the latch degrades to timer-only
                log.warning("verdict router register failed", camera=self._ctx.camera_code, err=str(e))

        # camera_label gives the ingest a per-camera label for
        # vms_decode_errors_total — operators can grep / group by this in
        # Prometheus to see which cameras are decode-hot.
        ingest = make_ingest(
            self._ctx.rtsp_url,
            target_fps=self._ctx.target_fps,
            camera_label=camera_label,
        )
        # Stash a reference so stats() can read decode counters even
        # between reopens — useful for "is this camera coming back?"
        self._ingest_ref = ingest
        backoff = settings.pipeline_rtsp_reopen_backoff_sec
        opened_ok = False

        while not self._stop.is_set():
            # ─── (re)open the source ──────────────────────────────────────
            self._stream_open_attempts += 1
            try:
                await loop.run_in_executor(get_ingest_pool(), ingest.open)
                opened_ok = True
                self._stream_opened_at = time.time()
                STREAM_HEALTHY.labels(camera_id=camera_label).set(1)
                backoff = settings.pipeline_rtsp_reopen_backoff_sec
            except Exception as e:
                STREAM_HEALTHY.labels(camera_id=camera_label).set(0)
                STREAM_RESTARTS.labels(camera_id=camera_label, reason="open_failed").inc()
                log.error("stream open failed", camera=self._ctx.camera_code, err=str(e))
                if self._stop.is_set():
                    break
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, settings.pipeline_rtsp_reopen_max_backoff_sec)
                continue

            try:
                await self._consume_loop(loop, ingest, camera_label, zone)
            except StreamError as e:
                log.warning("stream consume error; reopening", camera=self._ctx.camera_code, err=str(e))
            finally:
                try:
                    await loop.run_in_executor(get_ingest_pool(), ingest.close)
                except Exception:
                    pass
                STREAM_HEALTHY.labels(camera_id=camera_label).set(0)

            if self._stop.is_set():
                break
            STREAM_RESTARTS.labels(camera_id=camera_label, reason="reopen").inc()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, settings.pipeline_rtsp_reopen_max_backoff_sec)

        try:
            await self._publisher.mark_offline(camera_label)
        except Exception:
            pass
        # Drain any leftover footfall deltas for this camera so the counts
        # for the final minute land in Postgres rather than evaporating.
        # Unconditional: the gate may have been switched on from the UI
        # after this camera started (a no-op when it never was).
        try:
            await get_footfall_registry().remove_camera(self._ctx.camera_id)
        except Exception as e:
            log.warning(
                "footfall remove_camera failed",
                camera=self._ctx.camera_code,
                err=str(e),
            )
        # Drop the snapshot — otherwise the API would keep handing out a
        # frozen frame to anyone polling, masking that the camera went
        # offline. The frontend already shows "no preview" on 404.
        try:
            get_snapshot_cache().forget(self._ctx.camera_code)
        except Exception:
            pass
        try:
            await self._snapshot_pump.aclose()
        except Exception as e:
            log.warning("snapshot pump shutdown failed", camera=self._ctx.camera_code, err=str(e))
        try:
            get_verdict_router().unregister(camera_label)
        except Exception:
            pass
        log.info(
            "stream stopped",
            camera=self._ctx.camera_code,
            frames=self._frame_count,
            publishes=self._publish_count,
            opened_ok=opened_ok,
        )

    async def _consume_loop(
        self,
        loop: asyncio.AbstractEventLoop,
        ingest: RTSPIngest,
        camera_label: str,
        zone: str,
    ) -> None:
        timeout = max(0.5, float(settings.pipeline_frame_timeout_sec))
        while not self._stop.is_set():
            t_frame = time.perf_counter()
            try:
                frame = await asyncio.wait_for(
                    loop.run_in_executor(get_ingest_pool(), ingest.read_frame),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                FRAMES_DROPPED.labels(camera_id=camera_label, reason="rtsp_stall").inc()
                STREAM_HEALTHY.labels(camera_id=camera_label).set(0)
                raise StreamError("frame read timed out")
            except Exception as e:
                FRAMES_DROPPED.labels(camera_id=camera_label, reason="read_error").inc()
                raise StreamError(f"frame read failed: {e}") from e

            if frame is None:
                FRAMES_DROPPED.labels(camera_id=camera_label, reason="eos").inc()
                return

            # Everything before this line was waiting for the decoder; everything
            # after it is work. The old single frame timer conflated the two.
            t_work = time.perf_counter()
            PIPELINE_STAGE_LATENCY.labels(stage="wait").observe(t_work - t_frame)
            STREAM_HEALTHY.labels(camera_id=camera_label).set(1)
            FRAMES_INGESTED.labels(camera_id=camera_label).inc()
            self._frame_count += 1
            self._update_fps(camera_label, frame.ts)

            # ── Detect cadence + motion gate ──
            # Two independent reasons to skip the (expensive, shared-GPU) SCRFD
            # call on this frame:
            #   1. Detect interval — run the detector every Nth frame and let
            #      the Kalman tracker predict the boxes in between. This is what
            #      keeps the box moving with the person at ingest fps while the
            #      detector runs at fps/N. N=1 disables it (detect every frame).
            #   2. Motion gate — a ~0.2 ms pixel-diff that skips detect on
            #      static empty scenes. Runs inline (below an executor hop).
            # Either skip still runs the tracker (predict) + overlay below, so a
            # skipped frame updates the box, it just doesn't re-detect.
            detect_every_n = self._detect_cadence()
            self._frames_since_detect += 1
            run_detect = self._frames_since_detect >= detect_every_n
            skip_reason = "attention" if detect_every_n > max(1, int(settings.detect_every_n_frames)) else "cadence"
            if run_detect:
                self._frames_since_detect = 0
            if run_detect and self._motion_gate is not None:
                run_detect = self._motion_gate.should_detect(
                    frame.bgr, self._tracker.active_track_count
                )
                skip_reason = "motion"

            if not run_detect:
                MOTION_GATE_SKIPS.labels(camera_id=camera_label, reason=skip_reason).inc()
                observations = []
            else:
                t0 = time.perf_counter()
                try:
                    with traced(
                        "orchestrator.detect",
                        **{
                            "camera.id": camera_label,
                            "camera.code": self._ctx.camera_code,
                            "frame.seq": frame.seq,
                        },
                    ):
                        if settings.pipeline_batched_inference:
                            # Batched path coalesces this call with concurrent
                            # detects from sibling orchestrators sharing the same
                            # FaceRuntime (same det_size). Falls through to the
                            # per-image path internally if BatchedSCRFD couldn't
                            # be built against the loaded model.
                            observations = await self._runtime.detect_async(frame.bgr)
                        else:
                            observations = await loop.run_in_executor(
                                get_gpu_pool(),
                                self._runtime.detect,
                                frame.bgr,
                            )
                except Exception as e:
                    FRAMES_DROPPED.labels(camera_id=camera_label, reason="detect_error").inc()
                    log.warning("detect failed", camera=self._ctx.camera_code, err=str(e))
                    continue
                DETECT_LATENCY.observe(time.perf_counter() - t0)
                PIPELINE_STAGE_LATENCY.labels(stage="detect").observe(time.perf_counter() - t0)
            observations = self._filter_observations(frame, observations, camera_label)
            self._observations_last_frame = len(observations)
            if observations:
                DETECTIONS.labels(camera_id=camera_label).inc(len(observations))
                self._observations_total += len(observations)
                self._last_observation_at = time.time()

            t0 = time.perf_counter()
            tracked = self._tracker.step(observations)
            PIPELINE_STAGE_LATENCY.labels(stage="track").observe(time.perf_counter() - t0)
            for tf in tracked:
                if tf.is_new:
                    TRACKS_OPENED.labels(camera_id=camera_label).inc()
            # Bank the identity of any track that just died so a re-detect of
            # the same person after a brief occlusion inherits it instead of
            # restarting from "Unknown" (identity_latch.RecentIdentityBank).
            if self._latch_enabled and self._tracker.dropped_last_step:
                now_mono = time.monotonic()
                for dead in self._tracker.dropped_last_step:
                    self._reassoc.remember(dead.identity, dead.embedding_pool.pooled(), now_mono)

            # ── Person count via YOLOv8 (optional, off-by-default) ──
            # Counts humans regardless of face visibility (back-of-head,
            # occlusion, profile view). Runs every Nth frame to bound GPU
            # load; reuse last value between runs so the UI doesn't blink.
            every_n = max(1, int(settings.pipeline_person_detect_every_n_frames))
            person_boxes_this_frame: list[tuple[float, float, float, float, float]] | None = None
            if (
                settings.pipeline_person_detection_enabled
                and self._frame_count - self._person_last_run_frame >= every_n
            ):
                detector = get_person_detector()
                if detector is not None:
                    try:
                        persons = await loop.run_in_executor(
                            get_gpu_pool(), detector.detect, frame.bgr
                        )
                        self._last_person_count = len(persons)
                        person_boxes_this_frame = persons
                    except Exception as e:
                        log.warning("person detect failed", camera=self._ctx.camera_code, err=str(e))
                    self._person_last_run_frame = self._frame_count

            # ── Footfall counter feed ──
            # Footfall rides on ONE source of boxes per camera, never both:
            #   1. YOLOv8 person boxes — best for entrance cams that see
            #      backs / sides of people (no face required). Tested at
            #      the feet, so the line is drawn on the floor. On frames
            #      where YOLO is skipped (every_n) nothing is fed: mixing
            #      face boxes in would hand the centroid tracker two very
            #      different points for the same person on alternate frames.
            #   2. SCRFD face tracker bboxes — when YOLO is off or its ONNX
            #      model isn't installed. Tested at the box centre.
            # Counting only kicks in when the operator has enabled footfall
            # for THIS camera. The registry is read every frame, not the
            # config this orchestrator started with, so a gate switched on
            # from the UI starts counting without restarting the camera.
            ff_cfg = get_footfall_registry().get_config(self._ctx.camera_id)
            if ff_cfg is not None and ff_cfg.enabled:
                src_boxes: list[tuple[float, float, float, float, float]] | None = None
                body_source = settings.pipeline_person_detection_enabled and get_person_detector() is not None
                if body_source:
                    src_boxes = person_boxes_this_frame
                elif tracked:
                    # Build (x1,y1,x2,y2,score) tuples from the face tracker.
                    # Using tracked.observation.bbox keeps the source of
                    # truth one place; the registry will re-track centroids
                    # internally (it doesn't trust external track IDs).
                    src_boxes = []
                    for tf in tracked:
                        try:
                            x1, y1, x2, y2 = tf.observation.bbox.tolist()
                            src_boxes.append((
                                float(x1), float(y1), float(x2), float(y2),
                                float(tf.observation.det_score or 0.5),
                            ))
                        except Exception:
                            continue
                if src_boxes:
                    try:
                        get_footfall_registry().update(
                            self._ctx.camera_id,
                            frame.bgr.shape[1],
                            frame.bgr.shape[0],
                            src_boxes,
                            anchor="feet" if body_source else "center",
                        )
                    except Exception as e:
                        log.warning(
                            "footfall update failed",
                            camera=self._ctx.camera_code,
                            err=str(e),
                        )

            # Publish the overlay first so the live UI sees the boxes within
            # one frame's worth of detect+track latency, even if the per-face
            # quality+embed work is slow on crowded scenes.
            t0 = time.perf_counter()
            await self._update_overlay(frame, tracked)
            PIPELINE_STAGE_LATENCY.labels(stage="overlay").observe(time.perf_counter() - t0)

            # Per-face processing fan-out, bounded by self._face_sem. With N
            # faces visible, we spend max(detect, max_face_handler/concurrency)
            # instead of detect + sum_face_handlers as the old serial loop did.
            if tracked:
                t0 = time.perf_counter()
                await asyncio.gather(
                    *[
                        self._handle_tracked_bounded(loop, frame, tf, camera_label)
                        for tf in tracked
                    ],
                    return_exceptions=False,
                )
                PIPELINE_STAGE_LATENCY.labels(stage="faces").observe(time.perf_counter() - t0)
            now = time.perf_counter()
            PIPELINE_STAGE_LATENCY.labels(stage="work").observe(now - t_work)
            PIPELINE_FRAME_LATENCY.labels(zone=zone).observe(now - t_frame)

    def _update_fps(self, camera_label: str, ts: float) -> None:
        if self._last_frame_ts > 0:
            instant = 1.0 / max(ts - self._last_frame_ts, 1e-6)
            if self._frame_emas <= 0:
                self._frame_emas = instant
            else:
                self._frame_emas = (self._frame_emas * 0.8) + (instant * 0.2)
            CAMERA_FPS.labels(camera_id=camera_label).set(self._frame_emas)
        self._last_frame_ts = ts

    def _zone_for_bbox(self, bbox, frame: Frame, *, target: str = "face") -> dict | None:
        if not self._zones:
            return None
        h, w = frame.bgr.shape[:2]
        return bbox_zone(bbox, w, h, self._zones, target=target)

    def _filter_observations(
        self,
        frame: Frame,
        observations: list[FaceObservation],
        camera_label: str = "",
    ) -> list[FaceObservation]:
        if not observations:
            return observations
        # Size first — before zones and long before the tracker. A face below
        # the recognisable minimum can never produce an identity, yet it used
        # to open a track and ride through Kalman, Hungarian and a quality
        # check before the gate rejected it (99.85% of all detections on the
        # main stream). Same number as the gate so the two never disagree.
        min_px = int(settings.track_min_face_px) or int(settings.quality_min_face_px)
        # Same for the detector-score floor: the detector runs at
        # insightface_det_threshold (0.5) but the gate demands
        # quality_min_det_score (0.6), so after the size filter 73 of 76 kept
        # detections were still rejected for score — after opening a track.
        min_score = float(settings.quality_min_det_score)
        label = camera_label or str(self._ctx.camera_id)
        if min_px > 0 or min_score > 0:
            kept: list[FaceObservation] = []
            too_small = low_score = 0
            for o in observations:
                if min_px > 0 and min(o.width, o.height) < min_px:
                    too_small += 1
                elif min_score > 0 and float(o.det_score) < min_score:
                    low_score += 1
                else:
                    kept.append(o)
            if too_small:
                DETECTIONS_DROPPED_PRETRACK.labels(camera_id=label, reason="too_small").inc(too_small)
            if low_score:
                DETECTIONS_DROPPED_PRETRACK.labels(camera_id=label, reason="low_det_score").inc(low_score)
            observations = kept
        if not self._zones or not observations:
            return observations
        h, w = frame.bgr.shape[:2]
        return [
            obs for obs in observations
            if bbox_zone(obs.bbox, w, h, self._zones, target="face") is not None
        ]

    async def _update_overlay(
        self,
        frame: Frame,
        tracked: list[TrackedFace],
    ) -> None:
        h, w = frame.bgr.shape[:2]
        # Distinct people currently in the scene per the tracker — INCLUDES
        # tracks whose face was momentarily not detected this frame (a head
        # turn, a brief occlusion). The Kalman filter keeps them alive for
        # ~tracker_max_age frames so the displayed count doesn't blink.
        # `boxes` below only includes tracks observed *this frame*, so
        # active_tracks >= len(boxes).
        active_tracks = self._tracker.active_track_count
        # Draw from the tracker's Kalman state, not just faces detected THIS
        # frame, so the box keeps moving with the person on frames where the
        # detector didn't run (detect_every_n_frames). max_miss bounds how far a
        # box is drawn on prediction alone: N-1 covers the gap between detects
        # and drops the box promptly once someone actually leaves. At N=1 this
        # is max_miss=0 → only tracks matched this frame, i.e. unchanged.
        max_miss = max(0, int(self._current_cadence) - 1)
        boxes: list[dict] = []
        for track in self._tracker.tracks_for_overlay(max_miss):
            bbox = track.bbox                      # Kalman [x1,y1,x2,y2]
            x1, y1, x2, y2 = (float(v) for v in bbox.tolist())
            obs = track.last_obs                   # last real detection on this track
            zone = self._zone_for_bbox(bbox, frame)
            # Stable, track-voted gender/age instead of the raw per-frame
            # genderage output (which flips between Male/Female on CCTV crops).
            # None until the vote resolves — the UI shows nothing rather than
            # noise for the first few frames of a track.
            if settings.face_attributes_enabled:
                attrs = track.attributes
                gender = attrs.gender_label()
                gender_conf = attrs.gender_confidence()
                age = attrs.age_estimate()
            else:
                gender = _gender_label(obs.gender) if obs is not None else None
                gender_conf = None
                age = int(round(obs.age)) if (obs is not None and obs.age is not None) else None
            # Identity straight from the track's latch — the name appears on the
            # very next frame after the verdict lands, and a track the latch has
            # re-identified is never overwritten by a stale downstream patch.
            det_conf = float(obs.det_score) if obs is not None else None
            if self._latch_enabled:
                shown = track.identity.display()
                name = shown.name
                identity_state = shown.state
                person_id = shown.person_id
                conf = shown.confidence if shown.confidence is not None else det_conf
            else:
                name, identity_state, person_id, conf = "Unknown", "unknown", None, det_conf
            boxes.append(
                {
                    "track_id": track.track_id,
                    "name": name,
                    "identity_state": identity_state,
                    "person_id": person_id,
                    "conf": conf,
                    "gender": gender,
                    "gender_conf": gender_conf,
                    "age": age,
                    "x1": x1,
                    "y1": y1,
                    "x2": x2,
                    "y2": y2,
                    "zone_id": zone.get("id") if zone else None,
                    "zone_name": zone.get("name") if zone else None,
                }
            )
        # Publish on change, not on every frame. Downstream already throttles
        # to backend_overlay_min_interval_sec (5 Hz) and the browser predicts
        # box motion between updates, so an 8 Hz publish bought nothing and
        # cost a JSON build + Redis round trip per frame per camera — on an
        # EMPTY scene too. Rules: with tracks, at most every min-interval;
        # the moment the scene empties, at once (the UI must clear its boxes);
        # while it stays empty, a heartbeat so the UI's stale timer (1.2 s)
        # keeps the overlay alive without drawing anything.
        now_mono = time.monotonic()
        since = now_mono - self._overlay_last_publish
        if boxes:
            # Full rate only while a browser is drawing this camera; otherwise a
            # keep-alive so people-counts and the admin monitor stay fresh
            # (services/overlay_viewers.py; fail-open = full rate).
            interval = float(settings.overlay_publish_min_interval_sec)
            if settings.overlay_viewer_gating and not await is_watched(str(self._ctx.camera_code or "")):
                interval = max(interval, float(settings.overlay_unwatched_interval_sec))
            publish = since >= interval
        elif self._overlay_last_had_boxes:
            publish = True
        else:
            publish = since >= float(settings.overlay_idle_heartbeat_sec)
        if publish:
            try:
                await self._publisher.write_frame(
                    str(self._ctx.camera_id),
                    boxes=boxes,
                    frame_w=w,
                    frame_h=h,
                    running=True,
                    active_tracks=active_tracks,
                    persons_present=int(self._last_person_count),
                    camera_code=str(self._ctx.camera_code or ""),
                )
                self._overlay_last_publish = now_mono
                self._overlay_last_had_boxes = bool(boxes)
            except Exception as e:
                log.warning("state publish failed", camera=self._ctx.camera_code, err=str(e))
        # Push the raw frame to the snapshot cache for the JPEG fallback
        # served at /api/cameras/<monitor_id>/snapshot.jpg. The cache
        # self-throttles to ~4 fps so we don't pay encode CPU on every
        # frame, and runs cv2.imencode on the IO pool so the asyncio
        # event loop isn't blocked.
        try:
            cache = get_snapshot_cache()
            await asyncio.get_running_loop().run_in_executor(
                get_io_pool(),
                cache.maybe_write,
                self._ctx.camera_code,
                frame.bgr,
            )
        except Exception as e:
            log.debug(
                "snapshot cache write failed",
                camera=self._ctx.camera_code, err=str(e),
            )

    async def on_verdict(self, payload: dict) -> None:
        """Match-worker answer for one of our tracks, delivered by the
        VerdictRouter. Feeds the track's identity latch and pushes the name
        to the overlay immediately (time-to-identity path)."""
        camera_label = str(self._ctx.camera_id)
        if payload.get("skipped"):
            # The worker declined to match (its own quality floors). Not a
            # miss — must not push the latch toward UNKNOWN.
            return
        track_id = str(payload.get("track_id") or "")
        track = self._tracker.get_track(track_id)
        pid = payload.get("person_id")
        ambiguous = bool(payload.get("ambiguous"))
        outcome = "ambiguous" if ambiguous else ("hit" if pid else "miss")
        if track is None:
            VERDICTS_RECEIVED.labels(camera_id=camera_label, outcome="orphan").inc()
            return
        VERDICTS_RECEIVED.labels(camera_id=camera_label, outcome=outcome).inc()
        if not self._latch_enabled:
            return

        now = time.monotonic()
        latch = track.identity
        v = Verdict(
            person_id=str(pid) if pid else None,
            name=payload.get("person_name"),
            similarity=float(payload.get("similarity") or 0.0),
            ambiguous=ambiguous,
            at=now,
        )
        before, after, reason = latch.apply_verdict(v, now)
        if before is not after:
            LATCH_TRANSITIONS.labels(
                camera_id=camera_label, from_state=before.value, to_state=after.value,
            ).inc()

        # Time-to-identity: measured from the track's first quality-passing
        # face to the first provisional name, and to the K-of-N confirmation.
        if latch.first_seen_at > 0:
            tti = max(0.0, now - latch.first_seen_at)
            if reason == "provisional" and latch.provisional_at == now:
                TIME_TO_IDENTITY.labels(kind="provisional").observe(tti)
            elif reason == "confirmed" and latch.latched_at == now:
                if latch.provisional_at == now:
                    TIME_TO_IDENTITY.labels(kind="provisional").observe(tti)
                TIME_TO_IDENTITY.labels(kind="confirmed").observe(tti)

        if reason in ("provisional", "confirmed", "identity_change", "unlatched"):
            shown = latch.display()
            try:
                await self._publisher.patch_name(
                    camera_label, track_id, name=shown.name, conf=shown.confidence,
                )
            except Exception as e:  # noqa: BLE001 — the next frame write carries it anyway
                log.debug("patch_name failed", camera=self._ctx.camera_code, err=str(e))

    async def _handle_tracked_bounded(
        self,
        loop: asyncio.AbstractEventLoop,
        frame: Frame,
        tf: TrackedFace,
        camera_label: str,
    ) -> None:
        """Wrapper that bounds concurrent _handle_tracked tasks via a per-
        orchestrator semaphore and isolates per-face failures so one bad face
        doesn't poison the gather() of its neighbors."""
        async with self._face_sem:
            try:
                with traced(
                    "orchestrator.handle_face",
                    **{
                        "camera.id": camera_label,
                        "track.id": tf.track.track_id,
                        "track.is_new": tf.is_new,
                        "frame.seq": frame.seq,
                    },
                ):
                    await self._handle_tracked(loop, frame, tf, camera_label)
            except Exception as e:
                log.warning(
                    "handle_tracked failed",
                    camera=self._ctx.camera_code,
                    track_id=tf.track.track_id,
                    err=str(e),
                )

    async def _maybe_vote_attributes(
        self,
        loop: asyncio.AbstractEventLoop,
        frame: Frame,
        tf: TrackedFace,
        verdict,
        camera_label: str,
    ) -> None:
        """Feed one gender/age vote into the track's attribute aggregate.

        Two sources, in preference order:
          1. The observation itself — populated when the genderage head ran
             inline in FaceAnalysis.get() (INSIGHTFACE_ONDEMAND_GENDERAGE=false).
             Free, so we vote on every quality-passing frame.
          2. An explicit on-demand genderage inference — the default path,
             and the only path under PIPELINE_BATCHED_INFERENCE=true. Spent
             only while `attrs.needs_sample()` is True, so per-track cost is
             bounded by attributes_max_votes."""
        if not settings.face_attributes_enabled:
            return
        obs = tf.observation
        if min(obs.width, obs.height) < settings.attributes_min_face_px:
            return
        attrs = tf.track.attributes
        gender, age = obs.gender, obs.age
        if gender is None:
            if not attrs.needs_sample():
                return
            from vms_face.infra import genderage as _genderage
            if _genderage._instance is None and not _genderage._unavailable:
                # Cold: the session build waits on the box-wide CUDA gate and
                # can take tens of seconds behind 60 decoder start-ups — never
                # on the loop thread.
                estimator = await loop.run_in_executor(None, get_genderage_estimator)
            else:
                estimator = get_genderage_estimator()
            if estimator is None:
                return
            try:
                result = await loop.run_in_executor(
                    get_gpu_pool(),
                    estimator.estimate,
                    frame.bgr,
                    obs.bbox,
                    obs.landmark_5,
                )
            except Exception as e:
                log.warning(
                    "genderage estimate failed",
                    camera=self._ctx.camera_code,
                    err=str(e),
                )
                return
            if result is None:
                return
            gender, age = result
            GENDERAGE_CALLS.labels(camera_id=camera_label).inc()
        attrs.add_vote(gender, age, verdict.score)

    async def _handle_tracked(
        self,
        loop: asyncio.AbstractEventLoop,
        frame: Frame,
        tf: TrackedFace,
        camera_label: str,
    ) -> None:
        """Per-observation pipeline: quality → embed → pool → maybe-publish."""

        active_zone = self._zone_for_bbox(tf.observation.bbox, frame)
        if self._zones and active_zone is None:
            return

        # Quality eval is cv2-bound; offload it so we don't block the loop
        # when 100+ faces are visible in one frame.
        t_q = time.perf_counter()
        verdict = await loop.run_in_executor(
            get_io_pool(),
            self._quality.evaluate,
            frame.bgr,
            tf.observation,
        )
        QUALITY_LATENCY.observe(time.perf_counter() - t_q)
        if not verdict.passed:
            return

        now = time.monotonic()
        latch = tf.track.identity
        latch.note_face(now)   # time-to-identity origin: first usable face

        # ── Attribute vote (gender / age) ──────────────────────────────────
        # Happens before the embed gates so votes accrue even on frames where
        # the embed is skipped. Bounded: once the track's vote is settled,
        # no further genderage inference is spent on it.
        await self._maybe_vote_attributes(loop, frame, tf, verdict, camera_label)

        # ── Embed gating ───────────────────────────────────────────────────
        # 1. always embed when the pool isn't full yet (warm-up so a new
        #    identity can match within ~min_hits frames)
        # 2. afterwards, embed every Nth observation **per track**. The old
        #    frame.seq % N gate fired on the same frames for every track,
        #    bursting GPU work and leaving it idle in between. Track-local
        #    counters spread the load and keep the recognizer warm.
        # ── L0 identity latch: does this track need the recognizer at all? ──
        # A LATCHED (or negative-latched UNKNOWN) track only embeds when a
        # re-verify is due: quality jump, timer, or tracker uncertainty. This
        # sits ABOVE the warm-up rule on purpose — a track confirmed after two
        # verdicts must not keep embedding every frame to fill its pool.
        pool = tf.track.embedding_pool
        if self._latch_enabled:
            emb_dec = latch.should_embed(now, verdict.score)
            if not emb_dec.ok:
                self._tracker.update_quality(tf.track.track_id, verdict.score, tf.observation)
                EMBED_SKIPPED.labels(camera_id=camera_label, reason=emb_dec.reason).inc()
                LATCH_DECISIONS.labels(
                    camera_id=camera_label, outcome="suppress", reason=emb_dec.reason,
                ).inc()
                return

        embed_every_n = max(1, int(self._ctx.embed_every_n))
        warm_up = pool.size < pool.top_k
        tf.track.frames_since_last_embed += 1
        if not warm_up and tf.track.frames_since_last_embed < embed_every_n:
            # Still keep the rolling-best-quality crop fresh for snapshots
            # even when we skip the embed.
            self._tracker.update_quality(tf.track.track_id, verdict.score, tf.observation)
            return
        # We're going to attempt the embed; reset the per-track counter
        # whether or not the recognizer ultimately produces a vector.
        tf.track.frames_since_last_embed = 0

        # ── Pre-embed quality gate ─────────────────────────────────────────
        # If the pool is saturated and verdict.score can't improve it, skip
        # the recognizer entirely. The pooled embedding doesn't change and
        # there's no match-side benefit to re-querying Qdrant. Pure compute
        # saving — measured in `vms_embed_skipped_total`. Reuse-existing path
        # below stays free for the buffalo_l/ArcFace combo, which gets the
        # embedding for "free" from detection.
        if (
            tf.observation.embedding is None
            and not pool.would_admit(verdict.score)
        ):
            self._tracker.update_quality(tf.track.track_id, verdict.score, tf.observation)
            EMBED_SKIPPED.labels(
                camera_id=camera_label,
                reason="pool_saturated_lower_quality",
            ).inc()
            return

        # ── Compute embedding ──────────────────────────────────────────────
        embedding = self._recognizer.reuse_existing(tf.observation.embedding)
        if embedding is None:
            if tf.observation.landmark_5 is None:
                EMBED_FAILURES.labels(camera_id=camera_label, reason="no_landmarks").inc()
                return
            t_e = time.perf_counter()
            try:
                if settings.pipeline_batched_inference:
                    # Batched path: in-flight embeds across cameras coalesce
                    # into a single ONNX call. embed_async handles the feature
                    # flag itself but we keep the branch explicit so the metric
                    # latencies stay attributable.
                    embedding = await self._recognizer.embed_async(
                        frame.bgr, tf.observation.landmark_5
                    )
                else:
                    embedding = await loop.run_in_executor(
                        get_gpu_pool(),
                        self._recognizer.embed,
                        frame.bgr,
                        tf.observation.landmark_5,
                    )
            except Exception as e:
                EMBED_FAILURES.labels(camera_id=camera_label, reason="error").inc()
                log.warning("embed failed", camera=self._ctx.camera_code, err=str(e))
                return
            EMBED_LATENCY.observe(time.perf_counter() - t_e)
        if embedding is None:
            EMBED_FAILURES.labels(camera_id=camera_label, reason="none_returned").inc()
            return
        EMBEDDINGS.labels(camera_id=camera_label).inc()

        # Feed appearance back into the tracker so next frame's Hungarian
        # assignment sees the cosine cost (matters most for the AdaFace
        # path where FaceObservation.embedding is None at step() time).
        self._tracker.update_appearance(tf.track.track_id, embedding)

        # Update best-snapshot tracking
        self._tracker.update_quality(tf.track.track_id, verdict.score, tf.observation)

        # Update the multi-frame pool.
        pool_changed = pool.add(verdict.score, embedding)

        if self._latch_enabled:
            # Re-association: a brand-new track whose first template matches a
            # track that died in the last few seconds inherits that identity as
            # PROVISIONAL (one agreeing verdict confirms it). Occlusion no
            # longer resets a name to "Unknown".
            if latch.state is LatchState.NEW and pool_changed and pool.size == 1:
                claim = self._reassoc.claim(embedding, now)
                if claim is not None:
                    latch.adopt(claim.person_id, claim.name, claim.confidence, now)
                    REASSOCIATIONS.labels(camera_id=camera_label).inc()
                    LATCH_TRANSITIONS.labels(
                        camera_id=camera_label, from_state="new", to_state="candidate",
                    ).inc()
            pub_dec = latch.should_publish(
                now,
                pool_changed=pool_changed,
                quality=verdict.score,
                hits=tf.track.hits,
                min_hits=int(settings.track_min_hits_to_match),
            )
            if not pub_dec.ok:
                LATCH_DECISIONS.labels(
                    camera_id=camera_label, outcome="suppress", reason=pub_dec.reason,
                ).inc()
                return
            latch_reason = pub_dec.reason
        else:
            # Legacy behaviour: every pool change on a mature track is a query.
            if not pool_changed:
                return
            if tf.track.hits < settings.track_min_hits_to_match:
                return
            latch_reason = "legacy"

        pooled = pool.pooled()
        if pooled is None:
            return

        # ── Snapshot via bounded pump ──────────────────────────────────────
        # Publish the candidate immediately with a deterministic key. The
        # actual MinIO PUT is queued on the per-camera SnapshotPump; on
        # overflow the oldest pending upload is dropped and counted, so a
        # slow MinIO can never grow unbounded asyncio.create_task chains.
        snapshot_key = _snapshot_key(
            self._ctx.tenant_id,
            self._ctx.camera_id,
            tf.track.track_id,
        )
        snapshot_uri = f"s3://{settings.minio_bucket_snapshots}/{snapshot_key}"
        crop = _crop_with_padding(frame.bgr, tf.observation.bbox)
        if crop is not None:
            self._snapshot_pump.submit(
                settings.minio_bucket_snapshots,
                snapshot_key,
                crop,
            )

        # Optional: log clothing upper/lower colour so forensic body fusion has
        # historical data to match against. Flag-gated OFF (CPU cost per detection
        # at scale); lazy import keeps it out of the hot path when disabled.
        body_attrs: dict = {}
        if settings.journey_body_logging:
            try:
                from vms_face.journey.body import BodyEmbedder, extract_clothing, person_bbox_from_face
                fbbox = [float(v) for v in tf.observation.bbox.tolist()]
                body_attrs = extract_clothing(frame.bgr, face_bbox=fbbox).to_payload()
                # OSNet body-ReID vector over the estimated person region (face-anchored)
                # so the journey keeps tracking when the face turns away / is occluded.
                be = BodyEmbedder.shared()
                if be.enabled:
                    fh, fw = frame.bgr.shape[:2]
                    bvec = be.embed(frame.bgr, person_bbox=person_bbox_from_face(fbbox, fw, fh))
                    if bvec is not None:
                        body_attrs["body_vec"] = bvec
            except Exception:
                body_attrs = {}

        h, w = frame.bgr.shape[:2]
        candidate = FaceCandidate(
            tenant_id=self._ctx.tenant_id,
            camera_id=self._ctx.camera_id,
            track_id=tf.track.track_id,
            occurred_at=dt.datetime.fromtimestamp(frame.ts, tz=dt.timezone.utc),
            bbox=[float(v) for v in tf.observation.bbox.tolist()],
            det_score=tf.observation.det_score,
            quality_score=verdict.score,
            embedding=pooled.tolist(),
            snapshot_uri=snapshot_uri,
            extra={
                "camera_code": self._ctx.camera_code,
                "frame_seq": frame.seq,
                "frame_w": w,
                "frame_h": h,
                "face_px": min(tf.observation.width, tf.observation.height),
                "blur_var": verdict.blur_var,
                "brightness": verdict.brightness,
                # pose (degrees) for pose-aware fusion — profile faces are unreliable
                # for recognition, so downstream down-weights them and leans on body.
                "yaw": getattr(tf.observation, "yaw_deg", None),
                "pitch": getattr(tf.observation, "pitch_deg", None),
                # Track-voted attributes (multi-frame fusion) when enabled;
                # falls back to the strict single-frame reviewable label.
                "gender": (
                    tf.track.attributes.gender_label()
                    if settings.face_attributes_enabled
                    else _reviewable_gender_label(tf.observation.gender, verdict, tf.observation)
                ),
                "gender_conf": (
                    tf.track.attributes.gender_confidence()
                    if settings.face_attributes_enabled
                    else None
                ),
                "age": (
                    tf.track.attributes.age_estimate()
                    if settings.face_attributes_enabled
                    else None
                ),
                "is_new_track": tf.is_new,
                "pool_size": pool.size,
                "pool_best_quality": pool.best_quality,
                "recognizer": self._recognizer.name,
                # Why this candidate exists (first_template / candidate /
                # reverify_timer / quality_jump / unknown_retry / uncertain /
                # legacy) and what the latch believed when it was sent. Lets
                # downstream tell a first look from a heartbeat re-verify.
                "latch_state": latch.state.value,
                "latch_reason": latch_reason,
                "latch_person_id": latch.person_id,
                "zone": self._ctx.zone,
                "detection_zone_id": active_zone.get("id") if active_zone else None,
                "detection_zone_name": active_zone.get("name") if active_zone else None,
                **body_attrs,  # upper_color/lower_color/… when journey_body_logging is on
            },
        )
        self._publish_count += 1
        self._last_published_at = time.time()
        await self._bus.publish_detection(candidate.model_dump(mode="json"))
        if self._latch_enabled:
            latch.note_published(now, verdict.score)
            LATCH_DECISIONS.labels(
                camera_id=camera_label, outcome="publish", reason=latch_reason,
            ).inc()

# ── module-level helpers ─────────────────────────────────────────────────


def _snapshot_key(tenant_id, camera_id, track_id: str) -> str:
    ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{tenant_id}/{camera_id}/{track_id}/{ts}_{uuid.uuid4().hex[:8]}.jpg"


def _crop_with_padding(frame_bgr, bbox):
    """Crop a full-body + context region around the face bbox so the snapshot
    shows the person's posture and background, not just a tight face (operator
    feedback). A face sits near the top ~1/7 of a standing body, so we pad far
    more BELOW than above, and generously sideways for shoulders + scene, then
    clamp to the frame — a close-up person just fills the frame. The face stays
    clearly visible (top of the crop) so watchlist face-enhancement still works.
    Env-tunable via SNAPSHOT_BODY_PAD_* if a deployment wants tighter/wider."""
    h, w = frame_bgr.shape[:2]
    bw = max(1, int(bbox[2] - bbox[0]))
    bh = max(1, int(bbox[3] - bbox[1]))
    pad_x = int(bw * float(getattr(settings, "snapshot_body_pad_x", 1.0)))
    pad_top = int(bh * float(getattr(settings, "snapshot_body_pad_top", 0.7)))
    pad_bottom = int(bh * float(getattr(settings, "snapshot_body_pad_bottom", 4.5)))
    x1, y1 = max(0, int(bbox[0]) - pad_x), max(0, int(bbox[1]) - pad_top)
    x2, y2 = min(w, int(bbox[2]) + pad_x), min(h, int(bbox[3]) + pad_bottom)
    if x2 <= x1 or y2 <= y1:
        return None
    return frame_bgr[y1:y2, x1:x2]
