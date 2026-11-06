# Drisyam VMS — Streaming Pipeline Architecture

> Target: 2,000 concurrent cameras on a campus deployment, with a clear path to
> tens of thousands across multi-site federations.

This document is the contract for how camera streams flow from the edge (IPC /
NVR / DVR) all the way to a browser tile or an AI worker. It also covers the
supervisor that keeps the pipeline alive, the observability stack, and the
runbook for the on-call rotation.

---

## 1. Data planes

```
                                                ┌─────────────────────┐
                                                │  Browser (operator) │
                                                │  React + HLS.js +   │
                                                │  WebRTC WHEP        │
                                                └──────────▲──────────┘
                                                           │ /live/  /hls/
                                                           │ /api/   /socket.io/
                                                  ┌────────┴─────────┐
                                                  │   NGINX (edge)   │
                                                  │  rate-limit +    │
                                                  │  TLS termination │
                                                  └────────┬─────────┘
                                                           │
              ┌────────────────────────────────────────────┼───────────────────────────────────────────┐
              │                                            │                                           │
        ┌─────▼──────┐                              ┌──────▼──────┐                            ┌──────▼──────┐
        │  Express   │  REST + WebSocket            │  MediaMTX   │  RTSP→WebRTC/HLS           │  smart-cam  │
        │  backend   │  control plane               │   pool      │  data plane (×N)           │  -ai (FastAPI)│
        │  :5000     │                              │ :8554/89/88 │                            │  :8001      │
        │            │  ─── /v3/config/paths ───────►             │                            │             │
        │            │  ─── /v3/paths/list ──────── │             │                            │             │
        │            │                              │             │ ── RTSP egress (cam_*) ─►  │             │
        └─────┬──────┘                              └──────┬──────┘                            └──────┬──────┘
              │                                            │                                           │
              │                                            ▼                                           │
              │                                    ┌─────────────┐                                    │
              │                                    │ recordings/ │  10-min MP4 segments               │
              │                                    │ (bind mnt)  │                                    │
              │                                    └──────┬──────┘                                    │
              │                                            │                                           │
              │                                            ▼                                           │
              │                                    ┌─────────────┐                                    │
              │                                    │   S3 (10PB) │                                    │
              │                                    └─────────────┘                                    │
              │                                                                                       │
              │  In-process EventEmitter ── streamBus ──► Redis Streams ──► AI / WS / dashboards     │
              │  BullMQ jobs (S3 sync, watchdog, alerts, snapshots) ◄────────────────────────────────┤
              │                                                                                       │
              ▼                                                                                       ▼
        ┌─────────────┐                                                                       ┌─────────────┐
        │  MySQL 8.4  │ control state (cameras, groups, MediaMTXServer pool, supervisor cols) │  Postgres   │
        └─────────────┘                                                                       │ + Qdrant    │ vector
                                                                                              └─────────────┘
```

### Why MediaMTX is the canonical data plane

Single binary, RTSP/WebRTC/HLS/MP4 record support, REST control. We pool it
horizontally (`mediamtx_servers` table), assign cameras with capacity-aware
routing (`services/mediamtxRouter.service.js`), and keep the Shinobi-era code
only as a legacy migration target — it is no longer in the live data plane.

### Two egress paths, one ingress

| Egress     | Latency | When                                 |
|------------|---------|--------------------------------------|
| WebRTC WHEP| < 500ms | single-camera live view              |
| HLS        | ~ 2s    | multi-grid, mobile, archival fallback|
| RTSP       | < 500ms | internal-only (AI workers, sidecars) |

Sub-streams (`cam_<id>_sub`, `sourceOnDemand: true`) carry the camera/NVR's
secondary low-bitrate track for grid tiles. When a sub-stream isn't available
and the user requests `quality=low`, the transcoder sidecar produces a
`cam_<id>_low` H.264 path on demand — capped via `GRID_LOW_TRANSCODE_MAX`.

H.265 sources are auto-detected and transcoded to H.264 on egress
(`cam_<id>_h264`) because Chrome cannot play H.265 over HLS/MSE. Browsers
always receive a H.264 stream regardless of source codec.

---

## 2. Control plane — the StreamSupervisor

`services/streamSupervisor.service.js` is the heartbeat of the pipeline. It is
a real-time data-plane health monitor distinct from:

