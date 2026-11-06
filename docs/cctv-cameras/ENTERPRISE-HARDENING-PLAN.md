# Camera Subsystem — Enterprise Hardening Plan

> Generated from a multi-agent analysis (8 vendor docs + 6 backend subsystems, May 2026).
> Scope: take the camera ingest/onboarding/resilience stack to enterprise grade for a
> 2,000-camera, mixed-vendor, MediaMTX-only campus (Shinobi removed).

## The headline finding

The vendor docs in `docs/cctv-cameras/` are **model-number *decoding* references** (how to read
`DS-2CD2143G0-I` → "4MP IR dome, gen-1 AcuSense"). They contain **no runtime integration data** —
no RTSP paths, ports, ONVIF endpoints, or channel-name APIs. All integration logic lives in **code**,
and that code covers far fewer vendors than the docs imply.

**Docs cover 8 vendors. Code covers ~3.5.**

### Vendor coverage matrix (as-is)

| Vendor | Documented | RTSP path in code | Probe in code | Name discovery | Notes |
|---|:--:|:--:|:--:|:--:|---|
| **Hikvision** | ✅ | ✅ | ✅ | ✅ | Full. Also the silent default for every unknown device type. |
| **Dahua** | ✅ | ✅ | ✅ | ✅ | Full (main stream only; `hasVideo` not implemented). |
| **Axis** | ✅ | ✅ | ⚠️ | ✅ | Probe hard-coded to single channel; **no** encoder/keyframe/sub-stream writer. |
| **ONVIF/generic** | ✅ | ❌ | ⚠️ | ✅ | **No RTSP path entry** (falls to Hikvision); `generic` returns a fabricated `/stream/N`. |
| **Uniview (UNV)** | ✅ | ❌ | ❌ | ❌ | Zero coverage. Blocked at API allow-lists. Common in Indian campus deployments. |
| **CP Plus** | ✅ | ❌ | ❌ | ❌ | Zero coverage. **Dahua OEM** → cheapest win: alias the Dahua driver. |
| **Hanwha (Wisenet)** | ✅ | ❌ | ❌ | ❌ | Zero coverage. SUNAPI; WiseStream VBR breaks the supervisor's fixed bps thresholds. |
| **Bosch** | ✅ | ❌ | ❌ | ❌ | Zero coverage. Multi-imager (4 sensors / 1 IP) unmodeled. |
| **Honeywell** | ✅ | ❌ | ❌ | ❌ | Zero coverage. ONVIF Profile S/G/T → covered once ONVIF RTSP/XAddr discovery is fixed. |

### Why this is the core problem

Vendor behaviour is scattered across **four drifting switch statements** plus **two duplicated RTSP path
builders**, and the API is gated by **three independent closed allow-lists**:

- `probe()` — `deviceProbe.service.js:335`
- `setEncoderConfig()` — `deviceProbe.service.js:686`
- `setKeyframeInterval()` — `deviceProbe.service.js:711`
- `buildRtspPath()` — `cameraGroup.controller.js:35` (no `onvif` case)
- `buildRtspPath()` — **duplicated** in `bulkImport.controller.js:150`
- `deriveSubPath()` — `mediamtx.service.js:70` (Hik/Dahua only)
- Allow-lists: Joi enum `deviceProbe.controller.js:40`, `CameraGroup.deviceType` enum, `bulkImport SUPPORTED_DEVICE_TYPES`

Adding one vendor means editing **6 places + 3 allow-lists**, and unknown/mislabeled devices **silently
fall back to Hikvision ISAPI** — producing confidently-wrong RTSP URLs and garbage probes with no
operator-visible error.

**The single highest-leverage change is a per-vendor driver registry** that all six call-sites delegate to.
It is the prerequisite for every coverage enhancement below.

---

## Prioritized enhancements

Priority: **P0** = correctness/coverage/security blocker · **P1** = scale/robustness · **P2** = quality · **P3** = strategic.

### P0 — Foundation & coverage (do first)

1. **Per-vendor driver registry** *(L / med risk)* — `src/services/vendors/`. One descriptor per vendor:
   `{ id, displayName, defaultRtspPort, defaultHttpPort, capabilities, buildRtspPath(), buildSubPath(),
   probe(), setEncoder(), setKeyframe() }`. `getDriver(deviceType)` throws `UnsupportedVendorError`
   (no Hikvision fallback). Refactor all four switches + both path builders + `deriveSubPath` to delegate.
   Seed hik/dahua/axis/onvif by moving existing functions verbatim (no behaviour change) to de-risk.

2. **Add Uniview, CP Plus, Hanwha, Bosch, Honeywell drivers** *(L / med)* — open the three allow-lists to
   `Object.keys(registry)`. CP Plus = Dahua alias. Uniview = `/unicast/c{ch}/s0/live` (+ `s1` sub) + ONVIF probe.
   Hanwha/Bosch/Honeywell = ONVIF probe + correct `buildRtspPath` via `GetStreamUri`. Change
   `CameraGroup.deviceType` from a DB enum to a STRING validated against the registry (new drivers need no migration).

