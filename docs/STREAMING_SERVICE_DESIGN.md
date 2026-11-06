# Drishyam Streaming Service — System Design

> **Status:** living document · **Last updated:** 2026-07-05
> **Scope:** the video data plane — from camera RTSP ingest to browser playback,
> recording, AI egress, and the control loops that keep it healthy at scale.
> **Audience:** engineers extending or operating the streaming subsystem.

---

## 1. Purpose

The Streaming Service is the **single abstraction the backend uses to control
live and recorded video**. Everything above it (controllers, routes, the SPA,
the AI worker) depends only on this surface; the engine underneath (MediaMTX
today) is swappable. This document describes the current architecture, the
control loops that make it reliable at ~2,000 cameras, the known gaps, and the
roadmap to make it more powerful.

**Design goals**
- Sub-500ms live latency for the focused camera; ~2s reliable fallback for grids.
- Survive camera/NVR flaps, engine restarts, and network blips without operator action.
- Bounded resource use — pull a camera only while it's watched (on-demand).
- Engine-agnostic: a native/C++ core could replace MediaMTX without touching callers.

---

## 2. High-level architecture

```
                          ┌──────────────────────── DRISHYAM BACKEND (Node) ───────────────────────┐
                          │                                                                         │
   IP cameras / NVRs      │   CONTROL PLANE (this service + control loops)                          │
   ┌───────────┐          │   ┌─────────────────────────────────────────────────────────────┐     │
   │ Cam / NVR │──RTSP──┐ │   │  drishyamStreaming.service  (StreamingEngine singleton)       │     │
   │ Cam / NVR │──RTSP──┤ │   │    add/remove path · getPath · list · URL builders · retry    │     │
   │   ...     │        │ │   └───▲─────────────────────────────────────────────────────┬────┘     │
   └───────────┘        │ │       │ REST /v3/config/paths (add/patch/delete), /v3/paths  │          │
                        │ │       │                                                       │          │
                        ▼ │       │        control loops (leader-elected):               ▼          │
                 ┌──────────────┐ │   • streamSupervisor  (health state machine, 2s)   spawn        │
                 │  MediaMTX    │◄┘   • recordingSync      (S3 sync 5m + watchdog 2m)    FFmpeg      │
                 │  ENGINE POOL │     • mediamtxReconcile  (retention drift, 60s)      transcoder    │
                 │ (1..N nodes) │     • cameraReachability (TCP prober, 25s)          (H265→H264)    │
                 └──────┬───────┘                                                                    │
      DATA PLANE        │  egress                                                                    │
      RTSP 8554 ────────┼────────────────────────────► AI worker (vms_face) reads rtsp://.../cam_<id>│
      WebRTC 8889 ──┐   │  HLS 8888 ──┐                                                              │
                    │   │             │                └───────────────────────────────────────────┘
                    ▼   ▼             ▼
                 ┌──────────────────────┐        ┌──────────────┐
                 │        NGINX         │◄───────│   Browser    │   /live/<path>/whep  (WebRTC)
                 │  /live/ (ip_hash)    │  HTTPS │   SPA player │   /hls/<path>/*.m3u8 (HLS)
                 │  /hls/  (round-robin)│        └──────────────┘
                 │  /api/  (rate-limit) │
                 └──────────────────────┘
```

**Two planes, kept separate:**
- **Control plane** — the backend tells the engine *what paths should exist*
  (add/remove/patch) and *reads their runtime state* (ready? bitrate?). This is
  the Streaming Service + the control loops. All REST, low bandwidth.
- **Data plane** — actual video bytes flow camera → engine → browser/AI. The
  backend never touches these bytes (except the FFmpeg transcoder for H.265).

---

## 3. The engine abstraction (new)

The service is now a **pluggable engine** behind a stable facade, so MediaMTX is
an implementation detail, not the identity.

```
   consumers (controllers, routes, stream/recordingSync/transcoder services)
        │  require('.../drishyamStreaming.service')   ← the ONLY import point
        ▼
   drishyamStreaming.service.js        exports createEngine()  ── legacy shim:
        │                                                          mediamtx.service.js
        ▼                                                          re-exports the same
   streaming/index.js  createEngine()  ── selects by STREAMING_ENGINE (default 'mediamtx')
        │                                  throws on unknown; logs active engine
        ▼
   streaming/StreamingEngine.js  (abstract contract: method surface + behavioural rules)
        ▲ extends
   streaming/MediaMTXEngine.js   (REST client, retry helpers, path CRUD, URL builders, .api)
        │
        └── future: NativeCoreEngine, GStreamerEngine, … (implement the same contract)
```