- **mediamtxRouter** — the *control* plane (add/remove paths)
- **recordingSync.runWatchdog** — *config reconciliation* (re-add paths
  MediaMTX dropped after a restart)

### State machine

```
PENDING ─► CONNECTING ─► STREAMING ─┬─► DEGRADED ──► OFFLINE
                                    │
                                    └─ flaps≥5 in 2m ─► QUARANTINED (5 min)
```

Transitions are observed once every `SUPERVISOR_POLL_MS` (default 2 s) by
calling `/v3/paths/list` on every online MediaMTX server. We compute
per-camera ingress bps from successive `bytesReceived` deltas — this is the
ground truth of "camera is actually sending video right now".

### Tunables

| env var                              | default | meaning                                       |
|--------------------------------------|--------:|-----------------------------------------------|
| `SUPERVISOR_POLL_MS`                 | 2000    | How often to poll every MediaMTX             |
| `SUPERVISOR_MIN_BPS`                 | 20000   | Below this and a path is *not* streaming     |
| `SUPERVISOR_DEGRADED_AFTER_MS`       | 8000    | ready=true but starved → DEGRADED            |
| `SUPERVISOR_OFFLINE_AFTER_MS`        | 15000   | not-ready for this long → OFFLINE            |
| `SUPERVISOR_FLAP_LIMIT`              | 5       | streaming↔non-streaming cycles allowed       |
| `SUPERVISOR_FLAP_WINDOW_MS`          | 120000  | rolling window for the above                 |
| `SUPERVISOR_QUARANTINE_MS`           | 300000  | how long to back off after flap-out          |
| `SUPERVISOR_LEADER_TTL_MS`           | 15000   | Redis lock TTL for leader election           |

### Leader election

Only ONE backend instance does supervisor work in any deployment. We use a
Redis SET-NX lock (`drisyam:supervisor:leader`, 15s TTL) refreshed on every
tick. If you scale the backend to N replicas, exactly one will own the loop;
others sit idle and consume zero MediaMTX resources.

### What it persists (per transition)

| column                | type   | written when                                 |
|-----------------------|--------|----------------------------------------------|
| `cameras.status`      | enum   | always (kept compatible with legacy code)   |
| `cameras.supervisor_state` | enum | always — full state machine value         |
| `cameras.bps_in`      | int    | always                                       |
| `cameras.last_seen_at`| date   | when transitioning *into* online            |
| `cameras.last_offline_at`| date | online→offline only                         |
| `cameras.flap_count_24h` | int | streaming → non-streaming transitions       |

Writes only happen on transitions, NOT on every tick — so 2k cameras with low
churn cost <50 row updates per tick.

---

## 2b. Stream quality, packet recovery, and active healing

The supervisor decides "is this camera up?" — `streamQuality.service.js`
decides "is the data we're getting actually good?" and "should we reach in
and fix it?" It piggybacks on the supervisor's MediaMTX poll, so there's no
extra polling traffic to MediaMTX.

### What it measures

| metric                                   | derivation                                                  | what it means                                  |
|------------------------------------------|-------------------------------------------------------------|------------------------------------------------|
| `drisyam_camera_jitter_ms`               | stddev of bps samples / mean × 1000 (rolling 60 s)         | inter-frame arrival jitter proxy. > 200 ms = noticeable bumpiness. |
| `drisyam_camera_frames_in_error_per_second` | rate of MediaMTX `inboundFramesInError`                  | corrupt/out-of-order RTP from the camera. > 5/s warn, > 50/s heal. |
| `drisyam_camera_readers`                 | length of MediaMTX `readers` array                          | active WebRTC + HLS clients. Used to decide if heal is safe.       |

### Active healing

`streamQuality.heal()` issues `PATCH /v3/config/paths/patch/cam_<id>` with
the existing config. MediaMTX treats this as "rebind your source" — it drops
the upstream RTSP and reconnects, sending a PLI to the camera so the next
frame is an IDR. Cheaper than DELETE+ADD; doesn't touch the recording stream
beyond a brief gap.

Heal triggers (any one is sufficient):

- **Stuck CONNECTING > 30 s** — usually the camera-side ONVIF answered
  DESCRIBE but the SETUP/PLAY hung. PATCH gets us a clean RTSP session.
