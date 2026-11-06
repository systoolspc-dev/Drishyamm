# Drishyam VMS — System Design

> **Status:** Current as of 2026-08-05. This document supersedes the earlier Shinobi-era design.
> Drishyam no longer uses Shinobi; the media plane is a MediaMTX-based **Drishyam Stream Service**,
> and the platform now includes a multi-tenant AI analytics service, a mobile app, and an
> edge-connectivity layer.

---

## 1. Overview

**Drishyam** is an enterprise, multi-tenant **Video Management System (VMS)** with an integrated
**AI analytics** platform. It ingests RTSP from IP cameras / NVRs / DVRs, delivers sub-second live
video and recorded playback to a web console and a mobile app, records to cloud object storage, and
runs face recognition, person-journey reconstruction, restricted-zone intrusion, occupancy/footfall,
and activity analytics on the same feeds.

**Core capabilities**

- Multi-tenant SaaS: organization = account owner + sub-users, with capability-based RBAC.
- Live streaming over **WebRTC (WHEP)** with **HLS** fallback; sub-stream grids, main-stream single view.
- Continuous + on-demand recording to disk, tiered to **10 PB S3** (NetForChoice), with per-camera / group / site **retention**.
- AI suite (opt-in per camera, entitlement-gated): face watchlist, cross-camera person journey, restricted zones, headcount/occupancy, footfall, activity/productivity, live tracker, ANPR (frontend), weapon/aggression (frontend scaffolding).
- Three camera-connectivity models: **direct RTSP**, **DDNS**, and **outbound edge-relay** (for NAT/CGNAT sites).
- Subscription billing (Stripe + Razorpay) plus admin-issued enterprise **licenses**.
- Mobile app (React Native + Expo) with live wall, single-camera view, and push alerts.

**Design themes**

- **The database is the source of truth.** The Stream Service holds no persistent config; watchdog/reconcile loops continuously re-converge it.
- **Separation of planes** — user, service, AI, and media each have their own auth boundary.
- **On-demand by default** — idle cameras don't pull video; a per-NVR reachability probe keeps them "online" (STANDBY).
- **Pluggable engines** — the streaming backend sits behind a `StreamingEngine` contract; the AI recognizer is swappable (ArcFace / AdaFace).

---

## 2. High-Level Architecture

```mermaid
flowchart TB
  subgraph Clients
    WEB[Web Console<br/>React 19 / Vite / Tailwind]
    MOB[Mobile App<br/>React Native / Expo]
  end

  subgraph Edge[Ingress]
    CF[Cloudflare Tunnel<br/>cloudflared]
    NGX[nginx<br/>TLS at CF edge]
  end

  subgraph Backend[smart-cam-backend · Express 5 · :5000]
    API[REST API /api/*]
    WS[socket.io realtime]
    SVC[Services + background loops]
  end

  subgraph Media[Drishyam Stream Service · MediaMTX]
    MTX[(RTSP 8554 · WHEP 8889<br/>HLS 8888/8898 · API 9997)]
    TRX[Transcoder H265→H264]
    SFU[SFU Bridge → LiveKit]
  end

  subgraph AI[smart-cam-ai · FastAPI · :8001]
    ORCH[Per-camera orchestrator]
    MW[match / reid / stitch workers]
  end

  subgraph Data[Datastores]
    MYSQL[(MySQL 8.4<br/>VMS metadata)]
    PG[(Postgres + pgvector<br/>vms_face)]
    QD[(Qdrant<br/>face + appearance vectors)]
    MINIO[(MinIO / S3 10PB<br/>recordings + crops)]
    REDIS[(Redis<br/>cache · bus · queues)]
    KAFKA[(Kafka<br/>event bus)]
  end

  CAMS[IP Cameras / NVR / DVR<br/>Hikvision · Dahua · CP Plus · Uniview · Axis · Bosch · Hanwha]

  WEB & MOB --> CF --> NGX --> API
  NGX -->|/whep /hls| MTX
  API --> SVC --> MTX
  CAMS -->|RTSP pull / edge push| MTX
  MTX --> TRX --> MTX
  MTX --> SFU
  MTX -->|RTSP sub| ORCH
  ORCH --> REDIS --> MW
  MW --> PG & QD & MINIO
  SVC --> MYSQL & REDIS & MINIO
  AI -->|overlay + events| API
```

---

## 3. Component Inventory

