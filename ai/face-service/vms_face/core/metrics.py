from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram, Info

# ─── Service identity ───────────────────────────────────────────────────────
BUILD_INFO = Info("vms_build", "Build identity")

# ─── Per-camera throughput ───────────────────────────────────────────────────
FRAMES_INGESTED = Counter(
    "vms_frames_ingested_total",
    "Total frames pulled from cameras",
    ["camera_id"],
)
FRAMES_DROPPED = Counter(
    "vms_frames_dropped_total",
    "Frames dropped (rate limiting, decode failure, RTSP stall, etc.)",
    ["camera_id", "reason"],
)

# ─── Detection / embedding ───────────────────────────────────────────────────
DETECTIONS = Counter(
    "vms_detections_total",
    "Total face detections",
    ["camera_id"],
)
EMBEDDINGS = Counter(
    "vms_embeddings_total",
    "Total embeddings computed",
    ["camera_id"],
)
EMBED_FAILURES = Counter(
    "vms_embed_failures_total",
    "Embedding attempts that returned None",
    ["camera_id", "reason"],
)
QUALITY_REJECTS = Counter(
    "vms_quality_rejects_total",
    "Detections rejected by the quality gate",
    ["reason"],
)

# ─── Latency ─────────────────────────────────────────────────────────────────
DETECT_LATENCY = Histogram(
    "vms_detect_latency_seconds",
    "Face detection latency",
    buckets=(0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0),
)
# How late the event loop runs a 100 ms timer. The honest measure of loop
# congestion: every await in every orchestrator pays this on resumption.
LOOP_LAG = Histogram(
    "vms_loop_lag_seconds",
    "Event-loop timer lateness (100 ms probe)",
    buckets=(0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0),
)
EMBED_LATENCY = Histogram(
    "vms_embed_latency_seconds",
    "Embedding latency",
    buckets=(0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0),
)
QUALITY_LATENCY = Histogram(
    "vms_quality_latency_seconds",
    "Quality gate evaluation latency",
    buckets=(0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1),
)
MATCH_LATENCY = Histogram(
    "vms_match_latency_seconds",
    "Qdrant ANN match latency",
    buckets=(0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2),
)
APPEARANCE_UPSERT_LATENCY = Histogram(
    "vms_appearance_upsert_latency_seconds",
    "Latency of appearance-log Qdrant upsert",
    buckets=(0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.5),
)
PIPELINE_FRAME_LATENCY = Histogram(
    "vms_pipeline_frame_latency_seconds",
    "Frame-loop period INCLUDING the wait for the next frame; see vms_pipeline_stage_seconds for the work",
    ["zone"],
    buckets=(0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0),
)
# Stage timers. PIPELINE_FRAME_LATENCY starts before the frame read, so it
# measures the loop *period* (~ the 125 ms wait for the next frame at 8 fps),
# not the work — it read 164 ms on a pipeline whose detect took 18 ms. These
# split the two: "wait" is time blocked on the decoder, "work" is everything
# after a frame arrives, and the rest are work's parts.
PIPELINE_STAGE_LATENCY = Histogram(
    "vms_pipeline_stage_seconds",
    "Per-frame time by stage: wait, detect, track, overlay, faces, work",
    ["stage"],
    buckets=(0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0),
)
DETECTIONS_DROPPED_PRETRACK = Counter(
    "vms_detections_dropped_pretrack_total",
    "Detections discarded before tracking (too small to ever be recognised)",
    ["camera_id", "reason"],
)
HW_DECODE = Gauge(
    "vms_hw_decode",
    "1 when this camera's frames come from the hardware decoder (NVDEC)",
    ["camera_id"],
)
SNAPSHOT_UPLOAD_LATENCY = Histogram(
    "vms_snapshot_upload_latency_seconds",
    "MinIO snapshot put latency",
    buckets=(0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0),
)

# ─── Track / match outcome ──────────────────────────────────────────────────
TRACKS_OPENED = Counter("vms_tracks_opened_total", "New tracks created", ["camera_id"])
TRACKS_CLOSED = Counter("vms_tracks_closed_total", "Tracks expired", ["camera_id"])
MATCHES = Counter(
    "vms_matches_total",
    "Match results",
    ["camera_id", "outcome"],   # outcome: hit | miss
)

