# About this snapshot

Built 2026-11-06 from the working Drishyam monorepo (branch `main` at
`debc259`, plus its uncommitted working tree — the code the local
`drisyam-original` stack was actually running) and the in-house model
training projects. Source folder → new folder map: [README.md](README.md).

## Verified before handover

| Check | Result |
|---|---|
| `docker compose config` — base, all profiles, scale overlay, observability overlay | valid; no duplicate host ports |
| MySQL migrations 001-037 + 3 seeders on an **empty** MySQL 8.4 | all apply; 33 tables, columns identical to the working DB |
| Backend boot in `NODE_ENV=production` on that fresh DB → `create-admin.js` → login → operator API | 200s; JWT carries `isPlatformAdmin`; wrong password 401 |
| Backend Jest | 230 pass, 3 fail — the same 3 fail on the untouched source (stale MediaMTX-engine tests + a temp doc-check test) |
| `ai/face-service` image built from the new Dockerfile | builds; ORT 1.26 with TensorRT + CUDA providers; code imports with nothing mounted |
| Face weights shipped in `models/insightface` | load on GPU; detection + 512-d embedding on a demo frame |
| vms_face unit tests (from this folder) | 43 / 43 pass |
| head-count / activity-monitor tests | 103/104 and 43/44 — the same single failure on the untouched source |
| Frontend `vite build` | succeeds |
| Secret sweep (patterns + every real value from the source `.env` files) | clean, except documented dev defaults (`drishyam123`, `minioadmin`) and test fixtures |

Not run here: the full stack on a second machine (this machine is running
production AI and the original stack on the same ports and GPU).

## Deliberately not included

| What | Why |
|---|---|
| `.env` files, LiveKit / S3 / payment / SMTP credentials | secrets; every service has a complete `.env.example` |
| Staff face photos (`known_faces`, `unknown_faces`, eval galleries — ~2.4 GB) | biometric personal data; enrol through the console or `data/known-faces/` |
| Databases' contents, recordings | data, not code; see [SETUP.md §8](SETUP.md) to migrate |
| TensorRT engine caches | GPU-specific; rebuilt automatically on first start |
| `insightface-master/`, `human_detection/` app, `deepstream_api/`, `Customer-Footfall-Count-main/` app, `weapon_detection/` (empty) | legacy / experimental, not in any running compose (the footfall clip, crowd clip and YOLOv8n are kept in `demo/` and `models/`) |
| Standalone `Bank/`, `Hospitality/`, `Hostel/` apps | already migrated into `frontend/src/modules/employee-productivity/` |
| One-off backend scripts with camera passwords / old NVR IPs; legacy Shinobi CLI scripts and their keys | credentials; superseded |
| `media-pipeline/`, `recordings-pipeline/`, trainee and POC bundles, zips | derived copies of the code above |
| Site-specific relay packages (POC client, Burjeel, NFC) | customer configuration; the generic relay is in `deploy/edge-relay/` |
| Old compose files (`docker-compose.yml` Jul-05, DeepStream, per-service) | merged into the new `docker-compose.yml` (running architecture + the audit's security hardening) |
| Brand / marketing site, sales material, pricing, proposals, design mock-ups, research PDFs | not needed to run the product |
| Credentials doc, Shinobi guide, old server deploy runbooks | secrets / legacy / tied to the old server |
| 4 unreferenced videos in `frontend/src`, a stray `public/CameraCard.jsx`, duplicate model files | unused / duplicates |

## Changes made to the code (small, all verified)

| File | Change |
|---|---|
| `backend/migrations/037-create-sync-only-tables.js` | **new** — creates `alert_emails`, `mail_config`, `password_resets`, `restricted_zones`, which previously existed only via dev-mode `sequelize.sync()`; no-op where present |
| `backend/scripts/create-admin.js` | credentials from `ADMIN_EMAIL` / `ADMIN_PASSWORD` instead of a hard-coded default; sets `is_platform_admin` (the `/admin` console needs it) |
| `backend/src/config/env.js` | `ACTIVITY_SERVICE_URL` default `http://activity-monitor:8000` (was a container name) |
| `ai/activity-monitor/src/.../live_tracker.py`, `recognition_sync.py` | Postgres DSN default host `postgres` (was a container name) |
| `frontend/src/core/services/auth.js` | DEV demo login now opt-in via `VITE_DEMO_EMAIL` / `VITE_DEMO_PASSWORD` (it held a real person's credentials and the stack runs the dev server) |
| `media/stream-service/Dockerfile` | MediaMTX pinned to `1.18.1` (was `latest`) |
| `media/stream-service/mediamtx.yml` | WebRTC host list from `HOST_IP` (was this office PC's LAN IP) |
| `ai/face-service/Dockerfile` | new build context (`vms_face/` only); same image contents and in-container paths |
| a code comment and one troubleshooting doc | real camera password / API keys replaced with placeholders |
| nested `.gitignore` files | stopped ignoring the model weights and demo videos this repo ships (they go through Git LFS) |

## Known gaps carried over from the source

* Production (`103.109.7.36`) had a few backend services that were never
  committed back (camera-offline alert service, relay backfill service, ~46
  differing files as of 2026-10-20). This snapshot is the local tree; merge
  those in if you need them.
* The relay's missed-footage backfill needs backend work that isn't built yet:
  [specs/RELAY_BACKFILL_BACKEND_SPEC.md](specs/RELAY_BACKFILL_BACKEND_SPEC.md).
* The e-mail-report endpoint the console's export dialog calls
  (`POST /api/notifications/reports/send`) doesn't exist; the UI falls back to
  download + mail draft.
* Some older per-service docs (`frontend/docs/*`, parts of `backend/docs/*`)
  link to file paths from before the frontend was restructured.
