# Streaming improvement plan — phased

The current streaming engine has accumulated 3 months of "feature first, engine later" debt. This doc breaks the cleanup into four phases. Each phase has a clear deliverable, a measurable success criterion, and an effort estimate, so we can ship + measure before deciding the next phase is worth it.

**The decision the user committed to** (2026-05-27):
- We will run **our own TURN server** (coturn) for predictable WebRTC behaviour behind corporate firewalls. Item #6 in the audit became Phase 1.4.

---

## Why phasing matters here

Some of the items in the audit are **1-day fixes that affect every camera immediately** (camera-side GOP + CBR + sub-stream). Others are **multi-week architecture shifts** (SFU migration). Mixing them gives us nothing for the first two weeks then everything at once — wrong for an operator who's already frustrated. Phasing ships the cheap wins first so people feel improvement in week 1, then uses the new observability (Phase 2.1) to decide whether the expensive phases are even worth doing.

---

## Phase 1 — Cheap wins (target: 1 week)

The fixes that don't require new infrastructure decisions. Every item here is reversible in one config change.

| # | Item | Effort | Risk |
|---|---|---|---|
| 1.1 | Camera-config sweep — push GOP=2s, CBR, enable sub-stream across every Camera row | 1 day | Low (camera-side, per-camera rollback) |
| 1.2 | Frontend picks main vs sub stream based on tile size + `navigator.connection.downlink` | 2 days | Low (purely client-side) |
| 1.3 | MediaMTX `sourceOnDemandCloseAfter` / `sourceOnDemandStartTimeout` tuning for hot-path pre-warm | 0.5 day | Low (single config change) |
| 1.4 | Deploy coturn on 103.109.7.37 + backend REST-auth TURN creds endpoint | 1 day | Medium (firewall + UDP port range) |

**Success criteria** (measure before + after on the same camera set):
- Live View first-frame latency drops from 3–6 s to < 1.5 s
- MonitorWall (9-camera grid) bandwidth usage drops > 70% on a 5 Mbps downlink
- WebRTC connection success rate behind a corporate firewall ≥ 95% (with TURN)
- Zero camera config rollbacks needed (every camera survives the sweep)

**What does NOT happen in Phase 1**: any change to MediaMTX itself, any GPU work, any new microservice.

---

## Phase 1.4 details — TURN architecture decision

coturn needs a **publicly reachable IP** for clients behind NAT to connect to it. Cloudflare Tunnel only forwards HTTP/HTTPS, not arbitrary UDP, so coturn can't live on the home dev machine.

The right home for coturn is the existing `103.109.7.37` server (where nginx + the frontend already live). It already has a public IP and is in the operator's control. Concrete deployment:

```
client browser
   │
   │  RTCPeerConnection with iceServers: [
   │      { urls: 'turn:turn.indyatools.com:3478', username: <X>, credential: <Y> }
   │  ]
   ▼
103.109.7.37:3478 (UDP)  ←  coturn (Docker container on the prod server)
   │
   │  authenticates via REST credentials (time-limited HMAC of username)
   ▼
relays media UDP between client ↔ MediaMTX
```

Backend addition: `POST /api/turn/credentials` returns time-bound TURN credentials. The username encodes an expiry (`<unix-ts>:<userId>`), the credential is `HMAC-SHA1(secret, username)` (the coturn REST-API auth scheme — RFC 7635-ish, but the de-facto coturn one).

Firewall ports to open on 103.109.7.37:
- `3478/udp` (STUN/TURN)
- `5349/tcp` (TLS fallback for restrictive networks)
- `49152–65535/udp` (relay range — narrow this if hosting cost matters)

DNS: `turn.indyatools.com` → A record → 103.109.7.37.

We do NOT need a Cloudflare tunnel for coturn; we want direct UDP for low latency.

---

## Phase 2 — Observability + LL-HLS (target: 1 week)

Now we can SEE per-camera quality. The big unknown today is "is camera X bad, or is the operator's wifi bad?". Phase 2 settles that.

