# vms_face — Enterprise Face Recognition for drisyam VMS

Phase 1 foundation for a 2,000-camera campus VMS on NVIDIA Blackwell.
Replaces the single-process `insightface_api.py` with a layered service.

> **Looking for "what does each service do and how good is it?"**
> See [SERVICES.md](SERVICES.md) — a per-component reference covering every box
> in the diagram below: API, match-worker, reid-worker, retention-worker,
> orchestrator, snapshot pump, batcher, Postgres, Qdrant, Redis, MinIO,
> MediaMTX, SCRFD, AdaFace.
>
> **Looking for "how do we make face detection itself measurably better?"**
> See [DETECTION_STRATEGY.md](DETECTION_STRATEGY.md) — failure-mode taxonomy,
> 5 phases (config tuning → benchmark → SCRFD-34G → local fine-tune →
> advanced), per-phase acceptance criteria, anti-patterns, and a
> phase-to-files map.

```
RTSP → MediaMTX → ingest → detector(SCRFD) → tracker(IOU) → quality gate
                                                              │
                                                              ▼
                                                      embedder(ArcFace)
                                                              │
                                                              ▼
                                                Redis Streams ─┐
                                                               ▼
                                                       match worker
                                                       ┌────┴────┐
                                                       ▼         ▼
                                                    Qdrant    Postgres
                                                    (ANN)     (events)
                                                               │
                                                               ▼
                                                       FastAPI / WebSocket
                                                               │
                                                               ▼
                                                          MinIO (snapshots)
```

## Quick start (local, single GPU)

### Option A — full stack via Docker Compose (recommended)

Requires the NVIDIA Container Toolkit on the host. The compose file builds
the API + workers, brings up Postgres / Qdrant / Redis / MinIO / MediaMTX,
runs the bootstrap migration, then starts everything.

#### A1 — dev (one command, zero secrets to invent)

The shipped `.env.dev` file holds throwaway dev defaults and turns on
`VMS_JWT_DEV_BYPASS` so the AiFeed.jsx frontend works without minting
tokens or sending `X-API-Key`. Use it for local development:

```powershell
docker compose --env-file app/face_detection/vms_face/.env.dev `
    -f app/face_detection/vms_face/docker-compose.gpu.yml `
    up -d --build
docker compose --env-file app/face_detection/vms_face/.env.dev `
    -f app/face_detection/vms_face/docker-compose.gpu.yml `
    logs -f api
```

The API logs a loud `JWT auth disabled (VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true)`
warning on startup so the bypass is impossible to miss.

#### A2 — stage / prod (you provide the secrets)

`docker-compose.gpu.yml` fails to start if any of these are missing — this
is intentional, a prod deploy without secrets shouldn't boot:

```powershell
# from the repo root
$env:VMS_JWT_SECRET = "<32+ random chars>"
$env:VMS_CAMERA_CRED_KEY = python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
$env:LEGACY_API_KEY = "<shared secret for AiFeed.jsx>"
$env:POSTGRES_PASSWORD = "<DB password>"
$env:MINIO_ROOT_USER = "minio"
$env:MINIO_ROOT_PASSWORD = "<MinIO password>"

docker compose -f app/face_detection/vms_face/docker-compose.gpu.yml up -d --build
docker compose -f app/face_detection/vms_face/docker-compose.gpu.yml logs -f api
```

In either mode, start a stream from the host (or another container):

```powershell
python -m vms_face.pipeline.run_stream `
    --tenant-id <uuid> --camera-id <uuid> --camera-code GATE-01 `
    --source rtsp://mediamtx:8554/cam_GATE01
```

### Option B — bare metal (dev / debugging)

```powershell
# 1. spin up infra (no API/workers, no GPU runtime)
docker compose up -d

# 2. install python deps (CUDA 12.x recommended for Blackwell)
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 3. apply DB migrations
alembic upgrade head

# 4. start API gateway
uvicorn vms_face.api.main:app --host 0.0.0.0 --port 8001 --workers 1

# 5. start match worker (separate terminal)
python -m vms_face.workers.match_worker

# 6. start a stream (separate terminal, per camera)
python -m vms_face.pipeline.run_stream --camera-id cam-001 --source rtsp://...
```

## Local dev — making AiFeed.jsx work without minting tokens

The frontend (`smart-cam-app/src/pages/AiFeed.jsx`) was built before the
auth layer was added — it talks straight to `http://localhost:8001` and
doesn't know about JWTs or `X-API-Key` headers. Two equally valid ways to
unblock it locally:

### Option 1 — dev bypass (fastest, no frontend changes)

In your `.env`:

```env
VMS_ENV=dev
VMS_JWT_DEV_BYPASS=true
```

The API then treats unauthenticated requests as the default tenant's
"anonymous" principal, and the legacy `/set-camera` / `/upload` / `/ws`
routes accept connections without `X-API-Key`. The startup log emits a
loud warning so you know the bypass is on:

```
JWT auth disabled (VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true). Every protected
route binds to the default tenant. NEVER use this in prod.
```

`VMS_JWT_DEV_BYPASS` is gated on `VMS_ENV=dev`; if anyone ever flips
`VMS_ENV=prod`, the bypass becomes a no-op automatically. There is no
production code path where this can accidentally open the API.

### Option 2 — shared key (closer to production behaviour)

In your `.env`:

```env
LEGACY_API_KEY=local-dev-shared-key
```

Then in `AiFeed.jsx`, add `X-API-Key: local-dev-shared-key` to every
`fetch()` call and append `?api_key=local-dev-shared-key` to the WS URL
(query param is the only way to pass it through a browser WS open). This
mirrors what a production deploy looks like — the frontend just needs to
know one secret.

### Both off → 404, not 401

If neither path is configured, the legacy router responds 404 with the
message `legacy router is disabled — set LEGACY_API_KEY in prod, or
VMS_ENV=dev + VMS_JWT_DEV_BYPASS=true for local dev`. That's intentional:
a misconfigured deploy refuses to serve the legacy surface at all.

## People counting (per camera & aggregate)

Every overlay payload (`GET /api/detections/{monitor_id}` and the live WS)
now carries a `people` block alongside the existing `boxes` array:

```jsonc
{
  "boxes": [ /* per-face overlay data */ ],
  "frame_w": 3200,
  "frame_h": 1800,
  "running": true,
  "persons": 5,                  // current frame; kept for back-compat
  "people": {
    "total":             5,      // raw current count (head count)
    "known":             1,      // recognized identities (name != "Unknown")
    "unknown":           4,
    "male":              2,      // gender split from the per-track vote —
    "female":            2,      //   stable labels only, so male+female can
    "gender_unknown":    1,      //   be < total while votes are unresolved
    "smoothed_total":    5,      // 2s rolling max — use this in the UI to
    "smoothed_known":    1,      //   prevent the count flickering when a
    "smoothed_unknown":  4,      //   detection blink-misses one frame
    "window_sec":      2.0,
  },
  "fps": 7.92,
  "frames": 482,
  "ts": 1778484629.86
}
```

