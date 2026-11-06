# smart-cam-ai — Features

One section per shipped feature. Each has: **what it does**, **files**, **endpoints**, **DB / cache state**, **knobs**, **how to extend**. Scan to find your area, then dive.

---

## Face recognition (the core)

What it does: detects + tracks + matches faces against the enrolled gallery. Produces `DetectionEvent` rows + WebSocket alerts.

**Files**
- [pipeline/orchestrator.py](../vms_face/pipeline/orchestrator.py) — per-camera frame loop
- [pipeline/ingest.py](../vms_face/pipeline/ingest.py) — RTSP reader
- [infra/insightface_runtime.py](../vms_face/infra/insightface_runtime.py) — SCRFD + ArcFace loader
- [infra/batched_scrfd.py](../vms_face/infra/batched_scrfd.py) — multi-camera batched detect
- [services/face_quality.py](../vms_face/services/face_quality.py) — pre-match gate
- [services/face_matcher.py](../vms_face/services/face_matcher.py) — Qdrant 1:N search
- [workers/match_worker.py](../vms_face/workers/match_worker.py) — async match daemon

**Endpoints**
- `GET /api/detections/{monitor_id}` — current bbox state (1 s poll fallback)
- `WS /ws` — push channel for live boxes + alerts
- `GET /personnel/search` — find a person
- `GET /logs` — recent events

**Tables** — `detection_events`, `persons`, `face_enrollments` (Qdrant collection: `vms_enrolled`)

**Key knobs** — see ARCHITECTURE's settings table

**Extend it** — to add a new recognizer (e.g. magface): subclass `infra/recognizers/base.Recognizer`, register in `infra/recognizers/factory.py`, set `RECOGNIZER_BACKEND=magface`. Re-enroll because embeddings aren't compatible across backends.

---

## Enrollment (uploading known faces)

What it does: accepts a face photo + name, runs detect → quality gate → embed, stores in Qdrant + Postgres + MinIO. Also bootstraps from `data/known_faces/` on every startup.

**Files**
- [services/enrollment.py](../vms_face/services/enrollment.py)
- [services/known_faces_bootstrap.py](../vms_face/services/known_faces_bootstrap.py)
- [api/routes/persons.py](../vms_face/api/routes/persons.py), [legacy.py](../vms_face/api/routes/legacy.py)

**Endpoints**
- `POST /upload` — multipart `name + file`, legacy interface used by Watchlist
- `POST /persons` / `POST /persons/{id}/enrollments`

**Tables** — `persons`, `face_enrollments`

**Notable behavior** — bootstrap is idempotent. Files with no detectable face are skipped (logged with reason). Repaired-missing-vector counter ticks when a Postgres row exists but the Qdrant vector is gone.

---

## Face learning (unknown-face queue)

What it does: when a high-quality face fails to match anyone, the orchestrator queues it as a `FaceLearningSample` for an operator to label. The frontend FaceLearning page polls + lets the operator approve/reject.

**Files**
- [services/face_learning.py](../vms_face/services/face_learning.py)
- [api/routes/learning.py](../vms_face/api/routes/learning.py)

**Endpoints**
- `GET /face-learning/samples?status=pending&limit=…`
- `GET /face-learning/samples/{id}/snapshot` — streamed JPEG
- `POST /face-learning/samples/{id}/approve` — promotes to enrollment
- `POST /face-learning/samples/{id}/reject`

**Tables** — `face_learning_samples`

**Knobs** — `FACE_LEARNING_MIN_SIMILARITY` (how close must a candidate be to enter the queue), `FACE_LEARNING_MIN_QUALITY`, `FACE_LEARNING_MIN_FACE_PX`, `FACE_LEARNING_MIN_BLUR_VAR`.

---

## Watchlist + alerts

What it does: enrolled people can have role `BLACKLIST`. When matched, the candidate becomes `EventKind.ALERT` instead of `MATCH`, fires onto `vms.alerts`, and the frontend AI Alerts page surfaces it as a watchlist hit.

**Files**
- [workers/match_worker.py](../vms_face/workers/match_worker.py) lines 110-130 (kind decision)
- [domain/enums.py](../vms_face/domain/enums.py) — `PersonRole`, `EventKind`

**Endpoints** — alerts ride the same WS channel as regular matches; `kind=alert` is the distinguisher.

---

## Footfall (line-crossing customer counter)

What it does: counts people crossing an operator-configured horizontal line per camera. Persists per-minute IN/OUT counts to `footfall_minute_buckets`. Drives the Footfall page in the frontend.

**Files**
- [services/footfall.py](../vms_face/services/footfall.py) — Euclidean tracker + line-crossing detector + 5 s flusher
- [api/routes/footfall.py](../vms_face/api/routes/footfall.py) — REST surface
- [alembic/versions/0005_footfall.py](../vms_face/alembic/versions/0005_footfall.py) — migration
- [pipeline/orchestrator.py](../vms_face/pipeline/orchestrator.py) — calls `registry.update()` per frame

