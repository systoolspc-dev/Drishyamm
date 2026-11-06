# Drishyam — Streaming & Recording Architecture

> **Audience:** new interns / junior engineers picking up the streaming and
> recording subsystem. Read this end-to-end before opening a PR. Sections 1–4
> teach you the system; sections 5–7 are reference; section 8 is your project
> backlog.

---

## 0. What this document covers

The video pipeline: how a frame gets from a camera onto a phone or browser,
and how it gets stored for later playback. This includes:

- **MediaMTX** — the always-on video router (replaces our old Shinobi stack)
- **Backend stream service** — the Node layer that orchestrates MediaMTX
- **Frontend players** — `DirectStreamPlayer` (live) and `HLSPlayer` (playback)
- **Recording sync** — how 15-min on-disk segments end up as proper 10-min
  S3 clips
- **Adaptive bitrate (ABR)** — Netflix-style auto quality switching

It does **not** cover:

- The AI pipeline (`smart-cam-ai/`) — see `13-ai-pipeline.md`
- Auth / billing / multi-tenancy
- Frontend pages other than the live + playback views

---

## 1. Glossary — read this first

| Term | What it means |
|---|---|
| **RTSP** | Real Time Streaming Protocol. The camera "publishes" video over RTSP on port 554. We pull from `rtsp://user:pass@host:port/path`. |
| **HLS** | HTTP Live Streaming. Apple-invented. Splits the stream into 2-second `.ts` (or `.m4s`) chunks listed in an `.m3u8` playlist. Works in any browser via JS. ~2-6s latency. |
| **LL-HLS** | Low-Latency HLS. Adds smaller "parts" (~0.3s each) so you can preview before a chunk finishes. ~1-2s latency. MediaMTX speaks this. |
| **WebRTC / WHEP** | Real-time peer-to-peer video. Sub-500ms latency. WHEP = "WebRTC HTTP Egress Protocol", the standard way browsers negotiate a one-way receive. |
| **Master playlist** | An HLS `.m3u8` that references multiple "variant" playlists at different resolutions. The player picks the variant. **This is how ABR works.** |
| **Sub-stream** | NVRs publish a 2nd, lower-res RTSP feed at e.g. `/Streaming/Channels/102` (Hikvision). Lighter on bandwidth and GPU. |
| **fMP4** | Fragmented MP4. The chunked format MediaMTX writes for recordings — random-seekable and concat-friendly. |
| **Segment** | One MP4 file written by MediaMTX, ~10 minutes of video. |
| **Path** | MediaMTX terminology for "one camera." We name them `cam_<monitorId>`. |
| **monitorId** | Drishyam's stable 24-char ID for a camera. Unique per user. |
| **ABR** | Adaptive Bitrate. The player switches between bitrate variants based on measured network throughput. |
| **MediaMTX API** | REST API on port 9997 used by our backend to add/remove paths and read stats. |

If anything below uses a term not in this table, please add it here in your PR.

---

## 2. The 30-second mental model

```
                 ┌────────────────────┐
                 │    IP Cameras      │
                 │   (RTSP, port 554) │
                 └──────────┬─────────┘
                            │ pull
                            ▼
                 ┌────────────────────────────────┐
                 │           MediaMTX             │
                 │  (Docker container, always on) │
                 │                                │
                 │  • Pulls every camera's RTSP   │
                 │  • Records 10-min MP4 segments │
                 │  • Serves WebRTC (port 8889)   │
                 │  • Serves HLS/LL-HLS (8888)    │
                 │  • REST API (9997)             │
                 └──┬──────────┬───────────┬──────┘
                    │          │           │
       browsers (live)      Node.js     Disk
                            backend     (mediamtx-recordings/)
                            ▲   │              │
                            │   ▼              │ Node reads
                       ┌────┴───────────┐      │ .mp4 files
                       │ smart-cam-     │ ◄────┘
                       │   backend      │
                       │                │
                       │  • REST API    │
                       │  • Builds      │
                       │    master HLS  │
                       │    playlist    │
                       │  • Stitches +  │
                       │    uploads to  │
                       │    S3 every 5m │
                       └────────┬───────┘
                                │
                                ▼
                       ┌────────────────┐
                       │  10PB S3       │
                       │  (recordings)  │
                       └────────────────┘
```

Five facts to remember:

1. **MediaMTX never restarts a camera unless we tell it to.** The path config is
   in-memory in MediaMTX, but the source of truth is our MySQL `cameras` table.
   A watchdog reconciles them every 2 minutes.
2. **Recordings live on disk first, S3 second.** MediaMTX writes to a bind-mounted
   directory; Node uploads them to S3 then deletes the local file.
3. **Live and recording are independent.** Even if no browser is watching, MediaMTX
   keeps the camera connected and recording. (`sourceOnDemand: false`.)
