# Streaming Subsystem — Developer Guide

This document covers how video gets from an IP camera or NVR to a browser tile, to disk, and to
the AI workers: the media server configuration, the Node control plane that drives it, the four
reconciliation loops that keep the two in sync, the vendor driver registry, the delivery paths
(WHEP / HLS / ABR / H.265 transcode), recording + retention, and NVR playback. It is written for
engineers who need to **change** this subsystem — every claim below is traceable to a file in the
repo, and where the code is confusing or wrong, it says so.

Everything here is derived from reading: `stream-service.yml`,
`smart-cam-backend/src/services/streaming/*`, `streamRouter.service.js`, `streamSupervisor.service.js`,
`streamQuality.service.js`, `streamReconcile.service.js`, `cameraReachability.service.js`,
`recordingSync.service.js`, `recordingRetention.service.js`, `transcoder.service.js`,
`stream.service.js`, `services/vendors/index.js`, `controllers/playback.controller.js`,
`controllers/stream.controller.js`, `controllers/cameraHealth.controller.js`, `nginx.conf`,
`docker-compose.drisyam-original.yml`, and the frontend players under `smart-cam-app/src/core/`.

---

## 1. Mental model

Three ideas. If you hold these, everything else in this document is derivable.

### 1.1 The media server is stateless; the database is authoritative; loops re-converge them

The media server (branded **Drishyam Stream Service**, a thin wrapper over upstream MediaMTX — see
`stream-service/Dockerfile`) keeps its entire path configuration **in memory**. Restart the
container and every `cam_*` path is gone. It has no database, and we deliberately never gave it one.

The truth about which cameras exist, what their RTSP URLs are, and how long their recordings live is
the MySQL `cameras` / `camera_groups` / `sites` tables. Node's job is not to "configure the media
server once" — it is to **continuously push the DB's intent into a server that may have forgotten
everything five seconds ago**. That is why the codebase is full of loops instead of one-shot setup
calls, and why almost every write is idempotent (`POST /v3/config/paths/add/<name>`, and on 400/409
fall back to `PATCH .../patch/<name>` — see `StreamServiceEngine._putPath`).

Corollary that trips people up: **editing a path config in the media server by hand is pointless.**
A watchdog or reconcile pass will overwrite or delete it. Change the DB, or change the code that
derives config from the DB.

### 1.2 Video never passes through Node

There are two planes and they share nothing but path names.

```mermaid
flowchart LR
  subgraph Edge
    CAM[IP camera / NVR<br/>RTSP server]
  end
  subgraph Media["Drishyam Stream Service (stateless)"]
    P["path cam_&lt;id&gt;<br/>path cam_&lt;id&gt;_sub"]
  end
  subgraph Node["smart-cam-backend (Node)"]
    CTRL[REST control :9997<br/>add / patch / delete / list]
    LOOPS[supervisor · watchdog<br/>reconcile · prober]
  end
  BROWSER[Browser<br/>WHEP / HLS]
  AI[AI workers<br/>RTSP readers]
  DISK[(recordings volume)]

  CAM -- "RTSP pull (TCP)" --> P
  P -- "WebRTC :8889 / HLS :8888" --> BROWSER
  P -- "RTSP :8554" --> AI
  P -- "segmented MP4" --> DISK
  Node <-. "JSON only" .-> CTRL
  CTRL <--> P
  LOOPS -.reads.-> P
  DISK -. "read + upload" .-> Node
```

Node issues JSON control calls and reads counters. It never proxies a frame. The two exceptions
prove the rule and are both **ffmpeg subprocesses spawned by Node**, not Node itself moving bytes:
the H.265→H.264 transcoder (`transcoder.service.js`) and NVR playback
(`playback.controller.js`). Both *publish* into the media server over RTSP and then get out of the
way. The third exception is recording upload — Node reads finished `.mp4` files off a shared volume
and streams them to S3 (`recordingSync.service.js`), which is file I/O, not live video.

Practical consequence: **you cannot fix a black tile by restarting Node**, and Node CPU/memory is
not a function of concurrent viewers. If frames are wrong, the problem is in the media server, the
network, or the camera.

### 1.3 A pull starts when a READER connects, not when a path is registered

Every camera path is created with `sourceOnDemand: true` (`StreamServiceEngine.addCamera`). The
media server does **not** dial the camera when you add the path. It dials when someone asks to read
the path — a browser opening WHEP, a browser fetching `index.m3u8`, an AI worker opening
`rtsp://stream-service:8554/cam_<id>`, or an ffmpeg transcoder.

This is the single most important operational fact in the subsystem, because it makes "online" and
"streaming" different things. A perfectly healthy camera that nobody is watching reports
`ready: false` and `bytesReceived` frozen — indistinguishable, from the media server's point of
view, from a camera whose NVR is on fire. The `STANDBY` state and the per-NVR reachability prober
(§4.3) exist entirely to tell those two apart.

Why on-demand at all? Because entry-level NVRs have a hard cap on concurrent RTSP sessions. The
comment block in `docker-compose.drisyam-original.yml` around `RECORD_SUB` documents the incident:
18 cameras behind one NVR, each holding a permanent session, jammed the NVR's session table until
`:554` stopped answering entirely and *all 18* went offline. On-demand keeps concurrency
proportional to how many cameras humans are actually looking at.

---

## 2. Where the code lives

| File | Responsibility |
|---|---|
| `stream-service.yml` | Media server runtime config: ports, RTSP transport, HLS tuning, path defaults. Bind-mounted to `/mediamtx.yml`. |
| `src/services/streaming/StreamingEngine.js` | Abstract contract every engine must satisfy (naming, CRUD, reads, URL builders) + the behavioural contract (what throws, what returns `null`). |
| `src/services/streaming/StreamServiceEngine.js` | The one real implementation. All `/v3/...` REST calls, retry policy, pagination, path naming, URL building. |
| `src/services/streaming/index.js` | Engine factory keyed by `STREAMING_ENGINE` (default `mediamtx`). |
| `src/services/drishyamStreaming.service.js` | The singleton every other module imports. `streamService.shim.js` is a deprecated re-export. |
| `src/services/stream.service.js` | Per-request orchestration for "start this stream": ensure paths, warm HLS muxers, pick sub vs main, spawn transcoders, build the ABR master playlist. |
| `src/services/streamRouter.service.js` | Pool-aware variant (multiple media servers, `mediamtx_servers` table): server selection, capacity counters, `patchPath`. |
| `src/services/streamSupervisor.service.js` | Data-plane health: 2 s poll, per-camera state machine, DB writes + events + Prometheus. |
| `src/services/streamQuality.service.js` | Per-camera telemetry (jitter, frames-in-error, readers) + active healing with cooldown/budget/per-NVR limits. |
| `src/services/cameraReachability.service.js` | Per-host TCP prober. The only signal that distinguishes idle from dead. |
| `src/services/recordingSync.service.js` | Two loops: S3 upload of finished segments (5 min) and the path watchdog (2 min). |
| `src/services/streamReconcile.service.js` | DB → media server retention drift correction (60 s) + server-load recompute. |
| `src/services/recordingRetention.service.js` | Camera → Group → Site → default retention resolution and `recordDeleteAfter` application. |
| `src/services/s3Retention.service.js` | Enforces the same retention on the durable object-storage copy. Off by default, dry-run by default. |
| `src/services/transcoder.service.js` | ffmpeg supervisor for `_h264` / `_sub_h264` / `_low_h264` sidecar paths. |
| `src/services/vendors/index.js` | Vendor driver registry: RTSP path templates, sub-path derivation, playback URLs, capability flags. |
| `src/controllers/stream.controller.js` | `/api/stream/*` — start, stop, status, master playlist, watchdog trigger, media-plane auth check. |
| `src/controllers/playback.controller.js` | NVR playback (`pb_*` paths). |
| `src/controllers/cameraHealth.controller.js` | Operator health table; joins DB + media server + transcoder + supervisor state. |
| `nginx.conf` | Public edge: `/live/` → WebRTC 8889, `/hls/` → HLS 8888, `/_stream_auth` subrequest. |

Frontend, for delivery decisions:

| File | Responsibility |
|---|---|
| `smart-cam-app/src/core/services/streamCache.js` | Calls `/api/stream/start`, caches hls.js instances, holds all hls.js tuning. |
| `smart-cam-app/src/core/services/streamRegistry.js` | One shared `RTCPeerConnection` per monitorId, refcounted, 30 s grace, tab-hidden suspend. |
| `smart-cam-app/src/core/players/DirectStreamPlayer.jsx` | Picks WebRTC vs HLS; one-way WebRTC→HLS fallback latch. |
| `smart-cam-app/src/core/lib/utils.js` | `playerQuality(camera, dflt)` — resolves the saved per-camera quality preference. |

---

## 3. Path naming vocabulary

You cannot read the logs without this table. Every name is derived, never stored.

| Path name | Built by | What it is |
|---|---|---|
| `cam_<monitorId>` | `StreamServiceEngine.pathName()` | The main stream. Pulled from the camera's `path` (full resolution). This is the canonical path — recording, AI, and health all key off it. |
| `cam_<monitorId>_sub` | `subPathName()` | The camera's own low-res second channel, pulled from the *derived* RTSP sub-path (§6.2). Best-effort: if the camera has no sub channel, this path simply doesn't exist. |
| `cam_<monitorId>_h264` | `transcoder.transcodedPathName()` | ffmpeg output. H.265 source re-encoded to H.264 so Chrome can play it. **Published** into the media server, not pulled. |
| `cam_<monitorId>_sub_h264` | `transcodedSubPathName()` | Same, sourced from `_sub`, low profile (360p/12 fps). |
| `cam_<monitorId>_low_h264` | `transcodedLowPathName()` | Server-made low variant when the camera has no usable native sub. Sourced from the MAIN path, low profile. |
| `cam_<monitorId>_clean` | `smart-cam-transcoder` (separate container) | Phase-3 NVENC "normalisation" path (baseline H.264, fixed GOP). Not produced by the backend; the watchdog's orphan regex knows about the suffix so it doesn't delete it. |
| `pb_<monitorId>_<startMs>` | `playback.controller.js` | Short-lived NVR-playback session. ffmpeg pulls the NVR's *recorded* RTSP stream and publishes here. |
| `all_others` | `stream-service.yml` `paths:` | Wildcard that permits any not-explicitly-configured path name. This is what lets ffmpeg publish `_h264` and `pb_*` paths without pre-registering them. |

