# Phase 4 — SFU migration design

## TL;DR — the decision

**Use LiveKit, not mediasoup, not Janus, not ion-sfu.** Self-hosted, single LiveKit server in dev → LiveKit Cluster (multi-region) at scale. Each camera becomes a LiveKit *room*; each operator becomes a *subscriber* to one or more rooms; a thin Python bridge service (`smart-cam-sfu-bridge`) is the *publisher* — it reads RTSP from MediaMTX and republishes into LiveKit per camera.

MediaMTX **stays** as the RTSP ingest + recording broker. We add the SFU above it, not replace it. The bridge is the only new moving part on the server side; the SPA gets a `LiveKitPlayer` alongside the existing `DirectStreamPlayer`, switchable per camera by feature flag.

This doc is the architecture + migration plan for the multi-week build. The infrastructure scaffolding (LiveKit container, JWT mint endpoint, frontend service) ships this session; the actual player wiring + per-camera rollout happens next session.

---

## Why an SFU at all

MediaMTX's WebRTC is **point-to-point**: each viewer opens its own ICE connection straight to MediaMTX, which spawns one RTP source per session against the camera. With:

- 2,000 cameras
- 10 concurrent operators
- average 9 cameras per operator (MonitorWall grid)

… the worst-case fanout is 90 ICE sessions per active camera and 2,000 × 9 = **18,000 simultaneous WebRTC sessions** on the server. MediaMTX's WebRTC engine isn't designed for that — it's a "broker that supports WebRTC", not "a WebRTC SFU". CPU and memory pressure scale per-session linearly.

An SFU solves this with a one-to-many model:

```
camera → one ingress → SFU → N egresses (N viewers)
```

The SFU keeps **one decode + jitter buffer + congestion-control loop per source**, and just forwards RTP packets to subscribers. CPU scales with sources × bitrate, not sources × viewers.

At our scale (40 cameras, < 5 concurrent operators today) we don't need it yet. At 2k cameras / 10 operators, it's structural.

---

## Why LiveKit (vs mediasoup, Janus, ion-sfu)

| Criterion | LiveKit | mediasoup | Janus | ion-sfu |
|---|---|---|---|---|
| Language | Go | Node + C++ | C | Go (Pion) |
| Operating story | Single binary, clear config | Library, BYO server | Compile from source, verbose config | Library + reference server |
| Native WHIP / WHEP | ✅ (publisher uses WHIP) | ✅ via plugin | ✅ via plugin | ✅ |
| RTSP ingest built-in | ✅ (RTSP source per room) | ❌ (bring your own bridge) | Partial | Partial |
| TURN bundled | ✅ | ❌ | ❌ | ❌ |
| Cluster / multi-region | ✅ (LiveKit Cluster) | Manual | Manual | Manual |
| Managed cloud option | ✅ (LiveKit Cloud) | ❌ | ❌ | ❌ |
| Browser SDK quality | ✅ (typed, well-maintained) | OK | Manual | OK |
| Production users | OpenAI Realtime, Spotify, Reddit | Hopin, Around | Many academic / WebRTC research | Smaller community |
| Community + docs | Best | Good | Verbose | Smaller |
| Fit with drisyam's stack | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |

**Decision**: LiveKit. The operating story is the deal-breaker — we don't want to write a Janus config from scratch or build the RTSP→SFU bridge that mediasoup makes you build yourself. LiveKit's `Ingress` model (push RTSP → SFU publishes as a participant) maps directly to our need.

If LiveKit Cloud's pricing ever becomes interesting compared to self-hosting bandwidth, we already speak the right SDK and can flip with no code changes.

---

