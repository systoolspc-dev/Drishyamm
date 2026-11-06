# face-service (`vms_face`)

The face / identity AI: detection, recognition, watchlists and unknown-person
alerts, gender/age, face learning, footfall lines, the cross-camera person
journey, and the inference server that lets many camera shards share one set
of GPU engines.

| Path | What |
|---|---|
| `vms_face/` | The Python package (FastAPI API, pipelines, workers, Alembic migrations, tests). Its own [README](vms_face/README.md), [SERVICES.md](vms_face/SERVICES.md) and [DETECTION_STRATEGY.md](vms_face/DETECTION_STRATEGY.md) go deeper. |
| `MODEL.md` | Study guide: the frame-by-frame call path, every threshold, measured accuracy and latency, weaknesses, improvement ideas. |
| `docs/` | Service-level architecture, features, onboarding, troubleshooting. |
| `Dockerfile`, `requirements.txt` | One CUDA 12.8 image, `drishyam/face-service`. |

## One image, several roles

| Compose service | Command | Role |
|---|---|---|
| `smart-cam-ai` | `alembic upgrade head && uvicorn vms_face.api.main:app` | API on :8001 + camera pipelines (shard 0; owns migrations) |
| `smart-cam-ai-worker` | `python -m vms_face.workers.match_worker` | gallery / watchlist matching, alert events |
| `journey-stitch-worker` | `python -m vms_face.workers.stitch_worker` | renders journey MP4 + PDF (CPU) |
| `smart-cam-ai-1..4` (scale file) | `uvicorn …` | extra camera shards |
| `smart-cam-infer..-3` (scale file) | `python -m vms_face.workers.infer_server` | shared detector + recognizer engines over TCP :9010 |

## Configuration

There is no `.env` for this service. All settings are fields of
`vms_face/config/settings.py` (pydantic-settings: field `insightface_det_size`
↔ env `INSIGHTFACE_DET_SIZE`). Compose sets them in the `x-ai-env` block of
the root `docker-compose.yml`, taking secrets and host-specific values from
the root `.env`. The values there are the tuned ones from the running system;
what each knob does and how to tune it:
[../../docs/AI_ACCURACY_AND_TUNING.md](../../docs/AI_ACCURACY_AND_TUNING.md),
[../../docs/07-env-variables.md](../../docs/07-env-variables.md).

Mounted at runtime (nothing to download):

| Host | Container |
|---|---|
| `ai/face-service/vms_face` | `/srv/app/face_detection/vms_face` (live code; restart to pick up edits) |
| `models/insightface` | `/root/.insightface` (buffalo_l / buffalo_sc; TensorRT cache written here) |
| `data/known-faces` | `/srv/data/known_faces` (optional bootstrap gallery: `Name_1.jpg`, `Name_2.jpg`, …) |
| `data/ai-models` | `/srv/data/models` (optional `yolov8n.onnx` for full-body presence) |
| `RECORDINGS_DIR` | `/recordings` (read-only, journey clips) |

## Tests

```bash
docker compose exec smart-cam-ai sh -c \
  'cd /srv/app/face_detection && python -m unittest discover -s vms_face/tests -t .'
```

43 tests, all passing as of 2026-11-06.

## API

`http://<host>:8001/docs` (OpenAPI). Routers: cameras, streams, persons,
personnel, events, search, embed, learning, reid, journey, footfall, tenants,
edge, ws, legacy. Every call is tenant-scoped by the `tid` claim of the JWT
the backend mints (signed with `SERVICE_TOKEN`); in `VMS_ENV=dev` an
unauthenticated call acts as the default tenant.