| Component | Dir | Stack | Port(s) | Role |
|---|---|---|---|---|
| Web console | `smart-cam-app` | React 19, Vite 7, Tailwind v4 | 5173 (dev) | Operator + admin UI |
| Mobile app | `drishyam_app` | React Native 0.86, Expo SDK 57 | — | Live wall, single view, push |
| Backend API | `smart-cam-backend` | Node, Express 5, Sequelize 6 | 5000 | VMS control plane |
| Stream Service | `stream-service` | MediaMTX (rebranded) | 8554/8888/8898/8889/9997/9998 | Media plane |
| Transcoder (sidecar) | in backend | ffmpeg (nvenc/qsv/amf/x264) | — | On-demand H.265→H.264 |
| Transcoder (GPU) | `smart-cam-transcoder` | Python/FastAPI + NVENC | 8004 | GPU normalize → `_clean` |
| SFU bridge | `smart-cam-sfu-bridge` | Python/FastAPI + WHIP | 8005 | Egress fan-out → LiveKit |
| AI service | `smart-cam-ai` | Python/FastAPI, ONNX Runtime | 8001 | Detection/recognition/analytics |
| AI worker | `smart-cam-ai` | Python | — | Match / reid / footfall |
| Journey stitch worker | `smart-cam-ai` | Python + RQ | — | Cross-camera stitch MP4/PDF |
| Face reconstruct | `smart-cam-ai/app/facerecounstruct` | CodeFormer + Real-ESRGAN | 8002 | Snapshot enhancement |
| Activity monitor | `smart-cam-ai/app/activity-monitor` | Python + YOLOv8-pose | 8010→8000 | Productivity + live tracker |
| Marketing site | `brand-site` | Static HTML | — | drishyam.io (Cloudflare/cPanel) |
| Observability | `observability` | Prometheus + Grafana | — | Metrics + dashboards |
| Edge relay | `edge-relay` | PowerShell + ffmpeg | — | Outbound RTSPS push from site LAN |

Primary compose file: **`docker-compose.drisyam-original.yml`** (production stack, containers prefixed
`drisyam-original-`). There is no `docker-compose.prod.yml`. Optional overlays:
`docker-compose.observability.yml`, `docker-compose.deepstream.yml`.

---

## 4. Data Model & Datastores

### 4.1 Datastores

| Store | Image / Port | Holds |
|---|---|---|
| **MySQL 8.4** | `mysql:8.4` · 3307→3306 | VMS metadata: users, cameras, groups, sites, subscriptions, licenses, alerts config, `ai_events` mirror |
| **Postgres + pgvector** | `pgvector/pgvector:pg16` · 5432 · DB `vms_face` | AI domain: persons, face_enrollments, tenants, detection_events, journeys, embeddings, footfall buckets, audit |
| **Qdrant** | `qdrant:v1.12.4` · 6333/6334 | Face + appearance vectors (`vms_enrolled`, `vms_appearance`) |
| **MinIO / S3** | `minio` · 9000/9001 (→ 10 PB S3) | Recordings, detection crops, enrollment thumbnails, stitch artifacts |
| **Redis 7** | `redis:7-alpine` · 6379 | Cache, pub/sub bus, Redis Streams, BullMQ queues |
| **Kafka 3.9** | `apache/kafka:3.9.0` · 9092 | Event streaming between AI producers/workers |

### 4.2 VMS relational model (MySQL, Sequelize)

All PKs are UUIDv4 `CHAR(36)`; columns are `underscored`; `User` is soft-deleted (paranoid).

- **User** — identity/account. `role` (tier), `scope` (JSON site/group RBAC), `parentUserId` (org root; NULL = owner), `customRoleId`, `isPlatformAdmin`, `emailVerified`. bcrypt (rounds 13). `accountOwnerId() = parentUserId || id`.
- **Plan** — subscription tier: `maxCameras`, `maxStorage`, `price`, gateway IDs, **`aiEnabled`** (authoritative AI gate).
- **Subscription** — user↔plan; `status`, period, gateway sub IDs, **`features`** JSON (curated AI subset; NULL = all plan AI features).
- **Payment** — one gateway charge (`gateway` stripe/razorpay, `status`).
- **Camera** — one channel: `monitorId`, RTSP `host/port/path/username/password` (**password AES-256-GCM**), `type`, `channel`, `retentionDays`, `streamQuality` (auto/main/sub), `settings` JSON, `mediamtxServerId`, and health fields (`supervisorState`, `bpsIn`, `lastSeenAt`, `flapCount24h`, `quarantineUntil`).
- **CameraGroup** — an NVR/DVR device (1 IP → many cameras): `host/httpPort/username/password` (**encrypted**), `deviceType` (validated against the vendor registry), `totalChannels`, retention/quality defaults. **Group creds take precedence over camera-level creds.**
- **Site** — physical location; `timezone`, `settings` JSON (inherited defaults).
- **StreamServer** (`mediamtx_servers`) — one Stream Service instance in the pool: API/HLS/WebRTC/RTSP URLs, `capacityCams`/`currentCams`, `headroom()`; nullable `siteId` = global default.
- **AIEvent** — persisted detection: `eventType`, `severity`, `bbox`, `trackId`, `confidence`, `payload`, `snapshotKey` (S3), `acknowledgedAt`.
- **DeviceToken** — Expo push registration. **AlertEmail** — per-user email recipient (`minSeverity`, `eventTypes`). **MailConfig** — singleton SMTP config (`password` encrypted).
- **RestrictedZone** — drawn no-entry area per `monitorId`: `shape`, normalized `points`/`rect`, `dwellSec`, `armWindow`, `allowed` categories.
- **Role** — account-defined custom RBAC role (`capabilities` JSON), overrides the built-in tier.
- **License / LicenseResource / LicenseFeature** — admin-issued enterprise licensing (status, term, `mrr`/`arr`, per-SKU quotas, per-feature flags). **PricingCatalog / Quote** — admin billing catalog + saved quotes.
- **RefreshToken** — DB-stored single-use rotating refresh tokens. **PasswordReset** — reset tokens.