- **Frames-in-error rate ≥ 50/s sustained** — corrupt RTP. Reconnecting
  resyncs SPS/PPS most of the time.

Heal is *not* triggered for high jitter — that's a network problem and
tearing down a session that's still delivering frames just makes it worse.
We log + alert via the metric instead.

### Heal storm protection

Every camera has a 60 s cooldown and a 24h budget of 20 heal attempts.
Beyond the budget the camera is marked as needing operator attention via
`drisyam_stream_heals_refused_total{reason="budget-exhausted"}`.

### Operator endpoints

| route                                              | purpose                                       |
|----------------------------------------------------|-----------------------------------------------|
| `POST /api/cameras/:monitorId/heal`                | force-reconnect (manual)                     |
| `POST /api/cameras/:monitorId/keyframe`            | trigger PLI by way of path PATCH             |
| `GET /api/cameras/:monitorId/quality`              | current jitter / FIE rate / heal log         |

### Keyframe acceleration (camera-side)

Time-to-first-frame on viewer pop-in is dominated by GOP length on the
camera. Default GOP is 50–100 frames (≈ 2–4 s) on most NVR firmwares. We
push it down to 1 s via:

```
POST /api/groups/:groupId/cameras/:monitorId/keyframe-interval
Body: { gopSec: 1, fps: 25 }
```

Vendor backends:

| device_type | API call                                                      |
|-------------|---------------------------------------------------------------|
| hikvision   | `PUT /ISAPI/Streaming/channels/<id>` with mutated `<GovLength>` |
| dahua       | `setConfig&Encode[ch].MainFormat[0].Video.GOPLength=<N>`     |
| onvif       | `SetVideoEncoderConfiguration` with mutated `<GovLength>`    |

Cost is ~10–15 % extra bitrate; for surveillance that's a fair trade for
sub-1 s pop-in.

### Adaptive playback (browser-side)

`useAdaptivePlayback` (frontend hook, `smart-cam-app/src/hooks`) watches the
real `<video>` element + HLS.js error stream and switches between three
profiles:

| profile | maxBufferLength | liveSyncDurationCount | playoutDelayHint |
|---------|----------------:|----------------------:|-----------------:|
| smooth  | 4 s             | 1 part                | 0.1 s            |
| bumpy   | 8 s             | 2 parts               | 0.3 s            |
| choppy  | 16 s            | 3 parts               | 0.5 s            |

Promotion fires on the first stall (frame freezes are highly visible).
Demotion only happens after 60 s of uninterrupted playback. This asymmetry
biases towards smoothness for the minute after a stall — common pattern when
an NVR's bursty fragment timing is the underlying issue.

WebRTC receivers get `playoutDelayHint` adjusted in real time; HLS.js gets
`config.maxBufferLength` and `config.liveSyncDurationCount` flipped on the
running instance (no teardown).

### What the browser jitter buffer / NACK gives us for free

| feature          | who handles it          | how to verify                    |
|------------------|-------------------------|----------------------------------|
| Jitter buffer    | MediaMTX (Pion) + browser | stable WebRTC playback under simulated 50 ms latency w/ 20 ms jitter |
| NACK             | MediaMTX (Pion) + browser | UDP packet drop test still plays smoothly |
| FEC              | **not implemented**     | requires forking MediaMTX or replacing SFU |
| Packet reordering| MediaMTX                | RTP seq# discontinuity counters in `/v3/paths/get` |

FEC is the one we *don't* have. For LAN deployments it's overkill; for
WAN-bridged sites it's a real gap and we'd add it via mediasoup or LiveKit
in front of MediaMTX. Track this if a site ever asks.

---

## 3. Eventing — two buses, one mental model

### In-process (`events/bus.js`)

Synchronous EventEmitter for same-instance fan-out. Used by:
- WS service — push camera lifecycle to connected browsers
- aiEvents.service — local cache invalidation

### Cross-process (`services/streamBus.service.js`)

Redis Streams (durable, MAXLEN-trimmed) with consumer groups. Streams:

| stream                          | events                              |
|---------------------------------|-------------------------------------|
| `drisyam:events:camera`         | CAMERA_*, STREAM_READY, STREAM_OFFLINE |
| `drisyam:events:ai`             | AI_EVENT_DETECTED, AI_ALERT_TRIGGERED |
| `drisyam:events:recording`      | RECORDING_SYNCED                    |