Reading a log line like `watchdog: cycling path (likely corrupted muxer) { camera: 'Gate 1', monitor: '5ff9…' }`
means the path `cam_5ff9…` was deleted and re-added. A `cam_…_h264` in a URL means the browser is
watching a transcode, not the camera. `pb_` means somebody is replaying NVR footage.

The prefix is also a namespace guarantee: the watchdog's orphan pass (§5.2) only ever deletes paths
starting with `cam_`, so a manually published demo path can't be reaped by accident.

---

## 4. The on-demand model

### 4.1 What actually triggers a pull

`addCamera()` writes this path config:

```js
const continuous = process.env.RECORD_CONTINUOUS === '1';
const alwaysOn   = continuous || process.env.SOURCE_ALWAYS_ON === '1';
const pathConfig = {
  source: rtspUrl, sourceOnDemand: !alwaysOn, sourceProtocol: 'tcp',
  record: continuous, recordPath: RECORD_PATH,
  recordSegmentDuration: RECORD_SEGMENT, recordDeleteAfter: '0s',
};
```

So by default `sourceOnDemand: true`, `record: false`. The RTSP dial happens on first reader. The
readers in this system are:

| Reader | How it connects | Notes |
|---|---|---|
| Browser, single camera | WHEP `POST {WHEP_BASE}/cam_<id>/whep` (`streamRegistry.js`) | Lowest latency (<500 ms). |
| Browser, grid tile / mobile | HLS `GET .../cam_<id>[_sub]/index.m3u8` | ~2 s latency; smoother. |
| AI workers (`vms_face`, activity-monitor, zone-guard) | `rtsp://mediamtx:8554/cam_<id>` — template in `MEDIAMTX_RTSP_TEMPLATE`; the backend also publishes URLs at `GET /api/internal/cameras` | An AI camera that is "enabled" holds a permanent reader, which makes that path effectively always-on. |
| Transcoder ffmpeg | `rtsp://<rtspHost>:8554/cam_<id>` | Counts as a reader on the source path while it runs. |
| The backend's own warmup | `stream.service.warmupHlsPath()` GETs the playlist | Deliberate: fetching the playlist is what *starts* the HLS muxer. |

`stream.service.warmupHlsPath()` is worth reading in full, because it encodes the ordering rule:

```js
// Phase 1: wait for path readiness (with triggerBeforeReady, poke HLS to CAUSE readiness)
// Phase 2: once ready, poll the HLS playlist until 200 — this also starts the muxer
```

Phase 1 exists because HLS on a not-ready path returns 404 *always*; polling it before readiness
just fills the logs with misleading 404s. But for an on-demand path, readiness can never arrive
without a reader — hence `triggerBeforeReady: true` when warming the sub-stream, which fires an HLS
GET every 1.5 s to break the deadlock.

### 4.2 The lifetime of a pull

`stream-service.yml` `pathDefaults`:

- `sourceOnDemandStartTimeout: 30s` — how long to wait for the source to come up.
- `sourceOnDemandCloseAfter: 20s` — how long the RTSP session is held after the last reader leaves.

Combined with the frontend's 30 s subscriber grace in `streamRegistry.js` (`GRACE_MS`), navigating
between pages reuses a warm connection instead of paying a 3–6 s cold start.