**Contract highlights** (enforced by the base class; see `StreamingEngine.js`):
- `addCamera` — idempotent (patch-on-exists), throws `AppError(502)` on hard failure.
- `addCameraSubStream` — best-effort, never throws (a missing sub only degrades grid).
- `removeCamera` / `removeCameraSubStream` / `deletePathByName` — return `true`
  when the path is **gone** (removed or already absent), `false` only if every
  attempt failed. Never throw.
- `getPath` / `listPaths` / `listConfiguredPaths` — return `null`/`[]` when the
  engine is unreachable so callers degrade gracefully.

**Adding an engine:** implement `StreamingEngine`, register it in the `ENGINES`
map in `streaming/index.js`, set `STREAMING_ENGINE=<key>`. Nothing else changes.

---

## 4. Path namespace

Every camera maps to a predictable set of engine paths keyed on `monitorId`, so
the watchdog can filter the `cam_` namespace safely:

| Path                    | Purpose                                  | Source                       |
|-------------------------|------------------------------------------|------------------------------|
| `cam_<id>`              | Main stream (record + WebRTC/HLS egress) | camera main RTSP             |
| `cam_<id>_sub`          | Sub-stream for grid/low-bandwidth        | camera secondary RTSP        |
| `cam_<id>_h264`         | H.264 transcode of an H.265 main         | FFmpeg transcoder (main)     |
| `cam_<id>_sub_h264`     | H.264 transcode of the sub               | FFmpeg transcoder (sub)      |
| `cam_<id>_low_h264`     | Capped low-quality transcode (fallback)  | FFmpeg transcoder (low)      |

The transcoder paths exist only when a source is H.265 (browsers can't decode
H.265 over WebRTC/HLS). **All five must be torn down when a camera is deleted**
(see §6.3).

---

## 5. Camera lifecycle

### 5.1 Add (create group / add channels / bulk import)

```
controller ──► cameraQuota.assertCameraQuota(user, N)      ── plan limit (403 if over)
           ──► router.pickServerForSite(siteId)            ── least-loaded online server
           ──► streamingService.addCamera(monitorId, cfg)  ── POST /v3/config/paths/add/cam_<id>
           │      (idempotent: 400/409 → PATCH; transient blip → retry ×3)
           ──► streamingService.addCameraSubStream(...)     ── best-effort sub path
           ──► Camera.create(...)  +  router.incrementServerLoad(server, N)
           ──► emit CAMERA_ADDED   (supervisor picks it up on next tick)
```

### 5.2 Live view (frontend) — WebRTC-first, clean one-way HLS fallback

The player is split into dedicated components (`WebRTCPlayer`, `HLSPlayer`)
behind a picker, with two routes: `/live` (WebRTC) and `/live-hls` (HLS-only).

```
SPA opens camera ──► GET /api/stream/start/<id>  (stream.service.startStream)
    1. ensure main path exists (re-add if lost after an engine restart)
    2. detect source codec (H264 | H265) via /v3/paths/get
    3. if H265 → spawn FFmpeg transcoder (priority 1) → publishes cam_<id>_h264
    4. warm the HLS muxer (poll ready, then poll segments — up to ~6s+6s)
    5. prefer native H264 sub-stream for grid; else main; else capped low transcode
    ◄── returns { webrtcUrl, hlsUrl, hlsSubUrl, masterUrl }

Browser:  /live      → WebRTCPlayer  (WHEP, sub-500ms)  ── on failure, ONE-WAY ──► HLSPlayer
          /live-hls  → HLSPlayer     (hls.js, ~2s, LRU-capped warm cache)
```

### 5.3 Delete (all routes converge on one handler)

```
controller ──► streamingService.removeCamera(id)          ── DELETE cam_<id>       (retry ×3)
           ──► streamingService.removeCameraSubStream(id)  ── DELETE cam_<id>_sub   (retry ×3)
           ──► Camera.destroy(...)
           ──► emit CAMERA_DELETED
                     │
   server.js  ◄──────┘  (single centralized teardown for EVERY delete route)
     • streamSupervisor.forget(id)     — drop health state (no stale machine on reuse)
     • streamQuality.forget(id)        — drop quality/heal state
     • transcoder.stopTranscoder(id)   — SIGTERM main/sub/low (deliberate = no auto-restart)
     • deletePathByName(cam_<id>_h264 / _sub_h264 / _low_h264)  — remove transcoded paths
                     │
   SAFETY NET ◄──────┘  watchdog Phase 1b deletes any orphan cam_* path whose DB row is gone
```