4. **The browser uses WebRTC for single-camera live, HLS for grid + playback.**
   See section 4.3.
5. **Master playlist gives ABR for free** because the camera already has a main
   stream + a sub-stream. We just list both as variants.

---

## 3. Component deep-dive

### 3.1 MediaMTX

**Where it runs.** Docker container (compose file in `infra/`). Ports it exposes:

| Port | Protocol | Used for |
|---|---|---|
| 8554 | RTSP | Internal egress for the AI worker (`rtsp://mediamtx:8554/cam_<id>`) |
| 8888 | HTTPS | HLS / LL-HLS for browsers (`/cam_<id>/index.m3u8`) |
| 8889 | HTTPS | WebRTC WHEP for browsers (`/cam_<id>/whep`) |
| 9997 | HTTP  | REST API used by our backend (auth: basic, user/pass in env) |

**Key concept: paths.** A "path" in MediaMTX is one camera. We name every path
`cam_<monitorId>`. Sub-streams are `cam_<monitorId>_sub`.

**Adding a path** — when a camera is created in our app, the backend POSTs to
MediaMTX:

```http
POST http://mediamtx:9997/v3/config/paths/add/cam_<monitorId>
{
  "source":                "rtsp://user:pass@10.0.0.5:554/Streaming/Channels/101",
  "sourceOnDemand":        false,
  "sourceProtocol":        "tcp",
  "record":                true,
  "recordPath":            "/recordings/%path/%Y-%m-%d/%H-%M-%S-%f",
  "recordSegmentDuration": "10m0s",
  "recordDeleteAfter":     "0s"
}
```

`sourceProtocol: tcp` matters — UDP causes packet loss + FU-A fragmentation
errors with most NVRs. Always use TCP unless a customer explicitly asks otherwise.

**`sourceOnDemand: false`** is what keeps the camera always-connected, even when
no one's watching. Recording would break otherwise.

**Reference doc.** Spec is at https://github.com/bluenviron/mediamtx — read the
"REST API" and "HLS" sections.

### 3.2 Backend — `smart-cam-backend`

#### `src/services/mediamtx.service.js`
Thin wrapper around MediaMTX's REST API. Methods:

- `addCamera(monitorId, camConfig)` — idempotent (PATCH if path exists)
- `removeCamera(monitorId)` — DELETE
- `addCameraSubStream(monitorId, camConfig)` — same but for the sub-stream path
- `getPath(monitorId)`, `listPaths()`, `listConfiguredPaths()` — read state
- `pathName(monitorId)` → `"cam_<id>"`, `subPathName(monitorId)` → `"cam_<id>_sub"`
- `deriveSubPath(mainPath)` — Hikvision: `/Channels/101` → `/Channels/102`,
  Dahua: `subtype=0` → `subtype=1`. Returns null if we can't derive.
- `buildRtspUrl(camConfig)` — URL-encodes special chars in passwords
- `getWebrtcUrl()`, `getHlsUrl()`, `getRtspEgressUrl()` — URL builders

Read the file end-to-end before changing it. ~250 lines, well-commented.

#### `src/services/stream.service.js`
Orchestrator. When a browser hits `/api/stream/start/:monitorId`:

1. Look up the camera in MySQL.
2. Make sure the path exists in MediaMTX (re-add if missing — handles MediaMTX
   restart).
3. Add the sub-stream path if the camera supports one.
4. Return `{ webrtcUrl, hlsUrl, hlsSubUrl, masterUrl }`.

#### `src/controllers/stream.controller.js`
HTTP handlers:

| Endpoint | What it does |
|---|---|
| `GET /api/stream/start/:monitorId` | Calls `streamService.startStream(camera)` and returns URLs |
| `GET /api/stream/status/:monitorId` | Same as start but doesn't re-add path |
| `GET /api/stream/stop/:monitorId` | Calls `removeCamera()` — used during cleanup |
| `POST /api/stream/watchdog/run` | Manually triggers the watchdog |
| `GET /api/stream/master/:monitorId/index.m3u8` | **Builds the ABR master playlist (see 4.2)** |

#### `src/services/recordingSync.service.js`
Two background loops, **either** as BullMQ repeatable jobs (when Redis is up)
or as `setInterval` (legacy fallback):

1. **S3 sync** — every 5 min, finds finalized MP4s under
   `mediamtx-recordings/cam_<id>/YYYY-MM-DD/`, stitches short fragments,
   uploads to S3, deletes the local file.
2. **Watchdog** — every 2 min, reconciles MediaMTX configured paths against
   the MySQL `cameras` table. Re-adds missing paths. Probes the HLS muxer for
   ready cameras and cycles paths whose muxer returns 500 (corrupted after
   RTSP reconnect).

Detailed flow in section 4.5.

### 3.3 Frontend — `smart-cam-app`

#### `src/components/DirectStreamPlayer.jsx`
The live player used on `/live` and any single-camera embed. Flow:

1. `acquireStream(monitorId)` → returns cached `{ webrtcUrl, hlsUrl, masterUrl, ... }`.
2. **WebRTC path** (single view default): create `RTCPeerConnection`, add recv
   transceivers, exchange SDP via `POST {webrtcUrl}/whep`, attach the
   resulting `MediaStream` to the `<video>` tag. Sub-500ms latency.
3. **HLS path** (forced via `forceHls={true}` in grid mode, or fallback):
   load the master playlist (or single-variant `hlsUrl`) via HLS.js.
4. **Quality selector** — overlay button reading `hls.levels`, lets the user
   force a specific variant or stay on Auto.

#### `src/components/HLSPlayer.jsx`
Plain HLS.js wrapper used on `/playback`, `/gallery`, etc. Same quality
selector. Used for recordings (signed S3 URLs) — those are not master
playlists, so the selector hides itself.

#### `src/services/streamCache.js`
Single registry keyed by `monitorId`. **Why it exists:** without caching,
switching camera A → B → A would reload HLS.js from scratch and re-buffer
6+ seconds. The cache keeps `Hls` instances alive across mounts.

Important methods:
- `acquireStream(monitorId)` — dedups concurrent calls, returns cached entry
- `evictStream(monitorId)` — destroys after a fatal error
- `releaseAllStreams()` — call when leaving the live page

The HLS instance is created with `xhrSetup` that injects the JWT only on the
master-playlist URL (variant playlists hit MediaMTX directly, no auth there).

---

## 4. Data flows — the things you'll touch

### 4.1 Live (WebRTC) flow — single camera view

```
Browser                                   Backend                   MediaMTX
   │                                        │                          │
   │ acquireStream(monitorId)               │                          │
   │ ─────────────────────────►             │                          │
   │ GET /api/stream/start/<id>             │                          │
   │ ─────────────────────────────────────► │                          │
   │                                        │ ensure path + sub-path   │
   │                                        │ ─────────────────────►   │
   │                                        │ POST /v3/config/paths/.. │
   │                                        │ ◄─────────────────────   │
   │ { webrtcUrl, hlsUrl, masterUrl }       │                          │
   │ ◄─────────────────────────────────────                            │
   │                                                                   │
   │ POST <webrtcUrl>/whep   (SDP offer)                              │
   │ ────────────────────────────────────────────────────────────────► │
   │ ◄──────────────── (SDP answer) ────────────────────────────────── │
   │                                                                   │
   │ ◄═════════════════════════════════════════════════════════════════│
   │            video frames (sub-500ms latency)                       │
```

### 4.2 ABR master playlist

When the player requests `/api/stream/master/<monitorId>/index.m3u8`, the
backend builds this on the fly:

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=4147200,RESOLUTION=1920x1080,FRAME-RATE=25,NAME="High"
http://localhost:8888/cam_<id>/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=614400,RESOLUTION=640x480,FRAME-RATE=25,NAME="Low"
http://localhost:8888/cam_<id>_sub/index.m3u8
```

HLS.js fetches both variant playlists and switches based on measured bandwidth.
**No transcoding** — the camera already publishes both streams.

Code: `streamService.buildMasterPlaylist(camera)` in
`src/services/stream.service.js`.

### 4.3 HLS path (grid view, mobile, fallback)

Same as 4.1 except step 4 is:

```
hls.loadSource(masterUrl)
hls.attachMedia(<video>)
hls.on(MANIFEST_PARSED) → hls.startLoad(-1)
hls.on(LEVEL_SWITCHED) → update quality selector UI
```

We **always** load the master playlist when available; HLS.js does the rest.

### 4.4 Recording capture (MediaMTX side)

```
RTSP frames ──► MediaMTX path "cam_<id>"
                       │
                       │  recordPath: /recordings/%path/%Y-%m-%d/%H-%M-%S-%f
                       │  recordSegmentDuration: 10m0s   (env-driven)
                       ▼
       /recordings/cam_<id>/2026-05-02/14-23-45-123456.mp4   (~10 min)
       /recordings/cam_<id>/2026-05-02/14-33-45-654321.mp4
       /recordings/cam_<id>/2026-05-02/14-43-46-...
```

Filenames: `HH-MM-SS-microseconds.mp4`. The microseconds suffix breaks ties
when MediaMTX rotates segments at the same wall-clock second.

**Real-world reality:** MediaMTX rotates at keyframes, not exact wall-clock
boundaries, so segments are *approximately* 10 minutes. They can also be
much shorter when the RTSP source disconnects and reconnects. We handle
that in 4.5.

### 4.5 S3 sync — including the stitcher

Every 5 minutes, for every camera, `recordingSync.runSync()` does:

```
1. Find finalized .mp4 files in mediamtx-recordings/cam_<id>/
   (skip files modified within the last 2 minutes — still being written).
