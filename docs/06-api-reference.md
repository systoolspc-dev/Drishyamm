# 06 — API Reference

Every HTTP endpoint of the Drishyam VMS backend (`smart-cam-backend`) is mounted under the base path **`/api`** (see `src/app.js` → `app.use('/api', routes)` and `src/routes/index.js`). Requests and responses are JSON unless noted (a few endpoints stream binary — JPEG snapshots, MP4, PDF, CSV, HLS playlists). Almost everything is protected by a **JWT bearer token**; a small number of routes use a service token or a media-plane cookie instead.

> Written from `src/routes/*.routes.js` + the matching controllers: ~188 endpoints across 23 mounted routers.

---

## Authentication

| Token | Lifetime | Where it comes from | Notes |
|---|---|---|---|
| Access token (JWT) | `JWT_EXPIRES_IN`, default **15m** | `POST /api/auth/login` / `register` / `refresh-token` → `token` | Signed with `JWT_SECRET`. Claims used by middleware: `id`, `email`, `role`, `isPlatformAdmin`. |
| Refresh token (JWT) | `JWT_REFRESH_EXPIRES_IN`, default **7d** | same responses → `refreshToken` | **Single-use rotation**: `POST /api/auth/refresh-token` verifies it, revokes it, and issues a brand-new pair. |

Sending the access token (`src/middleware/authenticate.js`):

```
Authorization: Bearer <accessToken>
```

…or, for URLs a browser loads directly and cannot attach headers to (`<video src=…>`, `<img src=…>`, downloads):

```
GET /api/…?token=<accessToken>
```

Both are accepted by the same middleware. An expired token returns `401 "Token expired. Please refresh your token."`; an invalid one returns `401 "Invalid token."`.

Sessions are revoked server-side on `POST /api/auth/logout` (that one refresh token), and **all** of a user's refresh tokens are revoked on password change (`PUT /api/auth/change-password`) and password reset (`POST /api/auth/reset-password`).

### Capability model

Roles (`src/utils/constants.js`): `admin`, `manager`, `operator`, `viewer`, plus the legacy `user` alias. Each maps to a capability set, and an account may define **custom roles** whose explicit capability list overrides the tier:

| Capability | Label | admin / user | manager | operator | viewer |
|---|---|:--:|:--:|:--:|:--:|
| `view_live` | View live cameras | ✅ | ✅ | ✅ | ✅ |
| `view_playback` | View recorded playback | ✅ | ✅ | ✅ | ✅ |
| `ack_alerts` | Acknowledge / act on alerts | ✅ | ✅ | ✅ | — |
| `manage_cameras` | Add / edit cameras & groups | ✅ | ✅ | — | — |
| `use_ai` | AI modules + configuration | ✅ | ✅ | — | — |
| `manage_users` | Manage users & roles | ✅ | — | — | — |
| `manage_settings` | Billing & settings | ✅ | — | — | — |

`GET /api/auth/me`, `login` and `register` return the caller's effective `capabilities` array (with `use_ai` stripped when the account's plan has no AI) — the SPA gates its navigation on it.

**What is actually enforced server-side today:**

- `requireCapability(...)` is currently applied to exactly one router — `/api/manage/*` with `MANAGE_USERS`. It reloads the user from the DB (so a role change or deactivation takes effect immediately) and attaches `req.dbUser`.
- `requireAiCapability` gates `/api/ai/*` and `/api/person-tracker/*` on the **plan entitlement** (`assertAiEntitled`) — a Basic-VMS account gets `403` even via curl.
- `adminAuth` (on `/api/admin/*`) requires the `isPlatformAdmin` JWT claim — a DB-flagged platform-operator account; self-registration can never set it.
- Every other router relies on `authenticate` plus per-row ownership scoping (`where: { userId: req.user.id }`) inside the controller.

---

## Auth planes

| Plane | Credential | Used by | Routes |
|---|---|---|---|
| User plane | `Authorization: Bearer <JWT>` or `?token=` | Console SPA, mobile app | Everything except the rows below |
| Service plane | `X-Service-Token: <SERVICE_TOKEN>` (or `Authorization: Bearer <SERVICE_TOKEN>`), compared constant-time | smart-cam-ai worker, sidecars | `/api/internal/*` (`src/middleware/serviceAuth.js`) |
| Service plane (query variant) | `?token=<SERVICE_TOKEN>` | stampede detector (cannot set headers) | `POST /api/internal/stampede-alert` only |
| Media plane | `st_<monitorId>` HTTP-only cookie, minted at stream start | nginx `auth_request` in front of `/hls/` and `/live/` | `GET /api/stream/verify` — **no JWT**; returns `204` allow / `401`/`403` deny, and a plain `204` when `STREAM_URL_SECRET` is unset. See `docs/STREAM_SECURITY.md`. |
| Platform-operator plane | user JWT with `isPlatformAdmin: true` | Drishyam ops dashboard | `/api/admin/*` |

