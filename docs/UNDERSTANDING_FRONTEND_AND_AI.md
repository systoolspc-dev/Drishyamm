# Understanding Drisyam — Frontend, Backend & AI (A Beginner's Guide)

> **Who this is for:** You just joined the project and want to understand how the
> **frontend (the website operators use)**, the **backend (the main API + database)**,
> and the **AI features (the smart camera analytics)** work — without already knowing
> the codebase.
>
> Read this top to bottom once. Then keep it open as a map while you explore the code.

---

## 1. The 30-second mental model

Drisyam is a **VMS — a Video Management System**. Think of it like YouTube + a
security guard, for CCTV cameras.

- Hundreds/thousands of CCTV cameras stream video.
- A website (the **frontend**) lets operators watch live feeds, replay recordings,
  manage cameras, and see alerts.
- A **backend** is the brain in the middle: it holds the database (users, cameras,
  events), exposes the API the frontend calls, manages recordings, and coordinates
  the streaming + AI services.
- An **AI service** quietly watches those same feeds and raises its hand when it sees
  something interesting: *"that's a known person", "someone crossed this line",
  "a face I don't recognize"*, etc.

The product is split into several independent services, each in its own folder at the
project root. The three you'll care about most:

| Folder | What it is | Language |
|---|---|---|
| `smart-cam-app/` | **The frontend** — the React website operators use | JavaScript + React |
| `smart-cam-backend/` | **The backend** — the main API, database, recordings, coordination | JavaScript + Node/Express |
| `smart-cam-ai/` | **The AI service** — analyzes video, detects faces/people/etc. | Python + FastAPI |

Supporting services you'll see (context, not the focus here): `smart-cam-transcoder/`
and `smart-cam-sfu-bridge/` (video plumbing), plus `mediamtx.yml` (**MediaMTX**, the
streaming server that pulls RTSP from cameras and republishes it as web-friendly
HLS/WebRTC).

### How the pieces talk (the big picture)

```
   CCTV Cameras (RTSP)
          │
          ▼
   ┌──────────────┐  pulls video   ┌──────────────────┐
   │   MediaMTX   │ ──────────────▶ │  smart-cam-ai    │  reads frames,
   │ (stream hub) │                 │  (Python / AI)   │  runs models
   └──────┬───────┘                 └───────┬──────────┘
          │ HLS / WebRTC                     │ events & alerts
          │ (web video)                      │ (Redis / HTTP)
          │                                  ▼
          │                        ┌────────────────────────┐
          │                        │   smart-cam-backend    │  the hub:
          │                        │   (Node / Express)     │  DB, API, auth,
          │                        │   + MySQL + Redis + S3  │  recordings,
          │                        └───────────┬────────────┘  coordination
          │                                    │ REST + WebSocket
          ▼                                    ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                     smart-cam-app (React frontend)            │
   │   Live grid · Playback · Camera setup · AI Alerts · Footfall  │
   └──────────────────────────────────────────────────────────────┘
```

**Three key ideas to hold onto:**
1. **Video** reaches the browser as a stream (HLS or WebRTC), via MediaMTX — it does
   *not* flow through the backend.
2. **Everything else** (camera lists, recordings, login, AI events) flows through the
   **backend** as data — REST for requests, WebSocket for live push.
3. **AI results** (a face matched, a line crossed) are *data*, drawn *on top* of the
   video as boxes and labels.

---

# PART A — The Frontend (`smart-cam-app/`)

## 2. What it's built with

A modern Single-Page Application (SPA). The key libraries, and *why each exists*:

| Library | Job in plain words |
|---|---|
| **React 19** | The UI framework — builds the screens out of components |
| **Vite** | The dev server + bundler — `npm run dev` to run it locally |
| **React Router** | Decides which page to show based on the URL (`/live`, `/alerts`, …) |
| **Zustand** | Tiny global store — mainly holds "who is logged in" |
| **React Query** | Fetches + caches data from the backend so the UI feels fast |
| **Axios** | The HTTP client that calls the backend, auto-attaches the login token |
| **Socket.IO** | The live "phone line" for real-time events (AI alerts, camera status) |
| **HLS.js** | Plays video in the grid (HTTP Live Streaming) |
| **WebRTC (MediaMTX WHEP)** | Plays video with *ultra-low latency* for single-camera view |
| **Tailwind CSS + shadcn/Radix** | Styling + pre-built UI components (buttons, dialogs) |
| **Leaflet** | Maps — camera pins and incident locations |
| **Recharts** | Charts on dashboards / analytics |