# ─── Worker queues / messaging ──────────────────────────────────────────────
QUEUE_DEPTH = Gauge(
    "vms_queue_depth",
    "Current depth of a Redis stream",
    ["stream"],
)
DLQ_DEPTH = Gauge(
    "vms_dlq_depth",
    "Current depth of the detections dead-letter queue",
    ["stream"],
)
MATCH_WORKER_INFLIGHT = Gauge(
    "vms_match_worker_inflight",
    "Currently in-flight match-worker tasks",
    ["consumer"],
)
MATCH_WORKER_PROCESSED = Counter(
    "vms_match_worker_processed_total",
    "Total match-worker messages processed",
    ["consumer", "outcome"],   # outcome: ok | error | dlq
)
MATCH_WORKER_AUTOCLAIM = Counter(
    "vms_match_worker_autoclaim_total",
    "Stuck stream entries reclaimed via XAUTOCLAIM",
    ["consumer"],
)

# ─── Stream / camera health ─────────────────────────────────────────────────
ACTIVE_CAMERAS = Gauge(
    "vms_active_cameras",
    "Number of cameras currently streaming",
)
CAMERA_FPS = Gauge(
    "vms_camera_fps",
    "Per-camera ingest FPS (EWMA)",
    ["camera_id"],
)
STREAM_RESTARTS = Counter(
    "vms_stream_restarts_total",
    "Per-camera RTSP reopens",
    ["camera_id", "reason"],
)
STREAM_HEALTHY = Gauge(
    "vms_stream_healthy",
    "1 if the camera stream is producing frames within the deadline, else 0",
    ["camera_id"],
)

# ─── System resources (filled by core.system_metrics) ───────────────────────
SYSTEM_CPU_PCT = Gauge(
    "vms_system_cpu_percent",
    "Process CPU utilization (psutil cpu_percent)",
)
SYSTEM_RSS_BYTES = Gauge(
    "vms_system_rss_bytes",
    "Process resident set size in bytes",
)
SYSTEM_GPU_UTIL_PCT = Gauge(
    "vms_system_gpu_util_percent",
    "GPU utilization percent",
    ["gpu_index", "gpu_name"],
)
SYSTEM_GPU_MEM_USED_BYTES = Gauge(
    "vms_system_gpu_mem_used_bytes",
    "GPU memory used in bytes",
    ["gpu_index", "gpu_name"],
)
SYSTEM_GPU_MEM_TOTAL_BYTES = Gauge(
    "vms_system_gpu_mem_total_bytes",
    "GPU memory total in bytes",
    ["gpu_index", "gpu_name"],
)
SYSTEM_GPU_TEMP_C = Gauge(
    "vms_system_gpu_temp_celsius",
    "GPU temperature in Celsius",
    ["gpu_index", "gpu_name"],
)

# ─── Per-camera live people count ───────────────────────────────────────────
# Updated by LatestDetectionCache on every frame the orchestrator publishes.
# Operators wire this into Grafana to see "how many people are currently
# in front of camera X", "what's our peak occupancy this hour", etc.
CAMERA_PEOPLE_COUNT = Gauge(
    "vms_camera_people_count",
    "Number of people currently visible to a camera. `kind` splits known "
    "(recognized to an enrolled identity) from unknown; `total` is their sum.",
    ["camera_id", "kind"],   # kind: total | known | unknown | smoothed_2s
)

# ─── RTSP decode health (per-camera) ────────────────────────────────────────
DECODE_ERRORS = Counter(
    "vms_decode_errors_total",
    "Per-camera FFmpeg/PyAV decode errors. Hot cameras = the network or the "
    "camera itself is dropping/reordering RTP packets faster than FFmpeg's "
    "tolerance window. See docs/camera-troubleshooting in README.",
    ["camera_id", "kind"],   # kind: decode | demux | packet_decode
)