Consumers in any language can XREADGROUP from these. The bridge auto-mirrors
every in-process event to its corresponding stream — producers don't have to
care.

---

## 4. Observability

Spin up the optional overlay:

```powershell
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

This adds Prometheus, Grafana (pre-provisioned with a Drisyam Fleet
dashboard), cAdvisor, node-exporter, and exporters for Redis/MySQL/Postgres.
MediaMTX exposes its own `/metrics` on port 9998 (configured in
`mediamtx.yml`).

### The metrics that matter for on-call

| metric                                         | meaning / use                          |
|------------------------------------------------|----------------------------------------|
| `drisyam_camera_state{state="streaming"}`      | Healthy fleet count                   |
| `drisyam_camera_state{state="offline"}`        | Outage size                           |
| `drisyam_camera_state{state="quarantined"}`    | Flapping cameras (NVR / network issue)|
| `drisyam_camera_bps_in`                         | Per-camera bitrate (top/bottom-K)     |
| `drisyam_camera_transitions_total{to=...}`      | Churn rate                            |
| `drisyam_supervisor_is_leader`                  | Should sum to 1 across all replicas   |
| `drisyam_mediamtx_capacity_ratio`               | Per-server fill — alert at 0.9        |
| `drisyam_nodejs_eventloop_lag_seconds`          | Backend health (alert > 0.2 s)        |
| `drisyam_http_requests_total{status=~"5.."}`    | Drives the 5xx-rate alert             |

Pre-shipped alert rules live in `observability/prometheus/alerts.yml`.

---

## 5. Auth + transport edge

NGINX (`nginx.conf`) is the only thing exposed to the public internet. It:

- terminates TLS (uncomment the 443 server block in production)
- rate-limits `/api/` (60 r/s per IP, burst 120) and `/api/auth/*` (5 r/s)
- WebSocket-aware proxying for `/socket.io/` and `/live/` (WebRTC)
- caches HLS segments for 10s; never caches `.m3u8` playlists
- restricts `/api/metrics` and `/api/health/full` to internal CIDRs

Worker tuning is sized for 2k WebRTC connections + 4k HLS readers:
`worker_connections 65536` + `worker_rlimit_nofile 100000` + `keepalive 256`
upstream.

---

## 6. Camera onboarding — the ergonomic bits

### Auto-discover the names already on the device

When configuring a group, the user does NOT need to retype names that are
already configured on the NVR / IPC. Three new endpoints
(`controllers/deviceProbe.controller.js`):

| route                                  | purpose                                  |
|----------------------------------------|------------------------------------------|
| `POST /api/groups/probe`               | preview before saving (frontend button) |
| `POST /api/groups/:groupId/probe`      | re-probe an existing group (read-only)  |
| `POST /api/groups/:groupId/sync-names` | overwrite *auto-named* cameras only     |

Vendor coverage:

| device_type | how                                                                |
|-------------|--------------------------------------------------------------------|
| `hikvision` | ISAPI: `/ISAPI/System/Video/inputs/channels` (digest auth)         |
| `dahua`     | CGI: `/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle`|
| `axis`      | param.cgi for HostName + Image.I0.Name                             |
| `generic`   | ONVIF SOAP `GetProfiles` (UsernameToken digest)                    |

`sync-names` only overwrites cameras whose current name matches the
auto-generated pattern (`<group> - Camera NN` or `Camera N`). Manually-edited
names are preserved.

---

## 7. Capacity planning (rule of thumb at 2k cameras)

| component        | sizing baseline                               | scale to 2k                |
|------------------|-----------------------------------------------|----------------------------|
| MediaMTX         | ~200 cams/instance (CPU/disk-bound on record) | 10 servers @ 200 each      |
| smart-cam-backend| 1 vCPU / 200 cams (REST + supervisor)         | 4 vCPU + 1 supervisor      |
| smart-cam-ai     | 1 GPU per ~80–100 cams @ 10 fps detection     | 20–25 RTX-class GPUs       |
| Redis            | 100 MB working set                            | 1 GB headroom              |
| MySQL            | 50 GB / 5 yrs metadata                        | 200 GB headroom            |
| Recording disk   | 1.2 GB / cam / day @ 4 Mbps H.264             | 2.4 TB / day               |
| S3 retention     | tier to Glacier after 30 d                    | 90 d hot ≈ 220 TB hot      |

Adjust before deployment based on real bitrate sampling — the
`drisyam_camera_bps_in` Prometheus gauge tells you exactly what your fleet
costs in real time.

---

## 8. Runbook

### "Half my cameras went offline"

1. Open Grafana → **Drisyam VMS — Fleet Health** → "Cameras offline" stat.
2. Check `drisyam_mediamtx_server_online` — is one MediaMTX missing?
3. Check `drisyam_supervisor_is_leader` — should sum to 1.
4. If MediaMTX is up: run the full-health probe
   `curl http://<edge>/api/health/full | jq` and inspect each component.
5. If a cluster of cameras share a switch / NVR, ssh into the device and
   verify it isn't rebooting / over-temperature.

### "WebRTC plays for 5 seconds and stops"

1. Browser DevTools → Network → look for ICE candidate failures.
2. NGINX `proxy_buffering off` is set on `/live/` — verify it didn't get
   flipped during a config edit.
3. MediaMTX `webrtcAdditionalHosts` includes the public hostname.
4. If all clients fail simultaneously, the symptom is usually a NAT rebind on
   the upstream firewall. Restart MediaMTX as a last resort; the supervisor
   re-marks cameras offline and the watchdog re-adds paths within ~15 s.

### "I added a camera and the path didn't appear"

1. `mediamtxRouter.pickServerForSite` returns 503 → no online server with
   capacity. Either provision a new MediaMTX or raise `capacity_cams` on an
   existing one.
2. Otherwise check the backend log line `mediamtxRouter: addCamera failed`.

### "AI worker isn't getting events"

1. AI worker is a stream consumer — verify Redis is up.
2. `XLEN drisyam:events:camera` to see the stream depth.
3. `XINFO GROUPS drisyam:events:camera` to see consumer offsets.
4. If a consumer's pending list is huge, restart the worker — it'll resume
   from the last delivered ID.

### Adding a new MediaMTX server

```bash
# 1. Bring up the new container (any host with network reach to cameras)
# 2. Insert into the pool
INSERT INTO mediamtx_servers (id, name, hostname, api_url, hls_url, webrtc_url,
       rtsp_internal_host, capacity_cams, status, current_cams, created_at, updated_at)
VALUES (UUID(), 'mtx-2', 'mtx-2.local',
        'http://mtx-2.local:9997', 'http://mtx-2.local:8888',
        'http://mtx-2.local:8889', 'mtx-2.local',
        200, 'online', 0, NOW(), NOW());
# 3. Add scrape target in observability/prometheus/prometheus.yml under the
#    `mediamtx` job, then `curl -X POST http://prometheus:9090/-/reload`.
```

The router immediately balances new cameras to the new server because of the
`current_cams ASC` ordering.

### Migrating cameras off a draining MediaMTX

```sql
UPDATE mediamtx_servers SET status = 'draining' WHERE name = 'mtx-1';
```

Existing paths keep working; the router refuses to assign new cameras.
Flip cameras to a healthy server with `mediamtxService.removeCamera` +
`mediamtxRouter.addCamera(cam, config, healthyServer)`.

---

## 9. What's still on the table

Things that are designed-for but not yet built:

- **Multi-region federation.** Cross-region Qdrant + S3 replication for
  disaster recovery. Site-bound MediaMTX pools already exist; what's missing
  is a global stream registry that lets you search across sites without
  joining MySQL queries from the operator's browser.
- **GPU-aware AI dispatcher.** Current AI worker assignment is static. A
  dispatcher that consumes `drisyam_camera_state` + GPU load and reassigns
  cameras between AI workers will let us push GPU utilization to ~85% safely.
- **DPDP audit trail.** Every camera-name change, every recording playback URL
  generation, every face match should write to `admin_audit_log` with the
  user identity. Schema exists (migration 014); writers need to be retrofitted
  into the relevant controllers.
- **Replay buffer / scrubbing.** MediaMTX records to disk; the player today
  needs to fall back to S3-signed playback. A short (30 min) on-disk replay
  buffer served via HLS would make scrubbing back from "live" instant.

Track these in the project board, not in this doc.