## Target architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Camera RTSP stream                                                      │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    ▼
                            ┌─────────────────┐
                            │  MediaMTX       │  (unchanged — RTSP capture,
                            │  • RTSP ingest  │   HLS, recording, AI ingest)
                            │  • HLS muxer    │
                            │  • Recording    │
                            └────┬────────────┘
                                 │
                                 │ RTSP egress (cam_<id>) — read by:
              ┌──────────────────┼─────────────────────────────────┐
              │                  │                                  │
              ▼                  ▼                                  ▼
       smart-cam-ai      smart-cam-transcoder              smart-cam-sfu-bridge
       (face detection,  (Phase 3 — optional               (Phase 4 — NEW
        recording trigger)  NVENC cleanup)                    publishes per-camera
                                                              streams into LiveKit
                                                              as a participant)
                                                              │
                                                              ▼
                                                         ┌─────────────┐
                                                         │  LiveKit    │
                                                         │  • SFU      │
                                                         │  • TURN     │
                                                         │  • Cluster  │
                                                         └─────┬───────┘
                                                               │
                                                               │ WebRTC subscribe
                                                               │
                                                               ▼
                                                        Operator browsers
                                                        (LiveKit JS SDK)
```

**Per-room model**:

- One LiveKit *room* per camera, name `cam_<monitor_id>`
- One *publisher participant*: the bridge service, identity `bridge`
- N *subscriber participants*: operators, identity `<user_id>`

We **don't** put multiple cameras in one room. Easier ACL (operator either has access to that camera or doesn't), easier scaling (subscribers pull only what they need), no fanout overhead from cameras nobody watches.

**Migration strategy** — feature flag per camera, same shape as Phase 3:

```js
camera.settings.sfu = { enabled: true }
```

When `enabled`: SPA uses `LiveKitPlayer` for that camera; bridge keeps the room populated. When `enabled: false` (default): SPA uses existing DirectStreamPlayer hitting MediaMTX WHEP directly. **Zero behavioural change** for cameras with the flag off — Phase 4 ships invisibly until operators opt cameras in.

---

## Why the bridge service vs LiveKit's built-in RTSP Ingress

LiveKit's `Ingress` resource lets you POST an RTSP URL and LiveKit's ingress worker pulls it and republishes inside the room. That's the easy path.

We're building a custom bridge anyway because:

1. **Per-camera lifecycle control**. Bridge starts/stops based on the `settings.sfu.enabled` flag on each Camera row + observed subscriber count. LiveKit's Ingress isn't quite that fine-grained.
2. **Codec normalisation handoff**. When Phase 3 transcoding is also enabled on a camera, the bridge reads `cam_<id>_clean` instead of `cam_<id>`. Plain Ingress would need separate config per pathing variant.
3. **Failure isolation**. Bridge crashes don't take down LiveKit's worker pool; an Ingress failure on shared LiveKit could.
4. **Metrics**. We want per-camera publish-rate, bitrate, ICE failure rate surfaced into Prometheus alongside the Phase 2.1 dashboard. Custom bridge lets us emit those directly.

The bridge is small: ~300 lines of Python — `livekit-server-sdk` plus FFmpeg for RTSP → WebRTC packetisation, or use [livekit-rtsp](https://github.com/livekit/livekit-rtsp) helper. We'll write the simple version first and swap to the helper if it pulls weight.

---

## What ships in this session (foundation)

The MASSIVE asterisk on Phase 4 is *the actual player migration is risky and big*. We're not doing it today. Today we put in place everything that makes the migration a clean per-camera flip later.

| # | Item | This session | Next session |
|---|---|---|---|
| 4.0 | `docs/PHASE-4-SFU-DESIGN.md` (this doc) | ✅ | — |
| 4.1 | LiveKit container in docker-compose.yml | ✅ | — |
| 4.2 | Backend `POST /api/livekit/token` — JWT mint for subscribers | ✅ | — |
| 4.3 | Frontend `services/livekit.js` — fetch token + create Room | ✅ | — |
| 4.4 | `smart-cam-sfu-bridge` Python service skeleton + Dockerfile | ✅ (skeleton only) | finish RTSP→LiveKit publish loop |
| 4.5 | `LiveKitPlayer.jsx` component | — | ✅ wire to streamRegistry |
| 4.6 | `streamRegistry` extension to support SFU rooms | — | ✅ |
| 4.7 | Backend admin endpoint `PATCH /api/admin/cameras/:id/sfu` | — | ✅ |
| 4.8 | First-camera rollout + soak test | — | ✅ |
| 4.9 | Per-room observability in Grafana | — | After 4.8 |

---

## Migration plan (production rollout, when ready)

1. **Dev soak (1 week)** — one camera flagged SFU-enabled. Operators watch via LiveKitPlayer for a full week. Compare jitter, freezes, startup latency against the MediaMTX WHEP baseline using Phase 2.1 metrics.
2. **Office 12 wave (1 week)** — flip 17 cameras in Office 12 to SFU. The remaining 8 Office 13 cameras stay on MediaMTX WHEP as control group.
3. **Office 13 wave (1 week)** — remaining cameras flip. MediaMTX WHEP becomes dead code path on cameras that opted in.
4. **MediaMTX WHEP deprecation (1 week)** — once 100% on SFU and metrics stable, document the WHEP code path as legacy. Don't delete — keep as fallback for next month, then remove.

Total: ~4 weeks of careful rollout *after* the infrastructure ships next session.

---

## Failure modes we plan for

| Scenario | Mitigation |
|---|---|
| LiveKit container down | Per-camera flag — operators on SFU-flagged cameras see "Reconnecting..." for 30 s, then auto-fallback to MediaMTX WHEP if bridge sees LiveKit unreachable. Cameras not flagged keep working unchanged. |
| Bridge crashes for one camera | LiveKit's subscriber sees the publisher leave the room. SPA shows "Camera reconnecting...". Bridge supervisor (same pattern as transcoder) respawns within 5 s. |
| Operator JWT expires mid-watch | LiveKit kicks the participant. SPA's `LiveKitPlayer` re-fetches a token from `/api/livekit/token` and re-joins. Pattern matches Phase 1.4 TURN cred refresh. |
| LiveKit upgrade needs Cluster mode | Switch the `LIVEKIT_HOST` env from `ws://livekit:7880` → `wss://livekit-cluster.indyatools.com:7880`. Zero code changes. |
| MediaMTX RTSP unreachable from bridge | Bridge's publish loop sees the RTSP source 404 → backs off, retries. LiveKit room stays empty; SPA sees no participant → "no source" state. Same as MediaMTX WHEP behaviour today. |

