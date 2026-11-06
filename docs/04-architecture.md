# 04 — Architecture Deep-Dive: Streaming & Recording

> How video actually gets from a camera to a screen, and from a camera to storage.
> Companion docs: [12-streaming-recording-architecture.md](./12-streaming-recording-architecture.md),
> [STREAMING_SERVICE_DESIGN.md](./STREAMING_SERVICE_DESIGN.md), [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md).

---

## 1. The two planes

```
CONTROL PLANE                          MEDIA PLANE
(state + config)                       (actual video)

MySQL  ──►  Backend  ──REST──►  Stream Service  ◄──RTSP──  Cameras
                                      │
                                      ├──WHEP/HLS──►  Browser / Mobile
                                      ├──RTSP──────►  AI service
                                      └──MP4───────►  Disk ──►  S3
```

**Video never passes through the Node backend.** The backend only tells the Stream Service
what paths to create; clients pull media directly. This is why one backend can serve thousands
of cameras — it moves configuration, not frames.

---

## 2. Drishyam Stream Service (MediaMTX)

A thin rebrand of MediaMTX (`stream-service/Dockerfile`), configured by `stream-service.yml`.
No code fork.

| Function | Port | Notes |
|---|---|---|
| RTSP ingest | 8554 | TCP transport forced (`rtspTransports: [tcp]`) |
| RTSPS ingest | 8555 | Cloud only — for edge-relay push (TLS) |
| HLS egress | 8888 (external **8898**) | LL-HLS, fMP4 |
| WebRTC / WHEP | 8889 | Primary live path |
| Control API | 9997 | **Loopback only** — backend uses Basic Auth |
| Metrics | 9998 | Prometheus |

**Path naming:**

| Path | Contents |
|---|---|
| `cam_<monitorId>` | Main stream |
| `cam_<monitorId>_sub` | Sub-stream (grids, AI, recording) |
| `cam_<monitorId>_h264` | Transcoded from H.265 (backend sidecar) |
| `cam_<monitorId>_clean` | GPU-normalized (standalone transcoder) |
| `pb_<monitorId>_<startMs>` | Short-lived NVR playback session |

**Tuning that matters:** `hlsSegmentDuration: 2s`, `hlsPartDuration: 1s` with **part == GOP**,
so every part starts on a keyframe → fast channel-zap and clean resync.
`sourceOnDemandCloseAfter: 20s` keeps the RTSP pull briefly alive after the last viewer, so
quick re-opens don't re-hammer the NVR.

---

## 3. Live path — how a camera reaches the browser

```
Camera/NVR ──RTSP(TCP)──► Stream Service ──WHEP(WebRTC)──► Browser   (~0.3–0.5s)
                                        └─HLS(fMP4)─────► Browser   (~2s, fallback)
```

1. User opens a camera → backend `stream.service.startStream` ensures the path exists and
   issues a **signed media cookie**.
2. Player requests WHEP; the on-demand RTSP pull starts.
3. `WebRTCPlayer.jsx` negotiates; if `RTCPeerConnection` is unavailable or negotiation fails,
   `HLSPlayer.jsx` takes over.
4. nginx validates the cookie via `auth_request` → `/api/stream/verify` before serving media.

> **WHEP *is* WebRTC.** WHEP is just the HTTP signaling that starts the session — the video
> still flows over WebRTC. It is not a lesser protocol.

**Grid vs single view:** grids use `_sub` (low bitrate, negligible CPU, light on the NVR);
single view uses main. Per-camera `streamQuality` is `auto | main | sub`, and an ABR HLS master
playlist lists the sub variant only when the Stream Service reports it `ready`.

**H.265 handling:** browsers can't decode HEVC via MSE. Two transcoders exist — an on-demand
backend sidecar (`transcoder.service.js`, NVENC→QSV→AMF→x264, idle shutdown, cap 8 concurrent)
producing `_h264`, and a GPU normalizer (`smart-cam-transcoder`, NVDEC→NVENC) producing `_clean`.

---

## 4. Self-healing lifecycle

The Stream Service holds config **in memory only** — it is lost on restart. Four loops
continuously re-converge it to the database.

| Service | Interval | Job |
|---|---|---|
| `recordingSync.service.js` (watchdog) | 2 min | Re-add missing paths, delete orphans (2-pass confirm), probe HLS muxer health and cycle corrupted ones, sync online/offline |
| `streamSupervisor.service.js` | 2 s | Poll `/v3/paths/list`, compute per-camera bitrate, drive the state machine, persist health |
| `streamReconcile.service.js` | 60 s | Fix retention drift (`recordDeleteAfter`) |
| `streamQuality.service.js` | per tick | Jitter / error-rate telemetry, active `heal()` (path re-bind) |
| `cameraReachability.service.js` | 25 s | One TCP probe **per NVR host** (not per camera) |

### Camera state machine

```
PENDING → CONNECTING → STREAMING
                    ↘ DEGRADED
   STANDBY (reachable, nobody watching)   → shown as ONLINE
   OFFLINE (host unreachable)
   QUARANTINED (5 flaps / 120s → 5 min backoff)
```

**STANDBY is the important one.** An on-demand camera nobody is watching is *not* offline —
the reachability probe proves the NVR answers, so it displays as online without pulling video.