### 4.3 AI domain (Postgres `vms_face`)

Every table carries an indexed `tenant_id` UUID: `tenants`, `persons` (unique `(tenant_id, external_id)`),
`face_enrollments` (1 row ↔ 1 Qdrant point, `snapshot_uri` = MinIO key), `cameras` (encrypted `rtsp_url`),
`detection_events` (time-series), `face_learning_samples`, `track_links`, `journeys` + `journey_stops`,
`camera_edges` (transit-time adjacency), `embeddings` (pgvector mirror, `Vector(512)`),
`footfall_minute_buckets`, `audit_log` (DPDP append-only).

**Qdrant** (cosine, 512-D L2-normed):
- **`vms_enrolled`** — hot gallery, one point per enrollment (`{tenant_id, person_id, full_name, role, recognizer}`) — the 1:N live-match target.
- **`vms_appearance`** — large time-partitioned appearance log, one point per detection — powers forensic journey search; pruned by retention on `occurred_at_ts`.

---

## 5. Backend (smart-cam-backend)

### 5.1 Stack & structure

Node + **Express 5**, **Sequelize 6** on **MySQL** (`mysql2`), `jsonwebtoken`, `bcryptjs`, `ioredis`,
`bullmq`, `socket.io`, AWS SDK v3 (S3), `stripe`/`razorpay`, `helmet`, `express-rate-limit`, `joi`,
`winston`, `prom-client`, `fluent-ffmpeg`, `nodemailer`.

`src/` → `routes/`, `controllers/`, `services/`, `models/`, `config/` (Joi-validated `env.js`,
`prodSecretGuard.js`), `middleware/` (`authenticate`, `authorize`, `adminAuth`, `serviceAuth`,
`requireCapability`, `requireAiCapability`, `rateLimiter`, `validate`), `utils/` (`aiTenant`,
`fieldCrypto`, `streamToken`, `digestAuth`, `semaphore`), `events/bus.js`, `queues/` (BullMQ).

### 5.2 Auth, RBAC & multi-tenancy

- **Access token** (15m, `JWT_SECRET`): `{ id, email, role, isPlatformAdmin }`; also accepted via `?token=` for `<video>`/direct media loads.
- **Refresh token** (7d, `JWT_REFRESH_SECRET`): persisted in `refresh_tokens`, **single-use rotation**, bulk-revoked on password change/reset.
- **Capabilities** (not raw roles): `view_live, view_playback, ack_alerts, manage_cameras, use_ai, manage_users, manage_settings`. Tiers `admin > manager > operator > viewer`; a custom `Role.capabilities` overrides the tier via `resolveCapabilities(user)`.
- **Organization** = account owner + sub-users; org root = `parentUserId || id`. Resource queries scope to `accountOwnerId()`, then narrow by `user.scope`. Sub-users created via `/api/manage`, log in by username.
- **Register** creates an account-owner (`role=admin`), whitelisting name/email/password only. `TIER_TO_PLAN = { basic_vms: 'Basic VMS', ai_vms: 'AI+VMS' }` (fallback `Free`), creates a trial Subscription, issues a token pair.

### 5.3 Entitlements

`services/entitlements.service.js` — the authoritative AI signal is the user's most-recent
**active/trialing** Subscription → `Plan.aiEnabled` (plus `Subscription.features`, NULL = all plan AI
features). `assertAiEntitled` (403), `getAiEntitledUserIds()` (bulk set for the runtime reconcile loop
that stops AI on downgraded accounts). The UI capability list hides AI when `!aiEnabled`, but backend AI
routes 403 regardless — the real boundary.

### 5.4 REST API surface (`/api`)

