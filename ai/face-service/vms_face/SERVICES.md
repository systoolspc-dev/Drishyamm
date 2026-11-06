# vms_face — Services Reference

One file, every component in the stack. For each service: what it is, what
job it does in this VMS, why it was chosen (with the honest trade-offs), and
operational notes. The flow at the top shows how a single face moves through
the system; everything below explains the boxes.

---

## End-to-end flow

```
   ┌───────────────┐       RTSP       ┌────────────┐       RTSP       ┌──────────────────────┐
   │  Camera fleet │ ───────────────► │  MediaMTX  │ ───────────────► │  Per-camera ingest   │
   │ (RTSP / ONVIF)│                  │  (gateway) │                  │ (PyAV decode loop)   │
   └───────────────┘                  └────────────┘                  └──────────┬───────────┘
                                                                                 │ BGR frame
                                                                                 ▼
                                                                  ┌──────────────────────────┐
                                                                  │  StreamOrchestrator       │
                                                                  │   detect → quality →     │
                                                                  │   track → embed → pool    │
                                                                  └──────────┬───────────────┘
                                                                             │ FaceCandidate
                                            (overlay state)                  │  + pooled emb
                                            ┌─────────────────┐              ▼
                                            │  Redis Pub/Sub  │     ┌─────────────────┐
                                            │  vms.cam.state  │ ◄── │  Redis Streams  │
                                            └────┬────────────┘     │ vms.detections  │
                                                 │                  └────────┬────────┘
                                                 ▼                           ▼
                                          ┌────────────┐       ┌────────────────────────┐
                                          │ FastAPI WS │       │   Match worker(s)      │
                                          │ /ws/alerts │ ◄──── │  Qdrant ANN → DB write │
                                          └────────────┘       │  → audit → alert       │
                                                ▲              └────────┬───────────────┘
                                                │                       │
                                                │  vms.alerts           │
                                                └─── Redis Streams ◄────┘
                                                                        │
                                                  Postgres / TimescaleDB ▼
                                                  Qdrant enrolled gallery
                                                  Qdrant appearance log
                                                  MinIO snapshot bucket
                                                  MinIO enrollment bucket
```

The orchestrator process can be the API process (single-node dev) or its own
process (production). The match-worker, reid-worker, retention-worker run as
separate processes always.

---

## App services (we wrote these)

### `api` — FastAPI gateway
- **What it is.** A FastAPI app served by uvicorn. Surfaces REST + WebSocket.
- **Job.** Identity/authn at the door (JWT HS256, tenant id from claim),
  tenant-scoped CRUD on persons / cameras / detection events / appearance
  search / journey reconstruction / face-learning queue. Fans out alerts on
  WebSocket. Hosts the legacy `AiFeed.jsx` compat router behind a separate
  `X-API-Key`.
- **Why this shape.** FastAPI gives async-native I/O and Pydantic validation
  for free; uvicorn is the fastest ASGI server we trust. We deliberately use
  a single in-process worker (no `--workers N`) — the FaceRuntime (ONNX
  Runtime CUDA EP) cannot be safely shared across forked workers. Horizontal
  scale is via container replicas behind a load balancer, not in-process.
- **How good is our use.** Solid for ≤ a few hundred cameras per node. The
  weak spots: every protected route fails closed when JWT isn't configured
  (good); the legacy router is only as strong as the shared key (acceptable
  bridge to a JWT-issuing front-end); WS reconnects today don't replay the
  last few seconds of overlay state (improvement opportunity).

### `match-worker` — Redis Streams consumer
- **What it is.** A long-running Python process subscribed to
  `vms.detections` via a consumer group (`match-workers`).
- **Job.** For each `FaceCandidate`: 1:N search against the enrolled Qdrant
  gallery, assemble a `DetectionEvent` row in Postgres, write a DPDP audit
  log entry, push to the appearance Qdrant collection (forensic log),
  publish an alert on `vms.alerts` for the WebSocket fanout, and enqueue
  high-quality crops onto the supervised face-learning review queue.