2. For each, run ffprobe to get the actual duration.
3. Drop unreadable files.
4. Sort by start time (parsed from filename).
5. PLAN BATCHES:
   - A "long" segment (≥ 120s) is its own batch of 1.
   - "Short" segments (<120s) get merged with adjacent short segments
     that are within 5s of each other, up to a 15-min batch ceiling.
6. MATERIALIZE each batch:
   - 1 segment → upload as-is.
   - N segments → ffmpeg-concat (lossless `-c copy`) into one file → upload.
7. S3 KEY: recordings/<userId>/<group>/<camera>/<YYYY-MM-DD>/
            <HH-MM-SS>_to_<HH-MM-SS>_<duration>m.mp4
8. DELETE local sources on success.
```

Knobs (all env-driven):
- `RECORDING_SEGMENT_DURATION` (default `10m0s`) — what we tell MediaMTX
- `RECORDING_STITCH_BELOW_SEC` (default `120`) — fragment-size threshold

Why we stitch: RTSP reconnect storms during a network glitch can produce
20 × 8-second files in a row. Without stitching, S3 ends up with thousands
of nearly-empty objects and the playback experience is awful. With
stitching, those become one ~3-min clip with a sensible filename.

### 4.6 Playback

```
Browser /playback/<groupId>?date=YYYY-MM-DD
   │
   │ fetches recording list:
   │ GET /api/groups/:id/recordings?date=...
   │   ◄ s3.listGroupRecordings()
   │
   │ user clicks a clip:
   │ GET /api/groups/:id/recordings/play?key=...
   │   ◄ getPlaybackUrl(key, 3600) → 1h presigned URL
   │
   │ HLSPlayer / native <video>
   │   src = presignedUrl
   │   plays MP4 directly (no HLS for recordings — single file each)
```

For thumbnails, see `getThumbnailForRecording` in
`src/controllers/cameraGroup.controller.js`. It runs `ffmpeg -vframes 1`
against the presigned URL and caches the JPEG in Redis for 7 days.

### 4.7 Self-healing watchdog

`recordingSync.runWatchdog()` runs every 2 minutes:

```
1. Load all cameras from DB (joined with group for credentials).
2. listConfiguredPaths() + listPaths() in parallel.
3. PHASE 1 — re-add missing paths:
     for each camera, if cam_<id> isn't configured in MediaMTX, add it.
     Also re-add sub-streams if the main is configured but sub isn't.
4. PHASE 2 — probe HLS muxer for "ready" cameras:
     fetch http://localhost:8888/cam_<id>/index.m3u8 (HEAD → status code).
     - 500 → muxer corrupted → remove + re-add path (forces fresh muxer).
     - 404 ≥ 60s after readyTime → same.
     - 200 / fresh 404 → fine.
5. PHASE 3 — sync DB camera.status from MediaMTX live state.
```

The watchdog is the single most important reliability component. **If
something starts dying in production, look at the watchdog logs first.**

---

## 5. Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `MEDIAMTX_API_URL` | `http://localhost:9997` | REST API base for MediaMTX |
| `MEDIAMTX_API_USER` / `_PASS` | `drishyam` / `drishyam123` | Basic auth for MediaMTX API (set in `mediamtx.yml`) |
| `MEDIAMTX_HLS_URL` | `http://localhost:8888` | Public HLS URL the browser uses |
| `MEDIAMTX_WEBRTC_URL` | `http://localhost:8889` | Public WebRTC URL the browser uses |
| `MEDIAMTX_RTSP_HOST` / `_PORT` | `localhost` / `8554` | Internal RTSP egress for AI worker (never browser-facing) |
| `MEDIAMTX_RECORDINGS_DIR` | `./mediamtx-recordings` | Host bind-mount for recording storage |
| `RECORDING_SEGMENT_DURATION` | `10m0s` | Go duration string passed to MediaMTX |
| `RECORDING_STITCH_BELOW_SEC` | `120` | Below this, fragments get stitched before S3 upload |

The MediaMTX side is configured in `mediamtx.yml` (in the compose context).
The relevant block:

```yaml
api: yes
apiAddress: :9997
authMethod: internal
authInternalUsers:
  - user: drishyam
    pass: drishyam123
    permissions:
      - action: api

paths:
  all_others:                              # default — actual cameras override
    sourceProtocol: tcp
    record: yes
    recordPath: /recordings/%path/%Y-%m-%d/%H-%M-%S-%f
    recordSegmentDuration: 10m0s
    recordDeleteAfter: 0s
```

---

## 6. Local dev setup (do this on day 1)