> It's **JavaScript (`.jsx`), not TypeScript.** Don't go looking for `.ts` files.

## 3. How to find your way around `smart-cam-app/src`

```
src/
├── main.jsx        ← App starts here (sets up React, Router, providers)
├── App.jsx         ← The list of every page + URL (the "site map")
│
├── pages/          ← One file = one full screen (Login, LiveView, Alerts, …)
├── components/     ← Reusable pieces (video player, sidebar, dialogs)
│   └── ui/         ← Generic buttons/inputs/cards (the design system)
│
├── services/       ← All the "talk to the server" code lives here
│   ├── api.js      ← The Axios setup (login token, auto-refresh on 401)
│   ├── socket.js   ← The WebSocket connection (live events)
│   └── ai.js       ← Calls for AI data (events, snapshots, footfall)
│
├── hooks/          ← Reusable logic (e.g. useQueries.js fetches cameras)
├── store/          ← Zustand global state (authStore.js = logged-in user)
├── config/         ← endpoints.js = the backend/AI URLs (from env vars)
├── ai-analytics/   ← A self-contained "AI dashboards" sub-app (see §6)
└── admin/          ← A separate admin portal with its own login
```

**The reading order for your first day:**
1. `src/main.jsx` — see how the app boots.
2. `src/App.jsx` — see every page and its URL.
3. Open one simple page, e.g. `src/pages/Home.jsx`, to learn the pattern.
4. `src/services/api.js` — see how the app calls the backend and handles login.
5. `src/components/DirectStreamPlayer.jsx` — see how a camera actually plays video.

## 4. The main screens (pages)

(Full per-page detail already exists in
[`smart-cam-app/docs/FEATURES.md`](smart-cam-app/docs/FEATURES.md) — this is the
condensed tour.)

**Watching cameras**
- **Live View** (`/live`) — the camera grid (1×1, 2×2, 2×3). The core screen.
- **Monitor Wall** (`/monitor-wall`) — full-screen wall display, no menus, auto-rotate.
- **Map** (`/map`) — cameras as pins on a Leaflet map.
- **Dashboard** (`/dashboard`) — overview tiles: cameras online, people count, recent activity.

**Recordings**
- **Playback** (`/playback`) — pick a camera + date, replay the recorded clip.

**Managing the system**
- **Camera Setup** (`/camera-setup`) — add/edit cameras, sites, groups.
- **Camera Health** (`/health`) — per-camera uptime, bitrate, fps.
- **Settings** (`/settings`) — org settings, recording retention, storage.

**The AI screens** (where the AI features surface)
- **AI Feed** (`/ai-feed`) — pick a camera, watch detection boxes + names appear live.
- **AI Alerts** (`/alerts`) — a list of detection events with snapshots + an "Enhance face" button.
- **Watchlist** (`/watchlist`) — upload faces the system should recognize/flag.
- **Face Learning** (`/face-learning`) — a queue of unknown faces; approve to teach the system.
- **Footfall** (`/footfall`) — people-counting dashboard (line-crossing counts + trends).
- **Personnel Search** / **Journey Map** — find a person, draw their path across cameras.
- **AI Analytics hub** (`/ai-analytics/*`) — the richer dashboards module (see §6).

**Auth:** `/login`, `/register`, `/forgot-password`, `/reset-password`. Everything else
is wrapped in `ProtectedRoute`, which bounces you to `/login` if not signed in.

## 5. How the frontend talks to the servers

Three channels — keep them straight:

1. **REST (HTTP request/response)** — "give me the camera list", "save this camera".
   - All wired through `src/services/api.js` (Axios). Target = the **backend**.
   - Every request automatically carries your **JWT login token**.
   - If the token expires (a `401`), Axios silently refreshes it and retries — you
     don't get logged out mid-action. This logic is the most important part of `api.js`.

2. **WebSocket (live push)** — the server pushes events the instant they happen.
   - Wired through `src/services/socket.js`. The **backend** is on the other end.
   - Used for: `ai.event` (a detection → show a toast + draw a box),
     `camera.status` (a camera went online/offline).

3. **Video streams** — actual video, *not* via the backend.
   - **HLS** (HLS.js) for the grid; **WebRTC** (MediaMTX WHEP) for single-camera view.
   - Handled inside `DirectStreamPlayer.jsx`. It tries WebRTC first, falls back to HLS.