### Rate limits and body limits

| Scope | Limit |
|---|---|
| All of `/api` | 5000 requests / 15 min / IP. Skipped for `/internal/*`, for `GET` paths containing `/snapshot` or `/thumbnail`, and for localhost outside production. |
| Public auth routes (`register`, `login`, `refresh-token`, `forgot-password`, `reset-password`) | 10 / 15 min / IP in production (100 in dev) |
| JSON body | 10 KB default · 2 MB on `/api/internal/*` · 5 MB on `/api/person-tracker/*` |
| Raw body | `POST /api/payment/webhook` (signature verification) · `POST /api/cameras/:monitorId/talk/audio` (raw µ-law audio, 32 KB per chunk) |

---

## `/api/auth`

`src/routes/auth.routes.js` → `auth.controller.js`. Bodies validated by Joi (`src/validations/auth.validation.js`); unknown keys are stripped.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| POST | `/auth/register` | Public (auth limiter) | Create an account owner. Body `{ name, email, password, tier? }` — password ≥ 8 chars with upper + lower + digit; `tier` ∈ `basic_vms`/`ai_vms` (default `basic_vms`). Returns `{ user, capabilities, token, refreshToken }`. |
| POST | `/auth/login` | Public (auth limiter) | Body `{ email, password }` — `email` also accepts a **username** (RBAC sub-users). Returns `{ user, capabilities, token, refreshToken }`. |
| POST | `/auth/refresh-token` | Public (auth limiter) | Body `{ refreshToken }`. Revokes the presented token and returns a fresh `{ token, refreshToken }` pair. |
| POST | `/auth/forgot-password` | Public (auth limiter) | Body `{ email }`. Emails a 1-hour reset token; always answers success (no email enumeration). |
| POST | `/auth/reset-password` | Public (auth limiter) | Body `{ token, password }`. Consumes the reset token and revokes all sessions. |
| GET | `/auth/me` | JWT | Current user + active subscription/plan + effective `capabilities` + `aiEnabled`/`features`. |
| PUT | `/auth/profile` | JWT | Body `{ name?, email? }` (at least one). |
| PUT | `/auth/change-password` | JWT | Body `{ currentPassword, newPassword }`. Revokes all refresh tokens. |
| POST | `/auth/logout` | JWT | Body `{ refreshToken }` (optional) — revokes that refresh token. |

## `/api/user`

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/user/group-key` | JWT | Legacy Shinobi `groupKey`/`apiKey` for the caller. Both are `null` in Stream-Service mode. |

## `/api/shinobi` — legacy **name**, still **live**

> ⚠️ **Do not delete this router.** The name is historical, but these endpoints are
> **actively used** — `smart-cam-app/src/core/services/shinobi.js` still calls them for
> camera CRUD. `shinobi.controller.js` performs the real work through the **current**
> streaming engine (`drishyamStreaming.service`); the old Shinobi calls it also makes are
> wrapped in a best-effort `tryShinobi(...)` helper and are no-ops in Stream-Service mode.
>
> **Status:** functional, not dead. **New work should prefer** `/api/groups` (device-oriented
> CRUD) and `/api/stream`. Treat this router as pending migration, not as removable.

Every route is JWT-authenticated and takes a `groupKey` (which is `null` in Stream-Service mode).

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/shinobi/cameras` | JWT | List the caller's cameras. |
| GET | `/shinobi/cameras/:monitorId` | JWT | One camera. |
| POST | `/shinobi/cameras` | JWT + Joi `addCamera` | Add a camera (`groupKey`, `mid`, `name`, `host`, …). |
| PUT | `/shinobi/cameras/:monitorId` | JWT + Joi `updateCamera` | Update a camera. |
| DELETE | `/shinobi/cameras/:monitorId` | JWT | Delete a camera. |
| GET | `/shinobi/recordings/:monitorId` | JWT | Recordings for a camera. |

## `/api/groups` — camera groups (NVR / device) + recordings