| # | Item | Effort | Risk |
|---|---|---|---|
| 2.1 | Per-camera bitrate + jitter + packet-loss → Prometheus → Grafana board | 2 days | Low (additive) |
| 2.2 | Enable MediaMTX LL-HLS (CMAF + partial segments) + hls.js client fallback | 2 days | Medium (config-driven, but new code path) |
| 2.3 | WebRTC jitter-buffer tuning per network class — uses telemetry from 2.1 | 3 days | Medium (per-class A/B) |

**Success criteria**:
- Grafana board lists every camera with last-15-min bitrate / jitter / packet-loss / drop rate
- LL-HLS glass-to-glass latency ≤ 1.5 s on Safari/iOS
- p90 jitter visible-to-operator drops by 40% vs Phase 1 baseline

Once we have 2.1 we can prove or disprove the value of Phase 3 / Phase 4 with data.

---

## Phase 3 — NVENC transcode for problem cameras (target: 2 weeks)

For the subset of cameras that emit awkward H.264 (long GOP we can't override, B-frames, weird profiles), normalise via FFmpeg+NVENC to baseline H.264 / 1s GOP / fragmented MP4. Each transcoded stream costs ~1 GPU encoder slot.

| # | Item | Effort | Risk |
|---|---|---|---|
| 3.1 | Transcoder service: takes camera RTSP, outputs MediaMTX-publishable stream | 4 days | High (GPU resource contention) |
| 3.2 | Auto-detect bad cameras (from 2.1 data) and route them through the transcoder | 3 days | Medium |
| 3.3 | Capacity planning: 1 encoder slot per camera × N cameras × GPU model SKU | 1 day | Budget gate |

**Effort note**: only worth doing once Phase 2.1 data shows we have a meaningful set of "bad camera" outliers. If 95% of cameras work fine after Phase 1, skip Phase 3 entirely.

---

## Phase 4 — SFU migration (target: 3 weeks, optional)

For 2k-camera scale, replace MediaMTX's point-to-point WebRTC with a real SFU (mediasoup or LiveKit). Each camera publishes once; the SFU fans out to every viewer.

| # | Item | Effort | Risk |
|---|---|---|---|
| 4.1 | Spike LiveKit + mediasoup; pick one based on resource cost + ops complexity | 3 days | Low |
| 4.2 | Bridge from MediaMTX RTSP into the SFU (whip-publisher pattern) | 1 week | High |
| 4.3 | Frontend migration to the SFU SDK (replaces direct WHEP) | 1 week | Medium |
| 4.4 | Rollout with feature flag: per-tenant SFU vs legacy MediaMTX-WHEP | 3 days | Medium |

**Effort note**: irrelevant at 40 cameras. Becomes critical at ≥ 500 cameras with > 5 concurrent viewers per camera. The 2k-camera college deployment is the trigger.

---

## Open questions / decisions deferred

1. **TURN cost** — coturn relay traffic counts as outbound from 103.109.7.37. At 2k cameras × 10 concurrent operators × 2 Mbps WebRTC = ~40 Gbps theoretical max. We won't hit that, but we need to set a sensible per-IP bandwidth cap in coturn config.
2. **LL-HLS vs WebRTC for mobile** — Safari's LL-HLS is native and rock-solid. We may end up routing mobile to LL-HLS and desktop to WHEP. Decided after Phase 2 data.
3. **AV1 / H.265** — defer. AV1 encoding is too slow today, H.265 browser support is patchy.
4. **WebTransport** — exciting (sub-100ms glass-to-glass) but Chrome-only and stability is "experimental". Revisit Q3 2026.

---

## Phase 1 starts today

Order within Phase 1:
1. **`scripts/optimize-cameras-for-streaming.js`** — the camera-config sweep. Safest highest-impact start. (Phase 1.1)
2. **Frontend network-aware quality** — `DirectStreamPlayer` / `WebRTCStream` / MonitorWall use sub-stream when tile is small or downlink is slow. (Phase 1.2)
3. **MediaMTX `sourceOnDemandCloseAfter` tuning** + pre-warm hot cameras. (Phase 1.3)
4. **coturn on 103.109.7.37** + backend TURN credentials endpoint. (Phase 1.4)

Each item is a separate PR so any one can be reverted independently.
