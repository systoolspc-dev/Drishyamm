# 07 — Environment Variables

Reference for every environment variable the Drishyam VMS actually reads, extracted
from source. Three processes have their own env surface:

| Process | Loads from | Validated by |
|---|---|---|
| `smart-cam-backend` (Node/Express) | `smart-cam-backend/.env` (loaded by `dotenv` in `src/config/env.js`), plus anything injected by Docker Compose | **Joi schema** in `src/config/env.js` + `src/config/prodSecretGuard.js` |
| `smart-cam-ai` (FastAPI, `vms_face`) | process env / `.env` next to the service | **pydantic-settings** in `app/face_detection/vms_face/config/settings.py` |
| `smart-cam-app` (Vite SPA) | `smart-cam-app/.env`, `.env.production` | none — read at build time via `import.meta.env` |

> **The backend refuses to boot on invalid config.** `src/config/env.js` runs the Joi
> schema over `process.env` with `abortEarly: false`. Any missing required var or a
> JWT secret under 32 characters prints the full list of problems and calls
> `process.exit(1)`. Unknown vars are allowed through (`.unknown(true)`) — that is how
> the operational tuning knobs in the tables below reach the services.
>
> **Secrets marked 🔒 must never be committed.** `.env` is gitignored; only
> `.env.example` (placeholders) belongs in the repo.

---

## Required in production

These have no safe default. The backend will not start without them, and
`prodSecretGuard.js` performs a second pass when `NODE_ENV=production`.

| Variable | Requirement |
|---|---|
| 🔒 `JWT_SECRET` | Required, **min 32 chars**. Must differ from `JWT_REFRESH_SECRET`. |
| 🔒 `JWT_REFRESH_SECRET` | Required, **min 32 chars**. |
| `DB_NAME`, `DB_USER` | Required (no default). |
| 🔒 `DB_PASSWORD` | Must be non-empty in production. |
| 🔒 `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Required by the schema (any value in dev). |
| 🔒 `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Required by the schema. |
| 🔒 `STREAM_SERVICE_API_PASS` / `MEDIAMTX_API_PASS` | Must not be the sample `drishyam123`. |
| 🔒 `SERVICE_TOKEN` | Optional but **min 32 chars** when set. Required in practice — it authenticates AI worker → `/api/internal/*` calls. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| 🔒 `CAMERA_CRED_KEY` | base64 of 32 random bytes. Without it camera RTSP passwords are stored **plaintext**. Generate: `openssl rand -base64 32` |
| 🔒 `STREAM_URL_SECRET` | HMAC key for signed stream URLs. Empty disables signing/verification. |
| 🔒 `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Needed for recording upload/playback. |
| 🔒 `VMS_JWT_SECRET` (AI service) | **min 32 chars** or the AI treats JWT as unconfigured. Must equal the backend's `AI_JWT_SECRET`. |

### Production secret guard (`src/config/prodSecretGuard.js`)

When `NODE_ENV=production`, boot is refused if any of the following hold. Outside
production the guard is a no-op, so the sample `.env` still works for dev/test.

| Check | Failure condition |
|---|---|
| Dev-default JWT secret | `JWT_SECRET` or `JWT_REFRESH_SECRET` matches `dev-`, `change-me`, `placeholder`, `xxxx`, or `secret-key-must-be` (case-insensitive) |
| Reused secret | `JWT_SECRET === JWT_REFRESH_SECRET` |
| Sample stream password | `MEDIAMTX_API_PASS === 'drishyam123'` |
| Empty DB password | `DB_PASSWORD` unset or empty |
| Placeholder Stripe key | `STRIPE_SECRET_KEY` contains `placeholder` or `replace_with` |

---

# Backend — `smart-cam-backend/.env`

## Core / server

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | One of `development`, `production`, `test`. Gates the prod secret guard, rate limiting, audit logging, and SMTP fail-hard. |
| `PORT` | `5000` | HTTP listen port. |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowed origins. |
| `FRONTEND_URL` | `http://localhost:5173` | Primary SPA URL used in emails/redirects. |
| `ALERT_TIMEZONE` | `Asia/Kolkata` | IANA zone for human-readable timestamps in alert emails and zone arm-windows. |
| `GIT_SHA` | `npm_package_version` → `dev` | Version string reported by `/api/health`. |
| `HOSTNAME` | `local` | Docker-provided; used to build the supervisor leader-election instance ID. |

## Database (MySQL)

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | MySQL host (`mysql` inside Compose). |
| `DB_PORT` | `3306` | MySQL port. |
| `DB_NAME` | **required** | Database name (Compose uses `drishyamvms`). |
| `DB_USER` | **required** | DB username. |
| 🔒 `DB_PASSWORD` | `''` | DB password. Must be non-empty in production. |
| `DB_SSL` | unset | Set to `true` to require TLS to the DB. Leave unset for a same-host Docker MySQL — forcing TLS aborts the handshake. |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | Set to `false` to accept a self-signed DB certificate. Only read when `DB_SSL=true`. |

## Redis / queues

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Cache, pub/sub, BullMQ, supervisor leader lock. `rediss://` supported. The app degrades gracefully if Redis is absent. |
| `STREAM_BUS_MAXLEN` | `50000` | `MAXLEN ~` cap on each `drisyam:events:*` Redis Stream. |
| `TRANSCODER_QUEUE_CONCURRENCY` | `32` | BullMQ worker concurrency for the transcode queue. |

## Auth & secrets

| Variable | Default | Description |
|---|---|---|
| 🔒 `JWT_SECRET` | **required, min 32** | Access-token signing secret. |
| `JWT_EXPIRES_IN` | `15m` | Access-token lifetime. |
| 🔒 `JWT_REFRESH_SECRET` | **required, min 32** | Refresh-token signing secret. Must differ from `JWT_SECRET`. |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh-token lifetime. |
| 🔒 `SERVICE_TOKEN` | `''` (min 32 if set) | Shared service-to-service token for `/api/internal/*` (AI worker → backend ingest). |
| 🔒 `CAMERA_CRED_KEY` | `''` | base64 32-byte AES-256-GCM key encrypting camera credentials at rest. Empty = plaintext storage (legacy). |
| 🔒 `STREAM_URL_SECRET` | `''` | HMAC key for signed stream URLs. Empty disables token signing *and* verification. |
| `STREAM_URL_TTL_SEC` | `3600` | Lifetime of a signed stream URL. |
| `RECORDING_PLAY_URL_TTL_SEC` | `14400` (4 h) | TTL of S3 presigned recording playback URLs. Presigned URLs are bearer credentials — keep this short. |
| `ENFORCE_CAMERA_LIMITS` | on (`false` disables) | Enforce per-plan camera quotas. |
| `FREE_TIER_MAX_CAMERAS` | `0` | Free-plan camera cap; `0` = unlimited. |

