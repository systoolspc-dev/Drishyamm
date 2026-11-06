# 05 — Codebase Guide

This repo is a **monorepo**. It holds every service that makes up Drishyam VMS: the
Node/Express control plane, the React operator console, the Python AI service, the
media gateway config, the React Native mobile app, the marketing site, and the
ops/deployment glue.

Nothing here is a single "app". When you get a task, the first question is always
*which component owns this?* — this guide answers that.

**Read `docs/04-architecture.md` first** if you don't yet know how the pieces talk to
each other. This document is the map of *where the code lives*.

---

## Where do I change X?

The most useful table in this doc. Start here.

| I want to… | Go to |
|---|---|
| Add / change a REST endpoint | `smart-cam-backend/src/routes/*.routes.js` (+ mount it in `routes/index.js`) then `smart-cam-backend/src/controllers/*.controller.js` |
| Change how a camera is discovered / connects / is configured (per brand) | `smart-cam-backend/src/services/vendors/index.js` — the driver registry (`DRIVERS`, `PLAYBACK_BUILDERS`) |
| Change how a live path is created / deleted / patched on the media server | `smart-cam-backend/src/services/streaming/StreamServiceEngine.js` (implementation) — never call it directly, go through `services/drishyamStreaming.service.js` |
| Change live-player behaviour (WebRTC/HLS, zoom, stalls, quality selector) | `smart-cam-app/src/core/players/` (`WebRTCPlayer.jsx`, `HLSPlayer.jsx`, `PlayerFrame.jsx`) |
| Change recording retention (how long clips are kept) | `smart-cam-backend/src/services/recordingRetention.service.js` (local/NAS via the media server) and `s3Retention.service.js` (durable object-store copy) |
| Fix "recordings aren't reaching S3" or "a camera path vanished" | `smart-cam-backend/src/services/recordingSync.service.js` — the S3-sync loop + the watchdog |
| Fix "camera shows offline but it's fine" | `smart-cam-backend/src/services/streamSupervisor.service.js` + `cameraReachability.service.js` |
| Add / change an AI analytic (detection logic) | `smart-cam-ai/app/face_detection/vms_face/services/` + wire it in `pipeline/orchestrator.py`, expose it in `api/routes/` |
| Add a page for an AI analytic | `smart-cam-app/src/ai-analytics/components/<Feature>/` + a route in `smart-cam-app/src/App.jsx` |
| Change when an alert fires / who gets it (push + email) | `smart-cam-backend/src/services/alertEngine.js` (delivery via `push.service.js` / `email.service.js`) |
| Change what a plan tier unlocks | `smart-cam-backend/src/services/entitlements.service.js` + `middleware/requireAiCapability.js`; camera counts in `cameraQuota.service.js` |
| Change RBAC roles / capabilities | `smart-cam-backend/src/utils/constants.js` (built-in tiers) + `middleware/requireCapability.js`; custom roles in `models/Role.js` |
| Change how camera credentials are stored | `smart-cam-backend/src/utils/fieldCrypto.js` (AES-256-GCM Sequelize get/set) |
| Change how the browser is authorised to fetch HLS/WebRTC | `smart-cam-backend/src/utils/streamToken.js` (short-lived per-camera signed tokens) |
| Change which AI tenant/org a request lands in | `smart-cam-backend/src/utils/aiTenant.js` (mints the per-org JWT the AI service scopes on) |
| Add a background job / periodic task | `smart-cam-backend/src/queues/index.js` + `queues/workers.js` (BullMQ; legacy `setInterval` fallback lives in `server.js`) |
| Add a DB table / column | `smart-cam-backend/src/models/*.js` + a migration in `smart-cam-backend/migrations/` |
| Change media-server tuning (segment length, auth, ports, record settings) | `stream-service.yml` at the repo root (bind-mounted into the container) |
| Change something in the phone app | `drishyam_app/src/screens/` (screens) / `drishyam_app/src/lib/` (api, auth, push) |
| Change the public marketing site | `brand-site/` (current). `smart-cam-marketing/` is the older static site — legacy |
| Change dashboards / metrics | `smart-cam-backend/src/services/metrics.service.js` (emit) + `observability/grafana/dashboards/` (display) |

---

## Repo root

```
drisyam/
├── smart-cam-backend/       Node/Express control plane + REST API + background workers
├── smart-cam-app/           React (Vite) operator console — the main web UI
├── smart-cam-ai/            Python AI services (face recognition, headcount, activity, …)
├── stream-service/          Dockerfile for "Drishyam Stream Service" (branded MediaMTX)
├── smart-cam-transcoder/    Python sidecar for H.265→H.264 transcoding
├── smart-cam-sfu-bridge/    Python bridge that publishes camera streams into an SFU (LiveKit)
├── drishyam_app/            React Native / Expo mobile app
├── brand-site/              Public marketing website (static multi-page HTML)
├── edge-relay/              PowerShell scripts for on-prem edge relays / NVR reachability
├── observability/           Prometheus config + Grafana dashboards & provisioning
├── case-studies/            Customer case-study markdown
├── proposals/               Sales/solution proposals
├── docs/                    This documentation set
├── scripts/                 Ops shell scripts (DB backup, enable stream auth)
├── camera-name-discovery/   Standalone reference implementation of channel-name discovery
├── smart-cam-marketing/     LEGACY static marketing site (superseded by brand-site/)
├── backup/                  Archived one-off files (old SQL dump, Shinobi-era scripts) — legacy
├── mediamtx-recordings/     Local recordings mount point (empty in git)
└── _local/                  Local-only scratch (archives, media, screenshots) — not part of the build
```

