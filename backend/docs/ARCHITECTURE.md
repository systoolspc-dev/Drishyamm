# smart-cam-backend — Architecture

How the Node gateway is put together. Use this when you're trying to understand WHY a piece exists, not just what it does.

> **Writing a new backend service?** This doc describes smart-cam-backend specifically. The cross-service layout + conventions that ALL drisyam Node services should follow are in [docs/BACKEND-TEMPLATE.md](../../docs/BACKEND-TEMPLATE.md) at the repo root — read that first, then come back here for the worked example.

## Folder layout

```
smart-cam-backend/
├── docs/                           # this folder. ONBOARDING / ARCHITECTURE / FEATURES / TROUBLESHOOTING / CLOUDFLARE_TUNNEL
├── migrations/                     # Sequelize CLI migrations (one per schema change, immutable once merged)
├── seeders/                        # Sequelize seeders (idempotent — safe to re-run)
├── sql/                            # one-shot SQL: bootstrap-billing.sql, database.sql, fix-user.sql
├── scripts/                        # OPERATIONAL scripts run from the host (`node scripts/<file>.js`)
│   ├── create-admin.js             # the canonical seed-an-admin script
│   ├── add-test-camera.js
│   ├── start-all-cameras.js
│   ├── dev-probes/                 # throwaway probes (read scripts/dev-probes/README.md)
│   └── legacy-shinobi/             # archived Shinobi-era scripts (read README)
├── src/                            # the running app
│   ├── server.js                   # boot: load env → connect DB → wire routes → http.listen
│   ├── app.js                      # express() construction + middleware order
│   ├── config/                     # env.js, database.js, redis.js, logger.js, cors.js
│   ├── routes/                     # one router per domain (.routes.js suffix)
│   ├── controllers/                # one controller per domain (.controller.js)
│   ├── services/                   # business logic (.service.js); axios/SDK calls live here, NOT in controllers
│   ├── models/                     # Sequelize models, autoloaded by models/index.js
│   ├── middleware/                 # authenticate, authorize, asyncHandler, errorHandler, rateLimiter, serviceAuth
│   ├── validations/                # joi schemas grouped by domain (.validation.js)
│   ├── events/                     # in-process EventEmitter + EVENTS enum
│   ├── queues/                     # BullMQ queue definitions + worker wiring
│   ├── scripts/                    # IN-PROCESS diagnostic helpers (import from src/) — read the convention below
│   └── utils/                      # AppError, asyncHandler, digestAuth, semaphore, constants
├── Dockerfile
├── .env.example
├── .gitignore                      # do NOT commit dev probes / build.log / nul / .env
└── package.json
```

### Naming conventions

| What | Suffix / case | Example |
|---|---|---|
| Router file | `<domain>.routes.js` | `auth.routes.js` |
| Controller | `<domain>.controller.js` | `stream.controller.js` |
| Service | `<domain>.service.js` (camelCase if multi-word: `streamSupervisor.service.js`) | `s3.service.js` |
| Sequelize model | `PascalCase.js` (no suffix) | `User.js`, `AIEvent.js` |
| Validation | `<domain>.validation.js` | `auth.validation.js` |
| Joi/test schema | object exported with the verb as key: `{ login, register, ... }` | |
| Database table | snake_case, plural | `refresh_tokens` |
| Route path | kebab-case | `/api/face-learning/samples` |
| Env var | SCREAMING_SNAKE | `JWT_SECRET`, `S3_ENDPOINT` |

### `scripts/` vs `src/scripts/` — the rule

Both directories exist; the rule is **where the script runs from**, not what it does.

| Lives in | Runs as | Imports from | Examples |
|---|---|---|---|
| `scripts/` | a developer typing `node scripts/<file>.js` on the host | the package's existing `require()` graph, paths relative to `scripts/` | seed an admin, sync cameras, push config |
| `src/scripts/` | needs to be in the same `cwd` as `src/` so it can `require('../config/database')` to use the running DB connection pool | anywhere under `src/` | `diagnose-s3.js`, `fix-camera-snapshots.js` |

Rule of thumb: if it reuses the running app's models / sequelize instance / Redis pool, put it under `src/scripts/`. If it stands alone with its own connection, put it under `scripts/`.

If a new script doesn't clearly fit either bucket, it belongs in `scripts/` — that's the simpler default.

## Request lifecycle

```
Browser  ─────HTTP──────▶  Express on :5000
                              │
                              ▼
  /api/*  ▶  rate limiter  ▶  authenticate  ▶  (authorize)  ▶  controller  ▶  Sequelize/MySQL
                                                                      │
                                                                      ▼
                                                                  axios proxy → smart-cam-ai (8001)
                                                                                 face-reconstruct (8002)
                                                                                 MediaMTX (9997)
                                                                                 S3
                              │
                              ▼
                          errorHandler ─▶ JSON `{success:false, message, [stack in dev]}`
```