`/auth` (register/login/refresh/forgot/reset + me/profile/logout) · `/user` · `/groups` (camera & group
CRUD, device probe, retention & quality, S3 recordings list/play/stream/thumbnail/download) · `/stream`
(start/stop/status, ABR master playlist, `/verify` media-plane auth for nginx) · `/ai` (all AI features,
`requireAiCapability`) · `/internal` (service-to-service AI ingest/overlay/registry, `serviceAuth`) ·
`/subscription` · `/payment` (+ `/webhook` raw-body signature verify) · `/admin` (operator console:
cross-tenant stats, health, billing/licensing, SMTP config, transcode toggles) · `/notifications`
(push tokens) · `/person-tracker` (proxy) · `/turn` · `/livekit` · `/sites` (+ import) · `/cameras`
(health) · `/manage` (RBAC) · `/restricted-zones` · `/playback` (NVR replay) · `/health` · `/metrics`
· `/system` · `/openapi.yaml`.

`app.js`: `trust proxy 1`, Helmet, CORS allowlist, tight per-route body limits (10 kb default; webhook raw;
internal 2 mb; talkback raw), `apiLimiter`, Prometheus middleware, centralized error handler.

### 5.5 Security architecture (per-plane)

- **User plane** — short-lived access JWT + DB-backed single-use rotating refresh tokens.
- **Service plane** (`serviceAuth`) — `SERVICE_TOKEN` via `X-Service-Token`, constant-time compare, **fails closed** if unset.
- **AI plane** (`aiTenant.js`) — per-org HS256 JWT with `tid` so every AI datastore call is tenant-isolated (fixed a cross-tenant alert leak, 2026-07-29).
- **Media plane** (`streamToken.js`) — HMAC-SHA256 per-camera signed token (`monitorId:userId:expires`, `STREAM_URL_SECRET`) delivered as a path-scoped cookie, validated by nginx `auth_request` → `/api/stream/verify`, so anonymous Stream Service reads can't be watched via a leaked URL.
- **Field encryption** (`fieldCrypto.js`) — transparent **AES-256-GCM** for RTSP/SMTP passwords (`enc:v1:` tagged, tamper-detected, key = base64 of 32 bytes; mirrors AI `crypto.py`).
- **Config guard** (`prodSecretGuard.js`) — refuses to boot in production with weak/dev-default secrets; min-32-char JWT secrets required.

---

## 6. Streaming & Recording Subsystem

### 6.1 Drishyam Stream Service (MediaMTX)

`bluenviron/mediamtx` rebranded via a thin Docker wrapper (`stream-service/Dockerfile`); runtime config is
bind-mounted from `stream-service.yml`. No code fork.

| Function | Container | Exposure |
|---|---|---|
| RTSP ingest | 8554 | `8554` |
| HLS egress | 8888 | **8898** external (drisyam-original), internal 8888 |
| WebRTC (WHEP) | 8889 | `8889` |
| Control REST API | 9997 | **loopback only** (`127.0.0.1:9997`) |
| Prometheus metrics | 9998 | loopback only |
| RTSPS (TLS) | 8555 | **cloud instance only**, for edge-relay ingest (self-signed) |

Config highlights: `rtspTransports: [tcp]` forced (WAN/PoE reliability); `authMethod: internal` with a
`drishyam` API user (Basic Auth, `action: api`) and user `any` for anonymous publish/read (streams are
protected at the Express/nginx layer, not in MediaMTX); LL-HLS (`fmp4`, 2 s segments / 1 s parts, part ==
GOP for instant zap); global `record: no`, on-demand (`sourceOnDemandStartTimeout 30s`,
`sourceOnDemandCloseAfter 20s`). Dynamic paths are named **`cam_<monitorId>`** (sub: `cam_<monitorId>_sub`;
transcoded: `cam_<monitorId>_h264` / `_clean`).

### 6.2 Backend control plane

- **`streaming/StreamServiceEngine.js`** — the `/v3/config/paths` client (Basic Auth). `_putPath` = idempotent add-or-patch (POST add → on 400/409 PATCH), bounded retry on network/5xx only. `addCamera` builds the path config (`source`, `sourceOnDemand`, `record`, `recordPath`, `recordSegmentDuration`, `recordDeleteAfter`). **Recording deliberately runs on the sub-stream** (`addCameraSubStream`, default 7 d) — full-res continuous record knocked remote NVRs offline.
- **`streamRouter.service.js`** — pool-aware routing over `mediamtx_servers` (site-bound → global default → 503), atomic load counters, `buildRtspUrl` (URI-encodes password), `patchPath`, `removeCamera`.
- **`vendors/index.js`** — the **driver registry** (single source of truth): per-vendor default port, capabilities, probe/encoder/keyframe strategies, and `buildRtspPath` / `buildSubPath` / `deriveSubPath` / playback-path builders. Hikvision `/Streaming/Channels/{ch*100+1}` (sub +1), Dahua/CP Plus `?channel=N&subtype=0/1`, Uniview `/unicast/cN/s0|s1/live`, Axis `/axis-media/media.amp`, Bosch `?inst=1|2`, Hanwha `/profileN/media.smp`. Unknown vendor → `UnsupportedVendorError` (422), never a silent fallback.

