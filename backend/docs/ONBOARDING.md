# smart-cam-backend — Onboarding

You're reading this because you'll be writing code in the Node.js gateway. Read it once start-to-finish; skim it when stuck.

## What this service is

`smart-cam-backend` is the **Express + Sequelize gateway** that sits between the React frontend (`smart-cam-app`) and the rest of the platform. It owns:

- Operator auth (JWT + refresh tokens, password reset)
- The relational source of truth: MySQL `drishyamvms` schema — users, camera_groups, cameras, ai_events, sites, plans, billing, licensing
- Camera + group CRUD, RTSP credential capture, ONVIF/Hikvision/Dahua device probes
- Stream supervisor — polls MediaMTX, surfaces health on the dashboard
- All proxies to the Python AI: `/api/ai/*` → `smart-cam-ai:8001`, `/api/ai/enhance` → `face-reconstruct:8002`
- S3 (NetForChoice 10PB) — recording uploads, AI event snapshots, watchlist dataset uploads
- WebSocket fan-out — `ai.event`, `ai.alert`, `stream.ready`, `stream.offline`
- Scheduled jobs — retention sweeps, license probes, audit log writes

The frontend talks to this on `http://localhost:5000/api/*`. The Python AI service talks to it via service-token-authed `/api/internal/*` endpoints.

## Repo layout

```
smart-cam-backend/
├── src/
│   ├── server.js                 ← entrypoint — Express app + websocket bootstrap
│   ├── config/
│   │   ├── env.js                ← Joi-validated environment schema
│   │   ├── database.js           ← Sequelize init
│   │   └── logger.js             ← Winston instance
│   ├── routes/                   ← one file per route group
│   │   ├── index.js              ← mounts the rest
│   │   ├── auth.routes.js, users.routes.js
│   │   ├── camera.routes.js, cameraGroup.routes.js
│   │   ├── ai.routes.js          ← all /api/ai/* (50+ endpoints)
│   │   ├── recording.routes.js
│   │   ├── internal.routes.js    ← X-Service-Token gated; called by smart-cam-ai
│   │   ├── admin.routes.js, billing.routes.js, license.routes.js
│   │   └── …
│   ├── controllers/              ← request handlers — one file per route group
│   ├── middleware/               ← authenticate, authorize, serviceAuth, errorHandler, validate
│   ├── models/                   ← Sequelize models (User, Camera, CameraGroup, AIEvent, …)
│   ├── services/                 ← stateless business logic
│   │   ├── s3.service.js         ← AWS SDK v3 wrapper for the recording + snapshot bucket
│   │   ├── shinobi.service.js    ← legacy name — actually talks to MediaMTX now
│   │   ├── mediamtx.service.js   ← path management + URL building
│   │   ├── streamSupervisor.service.js  ← polls MediaMTX, transitions Camera.status
│   │   ├── streamBus.service.js  ← Redis Streams bridge for cross-process events
│   │   ├── ws.service.js         ← Socket.IO server
│   │   ├── deviceProbe.service.js  ← ONVIF/Hikvision/Dahua encoder mutation
│   │   ├── transcoder.service.js ← ffmpeg/NVENC for recording
│   │   └── …
│   ├── events/bus.js             ← in-process EventEmitter + EVENTS enum
│   ├── queues/                   ← BullMQ definitions (ai-event-ingest etc.)
│   ├── utils/                    ← AppError, asyncHandler, digestAuth, constants
│   └── migrations/               ← Sequelize migrations
├── scripts/
│   ├── create-admin.js           ← seed an admin user
│   └── add-nvr-cameras.js
├── logs/                         ← Winston output (gitignored)
├── package.json
└── .env                          ← DO NOT COMMIT secrets
```

## How to run it

### With the rest of the stack (recommended)

```sh
cd C:\Users\systo\Desktop\anil\drisyam
docker compose up -d smart-cam-backend
docker compose logs -f smart-cam-backend
```

`./smart-cam-backend` is bind-mounted to `/app` in the container; `npx nodemon src/server.js` watches `src/` so any edit triggers a restart in 1-2 s.

### Standalone (rare)

```sh
cd smart-cam-backend
cp .env.example .env       # then edit DB creds + S3 + AI_BASE
npm install
npm run dev                 # nodemon
```

