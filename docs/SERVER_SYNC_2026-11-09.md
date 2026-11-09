# Server → local sync, 2026-11-09

Production (`/data/source/backend` @ `94ddf43`, frontend built from
`/data/build/app-20261104`) had months of fixes applied directly on the server
that never reached this repo; this repo (the 2026-11-06 snapshot) had fixes the
server lacked. This branch merges both. How it was decided, per file, is below.

**Method.** The running containers were taken as the truth for what production
runs (the backend container matched its git HEAD exactly). Every differing file
was compared against every older server copy (backend git history,
`backend-20261020{,b}`, `backend-patch-*`, frontend `app-2026MMDD` builds) to
tell which side changed which region; then a hunk-by-hunk review kept the
server's newer code plus every genuine local addition.

**Brought in from the server.** Live relay (low-latency live view, audio),
edge relay + recording backfill, faststart MP4 clips, fast NVR/relay playback,
per-NVR open pacing, main stream held 30 s not 5 min, on-demand main channel,
per-account recording (`RECORD_USER_IDS`), recordings listed from disk + S3,
resumable cloud playback, camera-down e-mails; Gallery/CloudPlayback/LiveView/
Dashboard/MonitorWall improvements. Production build + deploy files:
`frontend/Dockerfile.prod`, `frontend/nginx.prod.conf`, `backend/deploy.sh`,
`deploy/production/` (secrets replaced by `${VAR}`). Recording/backfill/relay
tuning keys documented in `backend/.env.example`.

**Kept from local.** Migrations 036/037, AI clock-skew handling, all local-only
tests, the snapshot's security fixes (no hard-coded demo login — production's
`auth.js` still contains one —, admin credentials from env, no credentials in
docs), PersonTracker live session, footfall-service-down messages in zone setup.

**Left out on purpose.** ~30 one-off backend scripts (`scripts/fix-*`,
`push-config.js`, `legacy-shinobi/`, `dev-probes/`, `src/scripts/`, `sql/`) —
most embed camera credentials or customer IPs and nothing references them; the
root-level `Bank/ Hospitality/ Hostel/` apps (already in
`src/modules/employee-productivity/`). AI services were not synced *from* the
server: its AI images date from July and this repo's AI code is newer.

**Also fixed.** `MEDIAMTX_API_URL` unset in compose → the stream supervisor
polled `localhost:9997` (pre-existing, production too). `transcoderLifecycle`
test isolated from the server's new encoder probe and NVR pacing.

**Verified.** Backend Jest 230 pass / 3 fail (the same 3 stale tests as before
the merge); frontend 107/107 tests, `vite build` OK; backend boots healthy.

---
# Backend merge decisions (server 94ddf43 vs local snapshot 2026-11-06)

Output files are in `merged/backend/<path>`. All use LF line endings, have no conflict markers, and pass `node --check` (60 .js files). `scripts/smoke.sh` passes `bash -n`.

## Resolved files