### 6.3 Self-healing lifecycle (DB → Stream Service convergence)

- **`recordingSync.service.js`** — (a) S3 sync loop (every 5 min): ffprobes finished MP4 segments, stitches RTSP-reconnect fragments (`ffmpeg concat`), uploads to S3, deletes local; (b) **watchdog** (every 2 min): re-adds missing `cam_*` paths from the DB, reconciles orphans (2-pass confirm), probes the HLS muxer and cycles corrupted ones (with per-camera cooldown + **per-NVR reset rate-limit `NVR_RESET_MIN_MS`**), and syncs Camera online/offline.
- **`streamSupervisor.service.js`** — the primary status authority. Polls `/v3/paths/list` every 2 s, derives per-camera bitrate from byte deltas, runs the state machine **PENDING → CONNECTING → STREAMING / DEGRADED / STANDBY / OFFLINE / QUARANTINED**. `STANDBY` = reachable but unviewed (on-demand) → treated as online. `QUARANTINED` = 5 flaps / 120 s → 5-min backoff (persisted). Redis leader election so one instance drives it.
- **`streamReconcile.service.js`** — continuous retention-drift reconciler (PATCHes only drifted `recordDeleteAfter`).
- **`streamQuality.service.js`** — per-camera telemetry (jitter, `frames_in_error_rate`, readers) + active `heal()` (re-bind) with backoff, a 24 h heal budget, and **per-NVR reconnect rate-limit**. Also owns the per-camera `auto/main/sub` quality mode.
- **`cameraReachability.service.js`** — one TCP probe per distinct NVR host every 25 s → the "reachable-but-idle" signal that keeps on-demand cameras STANDBY (online).

**Going online:** browser requests a stream → path ensured → the viewer's HLS/WHEP fetch triggers the
on-demand RTSP pull → path becomes `ready` → supervisor sees bps > floor → STREAMING. Idle cameras stay
STANDBY via the reachability probe without pulling video.

### 6.4 Delivery

- **Single view:** WebRTC **WHEP** (sub-500 ms) primary, **HLS** (~2 s) fallback. (WHEP *is* WebRTC — it is the HTTP signaling that starts the WebRTC session, not a separate/lesser protocol.)
- **Grid:** sub-stream tiles (`cam_<id>_sub`, low bitrate, ~zero server CPU). `stream.service.js` builds an **ABR HLS master playlist** (High=main, Low=sub) — the sub variant is listed only when the Stream Service confirms `ready`.
- **H.265 → H.264:** Chrome can't decode HEVC via MSE. Two transcoders: the **in-backend on-demand sidecar** (`transcoder.service.js`, ffmpeg NVENC→QSV→AMF→x264, idle-shutdown, `MAX_CONCURRENT=8`, publishes `_h264`), and the **GPU normalizer** (`smart-cam-transcoder`, NVDEC→NVENC, publishes `_clean`).
- **SFU egress** (`smart-cam-sfu-bridge`) — per-camera ffmpeg pulls from MediaMTX and pushes **WHIP → LiveKit** (`-c copy`), one pull → many subscribers.

### 6.5 Recording, retention & playback

- Continuous 24/7 recording on the **sub-stream** by default; full-res only under `RECORD_CONTINUOUS=1`. Segmented MP4 (`10m0s`) to a bind-mounted volume.
- **Retention** (`recordingRetention.service.js`): effective days = Camera → Group → Site → env default (30) → applied as MediaMTX native `recordDeleteAfter` (days→hours); `streamReconcile` is the drift backstop.
- **Tiering:** `recordingSync` reads finished segments off disk, stitches, uploads to S3 key `recordings/<userId>/<group>/<camera>/<date>/…mp4`, deletes local. App playback of drisyam-owned recordings is **HLS from S3**.
- **NVR playback** (`playback.controller.js`): RTSP-replay of the NVR's *own* recordings (Hikvision `/Streaming/tracks`, Dahua `/cam/playback`) → backend ffmpeg → short-lived `pb_<monitorId>_<startMs>` MediaMTX path → HLS+WHEP. Range cap 6 h, hard-kill 30 min. Hikvision/Dahua/CP Plus only.

### 6.6 Camera connectivity models

1. **Direct RTSP** — MediaMTX pulls `rtsp://user:pass@host:554/<vendorPath>` (same-LAN or routed). On-demand pull is the same-LAN direct case.
2. **DDNS** — same direct pull with a DDNS hostname (requires a real public IP + port-forward; fails on CGNAT).
3. **Edge-relay** (`edge-relay/`) — a Windows PC on the NVR LAN runs per-channel ffmpeg that pulls locally and **pushes outbound** `rtsps://<cloud>:8555/<name>` (TLS). Traverses NAT/CGNAT/DPI with no public IP; self-healing loop; `-c copy` by default. Cloud cameras are then repointed to pull the pushed feed.