Routers live in `src/routes/`. Each one starts with `router.use(authenticate)` (or `router.use(serviceAuth)` for internal). Controllers in `src/controllers/` are thin: validate input, call a service/model, return JSON.

## Auth

[middleware/authenticate.js](../src/middleware/authenticate.js) — extracts JWT from `Authorization: Bearer …` or the auth cookie, verifies HS256 with `JWT_SECRET`, attaches `req.user = { id, email, role }`.

[middleware/authorize.js](../src/middleware/authorize.js) — gate by role. `authorize('admin')` returns 403 for non-admins.

[middleware/adminAuth.js](../src/middleware/adminAuth.js) — wrapper around the two for the admin panel.

[middleware/serviceAuth.js](../src/middleware/serviceAuth.js) — for `/api/internal/*`. Checks the `X-Service-Token` header against `SERVICE_TOKEN` env. Constant-time comparison. This is the surface smart-cam-ai uses to push events back.

Refresh tokens live in MySQL (`refresh_tokens` table) so they can be revoked. `auth.controller.js` issues both access + refresh on `/login`; refresh endpoint rotates them.

## Event lifecycle (the AI feed)

```
smart-cam-ai  ──POST /api/internal/ai/events──▶  internal.routes.js
                                                       │
                                                       ▼
                                              s3Service.putObject (snapshot)
                                                       │
                                                       ▼
                                              AIEvent.create (MySQL)
                                                       │
                                                       ▼
                                              emit(EVENTS.AI_EVENT_DETECTED, …)
                                                       │
                                          ┌────────────┼────────────┐
                                          ▼                          ▼
                                     ws.service.js              streamBus.service.js
                                  toUser(userId, "ai.event")  ▶  Redis Stream `drisyam:events:ai`
                                          │                                  │
                                          ▼                                  ▼
                                  Browser via Socket.IO          Multi-replica consumers
```

[events/bus.js](../src/events/bus.js) is a plain `EventEmitter` plus an `EVENTS` enum. Anyone emitting on it triggers both the in-process subscribers (ws.service) AND the Redis bridge (streamBus.service), so a sibling backend replica receives the event too.

Streams are bounded (`STREAM_BUS_MAXLEN`, default 50k) — capped via `XADD MAXLEN ~`.

## Stream supervisor

[services/streamSupervisor.service.js](../src/services/streamSupervisor.service.js) is a 2-second interval task that:

1. Calls MediaMTX's `GET /v3/paths/list` to enumerate live paths.
2. Compares against `Camera` rows.
3. Transitions `Camera.status` based on bps + age (`offline` → `connecting` → `streaming` → `degraded`).
4. Emits `STREAM_READY` / `STREAM_OFFLINE` events when a transition happens.

The Frontend's CameraHealth + Dashboard tiles read these states.

## S3 layer

[services/s3.service.js](../src/services/s3.service.js) wraps the AWS SDK v3:

- **Recording upload** — multipart for >5 MB files (the GoP-merged MP4s ffmpeg writes). Retries on `ECONNRESET / ETIMEDOUT / EPIPE / ENOTFOUND`.
- **Playback URLs** — `getSignedUrl(GetObjectCommand, …, expiresIn:3600)`. The frontend opens these directly; backend never proxies the bytes.
- **Snapshot upload** — small-blob `putObject` from `/api/internal/ai/events`.
- **Bucket layout** — `recordings/{userId}/{group}/{camera}/{YYYY-MM-DD}/{filename}` for clips, `ai/events/{userId}/{monitorId}/{ts}.jpg` for snapshots, `watchlist-datasets/{userId}/…` for dataset uploads.

The endpoint defaults to `https://s3.10pb.com` (NetForChoice 10PB). Override via `S3_ENDPOINT` for local MinIO or AWS.

## person-tracker proxy

[routes/personTracker.routes.js](../src/routes/personTracker.routes.js) + [controllers/personTracker.controller.js](../src/controllers/personTracker.controller.js) — mounted at `/api/person-tracker/*`. JWT-authenticated. Forwards to the standalone `person-tracker` service (FastAPI on `:8003`) with `X-Service-Token` injected so the SPA never sees the secret.

Routes covered: `POST /search`, `POST /sightings/cluster`, `POST /stitch`, `GET /stitch/:id`, `GET /stitch/:id/video`, `GET /stitch/:id/report.pdf`, `GET /stitch/:id/map.json`.

Video + PDF downloads return a `302` to a presigned MinIO URL — we relay the redirect, bytes never pass through this service. Same approach used by other large-binary routes (S3 playback).

See `person-tracker/docs/API.md` for the upstream contract.

## Legacy: Shinobi

