# Streaming — the physics, the gap, the map

The single most useful thing a streaming team can know is **what they're optimising against** and **what's physically impossible regardless of money**. This doc captures that for drisyam so every future decision about cameras, brokers, players, codecs, or AI inference has a north star.

It is paired with [STREAMING-IMPROVEMENT-PLAN.md](STREAMING-IMPROVEMENT-PLAN.md) — that doc is the phased *what we do*; this one is the *why those constraints exist and how the world's best streaming systems live within them*.

---

## Part 1 — The physics

Three constraints define every decision below. They are not configurable. Buying more hardware doesn't make them go away.

### Constraint 1 — *latency is a budget, not a number*

Glass-to-glass latency is the sum of every queue between the photons hitting the sensor and the photons leaving your monitor.

```
Camera sensor → camera encoder buffer → RTSP / NIC → switch → broker decoder buffer
   ~20 ms       ~30-100 ms (GOP)      ~5 ms       ~1 ms     ~10 ms
                                                                ↓
                                                       SFU / WebRTC packetiser
                                                                ↓
                                                       Network (your network!)
                                                                ↓
client jitter buffer ← decoder buffer ← display refresh    ~30-3000 ms
   ~50-300 ms          ~10 ms           ~16 ms (60Hz)         ← this is the variable one
```

**What you can compress and what you can't:**

| Stage | Floor | Typical CCTV today | What dominates |
|---|---|---|---|
| Camera sensor → first byte | ~20 ms | 50-200 ms | GOP length, encoder profile |
| RTSP → broker | ~5 ms | 30-500 ms | Network between camera and broker |
| Broker decoder + repacker | ~10 ms | 100-500 ms | Buffering for transcode |
| Broker → client | ~10 ms | 50-2000 ms | Network + WebRTC negotiation |
| Client jitter buffer | ~50 ms | 200-1500 ms | Codec choice + browser default |
| Decoder → display | ~16 ms | 16 ms | Fixed |

Floor: **~150 ms glass-to-glass.** That's Twitch / YouTube Live's good day with WebRTC. Live-broadcast TV is around 4 seconds, by choice (CDN ladder). Netflix VOD is unbounded.

CCTV at world-class is the 150-300 ms band. Anything ≥ 1 s is a tuning problem.

### Constraint 2 — *bandwidth is shared, not dedicated*

A 1080p H.264 stream at 30 fps is 3-6 Mbps. Twenty-five cameras × 4 Mbps = 100 Mbps. That's a switch / NIC / WAN constraint. **No codec invents bandwidth that isn't there.** The only levers:

- **Resolution / fps**: lower → bigger room. 480p sub-stream is ~700 kbps.
- **Codec efficiency**: H.265 = 50% of H.264 at same quality. AV1 = 70%. These are real, measured, not vendor-magic.
- **Smarter encoding**: motion-aware bitrate (less bits in static scenes), per-title encoding (per-camera tuning).
- **Don't send what nobody watches**: source-on-demand. *Most of drisyam's "bandwidth pressure" today is paths kept warm with zero subscribers.*

### Constraint 3 — *every viewer pays the encode cost, unless you cache*

Netflix encodes each title once, stores 50 variants on disk, serves billions of plays from a static byte cache.