**Endpoints**
- `GET /footfall/cameras` — per-camera + today totals
- `GET /footfall/timeseries?granularity=minute|hour|day&from=…&to=…`
- `GET /footfall/cameras/{id}/config` / `PUT` — line position + direction + falls
- `GET /footfall/export.csv` — streaming CSV download

**Tables** — `footfall_minute_buckets(tenant_id, camera_id, bucket_minute, in_count, out_count, falls_count)` PK on `(camera_id, bucket_minute)`, indexed on `(tenant_id, bucket_minute DESC)`

**Knobs** — per-camera config_json: `enabled`, `line_y_frac` (0.05-0.95), `direction` (`down_is_in` / `up_is_in`), `falls_enabled`. Tracker constants `_TRACK_MATCH_RADIUS_PX` (60), `_TRACK_TTL_SEC` (2.0), `_FLUSH_INTERVAL_SEC` (5.0) are module-level in `services/footfall.py`.

**Source for crossings** — YOLOv8 person bboxes when `pipeline_person_detection_enabled=true`, otherwise SCRFD face tracker bboxes as fallback. The fallback works fine on entrance cams where faces are visible; body-mode is required for back-of-head walkers.

---

## Footfall + face MJPEG live preview

What it does: the Footfall card on the frontend shows a live `<img src=/api/cameras/{id}/mjpeg>`. The endpoint pushes JPEGs in `multipart/x-mixed-replace` from the snapshot cache at ~4 fps.

**Why MJPEG**: MediaMTX HLS muxer keeps crashing on Hikvision B-frame H.264. WebRTC works but needs negotiation. MJPEG over multipart works with a bare `<img>` and is what every commercial VMS (Frigate, Shinobi, BlueIris) ships for preview tiles.

**Files**
- [services/snapshot_cache.py](../vms_face/services/snapshot_cache.py) — per-camera latest-JPEG with 250 ms encode throttle
- [api/routes/legacy.py](../vms_face/api/routes/legacy.py) — `GET /api/cameras/{monitor_id}/mjpeg` + `/snapshot.jpg`

**Cost** — ~50 KB per JPEG × 4 fps = ~200 KB/s per camera + a poll loop with `await asyncio.sleep(0.1)`. Negligible CPU.

---

## Face reconstruction (CodeFormer + Real-ESRGAN)

What it does: separate service that turns a blurry CCTV face into a clean one. GAN-based restoration with smart routing (Aligned / Full Scene / Pure SR) + degradation triage.

