# drisyam — Technical Architecture

Single document covering everything drisyam is and does. Read this once and you understand:
- Every service in the stack + why it exists
- How a video frame becomes a recognised face becomes a stitched investigation video
- The streaming engine's six-layer optimisation stack
- What scales to 2,000 cameras and what doesn't

Companion docs that go deeper on specific topics are linked throughout.

---

## 1. System at a glance

drisyam is a **multi-camera Video Management System (VMS)** with face recognition, watchlist alerts, customer footfall, journey reconstruction, and forensic person tracking. Built for a 2,000-camera campus on NVIDIA Blackwell GPUs.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                  BROWSER                                      │
│            React 19 + Vite + Tailwind + LiveKit SDK + hls.js                  │
└─────┬──────────────────────────────────────────┬──────────────┬──────────────┘
      │ HTTPS / WSS                              │ WebRTC       │ WebSocket
      │ Auth: JWT                                │ (WHEP+LK)    │ (Socket.IO)
      │                                          │              │
      ▼                                          ▼              ▼
┌──────────────────┐     ┌──────────────┐    ┌────────────┐ ┌──────────────┐
│ smart-cam-backend│◀────│  TURN/coturn │    │ LiveKit    │ │  MediaMTX    │
│  Node + Express  │     │              │    │ Cloud SFU  │ │  RTSP broker │
│  Sequelize+MySQL │     └──────────────┘    └─────┬──────┘ └─────┬────────┘
│  JWT, S3, SocketIO                                 │              │
└──┬───────────────┘                                 │              │
   │ /api/ai/*           ┌───────────────┐           │              │
   ▼ /api/internal/*     │ smart-cam-app │           │              │
┌───────────────┐  ┌────▶│  React SPA    │           │              │
│ smart-cam-ai  │  │     │  Vite HMR     │           │              │
│ FastAPI       │  │     └───────────────┘           │              │
│ SCRFD+ArcFace │  │                                 │              │
│ YOLOv8 opt    │  │ /api/person-tracker/*           │              │
└──┬────────────┘  │                                 │              │
   │               │     ┌───────────────┐           │              │
   ├───▶ Qdrant    │     │ person-tracker│           │              │
   │   /vectors    │◀────│  FastAPI      │           │              │
   ├───▶ Postgres  │     │  + Worker (RQ)│           │              │
   │   /metadata   │     │  FFmpeg+PDF   │           │              │
   ├───▶ MinIO     │     └───────────────┘           │              │
   │   /snapshots  │     ┌───────────────┐           │              │
   ├───▶ Redis     │     │ face-recon-   │           │              │
   │   /events     │◀────│  struct       │           │              │
   │               │     │  CodeFormer   │           │              │
   │               │     │  + Real-ESRGAN│           │              │
   │               │     └───────────────┘           │              │
   │               │                                 │              │
   │               │     ┌───────────────┐ FFmpeg   │              │
   │               │     │ smart-cam-    │ + NVENC  │              │
   │               │     │ transcoder    │──────────┴──────────────┤
   │               │     └───────────────┘                          │
   │               │                                                │
   │               │     ┌───────────────┐ RTSP    ┌───────────────┐│
   │               │     │ smart-cam-sfu-│ +WHIP   │ Cameras (RTSP)││
   │               │     │ bridge        │─────────│ Office 12+13  ││
   │               │     └───────────────┘         └───────────────┘│
   │               │                                                 │
   │ alerts        ▼                                                 │
   └──────▶ smart-cam-ai-worker (match worker, Qdrant put)           │
                                                                     ▼
                                              ┌────────────────────────────────┐
                                              │  Observability layer            │
                                              │  Prometheus + Grafana + cAdvisor│
                                              │  + node/mysql/redis exporters   │
                                              └────────────────────────────────┘
```

---

## 2. Service inventory

| Service | Language | Port | Purpose | Doc |
|---|---|---|---|---|
| `smart-cam-app` | React 19 + Vite | 5173 | Operator UI: Live View, MonitorWall, AI Feed, Person Tracker, Watchlist, Footfall | [smart-cam-app/docs/](../frontend/docs/) |
| `smart-cam-backend` | Node 20 + Express | 5000 | JWT auth, MySQL, S3, Socket.IO, reverse proxy to AI/transcoder/SFU/person-tracker | [smart-cam-backend/docs/](../backend/docs/) |
| `smart-cam-ai` | Python 3.12 + FastAPI | 8001 | Face detection (SCRFD), embedding (ArcFace), tracking, footfall, embed-on-demand | [smart-cam-ai/docs/](../ai/face-service/docs/) |
| `smart-cam-ai-worker` | Python 3.12 | — | Match worker: pulls candidates from Qdrant, writes vms_appearance | same |
| `face-reconstruct` | Python 3.10 + FastAPI | 8002 | CodeFormer + Real-ESRGAN face enhancement (per-event, per-watchlist-hit, manual) | (in smart-cam-ai docs) |
| `person-tracker` | Python 3.12 + FastAPI | 8003 | Search-by-photo → cross-camera stitched MP4 + PDF report + map | [person-tracker/docs/](../person-tracker/docs/) |
| `person-tracker-worker` | Python 3.12 | — | RQ worker: stitching jobs (FFmpeg clip extract + concat + overlays + PDF render) | same |
| `smart-cam-transcoder` | Python 3.12 + FFmpeg+NVENC | 8004 | Per-camera NVENC normalisation (Phase 3) | [smart-cam-transcoder/docs/](../media/transcoder/docs/) |
| `smart-cam-sfu-bridge` | Python 3.12 + FFmpeg | 8005 | RTSP → LiveKit publisher (Phase 4 scaffold) | (in PHASE-4-SFU-DESIGN.md) |
| `mediamtx` | Go | 8554, 8888, 8889, 9997, 9998 | RTSP capture, HLS/WebRTC egress, recording, Prometheus | (in TROUBLESHOOTING) |
| `mysql` 8.4 | — | 3306 | Operator data: User, Camera, AIEvent, Subscription, License | (in smart-cam-backend ARCHITECTURE) |
| `postgres` 16 | — | 5432 | AI service relational data (Person, FaceEnrollment, FaceLearningSample, Tenant) | same |
| `qdrant` v1.12 | — | 6333 | ANN vector store: vms_enrolled (gallery, 512-d), vms_appearance (history, 512-d), faces (legacy) | same |
| `minio` | — | 9000 | Snapshots blob storage (vms-snapshots, vms-enrollments) | same |
| `redis` 7 | — | 6379 | Pub/Sub + streams + RQ queue | same |
| `livekit` (Cloud) | Go | wss:443 | WebRTC SFU (Phase 4) | [docs/PHASE-4-SFU-DESIGN.md](PHASE-4-SFU-DESIGN.md) |
| `coturn` (planned) | C | 3478, 5349 | TURN server for restrictive networks (Phase 1.4) | [docs/COTURN-DEPLOYMENT.md](COTURN-DEPLOYMENT.md) |
| `prometheus` | Go | 9090 | Metric scrape + storage | (in observability/) |
| `grafana` | Go | 3001 | Dashboards (drisyam fleet, per-camera streaming health) | same |

---

## 3. The frame's journey — from photons to operator decision

### 3.1 Camera → MediaMTX

Cameras publish RTSP to MediaMTX at `rtsp://mediamtx:8554/cam_<monitor_id>`. We force **TCP transport** because UDP loses packets on flaky networks and triggers `unable to extract DTS` errors downstream. MediaMTX uses **source-on-demand** with `sourceOnDemandCloseAfter: 5m` (Phase 1.3) so hot cameras stay warm 5 minutes past the last viewer's grace window.

For cameras that ship bad H.264 (long GOP, B-frames, weird profile), Phase 3's `smart-cam-transcoder` is enabled via `camera.settings.transcode.enabled`. NVENC reads `cam_<id>`, normalises to baseline H.264 + 2s GOP + no B-frames + ~4 Mbps CBR, republishes as `cam_<id>_clean`.

### 3.2 MediaMTX → AI

`smart-cam-ai` reads each enabled camera's RTSP path and runs the per-frame loop:

```
RTSP frame (8 fps target)
   ↓
SCRFD detection (threshold 0.7) → [bbox, landmarks_5, det_score]
   ↓
Face quality gate (min size, blur variance, brightness)
   ↓
ArcFace embedding (R100 backbone, 512-d)
   ↓
Qdrant search vs vms_enrolled (cosine, threshold 0.45)
   ↓
ByteTrack tracking (TRACK_MIN_HITS_TO_MATCH=4 for snappy ID assignment)
   ↓
Snapshot pump (face crop → MinIO, optionally enhanced via face-reconstruct)
   ↓
Event publish (Redis streams + Socket.IO to SPA)
```

The settings live in `smart-cam-ai/.env` + compose env. Per-frame timing is bounded by `PIPELINE_FRAME_TIMEOUT_SEC: 15.0` — beyond that the orchestrator declares the camera stalled and reopens the RTSP source.

### 3.3 Operator → Browser

The SPA reaches MediaMTX three ways:

| Path | Player | Latency | When |
|---|---|---|---|
| WebRTC WHEP | DirectStreamPlayer (single tile) | ~600 ms - 1.5 s | Default for Live View |
| LL-HLS (CMAF parts) | DirectStreamPlayer via hls.js | ~1.5 s | Grid tiles, Safari/iOS, fallback when WHEP fails |
| Snapshot MJPEG | Footfall preview | 1 Hz refresh | Footfall page tile |

After Phase 2.3 (network-class adaptive playback):
- `navigator.connection.effectiveType` + `downlink` + `rtt` → fast/medium/slow class
- Initial profile chosen (smooth/bumpy/choppy) → maps to HLS `maxBufferLength` + WebRTC `playoutDelayHint`
- Stall pressure observed on the `<video>` element promotes the profile (one stall = bumpy; four = choppy)
- 60 s clean playback demotes back

After Phase 4 (SFU, in progress) for enabled cameras:
- WebRTC subscribes to a LiveKit room `cam_<monitor_id>` instead of MediaMTX WHEP
- The bridge service publishes the RTSP into that room as a publisher participant
- Operator browser uses `livekit-client` SDK + a backend-minted participant JWT
- Same MediaStream lifecycle, persistent across navigation via `streamRegistry`

---

## 4. The streaming engine — six-layer optimisation stack

drisyam's streaming engine moved from "MediaMTX + WHEP, take-it-or-leave-it" to a layered, observable, opt-in stack. Each layer is independent; turning any off rolls back to the previous behaviour.

| Layer | What | Phase | Default state | Knob |
|---|---|---|---|---|
| **1. Camera config** | GOP=2 s + CBR + sub-stream enabled via Hikvision ISAPI / Dahua CGI | 1.1 | Manual sweep via `scripts/optimize-cameras-for-streaming.js` | Per-camera via `--only` |
| **2. Sub-stream usage** | MonitorWall + LiveView grid pull `quality="low"` for small tiles | 1.2 | On | `quality` prop on `<DirectStreamPlayer>` |
| **3. MediaMTX keep-alive** | `sourceOnDemandCloseAfter: 5m` keeps hot paths warm | 1.3 | On | `mediamtx.yml` |
| **4. TURN fallback** | coturn deployed for clients behind restrictive firewalls; backend issues short-lived HMAC creds | 1.4 | Off (needs server deploy) | `LIVEKIT_WS_URL` / `TURN_URI` env |
| **5. Stream registry + adaptive** | `streamRegistry` keeps WebRTC PC alive across navigation (30 s grace); `useAdaptivePlayback` picks initial profile from network class | streamRegistry + 2.3 | On | `useNetworkClass()` hook |
| **6. NVENC normaliser** | Per-camera transcode to baseline H.264 + 2 s GOP for the "bad H.264" subset | 3 | Per-camera opt-in via `camera.settings.transcode.enabled` | Backend admin endpoint |
| **7. SFU (LiveKit)** | One ingress per camera, N egresses (replaces point-to-point WHEP at scale) | 4 (scaffold) | Per-camera flag, code path shipping next | `camera.settings.sfu.enabled` |

### Observability bound to the stack

Phase 2.1 added the Grafana board *"drisyam — per-camera streaming health"* — scraped from MediaMTX's `/metrics` endpoint:

- `paths{name, state}` — ready vs notReady per camera
- `paths_readers{name}` — active viewers per camera
- `paths_inbound_bytes{name}` — bitrate from the camera
- `paths_outbound_bytes{name}` — bitrate to viewers
- `paths_inbound_frames_in_error{name}` — codec / packet errors

The "which camera is bad" question is answerable in 10 seconds: open the board, sort by frame-error rate.

---

## 5. The face recognition pipeline

### 5.1 Models in production

drisyam uses **InsightFace `buffalo_l`** bundle. Configured in [docker-compose.yml](../docker-compose.yml) under `smart-cam-ai`:

```yaml
INSIGHTFACE_MODEL: buffalo_l
INSIGHTFACE_DET_SIZE: 960
INSIGHTFACE_DET_THRESHOLD: "0.7"     # SCRFD confidence floor
INSIGHTFACE_REC_THRESHOLD: "0.45"    # ArcFace match floor for CCTV-quality faces
INSIGHTFACE_PROVIDERS: CUDAExecutionProvider,CPUExecutionProvider
```

The bundle ships **SCRFD-10G** (face detection + 5 landmarks) and **ArcFace R100** (512-dim embedding). Why this combination over alternatives:

- **SCRFD beats YOLO for faces**. SCRFD-10G: 96.06 % AP on WIDER FACE Hard; YOLOv8-face: ~92-93 %. SCRFD predicts landmarks needed for alignment in one pass; YOLO needs a second model.
- **ArcFace R100 + InsightFace** is the production embedding choice across the industry (Verkada, Genetec, most commercial VMSes). FNIR @ FPIR = 1e-3 is achievable on CCTV-quality faces with proper threshold tuning.

YOLOv8n.onnx **is** in the stack — for full-body person detection (`PIPELINE_PERSON_MODEL_PATH`), off by default. Flip on when crowds make face detection insufficient.

### 5.2 Vector stores

Three Qdrant collections, all cosine-distance, all 512-d vectors matching ArcFace output:

| Collection | Size today | Use |
|---|---|---|
| `vms_enrolled` | 468 points | Gallery (enrolled people from Watchlist + auto-learning approvals) |
| `vms_appearance` | **749,833 points** | History — every detected appearance, used by Person Tracker forensic search |
| `faces` | 232 points | Legacy collection, slated for cleanup |

### 5.3 Recognition flow at a glance

```
Live frame
   ↓ SCRFD detect (threshold 0.7)
   ↓ Quality gate (min face size 40 px, blur variance > 20, brightness in range)
   ↓ ArcFace embed (reuse SCRFD's embedding when available)
   ↓ Qdrant query vms_enrolled  (cosine ≥ 0.45)
   ↓ Match? → Person ID assigned
   ↓ Track lifecycle (ByteTrack, TRACK_MIN_HITS_TO_MATCH=4)
   ↓ Snapshot pump (face crop → MinIO with optional face-reconstruct)
   ↓ Match worker writes to vms_appearance + emits to Redis
   ↓ Backend Socket.IO → operator browser
```

The match worker is a **separate process** (`smart-cam-ai-worker`) so detection latency stays decoupled from Qdrant-write latency. Without this split, Qdrant maintenance windows would block detection.

---

## 6. Person Tracker — the forensic flagship

A separate service answering "show me everywhere this person went today" from a single uploaded photo. End-to-end **verified working** (this session).

### 6.1 Pipeline

```
Operator uploads photo
   ↓ POST /api/person-tracker/search  (multipart)
   ↓
   ├── person-tracker → smart-cam-ai /api/embed/face
   │   (SCRFD detect → ArcFace embed → returns 512-d vector + det_score)
   │
   ↓ person-tracker Qdrant search vs vms_appearance
   ↓ (cosine ≥ threshold, time-window filtered in Python — see below)
   ↓ returns Candidates[]: { camera_id, occurred_at, similarity, snapshot_uri }
   ↓
   ├── POST /api/person-tracker/sightings/cluster
   │   (collapse adjacent candidates within `window_sec=30` per camera → Sightings[])
   │
   ↓ POST /api/person-tracker/stitch  (creates RQ job)
   ↓
   ↓ person-tracker-worker picks up:
   │   ├── for each sighting, locate MediaMTX recording file at /recordings/cam_<id>/<date>/
   │   ├── FFmpeg clip extraction (precise seek + 2 s pre / 4 s post)
   │   ├── FFmpeg overlay (camera label, timestamp, confidence) via drawtext
   │   ├── FFmpeg concat to single MP4
   │   ├── Upload final MP4 + thumbnail snapshots to MinIO
   │   ├── ReportLab PDF render (cover + table-of-sightings + map page)
   │   └── Write map JSON (lat/lng of each camera + sighting metadata)
   │
   ↓ GET /api/person-tracker/stitch/{job_id}        (poll status)
   ↓ GET /api/person-tracker/stitch/{job_id}/video  (presigned redirect to MP4)
   ↓ GET /api/person-tracker/stitch/{job_id}/report.pdf
   ↓ GET /api/person-tracker/stitch/{job_id}/map.json
```

### 6.2 Compute cost per investigation

For a typical 10-sighting investigation:

| Phase | Where | Compute |
|---|---|---|
| Detect + embed query face | smart-cam-ai GPU | ~50–100 ms (SCRFD + ArcFace single forward) |
| Qdrant ANN query (750k vectors) | Qdrant CPU | ~20–80 ms |
| Cluster | person-tracker API | < 5 ms |
| FFmpeg clip extract × 10 (stream-copy where possible) | person-tracker-worker | ~300–600 ms per clip — disk-bound |
| drawtext overlay × 10 (re-encode libx264 veryfast) | same | ~1–3 s per clip |
| Concat + MinIO upload | same | ~1.5 s total |
| PDF render | person-tracker API | ~1–3 s |
| **Total wall** | | **~15–35 s end to end** |

100 investigations/day → ~25 minutes of worker CPU. **One worker container handles it idle 99 % of the time.**

### 6.3 Known schema drift (post-demo fix)

`vms_appearance` stores `occurred_at` as ISO 8601 string, but the original person-tracker assumed epoch ms int. We fixed this with in-Python time filtering (over-fetch then trim) — works against the existing 750k points without a schema migration. Long-term fix: add a parallel `occurred_at_ms` int field via a batch update so Qdrant Range filter moves back server-side.

---

## 7. Face reconstruct (CodeFormer + Real-ESRGAN)

Per-camera CCTV faces are often too low-res for confident human ID. `face-reconstruct` (port 8002) wraps **CodeFormer** (face-restoration GAN) + **Real-ESRGAN** (general SR) on PyTorch 2.7 + CUDA 12.8 (Blackwell-compatible).

Three injection points wired into the pipeline (all currently DISABLED — operator opt-in):
- **Per-event** (`SNAPSHOT_AUTO_ENHANCE`) — every face crop the pump uploads gets enhanced before MinIO write.
- **Per watchlist hit** (`WATCHLIST_AUTO_ENHANCE`) — alerts get the enhanced version for the operator UI.
- **Per face-learning sample** (`face_learning_auto_enhance`) — operator-facing review thumbnail gets enhanced on demand with a MinIO sidecar cache.

Why off by default: visual quality wasn't what the operator wanted in early tests. The infrastructure is intact for re-enabling per camera or globally with a one-line flag flip.

Operators can ALWAYS use the manual "Enhance face" button in the Alerts dialog regardless of the auto-enhance flags.

---

## 8. Streaming layer responsibility map

The "amazing tech advance layering" the operator asked about — every layer makes its own contribution. None of these are vendor magic; each is a specific code change with measurable impact:

| Layer | Owner | Trade-off |
|---|---|---|
| **L1 Camera config** | Hikvision/Dahua firmware via our sweep script | GOP 2 s costs ~5 % more bandwidth than 4 s for snappy recovery + sub-second viewer pop-in |
| **L2 MediaMTX broker** | mediamtx.yml | source-on-demand close-after 5 min: 5 min of camera-pull traffic when no operator watches → fast cold start when they do |
| **L3 Adaptive playback** | useAdaptivePlayback hook + useNetworkClass | Latency vs smoothness traded dynamically per-client based on observed stalls + measured downlink |
| **L4 Stream persistence** | streamRegistry | One WebRTC PC per camera shared across navigation (30 s grace) → no 3-6 s black flash on route change |
| **L5 NVENC normalisation** | smart-cam-transcoder | 1 NVENC slot per active transcoder → max 3-5 concurrent on RTX PRO 5000 |
| **L6 SFU (Phase 4)** | LiveKit + smart-cam-sfu-bridge | One stream encode per camera, fanout to N operators at zero per-viewer GPU cost |
| **L7 Edge AI (future)** | DeepStream / Hailo / MemryX | Reserved for 2k-camera regime where centralised GPU saturates |

---

## 9. Scaling to 2,000 cameras — the capacity model

Concrete per-resource analysis. Numbers are conservative; real hardware can do better.

### 9.1 Detection (smart-cam-ai)

| Workload | Maths | Today (40 cams) | At 2k cams |
|---|---|---|---|
| Frames/sec across fleet | cameras × 8 fps | 320 | **16,000** |
| GPU detection cost (SCRFD-10G @ 960²) | ~6 ms / frame on Blackwell | ~10 % GPU util | **~480 % GPU util** ← saturation |
| Mitigation | DeepStream batched inference (4-8× headroom) | n/a | Phase 4+ |
| If DeepStream insufficient | Multi-GPU (2-4× Blackwell) OR edge AI (Hailo/MemryX per-camera) | n/a | Phase 5 budget item |

**The trigger:** when [Grafana drisyam-fleet board](../deploy/observability/grafana/dashboards/drisyam-fleet.json) shows smart-cam-ai GPU > 80 % sustained, DeepStream migration becomes mandatory. Until then, single-GPU centralised is the right shape.

### 9.2 Storage (recordings)

| Workload | Maths | At 2k cams × 7 days |
|---|---|---|
| Single-camera bitrate (after Phase 3 normalisation) | ~4 Mbps | — |
| Daily volume per camera | 4 Mbps × 86,400 s ÷ 8 | ~43 GB/day |
| Fleet daily | × 2,000 cameras | **~86 TB/day** |
| 7-day retention | × 7 | **~600 TB** |

**Mitigation:**
- **Tiered storage** — hot SSD (last 24 h) + warm HDD (1-7 days) + cold S3 (> 7 days). Reduces TCO 3-5×.
- **Motion-triggered recording** — record only when smart-cam-ai sees a face/person. Cuts volume 70-90 % depending on camera placement.
- **Event-triggered clips** — keep 30 s before + 30 s after every AIEvent; drop the rest. Cuts another 90 % on top of motion-only.

Stack all three and 600 TB becomes ~10-15 TB. That's the right approach at 2k cameras.

### 9.3 Streaming egress (operator viewers)

| Topology | Egress per camera per viewer |
|---|---|
| Today (MediaMTX point-to-point) | 1× — N viewers × per-camera bitrate |
| After Phase 4 SFU | 1× — N viewers SHARE the same SFU-published track |

At 2k cameras with 10 operators each watching a 9-cam grid:

| Topology | Total egress |
|---|---|
| MediaMTX | 10 × 9 × 4 Mbps = **360 Mbps** |
| SFU | 9 × 4 Mbps × ceil(10 / SFU subscribers per track) = **36 Mbps if operators watch overlapping cameras** |

Phase 4 isn't a "faster" — it's a *scaling* — improvement. At 5 operators on overlapping cameras the SFU is ~10× more bandwidth-efficient than the current architecture.

### 9.4 Qdrant ANN

| Today | At 2k cams |
|---|---|
| 750k vectors in vms_appearance | ~10 days at current pump rate |
| At 2k cams: ~150x more appearances per day | **15M points in 1 day, 100M in 7 days** |

| Mitigation | Impact |
|---|---|
| Quantised vectors (Qdrant binary quantisation) | 4-8× index size reduction, ~10 % recall hit |
| Sharded Qdrant cluster (per-tenant or per-camera-group) | Linear scale-out |
| Per-camera HNSW parameters tuned | Tradeoff search latency vs recall |
| TTL on vms_appearance points (drop > 30 days) | Bounded growth |

At 100M points Qdrant on a single 32 GB instance still queries in < 50 ms — comfortably within the operator's expectation. The bottleneck is **disk + RAM for the index**, not query latency. Budget for ~80 GB Qdrant data volume at 2k cams × 7-day retention.

### 9.5 NVENC encoder slots (GPU bottleneck)

| Component competing for NVENC | Today | At 2k cams |
|---|---|---|
| smart-cam-transcoder | 0 (until per-camera flags set) | 3-5 active = the hard cap |
| Recording transcoders | 1 per recording camera | Up to 2k → impossible on one card |
| face-reconstruct | 0 NVENC use (raw CUDA only) | same |

**Reality:** at 2k cams, NVENC is the binding constraint. The unlocks:
- Community NVENC patch (removes the session cap; not officially supported)
- Multi-GPU (each card adds 3-5 slots)
- Move recording transcoding to CPU (libx264 veryfast is feasible at 1080p × 8 fps)
- Skip transcoding entirely for cameras with clean H.264

### 9.6 What works unchanged at 2k cams

| Component | Why it's fine |
|---|---|
| smart-cam-backend (Node) | Stateless API; horizontal scale-out via container replicas + sticky-session-free design |
| MySQL | Camera + User + AIEvent rows fit comfortably; index correctly on `userId` for tenant scope |
| MinIO | Object store scales linearly with disk + bandwidth |
| Redis | Sub/pub + RQ queues — single instance handles 10k QPS easily |
| LiveKit Cloud | Operated by LiveKit at scale (their public Cloud handles 100k+ concurrent participants) |
| person-tracker | Forensic, not real-time. 100 investigations/day = ~25 min of worker CPU |

---

## 10. Cross-references — where to read next

| Topic | Doc |
|---|---|
| Phased streaming improvement (P1-P4) | [STREAMING-IMPROVEMENT-PLAN.md](STREAMING-IMPROVEMENT-PLAN.md) |
| Physics + reference architectures | [STREAMING-WORLD-CLASS-MAP.md](STREAMING-WORLD-CLASS-MAP.md) |
| SFU choice + Phase 4 details | [PHASE-4-SFU-DESIGN.md](PHASE-4-SFU-DESIGN.md) |
| TURN deployment | [COTURN-DEPLOYMENT.md](COTURN-DEPLOYMENT.md) |
| Backend service template | [BACKEND-TEMPLATE.md](BACKEND-TEMPLATE.md) |
| Per-service deep dives | [smart-cam-app/docs/](../frontend/docs/) · [smart-cam-backend/docs/](../backend/docs/) · [smart-cam-ai/docs/](../ai/face-service/docs/) · [person-tracker/docs/](../person-tracker/docs/) · [smart-cam-transcoder/docs/](../media/transcoder/docs/) |

---

## 11. The "amazing tech advance" list — what to mention in the demo

If you have 90 seconds to explain why drisyam is different from a stock VMS:

1. **One unified service stack** — face detection + recognition + tracking + footfall + person search + alerts in one place, not 5 vendors' boxes wired together.
2. **Forensic Person Tracker** — upload any face, get a stitched MP4 + PDF report + map of every camera that saw them. Sub-30-second pipeline for typical investigations.
3. **GAN face reconstruction** — CodeFormer + Real-ESRGAN per-event so low-res CCTV faces become courtroom-quality.
4. **Phased streaming engine** — 7 layers (camera config, broker keep-alive, sub-stream, persistent WebRTC, NVENC, LL-HLS, SFU) each independently observable in Grafana. The "is camera 12 bad or is wifi bad?" question is answerable in 10 seconds.
5. **Per-camera observability** — bitrate / jitter / packet-loss / frame-error rate per camera, live.
6. **Zero-downtime architecture** — every layer is per-camera opt-in. NVENC bad? Disable it for that camera. SFU misbehaving? Fall back to MediaMTX WHEP transparently. Stream registry guarantees the operator never sees a black flash on navigation.
7. **2,000-camera horizon** — the model + math for what scales and what doesn't is in this doc. Most cost drivers (storage, NVENC slots, detection throughput) have well-understood unlocks (tiered storage, multi-GPU, DeepStream).