`cameraGroup.routes.js` → `cameraGroup.controller.js` and `deviceProbe.controller.js`. `router.use(authenticate)`: all routes require a JWT and are scoped to the caller.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| POST | `/groups/probe` | JWT | Probe an NVR/camera **without saving** (the "Discover" button) — returns channel names, model, video presence. |
| POST | `/groups/:groupId/probe` | JWT | Re-probe a saved group using stored credentials (read-only). |
| POST | `/groups/:groupId/sync-names` | JWT | Probe + overwrite still-auto-named cameras with the device's own channel names. |
| POST | `/groups/:groupId/cameras/:monitorId/keyframe-interval` | JWT | Set the device-side GOP length (fast stream pop-in). |
| POST | `/groups/:groupId/cameras/:monitorId/encoder` | JWT | Set the full encoder profile on the device (bitrate + GOP + fps). |
| GET | `/groups/:groupId/cameras/:monitorId/encoder-debug` | JWT | Diagnostic: the raw encoder XML the device exposes. |
| GET | `/groups` | JWT | List all groups with their cameras. |
| POST | `/groups` | JWT + Joi `createGroup` | Create a group and auto-provision its channels. Body `{ name, host, port=554, httpPort=80, username, password, totalChannels=1, deviceType='hikvision', location?, channels? }`. |
| GET | `/groups/:groupId` | JWT | One group + its cameras. |
| PUT | `/groups/:groupId` | JWT | Update group fields. |
| DELETE | `/groups/:groupId` | JWT | Delete the group and all its cameras. |
| POST | `/groups/:groupId/sync` | JWT | Force-refresh camera statuses from the streaming layer ("Refresh" button). |
| DELETE | `/groups/:groupId/cameras/:monitorId` | JWT | Remove a single camera channel from the group. |
| POST | `/groups/:groupId/reconfigure` | JWT | Re-apply the current stream configuration to every camera in the group. |
| POST | `/groups/:groupId/retention` | JWT | Group/location default recording retention. Body `{ retentionDays }`. |
| POST | `/groups/:groupId/cameras/retention` | JWT + Joi `bulkRetention` | Bulk per-camera retention. Body `{ monitorIds: [...], retentionDays }`. |
| POST | `/groups/:groupId/cameras/:monitorId/retention` | JWT | Per-camera retention override (`null` = inherit). |
| POST | `/groups/:groupId/quality` | JWT | Group default stream quality (`auto`/`main`/`sub`). |
| POST | `/groups/:groupId/cameras/quality` | JWT + Joi `bulkQuality` | Bulk per-camera quality. Body `{ monitorIds: [...], streamQuality }`. |
| POST | `/groups/:groupId/cameras/:monitorId/quality` | JWT | Per-camera quality override. |
| GET | `/groups/:groupId/recordings` | JWT | Recording list for every camera in the group (object storage). |
| GET | `/groups/:groupId/cameras/:monitorId/recordings` | JWT | Recording list for one camera. |
| GET | `/groups/:groupId/recordings/play?key=` | JWT | Fresh presigned playback URL for one object (TTL from `RECORDING_PLAY_URL_TTL_SEC`, default 4 h). |
| GET | `/groups/:groupId/recordings/stream?key=` | JWT (`?token=` OK) | Proxy the recording bytes with HTTP Range support — used directly as a `<video src>`. |
| GET | `/groups/:groupId/recordings/thumbnail?key=` | JWT (`?token=` OK) | First-frame JPEG thumbnail (cached 24 h). Exempt from the rate limiter. |
| GET | `/groups/:groupId/recordings/download?key=` | JWT | Forced-download signed URL. |