### Key root files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Base stack: mysql, redis, postgres, qdrant, minio, kafka, mediamtx, smart-cam-backend, smart-cam-ai, smart-cam-ai-worker, journey-stitch-worker, face-reconstruct, smart-cam-sfu-bridge, smart-cam-transcoder, cloudflared, smart-cam-app, footfall-demo |
| `docker-compose.drisyam-original.yml` | The stack actually used for the live demo — same services, but with `stream-service` (the renamed media gateway) and an extra `activity-monitor` container |
| `docker-compose.deepstream.yml` | Overlay that swaps `smart-cam-ai` for the DeepStream build |
| `docker-compose.observability.yml` | prometheus, grafana, cadvisor, node/redis/mysqld/postgres exporters |
| `stream-service.yml` | Media-gateway (MediaMTX) runtime config — control API on `:9997`, metrics `:9998`, RTSP `:8554`, HLS/WebRTC, recording settings. Camera paths (`cam_<monitorId>`) are added dynamically by the backend, not written here |
| `nginx.conf` | Reverse proxy: SPA, `/api`, `/ai`, `/hls`, WHEP |

---

## Backend — `smart-cam-backend/`

Node / Express / Sequelize (MySQL) / Redis / BullMQ / socket.io.

```
smart-cam-backend/
├── src/
│   ├── server.js          boot: DB → HTTP+socket.io → BullMQ → background loops → shutdown
│   ├── app.js             the Express app: middleware order + route mount
│   ├── config/            env, logger, db, redis, cors, security headers
│   ├── routes/            one file per API surface, mounted in routes/index.js
│   ├── controllers/       request handlers (thin — logic belongs in services/)
│   ├── services/          the real work: streaming, recording, AI, billing, alerts
│   ├── models/            Sequelize models + associations (models/index.js)
│   ├── middleware/        auth, RBAC, validation, rate limiting, error handling
│   ├── utils/             crypto, tokens, audit, constants, helpers
│   ├── queues/            BullMQ queue registry + workers
│   ├── events/            in-process event bus (EventEmitter)
│   ├── validations/       Joi schemas (auth, payment, shinobi)
│   ├── validators/        Joi schemas (cameraGroup) — same idea, second folder
│   └── scripts/           one-off diagnostic/repair CLIs
├── migrations/            Sequelize CLI migrations (001…N, run with npm run db:migrate)
├── seeders/               seed data
├── test/                  Jest suite (hermetic — no local .env needed)
└── docs/                  openapi.yaml (served at /api/openapi.yaml)
```

`npm run dev` (nodemon), `npm test` (jest), `npm run db:migrate`.

### `src/server.js` — boot order (read this first)

The startup sequence is deliberate and order-dependent:

1. `sequelize.authenticate()` — fail fast if the DB is down. `sequelize.sync()` only in development.
2. `http.createServer(app)` and **`wsService.init(server)` before `listen()`** — otherwise the socket.io upgrade handler is never registered.
3. `queueWorkers.start()` — BullMQ. If Redis is unavailable it returns false and the legacy `recordingSync.start()` interval loop takes over.
4. `streamBus.start()` — cross-process Redis-Streams bus. **Must come before the supervisor** so its bridge is wired.
5. `streamSupervisor.start()` — camera health watcher (idempotent; only the leader tick does work).
6. `streamReconcile.start()` — continuous DB → media-server config reconciliation.
7. `aiLifecycle.start()` — keeps the "AI Detection Cameras" selection in sync with the AI runtime.
8. `zoneIntrusion.init()` — restricted-zone intrusion engine.
9. `aiEventRetention.start()` / `s3Retention.start()` — pruning loops (S3 deletion stays dry-run until `S3_RETENTION_DELETE=1`).
10. A `CAMERA_DELETED` bus subscriber that tears down supervisor state, quality state, the FFmpeg transcoder, and the transcoded paths — this is the anti-zombie-stream hook.

Graceful shutdown on SIGTERM/SIGINT stops every loop, drains queues, closes the DB, force-exits after 10s. Transient network errors (`EPIPE`, `ECONNRESET`, …) are downgraded to warnings so a flaky camera can't kill the process.

### `src/app.js` — middleware order (also order-dependent)

1. `trust proxy` (required for rate limiting behind nginx)
2. `securityHeaders` → `cors`
3. **Body parsing with per-route exceptions** — this block matters:
   - `/api/payment/webhook` → skipped (needs the raw body)
   - `/api/internal/*` → skipped (the internal router installs its own `json({ limit: '2mb' })`)
   - `/api/cameras/:id/talk/audio` → skipped (raw G.711 µ-law bytes)
   - `/api/person-tracker/*` → `json({ limit: '5mb' })`
   - everything else → `json({ limit: '10kb' })`
4. `apiLimiter` rate limiting on `/api`
5. `metrics.httpMiddleware()` — **before** routes, so it can wrap `res.on('finish')`
6. `/api/openapi.yaml` static spec, then `/api` routes
7. 404 handler → `errorHandler`

### `src/config/`

| File | Purpose |
|---|---|
| `env.js` | Reads + validates every env var, exports the typed config object |
| `logger.js` | Winston logger (console + file) |
| `database.js` | Sequelize connection config per environment |
| `redis.js` | Redis client with graceful fallback |
| `cors.js` | CORS options from `CORS_ORIGINS` |
| `securityHeaders.js` | Helmet/CSP policy + rationale |
| `prodSecretGuard.js` | Refuses to boot production with default/placeholder secrets |

### `src/routes/` → mount points

All under `/api` (see `routes/index.js`):