- **Why this shape.** A consumer group means N parallel workers split work
  across processes; Redis handles the partition. Per-task concurrency
  inside one worker is bounded by `MATCH_WORKER_CONCURRENCY` (default 32) so
  a single slow Qdrant call can't starve a process. Failures route to a DLQ
  (`vms.detections.dlq`) and `XAUTOCLAIM` reaps stuck messages from dead
  workers — no message lost silently.
- **How good is our use.** This is the most production-grade file in the
  repo. Open issues: shipping the 512-D embedding inline in every Redis
  message is bandwidth-wasteful at 2k cameras (≈10 MB/s); we should write to
  Qdrant first and ship a `point_id` (PR #15, deferred). Also: we audit every
  hit, which can hammer the audit table for popular identities — sample at
  scale.

### `reid-worker` — cross-camera re-identification
- **What it is.** Second consumer of `vms.detections`, joined to its own
  group (`reid-workers`) so it sees every candidate without competing with
  match workers.
- **Job.** Look for embeddings that match a recent appearance on a *different*
  camera within `REID_WINDOW_SEC`. When the cosine similarity exceeds
  `REID_MIN_SIMILARITY`, emit a `track_links` row (a, b) connecting the
  older sighting to the newer one. The journey/UI builds a global identity
  by transitively traversing these edges.
- **Why this shape.** Cross-camera ReID is a separable concern from 1:N
  matching against the gallery. A person who isn't in the gallery still
  generates `track_link` rows and a useful journey across cameras.
- **How good is our use.** Adequate for the campus scale (2k cameras). At
  Phase 4 we'd swap face-only ReID for face+body fusion (clothing,
  silhouette) to handle cases where the face never appears.

### `retention-worker` — DPDP retention enforcement
- **What it is.** Hourly background loop.
- **Job.** Hard-delete `detection_events` older than
  `RETENTION_EVENT_DAYS`, MinIO snapshots older than
  `RETENTION_SNAPSHOT_DAYS`, audit log rows older than
  `RETENTION_AUDIT_LOG_DAYS`, and prune Qdrant appearance points by
  `occurred_at_ts < cutoff`.
- **Why this shape.** India DPDP Act 2023 classifies face embeddings as
  Sensitive Personal Data and requires hard-delete with provable retention.
  TimescaleDB's chunk-level retention policy on `detection_events` makes the
  Postgres side cheap; the Qdrant side now reports actual deletion counts
  (PR #20).
- **How good is our use.** Compliant in shape. Two real risks: (a) MinIO
  list-objects pagination is non-trivial at hundreds of thousands of
  objects; (b) the retention policy is global per-tenant — if you need
  per-purpose retention (e.g. shorter for visitors, longer for incidents),
  that's a follow-up.

### `pipeline.orchestrator` — per-camera processing loop
- **What it is.** One asyncio task per camera: ingest → SCRFD detect →
  quality gate → SORT-style tracker (Kalman + Hungarian + appearance) →
  AdaFace/ArcFace embed → top-K quality-weighted pool → publish.
- **Why this shape.** Per-camera tasks isolate one bad RTSP feed from the
  rest. The top-K embedding pool is the single biggest accuracy win
  available without swapping recognizers — it averages the best K crops
  per track, then matches against the pooled embedding (eliminates most
  single-frame noise).
- **How good is our use.** Strong. After PRs #5 and #9, per-frame fan-out
  is parallel and bounded; track-local embed cadence keeps the GPU warm.
  After PR #14 the AdaFace embed step coalesces in-flight requests across
  cameras (feature-flagged). Remaining lever: SCRFD batched detection,
  which requires dropping `FaceAnalysis`'s per-image preprocess wrapper.

### `services.snapshot_pump` — bounded MinIO uploader
- **What it is.** A per-camera `asyncio.Queue` + N consumer tasks fronting
  `ObjectStore.put_bytes`.
- **Job.** Take padded JPEG-encoded face crops from the orchestrator and
  upload to MinIO under a deterministic key. Drops the oldest queued item
  on overflow (freshness > completeness for live evidence) and counts the
  drop.
- **Why this shape.** Replaces an unbounded `asyncio.create_task` chain
  that piled up if MinIO got slow. With this, a slow MinIO degrades to
  "we drop some snapshots" instead of "we run out of memory".

### `infra.batcher` + `infra.batched_scrfd` — async micro-batching
- **What it is.** A generic `AsyncBatcher[T_in, T_out]` plus a
  `BatchedSCRFD` wrapper that bypasses `FaceAnalysis.get()`'s per-image
  preprocessing to dispatch `(B, 3, H, W)` blobs straight at the SCRFD
  ONNX session.
- **Job.** Coalesce in-flight detect / embed calls across cameras so the
  GPU sees one big tensor instead of many small ones. AdaFace embedding
  stacks aligned 112×112 BGR crops; SCRFD detect letterboxes each frame
  to the runtime's `det_size` and runs one batched session call, then
  decodes per-frame and applies per-image NMS.
- **Why this shape.** The SCRFD wrapper reuses the already-loaded model's
  state (input size, mean/std, anchor centers cache, FPN strides,
  threshold) so the batched and per-image paths produce numerically
  identical detections at the same det_size. `AsyncBatcher` falls back to
  per-image when `BatchedSCRFD` can't be constructed (e.g. an insightface
  upgrade renames an attribute), so a model update can't take the whole
  pipeline down.