```bash
# 1. Start MediaMTX in Docker
cd infra
docker compose up -d mediamtx
docker logs -f mediamtx-1   # confirm ":9997" "ready"

# 2. Backend
cd ../smart-cam-backend
cp .env.example .env
# Edit .env: set DB creds, JWT_SECRET, S3 keys
npm install
npm run db:migrate
npm run dev    # http://localhost:5000

# 3. Frontend
cd ../smart-cam-app
npm install
npm run dev    # http://localhost:5173

# 4. Add a test camera
# - Open http://localhost:5173, register, log in.
# - Devices → Add device → use any RTSP URL you have access to.
#   No real camera? Use a public test RTSP:
#   rtsp://rtspstream.com/movie    (free, low FPS)
# - Click Live → you should see the stream within ~5s.
```

If nothing shows up, in this order:

```bash
# Is MediaMTX even running?
curl -u drishyam:drishyam123 http://localhost:9997/v3/paths/list | jq

# Is the path configured?
curl -u drishyam:drishyam123 http://localhost:9997/v3/config/paths/list | jq

# Is the path "ready" (RTSP source connected)?
curl -u drishyam:drishyam123 http://localhost:9997/v3/paths/get/cam_<monitorId>

# Can you fetch the HLS playlist directly?
curl -i http://localhost:8888/cam_<monitorId>/index.m3u8
```

If `ready: false` for many seconds, your RTSP URL is wrong or unreachable.
If the playlist 404s but `ready: true`, the muxer is corrupted — call the
watchdog manually:

```bash
curl -X POST http://localhost:5000/api/stream/watchdog/run -H "Authorization: Bearer <jwt>"
```

---

## 7. Common debugging patterns

### "The video is laggy / freezes after a minute"

Most often: **HLS muxer race**. MediaMTX recreates the HLS muxer with a fresh
hash prefix when the source reconnects. The browser still has stale segment
URLs.

Fix in code: `evictStream(monitorId)` then `acquireStream` re-fetches.
See `DirectStreamPlayer.jsx` HLS error handler.

Logs to look for: `watchdog: HLS muxer returned 404 — cycling path`.

### "Recording files are tiny"

The RTSP source is flapping. `ffprobe` will show 8-12 second durations.
The stitcher should glue these into a normal clip on the next sync run.

If stitching isn't working, check:

- `RECORDING_STITCH_BELOW_SEC` (default 120 — set lower with caution)
- `ffmpeg` and `ffprobe` are on `PATH`
- Logs for `recordingSync: stitched + uploaded`

### "Camera is offline in the UI but I can ping it"

The DB status field reflects MediaMTX's last known state. The watchdog updates
it every 2 minutes. Either:

- Wait 2 minutes
- Run the watchdog manually
- Restart the Node backend

### "Master playlist returns 401"

JWT not getting injected. Check `streamCache.createHlsInstance` — the
`xhrSetup` callback must add the `Authorization` header **only** on URLs
containing `/api/stream/master/`. Adding it to MediaMTX URLs triggers
CORS preflight failures.

### "WebRTC works locally but not in production"

NAT traversal. Need either:
- Public IP on the MediaMTX server, OR
- A TURN server configured in `mediamtx.yml` under `webrtc:`

For dev, the default Google STUN server is in `DirectStreamPlayer`.

---

## 8. Improvement projects — pick one

These are intern-sized tasks (1-2 weeks each). For each: goal, files,
suggested approach, and definition of done.

### Project 1 — Recording health dashboard

**Goal.** Operators don't know if a camera is actually recording. Build a
dashboard showing per-camera recording health: last-segment-time,
segments-per-hour, average segment duration, total bytes today.

**Why it matters.** Customer's #1 fear: "is it recording right now?"
Today they have to check S3. We can answer it in the UI.

**Files.**
- New: `src/services/recordingMetrics.service.js` (collects + caches stats)
- New: `src/controllers/recordingHealth.controller.js`
- New: `src/routes/recordingHealth.routes.js`
- New: `smart-cam-app/src/pages/RecordingHealth.jsx`
- Existing: extend `recordingSync.service.js` to emit metrics on each sync

**Approach.**
1. Track per-camera stats in an in-memory map; persist a snapshot every 5 min.
2. Backend endpoint returns JSON for the past 24h.
3. Frontend page: table per camera with sparkline of segments-per-hour.
4. Add a "tampering" red badge when last-segment > 30 min ago for an online
   camera.

**Definition of done.**
- Page shows live stats for all cameras of the logged-in user.
- Updates every 30s without user action.
- Cypress test: simulate a camera with no segments → red badge appears.

---

### Project 2 — LL-HLS first-frame optimization

**Goal.** First-frame latency on `/live` is currently 4-8 seconds in
production. Target: < 2 seconds via LL-HLS tuning.

**Why it matters.** Demos lose energy when video takes 5 seconds to start.

**Files.**
- `mediamtx.yml` (HLS settings)
- `smart-cam-app/src/services/streamCache.js` (`createHlsInstance`)