> **Mental shortcut:** *Pictures* come straight from MediaMTX over HLS/WebRTC.
> *Everything else* goes through the backend.

## 6. The `ai-analytics/` sub-folder (don't let it confuse you)

`src/ai-analytics/` is almost a **mini-app inside the app** — a richer set of AI
dashboards (Weapon, Aggression, Fire, Vehicle/ANPR, Face Watchlist, Crowd, Restricted
Zone). It has its own components, hooks, services, and **scoped CSS** so its styling
can't leak into the rest of the app. Reached at `/ai-analytics/*`. Treat it as a
separate module.

---

# PART B — The Backend (`smart-cam-backend/`)

## 7. What the backend is

The **central hub** of the whole system — a **Node.js + Express** API server. Almost
everything that isn't raw video passes through it. Its jobs:

- **Owns the database** (MySQL) — users, cameras, sites, recordings, AI events, billing.
- **Serves the REST API** the frontend calls (`/api/...`).
- **Pushes live updates** to the frontend over Socket.IO (WebSocket).
- **Manages recordings** — syncs MediaMTX's recorded files up to S3, enforces retention.
- **Coordinates MediaMTX** — tells it which cameras exist and keeps it in sync.
- **Coordinates the AI service** — receives AI events and forwards them to the frontend;
  tells AI which cameras to watch.
- **Handles auth + billing** — JWT login, Stripe/Razorpay payments.

### The stack

| Library | Job in plain words |
|---|---|
| **Express 5** | The web framework (routes, middleware) |
| **Sequelize (MySQL)** | The ORM — talks to the database with JS objects instead of raw SQL |
| **jsonwebtoken + bcryptjs** | Login tokens (JWT) + password hashing |
| **Socket.IO** | Pushes live events to the frontend |
| **BullMQ + ioredis** | Background job queues on Redis (recordings sync, transcode, alerts) |
| **AWS S3 SDK** | Uploads recordings + snapshots to S3/MinIO, makes signed URLs |
| **fluent-ffmpeg** | Transcoding (full-res → low-res sub-stream) and snapshots |
| **Stripe / Razorpay** | Payments |
| **Joi** | Validates incoming request bodies before they hit your code |
| **Winston / prom-client** | Logging / Prometheus metrics |

> Like the frontend, it's **plain JavaScript, not TypeScript.**

## 8. How to find your way around `smart-cam-backend/src`

The backend follows a classic layered pattern: **Route → Controller → Service → Model**.

```
src/
├── server.js       ← Boot: connect DB, start HTTP + Socket.IO, launch workers
├── app.js          ← The Express app: middleware stack + mounts routes at /api
│
├── routes/         ← URL definitions. "What path maps to what handler"
├── controllers/    ← Request handlers. Read input, call a service, return JSON
├── services/       ← The real business logic (the important folder — see below)
├── models/         ← Sequelize DB tables (User, Camera, Site, AIEvent, …)
├── middleware/     ← Cross-cutting: authenticate.js, authorize.js, validate.js, errors
├── validations/    ← Joi schemas (one per domain) checked before controllers run
├── queues/         ← BullMQ background workers (index.js + workers.js)
├── events/         ← bus.js, an in-process event emitter
├── config/         ← env.js (validated env vars), database.js, redis.js, logger.js
└── utils/          ← Helpers (AppError, role constants)
```

**The mental model of a request:**
```
Browser → routes/ (which URL?) → middleware/ (logged in? valid body?)
        → controllers/ (orchestrate) → services/ (do the work, hit DB / MediaMTX / S3)
        → models/ (the DB) → back up as JSON
```

**The `services/` folder is where the system's real intelligence lives.** The ones
worth knowing early:
- `mediamtx.service.js` — the REST client that tells MediaMTX about camera paths.
- `recordingSync.service.js` — the loop that uploads finished recordings to S3 (every
  5 min) and a watchdog (every 2 min) that reconciles the camera list with MediaMTX.
- `streamSupervisor.service.js` — watches each camera's health (online/offline/degraded/
  quarantined) by polling MediaMTX.
- `ws.service.js` — sets up Socket.IO and fans events out to the right user.
- `s3.service.js` — uploads + signed download URLs for recordings/snapshots.
- `aiLifecycle.service.js` — tells the AI service which cameras to run inference on.

## 9. The main API areas (route groups)

All mounted under `/api` (see `src/routes/index.js`):