## `/api/stream`

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/stream/start/:monitorId` | JWT | Ensure the camera path exists in the stream service and return `{ ok, monitorId, webrtcUrl, masterUrl, hlsUrl, hlsSubUrl, streamUrl, provider, codec, transcoded }`. Optional `?quality=low\|high\|auto`. Also sets the `st_<monitorId>` media cookie when `STREAM_URL_SECRET` is configured. |
| GET | `/stream/stop/:monitorId` | JWT | Remove the camera's path from the stream service (cleanup / manual testing). |
| GET | `/stream/status/:monitorId` | JWT | `{ ok, monitorId, isActive, webrtcUrl, hlsUrl, provider, codec, transcoded }`. |
| POST | `/stream/watchdog/run` | JWT | Fire the self-healing watchdog cycle immediately instead of waiting for its timer. |
| GET | `/stream/master/:monitorId/index.m3u8` | JWT | Dynamic multi-variant (main + sub) HLS master playlist; `Content-Type: application/vnd.apple.mpegurl`. |
| GET | `/stream/verify` | **Media-plane cookie** (no JWT) | nginx `auth_request` hook. Reads `X-Original-URI`, derives the monitorId and validates the `st_<monitorId>` cookie → `204` / `401` / `403`. |

## `/api/internal` — service-to-service

`internal.routes.js`. Its own JSON parser (2 MB) and exempt from the API rate limiter.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| POST | `/internal/stampede-alert` | Service token via `?token=` | Crowd-crush webhook. Body `{ camera, level, score?, time_s? }` — maps the camera **name** to a VMS camera, stores a `crowd.stampede` AI event, and fans it out to the operator + alert engine. |
| GET | `/internal/health` | `X-Service-Token` | Liveness + token-validity probe for the AI worker. `{ ok, ts }`. |
| POST | `/internal/ai/events` | `X-Service-Token` | **Persisted** AI event ingest. Body `{ userId, monitorId, cameraId?, eventType, severity, ts, bbox?, trackId?, confidence?, payload?, snapshot? (base64) }`. Uploads the snapshot to object storage, stores the row, pushes it over WebSocket, hands it to the alert engine. `202 { ok, id }`. |
| POST | `/internal/ai/overlay` | `X-Service-Token` | **Ephemeral** per-frame bounding boxes for the live overlay — never persisted, never alerted. Body `{ userId, monitorId, ts?, frameW, frameH, boxes: [{ bbox, trackId?, name?, gender?, age?, conf? }] }`. `202 { ok }`. |
| GET | `/internal/cameras` | `X-Service-Token` | Camera registry for the AI worker: `{ ok, cameras: [{ id, userId, monitorId, name, status, settings, rtsp, rtspSub }] }`. |

## `/api/ai`

`ai.routes.js` → `ai.controller.js`. `router.use(authenticate)` **and** `router.use(requireAiCapability)` — every route is user-scoped and 403s for accounts without an AI plan. Many routes are authenticated proxies to `smart-cam-ai` or the `activity-monitor` service (upstream failures surface as `502`).

### Events, reports, watchlist

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/ai/events` | JWT + AI plan | Paged event feed merged from local AI events and the vms_face mirror. Query `limit` (≤200), `offset`, `monitorId`, `eventType`, `severity`, `since`. Returns `{ success, data, pagination }`. |
| GET | `/ai/reports` | JWT + AI plan | SQL-aggregated report for a range (`from`, `to`): totals plus severity / type / camera breakdowns and a daily trend. |
| GET | `/ai/events/:id/snapshot` | JWT + AI plan | Signed 1-hour URL for the event snapshot. |
| POST | `/ai/events/:id/ack` | JWT + AI plan | Acknowledge an event. |
| GET | `/ai/watchlist` | JWT + AI plan | The org's enrolled watchlist people (name + image count), tenant-scoped. |
| POST | `/ai/watchlist` | JWT + AI plan | Enroll a face. `multipart/form-data` with `name` + `file`; also mirrored into the admin dataset bucket. |
| DELETE | `/ai/watchlist/:name` | JWT + AI plan | Remove a person from the watchlist. |
| POST | `/ai/watchlist/dataset` | JWT + AI plan | Bulk enrollment: `multipart/form-data` field `dataset`, a `.zip` of per-person folders. |
| GET | `/ai/watchlist/datasets` | JWT + AI plan | List previously uploaded datasets. |
| GET | `/ai/face-learning/samples` | JWT + AI plan | Auto-learned face samples awaiting review. |
| GET | `/ai/face-learning/samples/:id/snapshot` | JWT + AI plan | Image for one pending sample. |
| POST | `/ai/face-learning/samples/:id/approve` | JWT + AI plan | Approve a sample into the gallery. |
| POST | `/ai/face-learning/samples/:id/reject` | JWT + AI plan | Reject a sample. |
| POST | `/ai/enhance` | JWT + AI plan | Face reconstruction (CodeFormer + Real-ESRGAN). `multipart/form-data` `file` + optional `fidelity_weight` (0..1); upstream returns `{ triage, before, after }` with base64 images. |