drisyam used Shinobi as its RTSP/HLS broker until early 2026; MediaMTX replaced it. The migration is mostly done but a few archeological pieces remain:

- [routes/shinobi.routes.js](../src/routes/shinobi.routes.js) + [controllers/shinobi.controller.js](../src/controllers/shinobi.controller.js) + [services/shinobi.service.js](../src/services/shinobi.service.js) — still wired but only return 404/no-op against an unreachable Shinobi. Frontend imports of `services/shinobi.js` exist as a shim ([../../smart-cam-app/src/services/shinobi.js](../../smart-cam-app/src/services/shinobi.js)) for the same reason.
- [scripts/legacy-shinobi/](../scripts/legacy-shinobi/) — three historical operational scripts. Don't run them on a live deployment.

Full removal is on the deferred list (touches ~10 frontend files + ~5 backend files). Until that pass, treat anything Shinobi-named as dead-but-quiet.

## MediaMTX integration

[services/mediamtx.service.js](../src/services/mediamtx.service.js) — URL building (`rtsp://mediamtx:8554/cam_<monitor_id>` for full HD, `…_sub` for the sub-stream), path management via the MediaMTX HTTP API.

[services/transcoder.service.js](../src/services/transcoder.service.js) — spawns ffmpeg with NVENC for recording the live RTSP into MP4 clips. Restarts on failure with exponential backoff.

When a Camera row is created/updated, the backend creates the path in MediaMTX (`POST /v3/config/paths/add/<name>`); when deleted, the path is removed.

## Device probes

[services/deviceProbe.service.js](../src/services/deviceProbe.service.js) and [controllers/deviceProbe.controller.js](../src/controllers/deviceProbe.controller.js) — ONVIF/Hikvision ISAPI/Dahua CGI clients for:

- Reading the device model + capabilities
- Mutating the H.264 encoder profile (Hikvision/Dahua) — the "Face Quality Boost" feature
- Setting keyframe intervals
- Listing channels for NVR-attached groups

All HTTP digest auth via [utils/digestAuth.js](../src/utils/digestAuth.js).

Lots of vendor quirks live here — Hikvision NVR-attached channels reject `<maxFrameRate>0 → N` overwrites; we now skip that field when current value is 0 (see commits + smart-cam-ai/docs/TROUBLESHOOTING.md).

## WebSocket (Socket.IO)

[services/ws.service.js](../src/services/ws.service.js) mounts Socket.IO on the Express server. Authentication is on-connect via the same JWT.

Channels:
- `ai.event` — every AIEvent row, scoped per-user (`toUser(userId, …)`)
- `ai.alert` — watchlist hits (same channel as ai.event with `kind=alert`)
- `stream.ready` / `stream.offline` — emit when Supervisor transitions
- `camera.created` / `camera.updated` / `camera.deleted`

The frontend listens in [services/socket.js](../../smart-cam-app/src/services/socket.js).

## Queues (BullMQ)

[queues/index.js](../src/queues/index.js) defines named queues backed by Redis. The largest is `drishyam-ai-events` — used to ingest in bursts. [queues/workers.js](../src/queues/workers.js) wires the consumers.

## Sequelize models

Convention: PascalCase class, snake_case table. `src/models/index.js` autoloads every `*.js` in the folder, then runs `.associate()` on each to set up FK relations.

Key models:
- `User`, `RefreshToken`, `PasswordReset`
- `Camera`, `CameraGroup`, `Site`
- `AIEvent` (snapshotKey, eventType, severity, bbox, trackId, confidence, payload)
- `MediamtxServer` (for multi-MediaMTX deployments)
- `License`, `LicenseFeature`, `LicenseResource`
- `Plan`, `PricingCatalog`, `Quote`, `Subscription`, `Payment`
- `AdminUser`, `AdminAuditLog`

## Error handling

[middleware/errorHandler.js](../src/middleware/errorHandler.js) — final middleware. Maps `AppError` to the proper status + message; unknown errors → 500 with stack in dev, generic in prod.

[utils/AppError.js](../src/utils/AppError.js) — `throw new AppError(message, statusCode)`.

[utils/asyncHandler.js](../src/utils/asyncHandler.js) — wraps an async controller so unhandled rejections route to the error middleware. Use it on every controller.

## Hard rules

- **Every controller goes through `asyncHandler`.** No naked `async` request handlers.
- **Never log a password / JWT / refresh token.** Even in debug mode.
- **`req.user.id`, never `req.body.userId`.** Auth scope is the JWT, not the request body.
- **S3 keys are namespaced by `userId`.** Multi-tenancy is enforced by key prefix, not query filter.
- **Service-token routes are NOT publicly mounted.** They live under `/api/internal/*` behind `serviceAuth`.
- **All writes to the AI service are proxied.** Never let the frontend talk to `smart-cam-ai` directly — auth scope would be wrong.