## Stream Service (Drishyam Stream Service / MediaMTX)

`STREAM_SERVICE_*` are the preferred names; the `MEDIAMTX_*` names are still honoured
as a fallback during the rename, so both work.

| Variable (preferred / legacy) | Default | Description |
|---|---|---|
| `STREAM_SERVICE_API_URL` / `MEDIAMTX_API_URL` | `http://localhost:9997` | Control-plane API the backend uses to add/remove paths. |
| `STREAM_SERVICE_API_USER` / `MEDIAMTX_API_USER` | `drishyam` | Control-plane basic-auth user. |
| 🔒 `STREAM_SERVICE_API_PASS` / `MEDIAMTX_API_PASS` | `drishyam123` | Control-plane password. **Prod guard rejects the sample value.** |
| `STREAM_SERVICE_WEBRTC_URL` / `MEDIAMTX_WEBRTC_URL` | `http://localhost:8889` | Public WHEP/WebRTC base the *browser* uses (via NGINX in prod). |
| `STREAM_SERVICE_HLS_URL` / `MEDIAMTX_HLS_URL` | `http://localhost:8888` | Public HLS base the *browser* uses. |
| `STREAM_SERVICE_INTERNAL_HLS_URL` / `MEDIAMTX_INTERNAL_HLS_URL` | falls back to the public HLS URL | Container-internal HLS base for server-side probes. |
| `STREAM_SERVICE_RTSP_HOST` / `MEDIAMTX_RTSP_HOST` | `localhost` | Internal RTSP egress host that AI workers connect to (never browser-reachable). |
| `STREAM_SERVICE_RTSP_PORT` / `MEDIAMTX_RTSP_PORT` | `8554` | Internal RTSP port. |
| `STREAM_SERVICE_RECORDINGS_DIR` / `MEDIAMTX_RECORDINGS_DIR` | `./mediamtx-recordings` | Path to the recordings bind-mount (`/recordings` inside containers). |
| `MEDIAMTX_RTSP_BASE` | `rtsp://mediamtx:8554` | Where the NVR-playback ffmpeg republishes its transcoded H.264. |
| `STREAMING_ENGINE` | `mediamtx` | Selects the streaming engine implementation. |
| `PREFER_MAIN_STREAM` | unset | `1` = serve the main stream as the primary live view. Default serves the sub-stream (it survives RTSP timeouts far better). |
| `GRID_LOW_TRANSCODE_MAX` | `2` | Max concurrent low-variant transcoder warm-ups triggered by the grid view. |
| `GRID_LOW_TRANSCODE_COOLDOWN_MS` | `15000` | Per-camera cooldown between grid-triggered low warm-ups. |

### TURN / coturn

Setting both `TURN_URI` and `TURN_SHARED_SECRET` makes the backend mint short-lived
REST-API credentials. When empty, `/api/turn/credentials` returns 204 and the SPA
falls back to STUN-only.

| Variable | Default | Description |
|---|---|---|
| `TURN_URI` | `''` | e.g. `turn:turn.example.com:3478?transport=udp`. |
| `TURN_URI_TLS` | `''` | e.g. `turns:turn.example.com:5349?transport=tcp`. |
| 🔒 `TURN_SHARED_SECRET` | `''` | coturn `use-auth-secret` shared secret. |
| `TURN_TTL_SEC` | `3600` | Credential lifetime (60–86400). |

### LiveKit (SFU)

| Variable | Default | Description |
|---|---|---|
| `LIVEKIT_WS_URL` | `''` | ws/wss URL for the SPA. Empty disables the LiveKit path. |
| `LIVEKIT_API_KEY` | `devkey` | Must match the LiveKit server's key. |
| 🔒 `LIVEKIT_API_SECRET` | `secret` | Signs per-participant JWTs. Rotate before any real deployment. |
| `LIVEKIT_TOKEN_TTL_SEC` | `3600` | Participant token lifetime (60–86400). |

## Recording & retention

| Variable | Default | Description |
|---|---|---|
| `RECORD_CONTINUOUS` | unset | `1` = always-on 24/7 recording for all cameras. **Dangerous on shared NVR uplinks** — this was tried and reverted (17 simultaneous full-res pulls knocked cameras offline). |
| `SOURCE_ALWAYS_ON` | unset | `1` = hold sources live without forcing recording. |
| `RECORD_SUB` | on (`0` disables) | Record the sub-stream path. Compose sets `0` on purpose: always-on sub recording opens one permanent RTSP session per camera and jams NVR session tables. |
| `RECORD_DELETE_AFTER` | `168h` | Stream Service `recordDeleteAfter` for sub-stream paths. |
| `RECORDING_SEGMENT_DURATION` | `10m0s` | Go duration string controlling MP4 segment length. 10 m balances scrub granularity vs. S3 object count. |
| `RECORDING_STITCH_BELOW_SEC` | `120` | Fragments shorter than this get concatenated before S3 upload so reconnect storms don't produce thousands of tiny clips. `0` disables stitching. |
| `DEFAULT_RETENTION_DAYS` | `30` | Fallback retention when no Camera → Group → Site value is set. |
| `RETENTION_APPLY_RETRIES` | `3` | Retries when pushing retention to the Stream Service. |
| `RETENTION_APPLY_BACKOFF_MS` | `300` | Backoff between those retries. |
| `RETENTION_APPLY_CONCURRENCY` | `8` | Parallelism for bulk retention application. |
| `RECORDING_UPLOADED_CACHE_MAX` | `50000` | FIFO cap on the in-memory "already uploaded" idempotency set. |
| `RECORDING_MAX_BUFFER_MB` | `256` | Ceiling on the buffered-read fallback so a multi-GB clip can't OOM the heap. |
| `WATCHDOG_NVR_RESET_MIN_MS` | `30000` | Minimum gap between path resets targeting the **same NVR** — stops one 500 from firing simultaneous RTSP re-opens into a box already at its session cap. |
| `WATCHDOG_ORPHAN_CLEANUP` | on (`0` disables) | Delete configured `cam_*` paths whose camera no longer exists in the DB. |
| `WATCHDOG_ORPHAN_PASSES` | `2` | Consecutive passes a path must look orphaned before deletion. |
| `WATCHDOG_ORPHAN_SKIP` | `demo-entrance` | Comma-separated monitorId bases never reconciled away (demo / externally-published paths). |
| `STORAGE_CACHE_MS` | `60000` | TTL of the cached disk-usage scan of the recordings tree. |