CCTV cannot cache (the bytes don't exist yet). So you either:
- **Encode once at the broker (SFU)** and fan out → 1 encoder × N viewers
- **Encode N times at the broker** for ABR ladders → N encoders × M cameras
- **Let the camera encode** (what we do today) → camera handles 1 viewer best; falls apart at 10 simultaneous

drisyam today: cameras encode. At 40 viewers × 25 cameras = 1000 simultaneous RTSP pulls. Cameras die under that load. **This is the strongest argument for a real SFU.**

---

## Part 2 — Why Netflix can't be copied

Netflix and CCTV optimise for opposite physics:

| | Netflix VOD | Live CCTV |
|---|---|---|
| Content | Pre-recorded | Generated in real-time |
| Sources | ~10k titles | ~thousands of cameras per deployment |
| Viewers per source | ~millions | 1-10 |
| Latency target | Doesn't matter (24h pre-positioned) | Sub-second |
| Encoding | Multi-day, multi-pass, VMAF-guided | Real-time, single pass |
| Distribution | Open Connect boxes inside ISPs | Direct path from camera to viewer |
| Cost driver | Egress bandwidth from edge | Per-camera encoder + GPU inference |
| Failure mode if late | Player rebuffers | Operator misses an incident |

**The single useful Netflix lesson**: their VMAF-guided "per-title encoding". They encode each video, measure the resulting quality with VMAF (Video Multi-method Assessment Fusion — Netflix's open-source tool), re-encode if the visual quality drops below threshold. drisyam can apply the analogous idea to *per-camera encoder tuning* — measure resulting bitstream quality per camera, auto-promote bad cameras to NVENC transcode pass.

That's literally the only Netflix technique that translates. Open Connect, AV1 ladders, multi-CDN, edge-cached bytes — none apply.

---

## Part 3 — What top live-streaming platforms actually do

These are the production architectures we should learn from, ranked by relevance to CCTV.

### Reference 1: Twitch / YouTube Live (closest analog)

| Layer | What they do | Why |
|---|---|---|
| Ingest | RTMP from streamer → SRT internally | RTMP is the publisher protocol; SRT is what they reroute on |
| Transcoder | NVENC on shared GPU pool | Per-channel ABR ladder (1080p / 720p / 480p) |
| Distribution | LL-HLS (Twitch went open-source with their `transmuxed` path) + WebRTC for "Low Latency" mode | LL-HLS for the masses, WebRTC for interactive |
| Edge cache | Multi-CDN (Akamai + Cloudflare + custom) | Egress at scale |
| Player | Their own JS player, hls.js as base, custom ABR | Telemetry-driven decisions |

**What CCTV borrows**: NVENC transcode pool, LL-HLS, ABR ladders, telemetry-first.

### Reference 2: Zoom / Google Meet (real-time, but conferencing)

| Layer | What they do |
|---|---|
| Transport | WebRTC (SFU model — mediasoup-style internally) |
| Codec | VP9 + SVC (Scalable Video Coding) — encode once, drop layers per subscriber |
| Network | Their own backbone + opportunistic TURN |
| Adaptive | Per-receiver bandwidth + CPU + screen-size estimation; encoder responds in real-time |
| Reliability | RED (Redundant Encoding) — duplicate frames to survive packet loss |

**What CCTV borrows**: SFU architecture, SVC, per-receiver adaptation, RED for lossy networks.

### Reference 3: Tesla camera streaming (closest CCTV analog at scale)

Tesla cars stream their dashcam feeds to fleet management. Engineering notes from public talks:

- Cameras pre-encode H.265
- Local NVMe buffer (~hours)
- Burst upload over LTE when the car is on a good network
- Backend uses cloud SFU for live view
- WebRTC for the dashboard, HLS for forensic review

**What CCTV borrows**: per-camera local buffer + opportunistic upload, dual protocol stack (WebRTC live + HLS replay).

### Reference 4: Verkada / Eagle Eye / Genetec (commercial VMS competitors)

Public marketing + observed behaviour:

- Cloud-managed SaaS model: every camera has a per-device key, points at a regional cloud broker
- Per-camera HEVC transcode (Verkada's hardware boxes do this on-device)
- Multi-resolution streaming negotiated at watch time
- Strong observability (per-camera bitrate dashboards visible to the operator)
- Aggressive sub-stream usage for grid views

**What CCTV borrows**: per-camera local transcode, operator-facing observability, sub-stream fluency.

---

## Part 4 — The gap map (where drisyam stands)

| Capability | Where drisyam is | World-class | Cost to close |
|---|---|---|---|
| Camera GOP normalised | ✅ Phase 1.1 sweep ships it | Mandatory | Days — done |
| Sub-stream actively used | ❌ Phase 1.2 wires it | Mandatory | Days |
| Source-on-demand tuned | ⏳ Phase 1.3 today | Mandatory | Hours |
| TURN server in our control | ⏳ Phase 1.4 | Mandatory | Day |
| Persistent streams across navigation | ✅ streamRegistry (Footfall); DirectStreamPlayer next | Mandatory | Hours |
| Per-camera observability | ⏳ Phase 2.1 | **Most underrated** | Day |
| Low-Latency HLS | ⏳ Phase 2.2 | Mandatory for mobile | Day |
| Adaptive jitter buffer | ⏳ Phase 2.3 | Strong differentiator | 2 days post-2.1 |
| Per-camera ABR ladders | ❌ Phase 3 | Mandatory at scale | Week |
| NVENC transcode for problem cameras | ❌ Phase 3 | Mandatory at scale | Week + GPU budget |
| HEVC / H.265 transcoding | ❌ Future | 50% bandwidth saving | 2 weeks + browser-support gating |
| WebRTC SFU (mediasoup / LiveKit) | ❌ Phase 4 | Mandatory at 2k cameras / 10+ concurrent viewers | 3 weeks |
| SVC (scalable video coding) | ❌ Beyond Phase 4 | Conferencing-class quality | Month+ |
| Per-camera local buffer (Tesla model) | ❌ Future | Survives WAN outages | Month + per-camera SD card |
| SRT camera → broker | ❌ Future | Camera-side firmware support | Quarter |
| Edge AI inference (camera-side) | ❌ Memory says "phased toward DeepStream" | Mandatory at 2k cameras | Quarter+ |
| Multi-region SFU mesh | ❌ Future | Only matters for multi-campus | Quarter |
| VMAF-guided encoder tuning | ❌ Future | Netflix lesson; transferable | Month |
| Audio/video sync, lipsync | ❌ Not addressed | Operator audio in scope? | Day if needed |
| Privacy zones / masking | ❌ Camera-side feature | DPDP compliance | Camera config + UI |

---

## Part 5 — The "physics-aware" decision rules

Every streaming decision should pass through these gates:

1. **Latency budget violated?** If a change adds >50 ms to the glass-to-glass path, justify why. Camera-side GOP changes return time; broker-side buffering spends it.
2. **Encode work amortised?** If we encode the same bytes more than once per stream, ask why. The answer is usually "ABR" or "transcode to better codec" — both fine. Never "operator clicked refresh".
3. **Subscriber count matters?** A 1:1 stream optimises for latency. A 1:100 stream optimises for shared CPU (SFU). Pick the architecture per use-case (Live View = 1:few; recording playback = 1:many).
4. **The camera is the bottleneck.** 80% of "the system is laggy" tickets are camera config, network between camera and broker, or NVR firmware quirks. Always check that layer first before touching server code.
5. **Observability before optimisation.** Without per-camera bitrate/jitter/loss metrics, every tuning change is voodoo. Ship Phase 2.1 before Phase 3.
6. **No new architecture without a feature flag.** SFU rollout, codec changes, player path changes — every one ships behind a flag and rolls forward by tenant / camera group.

---

## Part 6 — The "post-Phase-4" north star

After all four phases ship, drisyam looks like this:

- **Camera tier**: every camera GOP-normalised, CBR, NTP-synced, sub-stream actively used in grid views.
- **Broker tier**: MediaMTX as RTSP capture only; SFU (mediasoup / LiveKit) handles WebRTC fanout; NVENC transcode pool handles problem cameras; LL-HLS for mobile.
- **Transport tier**: coturn for TURN; QUIC/HTTP3 where possible; SFU mesh across 2-3 regions if needed.
- **Player tier**: persistent WebRTC connections across navigation (streamRegistry generalised across pages); adaptive jitter; bandwidth-aware quality picker; WebCodecs path for power users.
- **Observability tier**: per-camera bitrate/jitter/loss in Grafana; per-viewer RUM (rebuffer events, startup latency, freezes); synthetic monitoring that watches every camera and alerts when it sees garbage.
- **AI tier**: DeepStream batched inference at the broker; edge inference (per-camera) for the 2k-camera tier; codec-aware (I-frame only).
- **Storage tier**: tiered hot/warm/cold; event-triggered retention (only keep clips around motion / face hits); DPDP-compliant auto-delete.

That's the target. Each Phase moves the needle measurably. We hold ourselves to Twitch-class for live and Verkada-class for VMS — both achievable.

---

## Cross-references

- [STREAMING-IMPROVEMENT-PLAN.md](STREAMING-IMPROVEMENT-PLAN.md) — phased delivery schedule + success criteria per phase
- [BACKEND-TEMPLATE.md](BACKEND-TEMPLATE.md) — service-construction conventions every Node service follows
- `smart-cam-backend/docs/ARCHITECTURE.md` — gateway specifics
- `smart-cam-ai/docs/ARCHITECTURE.md` — Python brain specifics