| Path | File | What it does |
|---|---|---|
| `/api/auth` | `auth.routes.js` | Register, login, refresh token, forgot/reset password |
| `/api/user` | `user.routes.js` | Get/update the logged-in user's profile + settings |
| `/api/shinobi/cameras` | `shinobi.routes.js` | **Camera CRUD** (the name "shinobi" is legacy — it manages cameras in the DB + syncs them to MediaMTX) |
| `/api/groups` | `cameraGroup.routes.js` | Camera groups (1 NVR = 1 group of channels) |
| `/api/sites` | `site.routes.js` | Sites (the location hierarchy) |
| `/api/stream` | `stream.routes.js` | Start/stop a stream, status, the adaptive HLS playlist |
| `/api/ai/*` | `ai.routes.js` | AI events (list/ack/snapshot), watchlist upload, footfall, AI settings |
| `/api/person-tracker/*` | `personTracker.routes.js` | Reverse-proxy to the AI service (search-by-photo, journey export) |
| `/api/cameras` | `cameraHealth.routes.js` | Per-camera health / liveness |
| `/api/payment`, `/api/subscription` | `payment.routes.js`, `subscription.routes.js` | Stripe/Razorpay billing |
| `/api/health`, `/api/metrics`, `/api/system` | … | Liveness/readiness, Prometheus metrics, disk/CPU info |
| `/api/internal/*` | `internal.routes.js` | **Service-to-service** — the AI worker posts events here; protected by a service token, not a user JWT |

> **Note:** the frontend's "AI" calls split two ways. Some hit the **backend** at
> `/api/ai/*` (which stores/serves events from MySQL + S3). A few hit the **AI service
> directly** for speed (e.g. personnel search). The `endpoints.js` config in the
> frontend decides which.

## 10. The data model (the database)

Sequelize models live in `src/models/`. The hierarchy that matters most:

```
User ─┬─ owns ─▶ Site ──▶ CameraGroup ──▶ Camera ──▶ AIEvent
      ├─ owns ─▶ Subscription ──▶ Plan
      └─ owns ─▶ Payment
```

- **User** — login identity + role (ADMIN / USER). Multi-tenant: every camera/event
  belongs to a user, and Socket.IO fans events only to that user's "room".
- **Site** — a physical location (timezone, address, geo). Top of the location tree.
- **CameraGroup** — one NVR device and its channels.
- **Camera** — one stream. Key fields to know:
  - `monitorId` — a unique id; the MediaMTX path is literally `cam_{monitorId}`.
  - `supervisorState` — health: pending / connecting / streaming / degraded / offline / quarantined.
  - `retentionDays` — how long to keep recordings; **inherits** Camera → Group → Site → default 30d.
  - `streamQuality` — playback default: `main` / `sub` / `auto`.
- **AIEvent** — one row per AI detection (bbox, trackId, the S3 `snapshotKey`,
  acknowledged flag). The snapshot *image* lives in S3, not the DB.
- **Subscription / Plan / Payment** — billing.

**Schema lives in migrations, not in code-sync:** `smart-cam-backend/migrations/`
(run with `npm run db:migrate`) creates the tables; `seeders/` loads starter data like
the Free plan. In production the tables come from migrations, not `sequelize.sync()`.

## 11. How the backend connects everything + background jobs

**Outbound connections:**
- **MediaMTX** — REST calls (`mediamtx.service.js`) to add/update/delete a camera's
  path. MediaMTX has no database of its own, so **the backend is the source of truth**
  and a watchdog re-pushes the config if MediaMTX restarts.
- **AI service** — receives events at `/api/internal/ai/events`, and exposes a camera
  registry the AI worker reads to know what to watch. `aiLifecycle.service.js` decides
  which cameras get continuous inference (to save GPU).
- **S3 / MinIO** — recordings and AI snapshots; browser gets time-limited signed URLs.
- **Redis** — backs the job queues and a cross-process event bus (`streamBus`).
- **Stripe / Razorpay / SMTP** — payments and emails.

**Background jobs (BullMQ on Redis; falls back to plain timers if Redis is down):**
- **S3 sync** (every 5 min) — upload finished MediaMTX recordings to S3, delete local copy.
- **Watchdog** (every 2 min) — reconcile DB cameras ↔ MediaMTX paths, update online/offline
  status, clean up orphaned paths.
- **Transcode** — on demand, make a low-res sub-stream with FFmpeg.
- **Alert dispatch / snapshot / AI-event ingest** — post-processing queues.