---

## 7. AI & Analytics (smart-cam-ai)

### 7.1 Layout

`app/` is a monorepo of independently deployable services. The flagship is
**`face_detection/vms_face/`** (FastAPI + workers). Others: `activity-monitor/` (productivity + live
tracker), `head-count/`, `human_detection/`, `deepstream_api/` (optional NVIDIA DeepStream ingest),
`facerecounstruct/` (face enhancement, :8002), plus legacy footfall. "person-tracker" and "zone-guard"
are **centralized into vms_face** (journey subsystem and `services/detection_zones.py` + `infra/person_detector.py`).

### 7.2 vms_face architecture

Layered: `api/` (FastAPI + routers), `config/settings.py` (pydantic-settings), `core/` (security, crypto,
logging, metrics, tracing, 3-pool executors), `domain/` (SQLAlchemy models, Pydantic schemas, enums),
`infra/` (postgres, qdrant, minio, redis_bus, insightface_runtime, batched_scrfd, person_detector,
backend forwarders, detection_state), `pipeline/` (orchestrator, ingest, deepstream_bridge), `services/`
(enrollment, face_matcher, face_tracker, footfall, detection_zones, reid, known_faces_bootstrap,
face_learning), `journey/` (search, cluster, fusion, stitch_jobs, video, pdf, body), `workers/`
(match/reid/retention/stitch), `eval/` (FRVT-style harness), `alembic/`.

**Models:** InsightFace **SCRFD** detector (`buffalo_l`, det_size 960), recognition pluggable —
**ArcFace** (512-D, cos 0.62) default or **AdaFace** (512-D, cos 0.35); gender/age via buffalo_l head
(on-demand, per-track vote); optional **YOLOv8n** person detector and **OSNet** body-ReID for journey fusion.

### 7.3 Multi-tenancy

JWT (HS256) minted upstream by the backend (`aiTenant.js`), verified by `core/security.py` — required
claims `iss/aud/sub/tid/iat/exp`; **`tid` is the tenant UUID and the sole source of scope** (never a query
string). All Qdrant searches force a `tenant_id` filter, so live 1:N matching only ranks against that
tenant's gallery. A dev bypass exists for `vms_env=dev`.

### 7.4 Pipelines

- **Live** (`pipeline/orchestrator.py`, one per camera): RTSP ingest (PyAV, drop-old-frames, sub-stream preferred, optional NVDEC) → motion gate → SCRFD detect (batched/coalesced) → zone filter → IOU/DeepSORT tracker → per-face quality gate → gender/age vote → embed gating (per-track, every-Nth) → track embedding pool (quality-weighted mean) → publish `FaceCandidate` to Redis stream `vms.detections` after min-hits. Overlay boxes published to `vms.cam.state:{cam}` first (low latency); snapshot crop queued to MinIO.
- **Match** (`workers/match_worker.py`): consume `vms.detections`, matchability gate, Qdrant `vms_enrolled` ANN with tenant filter + crowd top-1 margin guard, classify `EventKind` (MATCH / ALERT if blacklist / UNKNOWN), write one `DetectionEvent` + audit row, feed face-learning, upsert `vms_appearance`, publish `vms.alerts`. DLQ on error.
- **Enrollment** (`services/enrollment.py`): decode → detect largest face → quality gate → embed (same recognizer as live) → MinIO crop → Qdrant `vms_enrolled` upsert then `FaceEnrollment` row (lockstep) → audit. `known_faces_bootstrap` enrolls the on-disk `known_faces/` gallery into the default tenant on startup.

### 7.5 Analytics features

- **Face watchlist** — the core pipeline; `Person.role` drives event kind (BLACKLIST → critical alert; UNKNOWN → warning). Optional watchlist auto-enhance via facerecounstruct.
- **Person journey** — forensic (upload face → ANN over `vms_appearance` → track-aware clustering → **space-time fusion** vetoing impossible hops via `camera_edges`, fusing face + OSNet body + clothing) → persisted journey graph → stitch worker renders MP4 + PDF + map to MinIO. Live journeys folded incrementally.
- **Restricted zone** — operator-drawn line/box/polygon zones (`detection_zones.py`) filter detections; YOLOv8n person detector counts humans regardless of face visibility (`persons_present = max(yolo, face_tracks)`).
- **Headcount / occupancy** — overlay carries `active_tracks` + `persons_present`; dedicated `head-count/` service available.
- **Activity / productivity** — YOLOv8-pose classifies `working/not_working/on_phone` with hysteresis; attendance + policy alerts reuse recognitions.
- **Live tracker** — "who is where now" across cameras, consuming `vms.cam.state:*`; ACTIVE→TRANSIT→LOST with K-of-N confirm, anti-teleport, and a learned movement graph. Zero extra camera load.