---

## Cost model

### Bandwidth

The big question: how does SFU egress bandwidth compare to MediaMTX WHEP today?

| Topology | Server egress per operator-grid (9 cams × 2 Mbps) |
|---|---|
| MediaMTX WHEP (today) | 9 × 2 Mbps × 1 operator = 18 Mbps **per operator** |
| LiveKit SFU | 9 × 2 Mbps × N operators where N is # subscribers per camera |

If N = 1 (one operator per camera-grid combination), bandwidth is identical. **SFU only wins when there are multiple subscribers per camera.** With 10 operators all watching some-but-not-all overlapping cameras, the SFU saves bandwidth proportional to subscriber-overlap.

### Compute

| Component | drisyam today | After Phase 4 |
|---|---|---|
| MediaMTX per session | ~30 MB RAM + ~5% of 1 vCPU per WebRTC viewer | unchanged for non-flagged cameras |
| LiveKit | n/a | ~150 MB base + ~10 MB per active room + ~5 MB per subscriber |
| Bridge | n/a | ~100 MB per running publisher (FFmpeg subprocess for the RTSP pull) |

At 40 cameras + 5 operators, total LiveKit footprint is ~1 GB RAM, < 10% of one vCPU. At 2k cameras + 50 operators, expect ~30 GB RAM and ~4 vCPU on the LiveKit node — manageable on a single mid-spec node.

### GPU

**Zero new GPU cost from Phase 4.** LiveKit forwards RTP packets; no encode/decode. The transcoder (Phase 3) still owns all GPU encoder slots; the bridge consumes RTSP and republishes without re-encoding.

---

## Cross-references

- [STREAMING-IMPROVEMENT-PLAN.md](STREAMING-IMPROVEMENT-PLAN.md) — Phase 4 in the broader roadmap
- [STREAMING-WORLD-CLASS-MAP.md](STREAMING-WORLD-CLASS-MAP.md) — why SFU sits where it does in the modern streaming stack (Part 3, "Reference 2: Zoom / Google Meet")
- [smart-cam-transcoder/docs/ARCHITECTURE.md](../media/transcoder/docs/ARCHITECTURE.md) — Phase 3 pattern that Phase 4's bridge service mirrors