**Always-on background services** (not queued, started in `server.js`):
- `streamSupervisor` — polls camera health and flips `supervisorState`, quarantining
  cameras that flap too much.
- `mediamtxReconcile` — re-converges MediaMTX config on boot / when retention changes.
- `recordingRetention` — ages off old recordings per the retention policy.

## 12. The auth flow (how login works)

JWT-based and stateless:

1. **Login** (`POST /api/auth/login`) → backend checks the bcrypt password, returns an
   **access token** (short-lived, ~15 min) + a **refresh token** (longer-lived, stored
   in the DB so it can be revoked).
2. **Every protected request** carries the access token. `middleware/authenticate.js`
   verifies it and attaches `req.user = { id, email, role }`.
3. **When the access token expires**, the frontend silently calls
   `POST /api/auth/refresh-token` to get a new one (this is the auto-retry you saw in
   the frontend's `api.js`).
4. **Roles**: `middleware/authorize.js` gates ADMIN-only routes.
5. **WebSocket** auth: the token is passed in the Socket.IO handshake; the socket joins
   a `user:{id}` room so each tenant only receives their own events.
6. **Service-to-service** (AI worker → backend): not a user JWT but an
   `X-Service-Token` checked by `middleware/serviceAuth.js`.

---

# PART C — The AI Features (`smart-cam-ai/`)

## 13. What the AI service is

A **Python** service built with **FastAPI**. Two jobs at once:

1. **Watches every camera** — pulls the video, runs AI models on the frames.
2. **Serves an API** — so events/counts/journeys can be queried.

It runs as **two processes**:
- The **API + pipeline** process (port `8001`) — reads cameras, runs detection.
- A **match worker** (background daemon) — does the heavy face-matching against the
  database, decoupled so detection never stalls.

### Core AI building blocks (the models)

| Purpose | Model | What it does |
|---|---|---|
| **Find faces** in a frame | **SCRFD** (`det_10g.onnx`) | Returns face boxes + landmarks |
| **Identify a face** | **ArcFace** (`w600k_r50.onnx`) | Turns a face into a 512-number "fingerprint" (embedding) |
| **Count people** (optional) | **YOLOv8** (`yolov8n.onnx`) | Finds people even when faces aren't visible |
| **Fix blurry faces** (optional) | **CodeFormer + Real-ESRGAN** | Sharpens a grainy CCTV face for review |

> **The key trick:** a face is matched by **comparing fingerprints, not pixels.**
> ArcFace turns each face into 512 numbers. To recognize someone, you find the
> *closest* fingerprint among enrolled people. That nearest-neighbor search runs in a
> **vector database called Qdrant** — fast even with 100k+ faces.

## 14. The AI features, one by one

Paths are under `smart-cam-ai/app/face_detection/vms_face/`:

1. **Face Recognition** *(the core)* — detect faces, track them across frames, match
   against enrolled people, emit an event.
   `pipeline/orchestrator.py` (the heart), `services/face_matcher.py`, `workers/match_worker.py`.
2. **Watchlist & Alerts** — enrolled people can be tagged VIP or Blacklist; a match
   fires a louder **ALERT**. Surfaces on the frontend's **AI Alerts** page.
   `workers/match_worker.py`.
3. **Face Learning (unknown-face queue)** — a *clear* face that matches nobody is
   parked for an operator to approve (→ enrolled) or reject. This is how it "learns"
   new people. `services/face_learning.py`. Frontend: **Face Learning**.
4. **Footfall (people counting)** — counts people crossing a configurable line (IN/OUT),
   stored per minute. `services/footfall.py`. Frontend: **Footfall**.
5. **People count** — optional YOLOv8 "how many people right now" for the dashboard
   badge. `infra/person_detector.py`.
6. **Personnel Search** — search enrolled people, see last sighting. `api/routes/personnel.py`.
7. **Journey Map** — list one person's "stops" across cameras so the UI can draw a path.
   `api/routes/journey.py`.
8. **Cross-camera ReID** — links the same person across cameras using body-appearance
   fingerprints (works even when the face isn't visible). `workers/reid_worker.py`.
9. **Face reconstruction / enhancement** — a separate service (port `8002`) that
   sharpens blurry faces on demand. Powers the **"Enhance face"** button. `app/facerecounstruct/`.

> **Weapon / fire / aggression / ANPR:** the frontend has full *dashboards* for these
> under `ai-analytics/`, and there are demo videos at the project root. In the AI
> service, **face / people / footfall are the fully-wired pipelines today**; the weapon
> folder is a stub. Treat those extra dashboards as "UI ready, model wiring varies" —
> verify before assuming a live model.

## 15. How a detection flows end-to-end (the money diagram)

The single most useful thing to understand. Follow one face through the system:

```
1. Camera (RTSP) ──▶ MediaMTX
                        │
2. AI pipeline reads a frame  (pipeline/ingest.py)
                        │
3. SCRFD finds the face       (det_10g.onnx)
                        │
4. Tracker gives it a stable ID across frames
                        │
5. Quality check (too blurry / too small / bad angle? → skip)
                        │
6. ArcFace turns the face into a 512-number fingerprint  (w600k_r50.onnx)
                        │
7. Fingerprint pushed onto a Redis queue ("vms.detections")
                        │
        ┌───────────────┴────────────────┐
        ▼                                 ▼
8. Match Worker picks it up         (live overlay cache updated
   - searches Qdrant for the         so the AI Feed shows a box
     closest enrolled person          immediately)
   - decides: MATCH / ALERT / UNKNOWN
   - saves a DetectionEvent (DB)
   - saves the snapshot in S3/MinIO
   - publishes the result to Redis ("vms.alerts")
        │
9. smart-cam-backend receives the event ──▶ Socket.IO ──▶ Frontend
                        │
10. Frontend shows a toast + adds it to the AI Alerts list,
    and paints the name onto the live box.
```

**Where things are stored:**
- **MySQL / PostgreSQL** — the events, people, enrollments, footfall counts ("records").
  *(The AI service uses its own Postgres; the backend uses MySQL — each owns its data.)*
- **Qdrant** — the face fingerprints (the "search index").
- **S3 / MinIO** — the snapshot images (the "photos"), served to the UI via signed URLs.
- **Redis** — the live message bus connecting pipeline ↔ match worker ↔ backend.

## 16. The knobs that change AI behavior

When the AI "isn't recognizing people" or raises "too many false alarms", these
settings in `smart-cam-ai/.../config/settings.py` are what you tune:

| Setting | Default | Effect |
|---|---|---|
| `INSIGHTFACE_REC_THRESHOLD` | 0.45 | Match strictness. ↑ = fewer false matches, more misses. |
| `INSIGHTFACE_DET_THRESHOLD` | 0.7 | How confident before it calls something a face. |
| `MATCH_MIN_FACE_PX` | 40 | Ignore faces smaller than this many pixels. |
| `MATCH_MIN_QUALITY` | 0.45 | Reject blurry / badly-angled faces before matching. |
| `TRACK_MIN_HITS_TO_MATCH` | 4 | Frames it must see a face before matching (cuts noise). |
| `AI_INFERENCE_FPS` | 8 | Frames/sec analyzed per camera (lower = less GPU). |
| `PIPELINE_PERSON_DETECTION_ENABLED` | false | Turn YOLOv8 people-counting on/off. |

> **Rule of thumb:** *Missing people you expect to recognize?* lower the recognition
> threshold. *Strangers matching as known people?* raise it.

---

## 17. Where to go next

- **Frontend deep dive (per page):** [`smart-cam-app/docs/FEATURES.md`](smart-cam-app/docs/FEATURES.md)
- **AI deep dive:** `smart-cam-ai/docs/ARCHITECTURE.md`, `FEATURES.md`, and especially
  `smart-cam-ai/docs/ONBOARDING.md`.
- **Backend:** `smart-cam-backend/docs/` plus `src/server.js` and `src/app.js`.
- **Running everything:** `RUNNING.md` and `docker-compose.yml` at the project root.

### A suggested first-week path
1. Run the frontend locally (`cd smart-cam-app && npm install && npm run dev`).
2. Click through every page in §4 to connect names to screens.
3. Trace **one read**: Live View → `useGroups()` (frontend) → `GET /api/groups`
   (backend route → controller → Camera model) → back to the grid.
4. Trace **one AI event** using the diagram in §15, reading `orchestrator.py` then
   `match_worker.py`, then how the backend forwards it over Socket.IO (`ws.service.js`).
5. Only then dive into the richer `ai-analytics/` dashboards.

---
*This is an onboarding map, not a spec. Code changes faster than docs — when a path or
setting here doesn't match what you see, trust the code and update this file.*