**Approach.**
1. In `mediamtx.yml`, set `hlsLowLatency: yes` and `hlsPartDuration: 200ms`.
2. In HLS.js config, tune `liveSyncDurationCount: 2`, `lowLatencyMode: true`,
   and `manifestLoadingTimeOut: 4000`.
3. Measure first-frame time using `performance.now()` between
   `acquireStream` and `LEVEL_LOADED`. Add to telemetry.
4. Try also `startPosition: -2` (seek to 2s before live edge — gives buffer
   without losing live feel).

**Definition of done.**
- Telemetry shows median first-frame < 2s on a wired connection.
- No regression in stability (no increase in stalls per session).
- Doc updated with the chosen settings + measurements.

---

### Project 3 — Per-camera retention policies

**Goal.** Right now we keep recordings forever (until S3 cost forces us
otherwise). Implement per-camera retention: "delete recordings older than
N days for this camera."

**Why it matters.** Compliance (DPDPA / GDPR), storage cost, customer ask.

**Files.**
- New migration `010-add-retention-days.js` (column on `cameras`)
- `src/services/recordingSync.service.js` (add a third repeatable job:
  retentionEnforcer)
- `smart-cam-app/src/components/AISettingsPanel.jsx` and the camera edit
  dialog (UI to set days)

**Approach.**
1. Camera model: add `retentionDays INT DEFAULT 30`.
2. Nightly BullMQ job:
   ```js
   for each camera:
     prefix = `recordings/${userId}/${group}/${camera}/`
     for each S3 object older than retentionDays:
       deleteObject(key)
   ```
3. UI control on camera edit: dropdown 7 / 14 / 30 / 60 / 90 / 180 days +
   "custom".
4. **Safety:** require confirmation, show "this will delete X TB" before
   shortening.

**Definition of done.**
- Test camera with 5-day retention has no objects older than 5 days after
  one nightly run.
- UI prevents shortening without confirmation.
- Audit log entry for every deletion (links to Track F).

---

### Project 4 — Tampering detection

**Goal.** Alert when a camera is covered, sprayed, or tilted away.

**Why it matters.** Universal customer expectation — every VMS has it.

**Files.**
- New: `src/services/cameraTamper.service.js`
- Wired via the event bus (emits `camera.tampered`)

**Approach.**
1. Sample one frame per camera every 30s (use `ffmpeg -ss now -frames:v 1`
   against the RTSP egress).
2. Compute pixel variance and average brightness.
3. State machine per camera:
   - 3 consecutive samples with `variance < 50` → camera covered.
   - 3 samples with `brightness > 250` → spray painted (often white).
   - Compare current frame's bottom-half to last week's same time-of-day
     mean to detect tilting (advanced — defer if time-pressed).
4. Emit `camera.tampered` event via the event bus → fanout via socket.io
   + AlertDispatch (Track C) handles SMS.

**Definition of done.**
- Cover the lens of a test camera with paper → alert fires within 2 minutes.
- Uncover → camera goes back to "ok" status (no alert).
- False-positive rate on "normal" cameras over 24h: < 1.

---

### Project 5 — PTZ controls (ONVIF Profile S)

**Goal.** Pan/tilt/zoom on the live view for cameras that support it.

**Why it matters.** Most NVRs and modern cameras support PTZ; right now we
ignore it.

**Files.**
- New: `src/services/onvif.service.js` (uses `node-onvif`)
- New: `src/controllers/ptz.controller.js`
- New: `src/routes/ptz.routes.js`
- New: `smart-cam-app/src/components/PtzControl.jsx`

**Approach.**
1. ONVIF discovery happens once per camera at provisioning; capabilities
   stored on `camera.settings.ptz`.
2. Endpoints:
   - `POST /api/cameras/:id/ptz/move` body `{ pan, tilt, zoom, duration }`
   - `POST /api/cameras/:id/ptz/preset/save` body `{ name }`
   - `POST /api/cameras/:id/ptz/preset/recall` body `{ name }`
3. Frontend: directional pad overlay on live view (visible only when
   `camera.ptzCapable`).
4. Keyboard shortcuts: `WASD` for pan/tilt, `+/-` for zoom.

**Definition of done.**
- Real Hikvision PTZ camera can be moved from the UI.
- 4 presets save and recall correctly.
- `ptzCapable: false` cameras show no controls.

---

### Project 6 — Bandwidth scheduler

**Goal.** Limit S3 sync bandwidth during business hours (8am-6pm) so
customer office WiFi doesn't choke.

**Why it matters.** Common complaint at on-prem-ish deployments.

**Files.**
- `src/services/recordingSync.service.js`
- New env vars: `SYNC_BANDWIDTH_LIMIT_MBPS`, `SYNC_BUSY_HOURS_START/END`

**Approach.**
1. Add a `bottleneck` library between the sync function and the S3 client.
2. Config: max bytes/sec during busy hours, unlimited otherwise.
3. Resume catchup at 2am (already runs, but explicit "burst" allowed).
4. Per-customer override via env (later: per-tenant in DB).