### Live counts and per-camera AI configuration

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/ai/people-count` | JWT + AI plan | Building-wide + per-camera live people count (smoothed). Polled ~2 s by dashboard tiles. |
| GET | `/ai/camera-mapping` | JWT + AI plan | Cameras with their AI zone/risk mapping + 24 h event counts. |
| PATCH | `/ai/cameras/:id/mapping` | JWT + AI plan | Update one camera's mapping (zone, risk, coverage). |
| GET | `/ai/cameras` | JWT + AI plan | Per-camera AI settings + live runtime/lifecycle status. |
| PATCH | `/ai/cameras/:id/lifecycle` | JWT + AI plan | Start/stop the AI pipeline for a camera. |
| PUT | `/ai/cameras/:id/settings` | JWT + AI plan | Update a camera's AI settings (mode, detection zones of shape `line`/`box`/`polygon`, alert toggles). |
| POST | `/ai/person-tracker-cameras` | JWT + AI plan | Turn person-tracking / journey mapping on or off in bulk. Body `{ cameraIds: [...], enabled? }`. |
| GET | `/ai/activity-cameras` | JWT + AI plan | Which cameras run phone-usage/activity monitoring (DB truth) + live pipeline status. |
| POST | `/ai/activity-cameras` | JWT + AI plan | Enable/disable activity monitoring in bulk. Body `{ cameraIds: [...], enabled? }`. |
| POST | `/ai/notify/test-camera-offline` | JWT + AI plan | Fire a sample camera-offline notification to the caller (auto-recovers) to verify the toast path. |

### Activity / productivity (proxied to `activity-monitor`)

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/ai/activity/people` | JWT + AI plan | Per-person totals for today (who / count / minutes). |
| GET | `/ai/activity/sessions` | JWT + AI plan | Completed phone-usage sessions (evidence log). |
| GET | `/ai/activity/history` | JWT + AI plan | Per-person daily totals over the last N days. |
| GET | `/ai/activity/attendance` | JWT + AI plan | Who is inside now (name + entry time) plus recent in/out. |
| GET | `/ai/activity/crossings` | JWT + AI plan | Full entry/exit feed (recognised + unknown). |
| GET | `/ai/activity/alerts` | JWT + AI plan | Policy alerts (watchlist / stranger / after-hours) + today's counts. |
| POST | `/ai/activity/alerts/:id/ack` | JWT + AI plan | Mark an activity alert acknowledged. |
| GET | `/ai/activity/metrics` | JWT + AI plan | Detection-funnel health (dedup ratio, recognition rate, sanity checks). |
| GET | `/ai/activity/events` | JWT + AI plan | Unified event log (attendance + alerts merged). |
| GET | `/ai/activity/line` | JWT + AI plan | The drawn in/out counting line for a camera (`?camera=` or `?stream=`). |
| PUT | `/ai/activity/line` | JWT + AI plan | Save the drawn in/out line. |
| GET | `/ai/activity/streams` | JWT + AI plan | Per-stream live snapshot (people, states, fps). |
| GET | `/ai/activity/snapshot/:streamId` | JWT + AI plan | Latest annotated JPEG passthrough; `204` when no frame is available yet. |
| GET | `/ai/track/live` | JWT + AI plan | Real-time who-is-where from the LiveTracker. |
| GET | `/ai/track/live/:name` | JWT + AI plan | Live position/trail for one person. |
| GET | `/ai/track/graph` | JWT + AI plan | The learned camera-to-camera movement graph. |
| POST | `/ai/track/reset` | JWT + AI plan | Reset tracker state. |