| File | Decision | What came from each side |
|---|---|---|
| src/controllers/cameraGroup.controller.js | server | Server only: recordings listed from BOTH stores via `cameraRecordingsMerged` (fixes the timeline showing only the last few minutes), thumbnail retry with ffmpeg `-rw_timeout`, `streamS3Resumable` (resumes after 10PB S3 resets), cloud clip export `exportRecordingRange`. Local lines are the older local-first code. |
| src/services/stream.service.js | server | Server only: `MAIN_OPEN_BUDGET_MS` on-demand main open (with `streamWarm.yieldForMain`), `userId` passed for RECORD_USER_IDS, `ensureMainCloseAfter`, `ensureLivePath`, `liveNvrUrl`, `mainOpen` diagnostics. Local adds nothing. |
| src/services/recordingSync.service.js | server | Server only: `RECORDING_STITCH_MAX_BATCH_SEC` env, `RECORDING_KEEP_LOCAL` archive (`retireLocalClip`), faststart MP4 rewrite before upload (`isFragmented` / `makeFaststart`), `userId` in the watchdog camConfig. |
| src/services/streaming/StreamServiceEngine.js | server | Server only: per-account recording `RECORD_USER_IDS`, `MAIN_SOURCE_CLOSE_AFTER=30s`, `ensureMainCloseAfter()`, richer log line. |
| src/services/storage.service.js | server | Server only: per-account cloud usage `cloudUsage()` (10 PB tier, cached). |
| src/controllers/system.controller.js | server | Server only: returns `cloud` usage scoped to `req.user`. Goes with storage.service. |
| src/routes/cameraGroup.routes.js | server | Server only: `GET /:groupId/recordings/export` route. Goes with the controller. |
| src/services/vendors/index.js | server | Server hot-patch 2026-09-30: Hik/Dahua playback timestamps sent as IST device-local time (they had been landing about 5.5 h off). Local still has the UTC version. |
| src/server.js | server | Server only: `liveRelay.attach(server)` (WebSocket at /api/stream/live), `recordingBackfill.start/stop`, `sequelize.sync()` disabled (2026-10-12; a 64-key crash-loop). Local's dev-only `sync()` is dropped on purpose: local migration 037 now creates the tables that only `sync()` used to create. |
| src/services/streamSupervisor.service.js | server | Server only: `cameraOfflineAlert` camera-down and recovery e-mails, plus the `name` attribute. |
| scripts/create-admin.js | local | Snapshot-notes fix: reads ADMIN_EMAIL / ADMIN_PASSWORD (no hard-coded credentials) and sets is_platform_admin. |
| src/config/env.js | local | Snapshot-notes fix: ACTIVITY_SERVICE_URL defaults to `http://activity-monitor:8000`. Otherwise identical. |
| src/services/aiLifecycle.service.js | local (= server + addition) | Server body unchanged. Local adds the `recordAiClock` wiring for aiClockSkew. |
| src/utils/aiTenant.js | local (= server + addition) | Local adds the AI JWT `iat` backdated by 120 s (clock-skew fix). |
| src/services/shinobi.service.js | local | Comment only: a real password in the comment is replaced with a placeholder. |
| test/cameraQuota.test.js | local | Local test matches the current cameraQuota/entitlements code, which is identical on both sides: it always counts, and covers per-account licence, licence 0, and sub-user spends the owner's licence. The server's test asserts `count` is never called, which no longer holds for that code. |
| docs/ONBOARDING.md, docs/FEATURES.md, docs/CLOUDFLARE_TUNNEL.md | local | Credentials removed; they point to ADMIN_EMAIL / ADMIN_PASSWORD. |
| scripts/smoke.sh, scripts/smoke-retention.js | local | Container name `drishyam-backend`, which matches the local docker-compose `container_name`. The server uses `drisyam-original-backend` (prod naming; SMOKE_CONTAINER overrides it). |
| .env.example | combined | Kept local's structure and values. Added the 13 requested production tuning keys as active lines with the server's values (RECORD_USER_IDS and BACKFILL_EDGE_SINCE left empty). Added about 150 other keys the code reads, all commented out, with the code default and a short note. No secret values. |

## Auto-merged files (checked)

| File | Result |
|---|---|
| .gitignore | OK. Server's version, which adds `.last-deployed-image` for deploy.sh. |
| package.json | OK. Server's version. The only difference from local is the added dependency `ws ~8.21.0`, which liveRelay needs. |
| package-lock.json | OK. Same as the server's lock. Its root deps match package.json exactly and `node_modules/ws` is 8.21.0. Local has no deps the server lacks. |
| src/controllers/playback.controller.js | OK. Same as server: edge/site-relay replays, NVR replay over the live relay, H.264 copy path. Local lines are only older code. |
| src/controllers/stream.controller.js | OK. Same as server: `liveTicket`, `warmStreams`, `mainOpen`. Local adds nothing. |
| src/routes/index.js | OK. Same as server (`/edge` routes). |
| src/routes/stream.routes.js | OK. Same as server (`/live/:monitorId/ticket`, `/warm`). |

## Unsure or flagged

- **server.js sync():** dropping local's dev-mode `sequelize.sync()` assumes migration 037 (plus the earlier migrations) fully covers the schema on a fresh dev DB. Run `db:migrate` on an empty DB to confirm.
- **smoke scripts:** they use the local container name. Production runs would need `SMOKE_CONTAINER=drisyam-original-backend`.
- **.env.example values:** the active production values will change local dev behaviour if the file is copied as-is:
  - 1-minute segments
  - stitching at 200 s
  - RELAY_AUDIO=0
  - EDGE_MAX_JOBS_PER_SITE=13

  That is intended, per the brief. Empty RECORD_USER_IDS and BACKFILL_EDGE_SINCE are fine because env.js does not validate those two keys.
- **HOSTNAME:** not documented. It is set by the container runtime.
- **Tests not run:** jest was not run because the local backend has no node_modules. Only syntax checks were done.

---

# Frontend merge decisions (LOCAL 2026-11-06 vs SERVER frontend-app-20261104)

Method: for each region where the two sides differ, check which dated server build (0929, smart-cam-app-live 10-17, 1020 to 1030c, 1104) the local text matches. Local text that matches an older build and was changed later on the server counts as old code, so the server wins. Local text that no server build ever had counts as a local addition and is kept. All output uses LF line endings.

## Files with conflicts (18)