**Definition of done.**
- During busy hours, S3 upload throughput stays under the limit
  (verifiable via Grafana).
- After hours, full bandwidth used.
- README documents the trade-offs.

---

### Project 7 — WebRTC TURN server integration

**Goal.** WebRTC works behind any NAT.

**Why it matters.** Today WebRTC fails on customer networks with strict NAT
(common in schools, hospitals, corporate). Falls back to HLS, which is fine
but loses the sub-500ms wow factor.

**Files.**
- `mediamtx.yml` (add `webrtcICEServers`)
- `infra/coturn/` (new — TURN deployment)
- `smart-cam-app/src/components/DirectStreamPlayer.jsx` (consume the new
  ICE server list)

**Approach.**
1. Deploy `coturn` in Docker with a long-term username/password.
2. Configure MediaMTX to publish ICE servers in WHEP responses.
3. Update DirectStreamPlayer to read the server list dynamically (so we can
   rotate creds without a frontend deploy).

**Definition of done.**
- WebRTC connects from a test laptop on a corporate VPN → it currently fails.
- TURN server uses < 5% CPU at typical load (it just relays UDP).
- Credential rotation procedure documented.

---

### Project 8 — Recording metadata table

**Goal.** Today, listing recordings does an S3 LIST every time
(slow, expensive, paginates badly). Move metadata into a `recordings`
table updated by the sync job.

**Why it matters.** Foundational for forensic search — Track B can join
events to clips by timestamp instead of doing S3 LIST.

**Files.**
- New migration `011-recordings-table.js`
- New model `src/models/Recording.js`
- `src/services/recordingSync.service.js` (insert a row on each successful
  upload)
- `src/controllers/cameraGroup.controller.js` (`getGroupRecordings`,
  `getCameraRecordings`) — query DB instead of S3 LIST.

**Approach.**
1. Schema:
   ```
   recordings(id PK, user_id, camera_id, monitor_id,
              started_at, ended_at, duration_sec,
              s3_key, size_bytes, thumbnail_s3_key,
              created_at, indexed_for_ai BOOL)
   index (camera_id, started_at)
   index (user_id, started_at)
   ```
2. After each successful S3 upload, insert a row.
3. Backfill script reads existing S3 prefix and populates rows.
4. Switch the recordings list endpoints to query SQL.

**Definition of done.**
- Listing one day's recordings: < 100ms from cache, < 500ms cold.
- Backfill script completes on existing dev S3.
- Old code paths removed; no S3 LIST in the recording-list controllers.

---

### Project 9 — Smart thumbnails

**Goal.** Generate one thumbnail per recording at upload time, not on first
view. Store it next to the MP4.

**Why it matters.** Today the `/recordings/thumbnail` endpoint runs
ffmpeg on every cold view (even with Redis cache). At scale this is the
slowest endpoint we have.

**Files.**
- `src/services/recordingSync.service.js`
- `src/controllers/cameraGroup.controller.js` (`getThumbnailForRecording`
  becomes a 302 to S3)

**Approach.**
1. After each successful upload, generate a thumbnail with ffmpeg
   (`-ss 00:00:02 -frames:v 1 -vf scale=320:-1`).
2. Upload to `thumbnails/<userId>/...same-path.../...mp4.jpg`.
3. Save key in the new `recordings.thumbnail_s3_key` column (Project 8).
4. Endpoint: 302 redirect to a presigned URL for the thumbnail key.

**Definition of done.**
- `/recordings/thumbnail` p95 < 50ms (from 2-3s today).
- Existing thumbnails still work (fallback path).
- Storage cost increase < 0.1% of recording cost.

---

### Project 10 — Dynamic 4-tier ABR with FFmpeg sidecar

**Goal.** Today ABR has 2 tiers (camera main + sub-stream). Add 2 more
tiers via on-demand transcoding so we get true 4-level adaptive (1080p /
720p / 480p / 240p).

**Why it matters.** Genuine improvement for low-bandwidth mobile users
on high-res cameras.

**Files.**
- `mediamtx.yml` — `runOnReady` hook
- New: `infra/transcoder/transcode.sh`
- `src/services/stream.service.js` — extend master playlist builder

**Approach.**
1. When a camera path becomes ready, MediaMTX runs `runOnReady` which
   spawns FFmpeg:
   ```
   ffmpeg -i rtsp://localhost:8554/cam_<id> \
          -c:v libx264 -preset veryfast -tune zerolatency \
          -vf scale=1280:720 -b:v 1500k \
          -f rtsp rtsp://localhost:8554/cam_<id>_720p
   ```
2. Repeat for 480p, 240p.
3. Master playlist includes all four variants.
4. Tear down transcoders when path goes idle (`runOnNotReady`).