## S3 / object storage

| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT` | `https://s3.10pb.com` | S3-compatible endpoint. |
| `S3_REGION` | `ap-south-1` | Region. |
| 🔒 `S3_ACCESS_KEY` | unset | Access key ID. |
| 🔒 `S3_SECRET_KEY` | unset | Secret access key. |
| `S3_BUCKET` | `bms-001161` | Recording bucket. |
| `S3_RETENTION_ENABLED` | off (`1` enables) | Enforce retention on the durable S3 copy. |
| `S3_RETENTION_DELETE` | off (`1` enables) | `1` actually deletes; otherwise the sweep is a dry run that only logs. |
| `S3_RETENTION_GRACE_DAYS` | `1` | Extra days kept beyond the resolved retention before an object is eligible. |
| `S3_RETENTION_INTERVAL_MS` | `86400000` (24 h) | Sweep interval. |
| `S3_RETENTION_MAX_DELETE_PER_RUN` | `20000` | Safety cap on deletions per sweep. |

## Transcoding

| Variable | Default | Description |
|---|---|---|
| `TRANSCODER_STALL_MS` | `30000` | Kill an ffmpeg session that stops producing output for this long. |
| `TRANSCODER_IDLE_MS` | `60000` | Tear down a transcode with no viewers for this long. |
| `TRANSCODER_CHECK_MS` | `15000` | Health-check tick. |
| `TRANSCODER_MAX` | `8` | Max concurrent ffmpeg transcode sessions per node. |
| `TRANSCODER_ALLOW_HW` | `false` | `true` enables hardware encoders (NVENC). Compose sets `true` on GPU hosts. |
| `TRANSCODER_QUEUE_WAIT_MS` | `10000` | How long a `wait=true` transcode request blocks for a slot. |
| `SMART_CAM_TRANSCODER_URL` | `http://smart-cam-transcoder:8004` | External transcoder microservice base URL. |

## AI service integration (backend side)

| Variable | Default | Description |
|---|---|---|
| `AI_SERVICE_URL` | `http://localhost:8001` | smart-cam-ai base URL (`http://smart-cam-ai:8001` in Compose). Backend proxies face upload / person-tracker calls here. |
| 🔒 `AI_JWT_SECRET` | `SERVICE_TOKEN` → `JWT_SECRET` | HS256 secret the backend uses to **mint per-organization JWTs** the AI verifies. Must equal the AI's `VMS_JWT_SECRET`. Carries `tid` (tenant) so every face/camera/journey call is org-scoped. Min 32 chars. |
| `AI_JWT_ISSUER` | `drisyam-vms` | `iss` claim; must match the AI's `VMS_JWT_ISSUER`. |
| `AI_JWT_AUDIENCE` | `drisyam-vms` | `aud` claim; must match the AI's `VMS_JWT_AUDIENCE`. |
| 🔒 `AI_SERVICE_TOKEN` / `PERSON_TRACKER_SERVICE_TOKEN` | `''` | `X-Service-Token` injected on the person-tracker reverse proxy. |
| `ACTIVITY_SERVICE_URL` | `http://drisyam-original-activity-monitor:8000` | activity-monitor base; backend proxies `/activity/*`. |
| `FACE_RECONSTRUCT_BASE` | `http://face-reconstruct:8002` | Face-enhance service (CodeFormer + Real-ESRGAN) used by `/api/ai/enhance-face`. |
| `AI_LIFECYCLE_RECONCILE_MS` | `15000` | Interval for reconciling which cameras have AI enabled against entitlements. |
| `AI_EVENT_RETENTION_DAYS` | `90` | Age at which `ai_events` rows are purged. |
| `AI_EVENT_RETENTION_INTERVAL_MS` | `21600000` (6 h) | Purge sweep interval. |
| `AI_MINIO_ENDPOINT` | `http://minio:9000` | MinIO endpoint used for zone-intrusion crop uploads. |
| 🔒 `AI_MINIO_KEY` | `minioadmin` | MinIO access key. Rotate off the default. |
| 🔒 `AI_MINIO_SECRET` | `minioadmin` | MinIO secret key. Rotate off the default. |
| `AI_MINIO_BUCKET` | `vms-snapshots` | Bucket for zone crops. |

## Alerts (push / email / SMTP)

Anti-flood doctrine: alert on debounced state transitions, throttle per identity, and
cap bursts. See `docs/DETECTION_LOGGING_ALERTING_POLICY.md`.

| Variable | Default | Description |
|---|---|---|
| `ALERT_PUSH_COOLDOWN_SEC` | `90` | Per-subject cooldown before the same push alert fires again. |
| `ALERT_EMAIL_COOLDOWN_SEC` | `600` | Per-subject email cooldown (email is held tighter — it was the flooding channel). |
| `ALERT_EMAIL_WINDOW_SEC` | `600` | Burst-cap window for email. |
| `ALERT_EMAIL_MAX_PER_WINDOW` | `8` | Max emails per window per recipient. |
| `EMAIL_HOST` | unset | SMTP host. Unset = dev logger transport; in production sending throws instead of silently dropping. SMTP is normally configured through Admin → Settings (encrypted in DB), and these env vars are the fallback. |
| `EMAIL_PORT` | `587` | SMTP port. |
| `EMAIL_SECURE` | `false` | `true` for implicit TLS (465). |
| `EMAIL_USER` | unset | SMTP username. |
| 🔒 `EMAIL_PASS` | unset | SMTP password. |
| `EMAIL_FROM` | `noreply@smart-cam.local` | From address. |

## Payments