### 7.6 Emission back to the backend (two deliberate paths)

1. **Ephemeral overlay** (`backend_forwarder.py`) — PSUBSCRIBE `vms.cam.state:*`, throttle ~5/s/cam, POST boxes to `/api/internal/ai/overlay` → backend emits socket.io **`ai.live`** → `AIOverlay.jsx` draws. **Never persisted, never alerted.**
2. **Persisted alerts** (`alert_backend_forwarder.py`) — consume `vms.alerts`, forward only `alert`(critical)/`unknown`(warning) to `/api/internal/ai/events` → backend `ai_events` row + push, with per-(user,camera,kind,subject) cooldown.

This split is what prevents alert flooding: routine face boxes ride the overlay channel; only meaningful
detections become AIEvents.

### 7.7 Alert fan-out (`alertEngine.js`)

Only `warning`/`critical` alert. Redis-backed dedup by **stable identity** (personId/name, or one
`unknown` token per camera — never volatile trackId), per-channel cooldowns (push 90 s, email 600 s), and a
per-user email burst cap (8 / 600 s). Channels: Expo push + email fan-out to `AlertEmail` recipients
(per-recipient severity/category gate), with the crop fetched once from AI MinIO and inlined.

---

## 8. Web Console & Mobile App

### 8.1 Web console (`smart-cam-app`)

React 19 + Vite 7 + Tailwind v4; React Router v7, TanStack Query, Zustand, Radix/shadcn, Recharts,
Leaflet, `hls.js`, `livekit-client`, `socket.io-client`. Structure: `core/` (VMS host — pages, players,
services, store), `ai-analytics/` (self-contained suite with its own **scoped** design system —
`analytics.css` confined to `.ai-analytics-scope` so tokens never leak into host/admin), `admin/`
(lazy-loaded operator console), `modules/` (feature modules).

Pages: Dashboard, LiveView, Playback + **NvrPlayback**, Gallery, Timeline/Timelapse, Map, MonitorWall,
Cameras/Groups/Health, AiDetectionSetup, Sites, ComputeMonitor/Cost, Settings, Pricing, auth. AI pages
under `/ai-analytics/*`: FaceWatchlist (search / live ReID / suspect / graph / behaviour), RestrictedZone,
CrowdMonitoring, Productivity, Incidents, ANPR, Aggression, WeaponDetection, GIS, VMS. Plus module routes:
`/live-tracker`, `/alerts`, headcount, footfall, reports.

**Players** (`core/players/`): `WebRTCPlayer` (WHEP, sub-500 ms, `RTCPeerConnection` via
`streamRegistry`), `HLSPlayer` (`hls.js` fallback), `PlayerFrame` (shared shell — zoom/pan, `AIOverlay`
bbox overlay, loading/error chrome).

### 8.2 Mobile app (`drishyam_app`)

React Native 0.86 + Expo SDK 57; React Navigation v7, `expo-video`, Zustand + TanStack Query,
`expo-notifications`. Screens: Home (focus-gated live tiles), **LiveWall** (fixed 8-tile grid), Cameras,
LiveView (single), Playback, Alerts, Login (with server override), Profile.

Stream URLs are **never hand-built** — `startStream(monitorId)` → `GET /api/stream/start/{monitorId}`
returns `{ webrtcUrl, hlsUrl, hlsSubUrl, masterUrl, codec, transcoded }`; `rewriteMediaUrl()` fixes the
host. Tiles play the **HLS sub-stream** (bandwidth/decoder limits). **Focus-gated streaming**:
`MAX_LIVE_TILES=4` (Home), `WALL_LIVE_TILES=8` (wall) — sized to a typical NVR's ~6–7 concurrent-pull
ceiling; `useIsFocused()` + staggered connects + `replaceAsync(null)` detach let MediaMTX close idle
on-demand paths. Push via Expo (`registerForPush` → backend `DeviceToken`); foreground `AlertWatcher`
buzzes, server `alertEngine` delivers background push.

---

## 9. Infrastructure & Deployment

### 9.1 Compose stack (`docker-compose.drisyam-original.yml`)

Services: `mysql` (3307), `redis` (6379), `postgres`/ai-postgres (5432), `qdrant` (6333/6334), `minio`
(9000/9001), `kafka` (9092), `stream-service` (8554/8898/8889/9997/9998), `smart-cam-backend` (5000),
`smart-cam-ai` (8001), `smart-cam-ai-worker`, `journey-stitch-worker`, `face-reconstruct` (8002),
`smart-cam-sfu-bridge` (8005), `smart-cam-transcoder` (8004), `activity-monitor` (8010), `footfall-demo`,
`smart-cam-app` (5173), `cloudflared`. Named volumes for each datastore; recordings bind-mounted at
`mediamtx-recordings/`.