3. **Explicit unsupported-vendor errors + raw-RTSP passthrough driver** *(M / med)* — `getDriver` throws →
   HTTP 422 `{code:'unsupported-vendor'}`. Add an `rtsp` driver whose `buildRtspPath` returns a per-camera
   `rawRtspPath` verbatim, so the long multi-vendor tail is always onboardable without code changes.

4. **Encrypt camera/group credentials at rest** *(M / med)* — AES-256-GCM `secretBox` util (`CRED_ENC_KEY`).
   Sequelize getters/setters store ciphertext, decrypt only in-process for RTSP/probe/talkback. Strip
   `password` from all API responses (`toSafeJSON()` → `***`). Migration re-encrypts existing rows. (DPDP requirement.)

### P1 — Scale & robustness

5. **ONVIF rework** *(L / med)* — `GetServices`/`GetCapabilities` XAddr resolution (no hard-coded paths),
   `GetSystemDateAndTime` clock-skew correction, Media2 support, `GetStreamUri`-driven RTSP paths,
   WS-Discovery (`onvifDiscover()`). This is the backbone for Hanwha/Bosch/Honeywell.
6. **ONVIF WS-Discovery / subnet-scan endpoint + queued bulk-onboarding job** *(L / med)* — `POST /api/sites/:id/discover`;
   convert commit to a BullMQ job with progress/resume (CSV-only + synchronous commit won't survive a 2,000-camera run).
7. **Per-camera RTSP override / sub-stream / transport / ONVIF profile-token fields on `Camera`** *(M / low)* —
   backs the `rtsp` passthrough driver and ONVIF `GetStreamUri` cache; stop hardcoding `h264/1920x1080/25fps`.
8. **Vendor/firmware auto-detect** *(M / low)* — `detectVendor()` reconciles probed `Manufacturer` vs declared
   `deviceType`; surfaces a "detected vendor" column in probe + bulk preview to catch mislabeled CSV rows.
9. **Fix split-brain media control plane** *(L / high)* — route **all** CRUD + the recordingSync watchdog through the
   pool-aware `mediamtxRouter` (today only bulkImport does). Decrement/reconcile `current_cams`; write
   `MediaMTXServer.status`/`lastHeartbeat`; make `draining` actually migrate cameras. Without this, a camera on
   server B goes **permanently dark** after B restarts.
10. **PTZ control via the driver registry** *(L / med)* — completely absent today. ONVIF PTZ + Hikvision ISAPI
    `PTZCtrl` + Dahua `ptz.cgi` + Axis VAPIX. `POST /api/cameras/:monitorId/ptz/{move,stop,preset}` with audit.
11. **Transactional + idempotent onboarding** *(M / med)* — wrap group + channels + load-increment in a
    `sequelize.transaction()`; move MediaMTX adds post-commit (watchdog-recovered); repair partial groups.
12. **Shard the stream supervisor** *(L / high)* — single-leader `Camera.findAll` every 2 s is a hard ceiling.
    Consistent-hash shard across instances; in-memory camera cache refreshed on events; CASE-based bulk UPDATE;
    poll jitter/backoff; persist flap/heal state to Redis so failover doesn't trigger a heal storm.

### P2 — Quality

13. HTTPS/TLS + per-vendor port handling for all probes/talkback (DPDP encryption-in-transit).
14. ONVIF/SUNAPI/RTSP-backchannel talkback + G.711 a-law + Redis session store + audit + WebSocket transport.
15. Onboarding/credential **audit trail** + optimistic locking (version column → 409 on stale write).
16. Bounded-concurrency batch probing (`probeMany`, per-host backoff) — serial 5 s probes across 2,000 cams is hours.
17. Real **alerting** on heal-budget exhaustion (`STREAM_GIVEUP` → notifier sinks) + bound Prometheus label cardinality.
18. Extend encoder/keyframe + **sub-stream** coverage to Axis and all drivers (grid tiles pull full-res today).
19. Stabilize `s3Path` (derive from immutable `monitorId`, not mutable name) + detect `deviceType`/`httpPort` changes on update.

### P3 — Strategic

20. GPU-aware transcode scheduling, NVENC session accounting, audio passthrough, source-codec probing
    (HW encoders are OFF by default on a Blackwell fleet; `MAX_CONCURRENT=8`).
21. Multi-tenant/organization layer above per-user isolation (today the only boundary is `userId`).
22. `hasVideo` signal-presence for non-Hikvision via ONVIF/RTSP `DESCRIBE` fallback.

---

## Recommended sequencing

**Wave 1 (this is the on-topic core):** #1 driver registry → #2 five new vendor drivers → #3 explicit errors +
raw-RTSP passthrough. This alone closes the documented-vs-coded vendor gap and is a low-risk
"seed-then-extend" refactor (existing vendors move verbatim; new ones are added).

**Wave 2:** #4 credential encryption · #9 split-brain fix · #11 transactional onboarding — the
correctness/security blockers.

**Wave 3+:** discovery/auto-detect (#5, #6, #8), PTZ (#10), supervisor sharding (#12), then the P2/P3 tail.

Each wave is independently shippable and verifiable (`node --check` + container restart + smoke test).