> **Why this matters:** before the teardown was centralized, delete stopped the
> supervisor state but left the **transcoder FFmpeg running** — it kept
> republishing to `cam_<id>_h264`, so the stream lingered (zombie) and reappeared
> after the watchdog deleted it (duplicate). Stopping the transcoder closes the loop.

---

## 6. Health / liveness state machine (`streamSupervisor`)

Polls each engine's `/v3/paths/list` every **2s** (one call covers all cameras on
that server → O(1) per server). A separate **reachability prober** TCP-connects to
each *distinct* host every **25s** (68 cameras on one NVR = one probe). Only the
**Redis-elected leader** writes DB state and emits events; transitions (not every
tick) trigger writes.

```
                         path exists
          ┌──────────┐   ready=false    ┌────────────┐  ready & bps≥20kbps  ┌───────────┐
          │ PENDING  │ ───────────────► │ CONNECTING │ ───────────────────► │ STREAMING │
          └──────────┘                  └────────────┘                      └─────┬─────┘
                                              │  reachable(host) & idle           │ ready but
                                              │  (on-demand, nobody watching)     │ bps<20kbps ≥20s
                                              ▼                                    ▼
                                        ┌───────────┐                       ┌───────────┐
                                        │  STANDBY  │  (public: ONLINE)     │ DEGRADED  │ (public: ONLINE)
                                        └───────────┘                       └───────────┘
                    not-ready ≥40s & host unreachable │        ≥5 flaps / 120s │
                                              ▼        ▼                       ▼
                                        ┌───────────┐                   ┌─────────────┐
                                        │  OFFLINE  │                   │ QUARANTINED │  (backoff 300s,
                                        └───────────┘                   └─────────────┘   persisted to DB)
```