| Variable | Default | Description |
|---|---|---|
| 🔒 `STRIPE_SECRET_KEY` | **required** | Stripe API secret. |
| 🔒 `STRIPE_WEBHOOK_SECRET` | **required** | Stripe webhook signature secret. |
| `RAZORPAY_KEY_ID` | **required** | Razorpay key ID. |
| 🔒 `RAZORPAY_KEY_SECRET` | **required** | Razorpay key secret. |
| 🔒 `RAZORPAY_WEBHOOK_SECRET` | **required** | Razorpay webhook signature secret. |

## Streaming lifecycle tuning

Operational knobs that protect fragile remote NVRs. The hard rule from the
2026-07-06 NVR flood incident still applies: **≤6 concurrent pulls per NVR, never
record-all.** These defaults are deliberately generous — remote NVRs over the public
internet have ~100 ms latency, and tight windows let one bad poll cascade
`STREAMING → DEGRADED → OFFLINE → CONNECTING` in a few ticks and arm a needless heal.

### Supervisor (`streamSupervisor.service.js`)

| Variable | Default | Description |
|---|---|---|
| `SUPERVISOR_POLL_MS` | `2000` | Poll interval for per-path stream metrics. |
| `SUPERVISOR_MIN_BPS` | `20000` | Bitrate floor (20 kbps) below which a path counts as unhealthy. |
| `SUPERVISOR_DEGRADED_AFTER_MS` | `20000` | Unhealthy duration before marking DEGRADED. |
| `SUPERVISOR_OFFLINE_AFTER_MS` | `40000` | Unhealthy duration before marking OFFLINE. |
| `SUPERVISOR_FLAP_WINDOW_MS` | `120000` | Window over which state flaps are counted. |
| `SUPERVISOR_FLAP_LIMIT` | `5` (Compose: `4`) | Flaps within the window before quarantine. |
| `SUPERVISOR_QUARANTINE_MS` | `300000` (Compose: `600000`) | How long a flapping camera stays quarantined — stop poking a struggling NVR and let its RTSP daemon recover. |
| `SUPERVISOR_LEADER_TTL_MS` | `15000` | Redis leader-lock TTL; only the leader instance drives the supervisor. |

### Stream quality / self-heal (`streamQuality.service.js`)

| Variable | Default | Description |
|---|---|---|
| `QUALITY_WINDOW_SAMPLES` | `30` | Rolling sample window (~60 s at a 2 s tick). |
| `QUALITY_HEAL_AFTER_MS` | `30000` | Sustained-bad duration before a heal is armed. |
| `QUALITY_HEAL_FIE_RATE` | `50` | Frames-in-error/sec that triggers a heal. |
| `QUALITY_WARN_FIE_RATE` | `5` | Frames-in-error/sec that raises a warning. |
| `QUALITY_WARN_JITTER_MS` | `200` | Jitter threshold for a warning. |
| `QUALITY_HEAL_COOLDOWN_MS` | `60000` | Base cooldown between heals for one camera. |
| `QUALITY_HEAL_COOLDOWN_MAX_MS` | `900000` | Cap on the exponential cooldown backoff (15 min). |
| `QUALITY_HEAL_BUDGET_24H` | `20` | Max heals per camera per rolling 24 h. |
| `QUALITY_NVR_RECONNECT_MIN_MS` | `30000` | Minimum gap between re-binds targeting one NVR. |

### Path reconciliation (`streamReconcile.service.js`)

| Variable | Default | Description |
|---|---|---|
| `RECONCILE_ENABLED` | on (`0` disables) | Reconcile DB cameras against Stream Service paths. |
| `RECONCILE_INTERVAL_MS` | `60000` | Full reconcile interval. |
| `RECONCILE_CONCURRENCY` | `8` | Parallel path operations per pass. |
| `RECONCILE_DEBOUNCE_MS` | `1500` | Coalesces change events so a restart re-adding 2000 paths triggers one reconcile, not 2000. |

### Reachability & device probes

| Variable | Default | Description |
|---|---|---|
| `CAMERA_PROBE_INTERVAL_MS` | `25000` | Per-NVR/host TCP reachability probe interval. |
| `CAMERA_PROBE_TIMEOUT_MS` | `5000` | Probe connect timeout. |
| `CAMERA_PROBE_PORT` | `554` | Default RTSP port probed when the camera doesn't specify one. |
| `DEVICE_PROBE_TIMEOUT_MS` | `5000` | Timeout for vendor ISAPI/CGI capability probes during onboarding. |

## Legacy (accepted, no longer used)

Kept in the Joi schema so existing `.env` files don't fail validation. No active
service reads these values.

| Variable | Default |
|---|---|
| `SHINOBI_URL` | `http://localhost:8443` |
| `SHINOBI_API_KEY` | `''` |
| `SHINOBI_GROUP_KEY` | `''` |
| `SHINOBI_SUPER_API_KEY` | `''` |

---

# AI service — `smart-cam-ai` (`vms_face`)