**Use `smoothed_total` for badges and dashboards, not `total`.** The raw
`total` flickers down to `0` for ~125 ms when the detector misses one
frame on a fully-tracked person. The 2 s rolling-max in `smoothed_total`
holds the count steady through normal occlusion-and-recovery patterns.
Switch back to `total` only if you actually want sub-frame latency.

### Aggregate across all cameras

```
GET /api/people-count
```

Returns:

```jsonc
{
  "running_cameras": 12,         // cameras with active orchestrators
  "total":           74,         // current people across the building
  "known":           18,
  "unknown":         56,
  "smoothed_total":  78,
  "cameras": [
    {
      "camera_id":      "<uuid>",
      "monitor_id":     "GATE-01",   // the public id your frontend uses
      "code":           "GATE-01",
      "name":           "Main entrance",
      "total":          7, "known": 2, "unknown": 5,
      "smoothed_total": 7,
      "running":        true,
    },
    ...
  ],
  "window_sec": 2.0,
  "ts": 1778484629.86
}
```

Cameras that are stopped, never opened a stream, or were marked offline are
excluded — `running_cameras` reflects active streams only.

### Prometheus

Each camera publishes a gauge for ops dashboards:

```
vms_camera_people_count{camera_id="<uuid>", kind="total"}
vms_camera_people_count{camera_id="<uuid>", kind="known"}
vms_camera_people_count{camera_id="<uuid>", kind="unknown"}
vms_camera_people_count{camera_id="<uuid>", kind="smoothed_2s"}
```

PromQL examples:

```promql
# Current building occupancy (smoothed)
sum(vms_camera_people_count{kind="smoothed_2s"})

# Cameras with > 5 people right now
count(vms_camera_people_count{kind="smoothed_2s"} > 5)

# Top 10 busiest cameras over the last hour
topk(10, avg_over_time(vms_camera_people_count{kind="smoothed_2s"}[1h]))
```

## Face attributes — stable gender & age per track

Every overlay box and every published `FaceCandidate` now carries a
track-voted `gender` (+ `gender_conf`) and `age`, instead of the raw
per-frame genderage output:

- **Why voting.** buffalo_l's genderage head is a per-crop classifier; on
  real CCTV crops (small, blurred, off-axis) its output flips between Male
  and Female frame to frame. Each quality-passing observation now casts a
  vote weighted by its quality score; a label is asserted only after
  `ATTRIBUTES_MIN_VOTES` votes with `ATTRIBUTES_MIN_AGREEMENT` weighted
  majority. Until then `gender` is `null` — the UI shows nothing rather
  than noise. A permanently split vote stays `null` (the honest answer).
- **Works in batched mode.** Previously `PIPELINE_BATCHED_INFERENCE=true`
  silently lost gender entirely (the batched SCRFD path never runs
  attribute heads). The on-demand estimator
  ([infra/genderage.py](infra/genderage.py)) restores it in both modes.
- **Cheaper than before.** Sampling stops once the vote settles
  (early-stop at 90% agreement) or at `ATTRIBUTES_MAX_VOTES`, so attribute
  inference is O(1) per track instead of every-face-every-frame. Track the
  saving via `vms_genderage_calls_total` vs `vms_detections_total`.
- **Age** is the quality-weighted mean of per-crop age regressions —
  errors are roughly zero-mean per crop, so it converges in a few frames.
- The people-count `people` block gains `male` / `female` /
  `gender_unknown`, and `GET /api/people-count` aggregates them across
  cameras.