- **Public mapping:** `STREAMING | DEGRADED | STANDBY → "online"`, everything else → `"offline"`.
- **STANDBY** is the key on-demand insight: an idle on-demand camera reports
  *not-ready* (nobody's viewing) but is healthy — the TCP prober confirms the NVR
  is up, so it shows **online (standby)** instead of a false offline.
- **Flap → quarantine** protects flaky NVRs: ≥5 flaps in 120s → 300s backoff,
  persisted (`quarantine_until`) and rehydrated on restart so a bounce doesn't
  reset the timer. The watchdog skips re-adding quarantined cameras.
- **Self-heal:** `streamQuality` flags stuck-CONNECTING (>30s) or high frame-error
  rate; the supervisor fires `heal()` with per-camera exponential-backoff cooldown
  and a 24h budget (default 20) so a heal storm can't hammer an NVR.

---

## 7. Recording pipeline

MediaMTX writes segmented MP4 to a bind-mounted NAS dir; Node owns the lifecycle
from there.

```
MediaMTX ─ writes ─► /recordings/cam_<id>/<date>/<ts>.mp4   (segments, per-path)
                          │
   S3 SYNC (every 5m, +30s boot stagger)                    WATCHDOG (every 2m, +60s stagger)
   ┌───────────────────────────────────┐        ┌──────────────────────────────────────────┐
   │ • only files ≥2min old, ≥10KB      │        │ Phase 1  re-add MISSING paths (DB = truth;│
   │ • ffprobe duration (15s timeout);  │        │          engine loses config on restart), │
   │   corrupt → delete, no upload      │        │          skip quarantined / unreachable    │
   │ • stitch short (<120s) consecutive │        │ Phase 1b delete ORPHAN cam_* paths whose   │
   │   segments (≤5s gap) via ffmpeg    │        │          DB row is gone (2-pass confirm)   │
   │   concat (10min timeout)           │        │ Phase 2  probe HLS muxer health; cycle a   │
   │ • upload to S3 → delete local      │        │          path only after 3×404 / 2×500 &   │
   └───────────────────────────────────┘        │          >120s ready (per-NVR rate-limited)│
                                                 └──────────────────────────────────────────┘

   RETENTION (mediamtxReconcile, every 60s, leader-only)
   desired = per-camera days resolved  camera → group → site → default(30d)
   observed = GET /v3/config/paths (all)  →  diff by seconds  →  PATCH only drifted paths
   (event-triggered + debounced 1.5s so a bulk add fires ONE reconcile, not N)
```

---

## 8. Reliability model — layered defenses

Each layer catches what the one above misses; nothing single-points-of-fails the
data plane.

```
  Layer 1  Idempotent + RETRY in the engine        →  a blip during add/delete self-recovers (×3, backoff)
  Layer 2  streamSupervisor (2s health)            →  detects dead/degraded/flapping; heals; quarantines
  Layer 3  recordingSync WATCHDOG (2m)             →  re-adds paths lost on engine restart; purges orphans
  Layer 4  mediamtxReconcile (60s)                 →  converges retention drift back to DB intent
  Layer 5  reachability prober (25s)               →  distinguishes idle-on-demand (STANDBY) from OFFLINE
  Cross    Redis leader election                   →  exactly one writer cluster-wide; safe to run N backends
```

**On engine restart** (MediaMTX has no persistent path config): the watchdog
re-adds every DB camera's path within ~2 minutes; the supervisor re-derives state
from live polls; retention re-converges on the next reconcile.

---

## 9. Multi-server scaling

A single MediaMTX instance is practical to ~**500 cameras**; beyond that the
system routes across a **pool** of engine instances.

```
                 ┌───────────────── mediamtx_servers (DB) ─────────────────┐
                 │ id · siteId(nullable) · status(online/offline/draining) │
                 │ capacityCams · currentCams · apiUrl/User/Pass           │
                 │ hlsUrl · webrtcUrl · rtspInternalHost/Port              │
                 └─────────────────────────────────────────────────────────┘
   add camera ─► router.pickServerForSite(siteId):
                   1. site-bound ONLINE servers with headroom, least-loaded first (ORDER BY currentCams ASC)
                   2. else global (siteId=NULL) ONLINE servers, least-loaded
                   3. else 503 (no capacity)
                 ─► Camera.mediamtxServerId = chosen.id ; incrementServerLoad(+N)
   control ─────► every op resolves the camera's server via getServerForCamera (falls back to default global)
```

The supervisor polls **all** online/draining servers each tick; URLs
(`hlsUrl`/`webrtcUrl`) are per-server so the SPA connects to the right instance.

---

## 10. Failure modes

| Failure                                   | Detection                          | Handling                                                        |
|-------------------------------------------|------------------------------------|-----------------------------------------------------------------|
| Engine blip during add/delete             | HTTP error in `_putPath`/`_deletePath` | Retry ×3 (200/600/1500ms); watchdog is the fallback           |
| Engine restart (loses path config)        | watchdog sees DB path not configured | Phase 1 re-adds all DB paths within ~2m                        |
| Camera/NVR flapping                       | supervisor flap counter            | Quarantine 300s backoff (persisted), watchdog skips re-add     |
| Idle on-demand camera looks offline       | reachability prober TCP-connect    | STANDBY (public online), not OFFLINE                           |
| H.265 source (browser can't decode)       | codec detect in `startStream`      | FFmpeg transcode → `cam_<id>_h264`, prefer native H264 sub     |
| Orphan path after out-of-band delete      | watchdog Phase 1b (2-pass)         | Deletes cam_* paths with no DB row                             |
| Corrupt/short recording segments          | ffprobe / size check               | Corrupt deleted; short segments stitched before upload         |
| Retention drift (manual/engine change)    | reconcile diff (60s)               | PATCH drifted paths back to DB-resolved days                   |
| Backend HA / split-brain on writes        | Redis leader lease                 | Only leader writes state + emits events                        |

---

## 11. Known gaps & tech debt

Surfaced by a subsystem audit (2026-07-05) — real, worth tracking:

1. ~~**Server load counter drifts up (bug).**~~ ✅ **FIXED 2026-07-05 (R1).**
   `router.reconcileServerLoads()` now recomputes `currentCams` from ground-truth
   camera counts on the 60s leader reconcile pass, so the tracker self-heals
   regardless of add/delete deltas. (`decrementServerLoad` added for symmetry.)
2. **No load-counter reconciliation.** Nothing re-syncs `currentCams` against
   `COUNT(cameras GROUP BY mediamtxServerId)`; a cascade `SET NULL` can strand capacity.
3. **`draining` status is inert.** The enum exists but `pickServerForSite` doesn't
   treat draining differently — cameras can still route onto a draining node.
4. **Routing is count-only.** No CPU/mem/NVENC-slot awareness; a server can be
   load-shedding while `headroom()` looks fine.
5. **Codec detection isn't cached** — repeated `startStream` calls re-hit the engine API.
6. **Warmup uses fixed 500ms polling**, no exponential backoff — can overwhelm a slow source.
7. **Orphan-confirm state is in-process** (`_orphanSeen`) — resets on backend restart.
8. **No Prometheus alert on prolonged quarantine** — operator must watch `flapCount24h`.

---

## 12. Roadmap — making it more powerful

Ordered by leverage. Each is contained and testable.

**Now (correctness / quick wins)**
- **R1. Fix the server load counter.** ✅ **DONE** — `reconcileServerLoads()`
  recomputes `currentCams` from ground truth on the 60s leader pass. (Fixes gap #1/#2.)
- **R2. `/api/streaming/status` endpoint.** Surface `engineInfo()`, per-server
  load/capacity/health, and quarantined-camera count — one call for ops + a Grafana panel.
- **R3. Act on the teardown-confirmation boolean.** When `removeCamera` returns
  `false`, mark the camera `deletionPending` so the watchdog prioritizes its orphan pass.

**Next (capability)**
- **R4. Engine capability negotiation.** Add `capabilities()` to the contract
  (`{ webrtc, hls, recording, substream, transcodePassthrough }`) so callers adapt
  per engine instead of assuming MediaMTX features.
- **R5. Codec + path-state cache.** Short-TTL cache of `getPath`/codec to cut
  control-API chatter under grid load; invalidate on supervisor transition.
- **R6. Drain-aware routing.** Exclude `draining` servers from `pickServerForSite`;
  add an admin "drain server → migrate cameras" flow for zero-downtime maintenance.
- **R7. Resource-aware routing.** Factor NVENC-slot / CPU into server selection
  (needs a per-server metrics feed) so transcode-heavy cameras land where there's headroom.

**Later (scale / new engines)**
- **R8. Native/GStreamer engine.** Implement `StreamingEngine` for a native core
  (lower per-camera overhead, in-process transcode). The abstraction now makes this
  a contained addition — wire via `STREAMING_ENGINE`.
- **R9. Edge sharding for lakhs of cameras.** Regional engine pools + a routing
  tier; the `mediamtx_servers` table already models the pool — extend with region.
- **R10. Adaptive on-demand tuning.** Per-camera `sourceOnDemandCloseAfter` based
  on view frequency (hot cameras stay warm, cold cameras close fast) to cut idle bandwidth.

---

## 13. Key files

| Concern                     | File                                                        |
|-----------------------------|-------------------------------------------------------------|
| Engine contract             | `smart-cam-backend/src/services/streaming/StreamingEngine.js` |
| MediaMTX implementation     | `smart-cam-backend/src/services/streaming/MediaMTXEngine.js`  |
| Engine factory              | `smart-cam-backend/src/services/streaming/index.js`           |
| Service entrypoint (singleton) | `smart-cam-backend/src/services/drishyamStreaming.service.js` |
| Multi-server routing        | `smart-cam-backend/src/services/mediamtxRouter.service.js`    |
| Health state machine        | `smart-cam-backend/src/services/streamSupervisor.service.js`  |
| Reachability prober         | `smart-cam-backend/src/services/cameraReachability.service.js`|
| Recording + watchdog        | `smart-cam-backend/src/services/recordingSync.service.js`     |
| Retention resolve/apply     | `smart-cam-backend/src/services/recordingRetention.service.js`|
| Retention reconcile         | `smart-cam-backend/src/services/mediamtxReconcile.service.js` |
| Start-stream / codec / warm | `smart-cam-backend/src/services/stream.service.js`           |
| Transcoder (H265→H264)      | `smart-cam-backend/src/services/transcoder.service.js`        |
| Engine config               | `mediamtx.yml`                                                |
| Edge (WHEP/HLS/rate/CORS)   | `nginx.conf`                                                  |
| Frontend players            | `smart-cam-app/src/components/player/{WebRTCPlayer,HLSPlayer,PlayerFrame}.jsx` |