| Route file | Mounted at | Notes |
|---|---|---|
| `auth.routes.js` | `/auth` | login, register, refresh, password reset |
| `user.routes.js` | `/user` | profile / settings |
| `cameraGroup.routes.js` | `/groups` | groups + cameras + device probe |
| `cameraHealth.routes.js` | `/cameras` | health, stream heal, talkback |
| `stream.routes.js` | `/stream` | start/stop live streams, URLs, tokens |
| `playback.routes.js` | `/playback` | NVR playback (replay the NVR's own recordings) |
| `ai.routes.js` | `/ai` | AI proxy, live overlay, AI camera selection |
| `personTracker.routes.js` | `/person-tracker` | authenticated proxy to the journey / person-tracker API |
| `restrictedZone.routes.js` | `/restricted-zones` | drawn no-entry zones |
| `notifications.routes.js` | `/notifications` | push-token registration + alert email recipients |
| `site.routes.js`, `bulkImport.routes.js` | `/sites`, `/sites/:siteId/import` | sites + bulk camera import |
| `subscription.routes.js`, `payment.routes.js` | `/subscription`, `/payment` | plans, licenses, Razorpay/Stripe |
| `manageUsers.routes.js` | `/manage` | RBAC user + custom role administration |
| `admin.routes.js` | `/admin` | platform-operator dashboard (gated by `adminAuth`) |
| `internal.routes.js` | `/internal` | service-to-service (AI → backend), gated by `serviceAuth` |
| `turn.routes.js`, `livekit.routes.js` | `/turn`, `/livekit` | TURN creds; LiveKit subscriber JWTs. Both return `{ available: false }` when unconfigured |
| `health.routes.js`, `metrics.routes.js`, `system.routes.js` | `/health`, `/metrics`, `/system` | liveness/readiness/deep, Prometheus scrape, host disk stats |
| `shinobi.routes.js` | `/shinobi` | **Legacy name, live code** — still serves camera CRUD, but the controller now drives `drishyamStreaming.service`, not Shinobi |

### `src/controllers/`

One controller per surface, kept thin. Beyond the obvious 1:1 mappings, note the ones mounted inside another route file: `deviceProbe.controller.js` (in `cameraGroup.routes`), `streamHeal.controller.js` + `talkback.controller.js` (in `cameraHealth.routes`), `alertEmail.controller.js` (in `notifications.routes`), `manageRoles.controller.js` (in `manageUsers.routes`), and `billing` / `license` / `transcode` / `mailConfig.controller.js` (all in `admin.routes`).

### `src/services/` — one line each

**Streaming / media (the core of the product)**

| File | Purpose |
|---|---|
| `drishyamStreaming.service.js` | The app-facing streaming facade — the single abstraction the rest of the backend imports for live/record path control |
| `streaming/StreamingEngine.js` | The abstract contract every streaming engine must satisfy; the backend depends only on this surface |
| `streaming/StreamServiceEngine.js` | The concrete engine — talks the media server's REST control API (`:9997`), RTSP pull (`:8554`), HLS/WebRTC egress |
| `streaming/index.js` | Engine factory; selects the implementation by `STREAMING_ENGINE` (default `mediamtx`) |
| `streamRouter.service.js` | Pool-aware wrapper over the single-instance shim — routes a camera to the right media server when there is more than one |
| `stream.service.js` | Thin orchestration over the engine: start/stop a camera's live stream, build URLs |
| `streamSupervisor.service.js` | Real-time data-plane health monitor per camera ("is this stream actually alive?") |
| `streamQuality.service.js` | Per-camera quality telemetry + active healing (supervisor decides alive/dead, this decides good/bad) |
| `streamReconcile.service.js` | Continuous DB → media-server config sync; re-converges retention/config drift after restarts or failed patches |
| `streamBus.service.js` | Cross-process event bus on Redis Streams |
| `transcoder.service.js` | On-demand H.265 → H.264 FFmpeg transcoder producing the `cam_<id>_h264` paths |
| `talkback.service.js` | Two-way audio (push-to-talk): browser mic → camera speaker |
| `streamService.shim.js` | **Deprecated** back-compat re-export of `drishyamStreaming.service` |
| `shinobi.service.js` | **Legacy** Shinobi HTTP client, kept only for remaining imports |

**Recording / storage**

| File | Purpose |
|---|---|
| `recordingSync.service.js` | **Two loops.** (1) S3 sync every 5 min: reads completed segments off the bind-mounted recordings volume, uploads to object storage, deletes the local copy. (2) Watchdog every 2 min: compares DB cameras against the paths configured on the media server, re-adds missing ones, reconciles orphans, syncs online/offline status. The media server has no persistent DB — the MySQL DB is the source of truth |
| `recordingRetention.service.js` | Per-camera / per-location retention resolution (Camera → Group → Site → default), applied via the media server |
| `s3Retention.service.js` | Enforces the same retention on the durable object-storage copy; dry-run until `S3_RETENTION_DELETE=1` |
| `s3.service.js` | S3-compatible SDK wrapper (upload, presign, list, key building) |
| `localRecordings.service.js` | Serves recordings straight off the local recordings volume (`RECORDINGS_DIR/cam_<monitorId>/<date>/…`), bypassing object storage |
| `storage.service.js` | Real on-disk stats (`df` + `du`) on the bind-mounted `/recordings` volume |

**AI / alerting**

| File | Purpose |
|---|---|
| `alertEngine.js` | Decides whether a persisted AI event becomes a phone alert and/or an email, and delivers it (dedup + cooldown + burst cap) |
| `push.service.js` | Mobile push delivery via Expo's HTTP push API |
| `email.service.js` | Transactional + alert email; SMTP resolved from the admin `MailConfig` row first, env second |
| `zoneIntrusion.service.js` | L3 restricted-zone engine (occupancy model, K-of-N confirm + dwell + cooldown), fed by live overlay person boxes |
| `aiLifecycle.service.js` | Reconciles the persisted "AI Detection Cameras" list against the AI runtime — selected cameras run continuously, unselected ones stop |
| `aiEventRetention.service.js` | Prunes the backend's MySQL `ai_events` mirror (the AI service prunes its own Postgres/Qdrant store separately) |

**Devices / tenancy / commerce / platform**

| File | Purpose |
|---|---|
| `vendors/index.js` | **The driver registry** — single source of truth for per-vendor camera behaviour (`DRIVERS` capabilities, aliases, `PLAYBACK_BUILDERS` for NVR playback URLs). Covers hikvision, dahua, cpplus, axis, uniview, hanwha, bosch, onvif, generic. It replaced four drifting switch statements; add a brand here and nowhere else |
| `deviceProbe.service.js` | Talks to NVR / camera HTTP APIs to discover device name, model and channels; sets encoder + keyframe config |
| `cameraReachability.service.js` | Lightweight per-NVR reachability prober (separates "NVR unreachable" from "stream not started") |
| `cameraQuota.service.js` | Plan-based camera-count enforcement on every real create path (group create, add-channels, bulk import) |
| `entitlements.service.js` | Plan-tier capability resolution — "Basic VMS" vs "AI+VMS"; the authoritative signal for every AI feature |
| `auth.service.js` | Access/refresh JWT minting, password hashing |
| `payment.service.js` | Checkout session creation; auto-selects the gateway |
| `razorpay.service.js`, `stripe.service.js` | Gateway API wrappers |
| `metrics.service.js` | Prometheus registry singleton + the HTTP metrics middleware |
| `ws.service.js` | socket.io channel; clients authenticate with `auth: { token }` in the handshake |

### `src/models/`

`models/index.js` instantiates Sequelize and wires every association — start there.

| Model | Table | Purpose |
|---|---|---|
| `User.js` | `users` | Account, role, org/tenant identity, subscription link |
| `Role.js` | `roles` | Account-defined custom roles (built-in tiers live in `utils/constants.js`) |
| `RefreshToken.js` | `refresh_tokens` | Refresh-token store |
| `PasswordReset.js` | `password_resets` | Password-reset tokens |
| `Site.js` | `sites` | Physical location grouping camera groups |
| `CameraGroup.js` | `camera_groups` | A group of cameras (typically one NVR or one area) |
| `Camera.js` | `cameras` | One camera: `monitorId`, credentials (encrypted), status, retention, quality, supervisor state |
| `StreamServer.js` | `mediamtx_servers` | One media-server instance in the pool (used by `streamRouter.service.js`) |
| `AIEvent.js` | `ai_events` | One row per detection emitted by smart-cam-ai (the backend's mirror) |
| `RestrictedZone.js` | `restricted_zones` | A no-entry area drawn on one camera; many rows per user/camera |
| `AlertEmail.js` | `alert_emails` | An address a user wants alerts delivered to, with per-recipient priority + type routing |
| `DeviceToken.js` | `device_tokens` | One row per mobile device registered for push |
| `MailConfig.js` | `mail_config` | Singleton (id=1) admin-managed SMTP config; password encrypted at rest |
| `Plan.js` | `plans` | Subscription tiers (incl. the `aiEnabled` flag) |
| `Subscription.js` | `subscriptions` | A user's active plan + billing state |
| `Payment.js` | `payments` | Payment records |
| `PricingCatalog.js` | `pricing_catalog` | SKU catalog: sku, name, category, unit, unit price (INR) |
| `Quote.js` | `quotes` | A generated quote: line items, term, discount, subtotal |
| `License.js` | `licenses` | Enterprise license: status, term, dates, license key, currency |
| `LicenseResource.js` | `license_resources` | Per-SKU quota + used count + price snapshot for a license |
| `LicenseFeature.js` | `license_features` | Feature flags enabled on a license |

### `src/middleware/`

| File | Purpose |
|---|---|
| `authenticate.js` | Verifies the JWT; also accepts `?token=` for URLs the browser loads directly (`<video src=…>` can't send custom headers) |
| `authorize.js` | Role-based authorization factory |
| `requireCapability.js` | Capability gate that loads the **fresh** user row, so a role/scope change or deactivation takes effect without waiting for token expiry |
| `requireAiCapability.js` | Plan-tier gate on every AI route — a Basic-VMS account gets 403 even via curl |
| `adminAuth.js` | Platform-operator only; keys off the `isPlatformAdmin` JWT claim, which self-registration can never set |
| `serviceAuth.js` | Service-to-service auth for `/api/internal/*` |
| `validate.js` | Joi validation middleware factory |
| `asyncHandler.js` | Wraps async handlers so errors reach the central error handler |
| `errorHandler.js` | Central JSON error handler (incl. Sequelize error mapping) |
| `rateLimiter.js` | Express rate limiting (general limiter + stricter auth limiter) |

### `src/utils/`

| File | Purpose |
|---|---|
| `fieldCrypto.js` | Transparent AES-256-GCM for sensitive DB columns (camera credentials) via Sequelize get/set |
| `streamToken.js` | Signed, short-lived, **per-camera** media-plane tokens so the anonymous HLS/WebRTC read path can be gated without a DB lookup per request |
| `aiTenant.js` | Per-organization identity for talking to smart-cam-ai — mints the per-org JWT the AI service scopes its Qdrant/Postgres reads on |
| `digestAuth.js` | Minimal HTTP Digest client (Hikvision ISAPI and Dahua CGI both default to Digest; axios has none) |
| `audit.js` | Append-only JSON-lines audit trail, kept separate from app logs so it can be shipped to a WORM store / SIEM |
| `constants.js` | RBAC tiers + the capabilities each role grants (route guards and UI check capabilities, not raw roles) |
| `cameraNaming.js` | Shared channel-naming heuristics used by onboarding + discovery |
| `semaphore.js` | In-process concurrency limiter — caps simultaneous FFmpeg processes |
| `AppError.js` | Error class carrying `statusCode` |

### `src/queues/` and `src/events/`

- `queues/index.js` — BullMQ queue + worker registry (durable, survives restarts, unlike `setInterval`).
- `queues/workers.js` — registers every worker + repeatable job; called once from `server.js`.
- `events/bus.js` — a single in-process `EventEmitter` (`bus`, `EVENTS`) for cross-service notifications that shouldn't become direct imports. `CAMERA_DELETED` is the important one.

---

## Operator console — `smart-cam-app/`

React + Vite + React Router + TanStack Query + Zustand + Tailwind/shadcn. `npm run dev`.

```
smart-cam-app/src/
├── App.jsx            the router — every route is React.lazy'd
├── main.jsx           entry
├── core/              the VMS proper: pages, players, services, store, layout, config
├── ai-analytics/      the AI analytics workspace (own scoped design system)
├── admin/             the platform-operator dashboard (mounted at /admin/*)
├── modules/           feature modules shared across verticals
├── use-cases/         vertical parameter packs (the product catalog)
└── pages/             one stray legacy page (AttendanceReport.jsx)
```

### `core/`

```
core/
├── pages/       Home, Dashboard, LiveView, MonitorWall, Playback, NvrPlayback, Timeline,
│                Timelapse, Gallery, Map, Cameras, CameraSetup, CameraGroups, CameraHealth,
│                Sites, AiDetectionSetup, Settings (+ settings/ManageUsersSection),
│                ComputeMonitor, ComputeCost, FeatureDemos, Pricing, Help,
│                Login, Register, ForgotPassword, ResetPassword
├── players/     the video stack (below)
├── services/    REST clients + the stream registry
├── store/       Zustand — authStore, notificationStore
├── layout/      Sidebar, Topbar, ProtectedRoute, ErrorBoundary, AIToastHost, NotificationBell
├── hooks/       useQueries, useStreamConnection, useAdaptivePlayback, useDigitalZoom,
│                useNetworkClass, useDashboardStats
├── components/  CameraCard, AISettingsPanel, StreamHealthPanel, TalkBackPanel,
│                BulkImportDialog, EnhanceFaceDialog
├── config/      endpoints.js — single source of truth for every service URL
├── context/     ThemeContext
├── ui/          shadcn primitives (button, card, dialog, select, table, tabs, …)
└── lib/         utils.js
```

**The three players** — `core/players/`:

| File | Purpose |
|---|---|
| `WebRTCPlayer.jsx` | **WHEP** (WebRTC) only, sub-500ms latency. The `RTCPeerConnection` is *not* owned here — it lives in `core/services/streamRegistry.js` so it survives page navigation (refcounted with a grace window) |
| `HLSPlayer.jsx` | HLS-only (hls.js + Safari native), ~2s latency — used for grids and mobile |
| `PlayerFrame.jsx` | The shared visual shell both players render inside: zoomable `<video>` stage (wheel/pinch zoom + drag-pan), badges, quality gear, overlays |
| `DirectStreamPlayer.jsx` | Thin picker that chooses WebRTC vs HLS |
| `WebRTCStream.jsx` | View-side player owning the `<video>` element + stall watchdog (negotiation still lives in `streamRegistry`) |
| `AIOverlay.jsx` | Live bounding boxes, subscribed to the **ephemeral** `ai.live` socket channel (one message per frame — deliberately not persisted) |
| `ZoomIndicator.jsx` | Small zoom-level overlay |
| `ShinobiEmbedPlayer.jsx` | **Legacy** — the old Shinobi embed player. Dead path |

**`core/services/`** — `api.js` (axios instance: attaches JWT, auto-refreshes on 401), `auth.js`, `cameraGroup.js`, `cameraHealth.js`, `site.js`, `recordings.js`, `ai.js`, `personTracker.js`, `license.js`, `manageUsers.js`, `payment.js`, `livekit.js`, `turnCredentials.js`, `socket.js` (one shared socket.io client), `streamRegistry.js` (one persistent WebRTC connection per monitorId, shared across every page that watches it), `streamCache.js` (HLS instance registry), and `shinobi.js` (**legacy shim** — kept only because a few stale imports remain).

**`core/config/endpoints.js`** is the rule: new pages import bases from here, never `import.meta.env` at the call site and never a hardcoded `localhost:<port>`. It exports `API_BASE` / `API_URL`, `AI_BASE` / `AI_WS`, `WHEP_BASE`, `PERSON_TRACKER_BASE`.

### `ai-analytics/`

A second, self-contained UI grafted into the same SPA, mounted under `/ai-analytics/*` in `App.jsx` via feature routers.

```
ai-analytics/
├── analytics.css                AUTO-GENERATED design system (~14k lines), every rule
│                                scoped under `.ai-analytics-scope`
├── ai-analytics-overrides.css   hand-written overrides on top
├── components/
│   ├── ANPRRouter.jsx + ANPR/            vehicle / plate analytics
│   ├── WeaponRouter.jsx + WeaponDetection/
│   ├── AggressionRouter.jsx + Aggression/
│   ├── FireDetectionRouter.jsx
│   ├── FaceWatchListRouter.jsx + FaceWatchlist/   search, watchlist mgmt, ReID, relationships
│   ├── CrowdMonitoring/, RestrictedZone/, Productivity/, Incidents/, Dashboard/, GIS/
│   ├── VMS/                     LiveMonitoring, Playback, Recordings, Evidence, CameraHealth
│   ├── System/, common/, layout/ (Layout, Sidebar, WorkspaceSidebar)
├── core/                        constants, useAlertStream hook, apiClient
├── providers/ + hooks/          ThemeProvider / useTheme
├── data/                        demo datasets + imagery for the analytics pages
└── utils/                       faceWatchlistStorage, relationshipEngine
```

**Design-system gotcha:** `analytics.css` opens with a full CSS reset scoped to `.ai-analytics-scope`. That reset wipes Tailwind utilities inside the scope, so styling for new analytics pages belongs in a scoped `<style>` block or the overrides file — not in Tailwind classes.

### `admin/`

The platform-operator dashboard, lazy-mounted at `/admin/*`: `AdminApp.jsx`, `AdminLogin.jsx`, `admin.css`, `services/api.js`, and `components/` — Dashboard, Customers, Camera, Licenses + LicenseDetail, PricingCatalog, PricingCalculator, Events, Auditlog, Tickets, Downloads, FaceWatchlist, MailSettings, and **LiveMonitor.jsx** (the live operations monitor, which carries its own self-contained WebRTC preview rather than reusing the operator player).

### `modules/` and `use-cases/`

`modules/` holds feature modules reused across verticals: `ai-feed/`, `alerts/` (Alerts + AlertRecipients), `face/` (Watchlist, PersonnelSearch, FaceLearning), `footfall/`, `headcount/`, `person-tracking/` (PersonTracker, LiveTracker, JourneyMap, CameraMapping), `reports/`, and the large `employee-productivity/` module with per-vertical page sets (`corporate`, `campus`, `school`, `hostel`, `hospitality`, `bank`) plus shared pages (ActivityBreakdown, PhoneUsage, ZoneCoverage, EventLog, RulesPolicies, Reports, EmployeeDetail).

`use-cases/index.js` is the **product catalog**: a use-case is a sellable vertical — a set of modules wired with vertical-specific parameters. Adding a vertical means dropping a folder (`bank/`, `campus/`, `corporate/`, `hospitality/`, `hostel/`, `retail/`, `school/`) and registering it; module code doesn't change.

### `App.jsx` — the router

Everything is `React.lazy` + `Suspense`. Route families:

- `/login`, `/register`, `/forgot-password`, `/reset-password` — public
- `/admin/*` — the admin SPA
- Core VMS (all behind `ProtectedRoute`): `/home`, `/dashboard`, `/live`, `/monitor-wall`, `/playback`, `/map`, `/camera-setup`, `/settings`, `/help`. Several old paths are now `Navigate` redirects into tabs (`/cameras` → `/camera-setup?tab=cameras`, `/gallery` and `/timeline` → `/playback?tab=…`, `/compute` → `/settings?tab=usage`)
- AI features: `/alerts`, `/watchlist`, `/face-learning`, `/ai-event/*` (personlsearch, cameramapping, journeymap, footfall, headcount), `/person-tracker`, `/live-tracker`, `/reports`
- `/activity-monitoring/*` — the productivity module, namespaced per vertical (`/campus/…`, `/school/…`, `/hostel/…`, `/hospitality/…`, `/bank/…`)
- `/ai-analytics/*` — the analytics workspace, wrapped in the `.ai-analytics-scope` container

---

## AI service — `smart-cam-ai/`

Python / FastAPI / ONNX Runtime + InsightFace / Postgres + Qdrant + Redis + MinIO.

```
smart-cam-ai/app/
├── face_detection/vms_face/             THE main service (detect → recognise → journey)
├── face_detection/insightface-master/   vendored InsightFace source
├── activity-monitor/                    phone-usage / productivity service (own package + container)
├── head-count/                          occupancy counting service (own package)
├── human_detection/                     body-detection experiment (backend/ + frontend/)
├── deepstream_api/                      DeepStream-backed variant (config, engine, main)
├── facerecounstruct/                    face restoration (CodeFormer) service
├── Customer-Footfall-Count-main/        footfall demo app
└── weapon_detection/                    placeholder — empty, no detector implemented
```

Note: the weapon and fire detectors referenced by the analytics UI do **not** exist as models yet; the pipeline is wired for them but nothing populates them.

### `face_detection/vms_face/` — the layered core

```
vms_face/
├── api/         HTTP surface
├── config/      settings
├── core/        cross-cutting primitives
├── domain/      models, schemas, enums, custom column types
├── infra/       everything that talks to the outside world
├── pipeline/    the per-camera processing loop
├── services/    the actual detection / recognition logic
├── journey/     person-journey reconstruction (absorbed the old person-tracker service)
├── workers/     out-of-process consumers
├── eval/        accuracy benchmarking harness
├── alembic/     DB migrations
└── tools/       probe_rtsp.py
```

**`api/`** — `main.py` builds the FastAPI app and includes every router; `deps.py` holds shared dependencies.
`api/routes/`: `tenants.py`, `persons.py`, `personnel.py`, `cameras.py`, `streams.py`, `events.py`, `search.py`, `learning.py`, `journey.py`, `ws.py`, `reid.py` (cross-camera ReID queries), `footfall.py`, `embed.py` (detect + embed one face, return the raw vector), and `legacy.py` — the compatibility router the console's `AiFeed.jsx` was originally built against, and the one that scopes requests to the caller's org tenant.

**`config/settings.py`** — the single pydantic settings object (thresholds, model paths, retention windows, service URLs).

**`core/`**

| File | Purpose |
|---|---|
| `security.py` | JWT auth primitives; a `Principal` is the authenticated identity behind a request |
| `crypto.py` | AES-256-GCM envelope for camera credentials at rest (used by `domain/types.EncryptedString`) |
| `executors.py` | Dedicated thread pools so blocking work can't starve the event loop |
| `metrics.py`, `system_metrics.py` | Prometheus counters/gauges + the background poller that fills them |
| `tracing.py` | OpenTelemetry plumbing |
| `logging.py`, `exceptions.py` | Structured logging; the `VMSError` hierarchy |

**`domain/`** — `models.py` (SQLAlchemy tables), `schemas.py` (pydantic wire shapes), `enums.py`, `types.py` (`EncryptedString`, transparent encrypt-on-write / decrypt-on-read column type).

**`infra/`**

| File | Purpose |
|---|---|
| `insightface_runtime.py` | Loads and owns the InsightFace / ONNX runtime session |
| `batched_scrfd.py` | Batched SCRFD face detection at the ONNX level |
| `batcher.py` | Async micro-batching primitive that feeds the batched detectors |
| `person_detector.py` | YOLOv8 person detector — SCRFD finds faces (great for recognition, poor for occupancy); this finds bodies |
| `genderage.py` | On-demand gender/age attribute head (run explicitly, not implicitly on every crop) |
| `aligner.py` | 5-point landmark face alignment |
| `recognizers/` | Embedding-model implementations |
| `postgres.py`, `qdrant.py`, `redis_bus.py`, `minio_store.py` | The four datastores: relational, vector, streams/pubsub, object |
| `detection_state.py` | Pub/sub of "what's visible right now" — the orchestrator produces, the API consumes |
| `detection_cache.py` | `LatestDetectionCache` |
| `alerts_subscriber.py` | Tails the Redis alerts stream inside the API process and patches person names into the cache |
| `backend_forwarder.py` | Live-overlay bridge → the backend's `/ai/overlay` (**ephemeral**, deliberately not persisted) |
| `alert_backend_forwarder.py` | Persisted-alert bridge: the `vms.alerts` stream → backend `/api/internal/ai/events` (deduped) |

**`pipeline/`** — `orchestrator.py` is the per-camera processing loop (the heart of the service); `ingest.py` handles RTSP decode; `run_stream.py` is a standalone single-camera dev runner; `deepstream_bridge.py` is the DeepStream variant's adapter.

**`services/`**

| File | Purpose |
|---|---|
| `face_matcher.py` | Gallery matching (Qdrant ANN + thresholding) |
| `face_tracker.py` | SORT-style tracker: Kalman prediction, Hungarian assignment, optional appearance term in the cost matrix |
| `face_quality.py` | Quality scoring so junk crops never reach enrollment or matching |
| `track_attributes.py` | Per-track gender/age voting (a single CCTV crop is unreliable; the track isn't) |
| `track_embedding_pool.py` | Keeps the best-N embeddings per track |
| `motion_gate.py` | ~0.2 ms CPU frame-difference check that skips the detect entirely on a static scene |
| `enrollment.py` | Enroll a person and their face vectors |
| `known_faces_bootstrap.py` | On startup, scan the on-disk `known_faces/` folder and enroll every image |
| `face_learning.py` | Incremental gallery improvement from confirmed matches |
| `reid.py` | Cross-camera ReID: given an appearance, find recent appearances on *other* cameras |
| `footfall.py` | Per-camera customer-footfall counting |
| `detection_zones.py` | Per-camera detection-zone geometry |
| `geometry.py` | Camera calibration + pinhole image↔ground-plane projection |
| `snapshot_cache.py` | Latest decoded frame per camera, served as JPEG (a guaranteed-visible live preview) |
| `snapshot_pump.py` | Bounded per-camera snapshot uploader (replaces unbounded fire-and-forget tasks) |
| `audit.py` | DPDP-compliant audit logging for every biometric operation |

**`journey/`** — person-journey reconstruction, which absorbed the former standalone `person-tracker` service (upload a face → find them across cameras → stitched MP4 + PDF). Files: `search.py` (Qdrant appearance search), `embed.py` (in-process query-face embedding), `body.py` (clothing colour + optional OSNet ReID), `fusion.py` (appearance drives the score; time and space are multiplicative), `cluster.py` (raw detections → sightings), `window.py` (`24h` / `7d` shorthand parsing), `recordings.py` ((monitor_id, timestamp) → recording file + seek offset), `video.py` (FFmpeg clip extract → overlay → concat), `stitch_jobs.py` (Redis job state + RQ enqueue), `persistence.py` (sync Postgres write from the RQ worker), `pdf.py` (ReportLab investigation report), `geo.py` (map.json for the Leaflet map), `events.py` (`journey.events` Kafka emission), `contracts.py`, `timefmt.py`.

**`workers/`** — separate processes, Redis-Streams / RQ consumers:

| Worker | Purpose |
|---|---|
| `match_worker.py` | Consumes `vms.detections`, runs Qdrant ANN against the enrolled gallery, writes the result and XADDs to `vms.alerts`. **If this container isn't running, recognition is silently dead** |
| `reid_worker.py` | Same stream, different consumer group — builds cross-camera ReID appearances |
| `stitch_worker.py` | RQ worker that renders a journey (clips → overlay → concat → MP4 + PDF) and persists it |
| `retention_worker.py` | DPDP Act 2023 compliance — prunes `detection_events`, vectors and snapshots on schedule |

**`eval/`** — an accuracy harness, not a test suite: `frvt.py`, `harness.py`, `manifest.py`, `metrics.py`, `report.py`, `video_pilot.py`. Use it when changing thresholds or swapping models.

### Other AI sub-apps

- `activity-monitor/src/activity_monitor/` — its own installable package and container: `manager.py`, `stream_worker.py`, `model.py`, `tracker.py`, `activity.py`, `crossing.py`, `counter.py`, `identity.py` (fusion with face identity), `ledger.py` + `store.py` (per-person time-in-state ledger, SQLite), `attendance.py`, `alert_policy.py`, `live_tracker.py`, `recognition_sync.py`, `api.py`, `web/`.
- `head-count/src/headcount/` — the same shape, smaller: `manager.py`, `stream_worker.py`, `model.py`, `counter.py`, `api.py`, `config.py`, `web/`.

---

## Mobile app — `drishyam_app/`

React Native + Expo. `CLAUDE.md` / `AGENTS.md` at its root are the canonical brief.

```
drishyam_app/
├── App.jsx, index.js, app.json
└── src/
    ├── navigation/AppNavigator.jsx   the whole nav tree
    ├── screens/
    │   ├── LoginScreen.jsx
    │   ├── HomeScreen.jsx
    │   ├── CamerasScreen.jsx
    │   ├── LiveWallScreen.jsx        multi-tile HLS grid (focus-gated streaming)
    │   ├── LiveViewScreen.jsx        single-camera WHEP
    │   ├── PlaybackScreen.jsx
    │   ├── AlertsScreen.jsx
    │   └── ProfileScreen.jsx
    ├── components/
    │   ├── LiveTile.jsx              one grid tile
    │   ├── CameraCard.jsx
    │   ├── AlertWatcher.jsx          subscribes to alerts
    │   ├── AlarmBanner.jsx
    │   ├── PushRegistrar.jsx         Expo push-token registration
    │   └── toast.jsx, ui.jsx, ErrorBoundary.jsx
    ├── lib/
    │   ├── client.js, api.js         HTTP client + endpoint wrappers
    │   ├── authStore.js              session state
    │   ├── alarmStore.js, alertFx.js alarm state + sound/haptics
    │   ├── push.js                   push registration + handlers
    │   └── settingsStore.js, storage.js, config.js
    └── theme.js
```

Rule that keeps this app working: **stream URLs are never constructed on the device** — they come from the backend's `/api/stream/start`.

---

## Supporting services

| Component | What it is |
|---|---|
| `stream-service/Dockerfile` | A thin brand layer over the upstream MediaMTX image. There is no source here — runtime config is bind-mounted from the root `stream-service.yml` to `/mediamtx.yml`, so tuning is a plain file edit + restart |
| `smart-cam-transcoder/app/` | Python sidecar: `main.py`, `transcoder.py`, `config.py` — H.265 → H.264 for browsers that can't decode HEVC |
| `smart-cam-sfu-bridge/app/` | Python bridge: `main.py`, `publisher.py`, `config.py` — publishes camera streams into the SFU (LiveKit) for fan-out |
| `edge-relay/` | PowerShell for on-prem edge deployments: `drishyam-edge-relay.ps1`, `install-relay-task.ps1`, `test-nvr.ps1`, plus site-specific go-live scripts |
| `observability/` | `prometheus/` scrape config and `grafana/dashboards/` (`drisyam-fleet.json`, `camera-streams.json`) + provisioning |
| `scripts/` | `backup-databases.sh`, `enable-stream-auth.sh` |
| `camera-name-discovery/` | Standalone reference implementation of NVR channel-name discovery (`full-source/`) |

---

## Legacy / deprecated — do not build on these

| Path | Status |
|---|---|
| `smart-cam-backend/src/services/shinobi.service.js` | Shinobi HTTP client. Shinobi is gone; kept only because `payment.service.js` and `shinobi.controller.js` still import it |
| `smart-cam-backend/src/routes/shinobi.routes.js`, `controllers/shinobi.controller.js` | **Legacy name, live code.** These endpoints still serve camera CRUD, but the controller drives `drishyamStreaming.service`. Don't add new endpoints here |
| `smart-cam-backend/src/services/streamService.shim.js` | Deprecated re-export — import `drishyamStreaming.service` instead |
| `smart-cam-app/src/core/players/ShinobiEmbedPlayer.jsx` | The old Shinobi embed player. Dead path |
| `smart-cam-app/src/core/services/shinobi.js` | Shim kept alive by a handful of stale imports; its URL builders return null for dead paths |
| `smart-cam-marketing/` | The original static marketing site. `brand-site/` is the current one |
| `backup/` | Archived one-off files, including the Shinobi-era scripts and an old SQL dump |
| `docs/08-shinobi-guide.md` | Describes the retired Shinobi deployment |

---

## Conventions worth knowing

- **The backend DB is the source of truth for the media plane.** The media server has no persistent config store, so `recordingSync`'s watchdog and `streamReconcile` continuously re-apply the DB's view. If something you set directly on the media server "reverts", that's why.
- **Never import a concrete streaming engine.** Go through `services/drishyamStreaming.service`; the engine behind it is chosen by `STREAMING_ENGINE`.
- **Never add a vendor `switch`.** That is exactly what `services/vendors/index.js` exists to prevent.
- **Detections are not alerts.** Alerting is debounced state transitions with K-of-N confirm, hysteresis, per-identity cooldown, and burst caps — read `docs/DETECTION_LOGGING_ALERTING_POLICY.md` before touching `alertEngine.js`.
- **Live overlay boxes are ephemeral.** They ride the `ai.live` socket channel and are deliberately not written to `ai_events`; only real alerts persist.
- **Frontend URLs come from `core/config/endpoints.js`**, never from `import.meta.env` at the call site.