Tune via `FACE_ATTRIBUTES_ENABLED`, `ATTRIBUTES_MIN_FACE_PX` (crops smaller
than this don't vote — tiny crops give near-random gender),
`ATTRIBUTES_MIN_VOTES`, `ATTRIBUTES_MAX_VOTES`, `ATTRIBUTES_MIN_AGREEMENT`.

## Troubleshooting

### "I'm getting 401 / 502 from the frontend"

The frontend talks to `smart-cam-backend` (port 5000), which proxies to
`vms_face` (port 8001). If `vms_face` rejects the call with 401 or 503 —
which it does for every protected route when auth isn't configured — the
backend translates that to a 502.

Diagnose in one command:

```bash
curl http://localhost:8001/healthz | jq
```

Three fields decide whether protected routes will work:

```jsonc
{
  "auth": {
    "mode": "dev-bypass",     // or "jwt", or "MISCONFIGURED"
    "jwt_configured": false,
    "dev_bypass": true,       // ← must be true for AiFeed to work without tokens
    "legacy_router_open": true
  }
}
```

- `mode: MISCONFIGURED` → no auth configured. Set `VMS_ENV=dev` +
  `VMS_JWT_DEV_BYPASS=true` in your env (or use `--env-file .env.dev`).
- `mode: jwt` but the frontend isn't sending a token → frontend
  changes needed, or switch to dev mode for local work.
- `mode: dev-bypass` and you still see 502 → the gateway (port 5000)
  isn't actually reaching the AI service. Check
  `docker compose logs smart-cam-backend`.

### "AiFeed says 'AI service is not reachable'"

Same root cause as above. The `handleEnableAi` flow hits the legacy
`POST /set-camera` endpoint. With dev bypass off, it 401s; with the
gateway in front, the user sees a 502. The fix is the same:

```bash
docker compose --env-file app/face_detection/vms_face/.env.dev \
    -f app/face_detection/vms_face/docker-compose.gpu.yml \
    restart api
```

Confirm with `curl http://localhost:8001/healthz | jq .auth.dev_bypass`.

### "Cameras connect but no frames decode" (RTP packet loss / reorder)

Symptoms in MediaMTX logs:
```
WAR cam_xxx [RTSP source] 1993 RTP packets lost
WAR cam_xxx invalid FU-A packet (non-starting)
ERR cam_xxx too many reordered frames (31)
WAR cam_xxx [recorder] sample of track 1 received too late, discarding
```

This is **upstream of vms_face** — the cameras themselves (or their network
path to MediaMTX) are losing packets. The orchestrator opens the RTSP
connection successfully but gets corrupted bitstreams that don't decode.

#### Pinpoint which camera is bad

Use the standalone probe tool — it doesn't touch the orchestrator / API:

```bash
python -m vms_face.tools.probe_rtsp rtsp://mediamtx:8554/cam_<monitor_id> --duration 15
```

Output ends in one of:
- **HEALTHY** — open succeeded, observed fps tracks declared fps, errors <10%
- **DEGRADED** — open succeeded but >50% of frames lost or errors >10%
- **BROKEN** — open succeeded but no decoded frames at all

Run it against the camera RTSP URL **directly** (skipping MediaMTX) to
isolate where the loss happens:

```bash
python -m vms_face.tools.probe_rtsp rtsp://<camera-ip>/<stream-path>
```

If the camera is healthy direct but degraded via MediaMTX → MediaMTX is the
bottleneck; tune it. If degraded both ways → camera or camera-network is
the bottleneck.

#### Fix the cause (ordered cheap → expensive)

1. **Force TCP at the camera.** Most IP cams default to UDP RTSP, which
   drops packets on any congested link. In the camera's web UI, set
   "RTSP transport" to TCP. mediamtx.yml already enforces `rtspTransports:
   [tcp]` on the MediaMTX side as defense-in-depth.

2. **Lower camera bitrate.** Most IP cams ship at 4–8 Mbps default; if
   the camera's uplink can't sustain that, you get the exact symptoms
   above. Drop to 1–2 Mbps in the camera UI (it's a slider in the H.264
   encoding settings). Less data → less loss → cleaner frames.

3. **Tighten the GOP (I-frame interval).** Many cameras default to GOP=60
   or "auto" which can mean 5+ seconds between keyframes. If the orchestrator
   reconnects, it must wait for the next keyframe to produce any frame.
   Set GOP / I-frame interval to **2× fps** (e.g. 50 for 25fps) in the
   camera UI. probe_rtsp's "max keyframe gap" surfaces this directly.

4. **Check network quality.** From the MediaMTX host:
   ```bash
   docker compose exec mediamtx ping -c 50 <camera-ip>
   ```
   - <1% packet loss + <50ms jitter = network is fine.
   - >5% packet loss or >200ms jitter = network is the cause. Check switch
     port, cable, PoE injector, or WiFi signal strength.

5. **Use a dedicated VLAN for cameras** if you don't already. Mixing
   camera RTSP with general LAN traffic (file backups, video calls,
   software updates) starves the cameras during traffic spikes. Cameras
   on their own VLAN with QoS prioritization eliminates this.

6. **Move MediaMTX closer to the cameras** if they're geographically
   distant. A "MediaMTX edge" per building / floor / VLAN that
   republishes a clean stream to the central server cuts loss
   dramatically — see the clustering topology below.

#### Watch the per-camera health metric

After PR additions, `vms_decode_errors_total{camera_id=..., kind=...}` shows
which cameras hit decode / demux errors. In a Grafana dashboard:

```promql
# decode success rate per camera, last 5 minutes
1 - (
  sum by (camera_id) (rate(vms_decode_errors_total[5m]))
  /
  sum by (camera_id) (rate(vms_frames_ingested_total[5m]))
)
```

Cameras consistently below 0.95 are the ones to fix.

### "No detection boxes are showing on AiFeed"

Three layers can fail independently — detector / orchestrator / WS fan-out.
The `/streams/debug` endpoint shows all three for every running camera:

```bash
# Mint a quick JWT for the call, OR rely on dev bypass (recommended):
curl http://localhost:8001/streams/debug | jq
```

Sample output for a healthy stream:

```jsonc
{
  "streams": [
    {
      "camera_code": "GATE-01",
      "stream": {
        "frames_ingested_total": 482,
        "frames_per_second_ewma": 7.92,
        "last_frame_at_seconds_ago": 0.12
      },
      "detection": {
        "observations_total": 1830,
        "observations_last_frame": 2,
        "last_observation_at_seconds_ago": 0.12
      },
      "tracker": {"active_tracks": 2},
      "publish": {
        "candidates_published_total": 87,
        "last_publish_at_seconds_ago": 0.4
      },
      "runtime": {
        "recognizer": "insightface",
        "detector_det_size": 960,
        "detector_degraded_to_cpu": false
      },
      "task_done": false
    }
  ]
}
```

Read top-to-bottom:

| Symptom | Likely cause |
|---|---|
| `streams: []` | `/set-camera` never started the orchestrator. Look at API logs for a 401 or an exception on the start path. |
| `task_done: true` with a `task_exception` | Orchestrator crashed. The exception string tells you which stage. |
| `frames_ingested_total: 0` after 10s | RTSP source unreachable. Verify with `ffprobe rtsp://...` from inside the API container. |
| `frames_ingested_total > 0` but `observations_total: 0` | Detector running but finds nothing. Bump `Camera.detection_input_size` (640 → 1280) or lower `INSIGHTFACE_DET_THRESHOLD`. See [DETECTION_STRATEGY.md](DETECTION_STRATEGY.md). |
| `observations_total > 0` but `candidates_published_total: 0` | Quality gate rejecting everything, or the pre-embed pool short-circuit is firing 100% of the time. Check `vms_quality_rejects_total` and `vms_embed_skipped_total` metrics. |
| `detector_degraded_to_cpu: true` | CUDA failed; the runtime is on CPU temporarily. Check `vms_runtime_cuda_failures_total` metric and GPU driver status. |
| All counters look healthy but no boxes in the UI | WS fan-out, not the pipeline. Check the browser's WS connection at `ws://localhost:8001/ws?camera_id=...` and the cam-state subscriber log (`cam-state subscriber started` should appear at API boot). |

If the orchestrator's task died, the simplest reset is `POST /set-camera`
again — it auto-restarts the orchestrator.

## Existing Frontend Compatibility

`smart-cam-app/src/pages/AiFeed.jsx` is hardcoded to `http://localhost:8001`
and `ws://localhost:8001/ws`. The API exposes the old AI service contract on
top of `vms_face`, so no frontend changes are required:

```text
POST /set-camera                 form: monitor_id
GET  /status
GET  /logs
POST /upload                     form: name, file
GET  /api/detections/{monitorId}
WS   /ws?camera_id={monitorId}
```

When `/set-camera` receives a `monitor_id` that is not already in the
`cameras` table, it creates a camera under the default tenant and builds the
RTSP source from:

```text
rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}/cam_{monitor_id}
```

In the root Docker Compose stack this resolves to `rtsp://mediamtx:8554/cam_...`,
matching the stream paths created by `smart-cam-backend`.
The React page starts the MediaMTX stream and then retries `/set-camera`, so a
fresh camera selection can become live without manually pre-seeding rows.

For the full app stack:

```powershell
docker compose up --build -d mysql postgres qdrant minio redis mediamtx smart-cam-backend smart-cam-ai smart-cam-ai-worker smart-cam-app
```

`smart-cam-ai` runs migrations and serves the compatibility API on port 8001.
`smart-cam-ai-worker` consumes Redis detection candidates, writes match events,
and publishes alerts. The API process tails those alerts and patches names into
the in-memory detection cache used by `/api/detections/{monitorId}` and `/ws`.

## When to cluster (and when not to)

The single biggest mis-investment for a new VMS team is clustering early to
"scale up." Below is the honest decision tree for `vms_face` + MediaMTX as
the camera count grows.

### Tier 1 — single host (1–200 cameras)

Don't cluster anything. One MediaMTX + one set of vms_face services on one
host is the right shape. The current `docker-compose.gpu.yml` is sized for
this. Tune MediaMTX (force TCP, raise buffers) and fix bad cameras one by
one with `probe_rtsp`. If you can't get to a healthy state at this tier,
adding more nodes won't help — you have a single-camera problem masquerading
as a scale problem.

### Tier 2 — single host, growing (200–500 cameras)

Still one host, but split MediaMTX from vms_face onto separate Docker
networks or separate VMs on the same physical host. The bottleneck is no
longer compute (your Blackwell is at 17% with a couple of streams); it's
the per-stream PyAV decode CPU cost on the AI side. NVDEC hardware decode
(Tier-2 task P1 in the [DETECTION_STRATEGY.md](DETECTION_STRATEGY.md))
gets you to ~500 cameras per node without clustering.

### Tier 3 — multi-host, regional edges (500–2,000 cameras)

This is where you cluster. The pattern is **MediaMTX edges close to
camera groups + central AI inference pool**:

```
   ~200 cameras       ~200 cameras       ~200 cameras
        │                   │                   │
        ▼                   ▼                   ▼
  ┌──────────┐         ┌──────────┐        ┌──────────┐
  │ MediaMTX │  ...    │ MediaMTX │  ...   │ MediaMTX │   ← regional edges
  │  edge-A  │         │  edge-B  │        │  edge-J  │      (10 of them, one per VLAN/site)
  └────┬─────┘         └────┬─────┘        └────┬─────┘
       │                    │                    │
       └────────────────────┴────────────────────┘
                            │ (clean re-stream over backbone)
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
  ┌──────────┐         ┌──────────┐         ┌──────────┐
  │ vms_face │   ...   │ vms_face │   ...   │ vms_face │   ← orchestrator pool
  │  orch-1  │         │  orch-2  │         │  orch-N  │      (~64 cameras each,
  └──────────┘         └──────────┘         └──────────┘      stateless, scaled to N)
       │                    │                    │
       └────────────────────┴────────────────────┘
                            │
                  shared Redis Streams / Postgres / Qdrant / MinIO
                  (also the match-worker / reid-worker pools)
```

Why this topology:
- **MediaMTX edge near cameras eliminates 90% of RTP loss.** Most loss
  happens on the camera → first-hop network. A MediaMTX on the same VLAN
  rebuilds a clean stream that survives the backbone.
- **Edges absorb camera-side bursts.** A camera dropping packets for 5
  seconds shows up at the edge, not at the AI cluster. The edge buffers,
  recovers, and re-publishes cleanly.
- **vms_face orchestrators stay stateless.** Each owns ~64 cameras (the
  default `pipeline_face_concurrency=8` × ~8 fps × buffering). Scale by
  adding pods. The match worker and ReID worker pools scale independently.
- **Storage stays central.** Postgres + Qdrant + MinIO are one fleet,
  shared by every orchestrator. At very high scale the Qdrant appearance
  log graduates to Milvus + CAGRA (>100M points).

### Tier 4 — extreme scale (2,000+ cameras)

Kubernetes. Helm-chart this. Per-region inference pools with regional
Qdrant replicas of the enrolled gallery for low-latency 1:N. Kafka
instead of Redis Streams. Beyond the scope of this repo today — listed
for completeness so you don't accidentally architect for it at Tier 1.

### Common clustering mistakes

1. **Clustering MediaMTX before fixing cameras.** Adding MediaMTX
   instances doesn't help if the camera→first-hop link is dropping
   packets. The new MediaMTX sees the same loss.
2. **Adding orchestrator processes when the bottleneck is the camera
   stream.** A bad camera occupies one orchestrator slot per
   reconnect attempt. Replicating the orchestrator just gives the
   bad camera more slots to consume.
3. **Sharing one big Postgres at Tier 4.** Past ~5k cameras, the
   `detection_events` hypertable wants its own database (or at
   least its own Postgres). Plan the cutover before you need it.
4. **One Qdrant for both enrolled and appearance.** Already
   addressed in this repo (split collections). Don't merge them
   back to save ops effort — the read patterns diverge sharply.

## Phased roadmap

- **Phase 1 (this code):** Qdrant + Postgres + Redis + insightface ONNX, **pluggable recognizer (ArcFace/AdaFace), per-track top-K quality-weighted embedding pool**. Single-node, Windows/Linux.
- **Phase 2:** NVIDIA DeepStream 7.1 inference node, TensorRT engines (SCRFD-34G + AdaFace), NvDCF tracker (with appearance features), Kafka broker, Triton.
- **Phase 3:** Recognizer fine-tuning on local CCTV captures + degradation augmentations. *Not* GFPGAN-in-the-recognition-path — that's an evidence-only post-process. Quality-aware FR (AdaFace) handles low-res better than SR.
- **Phase 4:** Kubernetes scale-out, dual-collection Qdrant (enrolled / appearance), Milvus-on-CAGRA when past 100M vectors, Prometheus/Grafana, DPDP retention worker.

## Recognizer choice

| Backend | Set in `.env` | When to use |
|---------|---------------|-------------|
| `insightface` (default) | `RECOGNIZER_BACKEND=insightface` | Fastest. Reuses buffalo_l's ArcFace head — no extra forward pass. Good baseline for indoor / cooperative captures. |
| `adaface` | `RECOGNIZER_BACKEND=adaface` + `ADAFACE_MODEL_PATH=/path/to/adaface_ir101_webface12m.onnx` | **Recommended for surveillance.** AdaFace's quality-aware loss gives ~5-15% TPR improvement on low-res / outdoor / distant cameras (TinyFace Rank-1: 72.29% open-source SOTA). Get the checkpoint from [github.com/mk-minchul/AdaFace](https://github.com/mk-minchul/AdaFace) and export with their `convert_to_onnx.py`. |

⚠ AdaFace and ArcFace embeddings live in different vector spaces. **Switching backends invalidates the existing gallery — re-enroll all persons after a switch.**

⚠ Cosine thresholds are also recognizer-specific:
- `INSIGHTFACE_REC_THRESHOLD` (default `0.62`) for ArcFace / buffalo_l.
- `RECOGNIZER_ADAFACE_THRESHOLD` (default `0.35`) for AdaFace.

`FaceMatcher` resolves the active threshold via
`settings.effective_recognizer_threshold(recognizer_name)`. A single shared
threshold cannot serve both backends — AdaFace cosines are systematically
lower than ArcFace cosines for same-identity pairs.

A/B test the two on your own footage:
```powershell
python -m vms_face.eval.harness `
  --gallery .\eval_data\gallery --probe .\eval_data\probe `
  --recognizer insightface --out .\eval_data\arcface_report

python -m vms_face.eval.harness `
  --gallery .\eval_data\gallery --probe .\eval_data\probe `
  --recognizer adaface --out .\eval_data\adaface_report
```

## Multi-frame track fusion (top-K quality-weighted pool)

Each tracked face accumulates the K highest-quality embeddings seen for that
identity. The match worker queries Qdrant against the pool's quality-weighted
average — not single frames. This is the simplest, most-effective form of
multi-frame fusion and the single biggest accuracy win available without
swapping models. Tune via `.env`:

- `TRACK_POOL_TOP_K=5` — number of best-quality embeddings retained per track
- `TRACK_MIN_HITS_TO_MATCH=3` — track must have this many hits before we publish

Trade-off: first match for a brand-new identity is delayed by `min_hits - 1`
frames (~250 ms at 8 FPS with min_hits=3). In exchange we get dramatic
reduction in single-frame match noise.

## Supervised face learning queue

The live pipeline can strengthen the enrolled gallery from real CCTV
conditions without retraining the base model online. When the match worker sees
a known-person match with a good similarity score, good quality score, a crop
snapshot, and a non-duplicate embedding, it stores the crop as a pending
`face_learning_samples` row.

Pending samples are review-only. They do not affect recognition until an
operator approves them:

- `GET /face-learning/samples?tenant_id=<uuid>&status=pending`
- `POST /face-learning/samples/{sample_id}/approve`
- `POST /face-learning/samples/{sample_id}/reject`

Approval creates a `face_enrollments` row and upserts the embedding into the
enrolled Qdrant collection with source `auto-learning`. This is useful for names
like Chitra where the studio/gallery photo matches, but live CCTV crops are low
resolution or off-angle.

Key settings:

- `FACE_LEARNING_ENABLED=true`
- `FACE_LEARNING_MIN_SIMILARITY=0.68`
- `FACE_LEARNING_MIN_QUALITY=0.60`
- `FACE_LEARNING_MIN_FACE_PX=96`
- `FACE_LEARNING_MIN_BLUR_VAR=45.0`
- `FACE_LEARNING_MAX_SAMPLES_PER_TRACK=6`
- `FACE_LEARNING_MAX_PENDING_PER_PERSON=100`
- `FACE_LEARNING_DUPLICATE_SIMILARITY=0.985`

Canonical defaults live in `config/settings.py`. `.env.example` documents the
same values; `.env` is for operator overrides only.

## DeepStream backend plan

`AI_INGEST_BACKEND=opencv` remains the working default. The Phase 2 path is to
use NVIDIA DeepStream for RTSP ingest, GPU decode, TensorRT detection, and
NvDCF tracking, then hand each frame/object set to:

```text
vms_face.pipeline.deepstream_bridge.DeepStreamCandidateBridge
```

That bridge publishes the same Redis `FaceCandidate` stream used by the current
orchestrator, so the match worker, Qdrant gallery, Postgres events, WebSocket
alerts, journey map, and supervised face learning queue stay unchanged.

This is intentionally a hybrid design: DeepStream accelerates video and
detection; `vms_face` remains the identity/matching/event layer.

## Resource tuning — fewer GPU/CPU cycles per frame

A lot of the system's cost is paid per face per frame. The defaults are set
for accuracy on a well-resourced node; the levers below let an operator
trade some accuracy or latency for substantially lower resource use. Each
row shows the typical resource impact assuming the rest of the system is
unchanged. Compose them by all means — the savings are roughly multiplicative
because they hit different pipeline stages.

### Defaults shipped (no operator action needed)

These already apply to fresh deployments — no opt-in flag required. They
were chosen because they save real cost without measurable accuracy impact.

| Lever | What it does | Savings | Where |
|---|---|---|---|
| **Skip aux landmark heads** | buffalo_l's `2d106det` (~5 MB) and `1k3d68` (~143 MB) ONNX models are not loaded. Their outputs are never read on the hot path; the 5-point landmarks the recognizer needs come from SCRFD. | ~150 MB GPU memory and 3–5 ms per face of inference time. Re-enable via `INSIGHTFACE_LOAD_AUX_LANDMARKS=true`. | [insightface_runtime.py](infra/insightface_runtime.py) |
| **Pre-embed quality gate** | If a track's embedding pool is full and the current crop's quality score can't beat the worst pool member, skip the recognizer call entirely. The pooled embedding can't change. | 30–60% fewer recognizer calls on long stable tracks. Measured via `vms_embed_skipped_total{reason="pool_saturated_lower_quality"}`. | [pipeline/orchestrator.py](pipeline/orchestrator.py), [services/track_embedding_pool.py](services/track_embedding_pool.py) |
| **Track-local embed cadence** | Replaces the global `frame.seq % N` gate with per-track `frames_since_last_embed`. Tracks no longer all embed on the same frame indices, so the GPU stays warm instead of bursting and idling. | Smoother GPU utilization; the same total embed budget is spread over time, reducing peak load by ~30%. | [pipeline/orchestrator.py](pipeline/orchestrator.py), [services/face_tracker.py](services/face_tracker.py) |
| **Quality-gate downsample** | Resizes large face crops to 64×64 before the Laplacian / brightness aggregates. Both metrics are robust to this scale; we only used the full crop for backwards-bug-compat. | ~10× faster blur+brightness eval on big faces. | [services/face_quality.py](services/face_quality.py) |
| **Snapshot quality 80** | JPEG quality dropped from 88 to 80. Visually indistinguishable on face thumbnails. | ~30% smaller files in MinIO, ~25% faster encode. Tune via `SNAPSHOT_JPEG_QUALITY`. | [services/snapshot_pump.py](services/snapshot_pump.py) |
| **Lazy API model load** | API process no longer loads buffalo_l on startup unless `API_WARMUP_FACE_RUNTIME=true`. The API doesn't run inference itself in the multi-process deployment. | ~600 MB GPU memory saved per API replica. | [api/main.py](api/main.py) |
| **On-demand genderage** | The genderage head no longer runs inside `FaceAnalysis.get()` on every face every frame. The orchestrator calls it explicitly, only while a track's gender/age vote still needs samples (≤ `ATTRIBUTES_MAX_VOTES` calls per track). Also the only way gender works under `PIPELINE_BATCHED_INFERENCE=true`. | Genderage inference drops from O(faces × frames) to O(1) per track — on a 1-minute track that's ~480 calls → ≤ 8. Disable via `INSIGHTFACE_ONDEMAND_GENDERAGE=false`. | [infra/genderage.py](infra/genderage.py), [services/track_attributes.py](services/track_attributes.py) |
| **Pool quality floor** | Crops below `TRACK_POOL_MIN_QUALITY` (0.30) never enter the embedding pool — and the pre-embed gate therefore skips their recognizer call too. Roadmap task A4. | Fewer garbage embeds computed AND garbage pooled embeddings never published (fewer confident-wrong matches downstream). | [services/track_embedding_pool.py](services/track_embedding_pool.py) |
| **Per-service compose limits** | Explicit `cpus` / `memory` caps in `docker-compose.gpu.yml`; reid-worker no longer pinned to GPU. | Bounded blast radius if a service misbehaves; reid replicas free ~600 MB GPU each. | [docker-compose.gpu.yml](docker-compose.gpu.yml) |

### Operator-tunable (you decide the trade-off)

These are bigger savings, but they trade something — accuracy on small faces,
publish latency, or first-match latency. Try one at a time and re-run the
benchmark in the [Future pipeline & accuracy roadmap](#future-pipeline--accuracy-roadmap)
section after each.

| Lever | Default | Savings if reduced | Trade-off |
|---|---|---|---|
| `TARGET_FPS` | 8.0 | Linear: cut to 5 fps → -37% GPU + -37% ingest CPU. | Re-id misses on fast walk-throughs; first-match latency stays the same but match-rate-per-second drops. |
| `INSIGHTFACE_DET_SIZE` | 960 | -50% detect compute when cut to 640. | Misses small/distant faces. Use per-camera (`Camera.detection_input_size`) — keep 960+ on parking-lot cams, drop to 640 on doorways. |
| `EMBED_EVERY_N_FRAMES` | 5 | Linear past warmup: 10 → -50% recognizer calls. | Slower track-pool saturation; dynamic identities take longer to confirm. |
| `TRACK_POOL_TOP_K` | 5 | -20% memory per track; cuts tracker overhead slightly. | Smaller pool = noisier match query; FNIR @ FPIR=1e-3 worsens by ~1–2% per K dropped. |
| `BATCH_DETECT_MAX` / `BATCH_EMBED_MAX` | 8 / 16 | Bigger batches = more sharing across cameras; +30–50% throughput at the cost of +window_ms latency. | Latency increases by `BATCH_*_WINDOW_MS`; useful when many cameras share one runtime. |
| `PIPELINE_FACE_CONCURRENCY` | 8 | Lower = less peak GPU contention with many faces in one frame. | Crowded frames serialize more; per-frame end-to-end latency rises. |
| `MATCH_WORKER_CONCURRENCY` | 32 | Lower = fewer Postgres / Qdrant connections in flight per worker. | Reduces match throughput; pair with PgBouncer (Tier-3 task O3) before going high. |
| `QUALITY_MIN_FACE_PX` | 40 | Higher (e.g. 80) → fewer faces to embed, lower GPU; lower (e.g. 24) → more faces, more GPU. | Higher rejects small / distant faces entirely. |
| `MOTION_GATE_ENABLED` | false | On quiet cameras (parking lots at night, empty corridors) skips 70–95% of SCRFD detect calls via a ~0.2 ms CPU frame-difference check. Never skips while tracks are alive; a full detect always runs at least every `MOTION_GATE_MAX_SKIP_FRAMES`. Roadmap task E.3. | ~1 frame of first-detect latency when motion starts in an empty scene. Watch `vms_motion_gate_skips_total`. |
| `RETENTION_*_DAYS` | 90 / 7 / 365 | Shorter retention = less Postgres + MinIO + Qdrant storage. | Forensic search window shrinks. |

### Realistic combined savings

Stacking the no-opt-in defaults above (which already shipped) gives roughly:

- **GPU memory**: -750 MB per process (-150 MB aux landmarks, -600 MB API skip-warmup), or about **40% lower steady-state GPU memory** on a typical multi-process deployment.
- **GPU compute per face**: -3–5 ms inference time saved on every detect (aux landmarks gone) plus 30–60% of recognizer calls eliminated by the pre-embed gate. Combined: **40–60% fewer GPU cycles per face on stable tracks**, smaller savings on transient/new faces.
- **CPU per frame**: ~10× faster blur/brightness eval on the quality gate, plus ~25% faster snapshot encoding. **20–35% lower CPU per frame** on average.
- **Storage**: ~30% smaller snapshot bucket. Linear with operator's `RETENTION_*_DAYS`.

Combine the operator-tunable knobs above and you can plausibly land in
**60–75% lower per-camera resource cost** vs. the original defaults — but
that includes accepting trade-offs on small-face detection and first-match
latency. Use the metrics (`vms_embed_skipped_total`, `vms_camera_fps`,
`vms_pipeline_frame_latency_seconds`, `vms_runtime_degraded`) to calibrate;
don't trust a single number out of context.

A truly transformative jump (the 80%+ figure that gets quoted at
conferences) requires the **NVDEC hardware decode** path (Tier-2 task P1
in the roadmap) — software H.264 decode is the largest remaining CPU draw
per camera and switching to GPU-resident frames is a 30–60% CPU reduction
on its own.

---

## Pipeline strength assessment

Where the system actually is today, with no marketing language. Each row is
"what's done", "evidence in the code", and "what's still missing" so a new
contributor can calibrate before picking up work.

| Dimension | Today | Evidence | Gap |
|---|---|---|---|
| **Detection quality** | SCRFD-10G via insightface buffalo_l. Strong on WIDER FACE Hard (83.05%); per-camera `detection_input_size` so parking-lot cameras and doorways don't share the same SCRFD anchor scale. | [infra/insightface_runtime.py](infra/insightface_runtime.py), [Camera.detection_input_size](domain/models.py) | No mask/occlusion classifier; pose head often empty in shipped buffalo_l builds (silently makes the pose filter inert — surfaced via `vms_detector_pose_available` gauge). |
| **Recognition quality** | Pluggable: ArcFace (free with buffalo_l) or AdaFace IR-101 / WebFace12M (separate ONNX). Per-recognizer cosine thresholds. Top-K=5 quality-weighted embedding pool per track — single biggest accuracy win without changing models. | [services/track_embedding_pool.py](services/track_embedding_pool.py), [infra/recognizers/adaface.py](infra/recognizers/adaface.py), [services/face_matcher.py](services/face_matcher.py) | No fine-tuning on local CCTV; not yet evaluating against FNIR @ FPIR=1e-3 (the right surveillance metric); no liveness / anti-spoof at enrollment. |
| **Tracking** | SORT-style: Kalman + Hungarian assignment + DeepSORT-lite appearance term (cosine on smoothed embedding, gated by IoU). Vectorized cost matrix (one matmul, not T×D Python loops). | [services/face_tracker.py](services/face_tracker.py) | No global track id across cameras inside one process (cross-camera linking is the ReID worker's job); ID switches under heavy occlusion still happen. |
| **Throughput** | Per-face fan-out is parallel and bounded; per-track `frames_since_last_embed` keeps GPU warm; AdaFace embedding and SCRFD detect both batch across cameras when `PIPELINE_BATCHED_INFERENCE=true` (3-5× detect, ~2× embed). | [pipeline/orchestrator.py](pipeline/orchestrator.py), [infra/batched_scrfd.py](infra/batched_scrfd.py), [infra/batcher.py](infra/batcher.py) | Software-decoded RTSP (no NVDEC); no CUDA-resident frames; GPU H2D copies on every detect. NVDEC + zero-copy is DeepStream territory (Phase 2). |
| **Reliability** | CUDA → CPU fallback now self-heals (cooldown + auto re-promotion + `vms_runtime_degraded`); per-frame deadline (1.5s default) with stream reopen on stall; bounded snapshot upload queue (drops oldest, never piles up); match worker has DLQ + XAUTOCLAIM. | [infra/insightface_runtime.py](infra/insightface_runtime.py), [services/snapshot_pump.py](services/snapshot_pump.py), [workers/match_worker.py](workers/match_worker.py) | API restart kills in-process orchestrators (single-process today); WS reconnect doesn't replay last-N-seconds of overlay. |
| **Security** | JWT HS256 on every protected route; `tenant_id` from claim, never query string; admin role gates tenant CRUD; legacy router behind `X-API-Key`; WS auth via `Sec-WebSocket-Protocol: bearer, <jwt>`; AES-256-GCM at-rest encryption of `Camera.rtsp_url`; RTSP scheme allowlist blocks `file://` SSRF. | [api/deps.py](api/deps.py), [core/security.py](core/security.py), [core/crypto.py](core/crypto.py), [domain/types.py](domain/types.py) | No mTLS; rate limiting; per-tenant DEK (single key today); audit-trail tamper detection. |
| **Multi-tenancy** | Tenant scope bound to JWT claim; routes return 404 (not 403) for cross-tenant access so existence isn't probeable; appearance log includes `tenant_id` payload index. | every `api/routes/*.py` | `track_links` and `face_learning_samples` lack tenant FK (orphans on tenant delete — TODO migration); legacy router shares one tenant. |
| **Compliance (DPDP)** | DPDP audit log on every 1:N hit; right-to-erasure endpoint (`POST /persons/{id}/forget`) does Postgres + Qdrant enrolled + Qdrant appearance + MinIO; retention worker deletes events / snapshots / audit log on schedule; encrypted camera credentials. | [services/audit.py](services/audit.py), [api/routes/persons.py](api/routes/persons.py), [workers/retention_worker.py](workers/retention_worker.py) | Audit failures are logged-not-fatal (write-or-fail recommended); no DSAR/data-export endpoint; no automated DPIA artifact generation. |
| **Observability** | 30+ Prometheus metrics covering FPS, latency, queue depth, runtime degradation, batch sizes, snapshot drops, match outcomes, audit, retention. Structured JSON logs. OpenTelemetry across processes (off by default; one trace_id follows a face from camera → bus → match worker → Postgres + Qdrant when on). | [core/metrics.py](core/metrics.py), [core/tracing.py](core/tracing.py) | No Grafana dashboards committed in repo; no SLOs / alerting rules; no eval-harness CI gate. |
| **Scalability** | Stateless workers behind Redis Streams consumer groups (horizontal scale via replicas); per-camera orchestrator processes; per-tenant Qdrant filtering; TimescaleDB hypertable on `detection_events`. | `docker-compose.gpu.yml` deploys 2× match-worker by default | Above ~5k cameras: Kafka instead of Redis Streams; PgBouncer; gRPC to Qdrant; multi-region enrolled gallery; Milvus + GPU CAGRA above 100M appearance points. |
| **Deployability** | One-command stack: `docker compose -f docker-compose.gpu.yml up -d` builds API + workers, brings up infra (Postgres / Qdrant / Redis / MinIO / MediaMTX), runs migrations via init container, exposes GPU through NVIDIA Container Toolkit. | [Dockerfile](Dockerfile), [docker-compose.gpu.yml](docker-compose.gpu.yml), [docker-entrypoint.sh](docker-entrypoint.sh) | No Helm chart; no Terraform; no automated cert provisioning; no CI/CD pipeline. |

### One-line verdict
**Production-ready for ~50–500 cameras per node with the current single-host
deployment.** Architecturally correct for 2,000-camera scale — every named
bottleneck has a named fix in this README. **Not yet defense-grade**: that
requires fine-tuning AdaFace on local CCTV, liveness, mask/occlusion, and
multi-modal fusion (face + body + gait). Those are the next-tier items below.

---

## Future pipeline & accuracy roadmap

Concrete, picked-up-able tasks for incoming developers. Each item is
self-contained — file paths, expected effort, and an acceptance criterion
you can actually measure. Items are ordered by **return per engineer-day**;
pick from the top.

> **Benchmark setup (do this first, regardless of which task you pick).**
>
> Capture 5–10k labeled face crops from your own deployed cameras across
> day/night, indoor/outdoor, and a representative pose distribution. Build a
> probe set with 1k+ identities, of which ~30% are *not* enrolled (open-set
> probes, since real surveillance is open-set). Use `eval/harness.py` as the
> scaffold and make it report **FNIR @ FPIR = 1e-3** as the headline metric
> — that's the NIST FRVT 1:N convention. Don't just report TPR/FPR; they're
> not comparable across deployments. Re-run the benchmark before AND after
> every change in this list — accuracy regressions hide easily.

### Tier 1 — accuracy (highest leverage)

#### A1. Fine-tune AdaFace on local CCTV captures
- **Why.** Public AdaFace is trained on WebFace12M (mostly clean web faces).
  Surveillance faces are off-axis, low-light, motion-blurred, JPEG-compressed,
  often tiny. A 3–5 epoch fine-tune of the IR-101 backbone on **your data**
  with degradation augmentation is the single biggest accuracy lift available.
  Expected: 5–15% FNIR @ FPIR=1e-3 reduction on local data.
- **Where.** Out of repo (training infra) + new ONNX export + drop-in
  replacement of `ADAFACE_MODEL_PATH`.
- **Inputs needed.** Captured + labeled identity dataset (≥5k crops, ≥500
  identities with ≥5 images each). Augmentations: motion blur kernel sweep,
  ISO noise injection, JPEG cycle, downsample-then-upsample.
- **Effort.** 2–4 weeks on a single A100/H100. Most of the cost is
  data labeling, not training.
- **Acceptance.** ≥10% FNIR @ FPIR=1e-3 reduction on the local probe set
  vs. the public AdaFace checkpoint, no regression on clean indoor probes.

#### A2. Head-pose model + reinstate the pose filter
- **Why.** [services/face_quality.py:62-67](services/face_quality.py#L62-L67)
  filters on yaw/pitch only when buffalo_l populates them. In many shipped
  builds it doesn't — the gauge `vms_detector_pose_available` reports 0 and
  the filter is silently a no-op. Off-axis crops then enter the embedding
  pool and degrade matching.
- **Where.** New `infra/head_pose.py` (small ONNX wrapper, e.g. WHENet or
  6DRepNet), call it from [services/face_quality.py](services/face_quality.py)
  when the detector's own pose head is empty.
- **Effort.** ~2 days. The model is ~10MB; inference is ~0.5–1ms per face.
- **Acceptance.** Off-axis (>45° yaw) faces no longer enter the embedding
  pool. Measure pool-mean-quality before/after on a real video;
  expect the pool's mean quality to rise by 0.05–0.15.

#### A3. Mask / occlusion classifier
- **Why.** Masked faces score "fine" on every metric we currently check —
  size, det_score, blur, brightness — but recognizer accuracy collapses on
  them. Real DPDP-compliant deployments need to either reject masked crops
  upstream or surface them as a separate alert kind.
- **Where.** New `infra/occlusion.py` (tiny CNN ONNX, ~1 MB), called from
  [services/face_quality.py](services/face_quality.py); add an
  `EventKind.OCCLUDED` and emit it as a soft alert rather than rejecting
  outright.
- **Effort.** ~3 days (model selection + integration; many open masks/no-
  masks classifiers are available pre-trained).
- **Acceptance.** Masked faces are flagged in `extra.occlusion_score >= 0.5`
  and excluded from the embedding pool; recognizer false-positive rate on
  masked probes drops to <2%.

#### A4. Quality floor on pool admission
- **Why.** [services/track_embedding_pool.py](services/track_embedding_pool.py)
  admits the top-K by quality, but if a track only ever sees 3 frames of
  quality 0.2, those poor crops still pool. A hard floor (e.g. 0.4)
  guarantees pool quality.
- **Where.** [services/track_embedding_pool.py](services/track_embedding_pool.py)
  + new setting `track_pool_min_quality`.
- **Effort.** 0.5 day.
- **Acceptance.** No regression on TPR; FNIR @ FPIR=1e-3 drops by 1–3% on
  surveillance-quality probes.

#### A5. Liveness / anti-spoof at enrollment
- **Why.** A printed photo or screen-replay can be enrolled today. After
  enrollment the spoof matches itself everywhere. Adding a liveness gate
  on `POST /persons/{id}/enrollments` shuts that down.
- **Where.** New `services/liveness.py` (e.g. SilentFaceAntiSpoofing ONNX),
  hook into [services/enrollment.py](services/enrollment.py) before the
  Qdrant upsert.
- **Effort.** ~3 days for enrollment-time only. Runtime liveness on the
  live pipeline is a much bigger project (depth, RGB+IR, or video-based).
- **Acceptance.** Replay attack via webcam+monitor rejected with HTTP 422
  on enrollment; legitimate enrollment paths unaffected.

### Tier 2 — performance

#### P1. NVDEC hardware video decode
- **Why.** PyAV defaults to software H.264 decode — ~0.5–1.0% CPU per camera
  per frame at 1080p. At 200 cameras per node that's 10–20 host CPU cores
  spent on decode alone.
- **Where.** [pipeline/ingest.py](pipeline/ingest.py) — replace PyAV's
  software codec with `h264_cuvid`, plumb the GPU-resident frame all the
  way to the SCRFD ONNX call. This is also a stepping stone toward
  DeepStream proper.
- **Effort.** ~1 week.
- **Acceptance.** 30–60% CPU reduction per camera; no change in detection
  output (numerical equivalence).

#### P2. gRPC for the Qdrant appearance write path
- **Why.** [infra/qdrant.py:47](infra/qdrant.py) `prefer_grpc=False`. HTTP
  is fine for the gallery (low QPS); the appearance write path at 2k
  cameras × 1 face/sec sustained is bandwidth-bound.
- **Where.** Per-store `prefer_grpc` toggle in [infra/qdrant.py](infra/qdrant.py).
- **Effort.** 1 day.
- **Acceptance.** Appearance write latency p99 drops by ≥30%.

#### P3. Embedding-by-id payload on the bus
- **Why.** Every `FaceCandidate` carries its 512-D vector inline as JSON
  (~5 KB). At 2k cameras × 1 face/sec that's 10 MB/s through Redis. The
  match worker doesn't need it inline — it can fetch by `appearance_point_id`.
- **Where.** Write to Qdrant **before** publishing in
  [pipeline/orchestrator.py](pipeline/orchestrator.py); ship `point_id` in
  the FaceCandidate; match worker reads vector via Qdrant retrieve when
  needed.
- **Effort.** 3–5 days; needs a feature flag for safe rollout because the
  payload format changes.
- **Acceptance.** Redis bandwidth drops ≥80%; no change in match outcomes.

### Tier 3 — operability

#### O1. Grafana dashboards committed to the repo
- **Why.** 30+ Prometheus metrics, no canonical visualization. Every team
  picking this up redoes the same dashboards.
- **Where.** New `dashboards/` directory with JSON exports for: per-camera
  health (FPS, queue depth, drops, runtime_degraded), system (GPU util,
  RSS, CPU), match-worker (inflight, processed, autoclaim, DLQ),
  retention (deleted counters), batch (size histogram, wait latency).
- **Effort.** 2–3 days.
- **Acceptance.** A new operator can clone the repo, point Grafana at
  Prometheus, and see the full state at a glance.

#### O2. Eval harness CI gate
- **Why.** Right now an embedding-related regression (e.g. accidentally
  flipping BGR/RGB on AdaFace) only surfaces when someone notices match
  rates dropped. A CI gate that runs `eval/harness.py` against a fixed
  probe set and fails the build on >2% FNIR regression catches it pre-
  merge.
- **Where.** New GitHub Actions workflow + a small fixture probe set
  committed (or pulled from S3).
- **Effort.** 2–3 days.
- **Acceptance.** Every PR runs the eval; regressions block merge.

#### O3. PgBouncer in transaction mode
- **Why.** Postgres pool sizing today (`pool_size=20, max_overflow=10`
  per process) doesn't survive >2 worker replicas. PgBouncer
  multiplexes across server connections.
- **Where.** Add to [docker-compose.gpu.yml](docker-compose.gpu.yml);
  point `POSTGRES_DSN` at `pgbouncer:6432`.
- **Effort.** 0.5 day.
- **Acceptance.** Idle Postgres connections drop from N×30 to ~20 total
  even with N=10 workers.

### Tier 4 — advanced / Phase 2+

#### F1. Real DeepStream inference path
- **Why.** Native NVDEC + nvinfer + nvtracker + GPU-resident buffers. The
  jump from 200 cameras/node to 1000+ cameras/node lives here.
- **Where.** Existing [pipeline/deepstream_bridge.py](pipeline/deepstream_bridge.py)
  is the seam — it publishes the same Redis FaceCandidate stream, so the
  brain (match worker / Qdrant / events / WS / face-learning) doesn't change.
- **Effort.** 6–9 months per the project research memo. Most of it is
  packaging TensorRT engines (SCRFD-TRT, AdaFace-TRT) and wiring the
  GPU-buffer copy into `DeepStreamCandidateBridge.handle_frame()`.

#### F2. Cross-camera ReID with face + body fusion
- **Why.** Today's ReID is face-only. People whose faces never appear (back-
  of-head shots, low resolution) can't be linked. Adding body re-id (e.g.
  OSNet) gives a fallback identity signal when faces are missing.
- **Where.** New worker `workers/body_reid_worker.py`; add a `body_track_links`
  table; merge into the journey graph alongside `track_links`.
- **Effort.** 4–6 weeks.

#### F3. Federated identity across tenants with cryptographic proofs
- **Why.** Multi-org campus: tenant A's blacklist needs to be checkable
  against tenant B's incoming faces, but neither can see the other's
  embeddings. PSI (private set intersection) or homomorphic comparison
  is the right primitive.
- **Effort.** Quarter+. Listed for completeness; only relevant for
  multi-tenant federations.

### How to claim a task

1. Open an issue with the task code (e.g. "A2 head-pose").
2. Run the benchmark setup at the top of this section so you have a
   baseline number to compare against.
3. Read the cited files end-to-end before changing anything.
4. Land the change behind a feature flag if it touches inference output
   (recognition / detection / pool semantics). Existing flags follow the
   pattern `PIPELINE_*` / `RECOGNIZER_*` / `QUALITY_*`.
5. Re-run the benchmark, attach pre/post numbers in the PR description.
6. Update [SERVICES.md](SERVICES.md) and the relevant README section so
   the next contributor sees the new state.

## Directory layout

```
vms_face/
├── config/        # pydantic settings, loaded from .env
├── core/          # logging, exceptions, metrics
├── domain/        # SQLAlchemy models, Pydantic schemas, enums
├── infra/         # adapters: postgres, qdrant, redis, minio, insightface
├── services/      # business logic: quality gate, tracker, matcher, enrollment
├── pipeline/      # ingest → detect → track → embed orchestration
├── api/           # FastAPI gateway (REST + WebSocket)
├── workers/       # async background workers
└── alembic/       # DB migrations
```