**Definition of done.**
- Master playlist for a camera with `width: 1920` returns 4 variants.
- Loadtest: 8 cameras transcoding simultaneously stays under 80% CPU on
  a 4-core machine.
- Transcoders auto-stop when no viewer requests the lower tiers (use
  MediaMTX `sourceOnDemand` for the sidecar paths).

---

### Project 11 — Multi-MediaMTX router

**Goal.** Today the backend assumes one MediaMTX instance. Make the backend
shard cameras across N instances so we can scale past ~500 cameras per node.

**Why it matters.** This is the single biggest blocker to handling 2,000+
cameras (see `15-scaling.md` if it exists, or the team chat archive).

**Files.**
- New migration `012-mediamtx-servers.js`
- New model `src/models/MediaMTXServer.js`
- New: `src/services/mediamtxRouter.service.js`
- All call sites of `mediamtxService.addCamera` / `removeCamera`

**Approach.**
1. Schema:
   ```
   mediamtx_servers(id, site_id, hostname, api_url,
                    hls_url, webrtc_url, rtsp_internal,
                    capacity_cams, current_cams, status,
                    last_heartbeat)
   ```
2. Each `Camera` row gets `mediamtx_server_id` FK.
3. `mediamtxRouter.assignServer(siteId)` — picks the least-loaded server.
4. Refactor `cameraGroup.controller.js` and `stream.controller.js` to look
   up the right server before any MediaMTX call.
5. Heartbeat endpoint: each server POSTs `/api/internal/sites/heartbeat`
   every 30s.

**Definition of done.**
- Two MediaMTX containers running locally, cameras distributed across them.
- Stop one container → its cameras show as "offline" within 90s.
- Live URLs returned by `/api/stream/start` correctly reflect the server
  hosting that camera.

---

### Project 12 — Privacy redaction on clip export

**Goal.** When an operator exports a clip for sharing (e.g., to police),
optionally blur all faces except a chosen one.

**Why it matters.** GDPR / DPDPA / customer ask. Genetec has this; we don't.

**Files.**
- New: `src/services/clipExport.service.js`
- New: `src/controllers/clipExport.controller.js`
- New: `src/queues/workers.js` (export job worker)
- New: `smart-cam-app/src/components/ClipExportDialog.jsx`

**Approach.**
1. Endpoint: `POST /api/recordings/:key/export` with body
   `{ keepFaceId?: string, redactAllFaces?: boolean }`.
2. Enqueue a BullMQ job: download the clip, run InsightFace per frame,
   blur faces (gaussian blur on the bbox), reupload as
   `exports/<userId>/<exportId>.mp4`.
3. Notify the user via socket.io when ready (`export.ready`).
4. Frontend: click "Export" on a recording → dialog with options → progress
   bar → download link.

**Definition of done.**
- A 2-minute clip with 5 visible faces exports in < 60s on the dev GPU.
- All faces blurred except the chosen one (verify visually).
- Audit log entry per export.

---

## 9. How to ship a PR in this area

1. Pick a project from section 8 (or get one assigned).
2. Read every linked file end-to-end before writing code.
3. Branch: `intern/<your-name>/<short-title>`.
4. Write tests first when behavior is testable (queue jobs, controllers).
5. Run locally, check the dev server's UI flow, capture a Loom video.
6. PR description must include:
   - Link to the project section in this doc.
   - Loom video.
   - "Definition of done" checklist with each item ticked.
   - Anything you changed in this doc itself.
7. Tag the streaming-track lead. Expect ≤ 24h review.

---

## 10. Reading list (do this before week 2)

Skim these to understand the why behind our choices.

- **MediaMTX docs:** https://github.com/bluenviron/mediamtx — read "Configuration" + "REST API" + "HLS" sections.
- **HLS spec primer:** https://datatracker.ietf.org/doc/html/rfc8216 (don't read it all; the §4 playlist examples are gold).
- **WebRTC for the curious:** https://webrtcforthecurious.com — chapter 1-3 is enough.
- **HLS.js docs:** https://github.com/video-dev/hls.js/blob/master/docs/API.md — config reference.
- **FFmpeg concat demuxer:** https://trac.ffmpeg.org/wiki/Concatenate — we use this for stitching.
- **BullMQ guide:** https://docs.bullmq.io — repeatable jobs are how we run sync + watchdog.

---

## 11. Glossary changes & doc updates

This doc is the source of truth for the streaming pipeline. If you change
behavior in code, **update this doc in the same PR**. Sections most likely
to drift:

- §3.1 (MediaMTX path config) — when you tune segment duration, retries, etc.
- §4.5 (S3 sync flow) — when stitcher params change.
- §5 (Configuration reference) — when you add/remove env vars.
- §8 (projects) — mark projects "done" or split them when scope changes.

If something in §1-7 is wrong, it's a bug. File it.

---

*Last updated: 2026-05-02. Maintainer: streaming track lead.*