# ─── Embed-call savings (quality-gate pre-embed short-circuit) ──────────────
EMBED_SKIPPED = Counter(
    "vms_embed_skipped_total",
    "Recognizer calls skipped because the embedding pool is saturated and the "
    "current verdict.score can't improve it. Pure compute saving (the pool's "
    "pooled embedding doesn't change). Higher = more savings.",
    ["camera_id", "reason"],   # reason: pool_saturated_lower_quality
)

# ─── Motion gate (pre-detect frame-difference short-circuit) ────────────────
MOTION_GATE_SKIPS = Counter(
    "vms_motion_gate_skips_total",
    "Detect calls skipped. reason=cadence: the frame fell between "
    "DETECT_EVERY_N_FRAMES ticks (the Kalman tracker carried the boxes); "
    "reason=motion: the scene was static with no track alive. Both are pure "
    "GPU savings — a skipped frame publishes the predicted/empty overlay.",
    ["camera_id", "reason"],
)

# ─── On-demand genderage attribute head ──────────────────────────────────────
GENDERAGE_CALLS = Counter(
    "vms_genderage_calls_total",
    "Explicit genderage inferences run by the orchestrator. Bounded per track "
    "by attributes_max_votes; compare against vms_detections_total to see the "
    "saving vs. the old always-on per-face-per-frame behavior.",
    ["camera_id"],
)

# ─── Snapshot pump (per-orchestrator bounded uploader) ──────────────────────
SNAPSHOT_QUEUE_DEPTH = Gauge(
    "vms_snapshot_queue_depth",
    "Per-camera in-process snapshot upload queue depth",
    ["camera_id"],
)
SNAPSHOT_QUEUE_INFLIGHT = Gauge(
    "vms_snapshot_queue_inflight",
    "Per-camera snapshots currently uploading",
    ["camera_id"],
)
SNAPSHOT_QUEUE_DROPPED = Counter(
    "vms_snapshot_queue_dropped_total",
    "Snapshots dropped because the per-camera upload queue was full",
    ["camera_id"],
)

# ─── Batched inference ──────────────────────────────────────────────────────
BATCH_FLUSHES = Counter(
    "vms_batch_flushes_total",
    "Times the inference batcher fired",
    ["stage", "trigger"],   # stage: detect | embed ; trigger: full | window
)
BATCH_SIZE = Histogram(
    "vms_batch_size",
    "Items per batched inference flush",
    ["stage"],
    buckets=(1, 2, 4, 8, 16, 32, 64),
)
BATCH_WAIT_LATENCY = Histogram(
    "vms_batch_wait_latency_seconds",
    "Time a request waits in the coalescing window before flush",
    ["stage"],
    buckets=(0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05),
)

# ─── Detector-head capability flags (set once after first detect) ───────────
DETECTOR_POSE_AVAILABLE = Gauge(
    "vms_detector_pose_available",
    "1 if the active detector populates yaw/pitch on observations, else 0. "
    "When 0 the FaceQualityGate's pose filter is a no-op and operators should "
    "either swap to a head-pose model or accept that off-axis faces are not "
    "filtered upstream.",
    ["det_size"],
)

# ─── Runtime / inference health ─────────────────────────────────────────────
RUNTIME_DEGRADED = Gauge(
    "vms_runtime_degraded",
    "1 if a FaceRuntime is currently serving from CPU after a CUDA failure, "
    "else 0. Multiple runtimes (per det_size) report independently.",
    ["det_size"],
)
RUNTIME_CUDA_FAILURES = Counter(
    "vms_runtime_cuda_failures_total",
    "CUDA execution-provider failures captured by FaceRuntime",
    ["det_size", "stage"],   # stage: detect | rebuild
)
RUNTIME_CUDA_RECOVERED = Counter(
    "vms_runtime_cuda_recovered_total",
    "Successful re-promotions from CPU back to CUDA",
    ["det_size"],
)

# ─── Worker liveness ────────────────────────────────────────────────────────
WORKER_ALIVE = Gauge(
    "vms_worker_alive",
    "1 if the worker has reported a heartbeat in the last interval, else 0",
    ["component", "host"],
)