### 9.2 Ingress

- **Cloudflare Tunnel** (`cloudflared`) — no router port-forwarding. In-repo tunnel config routes `drishyamapi.indyatools.com → smart-cam-backend:5000`. Console hostnames (`demo.indyatools.com`, `dash.drishyam.io`, `app.drishyam.io`) live in the host-side cloudflared ingress (not committed) and resolve via Cloudflare-proxied CNAMEs to the tunnel.
- **nginx** — default server on :80 (TLS terminated at the Cloudflare edge). Upstreams: `backend_api` (`/api/*`), `mediamtx_webrtc` (`/whep`), `mediamtx_hls` (`.m3u8`/segments). An `auth_request` subrequest (`/api/stream/verify`, body off) gates HLS access. CORS allowlist mirrors the backend.

### 9.3 Observability (`docker-compose.observability.yml`)

Prometheus + Grafana + exporters (cAdvisor, node, redis, mysqld, postgres). Dashboards:
`camera-streams.json`, `drisyam-fleet.json`. The Stream Service and backend both expose `/metrics`.

---

## 10. Known Constraints & Roadmap

- **Per-NVR concurrency (known gap).** Nothing bounds the *total simultaneous* RTSP source pulls to a single NVR. The per-NVR **reset** and **reconnect** rate-limits throttle re-open *frequency*, and on-demand + focus-gating reduce load, but if many cameras behind one weak NVR are viewed/recorded at once, concurrent pulls can still exceed its session ceiling and jam it (observed on entry-level 32-ch NVRs). `streamRouter` capacity is accounted per Stream Service *server*, not per source NVR. **Planned fix:** a per-NVR concurrency cap (~4–6, queued) + exponential retry backoff at the source-pull layer.
- **RBAC capabilities are defined but barely enforced (verified 2026-08-05).** `ROLE_CAPABILITIES` grants a `viewer` only `view_live`/`view_playback`, and the console renders its UI from that list — but **only 1 of 24 route files** (`manageUsers.routes.js`) actually calls `requireCapability`. Camera/group mutation routes (`POST`/`PUT`/`DELETE /groups`, retention, quality, encoder) are guarded by `authenticate` alone, with per-row `userId` scoping as the only limit. A restricted-role user can therefore perform actions their role forbids on resources scoped to them; the RBAC promise shown in the UI is not a server-side boundary. `/ai` and `/person-tracker` do enforce **plan entitlement** (a separate control). **Fix:** apply `requireCapability(...)` to mutating routes — particularly `manage_cameras` and `manage_settings`.

- **AI matching thresholds are loosened in the deployed compose.** `INSIGHTFACE_REC_THRESHOLD` 0.62 → **0.45** and `MATCH_MIN_FACE_PX` 80 → **15**, which materially raises false-identification risk for watchlist use. See `AI_ACCURACY_AND_TUNING.md` §2.1.

- **Stale docstring.** `vendors/index.js` `nvrInterface()` says the NVR's own recordings are never read, but `playback.controller.js` intentionally RTSP-replays them; the docstring predates the NVR-playback feature.

- **Credentials committed in `docs/`.** `docs/10-credentials.md` (and several other docs + `docs/archive/`) contain real passwords, tokens and customer IPs and are tracked in git. They are **not** on either GitHub repo — the monorepo has never been pushed — but the values should be rotated and the file replaced with a vault-pointer inventory.
- **DeepStream ingest** is an optional GPU path (`docker-compose.deepstream.yml`, `deepstream_api/`, `pipeline/deepstream_bridge.py`) for high camera density.
- **LiveKit SFU** is scaffolded (`smart-cam-sfu-bridge`, `/livekit` routes) but disabled until `LIVEKIT_WS_URL` is configured.

---

## 11. Related Documents

- `docs/12-streaming-recording-architecture.md`, `docs/STREAMING_SERVICE_DESIGN.md`, `docs/STREAMING_PIPELINE.md`, `docs/PHASE-4-SFU-DESIGN.md` — streaming deep-dives.
- `docs/CAMERA_CONNECTIVITY.md`, `docs/cctv-cameras/NVR-INTERFACE.md` — connectivity & NVR boundary.
- `docs/DETECTION_LOGGING_ALERTING_POLICY.md` — the canonical anti-flood alerting doctrine.
- `docs/RESTRICTED_ZONE_DETECTION.md`, `docs/JOURNEY_CENTRALIZATION.md`, `docs/DEEPSTREAM_AI_SERVICE.md` — AI subsystems.
- `docs/SECURITY.md`, `docs/STREAM_SECURITY.md` — security posture.
- `docs/06-api-reference.md`, `docs/07-env-variables.md`, `docs/11-deployment.md` — operational references.
- `case-studies/netforchoice.md`, `case-studies/sharda-university.md` — real edge-relay deployments.
