# smart-cam-backend — Features

One section per route group, ordered roughly by traffic. Each has: **purpose**, **endpoints**, **files**, **tables**, **notable behavior**.

---

## Auth (`/api/auth/*`)

Login, register, refresh, password reset, email verification.

**Endpoints**
- `POST /api/auth/register` — creates a `User` row, sends verification email
- `POST /api/auth/login` — bcrypt-compare, issues access JWT (15m) + refresh token (30d, MySQL-backed)
- `POST /api/auth/refresh` — rotates refresh + issues a new access JWT
- `POST /api/auth/logout` — revokes the refresh token
- `POST /api/auth/forgot-password` / `POST /api/auth/reset-password` — token via email
- `POST /api/auth/verify-email` — confirms `email_verified` flag

**Files** — [routes/auth.routes.js](../src/routes/auth.routes.js), [controllers/auth.controller.js](../src/controllers/auth.controller.js)

**Tables** — `users`, `refresh_tokens`, `password_resets`

**Notable** — passwords are bcryptjs (not native bcrypt) to avoid Windows build pain. Access tokens are issued via `signAccessToken()` reading `JWT_SECRET`; if `JWT_SECRET` is unset the service exits at boot.

---

## Cameras + Groups (`/api/cameras`, `/api/groups`)

CRUD over cameras and the groups they belong to (a group = an NVR or DVR with shared HTTP credentials and host).

**Endpoints**
- `GET /api/groups` — list groups with cameras nested; the frontend's `useGroups()` hook reads this
- `POST /api/groups` — create a group, immediately probes the device for capability + channel list
- `PATCH /api/groups/:id`, `DELETE /api/groups/:id`
- `GET /api/cameras/:id`, `PATCH /api/cameras/:id`, `DELETE /api/cameras/:id`
- `POST /api/groups/:groupId/cameras` — add a camera to a group, creates the MediaMTX path
- `POST /api/cameras/:id/heal` — restart the underlying RTSP stream
- `POST /api/cameras/:id/keyframe` — force an IDR

**Files** — [routes/camera.routes.js](../src/routes/camera.routes.js), [routes/cameraGroup.routes.js](../src/routes/cameraGroup.routes.js), [controllers/camera.controller.js](../src/controllers/camera.controller.js), [controllers/cameraGroup.controller.js](../src/controllers/cameraGroup.controller.js)

**Tables** — `cameras`, `camera_groups`, `sites`

**Notable** — when a Camera is created the backend (a) inserts the row, (b) tells MediaMTX about the path (`POST /v3/config/paths/add/cam_<monitorId>`), (c) emits `CAMERA_CREATED`. When deleted: emit `CAMERA_DELETED`, remove from MediaMTX, then delete the row. The transactional discipline matters — every step has a partial-failure recovery comment in the controller.

---

## Device probes + Boost (`/api/groups/:groupId/cameras/:monitorId/*`)

ONVIF / Hikvision ISAPI / Dahua CGI device interrogation + encoder mutation.

**Endpoints**
- `POST /api/groups/:groupId/cameras/:monitorId/encoder` — mutate H.264 bitrate + GOP + fps. This is the "Face Quality Boost" button.
- `GET .../encoder-debug` — return the raw XML from the camera's encoder endpoint so you can see what fields its firmware exposes
- `POST .../keyframe` — set keyframe interval only
- Other vendor-specific probes for capability discovery

**Files** — [routes/cameraGroup.routes.js](../src/routes/cameraGroup.routes.js), [controllers/deviceProbe.controller.js](../src/controllers/deviceProbe.controller.js), [services/deviceProbe.service.js](../src/services/deviceProbe.service.js)

**Notable** — Hikvision NVR-attached channels reject `<maxFrameRate>0 → N` overwrites — the writer now skips that field when current value is 0. Three other Hikvision quirks are inline-commented in `setHikvisionEncoder()`. When the writer succeeds it returns `edits=<count of fields actually changed>` so the operator can tell when "Boost" was a no-op.

---

## AI proxy (`/api/ai/*`)

Everything operator-facing the AI service produces flows through here.

**Endpoints**
- `GET /api/ai/events` — paginated event list, merges local MySQL `AIEvent` rows with vms_face's `/logs` stream
- `GET /api/ai/events/:id/snapshot` — signed S3 URL of the event's snapshot
- `POST /api/ai/events/:id/ack` — operator marks as reviewed
- `POST /api/ai/watchlist` — single-face upload (multipart) → AI's `/upload`
- `DELETE /api/ai/watchlist/:name`
- `POST /api/ai/watchlist/dataset` — ZIP of labelled faces → S3 staging → background ingest
- `GET /api/ai/watchlist/datasets` — list past dataset uploads
- `GET /api/ai/face-learning/samples` (and `/snapshot`, `/approve`, `/reject`)
- `GET /api/ai/people-count` — building-wide aggregate (proxies `/api/people-count`)
- `GET /api/ai/footfall/cameras` / `timeseries` / `cameras/:id/config` (GET, PUT) / `export.csv` — footfall surface
- `POST /api/ai/enhance` — multipart face crop → CodeFormer + Real-ESRGAN service on port 8002 (proxies `/api/reconstruct`)
- `GET /api/ai/camera-mapping`, `PATCH /api/ai/cameras/:id/mapping`, `PATCH /api/ai/cameras/:id/lifecycle`, `PUT /api/ai/cameras/:id/settings`

**Files** — [routes/ai.routes.js](../src/routes/ai.routes.js), [controllers/ai.controller.js](../src/controllers/ai.controller.js) (>1000 lines; the largest controller)