> **Gotcha:** the comment above `sourceOnDemandCloseAfter` in `stream-service.yml` describes a
> **5-minute** hold ("Phase 1.3 … keep the RTSP source open for 5 minutes … at 25 cameras × 5min
> that's about 4.5 GB"), but the value is `20s`. The comment is stale; trust the value. Likewise the
> comment above `sourceOnDemandStartTimeout` describes `rtspReadTimeout`, a different key that isn't
> set at all.

### 4.3 "Online" without a pull: STANDBY and the reachability prober

`cameraReachability.service.js` solves exactly one problem: an idle on-demand camera is
indistinguishable from a dead one. Every `CAMERA_PROBE_INTERVAL_MS` (default 25 s) it:

1. Loads `Camera.findAll({ attributes: ['host', 'port'] })`.
2. **Deduplicates by host** — 68 cameras behind one NVR produce exactly one probe.
3. Opens a bare TCP socket to the RTSP port with a `CAMERA_PROBE_TIMEOUT_MS` (default 5 s) budget.
   Connect ⇒ reachable. Timeout or refusal ⇒ unreachable.

The dedup is the entire design. A probe per camera would be 68 TCP connects per cycle into a box
whose session table is the thing we're protecting; a probe per *host* is one. And because the result
is per-host, when an NVR's uplink dies, all of its cameras flip together — which is what an operator
expects to see, instead of a slow drip of unrelated-looking offline alerts.

`isReachable(host)` returns `true` / `false` / `null` (never probed). The supervisor reads it on
every tick, and `null` deliberately preserves the legacy behaviour so a cold start doesn't mass-flip
statuses before the first probe lands.

---

## 5. The camera state machine

Owned by `streamSupervisor.service.js`. One in-memory entry per `monitorId` in `_cam`; the reducer
is `reduce(entry, pathInfo, now, hostReachable)`.

### 5.1 States

| State | Public `Camera.status` | Meaning | Typical cause |
|---|---|---|---|
| `pending` | offline | Initial state for a newly-seen camera. Never persisted for long. | Process just started. |
| `connecting` | offline | Path exists, `ready: false`, host **not** known-reachable. | RTSP handshake in flight, or a dead camera warming up to offline. |
| `streaming` | online | `ready: true` **and** `bpsIn >= SUPERVISOR_MIN_BPS` (20 kbps). | Someone is watching, frames are flowing. |
| `degraded` | online | `ready: true` but bitrate below the floor for ≥ `SUPERVISOR_DEGRADED_AFTER_MS` (20 s). | Camera connected but starved — bad uplink, wrong channel, camera sending nothing. |
| `standby` | **online** | Not ready, but `isReachable(host) === true`. | The normal idle state for an on-demand camera. **This is healthy.** |
| `offline` | offline | Not ready for ≥ `SUPERVISOR_OFFLINE_AFTER_MS` (40 s) *and* the host is unreachable — or the path is missing from the media server entirely. | NVR/site link down, camera unplugged, path wiped. |
| `quarantined` | offline | Too many flaps in the window; the supervisor stops poking this camera. | A struggling NVR. |

`publicStatus()` collapses this to the two-value `Camera.status` enum: `streaming`, `degraded` and
`standby` are **online**; everything else is offline.

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> standby: host reachable
  pending --> connecting: not ready, host not reachable
  connecting --> standby: host becomes reachable
  connecting --> offline: not ready ≥ OFFLINE_AFTER_MS
  connecting --> streaming: ready + bps ≥ MIN
  standby --> streaming: a reader connects, frames flow
  standby --> offline: host stops answering
  streaming --> degraded: ready, low bps ≥ DEGRADED_AFTER_MS
  degraded --> streaming: bps recovers
  streaming --> standby: not ready ≥ OFFLINE_AFTER_MS, reachable
  streaming --> offline: not ready ≥ OFFLINE_AFTER_MS, unreachable
  degraded --> standby: same, reachable
  degraded --> offline: same, unreachable
  offline --> standby: host answers again
  offline --> streaming: ready + bps ≥ MIN
  quarantined --> pending: quarantineUntil expires
  note right of quarantined
    Entered from ANY state when flap
    accounting hits FLAP_LIMIT inside
    FLAP_WINDOW_MS. Path config is left
    alone; watchdog + auto-heal skip it.
  end note
```

Two edges people expect and that do **not** exist: `offline → connecting` (an unreachable offline
camera stays `offline`; the `connecting` state is only reachable from `pending`/itself) and any
transition *out of* `quarantined` other than expiry.

### 5.2 Transition rules that are not obvious

**Missing path is instant offline, no debounce.** `if (!pathInfo) next = S.OFFLINE;` — the only
undebounced transition. Rationale in the code: a missing path usually means the media server was
restarted and lost its config, and marking it offline immediately gets the watchdog to re-add it
rather than having the supervisor and the watchdog both try to fix it.

**Not-ready is debounced on `notReadySince`, not on time-in-state.** The comment records the bug
this fixed: the old code compared `now - enteredStateAt`, so a stream that had been `streaming` for
ten minutes went `offline` on its *first* not-ready poll, because `enteredStateAt` was already older
than the window. That single-poll knockout produced most of the historical streaming→offline churn.

**A byte counter going backwards is not a 0-bps sample.** Re-adding or patching a path resets
`bytesReceived` to zero in the media server. Treating the negative delta as 0 bps demoted
`streaming → degraded`, which armed another heal, which reset the counter again — a self-sustaining
loop that showed up as `0 → big → 0` bitrate churn. The reducer now carries `bpsIn` forward
unchanged on a negative delta.

**`streaming → standby` is not a flap.** Flap accounting counts (a) any departure from `streaming`
that isn't to `standby`, and (b) any entry into `offline` from a non-offline state. Rule (b) matters
more than it looks: a camera on a saturated NVR often cycles `connecting ↔ offline` without ever
reaching `streaming`, so a `streaming`-only rule never armed quarantine for the *worst-behaved*
cameras and they flapped forever.

**Quarantine is sticky and cross-process.** On entering `quarantined` the supervisor persists
`quarantine_until` to the `cameras` row. That's what lets the recordingSync watchdog honour the
backoff (`isQuarantined(camera)`) instead of instantly re-adding the path and undoing it. On boot,
`rehydrateQuarantine()` reloads still-active quarantines into `_cam`, because the in-memory map is
wiped by a restart and without this a restart would immediately restart the flap loop.

### 5.3 Why a camera dropped

`offlineReason(toState, pathInfo, hostReachable)` attaches an actionable reason to every
offline transition; the code and text ship to the UI and the alert payload.

| `reasonCode` | Condition | Operator-facing text |
|---|---|---|
| `flapping` | entering `quarantined` | Unstable connection — repeatedly dropping (backing off) |
| `nvr_unreachable` | `hostReachable === false` | Recorder / NVR unreachable — the site link or NVR appears down |
| `stream_stopped` | no path info | Stream not running — reconnecting |
| `no_video` | path exists, never went ready | Reachable, but no video — check the camera power & cabling |

### 5.4 Persistence, events, metrics

Writes happen **only on transition**, never per tick. Per transition the supervisor updates
`status`, `supervisor_state`, `bps_in`, plus `last_seen_at` / `last_offline_at` /
`quarantine_until` / `flap_count_24h` as applicable, then emits `STREAM_READY` or `STREAM_OFFLINE`
on both the in-process bus (`events/bus.js` → WebSocket fan-out) and Redis Streams
(`streamBus.service.js` → other processes). Prometheus gauges (`drisyam_camera_state`,
`drisyam_camera_bps_in`, `drisyam_camera_transitions_total`, `drisyam_camera_jitter_ms`,
`drisyam_camera_frames_in_error_per_second`, `drisyam_camera_readers`,
`drisyam_stream_heals_triggered_total`, `drisyam_stream_heals_refused_total`) are set every tick
because they're in-memory and free.

**Leader election:** `acquireLeader()` takes a Redis lock (`drisyam:supervisor:leader`, `SET NX PX`,
TTL `SUPERVISOR_LEADER_TTL_MS` = 15 s) refreshed each tick. Only the leader ticks. Without Redis,
`isLeader()` returns `true` — single-instance dev works unchanged. `streamReconcile` gates its
periodic pass on the same `isLeader()`.

---

## 6. The reconciliation loops

Four loops keep the media server converged on the DB. They deliberately have different periods and
different jobs, and each has guard rails that exist because of a specific production failure.

| Loop | File | Period | Scope | Leader-gated |
|---|---|---|---|---|
| **Supervisor** | `streamSupervisor.service.js` | `SUPERVISOR_POLL_MS`, default **2 s** | Data plane: is each camera actually streaming? | Yes (Redis lock) |
| **Watchdog** | `recordingSync.runWatchdog()` | **2 min** (BullMQ repeatable, or `setInterval` fallback) | Control plane: do the configured paths match the DB? Are the HLS muxers alive? | No (BullMQ dedupes by `jobId`) |
| **Retention reconcile** | `streamReconcile.service.js` | `RECONCILE_INTERVAL_MS`, default **60 s** | Does each path's `recordDeleteAfter` match the resolved retention? | Yes |
| **Reachability prober** | `cameraReachability.service.js` | `CAMERA_PROBE_INTERVAL_MS`, default **25 s** | Is each distinct camera *host* answering on its RTSP port? | No (started by the supervisor) |

A fifth loop, **S3 sync** (`recordingSync.runSync()`, 5 min), moves finished recordings off disk; it
is a data loop, not a reconciler — see §8.

### 6.1 Supervisor (2 s)

One `/v3/paths/list` call **per media server**, not per camera — adding cameras costs nothing,
adding servers costs one round trip. The list is walked page by page (`PATHS_PER_PAGE = 1000`)
because the endpoint defaults to 100 items and a truncated list is worse than no list: a camera
missing from the map reads as "not streaming" and gets demoted.

Per camera it calls `streamQuality.observe()`, which returns optional `healAdvice`. The supervisor
fires the heal and moves on (fire-and-forget) — observation must never block the next camera. It
refuses to heal a `quarantined` camera, because the whole point of quarantine is to stop poking a
struggling NVR; operators can still force one via `POST /api/cameras/:monitorId/heal`.

**Guard rails in `streamQuality.heal()`:**

| Guard | Value | The failure it prevents |
|---|---|---|
| Per-camera cooldown, **exponential** | `QUALITY_HEAL_COOLDOWN_MS` 60 s, doubling per consecutive heal, capped at `QUALITY_HEAL_COOLDOWN_MAX_MS` 15 min | A permanently-broken camera being force-reconnected once a minute forever. |
| ±20 % jitter on the cooldown | — | De-phases sibling cameras so they stop healing in lockstep — 26 cameras on one NVR reconnecting on the same second *is* the outage. |
| 24 h budget | `QUALITY_HEAL_BUDGET_24H` = 20 | Unbounded intervention. Past the budget the camera is flagged for a human (`drisyam_stream_heals_refused_total{reason="budget-exhausted"}`). |
| **Per-NVR reconnect rate limit** | `QUALITY_NVR_RECONNECT_MIN_MS` = 30 s, keyed on `camera.host` | Many cameras share one recorder. Re-binding them simultaneously exceeds its concurrent-session cap, so it drops *healthy* channels too. This is the cross-camera amplifier behind fleet-wide flapping. |
| Reset `consecutiveHeals` on `streaming` | — | So a camera that genuinely recovered heals promptly next time instead of inheriting a 15-minute backoff. |

Note what heal *is*: a `PATCH` of the path with its own existing config. That makes the media server
drop and re-open the upstream RTSP session — the cheapest possible recovery, with no
`DELETE`+`ADD` window where the path doesn't exist.

Note also what quality **refuses** to heal: sustained high jitter (`QUALITY_WARN_JITTER_MS` = 200 ms)
only increments a metric. Jitter is a network property; tearing down a session that is still
delivering frames makes it worse.

### 6.2 Watchdog (2 min)

Four phases in `runWatchdog()`.

**Phase 1 — re-add missing paths.** For every DB camera, if `cam_<id>` is absent from
`listConfiguredPaths()`, call `addCamera()` + `addCameraSubStream()` + re-apply retention. Two
pre-conditions skip a camera entirely:

```js
if (isQuarantined(camera)) continue;                       // don't undo the supervisor's backoff
if (reachability.isReachable(camera.host) === false) continue;  // don't churn a dead NVR
```

The second is subtle and valuable: re-creating a path for an unreachable host produces a connect
attempt that will fail, log noise, and CPU — for nothing. The path stays absent until the prober
sees the host return, and then a later cycle re-adds it automatically.

Retention is re-applied *only* on a path that was actually missing. That's deliberate — a periodic
unconditional patch of every path would be a write storm.

**Phase 1b — orphan reconciliation (media server → DB).** Any configured `cam_*` path whose base
monitorId has no DB row is deleted. Safety rails:

- only the `cam_` namespace (never `all_others`, never a manually published path);
- `_sub` / `_clean` suffixes are stripped before matching, so a sub-path isn't judged separately;
- `WATCHDOG_ORPHAN_SKIP` (default `demo-entrance`) is never touched;
- the orphan must be seen on `WATCHDOG_ORPHAN_PASSES` (default 2) **consecutive** passes.

The consecutive-pass requirement guards the window between `addCamera()` and the DB row committing —
several creation paths add the path before/outside the transaction, so a single-pass rule would race
and delete a camera being born.

**Phase 2 — HLS muxer probe + reset.** For cameras the media server reports `ready`, GET the
internal HLS playlist and look at the status code. Why: the path can be genuinely healthy (RTSP OK,
tracks present) while its HLS muxer is wedged after a reconnect — the muxer hash prefix changes and
stale segment references return 500. The only fix is recreating the muxer, i.e. cycling the path.

```js
const warmedAndWatched = readers > 0 && readySinceMs !== null && readySinceMs > COLD_START_MS;
const shouldReset = warmedAndWatched &&
  ((status === 500 && f500 >= RESET_AFTER_500S) || (status === 404 && f404 >= RESET_AFTER_404S));
```

| Guard | Value | Why |
|---|---|---|
| `readers > 0` | — | Never cycle an unwatched path. There is nothing to fix and it's pure NVR noise. |
| `COLD_START_MS` | 120 s since `readyTime` | A muxer that is merely warming up returns 404/500 legitimately. |
| `RESET_AFTER_404S` / `RESET_AFTER_500S` | 3 / 2 consecutive | A single transient muxer-hash race during a normal reconnect must not hair-trigger a destructive remove+add. |
| `RESET_COOLDOWN_MS` (per camera) | 5 min | Cycling re-opens RTSP; on a maxed-out NVR that makes things worse. |
| `NVR_RESET_MIN_MS` (per host) | `WATCHDOG_NVR_RESET_MIN_MS`, 30 s | Same amplifier as §6.1: a tick full of 500s on one NVR must not fire 26 simultaneous RTSP re-opens into a box already at its session cap. |

Note the probe target: `config.streamService.internalHlsUrl` (`http://stream-service:8888`), **not**
the browser-facing `hlsUrl` (a host port-map like `:8898`). Using the browser URL from inside the
backend container silently network-errored on every probe, which made this whole phase dead code.

**Phase 3 — status sync.** Sets `Camera.status` from `ready || isReachable(host) === true`. This
must agree with the supervisor, which is the primary authority; the deliberate use of reachability
here is what stops the watchdog flipping every idle on-demand camera back to `offline` every two
minutes and fighting the supervisor.

**Tail:** if any path was added or reset, `streamReconcile.requestReconcile('watchdog-readd')` fires
a debounced immediate retention pass instead of waiting up to a minute.

### 6.3 Retention reconcile (60 s)

`reconcileRetention()` is a three-step diff designed to stay cheap at thousands of cameras:

1. `resolveDesired()` loads cameras + groups + sites **once** and resolves the hierarchy with map
   lookups — no per-camera queries.
2. `fetchObserved()` pages `/v3/config/paths/list` once per media server for `recordDeleteAfter`.
3. Compare by **absolute seconds**, not string equality — the media server may report `30d` where we
   sent `720h`. `durationToSeconds()` handles `d/h/m/s`.

Only drifted paths are patched, with `RECONCILE_CONCURRENCY` (8) in flight. A no-drift cycle issues
zero writes. Paths not present at all are skipped: adds belong to the watchdog.

`requestReconcile()` gives other code an immediate, **debounced** trigger
(`RECONCILE_DEBOUNCE_MS`, 1500 ms) — so a media-server restart that re-adds 2000 paths causes one
reconcile, not 2000.

The same loop also calls `streamRouter.reconcileServerLoads()`, which recomputes every
`mediamtx_servers.current_cams` from a `GROUP BY` over the cameras table. The increment/decrement
deltas drift (not every create path increments, deletes historically didn't decrement), so the
authoritative recompute — not more careful deltas — is the fix.

### 6.4 Reachability prober (25 s)

Covered in §4.3. It is started by `streamSupervisor.start()` and stopped by `stop()`; it is not
leader-gated, so every instance probes (cheap, and each instance needs its own local answer to
reduce with).

---

## 7. The vendor driver registry

`src/services/vendors/index.js` is the single source of truth for per-vendor behaviour. Its header
comment records why it exists: vendor logic used to live in four drifting `switch` statements in
`deviceProbe.service.js` plus two duplicated RTSP path builders in `cameraGroup.controller.js` and
`bulkImport.controller.js`, and any unknown device silently fell back to Hikvision ISAPI —
producing confidently-wrong RTSP URLs with no operator-visible error.

### 7.1 The registry

| id | Aliases | Main path template (channel `ch`) | Sub path | `pathStrategy` | probe / encoder / keyframe |
|---|---|---|---|---|---|
| `hikvision` | `hik`, `hilook` | `/Streaming/Channels/<ch*100+1>` | `…<ch*100+2>` | template | hikvision |
| `dahua` | `amcrest`, `empiretech` | `/cam/realmonitor?channel=<ch>&subtype=0` | `subtype=1` | template | dahua |
| `cpplus` | `cp-plus` | Dahua templates (OEM of the same SoC family) | Dahua | template | dahua |
| `axis` | — | `/axis-media/media.amp?camera=<ch>` | none | template | axis / — / — |
| `uniview` | `unv` | `/unicast/c<ch>/s0/live` | `/s1/live` | template | onvif |
| `hanwha` | `wisenet`, `samsung` | `/profile<2 or ch+1>/media.smp` | `profile+1` | **onvif** | onvif |
| `bosch` | — | `/rtsp_tunnel?inst=1&line=<ch>` | `inst=2` | **onvif** | onvif |
| `honeywell` | — | `/stream<ch>` (generic fallback) | none | **onvif** | onvif |
| `onvif` | — | `/stream<ch>` (placeholder) | none | **onvif** | onvif |
| `generic` | — | `/stream<ch>` (back-compat alias of the original 4-value enum) | none | **onvif** | onvif |

`pathStrategy: 'onvif'` is a **warning label**, not behaviour: it means the built-in template is a
documented best-effort and the authoritative URL should come from ONVIF `GetStreamUri` (not yet
implemented — "Wave 3") or a per-camera raw RTSP URL. The template is still returned if you ask for
it.

`getDriver()` throws `UnsupportedVendorError` (HTTP 422, `code: 'unsupported-vendor'`) for anything
unknown. **It never falls back.** That is the whole point, and `test/vendors.test.js` pins it.

### 7.2 Two different sub-path derivations

There are two, and they are used in different situations:

- **`buildSubPath(deviceType, channel)`** — used at onboarding, when you know the vendor.
- **`deriveSubPath(mainPath)`** — used by the media layer, which has the stored `camera.path` string
  but not always the `deviceType`. It pattern-matches every known convention in order: Hikvision
  `/Channels/N01→N02`, Dahua `subtype=0→1`, Uniview `/cN/s0/live→/s1/live`, Bosch `inst=1→2`,
  Hanwha `/profileN/→/profile(N+1)/`. Returns `null` when nothing matches, and the caller then
  simply has no sub-stream (grid tiles fall back to main, `hlsSubUrl` is `null`).

Both `StreamServiceEngine.deriveSubPath` and `streamRouter.deriveSubPath` delegate here so they
cannot drift.

### 7.3 How do I add a new camera vendor?

Everything below is one file unless stated. Budget an hour, most of it verification.

1. **Get the real RTSP paths.** Do not guess. Open the device's web UI or run
   `python -m vms_face.tools.probe_rtsp rtsp://user:pass@host/<candidate>` (in the AI image) or plain
   `ffprobe -rtsp_transport tcp rtsp://…` against main and sub for at least channels 1, 2 and 3 — the
   channel arithmetic is where templates usually break.

2. **Add the templates** near the other builders in `vendors/index.js`:

   ```js
   const acmeMain = (ch) => `/live/ch${ch}/main`;
   const acmeSub  = (ch) => `/live/ch${ch}/sub`;
   ```

3. **Add the driver entry** to `DRIVERS`. Be honest in `capabilities` — anything you set to `true`
   makes `deviceProbe.service.js` and the talkback/PTZ layers attempt real calls:

   ```js
   acme: {
     id: 'acme', displayName: 'Acme', aliases: ['acme-vision'],
     defaultRtspPort: 554, defaultHttpPort: 80,
     pathStrategy: 'template',          // 'onvif' if the template is best-effort
     probeStrategy: 'onvif', encoderStrategy: 'onvif', keyframeStrategy: 'onvif',
     capabilities: { probe: true, encoder: true, keyframe: true, subStream: true,
                     ptz: false, talkback: false, hasVideo: false },
     buildRtspPath: acmeMain, buildSubPath: acmeSub,
   },
   ```

   `*Strategy` values must be one of the strings `deviceProbe.service.js` already maps
   (`'hikvision' | 'dahua' | 'axis' | 'onvif' | null`) — see the `switch` statements at
   `deviceProbe.service.js:376`, `:730`, `:757`. Inventing a new strategy string means also
   implementing it there. `null` disables that capability cleanly.

4. **Teach `deriveSubPath()` the pattern**, if the sub path is derivable from the main path string
   (it usually is). Add one branch, ordered so it can't shadow an existing vendor's pattern:

   ```js
   if (/\/live\/ch\d+\/main$/.test(mainPath)) return mainPath.replace(/\/main$/, '/sub');
   ```

   Skip this only if the vendor genuinely has no sub channel — then grid tiles will use the main
   stream for those cameras, which is a real bandwidth cost.

5. **NVR playback (optional).** If the device family supports RTSP replay of its own recordings, add
   a builder to `PLAYBACK_BUILDERS` and map it in `playbackFamily()`. Otherwise
   `supportsPlayback()` correctly returns `false` and the API answers 422 with a clear message.

6. **Add tests** in `test/vendors.test.js` — main + sub for channels 1 and 3, alias canonicalisation,
   and `deriveSubPath` round-tripping your template. Run `npx jest test/vendors.test.js`.

7. **Verify nothing else needs touching.** The API allow-lists derive from `listDeviceTypes()` /
   `listAcceptedTypes()` (`deviceProbe.controller.js:42`, `bulkImport.controller.js:51`), so a new
   vendor is accepted by validation automatically. That is the payoff of the registry.

8. **End-to-end check:** create a group with the new `deviceType`, then
   `GET /api/cameras/health` — the row should show a `codec` and `resolution` once you open the
   camera, and `curl -u <user>:<pass> http://localhost:9997/v3/config/paths/list | jq '.items[].source'`
   should show the URL you expect (with the password URI-encoded, per `buildRtspUrl`).

---

## 8. Delivery

### 8.1 WHEP vs HLS

| | WebRTC (WHEP) | HLS |
|---|---|---|
| Port / edge | 8889, nginx `/live/` (`ip_hash` upstream — signalling is sticky) | 8888, nginx `/hls/` (round-robin, stateless) |
| Latency | sub-500 ms | ~2 s |
| Used for | single-camera live view, grid tiles that explicitly request `mode='webrtc'` | grid tiles, mobile, WebRTC fallback, anything H.265-transcoded |
| Codec support | camera codec passthrough | fMP4 LL-HLS; H.265 passes through to clients that can decode it, otherwise transcoded (§8.4) |
| Client | `streamRegistry.js` + `WebRTCPlayer.jsx` | `streamCache.js` + `HLSPlayer.jsx` |

`DirectStreamPlayer.jsx` picks: an explicit `mode='webrtc'` always wins; `mode='hls'`, `forceHls`,
or `quality='low'` pin HLS. The WebRTC→HLS fallback is a **one-way latch** (`fellBack` state, reset
only when camera/quality/mode changes) — the older bidirectional fallback thrashed between
protocols.

The LL-HLS tuning in `stream-service.yml` is worth understanding before touching it:

```yaml
hlsVariant: fmp4          # required for LL-HLS parts; MPEG-TS can't do partial segments
hlsSegmentDuration: 2s
hlsPartDuration: 1s       # == target GOP, so EVERY part starts on a keyframe
```

A part is only an independent start/resync point if it begins on a keyframe. With 200 ms parts over
a 1–2 s GOP only ~1 in 5–10 parts was independent, so first-frame and post-stall recovery had to
wait for the next keyframe. Setting part duration equal to the GOP makes every part a valid entry
point — instant zap, clean resync. That is also why `transcoder.service.js` pins `-g 25` (≈1 s at
25 fps) and `-g 12` for the 12 fps low profile, overriding whatever GOP a hardware encoder defaults
to, and why `-sc_threshold 0` disables scene-cut keyframes (they make GOP length unpredictable).

The matching client-side tuning lives in `streamCache.createHlsInstance()`. The load-bearing setting
is `liveSyncOnStallIncrease: 0.1` — hls.js adds 1.0 s to the target latency on **every** stall and
never resets it without rebuilding the player (hls.js #6350), so the default is a one-way ratchet up
to 4 s+. `liveSyncDurationCount: 3` (up from 1) is the biggest anti-stutter lever, and
`maxLiveSyncPlaybackRate: 1.5` catches up by speeding up invisibly rather than seeking.

### 8.2 Grid sub-stream vs single main

The rule lives in `smart-cam-app/src/core/lib/utils.js`:

```js
export function playerQuality(camera, dflt) {
  switch (camera?.streamQuality) {
    case 'sub':  return 'low';
    case 'main': return 'high';
    case 'auto': return 'auto';
    default:     return dflt;   // unset → the VIEW's bandwidth default
  }
}
```

Multi-camera views pass `dflt='low'`, single-camera views pass `'high'`. A main-stream tile is
roughly 8× the bitrate of a sub-stream tile, and a wall multiplies that by the tile count — this is
the primary scale lever in the whole product.

The saved preference is a three-level inheritance: `Camera.streamQuality` → `CameraGroup.streamQuality`
→ `'auto'`, settable per camera, in bulk, or per group via
`POST /api/groups/:groupId[/cameras[/:monitorId]]/quality` with `{ streamQuality: 'auto'|'main'|'sub'|null }`
(`null` = inherit).

Server side, `stream.service.startStream(camera, { quality })` decides what URLs to hand back:

1. Ensure `cam_<id>` exists (re-add if the media server was restarted).
2. Derive and add `cam_<id>_sub` if the vendor pattern matches.
3. Warm the main HLS muxer (and detect the codec from the live track info while there).
4. For `quality` `low`/`auto`, warm the sub path with `triggerBeforeReady: true` and check its codec.
   If the sub is ready **and H.264**, use it — and unless `PREFER_MAIN_STREAM=1`, make it the
   primary live view too, because remote NVRs over an office uplink often can't carry the full-res
   main stream at all (RTSP TCP timeouts → HLS 500) while the low-bitrate sub is fine.
5. Hand back `hlsSubUrl` **even if the sub didn't finish warming synchronously**:

   ```js
   if (!hlsSubUrl && subRtspPath && (quality === 'low' || quality === 'auto')) {
     hlsSubUrl = streamingService.getHlsSubUrl(monitorId);
   }
   ```

   Without this, an on-demand sub that needed more than ~2 s to warm returned `hlsSubUrl: null`, so a
   per-camera "Sub" choice (and every grid tile) silently played the **main** stream — the exact
   opposite of the intent. The player warms and retries the sub manifest itself.
6. If there's no usable native sub and `quality === 'low'`, fall back to the `_low_h264` transcode,
   pre-warming it in the background with a hard cap (`GRID_LOW_TRANSCODE_MAX`, default 2 concurrent,
   `GRID_LOW_TRANSCODE_COOLDOWN_MS` 15 s per camera).

### 8.3 The ABR master playlist

`stream.service.buildMasterPlaylist(camera)` emits a two-variant HLS master (High = main, Low = sub)
with estimated bandwidths (`w*h*fps*0.10`, deliberately ballpark — it only feeds hls.js heuristics).

The critical rule: **the Low variant is only listed after the media server confirms the sub path is
actually `ready: true`.** The sub is on-demand; if we advertise a variant that never publishes,
hls.js's variant fetch gets an empty/404 response and Chrome ORB-blocks it
(`ERR_BLOCKED_BY_ORB` in the Network tab). A single-variant master is still valid HLS and avoids the
flood.

Served at `GET /api/stream/master/:monitorId/index.m3u8`, JWT-authenticated (hls.js attaches the
bearer only for `/api/stream/master/` URLs via `xhrSetup`; variant playlists and segments go
straight to the media server unauthenticated).

> `stream.controller.startStream` currently hard-codes `const masterUrl = null;`, so the SPA never
> uses the ABR master — it plays `hlsUrl` or `hlsSubUrl` directly. The endpoint still works if you
> hit it. The comment explains the reasoning (a single-variant master adds nothing, and hls.js can
> misbehave on nested masters), but if you're wondering why ABR "doesn't work", this line is why.

### 8.4 H.265: passthrough first, transcode only when required

Nearly every camera here publishes H.265, so how this is handled decides both picture quality and
how many cameras can be watched at once.

**The rule: transcode only when the client genuinely cannot decode it.** Chromium has shipped
HEVC-over-MSE by default since v105, decoding through the platform's hardware decoder, so a large
share of real client machines can play the camera's native stream. Support is a property of the
*machine* (it needs an OS/GPU HEVC decoder), not of the browser version — so it cannot be inferred
from a user-agent string and has to be probed.

The flow:

1. The client probes its own decoder — `core/services/codecSupport.js` calls
   `MediaSource.isTypeSupported` for both `hvc1` and `hev1` (a decoder may accept one and not the
   other) and caches the answer for the page.
2. `streamCache.acquireStream` sends it as `?hevc=1` on `GET /api/stream/start/:monitorId`.
3. `stream.service.startStream` detects the source codec from the path's track info. For an H.265
   main stream it either **serves the native path unchanged** (client can decode) or **requests a
   transcoder and returns the `_h264` path** (client cannot).

This fails closed at every step: an older client sends no flag, an unexpected probe result counts as
"cannot decode", and either way the server transcodes exactly as it always did.

Why it matters: a transcode costs a hardware encoder slot per camera, and `MAX_CONCURRENT` caps
those — which is a hard ceiling on how many H.265 cameras can be viewed simultaneously. It also adds
a re-encode generation of quality loss and latency. Passthrough removes all three.

> **Debugging tip.** The response includes `codec` and `transcoded`. `transcoded: false` on an H.265
> camera means passthrough is working. The server also logs
> `[Stream] H.265 passthrough (client decodes HEVC natively)`.

The transcoder still runs for clients that need it:

`transcoder.service.js` is the ffmpeg supervisor:

| Concern | Mechanism |
|---|---|
| Encoder choice | Probes `ffmpeg -encoders` for `h264_nvenc` → `h264_qsv` → `h264_amf` → `libx264`. **Only if `TRANSCODER_ALLOW_HW=true`**, otherwise straight to `libx264`. |
| Hardware that lies | An encoder crashing within 10 s twice is **permanently demoted** for the process lifetime (`_demotedEncoders`) and the next-best one takes over. Being listed in `-encoders` doesn't mean the driver loads. |
| Never spawn on a dead source | `isSourcePathReady()` gate — ffmpeg against a frameless path just hangs and emits timeout warnings. |
| Stall | No `frame=` on stderr for `TRANSCODER_STALL_MS` (30 s) → SIGKILL → auto-restart. |
| Idle | Zero readers on the target path for `TRANSCODER_IDLE_MS` (60 s) → SIGTERM (treated as a clean stop, no restart). |
| Concurrency | `TRANSCODER_MAX` (8) active processes. |
| Crash loop | Linear backoff `3 s × (n+1)`, `MAX_RESTARTS` 5, then it gives up until the next viewer request. |
| Thundering herd | `requestTranscode()` enqueues a BullMQ job with `jobId: transcode:<monitorId>:<variant>` — duplicate viewer requests coalesce into one ffmpeg spawn. Falls back to running inline if Redis is down; `ensure*` is idempotent so a duplicate is a no-op. |

The output is `-f rtsp` published back into the media server, which is what `all_others: {}` in
`stream-service.yml` permits.

### 8.5 The edge (nginx) and media-plane auth

| Location | Upstream | Notes |
|---|---|---|
| `/api/` | `backend_api` | rate-limited per IP |
| `/socket.io/` | `backend_api` | 3600 s timeouts, buffering off |
| `/live/` | `mediamtx_webrtc` (8889) | `ip_hash` — WHEP offer/answer must stay on one server |
| `/hls/` | `mediamtx_hls` (8888) | `proxy_buffering off`; `.m3u8` → `no-store`, segments → `max-age=10` |
| `= /_stream_auth` | `backend_api/api/stream/verify` | `internal`; forwards `X-Original-URI` + the browser cookie |

Media-plane authorization (audit item H9) is **built but not switched on**: the `auth_request`
lines in `/live/` and `/hls/` are commented out, and `streamToken.enabled()` returns false unless
`STREAM_URL_SECRET` (≥16 chars) is set. When enabled, `stream.controller.startStream` mints an
HMAC token bound to the monitorId and drops it as an `st_<monitorId>` httpOnly cookie; nginx
subrequests `/api/stream/verify`, which returns 204/401. Until then, anyone who can reach the host
and knows a `cam_<id>` name can watch it — see `docs/STREAM_SECURITY.md`.

### 8.6 How do I add a delivery format?

Say you want to add a new egress (LL-DASH, WHIP-based SFU fan-out, an MJPEG bridge, a LiveKit room).

1. **Decide who produces it.** If the media server can emit it natively, it's a `stream-service.yml`
   change plus a URL builder. If it needs re-packaging, it's a sidecar that *publishes* into a new
   path suffix — follow the `_h264` pattern rather than inventing a new mechanism.
2. **Add the path suffix and its builder** in `transcoder.service.js` (`transcodedXPathName`) or,
   for a native format, a URL builder in `StreamServiceEngine` — and declare it on
   `StreamingEngine.js` so the contract stays honest.
3. **Decide how the path comes into existence, then tell the watchdog.** If the sidecar *publishes*
   over RTSP under the `all_others` wildcard (what `_h264` and `_clean` do), the path never appears
   in `/v3/config/paths/list` and the watchdog's orphan pass ignores it — nothing to do. If instead
   you **register** the path through `POST /v3/config/paths/add/...`, you must add your suffix to the
   strip in `recordingSync.runWatchdog()` Phase 1b (`name.slice(4).replace(/_(sub|clean)$/, '')`),
   or the orphan pass will delete your path every two passes. This is the most commonly missed step,
   and the failure mode (a path that works for four minutes then vanishes) is baffling if you don't
   know to look here.
4. **Wire the config**: add the upstream + `location` to `nginx.conf`, add the env var to
   `src/config/env.js` under `streamService` (keep the `STREAM_SERVICE_*` name with a `MEDIAMTX_*`
   fallback, matching the existing pattern), and expose the URL from
   `stream.service.startStream()`'s return object.
5. **Give it a lifecycle.** If it's a process, copy the transcoder's four budgets: readiness gate,
   stall detector, idle shutdown, concurrency cap. A format with no idle shutdown becomes a
   permanent RTSP reader and quietly converts every camera to always-on — which is how you jam an
   NVR.
6. **Frontend**: add a player under `core/players/` and let `DirectStreamPlayer` choose it. Do not
   open connections from a page component; use a refcounted registry like `streamRegistry.js` or
   you'll hold sessions open across navigation.

---

## 9. Recording

### 9.1 Where recording is (not) configured

| Path | `record` default | Config source |
|---|---|---|
| `cam_<id>` (main) | **off** — `record: process.env.RECORD_CONTINUOUS === '1'` | `StreamServiceEngine.addCamera` |
| `cam_<id>_sub` | **off** — `record: process.env.RECORD_SUB === '1'` | `StreamServiceEngine.addCameraSubStream` |
| Globally | `pathDefaults.record: no` | `stream-service.yml` |

When recording is on, the layout is
`recordPath: /recordings/%path/%Y-%m-%d/%H-%M-%S-%f`, i.e.
`/recordings/cam_<id>/2026-08-06/14-23-45-123456.mp4`, with
`recordSegmentDuration` from `RECORDING_SEGMENT_DURATION` (default `10m0s`).

### 9.2 Why recording belongs on the sub-stream — and why it's off

The reasoning is written out in `addCameraSubStream`'s doc comment and is the most important
paragraph in the file:

- The sub-stream is a fraction of the main stream's bitrate, so 24/7 recording fits the same uplink
  that full-res recording saturated. `RECORD_CONTINUOUS` was tried and **reverted** after it knocked
  cameras offline.
- But recording requires the source to stay connected, so `record: true` forces
  `sourceOnDemand: false` — **one permanent RTSP session per camera, 24/7**. That is precisely the
  configuration that jammed a customer's Hikvision until it was rebooted.
- The `RECORD_SUB: "0"` comment in `docker-compose.drisyam-original.yml` names the arithmetic: 18
  cameras behind one NVR × one permanent session each ⇒ session table jams ⇒ `:554` stops answering
  ⇒ the prober times out ⇒ all 18 flip offline. The standing rule from that incident is **≤6
  concurrent pulls per NVR, and no record-all**.

So the default is off, and turning it on is a per-deployment decision that requires capping
always-on recording per NVR (per-camera flags or staggered starts), not flipping a global.

> **Known rough edge:** `recordingSync.syncCamera()` reads only
> `path.join(RECORDINGS_DIR, streamingService.pathName(camera.monitorId))` — the **main** path
> directory. If you set `RECORD_SUB=1`, segments land in `cam_<id>_sub/` and are never uploaded or
> pruned by Node; only the media server's `recordDeleteAfter` (`RECORD_DELETE_AFTER`, default `168h`)
> bounds them. The engine's comment acknowledges this.

### 9.3 Segment stitching

RTSP reconnects produce many short fragments instead of clean 10-minute segments. `runSync()` (every
5 min) repairs that before upload:

1. **Collect** `*.mp4` under `cam_<id>/<date>/`, skipping `.stitch-*` temps.
2. **Filter** by age — anything younger than `MIN_AGE_MS` (2 min) may still be being written.
3. **Probe** each with `ffprobe` for real duration; unreadable files are deleted (a corrupt header
   is not recoverable and would jam the batch forever). The probe has a 15 s kill timer so a stalled
   NFS read can't leak a zombie holding an FD.
4. **Plan batches** (`planBatches`): a segment ≥ `STITCH_BELOW_SEC` (default 120 s, env
   `RECORDING_STITCH_BELOW_SEC`) is a batch of one. Short segments merge with adjacent short
   segments while the inter-segment gap ≤ `STITCH_MAX_GAP_SEC` (5 s) and the cumulative duration
   ≤ `STITCH_MAX_BATCH_SEC` (15 min).
5. **Materialise** (`ffmpegConcat`): `-f concat -c:v copy -c:a aac -movflags +faststart -fflags +genpts`.
   Video is stream-copied (lossless, fast). Audio is **re-encoded to AAC** because MP4 cannot hold
   `pcm_s16be`, which some cameras emit — with `-c copy` the whole stitch failed and the recording
   was lost. `+faststart` puts the moov atom first so the stored MP4 is seekable in a browser
   without a full download.
6. **Upload** with a human-readable name: `14-23-45_to_14-33-45_10m.mp4`.

### 9.4 S3 tiering

Key shape: `recordings/{userId}/{slug(groupName)}/{slug(cameraName)}/{YYYY-MM-DD}/{filename}`.

Upload is streamed from disk (`uploadRecordingFromFile`) with a buffered fallback that is **skipped**
for files over `RECORDING_MAX_BUFFER_MB` (256 MB) — reading a multi-GB clip into the heap would OOM
the process, so it is left on disk to retry next cycle. The local copy is deleted only after a
confirmed upload; a throw before the unlink means the file survives.

Idempotency has two layers: an in-process `_uploaded` Set (FIFO-bounded at
`RECORDING_UPLOADED_CACHE_MAX`, 50 000, so a long-lived process can't leak) and `s3Service.exists()`,
which is the real guard — the cache only saves a HEAD.

Playback reads **local disk first, S3 second** (`getGroupRecordings`, `getRecordingPlayUrl`):
local keys start with `cam_` and are streamed through
`GET /api/groups/:groupId/recordings/stream?key=…` with HTTP Range support; S3 keys start with
`recordings/<userId>/` (which is also the ownership check) and get a presigned URL whose TTL is
`RECORDING_PLAY_URL_TTL_SEC`, default **4 hours** — shortened from a 7-day link, because a presigned
URL is a bearer credential and a week of unauthenticated access is not an acceptable leak radius.

### 9.5 Retention inheritance and enforcement

Resolution order (`recordingRetention.resolveRetentionDays`):

```
Camera.retentionDays → Group.retentionDays → Site.settings.retentionDays → DEFAULT_RETENTION_DAYS (30)
```

`null` at any level means "inherit", which is why the API accepts `null` to reset an override.

Enforcement happens in three places, and you need all three:

| Copy | Enforced by | Notes |
|---|---|---|
| Local disk / NAS | The media server's native `recordDeleteAfter` on each path | `retentionToMediamtx(days)` returns `${days*24}h` — Go durations have no `d` unit. On-prem this means the NAS is managed with no extra cron. |
| Drift correction | `streamReconcile.reconcileRetention()` every 60 s | Compares by absolute seconds, patches only drifted paths. |
| Durable object storage | `s3Retention.service.js`, daily, leader-only | The media server bounds only local disk; nothing deleted old objects, so the durable copy grew forever. |

`s3Retention` deletes evidence, so it is armoured accordingly: **off** unless
`S3_RETENTION_ENABLED=1`, **dry-run** unless `S3_RETENTION_DELETE=1`, a `S3_RETENTION_GRACE_DAYS`
margin on top of the retention, a per-run cap (`S3_RETENTION_MAX_DELETE_PER_RUN`, 20 000), and a
strict key-date parser (`keyDateMs`) that returns `null` for anything that isn't exactly a valid
calendar date in position 4 — and a `null` is never deleted. `retentionDays <= 0` means keep forever.

Changes propagate immediately via `applyRetention()` (3 retries with backoff), and the reconcile loop
is the backstop if that fails. A freshly re-added path defaults to `recordDeleteAfter: '0s'`, which
is why the watchdog re-applies retention right after re-adding a missing path.

---

## 10. NVR playback and the read-only NVR boundary

### 10.1 The boundary

`vendors.nvrInterface(deviceType)` states the contract in code:

- **Live video** — `direction: 'read-only-pull'`. The NVR/camera is the RTSP *server*; we only pull.
  We never push video into an NVR.
- **Config** — we READ device info, channel names, and video-signal presence over HTTP/ONVIF. We
  WRITE only encoder settings (bitrate/GOP/fps), two-way audio, and PTZ, and only for vendors whose
  driver advertises that capability. We never touch NVR storage, recording schedule, users, or
  network config.
- **Recordings** — drisyam-owned: `NVR RTSP → Stream Service (record MP4) → Node stitch → S3`.

> That doc comment also says the NVR's own recordings are "NEVER read, played back, or modified" —
> which was true when it was written and is now **out of date**: §10.2 reads them (still read-only).
> `nvrInterface()` is exported but has no call site anywhere in the backend or frontend; treat it as
> documentation-as-code, and fix the recordings note if you touch it.

### 10.2 NVR playback (`pb_*`)

`playback.controller.js` replays footage stored on the NVR itself — useful when a camera was
onboarded after the fact, or when our own recording is off (which is the default).

```mermaid
sequenceDiagram
  participant B as Browser
  participant API as backend /api/playback/nvr/start
  participant FF as ffmpeg (backend container)
  participant NVR
  participant MS as Stream Service
  B->>API: { monitorId, start, end }
  API->>API: vendors.supportsPlayback(deviceType) — else 422
  API->>API: buildPlaybackPath(deviceType, channel, start, end)
  API->>FF: spawn ffmpeg -i rtsp://…/playback… -c:v libx264 -f rtsp
  FF->>NVR: RTSP PLAY (time range)
  FF->>MS: publish to pb_<monitorId>_<startMs>
  API-->>B: { hlsUrl: /hls/pb_…/index.m3u8, webrtcUrl: /whep/pb_… }
  B->>MS: GET /hls/pb_…/index.m3u8 (via nginx)
```

Vendor URL builders (`PLAYBACK_BUILDERS`), Hikvision and Dahua/CP Plus only:

- Hikvision: `/Streaming/tracks/<ch*100+1>?starttime=YYYYMMDDThhmmssZ&endtime=…` (UTC)
- Dahua: `/cam/playback?channel=<ch>&starttime=YYYY_MM_DD_hh_mm_ss&endtime=…` (device-local
  format — **we send UTC**, so a device on local time will be offset; see Gotchas)

Guard rails, all about not overloading the NVR:

| Guard | Value |
|---|---|
| Max requested range | `MAX_RANGE_MS` = 6 h |
| Hard session kill | `MAX_SESSION_MS` = 30 min |
| Duplicate window | `stopSession(pathN)` replaces any existing session for the exact same path |
| Explicit stop | `POST /api/playback/nvr/stop` kills ffmpeg **and** deletes the media-server path |
| Path-name validation | `/^pb_[A-Za-z0-9_]+$/` on stop — the path name goes into a control-API URL |

Transcode is unconditional `libx264` here (not the hardware-aware picker in
`transcoder.service.js`), because NVR playback streams are frequently H.265 and always short-lived.
Audio is dropped (`-an`) since NVR G.711 is HLS trouble.

> **Deployment note:** the response returns `webrtcUrl: /whep/<path>`, but the repo's `nginx.conf`
> exposes WebRTC at **`/live/`**, not `/whep/`. The `NvrPlayback.jsx` page only uses `data.hlsUrl`,
> so this doesn't break today — but if you start using that field, add a `/whep/` location (or
> change the controller). Also note the memory-documented production fix: `/hls` needs
> `proxy_redirect` handling and `absolute_redirect off`, because the media server's cookie-check
> 302 drops the `/hls` prefix and the request falls through to the SPA. That is **not** in the
> repo's `nginx.conf`.

---

## 11. How do I…

### 11.1 …debug a camera that won't stream

Work top-down; each step eliminates a layer.

**1. What does the system think?**

```bash
curl -s localhost:5000/api/cameras/health -H "Authorization: Bearer $JWT" | jq '.cameras[] | select(.name|test("Gate"))'
```

Read `status`, `reason`, `supervisorState`, `ready`, `inboundBytes`, `readers`, `bpsIn`,
`framesInError`, `healsToday`. The `classify()` decision tree in `cameraHealth.controller.js` tells
you what each means. `standby` with `reachable` is **healthy and idle** — not a bug.

**2. Does the path even exist?**

```bash
curl -su "$MEDIAMTX_API_USER:$MEDIAMTX_API_PASS" localhost:9997/v3/config/paths/list \
  | jq '.items[] | select(.name|startswith("cam_5ff9")) | {name, source, sourceOnDemand, record, recordDeleteAfter}'
```

Missing ⇒ the watchdog will re-add within 2 min *unless* the camera is quarantined or its host is
unreachable. Check both:

```sql
SELECT monitor_id, status, supervisor_state, quarantine_until, flap_count_24h FROM cameras WHERE monitor_id='…';
```

**3. Is the host reachable at all?** The prober logs every change:
`cameraReachability: host state change { host, port, reachable: false }`. If it's false, this is a
network/NVR problem and nothing in the VMS will fix it. Confirm from the backend container, not your
laptop — private-LAN camera addresses are a recurring false alarm:

```bash
docker compose exec smart-cam-backend sh -c 'nc -vz -w5 <host> 554'
```

**4. Is anyone actually reading it?** On-demand means no reader ⇒ no pull ⇒ no frames. Force one:

```bash
curl -s "localhost:5000/api/stream/start/<monitorId>" -H "Authorization: Bearer $JWT" | jq
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8898/cam_<monitorId>/index.m3u8
```

Then re-check `/v3/paths/get/cam_<id>` for `ready` and `bytesReceived` climbing.

**5. Is the RTSP URL right?** Compare `source` from step 2 with what the vendor driver should
produce for that channel, and test it directly:

```bash
ffprobe -rtsp_transport tcp -v error -show_streams "rtsp://user:pass@host:554/Streaming/Channels/101"
```

401 ⇒ credentials (remember: the **group's** credentials win over the camera's in the watchdog —
see Gotchas). 404 ⇒ wrong channel/path template for that vendor.

**6. Is it being suppressed?** Look for `heal ... refused` metrics
(`drisyam_stream_heals_refused_total{reason=…}`) and these log lines:

- `[Quality] heal triggered` — active intervention happening
- `watchdog: reset deferred (per-NVR rate limit)` — another camera on the same NVR was cycled recently
- `[Supervisor] transition … to: quarantined` — backoff engaged; nothing will touch it until
  `quarantine_until`

To override a cooldown deliberately: `POST /api/cameras/:monitorId/heal`.
To force a full reconcile now: `POST /api/stream/watchdog/run`.

### 11.2 …debug black video on a path that is `ready`

`ready: true` means RTSP is connected and tracks were announced. Black video with that state is
almost always a **delivery** problem, not an ingest one.

1. **Codec.** `GET /v3/paths/get/cam_<id>` → `tracks2[].codec`. H.265 + HLS in Chrome = nothing.
   The API response from `/api/stream/start` tells you what the backend decided
   (`codec`, `transcoded`); if `transcoded: true` the browser should be on `cam_<id>_h264`. Check
   the transcoder is alive: `transcoderService.listActive()` is surfaced in
   `/api/cameras/health` as `transcoder: { running, uptimeSec, restarts }`. A `restarts: 5` row
   means it gave up — check the backend log for `transcoder: ffmpeg exited unexpectedly` and its
   stderr tail.
2. **Muxer wedged.** Fetch the playlist directly from **inside** the backend container:
   `curl -o /dev/null -w '%{http_code}' http://stream-service:8888/cam_<id>/index.m3u8`. A persistent
   500 with `readers > 0` and `readyTime` older than 2 min is exactly the case Phase 2 of the
   watchdog resets. If the watchdog isn't acting, check the per-camera 5-minute and per-NVR 30-second
   cooldowns.
3. **Frames-in-error.** `framesInError` climbing (health table) or
   `drisyam_camera_frames_in_error_per_second` above ~5/s means corrupt RTP — usually a NAT or a
   camera mangling packets. Above 50/s the quality service heals automatically; if healing doesn't
   clear it, it's the camera or the path, not us.
4. **Sub-stream lie.** If the tile is a grid tile, it's probably on `cam_<id>_sub`. That path can be
   configured (from `deriveSubPath`) but point at a channel the camera doesn't actually serve — the
   path exists, is never ready, and the tile is black. Verify with
   `/v3/paths/get/cam_<id>_sub` and by `ffprobe`-ing the derived sub URL directly. If the vendor's
   convention doesn't apply to this model, the fix belongs in `deriveSubPath` or in the camera's
   stored `path`.
5. **WebRTC-only blackness.** `streamRegistry.js` always negotiates
   `${WHEP_BASE}/cam_<monitorId>/whep` — it **ignores** the `webrtcUrl` the API returned. So for an
   H.265 camera the operator's WebRTC attempt targets the raw H.265 path, fails or shows nothing,
   and falls back to HLS via the one-way latch. If WebRTC is black but HLS plays, this is why.
6. **Browser side.** hls.js fatal errors are logged and trigger `evictStream` + up to 5 retries; a
   `low` quality that keeps failing latches `fallbackToMainRef` and switches to the main URL. Check
   the console before blaming the server.

### 11.3 …apply a change to path configuration for cameras that already exist

This catches everyone. `addCamera()` only runs when a path is **missing**. Changing `RECORD_SUB`,
`SOURCE_ALWAYS_ON`, `RECORD_CONTINUOUS`, or the code in `addCamera()` does **not** rewrite existing
paths.

1. Restart the backend so it picks up the new env/code.
2. Wait ~60 s for the watchdog's first pass to be live (it boots with a 60 s delay).
3. Restart the media server. Every path is wiped; the next watchdog cycle re-adds them all with the
   new config.
4. Verify: `/v3/config/paths/list` and confirm the field you changed.

If you only need retention changed, don't do any of this — change the DB value and
`streamReconcile` converges within 60 s (or call `applyRetention`).

---

## 12. Gotchas

**The NVR concurrent-session ceiling is the real capacity limit, and re-add storms make it worse.**
Entry-level recorders serve a handful of simultaneous RTSP sessions. Every mechanism that "fixes" a
camera — a heal PATCH, a watchdog path cycle, a re-add after a restart, a grid of tiles all
negotiating at once — costs a session on the *shared* recorder. Do them simultaneously and the NVR
drops healthy channels, which the supervisor sees as more cameras failing, which arms more heals.
That feedback loop is why there are per-NVR rate limits in **three** independent places
(`streamQuality._nvrReconnectAt` 30 s, `recordingSync._nvrResetAt` 30 s, and the frontend's
`RESUME_STAGGER_MS` 200 ms on tab-resume), plus exponential heal backoff with jitter, plus
quarantine. If you add a new intervention, it needs a per-host limit too. The standing operational
rule from the 2026-07-06 incident is **≤6 concurrent pulls per NVR and never record-all**.

**Group credentials override camera credentials — in the watchdog, but not in `startStream`.**

```js
// recordingSync.buildCamConfig(camera)
host: group?.host ?? camera.host,  port: group?.port ?? camera.port,
path: camera.path,                                       // path is ALWAYS the camera's
username: group?.username ?? camera.username, password: group?.password ?? camera.password,
```

But `stream.service.startStream()` builds its config from `camera.*` **only**. So a camera whose row
has stale credentials will stream fine right after a watchdog re-add (group creds) and fail when a
user clicks it (camera creds) — or the reverse. `playback.controller` uses the group-first form.
`cameraGroup.controller.updateGroup` does propagate host/port/username/password down to camera rows
when they change, so this normally stays consistent; it diverges when rows are edited directly or a
migration touches one side.

Related: the reachability prober keys on **`camera.host`**, while `buildCamConfig` pulls from
**`group.host`**. If they ever disagree, a camera can be probed at one address and pulled from
another.

**Restart order matters: backend first, then the media server.** Restarting the media server wipes
every path and the watchdog restores them; restarting the backend is what picks up new env/code.
Doing the backend *second* means its watchdog re-registers paths into an instance you are about to
wipe, and you wait for another cycle. Also, the backend's watchdog has a **60 s boot delay** — bounce
the media server before that and the blackout is 60 s + up to 2 min. And transcoder ffmpeg processes
give up after `MAX_RESTARTS` (5, ≈45 s of attempts), so a media-server outage longer than that
leaves H.265 cameras without a transcode until someone opens them again.

**`sourceOnDemandCloseAfter` is 20 s, not the 5 minutes its comment claims.** See §4.2. The
neighbouring comment also documents a key (`rtspReadTimeout`) that isn't set at all.

**`hlsAlwaysRemux: yes` and `sourceOnDemand: true` pull in opposite directions.** Always-remux tells
the media server to keep HLS muxers running independently of readers, while every camera path is
on-demand. The exact interaction is version-dependent and this repo contains no test that pins it —
if you are reasoning about how long a pull actually lasts, **measure it** (watch `bytesReceived` and
`readers` on `/v3/paths/get/cam_<id>` after the last viewer leaves) rather than trusting either
setting's name.

**The AI service is a permanent reader.** An AI-enabled camera holds
`rtsp://mediamtx:8554/cam_<id>` open continuously, which makes that camera effectively always-on.
Enabling AI on many cameras behind one NVR is functionally identical to enabling `RECORD_SUB` — it
just doesn't look like a recording setting. Count AI cameras against the ≤6-per-NVR budget.

**Changing a group's `deviceType` doesn't rewrite existing cameras' RTSP paths.**
`updateGroup` only propagates host/port/username/password to camera rows; `camera.path` was built
from the old vendor's template at creation time and stays. New channels added afterwards use the new
vendor. You'll get a group with two different path conventions and no error.

**Dahua playback timestamps are sent as UTC in a device-local format.** `fmtDahua()` formats
`getUTC*` values into Dahua's `YYYY_MM_DD_hh_mm_ss` field, which the device interprets in its own
timezone. On a device that isn't on UTC, the returned footage is offset by the device's UTC offset.
Hikvision's format carries an explicit `Z` and is unambiguous.

**Committed credentials.** `stream-service.yml`'s `authInternalUsers` block, the
`MEDIAMTX_API_USER` / `MEDIAMTX_API_PASS` Joi **defaults** in `src/config/env.js`, and the
`smart-cam-transcoder` environment block in `docker-compose.drisyam-original.yml` all carry the same
hardcoded control-API password in the repository. Rotate it and set the env vars explicitly in every
deployment; do not rely on the defaults. Note that the media server's `authInternalUsers` also grants
`user: any` anonymous `read` — combined with the disabled `auth_request` (§8.5), the media plane is
currently unauthenticated.

---

## 13. Known rough edges

These are real, verified defects or debts. None is fatal; all will cost you time if you meet them
without warning.

1. **Two streaming unit-test suites are broken by the `MediaMTXEngine → StreamServiceEngine`
   rename.** Verified by running them:
   - `test/streaming.engine.test.js` — `Cannot find module '../src/services/streaming/MediaMTXEngine'`;
     the suite fails to load, so ~15 assertions about path naming, RTSP URL building and retry
     classification currently run zero times.
   - `test/streaming.factory.test.js` — two failures: it expects `createEngine().engineName === 'mediamtx'`
     but `StreamServiceEngine` sets `_engineName = 'stream-service'`. The *registry key* is still
     `mediamtx`; only the engine's self-reported name changed.

   The fix is mechanical (update the require path; assert on the registry key or on
   `'stream-service'`), and it should be done before anyone trusts `collectCoverageFrom:
   ['src/services/streaming/**/*.js']` in `jest.config.js`.

2. **The watchdog is not pool-aware.** `recordingSync.runWatchdog()` re-adds via the
   `drishyamStreaming` singleton, which is bound to the env-default media server
   (`config.streamService.apiUrl`). In a multi-server deployment (`mediamtx_servers` populated),
   the watchdog will re-register every camera on the default server regardless of
   `camera.mediamtxServerId`. The same is true of `stream.service.startStream()`. Only
   `streamRouter` (used by bulk import) and `streamSupervisor`/`streamReconcile` (which read from
   all servers) are pool-aware. Multi-server is therefore not production-ready today.

3. **Two path-config builders exist and can drift.** `StreamServiceEngine.addCamera` and
   `streamRouter.addCamera` build near-identical configs with independently written comments; the
   router additionally sets `recordDeleteAfter` from resolved retention while the engine hardcodes
   `'0s'` and relies on the watchdog/reconcile to fix it afterwards. `streamRouter.recordConfig()`
   still hardcodes `recordDeleteAfter: '0s'` and is only reachable when `RECORD_CONTINUOUS=1`.

4. **`masterUrl` is hardcoded to `null`** in `stream.controller.startStream`, so ABR is built,
   tested-by-hand, and unused (§8.3).

5. **`cameraHealth.classify()` checks `camera.status === 'standby'`**, but the `Camera.status`
   Sequelize enum only has `'online' | 'offline'`. That branch is dead; the live signal comes from
   `supervisorState`.

6. **`vendors.nvrInterface()` has no call site** and its `recordings` note is now inaccurate
   (§10.1).

7. **Doc/value drift in comments**: `recordingSync`'s header says "15-min MP4 segments" while
   `RECORDING_SEGMENT_DURATION` defaults to `10m0s`; `stream-service.yml`'s on-demand comments
   describe values that aren't set (§4.2). Believe the code, not the prose next to it.

8. **The orphan pass is safe for sidecar paths only by accident, not by design.** The suffix strip
   is `name.slice(4).replace(/_(sub|clean)$/, '')` — it knows about exactly two suffixes, and
   `_h264` / `_sub_h264` / `_low_h264` are not among them. They survive because of an **implicit
   invariant**: every sidecar path is *published* dynamically over RTSP under the `all_others`
   wildcard (backend `transcoder.service.js` uses `-f rtsp`; `smart-cam-transcoder/app/transcoder.py`
   likewise only builds RTSP URLs and uses the control API to *read*), so they never appear in
   `/v3/config/paths/list`, which is the only list the orphan pass walks. `_clean` is in the regex
   despite that — belt and braces, or a leftover from an earlier design. Nothing states or tests
   this invariant. If you add a format that **registers** its path through the config API, it will be
   seen as an orphan and deleted every two passes unless you add its suffix here (§8.6, step 3).

---

## 14. Reference

### 14.1 Environment variables

Names only — never commit values.

**Connection**

| Variable | Purpose |
|---|---|
| `STREAM_SERVICE_API_URL` (fallback `MEDIAMTX_API_URL`) | Control API base, e.g. the `:9997` endpoint |
| `STREAM_SERVICE_API_USER` / `_API_PASS` | Control API basic auth |
| `STREAM_SERVICE_HLS_URL` | Browser-facing HLS base |
| `STREAM_SERVICE_INTERNAL_HLS_URL` | Container-internal HLS base used by the watchdog's muxer probe and every warmup. Falls back to `STREAM_SERVICE_HLS_URL` — which is usually a host port-map that is **unreachable from inside the backend container**, silently killing both. Set it explicitly. |
| `STREAM_SERVICE_WEBRTC_URL` | Browser-facing WHEP base |
| `STREAM_SERVICE_RTSP_HOST` / `_RTSP_PORT` | Internal RTSP for transcoders and AI |
| `STREAM_SERVICE_RECORDINGS_DIR` | Shared recordings volume mount inside the backend |
| `STREAMING_ENGINE` | Engine key (`mediamtx`) |
| `MEDIAMTX_RTSP_BASE` | Used by `playback.controller` for the ffmpeg publish target |

**Ingest / recording behaviour**

| Variable | Default | Effect |
|---|---|---|
| `SOURCE_ALWAYS_ON` | off | Keep sources connected without recording |
| `RECORD_CONTINUOUS` | off | Always-on **and** 24/7 main-stream recording — known to saturate remote NVRs |
| `RECORD_SUB` | off | Record the sub-stream (forces its source always-on) |
| `RECORD_DELETE_AFTER` | `168h` | Sub-stream recording retention |
| `RECORDING_SEGMENT_DURATION` | `10m0s` | Segment length |
| `RECORDING_STITCH_BELOW_SEC` | `120` | Below this, segments are stitch candidates |
| `RECORDING_MAX_BUFFER_MB` | `256` | Above this, no buffered upload fallback |
| `RECORDING_UPLOADED_CACHE_MAX` | `50000` | Upload-dedup cache bound |
| `RECORDING_PLAY_URL_TTL_SEC` | `14400` | Presigned playback URL lifetime |
| `DEFAULT_RETENTION_DAYS` | `30` | Bottom of the retention hierarchy |
| `S3_RETENTION_ENABLED` / `_DELETE` / `_GRACE_DAYS` / `_MAX_DELETE_PER_RUN` / `_INTERVAL_MS` | off / dry-run / 1 / 20000 / 24 h | Durable-copy retention sweep |

**Loops and guard rails**

| Variable | Default | Loop |
|---|---|---|
| `SUPERVISOR_POLL_MS` | `2000` | supervisor tick |
| `SUPERVISOR_MIN_BPS` | `20000` | healthy-bitrate floor |
| `SUPERVISOR_DEGRADED_AFTER_MS` / `_OFFLINE_AFTER_MS` | `20000` / `40000` | debounce windows |
| `SUPERVISOR_FLAP_LIMIT` / `_FLAP_WINDOW_MS` / `_QUARANTINE_MS` | `5` / `120000` / `300000` (prod compose overrides to `4` / `120000` / `600000`) | quarantine |
| `SUPERVISOR_LEADER_TTL_MS` | `15000` | Redis leader lock |
| `CAMERA_PROBE_INTERVAL_MS` / `_TIMEOUT_MS` / `CAMERA_PROBE_PORT` | `25000` / `5000` / `554` | reachability |
| `QUALITY_HEAL_AFTER_MS` | `30000` | stuck-connecting heal trigger |
| `QUALITY_HEAL_FIE_RATE` / `_WARN_FIE_RATE` / `_WARN_JITTER_MS` | `50` / `5` / `200` | quality thresholds |
| `QUALITY_HEAL_COOLDOWN_MS` / `_MAX_MS` / `_BUDGET_24H` | `60000` / `900000` / `20` | heal budget |
| `QUALITY_NVR_RECONNECT_MIN_MS` | `30000` | per-NVR heal limit |
| `WATCHDOG_NVR_RESET_MIN_MS` | `30000` | per-NVR path-cycle limit |
| `WATCHDOG_ORPHAN_CLEANUP` / `_PASSES` / `_SKIP` | on / `2` / `demo-entrance` | orphan reconciliation |
| `RECONCILE_ENABLED` / `_INTERVAL_MS` / `_CONCURRENCY` / `_DEBOUNCE_MS` | on / `60000` / `8` / `1500` | retention reconcile |
| `TRANSCODER_ALLOW_HW` / `_MAX` / `_STALL_MS` / `_IDLE_MS` / `_CHECK_MS` / `_QUEUE_WAIT_MS` | off / `8` / `30000` / `60000` / `15000` / `10000` | transcoders |
| `GRID_LOW_TRANSCODE_MAX` / `_COOLDOWN_MS` | `2` / `15000` | background low-variant warmup |
| `PREFER_MAIN_STREAM` | off | Stop preferring the sub as the primary live view |
| `STREAM_URL_SECRET` / `STREAM_URL_TTL_SEC` | unset / `3600` | media-plane token auth |

### 14.2 HTTP surface

| Method + path | Purpose |
|---|---|
| `GET /api/stream/start/:monitorId?quality=auto\|high\|low` | Ensure paths, warm muxers, return `{ webrtcUrl, hlsUrl, hlsSubUrl, masterUrl, codec, transcoded }` |
| `GET /api/stream/stop/:monitorId` | Remove main + sub paths and kill transcoders (cleanup/testing) |
| `GET /api/stream/status/:monitorId` | Status + URLs |
| `GET /api/stream/master/:monitorId/index.m3u8` | ABR master playlist |
| `POST /api/stream/watchdog/run` | Force an immediate watchdog cycle |
| `GET /api/stream/verify` | nginx `auth_request` target (no JWT — the cookie is the authorization) |
| `GET /api/cameras/health` | Operator health table (owner-scoped) |
| `GET /api/cameras/:monitorId/quality` | Jitter / FIE / readers / heal log + supervisor entry |
| `POST /api/cameras/:monitorId/heal` | Manual heal (still honours budget + per-NVR limit; returns 409 when refused) |
| `POST /api/cameras/:monitorId/keyframe` | Same mechanism, different metric label |
| `POST /api/groups/:groupId/quality` | Group default stream quality |
| `POST /api/groups/:groupId/cameras/:monitorId/quality` | Per-camera override |
| `POST /api/groups/:groupId/cameras/quality` | Bulk override |
| `POST /api/playback/nvr/start` \| `/stop` | NVR replay session lifecycle |
| `GET /api/internal/cameras` | Camera registry + RTSP egress URLs for AI workers |
| `GET /api/metrics` | Prometheus scrape (IP-allowlisted in nginx) |

### 14.3 Media-server control endpoints used by this codebase

| Endpoint | Used by |
|---|---|
| `POST /v3/config/paths/add/<name>` | `addCamera`, `addCameraSubStream`, `streamRouter.addCamera` |
| `PATCH /v3/config/paths/patch/<name>` | idempotent fallback, `patchPath` (retention), `streamQuality.heal` |
| `DELETE /v3/config/paths/delete/<name>` | `removeCamera`, orphan cleanup, NVR playback stop |
| `GET /v3/config/paths/list?page&itemsPerPage` | watchdog (configured paths), retention reconcile |
| `GET /v3/config/paths/get/<name>` | `streamQuality.heal` (read-before-patch) |
| `GET /v3/paths/list?page&itemsPerPage` | supervisor, watchdog (readiness), camera health |
| `GET /v3/paths/get/<name>` | readiness/codec/reader probes throughout |

**Always paginate.** These endpoints default to 100 items. The comment on
`StreamServiceEngine._listAllPages` explains why a truncated read is worse than a failed one: each
camera owns two paths, so page 1 covers ~50 cameras, and the watchdog treats every path it cannot
see as *missing* — re-adding it every cycle, which tears down and re-opens the RTSP source, which is
a permanent reconnect storm against the NVR.
