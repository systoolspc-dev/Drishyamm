from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Service ---
    vms_env: Literal["dev", "stage", "prod"] = "dev"
    vms_log_level: str = "INFO"

    # --- Postgres ---
    postgres_dsn: str = "postgresql+asyncpg://vms:vms@localhost:5432/vms_face"
    postgres_dsn_sync: str = "postgresql+psycopg2://vms:vms@localhost:5432/vms_face"

    # --- Qdrant ---
    qdrant_url: str = "http://localhost:6333"
    qdrant_api_key: str | None = None
    # Legacy single-collection name. Kept for backwards compat — used as a
    # fallback when the dual-collection split below is not configured.
    qdrant_collection: str = "faces"
    # Dual-collection split (research memory 2026-05-07): the enrolled gallery
    # is small/hot and replicated; the appearance log is large/time-partitioned.
    # Sharing a single collection is architecturally wrong above ~1M points.
    qdrant_collection_enrolled: str = "vms_enrolled"
    qdrant_collection_appearance: str = "vms_appearance"
    qdrant_appearance_enabled: bool = True
    qdrant_vector_size: int = 512
    qdrant_distance: Literal["Cosine", "Dot", "Euclid"] = "Cosine"

    # --- Redis ---
    redis_url: str = "redis://localhost:6379/0"
    redis_stream_detections: str = "vms.detections"
    redis_stream_alerts: str = "vms.alerts"
    redis_stream_detections_dlq: str = "vms.detections.dlq"
    # Stream caps (XADD MAXLEN ~). A FaceCandidate carries a 512-float JSON
    # embedding (~20 KB per entry); the old 200,000 cap let vms.detections
    # grow to 4.25 GB on a busy stack, pinned Redis at 100% CPU and made the
    # match worker's XREADGROUP time out and crash. Consumers ack within
    # milliseconds, so the backlog only matters while a worker is down:
    # 20,000 entries is over an hour of candidates at post-latch rates.
    redis_stream_detections_maxlen: int = 20_000
    redis_stream_alerts_maxlen: int = 20_000
    redis_consumer_group: str = "match-workers"
    redis_cam_state_channel: str = "vms.cam.state"
    redis_cam_state_key_prefix: str = "vms:cam:state:"
    redis_cam_state_ttl_sec: int = 30
    # Match-worker verdicts back to the orchestrator that owns the track
    # (pub/sub, per camera, best-effort — the durable path is still the
    # detections stream + DetectionEvent). Feeds the identity latch.
    redis_verdict_channel: str = "vms.verdict"
    # Enrolment / deletion notifications so local gallery caches reload.
    redis_gallery_changed_channel: str = "vms.gallery.changed"
    # Monotonic per-tenant gallery version (INCR on every change). Edge nodes
    # poll GET /edge/gallery/version and pull a snapshot when it moves.
    redis_gallery_version_key_prefix: str = "vms:gallery:version:"

    # --- MinIO ---
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_secure: bool = False
    minio_bucket_snapshots: str = "vms-snapshots"
    minio_bucket_enrollments: str = "vms-enrollments"
    # Journey stitch artifacts (MP4 / PDF / map). Reuses person-tracker's bucket.
    minio_bucket_output: str = "vms-person-tracker"

    # --- Journey reconstruction (forensic search + stitch) ---
    # Timezone for human-readable timestamps baked server-side (video overlay,
    # PDF, /journey/map labels). Storage + recording lookup stay UTC; this only
    # affects display. Set DISPLAY_TZ to your deployment's local zone.
    display_timezone: str = "Asia/Kolkata"
    recordings_root: str = "/recordings"            # MediaMTX recordings tree (RO mount)
    journey_default_window: str = "7d"              # default forensic search window
    journey_similarity_threshold: float = 0.50      # appearance ANN cosine floor
    journey_search_top_k: int = 5000                # max appearance hits per search
    journey_cluster_window_sec: int = 30            # same-camera sighting cluster gap
    clip_pad_before_sec: int = 2                    # FFmpeg clip lead-in
    clip_pad_after_sec: int = 4                     # FFmpeg clip lead-out
    # Per-sighting clip cap. Track-aware clustering can merge a long linger on one
    # camera into a single multi-minute sighting; without this each such stop would
    # render its FULL duration and the journey video balloons (e.g. 25+ min). Cap to
    # the first N seconds — the "key moment" at each stop. Env: CLIP_MAX_SEC.
    clip_max_sec: int = 20
    # Max number of stops in the stitched highlight reel. A person can have dozens
    # of re-visits to the same camera; rendering every one makes a long, repetitive
    # video. Keep the N highest-confidence stops (in time order). Env: STITCH_MAX_CLIPS.
    stitch_max_clips: int = 12
    stitch_max_total_sec: int = 600                 # max total stitched duration budget
    stitch_queue_name: str = "vms.stitch"           # RQ queue for stitch jobs
    stitch_job_timeout_sec: int = 1800              # RQ job timeout (30 min)
    stitch_font_path: str = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    # When true, the live StreamOrchestrator extracts clothing upper/lower colour
    # per detection and logs it into the vms_appearance payload so forensic body
    # fusion engages on historical detections. OFF by default — it adds a small
    # OpenCV cost per logged detection (matters at 2k cameras); enable knowingly.
    journey_body_logging: bool = False
    # OSNet body-ReID model (ONNX, 256x128 in / 512-d feature out). When present,
    # a body appearance vector is logged per detection and fused with the face
    # cosine — so a person is still tracked when only their side/back shows. Empty
    # or missing file → clothing-colour fusion only. Env: BODY_MODEL_PATH.
    body_model_path: str = "/srv/app/face_detection/vms_face/data/models/osnet_x1_0_msmt17.onnx"
    # Journey event spine (Kafka). Empty bootstrap = no-op producer (dev-safe).
    kafka_bootstrap_servers: str = ""
    kafka_topic_journey_events: str = "journey.events"

    # --- InsightFace runtime ---
    insightface_model: str = "buffalo_l"
    insightface_det_size: int = 960
    insightface_ctx_id: int = 0

    # How many independent model instances to hold per detection size.
    #
    # Each FaceRuntime serialises its own calls on a lock (InsightFace's app is
    # not safe to call concurrently), and the pool used to hold exactly ONE
    # runtime per det_size. Since every camera is normally configured with the
    # same det_size, that meant every camera in the process queued behind a
    # single lock: measured on an 18-camera deployment, ~95% of detect latency
    # was time spent waiting for that lock while the GPU sat mostly idle.
    #
    # Replicas let N cameras dispatch at once. Cost is GPU memory — roughly one
    # model copy each (~2 GB) — so raise this only with VRAM headroom to spare.
    # 1 restores the old single-runtime behaviour.
    # 2026-09-20: detect() is no longer serialized on a lock (ORT sessions are
    # thread-safe — see insightface_serialize_calls), so ONE runtime serves every
    # camera and extra replicas only buy extra CUDA streams. Default 1.
    insightface_runtime_replicas: int = 1

    # Shape of the detector input, as width : height.
    #
    # A square input letterboxes CCTV footage: 1920x1080 into 960x960 leaves
    # 43.8% of the tensor as black padding, convolved at full cost every frame,
    # and caps the scale factor at 0.5 so a 100px face reaches the detector as
    # 50px. Matching the picture's aspect spends that same compute on
    # resolution instead — 1280x736 costs 1.02x of 960x960 but scales by 0.667,
    # detecting faces ~33% further away.
    #
    # Set to the aspect of the cameras (16/9 = 1.7778). 0 keeps the square
    # input and the previous behaviour.
    insightface_det_aspect: float = 0.0
    insightface_providers: str = "CUDAExecutionProvider,CPUExecutionProvider"

    # ── ONNX Runtime session policy (infra/ort_session.py) ─────────────────
    # Host threads per session. ORT defaults to one intra-op thread per core
    # and lets them spin between kernels — measured 480 idle-spinning threads
    # in a two-camera process. A GPU session only needs threads to launch
    # kernels; 2 is enough.
    ort_intra_op_threads: int = 2
    ort_inter_op_threads: int = 1
    ort_allow_spinning: bool = False
    # TensorRT execution provider. Used only when libnvinfer.so.10 can actually
    # be loaded (pip tensorrt-cu12-libs or apt libnvinfer10); otherwise CUDA.
    # ORT advertising the provider means nothing — check the active provider.
    tensorrt_enabled: bool = True
    tensorrt_fp16: bool = True
    # Route the recognizer through TensorRT at all (FP32 unless the flag below).
    tensorrt_recognizer: bool = True
    # The recognizer's vectors must stay parity-identical to the enrolled
    # gallery: FP16 is allowed only because it measured cosine 0.999964 vs
    # CUDA FP32 on 32 real aligned faces (gate 0.9999). It is on because live
    # embed batches are ~1 (measured 1.06 under a 20-camera load), where FP16
    # is 1.77 ms/face against 5.50 ms for FP32 — at batch 16 they tie.
    tensorrt_fp16_recognizer: bool = True
    tensorrt_recognizer_input: str = "input.1"
    tensorrt_detector_input: str = "input.1"
    tensorrt_recognizer_max_batch: int = 32
    # Engine + timing cache. On the insightface bind mount so engines survive
    # container recreation. Engines are per GPU SKU.
    # Box-wide lock for CUDA/NVDEC context creation (infra/cuda_gate.py); the
    # compose volume `vms-locks` is mounted at /vms-locks in every AI container.
    cuda_init_lock_path: str = "/vms-locks/cuda-init.lock"
    tensorrt_cache_dir: str = "/root/.insightface/trt_cache"
    # Re-export the SCRFD detector with a STATIC 1x3xHxW input (folded through
    # ORT's optimizer) for the runtime's detector input size. The shipped
    # dynamic-HxW export is rejected by TensorRT ("contradictory
    # IOptimizationProfile constraints"), profile or not; the static one builds
    # and measured 3.56 ms vs 5.63 ms on CUDA FP32 at 960x544. Built once per
    # size into tensorrt_cache_dir. Harmless on CUDA (same speed).
    detector_static_export: bool = True
    # Fold SCRFD's preprocessing (uint8 BGR HWC -> float RGB CHW, (x-127.5)/128)
    # into the batched detector graph so it runs on the GPU: no
    # cv2.dnn.blobFromImage per frame on a CPU thread, and a 4x smaller
    # host->device copy. Measured 2026-09-21: blobFromImage was 16% of the
    # inference service's CPU at 116 detects/s.
    detector_u8_input: bool = True
    tensorrt_workspace_mb: int = 2048
    # OpenCV's own pool: per-frame resize/letterbox at 960x544 gains nothing
    # from it and it multiplies threads per process.
    opencv_threads: int = 1
    # Serialize detect() calls on one lock (the pre-2026-09 behaviour). ORT
    # sessions are thread-safe and the detection-only FaceAnalysis has no shared
    # mutable state on that path, so this is off; it exists as an escape hatch.
    insightface_serialize_calls: bool = False
    insightface_det_threshold: float = 0.5
    insightface_rec_threshold: float = 0.62
    # Crowd false-positive guard: a live 1:N match is only asserted when the top
    # identity beats the nearest DIFFERENT identity by at least this cosine margin.
    # In dense scenes two enrolled people can both sit near a live face — asserting
    # the top one is a coin-flip, so below this margin we return "unknown" rather
    # than risk a mis-ID. 0 disables the guard. Env: MATCH_TOP1_MARGIN.
    match_top1_margin: float = 0.06
    # When the CUDA execution provider fails, we degrade to CPU temporarily
    # and retry CUDA after this cooldown. Set 0 to disable retries (CPU latch).
    insightface_cuda_retry_sec: float = 60.0
    # buffalo_l ships several auxiliary models we don't use on the hot path:
    #   - 2d106det.onnx  (~5 MB)   — 106-point landmarks, never read
    #   - 1k3d68.onnx    (~143 MB) — 68-point 3D landmarks, sometimes carries pose
    # Disabled by default to free ~150 MB of GPU memory and ~3-5 ms per face of
    # inference time. Re-enable only if a downstream feature needs them.
    insightface_load_aux_landmarks: bool = False
    # When False the API process does NOT eagerly load the FaceRuntime on
    # startup. Saves ~600 MB GPU memory in the typical deployment where the
    # API serves REST/WS only and orchestrators run as separate processes.
    # Set True for single-process dev where the API also runs in-process
    # orchestrators (so the first frame doesn't pay the cold-start cost).
    api_warmup_face_runtime: bool = False

    # --- Batched ONNX inference (PR #14) ---
    # When enabled, in-flight detect()/embed() calls are coalesced across
    # cameras into a single ONNX Runtime call. Trades a small constant latency
    # (the coalescing window) for 3-5x throughput on detect and ~2x on embed.
    # Off by default to keep the rollout safe; flip per-deployment after a
    # benchmark. The window/max-batch tunables are independent for each path.
    pipeline_batched_inference: bool = False
    batch_detect_max: int = 8
    batch_detect_window_ms: float = 3.0
    batch_embed_max: int = 16
    batch_embed_window_ms: float = 2.0
    match_min_quality: float = 0.58
    match_min_face_px: int = 80
    match_min_blur_var: float = 30.0

    # --- Recognizer backend (pluggable) ---
    # Allowed:
    #   "insightface"         default; reuses the embedding FaceAnalysis.get()
    #                         computes during detection
    #   "insightface_batched" SAME weights, SAME vectors, embedded standalone
    #   "adaface"             different embedding space; needs re-enrolment
    #
    # "insightface" looks free — the embedding arrives with the detection — but
    # it is the opposite. InsightFace runs the recognition head on EVERY
    # detected face on EVERY detect call, one face at a time, before any of our
    # gates see it. So `embed_every_n_frames`, the quality verdict and
    # `pool.would_admit()` all save nothing: they sit behind `reuse_existing()`,
    # which hands back a vector already paid for. Measured on the live service:
    # `vms_embed_latency_seconds_count` = 0, `vms_embed_skipped_total` = no samples.
    #
    # "insightface_batched" produces bit-identical vectors (verified: cosine 1.0
    # to seven decimals) from the same w600k_r50.onnx, so the enrolled gallery
    # and every calibrated threshold survive the switch — but the gates bite and
    # in-flight crops batch across cameras. Measured 3.80 -> 0.85 ms/face at 6
    # faces. Switching back and forth is safe in both directions.
    # See docs/FACE_LIGHTWEIGHT_TARGET.md.
    recognizer_backend: str = "insightface"
    adaface_model_path: str = ""
    # Explicit path to the ArcFace recognition ONNX for "insightface_batched".
    # Empty = resolve it the same way FaceAnalysis does, from the
    # `insightface_model` pack under ~/.insightface/models (w600k_r50.onnx for
    # buffalo_l, w600k_mbf.onnx for buffalo_s).
    arcface_model_path: str = ""
    # Note: AdaFace and ArcFace embeddings are NOT interchangeable. Switching
    # backends requires re-enrolling all faces to keep the gallery consistent.
    #
    # Per-recognizer cosine thresholds. ArcFace (insightface_rec_threshold above)
    # and AdaFace live in different similarity regimes; a single threshold can't
    # serve both. Use effective_recognizer_threshold() at call sites.
    recognizer_adaface_threshold: float = 0.35

    # --- Identity latch (L0 cache, docs/FACE_EDGE_REALTIME_PLAN.md §4) ---
    # The unit of recognition work is the TRACK, not the frame. Once a track
    # has an identity the orchestrator stops embedding and stops asking the
    # match worker, and only re-verifies on a timer, on a quality jump, or when
    # the tracker becomes uncertain. Unknown visitors get a negative latch with
    # a retry budget instead of a full 1:N query per pool change.
    #
    # Off restores the previous behaviour exactly: publish a candidate on every
    # pool change once the track has track_min_hits_to_match hits.
    identity_latch_enabled: bool = True
    # K agreeing verdicts among the last N confirm an identity (K-of-N). The
    # first hit is published to the overlay immediately as PROVISIONAL; the
    # Kth turns it CONFIRMED. 2-of-3 confirms a stable face in ~2 queries.
    identity_latch_confirm_k: int = 2
    identity_latch_confirm_n: int = 3
    # While CANDIDATE, at most one query per this many seconds. The pool
    # changes on every warm-up embed, which used to mean a Qdrant query and a
    # DetectionEvent row per frame for the first ~5 frames of every track.
    identity_latch_candidate_gap_sec: float = 0.5
    # While LATCHED: re-verify at this interval (gallery may have changed, the
    # person may have been replaced by someone the tracker glued to the same
    # id), ...
    identity_latch_reverify_sec: float = 12.0
    # ... or sooner when the best crop quality on the track improves by at
    # least this much since the last query (a better template is worth a
    # second look — this is also how a wrong provisional gets corrected fast).
    identity_latch_quality_jump: float = 0.10
    # Consecutive DISAGREEING verdicts (a different person, or high-quality
    # misses) needed to drop a confirmed identity. Sticky on purpose: one bad
    # crop must not flicker a name off the box.
    identity_latch_unlatch_after: int = 3
    # Unknown (negative) latch: after this many queries with no hit, stop
    # asking. Retry only on a quality jump or every identity_latch_unknown_retry_sec.
    identity_latch_max_unknown_queries: int = 3
    identity_latch_unknown_retry_sec: float = 20.0
    # Re-association: a track that dies and a new track that appears within
    # this window with a template this similar to the dead track's inherits
    # its identity as PROVISIONAL (one agreeing verdict confirms it). This is
    # what stops a brief occlusion resetting a name to "Unknown".
    identity_latch_reassoc_sec: float = 30.0
    identity_latch_reassoc_min_cosine: float = 0.70

    # --- Gallery cache (L2 hot set + L3 local gallery, in front of Qdrant) ---
    # The match worker holds the enrolled gallery in RAM and answers 1:N with a
    # brute-force cosine search; Qdrant stays the source of truth and the
    # fallback when the cache is stale. 50k identities x 512-d float32 is
    # 100 MB and ~1 ms — a vector database is not the fast path at this size.
    gallery_cache_enabled: bool = True
    # Full reload interval. Enrol/delete also push `vms.gallery.changed`, which
    # triggers an immediate (debounced) reload — this is the safety net.
    gallery_cache_refresh_sec: float = 30.0
    # If the last successful load is older than this, the cache is considered
    # stale and match_one falls back to Qdrant until a reload succeeds.
    gallery_cache_max_stale_sec: float = 180.0
    # Debounce for change-triggered reloads (a bulk enrolment fires many).
    gallery_cache_invalidate_debounce_sec: float = 1.0
    # "float32" = exact. "int8" = per-vector scalar quantised storage (4x less
    # memory) with float32 rescoring of the top candidates; validate on the
    # eval harness before enabling on a gallery you care about.
    gallery_cache_storage: Literal["float32", "int8"] = "float32"
    gallery_cache_int8_rescore_k: int = 32
    # Rollout safety: with this probability a cached lookup ALSO queries
    # Qdrant and compares the top-1 person; disagreements are counted in
    # vms_gallery_cache_shadow_mismatch_total. 0 disables. Try 0.05 for a day.
    gallery_cache_shadow_check_rate: float = 0.0
    # L2 hot set: identities seen on a camera / tenant within this window.
    # Maintained always (it is cheap and the hit-rate metric decides whether
    # the fast path is worth turning on for an edge profile).
    gallery_cache_hot_window_sec: float = 1800.0
    # Fast path: answer from the hot set alone when the top-1 clears
    # threshold + this margin. OFF on the server (the full local search is
    # already ~1 ms there); it exists for edge tiers where the full gallery is
    # the expensive part. The margin guard cannot see cold rivals on this
    # path, hence the extra confidence required.
    gallery_cache_hot_fast_path: bool = False
    gallery_cache_hot_confident_margin: float = 0.10

    # --- Edge ↔ server (docs/FACE_EDGE_REALTIME_PLAN.md §5/§6) ---
    # RECOGNIZER_BACKEND=remote turns this process into the "detect-track-crop
    # only" edge shape: SCRFD + tracker + quality + latch run here, and the
    # ~2 crops per track the latch lets through are aligned locally and sent
    # to the server's /edge/embed, which answers in the SERVER's embedding
    # space. One embedding space per deployment, zero recognizer GPU on the
    # edge, and the identity latch works unchanged.
    edge_server_url: str = ""                 # e.g. http://smart-cam-ai:8001 (env EDGE_SERVER_URL)
    edge_server_token: str = ""               # Bearer JWT for /edge/* (env EDGE_SERVER_TOKEN)
    # "png" is lossless — the remote vector is IDENTICAL to a local one
    # (eval/remote_parity.py: cosine 1.0000000, ~21 KB per crop).
    # "jpeg" is NOT interchangeable for aligned 112x112 crops: measured
    # cosine 0.977-0.994 at q=92 (~4.5 KB) — the crop is so small that JPEG
    # eats exactly the detail the embedder keys on, and that drift is the
    # size of the ambiguity margin. Keep png unless a link is metered enough
    # to re-calibrate thresholds for it.
    edge_crop_format: Literal["png", "jpeg"] = "png"
    edge_jpeg_quality: int = 92
    edge_http_timeout_sec: float = 3.0
    # Circuit breaker: after this many consecutive failures stop calling the
    # server for the cooldown (embeds return None; the latch retries later),
    # so a dead uplink cannot stall the per-camera loop on every face.
    edge_breaker_fail_threshold: int = 5
    edge_breaker_cooldown_sec: float = 10.0
    # /edge/escalate detects on a crop the edge already found a face in, so a
    # permissive floor is right — the crop is not a whole scene.
    edge_escalate_det_threshold: float = 0.3

    # --- Track-level embedding pooling (multi-frame fusion) ---
    track_pool_top_k: int = 5
    track_min_hits_to_match: int = 3
    # Quality floor on pool admission (roadmap task A4). Crops scoring below
    # this composite quality never enter the pool, even when slots are free —
    # a track that only ever produced garbage crops publishes nothing rather
    # than a garbage pooled embedding. 0.0 disables the floor.
    track_pool_min_quality: float = 0.30

    # --- Face attributes (gender / age) ---
    # Per-track quality-weighted voting over genderage outputs. A single
    # frame's gender guess on a CCTV crop flips constantly; the vote
    # aggregates the best crops of a track and only asserts a label once
    # enough weighted agreement exists. Applies to the overlay, the
    # FaceCandidate payload, and the people-count gender breakdown.
    face_attributes_enabled: bool = True
    # Run buffalo_l's genderage head on demand (per track, until the vote is
    # confident) instead of inside FaceAnalysis.get() on every face every
    # frame. Also the ONLY way gender works at all when
    # PIPELINE_BATCHED_INFERENCE=true — the batched SCRFD path never runs
    # attribute heads. Cuts genderage inference from O(faces x frames) to
    # <= attributes_max_votes calls per track.
    insightface_ondemand_genderage: bool = True
    # Faces smaller than this (short side, px) don't vote — tiny crops give
    # near-random gender output and would poison the vote.
    attributes_min_face_px: int = 48
    # Vote thresholds: a label is asserted after >= min_votes samples with
    # >= min_agreement of the quality-weighted mass on one side. Sampling
    # stops at max_votes (or earlier once the vote is decisively settled),
    # bounding per-track attribute compute.
    attributes_min_votes: int = 3
    attributes_max_votes: int = 8
    attributes_min_agreement: float = 0.70

    # --- Quality gate ---
    quality_min_face_px: int = 40
    quality_min_det_score: float = 0.6
    quality_max_blur_var: float = 0.0
    quality_max_yaw_deg: float = 45.0
    quality_max_pitch_deg: float = 30.0
    quality_min_brightness: float = 15.0
    quality_max_brightness: float = 240.0

    # --- Tracker (SORT/DeepSORT-style) ---
    # Faces smaller than this (short side, px) are dropped BEFORE the tracker.
    # The quality gate rejects them anyway (reason=too_small) — but only after
    # they have opened a track and paid for Kalman + Hungarian + a quality
    # check. Measured: 139,496 tracks opened for 143,235 detections, 99.85% of
    # them too small to ever be recognised. 0 = use quality_min_face_px so the
    # pre-tracker filter and the gate agree on the same number.
    track_min_face_px: int = 0
    tracker_iou_threshold: float = 0.3
    tracker_max_age: int = 30   
    tracker_min_hits: int = 3
    # Weight given to the appearance (cosine) term in the assignment cost.
    # 0.0 = pure SORT (IoU only); >0 = DeepSORT-like, with the recognizer's
    # own embedding as the appearance feature. Empirically 0.4-0.6 works
    # well for face boxes; higher overweights appearance and produces
    # ID-switches under heavy occlusion.
    tracker_appearance_weight: float = 0.4
    # EWMA factor for the per-track smoothed embedding. Higher = more
    # historical inertia (less affected by single bad-quality frames).
    tracker_appearance_alpha: float = 0.7

    # --- Pipeline ---
    ai_ingest_backend: Literal["opencv", "deepstream"] = "opencv"
    # 4 fps/camera is ample for face detection and halves detector demand vs the
    # old 8 on a shared GPU; the tracker + client overlay predict between frames.
    target_fps: float = 4.0

    # Run the SCRFD detector only every Nth ingested frame; on the frames in
    # between, advance the existing Kalman/SORT tracks and publish their
    # PREDICTED boxes. This decouples how often a box moves on screen from how
    # often the (expensive, shared-GPU) detector runs.
    #
    # Why it matters: with detection on every frame, box updates are chained to
    # detector throughput, which on a shared GPU serving many cameras is a few
    # per second — so the box visibly lags a moving person. The tracker already
    # runs a constant-velocity Kalman predict on every track every step; this
    # draws that prediction instead of waiting for the next detection. It also
    # cuts detector demand by ~N, draining the queue on an oversubscribed GPU.
    #
    # 1 = detect every frame (previous behaviour, exact no-op). 2-3 is the
    # useful range; beyond that the prediction outruns reality between detects.
    detect_every_n_frames: int = 1
    # Attention scheduling (Phase 2.6): the detector's cadence follows what the
    # scene needs. Full rate (every frame) while any track is undecided (NEW /
    # CANDIDATE) or the scene is empty (entry detection); every Nth frame once
    # every track in view is latched to a known identity, every Mth while the
    # only tracks are latched strangers (the latch still re-queries them). The
    # Kalman tracker carries the boxes in between, exactly as with
    # DETECT_EVERY_N_FRAMES.
    attention_scheduling: bool = True
    attention_latched_every_n: int = 4
    attention_unknown_every_n: int = 2
    embed_every_n_frames: int = 5
    snapshot_top_k_per_track: int = 3
    # Maximum number of in-flight per-face processing tasks within a single
    # frame's _handle_tracked fan-out. Bounded so a sudden 100-face frame can't
    # flood the GPU/IO pools. Tune with VMS_GPU_POOL_SIZE in mind.
    pipeline_face_concurrency: int = 8
    # --- Person detection (YOLOv8) — optional, runs alongside face detection ---
    # When enabled, the orchestrator runs a YOLO person detector every Nth
    # frame and ships the count via the overlay payload as `persons_present`.
    # The cache then uses MAX(persons_present, face_active_tracks) as the
    # authoritative "people in frame" count — back-of-head and occluded
    # people now register correctly. See infra/person_detector.py docstring
    # for model setup (yolov8n.onnx, ~6 MB).
    pipeline_person_detection_enabled: bool = False
    pipeline_person_model_path: str = ""              # absolute path to yolov8n.onnx
    pipeline_person_threshold: float = 0.35
    pipeline_person_det_size: int = 640
    pipeline_person_detect_every_n_frames: int = 2
    # --- Investigation index (I-1), phase 0 measurement ---
    # Counts finished face tracks and (when person detection is on) person
    # tracks per camera, so we know tracks/camera/day before building the
    # index. Counting only: no crops, no embeddings, no DB writes. Off by
    # default. See docs/investigation/PHASE0_MEASUREMENT.md.
    investigate_measure_enabled: bool = False
    investigate_measure_log_interval_s: int = 900     # one summary log line per camera
    investigate_min_track_seconds: float = 1.0        # shorter tracks count as junk
    investigate_min_track_hits: int = 3               # fewer matched frames count as junk
    investigate_person_track_max_gap_s: float = 1.0   # person track ends after this long unseen
    # --- Motion gate (roadmap task E.3) — skip SCRFD on static scenes ---
    # A cheap CPU frame-difference check runs before the detector. When the
    # scene is static AND no tracks are alive, the detect call is skipped
    # entirely — on quiet cameras (parking lots at night, empty corridors)
    # this eliminates 70-95% of detect GPU. Never skips while tracks exist,
    # so a person standing still is never lost; a full detect always runs at
    # least every `motion_gate_max_skip_frames` as a safety net. Off by
    # default: enable per-deployment after checking the skip metric
    # (vms_motion_gate_skips_total) against expectations.
    motion_gate_enabled: bool = False
    # Width the frame is downscaled to for the difference check (~0.2 ms/frame).
    motion_gate_downscale_width: int = 160
    # Per-pixel intensity delta (0-255) considered "changed".
    motion_gate_pixel_delta: int = 26
    # Fraction of downscaled pixels that must change to count as motion.
    motion_gate_min_changed_frac: float = 0.004
    # Hard ceiling on consecutive skipped detects (15 ≈ 2 s at 8 fps).
    motion_gate_max_skip_frames: int = 15
    # Per-camera snapshot upload pump. Pump owns a bounded asyncio.Queue plus
    # `snapshot_pump_workers` consumer tasks; on overflow we drop the oldest
    # queued upload (best-effort by design — snapshots are evidence, not
    # source of truth). Replaces the unbounded fire-and-forget create_task.
    # /snapshot.jpg fallback thumbnails (services/snapshot_cache.py): encode a
    # copy no wider than this, at most every interval. The full 1080p frame at
    # 4 fps was the largest per-frame CPU cost in the pipeline (stage=overlay).
    snapshot_cache_max_width: int = 640
    snapshot_cache_interval_sec: float = 0.5
    snapshot_pump_queue_size: int = 256
    snapshot_pump_workers: int = 2
    # JPEG quality for snapshot uploads. 80 is visually indistinguishable from
    # 88 on face thumbnails and produces ~30% smaller files / ~25% faster
    # encoding. Raise to 88-92 only if you have an evidence-grade requirement.
    snapshot_jpeg_quality: int = 80
    # Per-event face enhancement. When true, the snapshot pump POSTs each
    # face JPEG to the face-reconstruct service (CodeFormer + Real-ESRGAN)
    # before uploading to MinIO. The enhanced PNG goes to MinIO instead of
    # the original. On any failure (timeout, 5xx, service offline) we fall
    # back to uploading the original — never drop the snapshot. Off by
    # default because it adds an HTTP round-trip per event.
    snapshot_auto_enhance: bool = False
    # Fidelity weight passed to /api/reconstruct (0..1). Lower = more
    # aggressive AI restoration; higher = stick closer to the original.
    # 0.5 is the upstream default and a good balance for CCTV faces.
    snapshot_auto_enhance_fidelity: float = 0.5
    # URL of the face-reconstruct service. Default points at the compose
    # service name; override via FACE_RECONSTRUCT_URL in env when running
    # without docker compose.
    face_reconstruct_url: str = "http://face-reconstruct:8002"
    # Watchlist-hit auto-enhance. Less aggressive than per-event because
    # alerts are rare but matter more — we can afford a longer round-trip.
    # When true, the match_worker pulls the alert's snapshot from MinIO,
    # enhances it via the same service, uploads the result alongside, and
    # the published alert points at the enhanced version. The original is
    # preserved at its original key so audit chains stay intact.
    watchlist_auto_enhance: bool = False
    watchlist_auto_enhance_fidelity: float = 0.6
    # Enrollment auto-enhance — disabled. The supporting helper in
    # services/enrollment.py stays gated on this flag; flip to True if you
    # want gallery thumbnails cleaned up post-upload.
    enrollment_auto_enhance: bool = False
    enrollment_auto_enhance_fidelity: float = 0.7
    # Face-learning thumbnail enhance — disabled. The /face-learning/
    # samples/<id>/snapshot endpoint stays gated on this flag and serves
    # the raw MinIO bytes when False.
    face_learning_auto_enhance: bool = False
    face_learning_auto_enhance_fidelity: float = 0.7
    # Per-frame deadline. If a frame pull stalls past this, the orchestrator
    # increments FRAMES_DROPPED{reason="rtsp_stall"} and reopens the stream.
    # Default is ~12× the 8-fps target frame period. Increase only if you have
    # cameras with known long GOP gaps; raising this masks bad cameras.
    pipeline_frame_timeout_sec: float = 1.5
    # RTSP hardware decode. Empty = CPU/software H.264 decode (PyAV default).
    # Set to "cuda" for NVDEC. PyAV 17's bundled FFmpeg ships hevc_cuvid/
    # h264_cuvid and the container has libnvcuvid, so this works as shipped —
    # but only through PyAV's HWAccel object (pipeline/ingest.py); the old
    # "hwaccel" demuxer *option* was silently ignored. Measured on 1080p HEVC:
    # 15.1 -> 9.6 ms CPU per frame; the remainder is the download + NV12->BGR
    # conversion, which the sub-stream (2.5 ms) removes far more effectively.
    rtsp_hwaccel: str = ""
    # Fall back to software decode when the hardware decoder cannot be opened
    # (no libnvcuvid, unsupported codec). False makes open() fail loud instead.
    rtsp_hwaccel_fallback: bool = True
    # Decoder threads per camera. FFmpeg's AUTO spawned 16 per stream
    # (measured av:hevc:df0..15); 2 keep a 1080p decode ahead of an 8 fps
    # consumer. Ignored by a hardware decoder, which gets 1.
    rtsp_decode_threads: int = 2
    # Drop-old-frames RTSP reader. When True, a dedicated thread keeps
    # decoding frames at line rate and writes them into a single "latest"
    # slot; orchestrator reads from the slot and gets the freshest frame
    # available. Without this, PyAV queues up old frames if the orchestrator
    # is slow, producing the classic "video keeps falling behind real time"
    # buffer-lag bug. Stock answer for RTSP + slow consumer; on by default.
    rtsp_drop_old_frames: bool = True
    # "pyav": decode in-process (PyAV threads; ~19 ms CPU per emitted frame and
    # GIL contention past ~10 cameras/process). "ffmpeg": one ffmpeg process per
    # camera does NVDEC decode, fps before download, BGR over a pipe
    # (pipeline/ingest_ffmpeg.py) — nothing decodes inside the interpreter.
    rtsp_ingest_backend: Literal["pyav", "ffmpeg"] = "pyav"
    ffmpeg_binary: str = "ffmpeg"
    ffmpeg_sw_threads: int = 2
    # Decoder groups (pipeline/ingest_ffmpeg_group.py): with the ffmpeg backend,
    # cameras that open within `ffmpeg_group_window_sec` of each other share one
    # ffmpeg process and ONE CUDA context, up to `ffmpeg_group_size` per process.
    # 1 = one process per camera (pipeline/ingest_ffmpeg.py).
    ffmpeg_group_size: int = 4
    ffmpeg_group_window_sec: float = 0.75
    rtsp_timeout_sec: int = 10
    # Tighter max_delay for the PyAV demuxer. Lower = less buffer lag.
    # 1s is enough to ride out brief reorder windows but small enough that
    # accumulated lag is bounded. Pairs with rtsp_drop_old_frames.
    rtsp_max_delay_sec: float = 1.0
    pipeline_rtsp_reopen_backoff_sec: float = 2.0
    pipeline_rtsp_reopen_max_backoff_sec: float = 30.0
    # API startup reconciliation is useful in a dedicated production worker,
    # but the legacy AiFeed compatibility path is interactive. Restarting every
    # previously-online camera on boot can overload one GPU during local testing.
    restart_online_streams_on_startup: bool = False
    # ── Camera sharding across processes (services/sharding.py) ────────────
    # A camera belongs to shard `id.int % AI_SHARD_COUNT`. Shard 0 is the
    # primary (singletons + the address the backend calls); start/stop for a
    # camera another shard owns is forwarded to it. Peers are indexed by
    # shard: "http://smart-cam-ai:8001,http://smart-cam-ai-1:8001".
    # Measured 2026-09-20: one process saturates at ~100 frames/s of
    # pipeline work (~12 cameras at 8 fps) with the GPU at 12%.
    ai_shard_index: int = 0
    ai_shard_count: int = 1
    ai_shard_peers: str = ""
    # False: shard 0 keeps the API + the process-wide singletons and owns no
    # cameras; cameras spread over shards 1..N-1. Measured 2026-09-21: the
    # primary's singletons plus 15 cameras gave a 27 ms event-loop lag while
    # a 7-camera shard sat at 2 ms.
    ai_shard_primary_owns_cameras: bool = True
    # "hash" = camera.id % shards; "balanced" = sticky least-loaded map in
    # Redis (services/sharding.py). Hashing put 43 cameras at 15/7/8/13.
    ai_shard_assignment: str = "balanced"
    # ── Inference service (workers/infer_server.py, infra/infer_client.py) ──
    # Empty = inference in-process (today). Set to tcp://host:port and every
    # orchestrator in this process sends detect/embed over one multiplexed
    # connection to the service, which batches across all cameras of all
    # workers on one set of TensorRT sessions. Role "server" marks the
    # service process itself so it builds local models regardless.
    infer_service_url: str = ""
    infer_service_role: str = ""
    infer_service_port: int = 9010
    infer_service_metrics_port: int = 9011
    infer_service_timeout_sec: float = 3.0
    infer_service_retry_sec: float = 5.0
    infer_service_fallback_after_sec: float = 30.0
    # Sync callers (API routes, enrollment) block a thread anyway; give them
    # room for a cold engine instead of the pipeline's tight per-frame budget.
    infer_service_sync_timeout_sec: float = 30.0
    # CPython hands the GIL over every 5 ms by default; with ~20 decode threads
    # per worker the event loop can wait several slices per wake-up. > 0 sets
    # sys.setswitchinterval at startup (measured, see FACE_SYSTEM_DESIGN.md).
    python_switch_interval: float = 0.0
    infer_client_embed_window_ms: float = 2.0
    infer_client_embed_max: int = 32

    @property
    def infer_remote(self) -> bool:
        return bool(self.infer_service_url) and self.infer_service_role != "server"
    # Detection state pub/sub backend. "local" keeps the in-process cache only
    # (works when API + orchestrators are co-located in one process); "redis"
    # publishes per-frame state through Redis so multi-process deployments
    # share the live overlay (the documented Phase 1 deployment).
    cache_backend: Literal["local", "redis"] = "redis"

    # --- Backend live-overlay bridge (EventDispatcher) ---
    # vms_face detects internally and publishes per-frame boxes to Redis, but
    # the main VMS backend's live overlay (AIOverlay.jsx) only draws boxes it
    # receives on the socket.io `ai.event` channel — which the backend emits
    # ONLY when the AI POSTs detections to /api/internal/ai/events. Without this
    # forwarder, detection works but no box ever reaches the player. The
    # forwarder PSUBSCRIBEs to the cam-state channel and POSTs throttled,
    # per-track detections to the backend, mapping camera_code -> monitorId.
    backend_forward_enabled: bool = True
    backend_url: str = ""            # e.g. http://smart-cam-backend:5000 (env BACKEND_URL)
    service_token: str = ""          # X-Service-Token for /api/internal/* (env SERVICE_TOKEN)
    # Live overlay is EPHEMERAL: the forwarder POSTs one whole-frame message per
    # camera to /api/internal/ai/overlay, which the backend fans out on the
    # 'ai.live' socket and drops. Nothing is persisted and nothing becomes an
    # alert — this is deliberately NOT the ai_events path (that flooded the
    # alerts panel). Rate is per-camera; ~5/s keeps boxes smooth on moving faces.
    backend_overlay_min_interval_sec: float = 0.2
    # Overlay publish cadence at the SOURCE (orchestrator -> Redis). With
    # tracks: at most this often (the forwarder and the browser's motion
    # prediction are built for 5 Hz). Empty scene: a heartbeat only, so the
    # UI's 1.2 s stale timer keeps the (empty) overlay alive; the transition
    # to empty always publishes immediately.
    overlay_publish_min_interval_sec: float = 0.2
    overlay_idle_heartbeat_sec: float = 1.0
    # Viewer gating (services/overlay_viewers.py). A camera nobody is watching
    # publishes its boxes at overlay_unwatched_interval_sec (a keep-alive for
    # people-counts and the admin monitor) and gets no overlay POST at all;
    # a watched camera runs at overlay_publish_min_interval_sec. The watched
    # set comes from the backend (browsers announce ai.watch) via the forwarder
    # into Redis. Fail-open when the feed is absent.
    overlay_viewer_gating: bool = True
    # Compact overlay frames (Phase 2.6): boxes as positional rows
    # [trackId, x1, y1, x2, y2, conf%, name, gender, state] with integer pixels
    # instead of one object per box. Same information, ~3x fewer bytes. The
    # player accepts both shapes.
    overlay_compact_frames: bool = True
    overlay_unwatched_interval_sec: float = 1.0
    overlay_viewers_poll_sec: float = 2.0
    overlay_viewers_key: str = "vms:overlay:viewers"
    overlay_viewers_ttl_sec: int = 10
    # The overlay NEVER shows age (unreliable on CCTV crops) and only shows
    # gender when the track vote is STRONGLY agreed — higher than the AI's own
    # assertion floor (attributes_min_agreement=0.70), because a wrong M/F on a
    # live face reads worse than none. Below this, the box shows just "Face".
    backend_overlay_min_gender_conf: float = 0.85
    # How often to refresh the monitorId->userId map from /api/internal/cameras.
    backend_forward_camera_refresh_sec: float = 30.0
    # Safety cap: don't forward more than this many boxes from a single frame
    # (a crowd scene shouldn't burst the backend).
    backend_forward_max_boxes_per_frame: int = 20
    # Persisted-alert bridge (SEPARATE from the ephemeral overlay above): forwards
    # blacklist/watchlist hits + unknown-person events from the `vms.alerts` stream
    # to /api/internal/ai/events, which become in-app alerts + phone pushes. A
    # per-(user,camera,kind,subject) cooldown keeps a person in view from creating
    # one ai_events row per frame — the same anti-flood rule as the overlay split.
    backend_alert_forward_enabled: bool = True
    backend_alert_cooldown_sec: float = 120.0

    # --- Match worker ---
    match_worker_concurrency: int = 32
    match_worker_autoclaim_min_idle_ms: int = 60_000
    match_worker_autoclaim_interval_sec: float = 15.0
    match_worker_appearance_log: bool = True

    # --- Supervised face learning ---
    # High-quality CCTV crops from confirmed matches are stored as pending
    # samples. Operators can approve them into the enrolled gallery, giving
    # each person multiple real-camera embeddings without retraining the model.
    face_learning_enabled: bool = True
    face_learning_min_similarity: float = 0.68
    face_learning_min_quality: float = 0.60
    face_learning_min_face_px: int = 96
    face_learning_min_blur_var: float = 45.0
    face_learning_max_samples_per_track: int = 6
    face_learning_max_pending_per_person: int = 100
    face_learning_duplicate_similarity: float = 0.985

    # --- Retention (DPDP) ---
    retention_worker_enabled: bool = True
    retention_worker_interval_sec: float = 3600.0
    retention_event_days: int = 90
    retention_snapshot_days: int = 7
    retention_audit_log_days: int = 365

    # --- System metrics poller ---
    system_metrics_enabled: bool = True
    system_metrics_interval_sec: float = 5.0

    # --- Cross-camera ReID worker (Phase 2) ---
    reid_worker_enabled: bool = True
    # Consumer group used by ReID workers — separate from match-workers so
    # they don't share work, only the underlying detections stream.
    reid_consumer_group: str = "reid-workers"
    # Window in which a face seen on camera B can be linked to a prior
    # appearance on camera A. Outside this window, embeddings drift enough
    # (and the operational meaning of "same person seen twice" weakens) that
    # we don't auto-link.
    reid_window_sec: int = 600
    # Cosine similarity floor for emitting a track_link.
    reid_min_similarity: float = 0.55
    # Top-K appearance hits inspected per candidate.
    reid_top_k: int = 10
    # Don't link two appearances on the same camera within this many seconds —
    # those are intra-camera tracks that should already be merged by the
    # local Kalman tracker. (Cross-camera linking is the goal.)
    reid_same_camera_dedup_sec: int = 30

    # --- TimescaleDB hypertable on detection_events (gated on extension) ---
    timescaledb_enabled: bool = True

    # --- API ---
    api_host: str = "0.0.0.0"
    api_port: int = 8001          # frontend AiFeed.jsx hardcodes localhost:8001
    api_cors_origins: str = "*"

    # --- Auth (JWT HS256) ---
    # `vms_jwt_secret` MUST be set in stage/prod. In dev a missing secret falls
    # back to `vms_jwt_dev_bypass=True` semantics if the operator opted in;
    # otherwise startup fails loudly. Secret length must be >= 32 chars.
    vms_jwt_secret: str = ""
    vms_jwt_algorithm: str = "HS256"
    vms_jwt_issuer: str = "drisyam-vms"
    vms_jwt_audience: str = "drisyam-vms"
    vms_jwt_leeway_sec: int = 30
    # When True (and only when VMS_ENV=dev), unauthenticated requests are
    # treated as the default tenant's "anonymous" principal. NEVER enable in
    # production — every route becomes open. Default off, even in dev.
    vms_jwt_dev_bypass: bool = False
    # Shared API key for the legacy /set-camera, /upload, /logs, /status, /ws
    # endpoints used by AiFeed.jsx. The frontend doesn't issue JWTs; this lets
    # us lock the legacy router behind a single shared secret without the rest
    # of the API being open. Empty disables the legacy router entirely.
    legacy_api_key: str = ""

    # --- Camera credential encryption (rtsp_url at rest) ---
    # AES-256-GCM with a 32-byte key, base64-encoded. When unset, rtsp_url is
    # stored plaintext (legacy behavior). When set, new writes are encrypted
    # and the type decoder transparently decrypts on read. Existing plaintext
    # rows continue to read fine — they're identified by a missing prefix tag.
    vms_camera_cred_key: str = ""

    # --- OpenTelemetry distributed tracing (PR #18) ---
    # Off by default (no-op tracer, zero overhead). When enabled, FastAPI /
    # SQLAlchemy / Redis are auto-instrumented; the orchestrator injects
    # trace context into FaceCandidate.extra._trace so the match-worker can
    # link its spans to the originating frame. trace_id is also bound into
    # structlog so logs and spans correlate.
    vms_otel_enabled: bool = False
    vms_otel_endpoint: str = ""              # e.g. http://otel-collector:4317
    vms_otel_service_name: str = "vms_face"
    vms_otel_sample_ratio: float = 1.0       # 0.0–1.0; 1.0 = trace every span

    # --- Legacy compat layer (drives smart-cam-app/AiFeed.jsx) ---
    # When the frontend posts /set-camera with a monitor_id we don't recognize,
    # we auto-create a Camera row in the default tenant using this RTSP template.
    mediamtx_rtsp_host: str = "localhost"
    mediamtx_rtsp_port: int = 8554
    mediamtx_rtsp_template: str = "rtsp://{host}:{port}/cam_{monitor_id}"
    default_tenant_name: str = "drisyam-default"
    legacy_single_active_camera: bool = True

    @field_validator("insightface_providers")
    @classmethod
    def _split_providers_ok(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("insightface_providers cannot be empty")
        return v

    def assert_consistent(self) -> None:
        """Cross-field validation that pydantic field validators can't easily
        express. Called from process startup so misconfigurations fail loud
        at boot rather than mid-frame."""
        # Batched detect bypasses FaceAnalysis.get(), which means
        # FaceObservation.embedding always comes back None. The
        # `insightface_arc` recognizer relies on that bundled embedding —
        # this combination would silently produce zero matches.
        if self.pipeline_batched_inference:
            backend = self.recognizer_backend.strip().lower()
            if backend in ("insightface", "insightface_arc", "arcface", "buffalo"):
                raise ValueError(
                    "PIPELINE_BATCHED_INFERENCE=true is incompatible with "
                    f"RECOGNIZER_BACKEND={self.recognizer_backend!r}. The batched "
                    "detect path doesn't run buffalo_l's bundled ArcFace head; "
                    "use RECOGNIZER_BACKEND=adaface (or another standalone recognizer)."
                )

    @property
    def providers_list(self) -> list[str]:
        return [p.strip() for p in self.insightface_providers.split(",") if p.strip()]

    def effective_recognizer_threshold(self, recognizer_name: str | None = None) -> float:
        """Return the cosine threshold appropriate for the active recognizer.

        ArcFace cosines on buffalo_l sit around 0.55-0.70 for a same-identity pair;
        AdaFace ir101_webface12m sits around 0.30-0.45. Calling FaceMatcher with
        a single configured threshold guarantees one of the two backends is wrong.
        """
        name = (recognizer_name or self.recognizer_backend).strip().lower()
        if name == "adaface":
            return self.recognizer_adaface_threshold
        return self.insightface_rec_threshold

    @property
    def cors_origins_list(self) -> list[str]:
        if self.api_cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.api_cors_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def _get_settings() -> Settings:
    return Settings()


settings = _get_settings()