**Notable** — every proxy uses the same shape: `axios.get(`${AI_BASE}/…`, { headers: aiOperatorHeaders(req), timeout: 5_000 })`. Errors → `throw new AppError('…', err.response?.status === 404 ? 404 : 502)`. Streaming endpoints (CSV export, face-learning snapshot) use `responseType: 'stream'` and pipe directly to `res`.

---

## Internal endpoints (`/api/internal/*`)

Service-token-gated. The Python AI service writes here.

**Endpoints**
- `GET /api/internal/health` — token-check ping
- `POST /api/internal/ai/events` — ingest a face event with optional base64 snapshot (uploads to S3 → AIEvent row → emit `AI_EVENT_DETECTED`)
- `GET /api/internal/cameras` — full camera roster + MediaMTX RTSP URLs (the AI service reads this on boot to know what to subscribe to)

**Files** — [routes/internal.routes.js](../src/routes/internal.routes.js)

**Notable** — the body limit is bumped to 2 MB (vs the global 10 kb) to accommodate base64 snapshots. Snapshot upload is best-effort: a failed S3 put doesn't fail event ingest, the row just lands with `snapshotKey: null`.

---

## Recording + Playback (`/api/recordings/*`)

**Endpoints**
- `GET /api/recordings?cameraId=&date=` — list MP4 clips for a camera/day
- `GET /api/recordings/:key/stream` — Range-aware byte-stream proxy (handles Browser seek)
- `GET /api/recordings/:key/download` — Content-Disposition: attachment
- `DELETE /api/recordings/:key`
- `GET /api/recordings/groups/:groupName?date=` — list across all cameras in a group

**Files** — [routes/recording.routes.js](../src/routes/recording.routes.js), [controllers/recording.controller.js](../src/controllers/recording.controller.js), [services/s3.service.js](../src/services/s3.service.js), [services/transcoder.service.js](../src/services/transcoder.service.js)

**Notable** — `getReadStream(key, range)` passes the Range header through to S3 so the browser's `<video>` can seek without downloading the whole clip. S3 returns 206 + Content-Range; we forward both.

---

## Stream supervisor + health

**Endpoints**
- `GET /api/health` — service liveness
- `GET /api/cameras/:id/health` — per-camera stream stats (uptime, bps, last error)
- `POST /api/cameras/:id/heal` — restart underlying ffmpeg/RTSP

**Files** — [services/streamSupervisor.service.js](../src/services/streamSupervisor.service.js), [controllers/streamHeal.controller.js](../src/controllers/streamHeal.controller.js), [controllers/health.controller.js](../src/controllers/health.controller.js)

**Notable** — Supervisor runs every 2 s, polls MediaMTX `/v3/paths/list`, transitions Camera.status. Anything that flaps (transitions >4× in 24h) is moved to `quarantine_until=<now + 1h>` to avoid alert spam.

---

## Admin dashboard (`/api/admin/*`)

Internal operator tooling — usage stats, user management, audit log search, license management.

**Endpoints**
- `GET /api/admin/stats` — total events, active cameras, license usage
- `GET /api/admin/events?…` — admin-scope event search across all users
- `GET /api/admin/audit?…` — audit log query
- `GET /api/admin/users` / `PATCH /api/admin/users/:id` / role changes
- `GET /api/admin/licenses` / `POST /api/admin/licenses`

**Files** — [routes/admin.routes.js](../src/routes/admin.routes.js), [controllers/admin.controller.js](../src/controllers/admin.controller.js), [middleware/adminAuth.js](../src/middleware/adminAuth.js)

**Notable** — admin auth is the regular JWT + `authorize('admin')`. The platform admin (created with `ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/create-admin.js`) comes from [scripts/create-admin.js](../scripts/create-admin.js).

---

## Billing + License (`/api/billing/*`, `/api/license/*`)

Stripe integration for plan management + feature gating for licensed features.

**Endpoints**
- `GET /api/billing/plans` / `GET /api/billing/subscription`
- `POST /api/billing/checkout` — Stripe checkout session
- Stripe webhook handler
- `GET /api/license/features` — feature flags for the current user
- `POST /api/license/probe` — used by a separate process to verify license validity

**Files** — [routes/billing.routes.js](../src/routes/billing.routes.js), [controllers/billing.controller.js](../src/controllers/billing.controller.js), [controllers/license.controller.js](../src/controllers/license.controller.js)

**Tables** — `plans`, `pricing_catalog`, `quotes`, `subscriptions`, `payments`, `licenses`, `license_features`, `license_resources`

---

## Bulk import (`/api/import/*`)

CSV/Excel bulk camera import for onboarding large deployments.

**Files** — [controllers/bulkImport.controller.js](../src/controllers/bulkImport.controller.js)

---

## Talkback (`/api/talkback/*`)

Two-way audio push to compatible cameras (Hikvision/Dahua audio-output channels). Sub-1 s latency via WebRTC.

**Files** — [controllers/talkback.controller.js](../src/controllers/talkback.controller.js)

---

## WebSocket channels (Socket.IO)

Not REST, but mentioned here because operators consume them. Authenticated by the same JWT on the handshake.

| Channel | When emitted | Payload |
|---|---|---|
| `ai.event` | Every AIEvent row | The event JSON |
| `ai.alert` | Watchlist hits (same channel, `kind=alert`) | Event + alert metadata |
| `stream.ready` | Supervisor transitioned to `streaming` | `{ monitorId, bps }` |
| `stream.offline` | Supervisor transitioned to `offline` | `{ monitorId, reason }` |
| `camera.created` / `updated` / `deleted` | Camera CRUD success | `{ camera }` |
| `recording.synced` | New clip lands on S3 | `{ key, cameraId, duration }` |

The frontend's WS client is in `smart-cam-app/src/services/socket.js`.