- **Trade-off.** The batched detect path **does not** run buffalo_l's
  bundled ArcFace head (it stops at SCRFD), so `RECOGNIZER_BACKEND=insightface`
  is incompatible with `PIPELINE_BATCHED_INFERENCE=true`. Use AdaFace
  (recommended for surveillance anyway) or another standalone recognizer.
  Settings validation fails the deploy at boot if both flags disagree.

---

## Storage layer (we operate these but didn't write them)

### `postgres` — relational state
- **What it is.** Postgres 16 (with TimescaleDB extension when enabled).
- **Job.** Authoritative store for tenants, persons, cameras, enrollments,
  detection events, audit log, track links, face-learning samples.
  Detection events become a TimescaleDB hypertable when the extension is
  installed — chunks are time-partitioned per day, compressed after 7
  days, and retention-pruned at the chunk level (cheap).
- **Why this shape.** A standard relational DB for the small/identity-shaped
  data; TimescaleDB for the time-series shape of `detection_events` so
  retention and aggregations don't degrade on a 1B-row table.
- **How good is our use.** Schema is clean (4 alembic migrations, no
  drift); FK cascades cover Tenant → Person → FaceEnrollment. Open items:
  `face_learning_samples` and `track_links` are missing a tenant FK
  (orphan rows when a tenant is deleted — PR #14 in our list); the
  connection pool sizing (20 + 10 overflow per process) won't survive
  many worker replicas without PgBouncer in transaction mode.

### `qdrant` — vector ANN store
- **What it is.** Qdrant 1.12 — a Rust-native ANN database with payload
  filters, cosine/dot/euclid distance, and on-disk persistence.
- **Job.** Two collections:
  - `vms_enrolled` — small, hot, replicated. The 1:N target for live
    matching. ~1k–1M points.
  - `vms_appearance` — append-only forensic log. One point per detection
    event with `occurred_at_ts` indexed for time-range filters. Up to
    billions of points at 2k-camera scale.
- **Why this shape.** Splitting enrolled vs. appearance is architecturally
  necessary above ~1M points — they have different read patterns, replica
  needs, and retention. Qdrant is the right pick up to ~50M points; above
  that we'd switch to Milvus 2.4 with GPU-CAGRA. Schema validation runs at
  startup (PR #20) so a wrong vector size or distance fails loudly.
- **How good is our use.** Sound. We're on HTTP — gRPC would be faster for
  the appearance write path at full scale (one upsert per detection adds
  up). Per-collection payload indices on `tenant_id`, `person_id`,
  `camera_id`, `role`, `occurred_at_ts` are all created on first run.

### `redis` — bus + cache
- **What it is.** Redis 7 with AOF persistence.
- **Job.** Three roles in the system:
  1. **Streams** for the work queues: `vms.detections` (pipeline →
     workers), `vms.alerts` (workers → API/WS), `vms.detections.dlq`.
  2. **Pub/Sub** for the per-camera live overlay (`vms.cam.state:<id>`)
     so multi-process deployments share the live view.
  3. **SETEX'd keys** so a late WS subscriber can pick up the latest cam
     state without waiting for the next frame.
- **Why this shape.** Redis Streams give us at-least-once delivery,
  consumer groups, and `XAUTOCLAIM` for dead-worker recovery — everything
  needed to ship before paying for Kafka. Pub/Sub for the live overlay is
  fine because that data is fire-and-forget by nature.
- **How good is our use.** Fits the campus scale. Above 5k cameras we'd
  swap Streams for Kafka (better partitioning, longer retention). The
  embedding-in-payload bandwidth concern noted under match-worker applies
  here too.

### `minio` — S3-compatible object store
- **What it is.** MinIO single-node deployment, S3 API on port 9000.
- **Job.** Two buckets: `vms-snapshots` (face crops, retention 7 days) and
  `vms-enrollments` (gallery enrollment images, retention indefinite).
- **Why this shape.** S3 semantics are the right abstraction for snapshot
  storage; MinIO lets us run on-prem without an AWS dependency. Production
  swaps the implementation to S3 / GCS / Azure Blob with no code change —
  the `ObjectStore` wrapper hides the SDK.
- **How good is our use.** Adequate. Single-node MinIO doesn't survive a
  disk loss; in production we'd run it as a 4-node distributed deployment
  or just point at S3. Snapshot keys are `{tenant}/{camera}/{track}/{ts}_{hex}.jpg`
  so list-by-prefix queries (e.g. retention) stay tractable.

### `mediamtx` — RTSP ingress / re-streaming
- **What it is.** MediaMTX (formerly rtsp-simple-server). RTSP/RTMP/HLS
  gateway in Go.
- **Job.** Cameras publish RTSP → MediaMTX; the orchestrator subscribes
  to the MediaMTX URL. Decouples camera credentials/network from the
  inference layer; lets browsers consume HLS for previews.
- **Why this shape.** A concentration point that buffers brief network
  hiccups, hides camera credentials behind a single ingress, and lets us
  horizontally scale inference nodes without each one holding 2k camera
  TCP connections.
- **How good is our use.** Configured by the README, included in the
  GPU compose (PR #13). For very large fleets you'd run regional
  MediaMTX clusters and shard cameras across them.

---

## Inference layer (we didn't write these models)

### `insightface` (SCRFD-10G, optional ArcFace via buffalo_l)
- **What it is.** The InsightFace `buffalo_l` model bundle: SCRFD-10G
  detector + 5-point landmark + ArcFace R50/W600K recognizer + age/gender
  heads.
- **Job.** Detect faces, return 5-point landmarks for alignment, optionally
  produce ArcFace embeddings (when `RECOGNIZER_BACKEND=insightface`).
- **Why this shape.** SCRFD-10G is the right primary detector — 83.05% on
  WIDER FACE Hard, well-supported, fast on CUDA. The bundled ArcFace head
  is fine for indoor / cooperative cameras.
- **How good is our use.** Strong on detection. We pin the detector input
  size per camera (`detection_input_size`); larger for parking-lot cameras
  with tiny distant faces, smaller for doorways. The CUDA fallback is now
  self-healing (PR #4) so a transient CUDA error doesn't permanently
  degrade a runtime.

### `adaface` (recommended recognizer)
- **What it is.** AdaFace IR-101 trained on WebFace12M. Operator provides
  the ONNX export.
- **Job.** Produce 512-D L2-normed embeddings on ArcFace-aligned 112x112
  BGR crops. Optional standalone recognizer; pairs with SCRFD detection.
- **Why this shape.** AdaFace's loss adaptively down-weights low-quality
  samples during training, making it the strongest open-source recognizer
  on TinyFace (Rank-1 = 72.29%). The right pick for surveillance, where
  faces are off-axis, motion-blurred, low-res.
- **How good is our use.** Correctly fed BGR (the model expects BGR;
  feeding RGB is a real bug we've had bitten by). Per-recognizer cosine
  threshold (PR #2) so switching backends doesn't silently destroy
  accuracy. AdaFace embedding now batches across in-flight requests
  (PR #14).

---

## Auxiliary

### `prometheus-client` — metrics
- Every component emits Prometheus metrics on `/metrics`. A Grafana
  dashboard (out of repo today) drives ops. Key metrics:
  `vms_camera_fps`, `vms_pipeline_frame_latency_seconds`,
  `vms_match_latency_seconds`, `vms_queue_depth`, `vms_dlq_depth`,
  `vms_runtime_degraded`, `vms_detector_pose_available`,
  `vms_snapshot_queue_drops_total`, `vms_batch_size`.

### `structlog` — logs
- Structured JSON logs to stdout. Container orchestrators handle
  collection. Fields are stable: `camera_code`, `camera_id`,
  `tenant_id`, `track_id`, `recognizer`, `err`. No PII (e.g. `full_name`)
  is logged at INFO level — only at DEBUG and only when explicitly added.

### `alembic` — schema migrations
- 4 migrations today (initial, audit log, track links + TimescaleDB,
  face learning samples). The `bootstrap` Docker init container runs
  `alembic upgrade head` before the API/workers start, so a fresh
  deployment is one `docker compose up`.

### `tini` — PID 1 in containers
- Reaps zombie children spawned by ffmpeg / PyAV inside the
  orchestrator. Without it, long-running containers eventually hit the
  process table limit on busy hosts.

---

## Things we deliberately don't run yet

- **DeepStream / Triton.** Phase 2. Reference target is SCRFD-TRT +
  AdaFace-TRT engines fed by `nvurisrcbin`, with `NvDCF` tracker. The
  `pipeline.deepstream_bridge` module is the seam — it publishes the
  same `FaceCandidate` Redis stream so the rest of the brain stays
  unchanged.
- **OpenTelemetry tracing.** Planned (PR #18). Today logs carry enough
  context for single-process debugging; at scale we want spans across
  ingest → bus → match worker → Qdrant.
- **PgBouncer.** Needed once we run >2 worker replicas; today the
  Postgres pool sizing is per-process (20 + 10 overflow).
- **GFPGAN / CodeFormer in the recognition path.** Not now, and not
  later — the research consensus (and our memo) says SR upstream of FR
  hallucinates identity-relevant pixels. SR is fine on the snapshot
  bucket asynchronously for human-review thumbnails.

---

## How good is the whole thing?

Honest answer: this is a strong **Phase 1**. With PRs #1–#16 landed (everything
described above except OTel), the system is:

- **Correct** for the documented use case at ~50–100 cameras per node.
  Authentication is real; tenant boundaries are enforced; CUDA failures
  self-heal; embeddings are pooled across frames; snapshots are bounded;
  retention is enforceable.
- **Right-shaped** for 2,000-camera scale: every bottleneck has a
  named fix (DeepStream / Triton, PgBouncer, gRPC to Qdrant, Kafka). The
  scaling story is "swap a service, don't rewrite the brain."
- **Not yet defense-grade.** That requires: liveness / anti-spoof at
  enrollment; head-pose / mask / occlusion classifiers in the quality
  gate; AdaFace fine-tuning on local CCTV captures with degradation
  augmentation; multi-modal fusion (face + body ReID + gait) for
  faces-never-seen cases. Roadmap items, not this PR.

SCRFD batched detection is now live behind `PIPELINE_BATCHED_INFERENCE`
(see [batched_scrfd.py](infra/batched_scrfd.py)). With it on, the dominant
remaining lever is dropping detection-side preprocessing onto the GPU
(NVDEC + CUDA-resident frames straight into the ONNX session) — that's
DeepStream territory and lives on the Phase 2 roadmap, not in-tree.
