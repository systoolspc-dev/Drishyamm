# smart-cam-ai — Architecture

The AI service is two processes (`smart-cam-ai` API + `smart-cam-ai-worker` match worker) coordinated through Redis, sharing Postgres + Qdrant + MinIO. Everything below explains the *why*, not just the *what*.

## The 30-second view

```
                            ┌──────────────────────────────────────┐
                            │     smart-cam-ai (API process)       │
                            │                                       │
  RTSP from MediaMTX  ──→   │  StreamOrchestrator (per camera)     │
                            │   ├─ RTSPIngest (drop-old reader)    │
                            │   ├─ SCRFD detect → IOU tracker      │
                            │   ├─ FaceQualityGate (blur/pose)     │
                            │   ├─ Top-K embedding pool            │
                            │   └─ Publish FaceCandidate           │ ──→  Redis Stream: vms.detections
                            │                                       │
                            │  /api/* + /footfall/* + /ws (FastAPI)│
                            │  LatestDetectionCache (live overlay) │ ←──  alerts subscriber
                            └──────────────────────────────────────┘
                                                                              ↑
                                                                              │
                            ┌──────────────────────────────────────┐         │
                            │   smart-cam-ai-worker (match daemon) │         │
                            │                                       │         │
                            │  XREADGROUP vms.detections           │         │
                            │   ├─ Qdrant ANN search (vms_enrolled)│         │
                            │   ├─ DetectionEvent.create (Postgres)│         │
                            │   ├─ Publish alert ──────────────────┼────────→ Redis Stream: vms.alerts
                            │   └─ Snapshot upload pump → MinIO    │
                            └──────────────────────────────────────┘
```

## The orchestrator's per-frame loop

[pipeline/orchestrator.py](../vms_face/pipeline/orchestrator.py) is THE file. One `StreamOrchestrator` per camera, running as an asyncio task inside the API process. Each frame:

1. **Ingest** — `RTSPIngest.read_frame()` returns the most recent frame from a drop-old reader thread. The thread continuously decodes from PyAV; the orchestrator pulls whatever's latest. If the thread can't keep up, frames are dropped (we count them in `_latest_dropped_count`). This pattern is from [StackOverflow #60816436](https://stackoverflow.com/q/60816436) and is the only sane way to keep RTSP from buffering 5 s behind.

2. **Detect** — SCRFD via `FaceRuntime.detect_async` (or `BatchedSCRFD` if `PIPELINE_BATCHED_INFERENCE=true`). Returns `FaceObservation`s with bbox + det_score + landmarks.

3. **Track** — `IOUTracker.step(observations)` returns `TrackedFace` per active track. The tracker is a SORT-style Kalman + Hungarian + DeepSORT appearance term implementation. Tracks survive `tracker_max_age` frames of misses, which is how someone walking past a doorway doesn't fragment into 5 separate tracks.

4. **Person count (optional)** — if `PIPELINE_PERSON_DETECTION_ENABLED=true`, runs YOLOv8 every `PIPELINE_PERSON_DETECT_EVERY_N_FRAMES` frames. Result is just `_last_person_count` for the UI badge.

5. **Footfall (optional)** — if the camera has `footfall.enabled=true` in `config_json`, feed person bboxes (or face tracker bboxes as fallback) to the `FootfallRegistry`. See [FEATURES.md#footfall](FEATURES.md#footfall).

6. **Overlay publish** — `_publisher.write_frame(...)` pushes the boxes to the cache. The cache fans out to:
    - HTTP poll `GET /api/detections/<monitor_id>` (1 s cadence, used by AI Feed)
    - WebSocket `/ws` (live event push)

7. **Snapshot cache** — every processed frame, `SnapshotCache.maybe_write(frame.bgr)` (throttled to 4 fps) keeps the latest JPEG ready for the MJPEG endpoint.

8. **Per-face fan-out** — for each `TrackedFace`, run quality gate → embed → pool top-K → publish `FaceCandidate` to `vms.detections` once the track has `track_min_hits_to_match` observations.

### Why all this complexity for "find a face"

- Pure per-frame match has p95 confidence variance ~0.15 — a single bad frame produces a false hit. Top-K pool of high-quality observations + `min_hits` cuts that.
- The tracker is the thing that gives a face a *stable identity* across frames; without it, the operator sees a flicker of "Unknown → Aastha → Unknown" on every blink.
- Snapshot upload via a bounded queue rather than `asyncio.create_task` is the difference between graceful degradation when MinIO has a hiccup and OOM-ing the orchestrator.

## The match worker

[workers/match_worker.py](../vms_face/workers/match_worker.py). Stateless, horizontally scalable. Lifecycle:

1. **XREADGROUP** on `vms.detections` with consumer group `match-workers`. Multiple replicas split the stream.
2. **Quality re-check** — `_candidate_matchable()` enforces `match_min_quality / face_px / blur_var`. A candidate the orchestrator already filtered passes this trivially; we re-check here because settings drift between API + worker is possible.
3. **Qdrant search** — `FaceMatcher.find_best_match(embedding)` against `vms_enrolled`. Returns `MatchResult{person_id, similarity, kind}` where kind is `match | alert | unknown`.
4. **Postgres insert** — `DetectionEvent` row in a single transaction.
5. **Appearance log** — if `qdrant_appearance_enabled`, append the embedding to `vms_appearance` for forensic search.
6. **Publish alert** — JSON onto `vms.alerts` (Redis Pub/Sub via `bus.publish_alert`). Subscribers:
    - `infra/alerts_subscriber.py` (in the API process) — patches the live overlay so the bbox flips green with the name.
    - The WS endpoint `/ws` — fans out to connected operators.
7. **ACK** — `XACK vms.detections`. If we threw, we DON'T ack — the entry stays pending, and `XAUTOCLAIM` (interval-driven loop) reclaims it to a sibling worker after `match_worker_autoclaim_min_idle_ms`.

### DLQ

Unhandled exceptions go to `vms.detections.dlq` via `bus.publish_dlq`. Inspect with `XRANGE vms.detections.dlq - +` — useful when a malformed candidate keeps poison-pilling the worker.

## Data stores

| Store | What's in it | Why this one |
|---|---|---|
| **Postgres** (`vms_face` schema) | tenants, persons, cameras, detection_events, face_enrollments, face_learning_samples, footfall_minute_buckets, audit_log, track_links | Relational integrity for the operator-facing data |
| **Qdrant** | `vms_enrolled` (the gallery, 1 vector per face), `vms_appearance` (every sighting, for forensic 1-of-N) | Sub-50ms ANN at 100k+ vectors |
| **MinIO** | face snapshots (S3 keys like `ai/events/<userId>/<monitorId>/<ts>.jpg`), enrollment thumbnails | Cheap blob storage; backend serves presigned URLs |
| **Redis** | streams (`vms.detections`, `vms.alerts`), pub/sub (`vms.cam_state`), counters | Cross-process bus + visibility |

## Settings → behavior map

Five knobs cover 80% of tuning:

| Setting | Loosen if… | Tighten if… |
|---|---|---|
| `INSIGHTFACE_DET_THRESHOLD` | missing faces on far cams | phantom tracks accumulating |
| `MATCH_MIN_FACE_PX` | enrolled people not matching | strangers matching after a glance |
| `MATCH_MIN_QUALITY` | matches lost in low light | false-positive matches |
| `INSIGHTFACE_REC_THRESHOLD` | similar-looking enrolled people swapping IDs | low-confidence look-alike matches |
| `TRACK_MIN_HITS_TO_MATCH` | first-match latency too high | flicker matches |

## Tracing + metrics

OpenTelemetry instrumentation is wired in `core/tracing.py`. When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, FastAPI + Redis + SQLAlchemy automatically emit spans. The orchestrator opens its own spans (`orchestrator.detect`, `match_worker.process`) carrying camera id + frame seq so you can trace a face from RTSP packet → MinIO key.

Prometheus is exposed at `:8001/metrics`. Useful counters:

```
detections_total{camera_id="..."}              SCRFD observations
tracks_opened_total{camera_id="..."}           new track births
match_worker_processed_total{outcome="..."}    ok | dlq | error
queue_depth{stream="..."}                      Redis stream lag
camera_fps{camera_id="..."}                    EWMA fps
camera_people_count{camera_id, kind}           live + smoothed counts
snapshot_queue_dropped_total                   evidence dropped on overflow
```

## Hard rules (gathered in pain)

- **No `--reload` on uvicorn.** A crash inside the supervisor's child becomes a hang.
- **No blocking I/O on the asyncio loop.** Anything compute-bound or socket-blocking → `loop.run_in_executor(get_io_pool() | get_gpu_pool())`.
- **Never trust upstream face crops.** The quality gate fires before embed regardless of source.
- **Snapshot upload is best-effort.** Drop the oldest, increment a counter, never block ingest.
- **JWT secret is a real secret in prod.** `VMS_JWT_DEV_BYPASS` is for `VMS_ENV=dev` only.