Configured with **pydantic-settings** (`config/settings.py`), `case_sensitive=False` —
each field maps to the upper-cased env var name shown below. `assert_consistent()` runs
at process startup and fails loudly on incompatible combinations (notably
`PIPELINE_BATCHED_INFERENCE=true` with an InsightFace/ArcFace recognizer, because the
batched detect path never runs buffalo_l's bundled ArcFace head).

## Service & datastores

| Variable | Default | Description |
|---|---|---|
| `VMS_ENV` | `dev` | `dev` \| `stage` \| `prod`. Setting `prod` disables the JWT dev bypass regardless of the flag. |
| `VMS_LOG_LEVEL` | `INFO` | structlog level. |
| 🔒 `POSTGRES_DSN` | `postgresql+asyncpg://vms:vms@localhost:5432/vms_face` | Async DSN (contains credentials). |
| 🔒 `POSTGRES_DSN_SYNC` | `postgresql+psycopg2://vms:vms@localhost:5432/vms_face` | Sync DSN for workers/migrations. |
| `QDRANT_URL` | `http://localhost:6333` | Vector DB endpoint. |
| 🔒 `QDRANT_API_KEY` | unset | Qdrant API key when secured. |
| `QDRANT_COLLECTION` | `faces` | Legacy single-collection fallback. |
| `QDRANT_COLLECTION_ENROLLED` | `vms_enrolled` | Small/hot enrolled gallery collection. |
| `QDRANT_COLLECTION_APPEARANCE` | `vms_appearance` | Large time-partitioned appearance log. Sharing one collection is wrong above ~1M points. |
| `QDRANT_APPEARANCE_ENABLED` | `true` | Write appearance vectors. |
| `QDRANT_VECTOR_SIZE` | `512` | Embedding dimensionality. |
| `QDRANT_DISTANCE` | `Cosine` | `Cosine` \| `Dot` \| `Euclid`. |
| `REDIS_URL` | `redis://localhost:6379/0` | Streams, cam-state pub/sub, RQ. |
| `REDIS_STREAM_DETECTIONS` | `vms.detections` | Detection stream key. |
| `REDIS_STREAM_ALERTS` | `vms.alerts` | Alert stream key. |
| `REDIS_STREAM_DETECTIONS_DLQ` | `vms.detections.dlq` | Dead-letter stream. |
| `REDIS_CONSUMER_GROUP` | `match-workers` | Match-worker consumer group. |
| `REDIS_CAM_STATE_CHANNEL` | `vms.cam.state` | Per-frame camera state channel. |
| `REDIS_CAM_STATE_KEY_PREFIX` | `vms:cam:state:` | Per-camera state key prefix. |
| `REDIS_CAM_STATE_TTL_SEC` | `30` | TTL of a camera-state key. |
| `MINIO_ENDPOINT` | `localhost:9000` | Object store for snapshots/enrollments. |
| 🔒 `MINIO_ACCESS_KEY` | `minioadmin` | Rotate off the default. |
| 🔒 `MINIO_SECRET_KEY` | `minioadmin` | Rotate off the default. |
| `MINIO_SECURE` | `false` | Use TLS to MinIO. |
| `MINIO_BUCKET_SNAPSHOTS` | `vms-snapshots` | Event snapshot bucket. |
| `MINIO_BUCKET_ENROLLMENTS` | `vms-enrollments` | Enrolled-face bucket. |
| `MINIO_BUCKET_OUTPUT` | `vms-person-tracker` | Journey stitch artifacts (MP4/PDF/map). |
| `KAFKA_BOOTSTRAP_SERVERS` | `''` | Journey event spine. Empty = no-op producer (dev-safe). |
| `KAFKA_TOPIC_JOURNEY_EVENTS` | `journey.events` | Journey topic. |
| `TIMESCALEDB_ENABLED` | `true` | Create the hypertable on `detection_events` when the extension exists. |

## Auth (JWT HS256) & tenancy

| Variable | Default | Description |
|---|---|---|
| 🔒 `VMS_JWT_SECRET` | `''` | HS256 signing secret. **Secrets under 32 chars are treated as unset.** Must equal the backend's `AI_JWT_SECRET`. |
| `VMS_JWT_ALGORITHM` | `HS256` | Signing algorithm. |
| `VMS_JWT_ISSUER` | `drisyam-vms` | Expected `iss`. |
| `VMS_JWT_AUDIENCE` | `drisyam-vms` | Expected `aud`. |
| `VMS_JWT_LEEWAY_SEC` | `30` | Clock-skew leeway. |
| `VMS_JWT_DEV_BYPASS` | `false` | When `true` **and** `VMS_ENV=dev`, unauthenticated requests become the default tenant's anonymous principal. **Never enable in production** — every route becomes open. |
| 🔒 `LEGACY_API_KEY` | `''` | Shared `X-API-Key` for the legacy `/set-camera`, `/upload`, `/logs`, `/status`, `/ws` router. Empty disables the legacy router. |
| 🔒 `VMS_CAMERA_CRED_KEY` | `''` | base64 32-byte AES-256-GCM key encrypting `rtsp_url` at rest. Unset = plaintext (legacy rows still readable). |
| `DEFAULT_TENANT_NAME` | `drisyam-default` | Tenant used by the legacy compat path. |

## Recognition models & thresholds

| Variable | Default | Description |
|---|---|---|
| `RECOGNIZER_BACKEND` | `insightface` | `insightface` (buffalo_l ArcFace head) or `adaface`. **Embeddings are not interchangeable — switching requires re-enrolling every face.** |
| `ADAFACE_MODEL_PATH` | `''` | ONNX path when using AdaFace. |
| `RECOGNIZER_ADAFACE_THRESHOLD` | `0.35` | AdaFace cosine threshold (AdaFace sits at ~0.30–0.45 for same-identity). |
| `INSIGHTFACE_MODEL` | `buffalo_l` | InsightFace model pack. |
| `INSIGHTFACE_DET_SIZE` | `960` | SCRFD input size. |
| `INSIGHTFACE_CTX_ID` | `0` | GPU index. |
| `INSIGHTFACE_PROVIDERS` | `CUDAExecutionProvider,CPUExecutionProvider` | ONNX Runtime provider order. Cannot be empty. |
| `INSIGHTFACE_DET_THRESHOLD` | `0.5` (Compose: `0.7`) | Detection confidence. 0.5 produces phantom tracks on noisy cameras; 0.7 keeps real faces and rejects most noise. |
| `INSIGHTFACE_REC_THRESHOLD` | `0.62` (Compose: `0.45`) | ArcFace 1:N cosine threshold. CCTV crops match a studio gallery at ~0.30–0.50, so 0.62 rejects most live matches. |
| `MATCH_TOP1_MARGIN` | `0.06` | Crowd false-positive guard: assert a match only when top-1 beats the nearest *different* identity by this cosine margin. `0` disables. |
| `INSIGHTFACE_CUDA_RETRY_SEC` | `60.0` | Cooldown before retrying CUDA after a provider failure. `0` latches to CPU. |
| `INSIGHTFACE_LOAD_AUX_LANDMARKS` | `false` | Load buffalo_l's 2d106det/1k3d68 heads. Off saves ~150 MB GPU and 3–5 ms/face. |
| `MATCH_MIN_QUALITY` | `0.58` (Compose: `0.25`) | Composite quality floor for 1:N match. |
| `MATCH_MIN_FACE_PX` | `80` (Compose: `15`) | Minimum face short side in px for match. |
| `MATCH_MIN_BLUR_VAR` | `30.0` (Compose: `8.0`) | Minimum Laplacian variance for match. |
| `API_WARMUP_FACE_RUNTIME` | `false` | Eagerly load FaceRuntime in the API process. Off saves ~600 MB GPU when orchestrators run separately. |

### Batched ONNX inference

| Variable | Default | Description |
|---|---|---|
| `PIPELINE_BATCHED_INFERENCE` | `false` | Coalesce in-flight detect/embed across cameras into one ONNX call (3–5× detect, ~2× embed throughput). Incompatible with the InsightFace recognizer. |
| `BATCH_DETECT_MAX` | `8` | Max detect batch size. |
| `BATCH_DETECT_WINDOW_MS` | `3.0` | Detect coalescing window. |
| `BATCH_EMBED_MAX` | `16` | Max embed batch size. |
| `BATCH_EMBED_WINDOW_MS` | `2.0` | Embed coalescing window. |

### Quality gate

| Variable | Default | Description |
|---|---|---|
| `QUALITY_MIN_FACE_PX` | `40` | Minimum face size admitted by the gate. |
| `QUALITY_MIN_DET_SCORE` | `0.6` | Minimum detector score. |
| `QUALITY_MAX_BLUR_VAR` | `0.0` | Blur ceiling (`0` = disabled). |
| `QUALITY_MAX_YAW_DEG` | `45.0` | Max head yaw. |
| `QUALITY_MAX_PITCH_DEG` | `30.0` | Max head pitch. |
| `QUALITY_MIN_BRIGHTNESS` | `15.0` | Minimum mean brightness. |
| `QUALITY_MAX_BRIGHTNESS` | `240.0` | Maximum mean brightness. |

### Tracking & track-level pooling

| Variable | Default | Description |
|---|---|---|
| `TRACKER_IOU_THRESHOLD` | `0.3` | SORT IoU gate. |
| `TRACKER_MAX_AGE` | `30` | Frames a track survives unmatched. |
| `TRACKER_MIN_HITS` | `3` | Hits before a track is confirmed. |
| `TRACKER_APPEARANCE_WEIGHT` | `0.4` | Weight of the cosine appearance term (`0` = pure SORT). Higher over-weights appearance and causes ID switches under occlusion. |
| `TRACKER_APPEARANCE_ALPHA` | `0.7` | EWMA factor for the per-track smoothed embedding. |
| `TRACK_POOL_TOP_K` | `5` | Best crops pooled per track for multi-frame fusion. |
| `TRACK_MIN_HITS_TO_MATCH` | `3` (Compose: `2`) | Confirmed hits before a track is matched. Lower = faster name pop-in on low-fps CCTV. |
| `TRACK_POOL_MIN_QUALITY` | `0.30` | Quality floor for pool admission; `0` disables. |

### Face attributes (gender / age)

| Variable | Default | Description |
|---|---|---|
| `FACE_ATTRIBUTES_ENABLED` | `true` | Per-track quality-weighted gender/age voting. |
| `INSIGHTFACE_ONDEMAND_GENDERAGE` | `true` | Run the genderage head on demand per track. The **only** way gender works when `PIPELINE_BATCHED_INFERENCE=true`. |
| `ATTRIBUTES_MIN_FACE_PX` | `48` | Faces smaller than this don't vote. |
| `ATTRIBUTES_MIN_VOTES` | `3` | Samples required before asserting a label. |
| `ATTRIBUTES_MAX_VOTES` | `8` | Sampling cap per track. |
| `ATTRIBUTES_MIN_AGREEMENT` | `0.70` | Weighted-mass agreement needed to assert. |

## Pipeline & ingest tuning

| Variable | Default | Description |
|---|---|---|
| `AI_INGEST_BACKEND` | `opencv` | `opencv` \| `deepstream`. |
| `TARGET_FPS` | `8.0` | Per-camera processing rate. |
| `EMBED_EVERY_N_FRAMES` | `5` | Embed cadence. |
| `SNAPSHOT_TOP_K_PER_TRACK` | `3` | Snapshots kept per track. |
| `PIPELINE_FACE_CONCURRENCY` | `8` | Max in-flight per-face tasks within one frame's fan-out. Tune alongside `VMS_GPU_POOL_SIZE`. |
| `PIPELINE_FRAME_TIMEOUT_SEC` | `1.5` (Compose: `15.0`) | Per-frame read deadline before the RTSP stream is reopened. On-demand pulls plus long GOPs need far more than the default. |
| `PIPELINE_RTSP_REOPEN_BACKOFF_SEC` | `2.0` | Initial reopen backoff. |
| `PIPELINE_RTSP_REOPEN_MAX_BACKOFF_SEC` | `30.0` | Max reopen backoff. |
| `RTSP_HWACCEL` | `''` | `cuda` uses NVDEC — requires an FFmpeg built with `--enable-cuvid`; the stock apt FFmpeg silently no-ops. |
| `RTSP_DROP_OLD_FRAMES` | `true` | Decoder thread keeps a single "latest frame" slot so a slow consumer can't accumulate buffer lag. |
| `RTSP_MAX_DELAY_SEC` | `1.0` | PyAV demuxer `max_delay`. |
| `RESTART_ONLINE_STREAMS_ON_STARTUP` | `false` (Compose: `true`) | Restart every previously-online camera at boot. |
| `CACHE_BACKEND` | `redis` | `local` (in-process only) or `redis` (multi-process shared overlay — the documented deployment). |
| `VMS_INGEST_POOL_SIZE` | `256` | RTSP I/O thread pool (~256 cameras/process). Floor 8. |
| `VMS_GPU_POOL_SIZE` | `4` | Inference dispatch threads. GPU work serializes anyway; more threads just add lock contention. Floor 1. |
| `VMS_IO_POOL_SIZE` | `32` | General blocking I/O pool (snapshot upload, sync DB). Floor 4. |

### Person detection (YOLOv8, optional)

| Variable | Default | Description |
|---|---|---|
| `PIPELINE_PERSON_DETECTION_ENABLED` | `false` | Count full-body presence so back-of-head/occluded people register. |
| `PIPELINE_PERSON_MODEL_PATH` | `''` | Absolute path to `yolov8n.onnx` (~6 MB). |
| `PIPELINE_PERSON_THRESHOLD` | `0.35` | Person confidence threshold. |
| `PIPELINE_PERSON_DET_SIZE` | `640` | Detector input size. |
| `PIPELINE_PERSON_DETECT_EVERY_N_FRAMES` | `2` | Detect cadence. |

### Motion gate (skip detection on static scenes)

| Variable | Default | Description |
|---|---|---|
| `MOTION_GATE_ENABLED` | `false` | Cheap CPU frame-diff before the detector. On quiet cameras this eliminates 70–95% of detect GPU. Never skips while tracks are alive. |
| `MOTION_GATE_DOWNSCALE_WIDTH` | `160` | Width used for the difference check (~0.2 ms/frame). |
| `MOTION_GATE_PIXEL_DELTA` | `26` | Per-pixel intensity delta counted as changed. |
| `MOTION_GATE_MIN_CHANGED_FRAC` | `0.004` | Fraction of pixels that must change to count as motion. |
| `MOTION_GATE_MAX_SKIP_FRAMES` | `15` | Hard ceiling on consecutive skipped detects (~2 s at 8 fps). |

### Snapshots & face enhancement

| Variable | Default | Description |
|---|---|---|
| `SNAPSHOT_PUMP_QUEUE_SIZE` | `256` | Bounded upload queue; overflow drops the oldest (best-effort by design). |
| `SNAPSHOT_PUMP_WORKERS` | `2` | Upload consumer tasks. |
| `SNAPSHOT_JPEG_QUALITY` | `80` | JPEG quality for snapshots. Raise to 88–92 only for evidence-grade needs. |
| `SNAPSHOT_AUTO_ENHANCE` | `false` | POST each face crop to face-reconstruct before upload. Falls back to the original on any failure. |
| `SNAPSHOT_AUTO_ENHANCE_FIDELITY` | `0.5` | Fidelity weight (0–1); lower = more aggressive restoration. |
| `FACE_RECONSTRUCT_URL` | `http://face-reconstruct:8002` | Enhancement service URL. |
| `WATCHLIST_AUTO_ENHANCE` | `false` | Enhance watchlist-hit snapshots; the original key is preserved for the audit chain. |
| `WATCHLIST_AUTO_ENHANCE_FIDELITY` | `0.6` | Fidelity weight for watchlist hits. |
| `ENROLLMENT_AUTO_ENHANCE` | `false` | Enhance gallery thumbnails post-upload. |
| `ENROLLMENT_AUTO_ENHANCE_FIDELITY` | `0.7` | Fidelity weight. |
| `FACE_LEARNING_AUTO_ENHANCE` | `false` | Enhance face-learning sample thumbnails. |
| `FACE_LEARNING_AUTO_ENHANCE_FIDELITY` | `0.7` | Fidelity weight. |

## Backend bridge (overlay + alerts)

Without this bridge, detection works but no box ever reaches the player. The overlay
path is **ephemeral** (fanned out on the `ai.live` socket and dropped, never persisted)
— deliberately not the `ai_events` path, which flooded the alerts panel.

| Variable | Default | Description |
|---|---|---|
| `BACKEND_FORWARD_ENABLED` | `true` | Forward per-frame boxes to the backend live overlay. |
| `BACKEND_URL` | `''` | e.g. `http://smart-cam-backend:5000`. |
| 🔒 `SERVICE_TOKEN` | `''` | `X-Service-Token` for `/api/internal/*`. Must match the backend's `SERVICE_TOKEN`. |
| `BACKEND_OVERLAY_MIN_INTERVAL_SEC` | `0.2` | Per-camera overlay rate (~5/s keeps boxes smooth). |
| `BACKEND_OVERLAY_MIN_GENDER_CONF` | `0.85` | Gender is shown on the overlay only above this vote confidence — higher than the assertion floor, because a wrong M/F reads worse than none. Age is never shown. |
| `BACKEND_FORWARD_CAMERA_REFRESH_SEC` | `30.0` | Refresh interval for the monitorId → userId map. |
| `BACKEND_FORWARD_MAX_BOXES_PER_FRAME` | `20` | Cap so a crowd scene can't burst the backend. |
| `BACKEND_ALERT_FORWARD_ENABLED` | `true` | Forward `vms.alerts` (watchlist/blacklist/unknown) to `/api/internal/ai/events` → in-app alerts + push. |
| `BACKEND_ALERT_COOLDOWN_SEC` | `120.0` | Per-(user, camera, kind, subject) cooldown so a person in view doesn't create one row per frame. |

## Match worker, ReID & face learning

| Variable | Default | Description |
|---|---|---|
| `MATCH_WORKER_CONCURRENCY` | `32` | In-flight match tasks per worker. |
| `MATCH_WORKER_AUTOCLAIM_MIN_IDLE_MS` | `60000` | Idle time before a pending stream entry is reclaimed. |
| `MATCH_WORKER_AUTOCLAIM_INTERVAL_SEC` | `15.0` | Autoclaim sweep interval. |
| `MATCH_WORKER_APPEARANCE_LOG` | `true` | Write appearance vectors for forensic journey search. |
| `REID_WORKER_ENABLED` | `true` | Cross-camera ReID worker. |
| `REID_CONSUMER_GROUP` | `reid-workers` | Separate group from match-workers (shares the stream, not the work). |
| `REID_WINDOW_SEC` | `600` | Window in which a face on camera B can link to a prior appearance on camera A. |
| `REID_MIN_SIMILARITY` | `0.55` | Cosine floor for emitting a track link. |
| `REID_TOP_K` | `10` | Appearance hits inspected per candidate. |
| `REID_SAME_CAMERA_DEDUP_SEC` | `30` | Suppress same-camera links inside this gap (the local tracker already merges those). |
| `FACE_LEARNING_ENABLED` | `true` | Queue high-quality CCTV crops from confirmed matches for operator approval. |
| `FACE_LEARNING_MIN_SIMILARITY` | `0.68` (Compose: `0.50`) | Match similarity required to queue a sample. |
| `FACE_LEARNING_MIN_QUALITY` | `0.60` (Compose: `0.45`) | Quality floor. |
| `FACE_LEARNING_MIN_FACE_PX` | `96` (Compose: `60`) | Size floor. |
| `FACE_LEARNING_MIN_BLUR_VAR` | `45.0` (Compose: `20.0`) | Blur floor. |
| `FACE_LEARNING_MAX_SAMPLES_PER_TRACK` | `6` | Cap per track. |
| `FACE_LEARNING_MAX_PENDING_PER_PERSON` | `100` | Cap on the pending review queue per person. |
| `FACE_LEARNING_DUPLICATE_SIMILARITY` | `0.985` | Above this, a sample is a near-duplicate and is dropped. |

## Journey reconstruction (forensic search + stitch)

| Variable | Default | Description |
|---|---|---|
| `DISPLAY_TIMEZONE` | `Asia/Kolkata` | Timezone for server-baked labels (video overlay, PDF, map). Storage and lookup stay UTC. |
| `RECORDINGS_ROOT` | `/recordings` | Read-only mount of the Stream Service recordings tree. |
| `JOURNEY_DEFAULT_WINDOW` | `7d` | Default forensic search window. |
| `JOURNEY_SIMILARITY_THRESHOLD` | `0.50` | Appearance ANN cosine floor. |
| `JOURNEY_SEARCH_TOP_K` | `5000` | Max appearance hits per search. |
| `JOURNEY_CLUSTER_WINDOW_SEC` | `30` | Same-camera sighting cluster gap. |
| `JOURNEY_BODY_LOGGING` | `false` (Compose: `true`) | Log clothing upper/lower colour per detection so body fusion works on historical data. Adds OpenCV cost per detection. |
| `BODY_MODEL_PATH` | `.../osnet_x1_0_msmt17.onnx` | OSNet body-ReID ONNX (256×128 in, 512-d out). Missing file = clothing-colour fusion only. |
| `CLIP_PAD_BEFORE_SEC` | `2` | Clip lead-in. |
| `CLIP_PAD_AFTER_SEC` | `4` | Clip lead-out. |
| `CLIP_MAX_SEC` | `20` | Per-sighting clip cap — keeps a long linger from ballooning the journey video. |
| `STITCH_MAX_CLIPS` | `12` | Max stops in the stitched highlight reel. |
| `STITCH_MAX_TOTAL_SEC` | `600` | Total stitched duration budget. |
| `STITCH_QUEUE_NAME` | `vms.stitch` | RQ queue for stitch jobs. |
| `STITCH_JOB_TIMEOUT_SEC` | `1800` | RQ job timeout. |
| `STITCH_FONT_PATH` | `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf` | Overlay font. |

## Retention (DPDP) & metrics

| Variable | Default | Description |
|---|---|---|
| `RETENTION_WORKER_ENABLED` | `true` | Run the AI-side retention worker. |
| `RETENTION_WORKER_INTERVAL_SEC` | `3600.0` | Sweep interval. |
| `RETENTION_EVENT_DAYS` | `90` | Detection-event retention. |
| `RETENTION_SNAPSHOT_DAYS` | `7` | Snapshot retention. |
| `RETENTION_AUDIT_LOG_DAYS` | `365` | Audit-log retention. |
| `SYSTEM_METRICS_ENABLED` | `true` | System metrics poller. |
| `SYSTEM_METRICS_INTERVAL_SEC` | `5.0` | Poll interval. |

## API & observability

| Variable | Default | Description |
|---|---|---|
| `API_HOST` | `0.0.0.0` | Bind address. |
| `API_PORT` | `8001` | Listen port. |
| `API_CORS_ORIGINS` | `*` | Comma-separated origins, or `*`. |
| `VMS_OTEL_ENABLED` | `false` | OpenTelemetry tracing (no-op tracer when off, zero overhead). |
| `VMS_OTEL_ENDPOINT` | `''` | e.g. `http://otel-collector:4317`. |
| `VMS_OTEL_SERVICE_NAME` | `vms_face` | Service name in traces. |
| `VMS_OTEL_SAMPLE_RATIO` | `1.0` | 0.0–1.0; 1.0 traces every span. |

## Legacy compat (drives `AiFeed.jsx`)

| Variable | Default | Description |
|---|---|---|
| `MEDIAMTX_RTSP_HOST` | `localhost` | Host used when auto-creating a camera from `/set-camera`. |
| `MEDIAMTX_RTSP_PORT` | `8554` | Port for the same. |
| `MEDIAMTX_RTSP_TEMPLATE` | `rtsp://{host}:{port}/cam_{monitor_id}` | RTSP URL template. |
| `LEGACY_SINGLE_ACTIVE_CAMERA` | `true` (Compose: `false`) | Allow only one active camera on the legacy path. |
| `KNOWN_FACES_DIR` | `/srv/app/face_detection/insightface-master/known_faces` | Folder walked at API startup; every image found is enrolled into the default tenant's gallery. Compose points this at the bind-mounted `vms_face/data/known_faces`. |

---

# Frontend — `smart-cam-app/.env` / `.env.production`

Vite inlines these at **build time**; changing them requires a rebuild, not a restart.
New pages must import from `src/core/config/endpoints.js` rather than reading
`import.meta.env` directly.

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:5000` | Backend gateway base (no `/api` suffix — `endpoints.js` appends it). |
| `VITE_AI_BASE_URL` | `http://localhost:8001` | smart-cam-ai base. In production this is the same-origin nginx proxy `/ai/` so port 8001 stays internal. Also derives the `/ws` URL. |
| `VITE_STREAM_SERVICE_WEBRTC_BASE` | `http://localhost:8889` | WHEP host; per-camera path is `${base}/cam_<monitorId>/whep`. |
| `VITE_MEDIAMTX_WEBRTC_BASE` | — | Legacy alias for the above, used only if the `STREAM_SERVICE` name is unset. |
| `VITE_API_BASE` | — | Used by the `ai-analytics` module's API client. |
| `VITE_SHINOBI_URL` | — | Legacy Shinobi URL; unused in the current stack. |

> Never put a secret in a `VITE_*` variable — everything prefixed `VITE_` is compiled
> into the JavaScript bundle and is public.

---

## Applying changes

| Deployment | How to apply |
|---|---|
| Docker Compose | `docker compose -p drisyam-original -f docker-compose.drisyam-original.yml up -d <service>` (Compose `environment:` entries override `.env` values from `env_file`). |
| PM2 | `pm2 restart all --update-env` — without `--update-env` PM2 keeps the old environment. |
| Frontend | Rebuild the SPA; `VITE_*` values are baked into the bundle. |
