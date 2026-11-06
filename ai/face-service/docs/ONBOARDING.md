# smart-cam-ai — Onboarding

You're reading this because you'll be writing code in the AI side of the drisyam VMS. This doc gets you productive on day one. Read it once start-to-finish; skim it again when you're stuck.

## What this service is

`smart-cam-ai` is the Python brain of the stack. It pulls RTSP from MediaMTX, runs face detection (SCRFD) + recognition (ArcFace / AdaFace) + person detection (YOLOv8) on GPU, tracks faces with Kalman + Hungarian + DeepSORT, persists to Postgres + Qdrant + MinIO, and emits events on Redis Streams that the Node backend forwards to operators.

Two processes live in this folder:

| Process | What it does | Container | Port |
|---|---|---|---|
| **API** (`vms_face.api.main:app`) | FastAPI: REST + WebSocket, owns the in-process StreamOrchestrator pool that runs the per-camera pipeline | `smart-cam-ai` | 8001 |
| **Match worker** (`vms_face.workers.match_worker`) | Consumes `vms.detections` (Redis Streams), runs Qdrant ANN, writes `DetectionEvent` rows, publishes `vms.alerts` for WS fan-out | `smart-cam-ai-worker` | (no port) |

The face-reconstruct service (CodeFormer + Real-ESRGAN) lives in `app/facerecounstruct/` as its own container on port 8002 — see [FEATURES.md](FEATURES.md#face-reconstruction).

## Repo layout

```
smart-cam-ai/
├── app/                                  ← all source lives here
│   ├── face_detection/vms_face/          ← the main VMS package (your primary work area)
│   │   ├── api/                          ← FastAPI app + routes
│   │   │   ├── main.py                   ← entrypoint, lifespan, router mounts
│   │   │   ├── deps.py                   ← DI helpers (current_tenant_id, db_session, …)
│   │   │   └── routes/                   ← one file per route group
│   │   │       ├── cameras.py, streams.py, events.py, learning.py,
│   │   │       ├── footfall.py, journey.py, personnel.py, persons.py,
│   │   │       ├── reid.py, search.py, tenants.py, ws.py, legacy.py
│   │   ├── pipeline/                     ← per-camera orchestrator
│   │   │   ├── orchestrator.py           ← THE central file — frame loop
│   │   │   ├── ingest.py                 ← PyAV RTSP reader with drop-old-frame thread
│   │   │   └── run_stream.py             ← headless single-camera entrypoint (debug only)
│   │   ├── services/                     ← stateless business logic
│   │   │   ├── face_matcher.py           ← Qdrant 1:N search + thresholds
│   │   │   ├── face_quality.py           ← blur/pose/size gates
│   │   │   ├── face_learning.py          ← unknown-face queue logic
│   │   │   ├── enrollment.py             ← gallery enrollment flow
│   │   │   ├── footfall.py               ← per-camera Euclidean tracker + line crossing
│   │   │   ├── snapshot_pump.py          ← bounded asyncio queue → MinIO upload
│   │   │   ├── snapshot_cache.py         ← per-camera latest-JPEG cache (MJPEG endpoint)
│   │   │   └── detection_zones.py        ← polygon-zone filter
│   │   ├── workers/                      ← long-running background processes
│   │   │   ├── match_worker.py           ← THE second daemon — Qdrant search loop
│   │   │   ├── reid_worker.py            ← cross-camera identity linking
│   │   │   └── retention_worker.py       ← Postgres + MinIO retention sweeps
│   │   ├── infra/                        ← I/O adapters
│   │   │   ├── postgres.py, redis_bus.py, minio_store.py, qdrant.py,
│   │   │   ├── insightface_runtime.py    ← SCRFD + ArcFace loader
│   │   │   ├── batched_scrfd.py          ← N-camera-batched detect
│   │   │   ├── person_detector.py        ← YOLOv8 ONNX wrapper
│   │   │   ├── detection_cache.py        ← LatestDetectionCache (the live overlay state)
│   │   │   ├── detection_state.py        ← cross-process Redis pub/sub for cache
│   │   │   ├── alerts_subscriber.py      ← match-worker → orchestrator name patcher
│   │   │   └── recognizers/              ← Recognizer plugins (insightface_arc, adaface)
│   │   ├── domain/
│   │   │   ├── models.py                 ← SQLAlchemy ORM models
│   │   │   ├── schemas.py                ← Pydantic in/out schemas
│   │   │   └── enums.py
│   │   ├── core/                         ← cross-cutting (logging, metrics, security, tracing)
│   │   ├── config/settings.py            ← Pydantic Settings — read this when adding a knob
│   │   └── alembic/versions/             ← DB migrations (0001…0005_footfall.py)
│   ├── facerecounstruct/                 ← CodeFormer + Real-ESRGAN service (port 8002)
│   ├── deepstream_api/                   ← experimental DeepStream bridge (not running)
│   ├── human_detection/                  ← legacy demo (not in compose)
│   ├── Customer-Footfall-Count-main/     ← reference impl that seeded the footfall feature
│   └── weapon_detection/                 ← stub
├── data/                                 ← bind-mounted into the containers
│   ├── known_faces/                      ← enrolled gallery JPEGs, bootstrapped at startup
│   ├── models/                           ← YOLOv8 ONNX + (optional) AdaFace .pt
│   └── insightface/                      ← buffalo_l cache
├── requirements.txt                      ← Python deps (pinned)
├── Dockerfile
└── .env                                  ← runtime config (NEVER commit secrets)
```

## How to run it

### Full stack (recommended for dev)

```sh
cd C:\Users\systo\Desktop\anil\drisyam     # repo root
docker compose up -d                       # brings the whole platform up
docker compose logs -f smart-cam-ai        # tail the AI
```

The `smart-cam-ai/app/` directory is bind-mounted into `/srv/app` so Python edits take effect on **container restart**:

```sh
docker compose restart smart-cam-ai           # API only
docker compose restart smart-cam-ai-worker    # match worker only
```

There is no auto-reload — we removed `--reload` from uvicorn because the reload supervisor turned a crash into a hang. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#ai-service-hangs).

### One camera, headless

For debugging detection on a fixed RTSP source without the full API stack:

```sh
docker compose exec smart-cam-ai \
  python -m vms_face.pipeline.run_stream \
  --camera_id <uuid> --tenant_id <uuid> --camera_code TEST \
  --source rtsp://mediamtx:8554/cam_<monitor_id>
```

### Just the match worker

The match worker is independent of the API. If detections pile up in Redis and the worker is dead, you'll see `QUEUE_DEPTH{stream="vms.detections"}` climb in Prometheus.

```sh
docker compose restart smart-cam-ai-worker
```

## Env vars you'll touch most

Read [config/settings.py](../vms_face/config/settings.py) for the full list — it's heavily commented. The ones an intern actually edits:

| Var | Default | Use when |
|---|---|---|
| `INSIGHTFACE_DET_THRESHOLD` | 0.7 | SCRFD raising false positives → bump higher |
| `INSIGHTFACE_REC_THRESHOLD` | 0.45 | known faces not matching → lower; strangers matching → raise |
| `MATCH_MIN_FACE_PX` | 40 | tiny faces matching as known people → raise |
| `MATCH_MIN_QUALITY` | 0.45 | blurry crops matching → raise |
| `MATCH_MIN_BLUR_VAR` | 20 | Laplacian variance floor (blur gate) |
| `PIPELINE_PERSON_DETECTION_ENABLED` | false | turn on YOLOv8 person count + footfall body-mode |
| `PIPELINE_PERSON_MODEL_PATH` | `/srv/data/models/yolov8n.onnx` | path to YOLO weights |
| `PIPELINE_BATCHED_INFERENCE` | false | coalesce N cameras' SCRFD calls (incompatible with insightface recognizer) |
| `EMBED_EVERY_N_FRAMES` | 5 | re-embed cadence after track warm-up |
| `TRACK_MIN_HITS_TO_MATCH` | 4 | hits needed before publishing a match |
| `SNAPSHOT_AUTO_ENHANCE` | false | route every face crop through CodeFormer before MinIO upload |
| `WATCHLIST_AUTO_ENHANCE` | false | enhance alert thumbnails when ALERT fires |
| `VMS_ENV` | dev | "dev" enables the JWT dev-bypass below |
| `VMS_JWT_DEV_BYPASS` | true (dev only) | skip JWT, bind to default tenant — never set in prod |
| `VMS_JWT_SECRET` | (long random) | HS256 secret; ≥32 chars required outside dev-bypass |
| `CACHE_BACKEND` | redis | `local` for single-process dev, `redis` for multi-process |
| `RECOGNIZER_BACKEND` | insightface | `adaface` if you've loaded the AdaFace .pt |

## Where to put your code

| Task | Files to touch |
|---|---|
| Add a REST endpoint | new file in `api/routes/<topic>.py`, mount in `api/main.py` |
| Add a DB table | new alembic migration in `alembic/versions/0006_<desc>.py` + ORM class in `domain/models.py` |
| Change a setting | `config/settings.py` (with a comment explaining the why) |
| Add a per-frame computation | inside `pipeline/orchestrator.py` in `_consume_loop` — read the existing comments first |
| Add a background task | new file in `workers/<name>.py` + lifespan task in `api/main.py` |
| Add a service that touches Postgres + MinIO | `services/<name>.py` — keep it stateless, inject `session` + `objects` from deps |

## Three first-PR ideas

1. **5-line PR — surface a new metric on `/status`.** Add `pipeline_total_frames` to `api/routes/legacy.py`'s `/status` response by reading `LatestDetectionCache._stats`. Verify with `curl http://localhost:8001/status`.

2. **50-line PR — a new gate.** Add `MATCH_MIN_FACE_ASPECT_RATIO` to `settings.py` and enforce it in `services/face_matcher.py` before the Qdrant call. Document why with a one-line code comment.

3. **200-line PR — extend a feature.** Add per-camera "peak hour" to the Footfall `/footfall/cameras` response: aggregate the last 7 days' hourly buckets from `footfall_minute_buckets`, return the hour-of-day with the highest IN count. Surface it on the Footfall card in the frontend.

## Where to ask

- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- "What does feature X do?": [FEATURES.md](FEATURES.md)
- "It's not working": [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- Operator-facing docs: `smart-cam-app/docs/`
- Backend gateway docs: `smart-cam-backend/docs/`

When in doubt: read the comment block at the top of any file you're editing. We comment the _why_, not the _what_ — that's the part you can't reconstruct from the code.