### Footfall counter

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/ai/footfall/cameras` | JWT + AI plan | Cameras known to the footfall counter (returns the AI service's own camera UUIDs). |
| GET | `/ai/footfall/timeseries` | JWT + AI plan | In/out counts over time. |
| GET | `/ai/footfall/cameras/:id/config` | JWT + AI plan | Footfall config for one camera — `:id` is the **AI service** camera UUID, not `monitorId`. |
| PUT | `/ai/footfall/cameras/:id/config` | JWT + AI plan | Update that config. |
| GET | `/ai/footfall/export.csv` | JWT + AI plan | Streamed CSV export of the counts. |

## `/api/person-tracker` — forensic journey

`personTracker.routes.js`. `authenticate` + `requireAiCapability`; the controller forwards to `smart-cam-ai`'s `/journey/*` with a service token, a per-org JWT and the operator id, and enriches responses with real camera names.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| POST | `/person-tracker/search` | JWT + AI plan | Search by photo. `multipart/form-data` (photo + optional filters); scoped to journey-enabled cameras. |
| POST | `/person-tracker/sightings/cluster` | JWT + AI plan | Cluster raw sightings into per-person candidates. |
| POST | `/person-tracker/stitch` | JWT + AI plan | Create a stitched-video render job. |
| GET | `/person-tracker/stitch/:jobId` | JWT + AI plan | Poll job status. |
| GET | `/person-tracker/stitch/:jobId/video` | JWT + AI plan | Relay the rendered MP4 bytes (`video/mp4`, plays inline). |
| GET | `/person-tracker/stitch/:jobId/report.pdf` | JWT + AI plan | Relay the generated PDF report. |
| GET | `/person-tracker/stitch/:jobId/map.json` | JWT + AI plan | Journey map data for the job. |
| GET | `/person-tracker/snapshot?uri=s3://…` | JWT + AI plan | Relay a matched-face crop image; a missing crop returns 4xx with no body. |

## `/api/notifications`

`notifications.routes.js` → `notifications.controller.js` + `alertEmail.controller.js`. All routes JWT-authenticated and user-scoped.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| POST | `/notifications/register` | JWT | Register/refresh this device's Expo push token. Body `{ token, platform?, deviceName? }`. |
| POST | `/notifications/unregister` | JWT | Remove a push token (logout / disable on this device). Body `{ token }`. |
| GET | `/notifications/emails` | JWT | List the caller's alert-email recipients. |
| POST | `/notifications/emails` | JWT | Add a recipient. Body `{ email, label?, minSeverity? ('warning'\|'critical'), eventTypes? }` where `eventTypes` ⊆ `watchlist, unknown, intrusion, weapon, fire, crowd, other` (`null`/omitted = all). |
| PATCH | `/notifications/emails/:id` | JWT | Update `minSeverity`, `disabled`, `label`, or `eventTypes`. |
| DELETE | `/notifications/emails/:id` | JWT | Remove a recipient. |
| POST | `/notifications/emails/:id/test` | JWT | Send a test alert email to that recipient (`502` if SMTP fails). |

## `/api/sites`

`site.routes.js` + `bulkImport.routes.js` (mounted at `/api/sites/:siteId/import`). Both call `router.use(authenticate)`.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/sites` | JWT | List the caller's sites with group/camera roll-ups. |
| POST | `/sites` | JWT | Create a site (slug auto-generated and de-duplicated). |
| GET | `/sites/:id` | JWT | One site. |
| PUT | `/sites/:id` | JWT | Update a site. |
| DELETE | `/sites/:id` | JWT | Delete a site — only when it is empty. |
| POST | `/sites/:id/archive` | JWT | Soft-archive (cameras stay, just hidden). |
| POST | `/sites/:id/restore` | JWT | Un-archive. |
| POST | `/sites/:siteId/import/preview` | JWT | Parse + validate a bulk CSV (`{ csv: "<text>" }` or a multipart file). Returns rows, validation errors and the expanded channel preview. Touches nothing. |
| POST | `/sites/:siteId/import/commit` | JWT | Provision the validated rows. Body `{ rows: [...], dryRun? }`. Per-row failure isolation; re-running on existing hosts is safe. |
| GET | `/sites/:siteId/import/template` | JWT | CSV template. Columns: `name, host, port, http_port, username, password, device_type, total_channels, location, latitude, longitude` — only `name` and `host` are required. |

## `/api/cameras` — health, healing, talkback

`cameraHealth.routes.js`. `router.use(authenticate)`; healing/talkback additionally require ownership (a platform `admin` role may act on any camera).

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/cameras/health` | JWT | Live health of every camera the caller owns — status ∈ `transcoding`, `healthy`, `starting`, `wobbling`, `offline`, `unknown`. Polled ~10 s. |
| GET | `/cameras/:monitorId/quality` | JWT + owner | Diagnostic snapshot: jitter, FIE rate, reader count, heal log, supervisor entry. |
| POST | `/cameras/:monitorId/heal` | JWT + owner | Force-reconnect the camera path (manual override of the automatic healer). `409` when the heal is refused. |
| POST | `/cameras/:monitorId/keyframe` | JWT + owner | Request an immediate I-frame (same mechanism as heal, different intent label). |
| GET | `/cameras/:monitorId/talk/status` | JWT + owner | Whether a two-way-audio session is open. |
| POST | `/cameras/:monitorId/talk/open` | JWT + owner | Open a talkback session (needs group credentials; `409` if already open). |
| POST | `/cameras/:monitorId/talk/audio` | JWT + owner | Append raw G.711 µ-law bytes, 8 kHz mono, `application/octet-stream`, ≤32 KB per chunk (`413` over that, `409` with no session). |
| POST | `/cameras/:monitorId/talk/close` | JWT + owner | Close the session. |

## `/api/restricted-zones`

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/restricted-zones?monitorId=` | JWT | List the caller's zones, optionally filtered to one camera. |
| POST | `/restricted-zones` | JWT | Create a zone. Body `{ monitorId, name, cameraName?, shape ('polygon'\|'rectangle'), points?, rect?, priority?, schedule?, armWindow?, dwellSec? (default 5), alertOnEntry?, allowed?, enabled? }`. |
| PUT | `/restricted-zones/:id` | JWT | Update any of those fields. |
| DELETE | `/restricted-zones/:id` | JWT | Delete a zone. |

## `/api/playback` — NVR playback

`playback.routes.js` → `playback.controller.js`. Replays the NVR's **own** recordings: builds a vendor RTSP playback URL, transcodes to H.264 with ffmpeg, publishes it to a short-lived stream path.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| POST | `/playback/nvr/start` | JWT | Body `{ monitorId, start, end }`. Range ≤ 6 h and not in the future; the vendor must support playback (Hikvision, Dahua/CP Plus — else `422`). Returns `{ success, pathName, hlsUrl, webrtcUrl, range, deviceType }`. Sessions are hard-killed after 30 min. |
| POST | `/playback/nvr/stop` | JWT | Body `{ pathName }` (must match `pb_…`). Kills ffmpeg and deletes the stream path. |

## `/api/subscription`

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/subscription/status` | JWT | The caller's active subscription + plan (`maxCameras`, `maxStorage`, price, billing cycle). |
| GET | `/subscription/license` | JWT | Active enterprise license: term, dates, `daysRemaining`, MRR/ARR, per-SKU resources, enabled features, and live camera utilisation. |

## `/api/payment`

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| POST | `/payment/create-checkout` | JWT + Joi | Body `{ planId (uuid), successUrl, cancelUrl, gateway ('stripe'\|'razorpay', default razorpay) }` → gateway checkout session. |
| POST | `/payment/verify` | JWT + Joi | Body `{ sessionId, gateway (default stripe) }` → verify and activate. |
| POST | `/payment/webhook` | Gateway signature (raw body) | Stripe (`stripe-signature`) or Razorpay (`x-razorpay-signature`) webhook. Unknown gateway → `400`. |

## `/api/turn`

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/turn/credentials` | JWT | Short-lived coturn REST credentials: `{ available: true, iceServers, username, expiresAt }`, or `{ available: false }` (HTTP 200) when `TURN_URI`/`TURN_SHARED_SECRET` are unset. |

## `/api/livekit`

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| POST | `/livekit/token` | JWT | Body `{ cameraId, role? ('subscriber'\|'admin') }`. Mints a room-scoped LiveKit participant JWT — the room name is derived from the cameraId, never accepted from the client. Returns `{ available: false }` when `LIVEKIT_WS_URL` is unset. |

## `/api/manage` — RBAC user administration

`manageUsers.routes.js`. `router.use(authenticate, requireCapability(MANAGE_USERS))` — the only router with an explicit capability gate. Everything is scoped to the caller's account, never another tenant.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/manage/users` | `manage_users` | The account owner + all sub-users, with resolved role labels and scope. |
| GET | `/manage/users/options` | `manage_users` | Assignable roles, the account's custom roles, and its Sites/Groups for the scope picker. |
| POST | `/manage/users` | `manage_users` | Create a sub-user. Body `{ name, username?, email?, password (≥8), role \| customRoleId, scope? { siteIds, groupIds } }`. |
| PUT | `/manage/users/:id` | `manage_users` | Update `name`, `role`/`customRoleId`, `scope`, `isActive`. The account owner can't be demoted or disabled here. |
| PUT | `/manage/users/:id/password` | `manage_users` | Admin password reset. Body `{ password }` (≥8). |
| DELETE | `/manage/users/:id` | `manage_users` | Soft-delete a sub-user (never the owner, never yourself). |
| GET | `/manage/roles` | `manage_users` | The account's custom roles. |
| GET | `/manage/roles/capabilities` | `manage_users` | Assignable capability keys + human labels (for the role editor). |
| POST | `/manage/roles` | `manage_users` | Create a custom role. Body `{ name, capabilities: [...] }` (at least one valid capability). |
| PUT | `/manage/roles/:id` | `manage_users` | Rename a role and/or replace its capability list. |
| DELETE | `/manage/roles/:id` | `manage_users` | Delete a role — `409` while any user still holds it. |

## `/api/admin` — platform operator only

`admin.routes.js`. `router.use(authenticate, adminAuth)` — requires the `isPlatformAdmin` JWT claim. These endpoints are cross-tenant.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/admin/stats` | Platform admin | Platform roll-up (users, cameras, events, revenue, trend). Query `range` ∈ `24h`, `7d`, `30d`, `90d`. |
| GET | `/admin/users` | Platform admin | All accounts with plan + camera counts. |
| GET | `/admin/users/:id` | Platform admin | One account with its subscription detail. |
| PUT | `/admin/users/:id/toggle-status` | Platform admin | Activate / suspend an account. |
| GET | `/admin/cameras` | Platform admin | All cameras across tenants. |
| GET | `/admin/events` | Platform admin | Recent AI events across tenants. |
| GET | `/admin/system-health` | Platform admin | The same deep component report as `/api/health/full`. |
| GET | `/admin/customers/:userId/camera-health` | Platform admin | One customer's camera-health table. |
| GET | `/admin/customers/:userId/ops-metrics` | Platform admin | Live per-customer ops metrics: model inferences, people detected, detecting cameras, fps, stream viewers, alerts triggered/delivered/unacked, configured push + email targets. |
| GET | `/admin/cameras/:monitorId/stream-start` | Platform admin | Warm **any** tenant's camera and return its WebRTC/HLS URLs for the monitoring preview. |
| GET | `/admin/datasets` | Platform admin | All uploaded face datasets. |
| GET | `/admin/datasets/download` | Platform admin | Signed download for one dataset object. |
| GET | `/admin/pricing-catalog` | Platform admin | Pricing catalog (seeded with defaults on first read if empty). |
| PUT | `/admin/pricing-catalog/:id` | Platform admin | Update a catalog item. |
| POST | `/admin/quotes/calculate` | Platform admin | Price a configuration: cameras/storage/GPU + AI features + support + term multiplier + discount + retention. |
| GET | `/admin/licenses` | Platform admin | List enterprise licenses. |
| GET | `/admin/licenses/:id` | Platform admin | One license with its resources + features. |
| POST | `/admin/licenses` | Platform admin | Create a license from a quote payload (transactional). |
| PUT | `/admin/licenses/:id/status` | Platform admin | Change license status (+ optional notes). |
| POST | `/admin/quotes` | Platform admin | Save a draft quote. |
| GET | `/admin/mail-config` | Platform admin | Platform SMTP settings + provider presets. The password is never returned — only `hasPassword`. |
| PUT | `/admin/mail-config` | Platform admin | Save SMTP settings (`provider` ∈ `gmail`\|`webmail`\|`custom`); an empty password keeps the stored one. |
| POST | `/admin/mail-config/test` | Platform admin | Send a test email using the **saved** config. Body `{ to }`. `502` on send failure. |
| PATCH | `/admin/cameras/:id/transcode` | Platform admin | Per-camera NVENC transcode toggle. Body `{ enabled: boolean, bitrateKbps?: 500..50000 }` — persists intent and calls the transcoder service. |
| GET | `/admin/transcoders` | Platform admin | Roll-up of desired (DB) vs live (transcoder service) transcoder state. |

## `/api/health`, `/api/metrics`, `/api/system`

Health and metrics are **unauthenticated by design** — production restricts `/full` and `/metrics` at the nginx layer.

| Method | Path | Auth/Capability | Description |
|---|---|---|---|
| GET | `/health` | Public | Shallow compatibility check: `{ status: 'ok', timestamp }`. |
| GET | `/health/live` | Public | Liveness — process only, no dependencies. `{ status: 'alive', version, uptime, pid, ts }`. |
| GET | `/health/ready` | Public | Readiness — DB + Redis + at least one stream server. `200` ready / `503` not ready. |
| GET | `/health/full` | Public | Deep diagnostic (DB, Redis, all stream servers, AI service, memory). Always `200`, even when degraded. |
| GET | `/metrics` | Public | Prometheus exposition of the global registry. |
| GET | `/system/storage` | JWT | Host disk + recordings sizes (cached, safe to poll). |

---

## Error format

Every error goes through `src/middleware/errorHandler.js` and comes back as:

```json
{ "success": false, "message": "Human-readable reason" }
```

with the HTTP status carried by `AppError(message, statusCode)` (`src/utils/AppError.js`). Stack traces are never returned — they are logged server-side. Any status **≥ 500 is rewritten to the generic `"Internal Server Error"`**, independent of `NODE_ENV`, so internal SQL or library text can never leak.

| Condition | Status | Body message |
|---|---|---|
| Joi validation failure (`validate` middleware) | 400 | All Joi messages, comma-joined |
| Missing / invalid / expired JWT | 401 | `Access denied. No token provided.` · `Invalid token.` · `Token expired. Please refresh your token.` |
| Capability, plan, or platform-admin gate | 403 | e.g. `You do not have permission to perform this action.` · `Access denied. Platform operator only.` |
| Unknown route | 404 | `Route <url> not found.` |
| Sequelize unique-constraint violation | 409 | `A record with this <field> already exists` |
| Sequelize validation error | 400 | Joined field messages |
| Rate limit exceeded | 429 | `Too many requests, please try again later.` · `Too many login attempts, please try again after 15 minutes.` |
| Upstream service (AI, activity-monitor, transcoder, SMTP) unreachable | 502 | Service-specific message |
| Anything unhandled | 500 | `Internal Server Error` |

Success envelopes are **not** uniform across the codebase: most controllers return `{ success: true, ... }`, while the streaming, internal-ingest and some proxy routes return `{ ok: true, ... }`. Binary endpoints (recording proxy, snapshots, MP4, PDF, CSV, HLS playlists) return raw bytes with the appropriate `Content-Type`.

---

## OpenAPI

A curated OpenAPI 3.0.3 document covering the core contract lives at `smart-cam-backend/docs/openapi.yaml` and is served raw, without auth, at:

```
GET /api/openapi.yaml        →  application/yaml
```

Load it directly in Swagger Editor, Postman, or any OpenAPI viewer. It intentionally documents the core surface rather than every endpoint — this file is the exhaustive reference.