| File | Decision | Notes |
|---|---|---|
| src/core/pages/Gallery.jsx | server | Every local hunk is 0929 code: 3-minute window grouping, HH:MM time parsing, size-based duration. Server adds per-clip cards, the exact `_to_` clip duration, 12h HH:MM:SS from filename (IST wall clock). |
| src/core/pages/DashboardQuickActions.jsx | server | Local uses hard-coded slate colours and has no entitlement gating, which is older. Server adds theme tokens (dark mode), `feature`/`featureAny` gating and the new plain-language labels. |
| src/core/pages/CloudPlayback.jsx | server | Local predates prod's 10-16 work. Server adds the "One MP4, trimmed" server export (`getExportUrl`), clip end taken from the `_to_HH-MM-SS` name, and `?view=gallery`. |
| src/core/pages/MonitorWallHome.jsx | server | Local lacks the AUTO_GRIDS 2..6 picker (already in 0929) and uses the old "Camera Setup" wording. Server also keeps Edit wall, with a note that the backend now ships wall-layouts. |
| src/core/pages/Dashboard.jsx | server | Server adds `aiOn` gating of detections/AI analytics and the per-account Cloud Storage card. Local's "Storage Used" (server disk) is 0929 code. |
| src/core/pages/LiveView.jsx | server | Local = 0929 wording + the entitlement change server already had. Server adds the fullscreen main-stream quality, next-page stream prewarm (`useStreamPrewarm`) and the live audio/relay work. |
| src/modules/person-tracking/PersonTracker.jsx | local | Local = server + a genuine addition: a live-session store (`./live-session`, local-only file with test), so stops stay after they age out of the window, plus "last seen X ago". Nothing on the server side is lost. |
| src/core/services/auth.js | local | Deliberate SNAPSHOT_NOTES fix: the demo login is opt-in via VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD, and the real person's credentials are removed. Server = 0929 code. |
| src/core/pages/monitor-wall/model.js | server | NVR_PULL_LIMIT 36 (server since 0929, with the decoder-ceiling note). Local's 9 is older. |
| src/core/hooks/useDashboardStats.js | server | Server adds the `storage.cloud` per-account usage that Dashboard needs. |
| src/modules/occupancy/zone-setup/GateEditor.jsx | local | Local = server + `footfallDown` prop: says "service not responding" rather than blaming the camera (10-27 clock-drift 401). No server build has this. |
| src/modules/occupancy/zone-setup/GateLineEditor.jsx | local | Same `footfallDown` addition. |
| src/modules/occupancy/zone-setup/ZoneSetup.jsx | local | Same addition: derives `footfallDown` from `useOccupancy().errors.footfall` (the hook is identical on both sides) and passes it down. |
| src/modules/ai-feed/aifeed/event-model.js | server (UNCERTAIN) | Only difference is the label "Vehicles" (server, every build since 1020) vs "Vehicles / ANPR" (local, in no build). This could be a local rename. It is cosmetic, so it is easy to flip. |
| src/core/pages/CameraHealth.jsx | server | Only diff: the local empty-state wording "Add cameras from Camera Setup..." is 0929 text. Server's is newer. |
| src/core/components/RequireCameras.jsx | server | Same: the local default description is 0929 text. |
| .gitignore | local | Deliberate SNAPSHOT_NOTES fix: stop ignoring *.mp4/*.webm/*.mpeg, because the demo videos ship via Git LFS. |
| .env.example | local | Local adds the commented VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD entries that go with auth.js. |

## Auto-merged files (git merge-file) — checked

Every one of these except NvrPlayback was already byte-identical to SERVER. For each, local matched an older build exactly, so server is correct:

- Local = 0929 text, server changed by 1020: ForgotPassword.jsx, MonitorWall.jsx, MonitorWallLive.jsx, Register.jsx, ResetPassword.jsx, monitor-wall/CameraLibrary.jsx, store/toastStore.js. Confirmed.
- Local = 0929 text, server changed by 10-17: playback/timelapse.js, services/recordings.js (server adds `getExportUrl`). Confirmed.
- Local = 0929..1030 text, server changed 1030b: lib/utils.js (adds `fullscreenQuality`). Confirmed.
- Local = 1020..1027b text, server changed 1030+: layout/ProtectedRoute.jsx (1030b), players/DirectStreamPlayer.jsx, players/PlayerFrame.jsx, services/streamRegistry.js (stream latency / relay work). Confirmed.
- Local = 1020..1030 text, server changed 1030c: ai-feed/aifeed/AiCameraCard.jsx. Confirmed.
- services/playback.js: local = 1020..1030c text, server changed 1104. Server wholesale confirmed.
- **pages/NvrPlayback.jsx: FIXED to server.** The merge had kept one local line, "Cameras added in Camera Setup appear in the picker above." That is 0929 wording. Every server build since 1020 says "Cameras you add under Setup › Add cameras ...", which matches the sidebar label "Add cameras" in both trees.

## Import check

- Every relative/`@/` import of every final file resolves against merged ∪ LOCAL ∪ the 4 server-only files.
- Every named import exists in the target's final version.
- The whole LOCAL tree was also re-checked against the merged versions of the files it imports. No missing exports.
- One pre-existing unresolved import is unrelated to this merge: `src/pages/AttendanceReport.jsx` imports `@/services/ai`, which exists in neither tree's path. It was already broken locally.

## package.json

SERVER and LOCAL package.json are identical (ignoring CRLF). The server-only files import only `react`. No dependency is missing.