The standalone mode is brittle because the service expects MySQL + Redis + smart-cam-ai + MediaMTX reachable. The compose path is what works.

### First-time setup

```sh
# Seed an admin user
docker compose exec -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='choose-a-strong-one' smart-cam-backend node scripts/create-admin.js
# needs ADMIN_EMAIL + ADMIN_PASSWORD in the environment — see scripts/create-admin.js
```

## Env vars you'll touch most

Read [src/config/env.js](../src/config/env.js) for the validated schema. Common ones:

| Var | Default | Notes |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `mysql` / 3306 / root / "" / `drishyamvms` | Compose service `mysql` |
| `JWT_SECRET` | (set in .env) | ≥32 chars; failing this kills the service at boot |
| `JWT_EXPIRES_IN` | 15m | Access token TTL |
| `REFRESH_TOKEN_EXPIRES_IN` | 30d | Refresh token TTL |
| `AI_BASE` | `http://smart-cam-ai:8001` | Where to proxy /api/ai/* |
| `FACE_RECONSTRUCT_BASE` | `http://face-reconstruct:8002` | CodeFormer service |
| `SERVICE_TOKEN` | (set in .env) | Shared with smart-cam-ai for /api/internal/* |
| `S3_ENDPOINT` | `https://s3.10pb.com` | NetForChoice |
| `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | — | object storage |
| `REDIS_URL` | `redis://redis:6379/0` | Streams + Pub/Sub |
| `MEDIAMTX_BASE` | `http://mediamtx:9997` | MediaMTX API |
| `WS_PORT` | shares 5000 | Socket.IO mounted on the Express server |
| `NODE_ENV` | `development` | Toggles stack traces in error responses |
| `LOG_LEVEL` | `info` | `debug` for verbose; check logs/combined.log |

## Where to put your code

| Task | Files to touch |
|---|---|
| Add a REST endpoint | `src/controllers/<topic>.controller.js` + register in `src/routes/<topic>.routes.js` + mount in `src/routes/index.js` if new |
| Add a DB column/table | `src/migrations/<ts>-<desc>.js` (sequelize-cli format) + update `src/models/<Model>.js` |
| Validate request body | Joi schema near the controller, run through the `validate` middleware |
| Call the AI service | Use the proxy pattern from `controllers/ai.controller.js`'s `peopleCount` / `footfallCameras` — `axios.get(`${AI_BASE}/…`, { headers: aiOperatorHeaders(req), timeout: … })` and map errors to 502 |
| Auth-required route | Mount under a router that already calls `router.use(authenticate)` (every router under `src/routes/` except auth + internal does) |
| Admin-only route | Add `authorize('admin')` middleware after `authenticate` |
| Internal-only route (called by smart-cam-ai) | Put it in `src/routes/internal.routes.js` (or a sibling using `serviceAuth` middleware) |
| Long-running async job | Push onto a BullMQ queue in `src/queues/` |
| Emit an event to operators | `emit(EVENTS.AI_EVENT_DETECTED, { event, userId })` from `events/bus.js`; the WS service forwards it |

## Three first-PR ideas

1. **5-line PR — surface a field.** Add the `last_seen_at` column to the `GET /api/cameras` response by appending it to `serializeMappedCamera()` in [controllers/ai.controller.js](../src/controllers/ai.controller.js). Verify with `curl`.

2. **50-line PR — a new endpoint.** Add `GET /api/cameras/:id/uptime-percentage` that returns last-7-day uptime by averaging the `Supervisor` transitions in MySQL (or a derived field on Camera). One controller, one route, one query.

3. **200-line PR — a new feature.** Add audit logging for camera deletions: when `DELETE /api/cameras/:id` succeeds, write an `audit_log` row with `actor=req.user.id, action='camera.delete', target_id=cameraId, metadata={name, monitorId}`. Add a corresponding `GET /api/admin/audit?action=camera.delete&from=&to=` admin endpoint.

## Where to ask

- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Per-feature reference: [FEATURES.md](FEATURES.md)
- "It's not working": [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- AI internals: `smart-cam-ai/docs/`
- Operator-facing UI: `smart-cam-app/docs/`