**Files**
- [facerecounstruct/backend/app/pipeline.py](../../face-reconstruct/backend/app/pipeline.py) — the restoration pipeline
- [facerecounstruct/backend/app/main.py](../../face-reconstruct/backend/app/main.py) — FastAPI
- [facerecounstruct/CodeFormer/](../../face-reconstruct/CodeFormer/) — vendored repo (https://github.com/sczhou/CodeFormer)
- [facerecounstruct/Dockerfile](../../face-reconstruct/Dockerfile) — pytorch/pytorch base + system deps
- [facerecounstruct/docker-entrypoint.sh](../../face-reconstruct/docker-entrypoint.sh) — first-run weight download

**Endpoints** (port 8002, proxied as `/api/ai/enhance` on the Node backend)
- `GET /health`
- `POST /api/reconstruct` — multipart `file` + `fidelity_weight` (0..1, default 0.5)

**Response shape** (key names matter — they are NOT what the README suggests):
```json
{
  "triage": { "blur_level": …, "noise_level": …, "compression_level": …, "overall_level": "mild|moderate|severe" },
  "original_image": "<base64 PNG>",
  "enhancement_stages": [ { "image": "<base64 PNG>", ... } ],
  "final_enhanced_image": "<base64 PNG>",
  "reconstruction_image": "<base64 PNG>",
  "fidelity_weight": 0.5,
  "device": "cuda",
  "reconstruction_error": null
}
```

**Timing** — verified on a real 3200×1800 CCTV frame: ~6 s end-to-end with `device=cuda`. The dominant cost is Real-ESRGAN background upsampling on full-scene mode; pure aligned-face mode is ~1 s.

**Three integration modes**
1. **On-demand** — operator clicks `Enhance face` in AI Alerts modal or FaceLearning sample lightbox → `<EnhanceFaceDialog>` does an axios POST through the Node proxy.
2. **Per-event** — `services/snapshot_pump.py` calls the service before MinIO upload when `SNAPSHOT_AUTO_ENHANCE=true`. Strict 2 s timeout — falls back to the original on any failure.
3. **Watchlist-hit** — `workers/match_worker.py._enhance_watchlist_snapshot()` enhances + uploads alongside when `WATCHLIST_AUTO_ENHANCE=true` AND `kind == ALERT`. Original is preserved at the same s3 key; the enhanced copy lands at `<key>_enhanced.png`.

**Knobs** (in `config/settings.py`)
- `face_reconstruct_url` = `http://face-reconstruct:8002`
- `snapshot_auto_enhance` (bool) + `snapshot_auto_enhance_fidelity` (0..1)
- `watchlist_auto_enhance` (bool) + `watchlist_auto_enhance_fidelity` (0..1)

**Patches we apply** — CodeFormer's bundled basicsr fork is missing `data/*` (mocked at runtime in `pipeline.py`) and `version.py` (created at image-build time in the Dockerfile). If a new ModuleNotFoundError appears after a CodeFormer upgrade, append to either mock list.

---

## Person detection + people-count tile

What it does: optional YOLOv8 ONNX inference for "humans in scene" count regardless of face visibility. Drives the Dashboard people-count tile, AiFeed badge, Footfall body-mode crossings.

**Files**
- [infra/person_detector.py](../vms_face/infra/person_detector.py)
- [api/routes/legacy.py](../vms_face/api/routes/legacy.py) — `GET /api/people-count`

**Tables** — none (in-memory only). Smoothed via 2 s rolling-max in `LatestDetectionCache`.

**Knobs** — `pipeline_person_detection_enabled`, `pipeline_person_model_path`, `pipeline_person_threshold` (0.35), `pipeline_person_det_size` (640), `pipeline_person_detect_every_n_frames` (2).

**Weights** — drop `yolov8n.onnx` into `smart-cam-ai/data/models/` (see [infra/person_detector.py](../vms_face/infra/person_detector.py) docstring for the export command).

---

## Personnel search

What it does: GET endpoint that answers "find a person by name / id / department". Returns latest sighting per person via a SQL window function.

**Files**
- [api/routes/personnel.py](../vms_face/api/routes/personnel.py)

**Endpoints**
- `GET /personnel/search?q=&role=&limit=&offset=` — list with `last_camera_code`, `last_seen_label`, `cameras_seen`, `enrollment_count`
- `GET /personnel/{id}` — single-person detail

---

## Journey map

What it does: returns a chronological list of "stops" — clusters of detections at the same camera within a configurable time window — for a given person over a time range. Frontend renders them on a Leaflet map.

**Files**
- [api/routes/journey.py](../vms_face/api/routes/journey.py)

**Endpoints**
- `GET /journey/{person_id}?from=&to=&min_dwell_sec=&max_gap_sec=`

---

## Cross-camera ReID

What it does: appearance-vector matcher that links tracks across cameras within a time window. Outputs `track_links` rows the frontend can use to chain a person's journey across non-overlapping cameras.

**Files**
- [workers/reid_worker.py](../vms_face/workers/reid_worker.py)
- [api/routes/reid.py](../vms_face/api/routes/reid.py)
- Qdrant collection: `vms_appearance` (only enabled when `QDRANT_APPEARANCE_ENABLED=true`)

**Tables** — `track_links(a_track_id, a_camera_id, b_track_id, b_camera_id, similarity, link_kind, person_id, metadata)` — unique on the 4-key tuple so re-emissions are no-ops.

---

## Retention

What it does: nightly sweep that deletes old `detection_events`, `face_learning_samples`, and their MinIO snapshots according to per-tenant retention policy.

**Files** — [workers/retention_worker.py](../vms_face/workers/retention_worker.py)

**Knobs** — `RETENTION_WORKER_ENABLED`, `RETENTION_DAYS_*`.

---

## Auth (JWT HS256)

What it does: every protected route reads a Bearer JWT, decodes it into a `Principal{subject, tenant_id, role}`. The dev-bypass mode synthesizes a Principal bound to the default tenant when `VMS_ENV=dev` + `VMS_JWT_DEV_BYPASS=true`.

**Files**
- [core/security.py](../vms_face/core/security.py)
- [api/deps.py](../vms_face/api/deps.py) — `current_principal`, `current_tenant_id`, `require_admin`, `operator_id`

**Posture check** — `GET /healthz` returns `auth.mode` = `jwt | dev-bypass | MISCONFIGURED`. Use this in deploys to verify production is actually running with JWT.

---

## Camera credential encryption

What it does: encrypts `rtsp_url` (and anything containing `password=`) at rest in Postgres using AES-256-GCM with `enc:v1:` prefix tags. Key from `VMS_CAMERA_CRED_KEY` (base64-encoded 32 bytes).

**Files** — [core/crypto.py](../vms_face/core/crypto.py), [domain/types.py](../vms_face/domain/types.py) — `EncryptedString` SQLAlchemy column type.

**Posture** — `GET /healthz`'s `pipeline.camera_cred_encryption: true` means the key is set + valid.