# ─── DPDP / forensic ────────────────────────────────────────────────────────
AUDIT_EVENTS = Counter(
    "vms_audit_events_total",
    "Audit-log entries written (1:N queries, deletions, enrollments)",
    ["action", "actor_kind"],
)
RETENTION_DELETED = Counter(
    "vms_retention_deleted_total",
    "Rows / objects pruned by the retention worker",
    ["target"],   # detection_events | snapshots | audit_log
)

# ─── Identity latch (L0 cache) ──────────────────────────────────────────────
LATCH_TRANSITIONS = Counter(
    "vms_latch_transitions_total",
    "Identity-latch state transitions per track. from/to are LatchState values; "
    "'latched'->'candidate' with reason=identity_change is a person swap on a "
    "track the tracker glued together.",
    ["camera_id", "from_state", "to_state"],
)
LATCH_DECISIONS = Counter(
    "vms_latch_decisions_total",
    "Publish/suppress decisions the latch made. outcome=publish means a "
    "FaceCandidate went to the match worker; outcome=suppress means an embed "
    "and/or a 1:N query that the old pipeline would have paid for was skipped.",
    ["camera_id", "outcome", "reason"],
)
TIME_TO_IDENTITY = Histogram(
    "vms_time_to_identity_seconds",
    "Seconds from a track's first quality-passing face to its identity "
    "appearing (kind=provisional: first hit shown on the overlay; "
    "kind=confirmed: K-of-N agreement).",
    ["kind"],
    buckets=(0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0),
)
VERDICTS_RECEIVED = Counter(
    "vms_verdicts_received_total",
    "Match-worker verdicts delivered back to an orchestrator over the "
    "vms.verdict channel. outcome: hit | miss | ambiguous | orphan (track gone).",
    ["camera_id", "outcome"],
)
REASSOCIATIONS = Counter(
    "vms_track_reassociations_total",
    "New tracks that inherited a recently-dead track's identity by template "
    "similarity (occlusion / re-detect without an ID reset).",
    ["camera_id"],
)

# ─── Gallery cache (L2 hot set + L3 local gallery) ──────────────────────────
GALLERY_LOOKUPS = Counter(
    "vms_gallery_cache_lookups_total",
    "1:N lookups by tier. tier=hot|local|qdrant; outcome=hit|miss|ambiguous|"
    "stale_fallback|error.",
    ["tier", "outcome"],
)
GALLERY_SIZE = Gauge(
    "vms_gallery_cache_vectors",
    "Enrolled vectors currently resident in the local gallery cache",
    ["tenant_id"],
)
GALLERY_REFRESH_LATENCY = Histogram(
    "vms_gallery_cache_refresh_seconds",
    "Wall time of a full local-gallery reload from Qdrant",
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0),
)
GALLERY_REFRESHES = Counter(
    "vms_gallery_cache_refreshes_total",
    "Local-gallery reloads. trigger=timer|invalidate|startup; outcome=ok|error",
    ["trigger", "outcome"],
)
GALLERY_SHADOW_MISMATCH = Counter(
    "vms_gallery_cache_shadow_mismatch_total",
    "Cached lookups whose top-1 person disagreed with a shadow Qdrant query. "
    "Any non-zero rate means the cache is stale or wrong — investigate.",
)
GALLERY_HOT_HITRATE = Counter(
    "vms_gallery_hot_set_total",
    "Whether the eventual top-1 identity was already in the camera's hot set. "
    "outcome=in_hot|not_in_hot|no_match. High in_hot = the edge fast path pays.",
    ["outcome"],
)

# ─── Cross-camera ReID worker ───────────────────────────────────────────────
REID_PROCESSED = Counter(
    "vms_reid_processed_total",
    "FaceCandidates processed by the cross-camera ReID worker",
    ["consumer", "outcome"],   # outcome: matched | nomatch | error
)
REID_LINKS_EMITTED = Counter(
    "vms_reid_links_emitted_total",
    "TrackLinks written by the cross-camera ReID worker",
    ["consumer"],
)
REID_LATENCY = Histogram(
    "vms_reid_latency_seconds",
    "Cross-camera ReID processing latency per candidate",
    buckets=(0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0),
)