### Protections against overwhelming an NVR

- On-demand pulls (idle cameras pull nothing)
- Sub-stream grids
- `NVR_RESET_MIN_MS` — serializes watchdog path cycles per NVR
- `NVR_RECONNECT_MIN_MS` — rate-limits heals per NVR
- Per-camera heal cooldown + 24h heal budget
- Quarantine on flapping
- Mobile: focus-gated tiles (`WALL_LIVE_TILES = 8`)

> **Known gap:** nothing caps the *total simultaneous* source pulls to one NVR. The limits
> above throttle re-open *frequency*, not concurrency. Weak NVRs can still jam if many
> cameras are opened at once.

---

## 5. Recording

**Recording runs on the sub-stream by default.** Full-resolution continuous recording
saturated remote uplinks and knocked cameras offline; the sub-stream is a fraction of the
bitrate and survives real-world links. Set `RECORD_CONTINUOUS=1` to record main.

```
Stream Service ──► segmented MP4 (10 min) ──► bind-mounted volume
                                                │
                    recordingSync (every 5 min) │
                                                ▼
                     ffprobe → stitch fragments → upload S3 → delete local
```

**Why stitching exists:** an RTSP reconnect leaves short fragment files. The sync loop
concatenates segments with gaps ≤ 5s into batches ≤ 15 min (`ffmpeg -f concat -c:v copy`) so
playback isn't a pile of 4-second clips.

**Safety rules:** files younger than 2 minutes or smaller than 10 KB are skipped (still being
written); uploads are idempotent (`s3Service.exists()` + a 50k FIFO cache).

**S3 key layout:** `recordings/<userId>/<group>/<camera>/<date>/<HH-MM-SS_to_HH-MM-SS_Nm>.mp4`

### Retention

Effective retention resolves **Camera → Group → Site → env default (30 days)** and is applied
as the Stream Service's native `recordDeleteAfter` (days converted to hours — Go durations have
no `d` unit). `streamReconcile` is the drift backstop; `s3Retention.service.js` enforces the
durable S3 copy separately.

---

## 6. Playback

| Type | Source | How |
|---|---|---|
| **Drishyam recordings** | S3 | HLS from object storage — the normal path |
| **NVR playback** | The NVR's own disks | RTSP replay (Hikvision `/Streaming/tracks`, Dahua `/cam/playback`) → backend ffmpeg → short-lived `pb_*` path → HLS/WHEP |

NVR playback is capped at a 6-hour range and hard-killed after 30 minutes to respect NVR load.
Hikvision / Dahua / CP Plus only.

> The NVR is treated as **read-only**: Drishyam pulls from it and never writes to or manages
> its storage. See [cctv-cameras/NVR-INTERFACE.md](./cctv-cameras/NVR-INTERFACE.md).

---

## 7. The vendor driver registry

`smart-cam-backend/src/services/vendors/index.js` is the single source of truth for
per-brand behaviour — it replaced six drifting switch statements.

| Vendor | Main path | Sub |
|---|---|---|
| Hikvision | `/Streaming/Channels/{ch*100+1}` | `…+2` |
| Dahua / CP Plus | `/cam/realmonitor?channel={ch}&subtype=0` | `subtype=1` |
| Uniview | `/unicast/c{ch}/s0/live` | `s1` |
| Axis | `/axis-media/media.amp?camera={ch}` | — |
| Bosch | `/rtsp_tunnel?inst=1&line={ch}` | `inst=2` |
| Hanwha | `/profile{N}/media.smp` | `profile{N+1}` |

`deriveSubPath()` also infers a sub-stream from an already-stored main path.
An unknown vendor raises `UnsupportedVendorError` (422) — **never a silent fallback**, because
a wrong guessed path produces a camera that looks configured but never streams.

---

## 8. Scaling out

- **Multi-instance pool:** `mediamtx_servers` holds each Stream Service instance;
  `streamRouter.service.js` picks a site-bound server with the most headroom, falling back to
  the global default, and returns 503 when the pool is full.
- **SFU egress:** `smart-cam-sfu-bridge` pushes a camera once into LiveKit (WHIP, `-c copy`)
  so many viewers share one upstream pull instead of one each.
- **DeepStream ingest:** optional GPU path for high camera density.

---

## 9. Where things break (and the fix)

| Symptom | Usual cause | Fix |
|---|---|---|
| Camera "offline" but NVR is fine | On-demand path never pulled + reachability probe failing | Check NVR reachability on the RTSP port |
| All cameras on one NVR drop together | NVR jammed by too many concurrent pulls | Reduce simultaneous viewing; reboot NVR to clear; see §4 |
| Black video, path `ready` | Corrupted HLS muxer after RTSP reconnect | Watchdog cycles it automatically (needs a reader + past cold-start) |
| Camera flaps online/offline | Unstable link | Supervisor quarantines it for 5 min — investigate the network, don't fight the backoff |
| Video won't play in Chrome | Source is H.265 | Transcoder produces the `_h264` variant |
| Recordings missing | Sub-stream not recording, or sync not uploading | Check `record` on `_sub` path and the sync loop's logs |
| Config lost after restart | Expected — Stream Service is stateless | Watchdog re-adds within 2 min |
