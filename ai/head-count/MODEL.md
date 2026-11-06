> **Study guide** (written 2026-10-20 for the AI study bundle). Paths in it are relative to that bundle: `code/head-count/…` = this folder; weights = `ai/head-count/models/`; `../docs/…` = `docs/…`; `../integration/backend` = `backend/`; `../integration/compose` = the root `docker-compose.yml`. Model catalogue: `models/README.md`.

# 02 — Head count (YOLOv8n head detector → tracked count → occupancy)

Study guide for the head-count pipeline, written from the code in
`code/head-count/` (a copy of `smart-cam-ai/app/head-count/`) and the backend glue in
`../integration/backend/src/`. All file:function references are relative to
`code/head-count/src/headcount/` unless prefixed otherwise. Numbers marked
**measured** are quoted from the docs in `../docs/` with the section given.

---

## 1. What it does + process topology

A standalone FastAPI microservice that counts **human heads** on the cameras an operator
switches on (per-camera toggle in the VMS), publishes a live count with reliability flags
to the backend every 5 s, and serves an annotated MJPEG preview plus its own dashboard.
The backend turns the counts into a live gauge, minute history, room-level fusion and
capacity alerts.

Ports: the container listens on **8000** (`api.port`); docker-compose maps it to host
**8020** (`docker-compose.drisyam-original.yml`, `"8020:8000"`). In production nginx proxies
`/headcount/*` to it.

Everything runs in **one Python process** (threads, not processes):

| Component | Where | Threads | Role |
|---|---|---|---|
| Entry point | `__main__.py:main` | main | load YAML (`config.py:load_config`), start uvicorn |
| App lifespan | `api.py:create_app.lifespan` | — | builds the manager, starts source poller and forwarder |
| Manager | `manager.py:StreamManager` | — | loads each detector **once** (shared by all cameras), owns `workers{}`, `reconcile()` adds/removes/restarts workers |
| Detector | `model.py:Detector` | — | Ultralytics `YOLO(weights)`, warm-up, per-frame `predict`, optional batch engine |
| Batch engine | `batch_engine.py:BatchInferenceEngine` | 1 (`batch-infer`) | CUDA only: groups concurrent frames into one forward pass + batched NMS |
| Stream worker | `stream_worker.py:StreamWorker` | 2 per camera (`read-<id>`, `infer-<id>`) | reader keeps only the latest frame; processor gates, infers, tracks, publishes |
| Head tracker | `head_tracker.py:HeadTracker` | (in processor) | detections → tracks → confirmed tracks = the published count |
| Zones | `zones.py:ZoneCounter` | (in processor) | optional polygons; counts only heads inside, with exit hysteresis |
| Source poller | `source.py:start_source/_loop` | 1 (`headcount-source`) | every 15 s GET backend `/api/internal/cameras`, filter `settings.headcount.enabled`, apply caps, `manager.reconcile()` |
| Forwarder | `forwarder.py:start_forwarder/_loop` | 1 (`headcount-forwarder`) | every 5 s POST all snapshots to backend `/api/internal/ai/occupancy` |
| REST/preview | `api.py` | uvicorn + threadpool | `/health`, `/count`, `/count/{id}`, `/streams`, `/snapshot/{id}`, `/video/{id}` (MJPEG), dashboard at `/` (`web/`) |

```
backend /api/internal/cameras ──(15 s poll)──> source._loop ──> manager.reconcile()
                                                                   │ start/stop
stream-service RTSP (sub-stream) ──> [read-<id>] latest frame ──> [infer-<id>]
                                                                   │ motion gate → YOLO → tracker → zones
                                                                   ▼
                                                     StreamStats.snapshot()
             forwarder._loop (5 s) ──POST /api/internal/ai/occupancy──> backend
             api /video /snapshot /streams ──> HeadCount.jsx video wall / dashboard
```

---

## 2. Frame-by-frame call path

### 2.1 Camera discovery and caps — `source.py:_to_streams`
- Keeps cameras with `settings.headcount.enabled === true`, a `monitorId` and an RTSP URL.
  `prefer_sub: true` picks `rtspSub` (the backend builds both from the stream service:
  `internal.routes.js GET /cameras` → `streamingService.getRtspEgressUrl`).
- **Skips cameras the VMS reports offline** (`status` in offline/unreachable/error/disabled;
  `HEADCOUNT_SKIP_OFFLINE`, default true). Reason in the code: OpenCV's FFmpeg backend
  serialises `avformat_open_input` behind a global mutex, so one dead camera's ~30 s open
  timeout blocks every other camera's (re)connect.
- **Two caps:** `max_streams` (default **8**, protects our CPU/GPU, always applies) and
  `max_streams_per_host` (default **4**, protects an NVR). The per-host cap is **skipped
  for relay hosts** (`HEADCOUNT_RELAY_HOSTS`, default
  `stream-service,drishyam-stream-service,mediamtx,localhost,127.0.0.1`), because the stream
  service holds one upstream pull no matter how many readers there are. Before this fix all
  20 relay URLs looked like one host and only 4 cameras ran. Deferred cameras are logged as
  a warning, not silently dropped.
- Carries the per-camera `zones` and the per-camera `imgsz` (allow-list
  416/512/640/800/960/1280, otherwise `None` = service default).
- `source.py:_loop` compares **full** configs (not just ids), so a zone or detail edit
  restarts that worker (`manager.reconcile`).

### 2.2 Source open, reconnect, read — `stream_worker.py:_connect` / `_read_loop`
- `_connect`: if `pipeline.gst_nvdec` and the URL is `rtsp://`, it opens
  `gst_pipeline_template` with `cv2.CAP_GSTREAMER`
  (`rtspsrc protocols=tcp latency=200 ! rtph264depay ! h264parse ! nvv4l2decoder ! nvvidconv ! BGRx ! videoconvert ! BGR ! appsink drop=1 max-buffers=1`).
  If that fails, or the flag is off (x86), it uses plain `cv2.VideoCapture(url)` (FFmpeg
  backend, **CPU software decode**) and sets `CAP_PROP_BUFFERSIZE=1`.
- RTSP over TCP is forced by the compose env `OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp`.
  The template is H.264 only. For H.265 cameras on Jetson you must edit the depay/parse elements.
- Sources can be RTSP, HLS/HTTP or a file. Anything FFmpeg opens works, and a digit string means a webcam index (`_open_source`).
- `_read_loop` calls `cap.read()` in a tight loop and overwrites `_latest_frame` and
  `_latest_seq`. There is no FIFO, so inference never falls behind on buffered frames.
  Every frame is still **decoded**, at the camera's full sub-stream rate.
- Reconnect: when open fails, back off `reconnect_delay` 3 s, doubling to `max_reconnect_delay` 30 s.
  A read failure releases the capture and reconnects. Both set `status=reconnecting`,
  `count_reliable=False`.
- `read_fps` is an EMA of the inter-frame **interval**, then inverted. (Averaging 1/gap gave
  "638 fps" on a 15 fps stream, OPTIMIZATION_REPORT §3.6.)
- Watchdog in `_process_loop`: no frame for `read_timeout` (10 s) → `reconnecting`, unreliable.

### 2.3 Frame sampling — `stream_worker.py:_process_loop`
- The processor polls the latest frame every 5 ms and only acts on a **new** `seq`.
- `infer_every`: only every Nth new frame is considered. The value is 1 in `config.yaml` and
  **3 in `config.docker.yaml` and `config.jetson.yaml`**. On a 15 fps sub-stream, at most about 5 frames/s
  reach the gate.
- `target_fps` (0 = off): sleeps `1/target_fps` **after** each inference. That adds idle time; it is not a strict rate cap.

### 2.4 Motion gate (adaptive, with hysteresis) — `_downscale_gray`, `_motion_frac`, `_process_loop`
- The frame is shrunk to **160x90** with `cv2.resize(INTER_AREA)` and converted to grey. Motion is the
  fraction of pixels whose `absdiff` is above **12** grey levels (`_MOTION_PIXEL_DELTA`). The comparison
  is against the **last inferred frame**, not the previous frame, so slow creep adds up until it fires.
- With `motion_adaptive: true` (the default), `thr_enter = clamp(noise_ema * motion_noise_mult(3.0), motion_floor 0.004, motion_ceiling 0.03)`
  and `thr_exit = thr_enter * motion_exit_ratio(0.4)`. `noise_ema` (starting value 0.002) is learned **only
  while static**: `0.98*ema + 0.02*frac`. If `raw_thr > ceiling`, the gate sets `gate_saturated=True`,
  which marks the camera as degraded. `motion_threshold` (0.008) is used only when `motion_adaptive=false`.
- Cadence: when there is motion, infer now. When static, infer only if the interval since the last inference is
  at least `verify_rapid_interval` (0.5 s, while "rapid verifications" are still owed) or
  `idle_infer_interval` (default 1.5 s; **10 s in docker/jetson yaml**). Otherwise skip, increment
  `frames_skipped_static`, and every `preview_refresh_sec` (0.5 s) re-encode the **live** frame
  with the last-known boxes so the tile does not freeze.
- After inference: if the count changed or there is motion, `_rapid_pending = verify_confirmations` (2). A quiet
  verify reduces it by one.

### 2.5 Pre-processing (two code paths)
**Per-frame path** (`model.py:Detector.infer`, which calls `self.model.predict(frame, device, imgsz, conf, classes, verbose=False[, half])`).
Ultralytics does the pre-processing:
- `LetterBox` with `auto=True` for a `.pt` model. The long side is scaled to `imgsz`, the short side is padded to the
  next multiple of 32 (stride), pad value **114**, interpolation `INTER_LINEAR`. A 16:9 frame at imgsz 640
  becomes a **384x640** tensor (OPTIMIZATION_REPORT §4: "ultralytics already auto-rectangles").
- BGR→RGB, HWC→CHW, `uint8 → float32` (or fp16 if `half`), `/255` → range [0,1]. No mean/std normalisation.

**Batched path** (`batch_engine.py:_geometry` + `_infer_now`) reproduces the same letterbox by hand:
`th = ceil(imgsz*h/w/32)*32`, `r = min(tw/w, th/h)`, centred padding, fill 114. The resize happens on the **CPU
into a pre-allocated uint8 batch** (`cv2.resize(..., dst=...)`). This moves about 3.6x less data over the bus and releases the GIL. Then
`torch.from_numpy(...).to(device, non_blocking=True)`, channel flip `[2,1,0]`, `permute(0,3,1,2)`,
`.to(fp16|fp32).div_(255)`. The geometry is cached per (h, w, imgsz).

### 2.6 Model
Read from `models/abel/best.pt` with a safe stub unpickler (no torch execution), plus `config.py`:

| Item | Value |
|---|---|
| Architecture | **YOLOv8n** detect (`depth_multiple 0.33`, `width_multiple 0.25`): Conv/C2f backbone + SPPF, PAN-FPN neck, anchor-free decoupled `Detect` head on layers 15/18/21 (P3/P4/P5) |
| Classes | `nc = 1`, `names = {0: 'head'}` |
| Size | ~3.0 M tensor elements, stored FP16 (Half storage), file 6.2 MB |
| Provenance | Third-party: HF repo `AbelKidane/yolov8headdetector` (`hf_repo` in yaml, auto-downloaded by `model.py:ensure_weights` if the file is missing) |
| Training args in checkpoint | fine-tuned from `yolov8n.pt` (COCO), `data: mydata.yaml` (**contents unknown**), `imgsz 640`, `epochs 30`, `batch 32`, `SGD lr0 0.01`, **`mosaic 0.0`**, `fliplr 0.5`, `scale 0.5`; Ultralytics 8.0.164, 2023-08-28; no validation metrics stored (`best_fitness: None`) |
| Input tensor | `(B, 3, H, W)` RGB float [0,1]; H×W = 384×640 for 16:9 at imgsz 640 (up to 736×1280 at imgsz 1280) |
| Raw output | `(B, 4+nc=5, A)`: `cx, cy, w, h, score` per anchor; A = 5040 at 384×640 (80·48 + 40·24 + 20·12) |
| Runtime | **PyTorch eager via Ultralytics** on every target. There is no ONNX, TensorRT or OpenVINO path in the code. |
| Device | `device: auto` → cuda, then mps, then cpu (`model.py:resolve_device`) |
| Precision | `half: false` on x86 (`config.docker.yaml`), so **FP32 on the x86 GPU**. `half: true` only in `config.jetson.yaml` |
| Threads | `torch_threads: 4` (docker/jetson yaml) → `torch.set_num_threads` in `manager.py:StreamManager.__init__` |
| Images | `Dockerfile` = CPU torch, `Dockerfile.gpu` = CUDA torch (**what the local compose stack builds**), `Dockerfile.jetson` = L4T PyTorch base (`dustynv/l4t-pytorch:r36.4.0`), FP16 + GStreamer |

`Detector.__init__` warms up on a blank `imgsz×imgsz` frame. On CUDA it also creates the batch
engine: `max_batch 16`, `max_wait_ms 8`, `iou 0.45`, `topk 300`. These values come from `getattr`
defaults, and **`DetectorConfig` has no fields for them**, so the YAML cannot change them.

**Routing (`Detector.infer`)**: `engine.try_solo()` tries the GPU lock without blocking. If it gets
the lock (no contention), the camera runs the stock `predict`, because batching loses at batch size 1:
6.5 ms vs 5.05 ms (`batch_engine.py:try_solo` docstring). If another camera holds the lock, this one
calls `engine.submit()` and waits up to 30 s for its batch. The engine's `_loop` waits for more frames
only while `fill_ema > 1.15`; a fixed wait took a single camera from 5 to 17 ms. It batches only frames
with the same `(h, w, imgsz)`. Workers **must not** hold `model_lock` while batching, or the batch would
deadlock. `stream_worker` takes `model_lock` only for non-batched detectors.

### 2.7 Post-processing
- **Per-frame path** (Ultralytics NMS): `conf` from the YAML (**0.4** in docker/jetson, 0.35 in
  `config.yaml`, model default 0.35). `iou` is **not passed**, so the Ultralytics default **0.7** applies.
  `max_det` defaults to 300, and `classes: None` means all classes (there is only one).
- **Batched path** (`batch_engine.py:_decode`): transpose to `(B, A, 5)`, take the class max, then keep the
  **top-k 300** anchors per image (avoids a `nonzero()` GPU sync). Next: xywh→xyxy, remove the padding, divide by `r`,
  apply `score > conf`, then `torchvision.ops.batched_nms(iou=0.45)` keyed by `image*1000 + class`,
  with **one** device→host copy. The result goes to `BatchResult`, a shim exposing `.boxes.{xyxy,conf,cls}` and `.names`.
- Note: **the two paths use different NMS IoU (0.7 vs 0.45)**. The batch docstring claims
  "identical detections" for its test case. In crowds the two can differ.
- The worker then pulls `xyxy` and `conf` into numpy (`stream_worker.py:_process_loop`).

### 2.8 Head tracker — `head_tracker.py:HeadTracker.update`
This is a "Level-2" tracker: constant-velocity centroid prediction plus greedy association. It costs microseconds.
1. **Weak-tier floor:** drop detections below `candidate_conf` (`track_candidate_conf`, **0.42** in
   docker/jetson, 0.5 by default).
2. **Predict** each track: `box + vel*dt`, with `dt` capped at 1.5 s (`_Track.predicted`).
3. **Associate:** greedy, highest IoU first, on predicted boxes, gated by `iou_thr 0.3` **and** the area-ratio
   gate (0.25x–4x). Leftover tracks then try a **centroid fallback**: nearest detection within
   `0.8 x predicted diagonal`, same area gate.
4. **Absorb** (`_absorb`): `vel = 0.6*vel + 0.4*inst_v`, box EMA `0.5/0.5`, hits+1, misses=0.
   It confirms if conf ≥ `strong_conf` (0.65), or if `hits ≥ confirm_hits (2)` **and** at least
   `min_confirm_sep_sec` (0.3 s) has passed since first seen.
5. Unmatched tracks get `misses+1`. Unmatched detections start a TENTATIVE track, or a CONFIRMED one immediately if ≥ 0.65.
6. **Expire** when `now-last_seen > miss_timeout_sec (6 s)`, or when `misses ≥ max_miss (2)` **and** at least 0.8 s
   (`coast_min_sec`) of wall-clock coasting has passed.
7. **Count** = confirmed, non-static tracks that a zone accepts (`confirmed_count` → `_countable`).

### 2.9 Static (furniture) suppression — inside the tracker
With `tracking: true` (the default), `static_suppress.py:StaticBoxSuppressor` is **not used**
(`stream_worker.py:__init__` creates it only when `tracking` is false). Furniture logic lives in the track:
- A track becomes `static` (excluded from the count and from the preview) only if it has **no human evidence**,
  is not **arrival-protected** (born during motion and younger than `arrival_protection_sec` 300 s),
  has ≥ `static_suppress_min_hits` (8) hits, **and** has had no activity for ≥ `static_suppress_sec` (120 s).
- **Human evidence** is permanent. A track earns it by moving at least `move_release_ratio` (0.35) birth-box diagonals of raw
  displacement, or by collecting ≥ 3 strong (≥ 0.65) hits.
- **Activity clock:** `note_region_activity` grey-diffs each track's box on the 160x90
  thumbnails (pixel delta 14, at least 5% of the box). If that fires, it resets `last_activity` and clears `static`.
  So someone sitting still and scrolling a phone stays counted, while a chair headrest
  (seen at conf 0.57, OPTIMIZATION_REPORT §8.1) drops out after about 2 min.
- Legacy path (`tracking: false`): `StaticBoxSuppressor.update` marks a box static after IoU ≥ 0.6 against the same spot for
  ≥ 8 hits over ≥ 120 s, then `rehabilitate()` it on region motion. The count in this path is a rolling median
  (`counter.py:RollingCounter`, `smooth_window` 5).

### 2.10 Zones and counting — `zones.py:ZoneCounter.evaluate`
- Polygons are normalised to 0..1, drawn in the VMS and stored in `settings.headcount.zones`. With no
  enabled zone, everything counts (opt-in).
- The anchor is the **bottom-centre of the head box**. The test is ray-casting point-in-polygon.
- Exit hysteresis: once a track is counted, it stays counted until it is outside by more than `max(0.35 x head height, 0.005)`
  for at least `exit_hold_sec` 1.0 s.
- `zone_counts` is seeded at 0 for every enabled zone, so "empty" can be told apart from "not counted".

### 2.11 Publish — `StreamStats.snapshot` → `forwarder.py:_build_payload`
Every `forward.interval_sec` (5 s) the forwarder POSTs `{source:"head-count", streams:[...]}` to
`<BACKEND_URL>/api/internal/ai/occupancy` with header `X-Service-Token`. Each stream carries:
`monitorId, heads, connected, reliable (= count_reliable && connected), ageSec (count_age_s), degraded (gate_saturated), tracked, status`.
`count_reliable` is set false on reconnect or read timeout, and after 3 consecutive inference failures. It also expires when
the last verified inference is older than `verify_deadline_s = 3*idle_infer_interval + 2`, which is **32 s** with the docker yaml.

### 2.12 Backend ingest — `integration/backend/src/routes/internal.routes.js` `POST /ai/occupancy`
1. Look up the `Camera` by `monitorId`. Call `services/occupancy/quality.js:cameraQuality`, which returns `unknown` if
   disconnected or `reliable=false`, `stale` if `ageSec > 35` (`OCCUPANCY_STALE_AFTER_SEC`), and
   otherwise `measured`. Only `measured` is usable.
2. Redis gauge `occupancy:live:<monitorId>` = `{heads | null, quality, connected, degraded, ts}`
   with TTL 30 s (`OCCUPANCY_GAUGE_TTL_SEC`). **A blind camera writes `null`, never 0.**
3. Minute accumulator hash `occ:acc:<cameraId>:<minute>` (samples, samples_measured, sum, peak,
   min, degraded; TTL 240 s). `occupancyAggregator.service.js` flushes it every 60 s into
   `occupancy_camera_minute`, rolls up into 15m/1h/1d every 5 min, and sweeps retention every 6 h.
4. **Camera-level alert** (`services/occupancyHysteresis.js`): threshold =
   `settings.headcount.threshold` or `OCCUPANCY_ALERT_THRESHOLD` (default 0 = off). M1 requires
   `confirmPolls` **3** consecutive samples ≥ N (about 15 s at a 5 s cadence). M2 holds the breach until
   count ≤ N − `clearMargin` **5**. A breach creates `AIEvent occupancy.threshold` (severity `warning`,
   `personId: cam:<monitorId>`) → `alertEngine.maybeAlert`. The `'clear'` edge is returned but
   **no clear event is emitted** at camera level.

### 2.13 Room fusion + room alerts — `occupancyEvaluator.service.js`
This is a leader-elected tick every 10 s (`OCCUPANCY_EVAL_MS`). It reads the gauges and calls
`services/occupancy/fuse.js:fuseSpace`:
`space_count = Σ_groups max(count x weight)`, where cameras in the same `overlapGroup` take the MAX and solo cameras SUM.
The quality is `measured`, `partial` (a lower bound: may breach, may not clear), `stale` or `unknown` (count NULL).
State machine defaults: `confirmSec 60`, `clearSec 60`, `clearMargin 2`, `warnPct 0.85`,
`cooldownSec 900` (warning tier). It opens and clears `occupancy_incidents` rows (durable across restarts)
and emits `occupancy.threshold` (critical), `occupancy.warning` or `occupancy.cleared` (info). The dedup subject
is `space:<id>`, so one room produces one alert.

### 2.14 Alert delivery — `services/alertEngine.js`
Only `warning`/`critical` alerts. Per-subject cooldown is push 90 s (`ALERT_PUSH_COOLDOWN_SEC`) and email
600 s. A per-user email burst cap allows 8 per 600 s. Occupancy is categorised as "crowd".

---

## 3. Pre/post-processing and model values, by file

| Value | `config.py` default | `config/config.yaml` | `config/config.docker.yaml` | `config/config.jetson.yaml` |
|---|---|---|---|---|
| `detectors[0].weights` | (required) | `models/abel/best.pt` | same | same |
| `detectors[0].device` | `auto` | `auto` | `auto` | `auto` (→ cuda) |
| `detectors[0].half` | `false` | `false` | `false` | **`true`** |
| `detectors[0].conf` | 0.35 | 0.35 | **0.4** | **0.4** |
| `detectors[0].imgsz` | 640 | 640 | 640 | 640 |
| NMS IoU | — (Ultralytics 0.7 per-frame; 0.45 batched, hard-coded) | — | — | — |
| `pipeline.infer_every` | 1 | 1 | **3** | **3** |
| `pipeline.idle_infer_interval` | 1.5 s | (default) | **10 s** | **10 s** |
| `pipeline.track_candidate_conf` | 0.5 | (default) | **0.42** | **0.42** |
| `pipeline.torch_threads` | 0 | (default) | **4** | **4** |
| `pipeline.gst_nvdec` | false | false | false | **true** |
| `api.preview_banner` | true | true | **false** | true |
| `source.enabled` / `forward.enabled` | false / false | false / false | **true / true** | **true / true** |
| per-camera `imgsz` | — | — | from VMS `settings.headcount.imgsz` ∈ {416,512,640,800,960,1280} | same |

Stale comments to be aware of: `config.docker.yaml` says *"0.5, NOT the model's 0.35 default"* and
`config.jetson.yaml` says *"Keep 0.5"*, but both set `conf: 0.4`. The v2.2 change (conf 0.4 plus
candidate 0.42) superseded those comments. The tracker and static logic now handle furniture.

---

## 4. Temporal logic and anti-flood rules

**Service side (decide per track):**

| Mechanism | Rule | Where |
|---|---|---|
| Gate hysteresis | enter ≥ thr_enter, exit < 0.4·thr_enter; noise learned only while static | `stream_worker._process_loop` |
| Adaptive cadence | motion → infer now; after a change, 2 re-verifies at 0.5 s; idle heartbeat 10 s | same |
| Two-tier confirm | weak (≥0.42) needs 2 hits spanning ≥0.3 s; strong (≥0.65) confirms at once | `head_tracker._absorb` |
| Coasting | expire only after ≥2 misses **and** ≥0.8 s, hard cap 6 s → brief occlusion holds the count | `head_tracker.update` |
| Furniture | never-moved, no strong evidence, no region activity for 120 s with ≥8 hits → excluded | `head_tracker.update` / `note_region_activity` |
| Zone edge | enter on contain; leave after margin plus 1 s sustained | `zones.ZoneCounter.evaluate` |
| Honesty | `count_reliable`, `count_age_s`, `gate_saturated` published alongside the number | `stream_worker.StreamStats` |

Measured effect (OPTIMIZATION_REPORT §9.3): a person leaving makes the count drop in about **1–1.5 s**.
A strong head entering confirms on the first inference; a weak one takes about 1 s through the rapid re-verify.

**Backend side (decide per area / alert per transition)**, following the doctrine in
`../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md` §6 row (g):
camera level is K=3 polls plus the N / N−5 deadband (`occupancyHysteresis.js`). Room level is 60 s confirm,
60 s clear, margin 2, a warning tier at 85% with a 900 s cooldown, partial counts that may breach but not clear,
and unknown that never clears (`occupancyEvaluator.service.js`). The invariant `count IS NULL ⟺ quality='unknown'` holds everywhere
(`../docs/OCCUPANCY_LOGIC.md` §2.2). Delivery dedup happens in `alertEngine.js`.

---

## 5. Outputs and consumers

| Output | Shape | Consumer |
|---|---|---|
| `GET /streams` | per-camera snapshot: `counts{heads}`, `raw_counts`, `total`, `tracked`, `tentative`, `zone_counts`, `fps`, `read_fps`, `infer_ms/p50/p95`, `count_reliable`, `count_age_s`, `gate_saturated`, `frames_processed`, `frames_skipped_static`, `static_suppressed`, `status`, `last_error` | `smart-cam-app/src/modules/headcount/HeadCount.jsx`, own dashboard |
| `GET /count`, `/count/{id}`, `/health` | totals / one snapshot / `{status, device, uptime, streams_online}` | dashboard, ops |
| `GET /video/{id}` (MJPEG at `preview_fps` 15, JPEG q70), `/snapshot/{id}` | annotated frames, suppressed boxes hidden | VMS video wall `<img>` |
| POST `/api/internal/ai/occupancy` | §2.11 payload every 5 s | backend gauge, minute log, camera alert |
| Redis `occupancy:live:<monitorId>` | gauge, TTL 30 s | `ai.controller.js` people-count overlay, `occupancyEvaluator` |
| MySQL `occupancy_camera_minute`, `occupancy_space_minute`, `occupancy_space_rollup`, `occupancy_incidents` | history and incidents | `GET /api/occupancy/history`, `/summary` (`occupancy.routes.js`), reports |
| `AIEvent` `occupancy.threshold/warning/cleared` | alerts | event log, push/email via `alertEngine` |

Inputs from the VMS: `PUT /api/ai/cameras/:id/headcount` (`ai.controller.js:setCameraHeadcount`,
licence-gated by `assertAiLicence(..., 'headcount')`) stores `{enabled, threshold, zones, imgsz}`
in `camera.settings.headcount`.

---

## 6. Configuration knobs

Any key can be overridden with `HEADCOUNT_<SECTION>__<KEY>`, e.g. `HEADCOUNT_API__PORT=9000`
(`config.py:_apply_env_overrides`). **Gotcha:** list indices do not work. The loop
`break`s when it meets a list, so `HEADCOUNT_DETECTORS__0__DEVICE=cuda` (the example in `.env.example`)
is **silently ignored**. Edit the bind-mounted YAML instead.

| Key | Default | Effect |
|---|---|---|
| `detectors[].conf` | 0.35 | detector score floor (everything below never reaches the tracker) |
| `detectors[].imgsz` | 640 | model input long side; overridden per camera |
| `detectors[].half` / `device` | false / auto | FP16; device choice |
| `detectors[].classes` | None | restrict counted classes |
| `pipeline.infer_every` | 1 | consider every Nth new frame |
| `pipeline.target_fps` | 0 | post-inference sleep (0 = off) |
| `pipeline.reconnect_delay` / `max_reconnect_delay` / `read_timeout` | 3 / 30 / 10 s | reconnect backoff, dead-stream watchdog |
| `pipeline.motion_gate` | true | skip inference on static scenes |
| `pipeline.motion_adaptive` | true | per-camera learned noise floor |
| `pipeline.motion_threshold` | 0.008 | fixed gate (only when not adaptive) |
| `pipeline.motion_floor` / `motion_noise_mult` / `motion_exit_ratio` / `motion_ceiling` | 0.004 / 3.0 / 0.4 / 0.03 | adaptive gate shape |
| `pipeline.idle_infer_interval` | 1.5 s | heartbeat inference when static; also sets reliability deadline |
| `pipeline.verify_rapid_interval` / `verify_confirmations` | 0.5 s / 2 | fast re-verify after a change |
| `pipeline.preview_refresh_sec` | 0.5 s | live tile refresh while gated |
| `pipeline.tracking` | true | count = confirmed tracks (false = median of per-frame counts) |
| `pipeline.track_candidate_conf` / `track_strong_conf` | 0.5 / 0.65 | weak / instant-confirm tiers |
| `pipeline.track_confirm_hits` / `track_min_confirm_sep_sec` | 2 / 0.3 s | weak confirmation |
| `pipeline.track_max_miss` / `track_miss_timeout_sec` | 2 / 6 s | expiry |
| `pipeline.track_move_release_ratio` | 0.35 | displacement that marks a track human |
| `pipeline.static_suppress` / `static_suppress_sec` / `static_suppress_min_hits` | true / 120 s / 8 | furniture rule (`static_suppress_iou` 0.6 only in legacy path) |
| `pipeline.smooth_window` | 5 | median window (legacy path only) |
| `pipeline.torch_threads` | 0 | intra-op thread cap |
| `pipeline.gst_nvdec` / `gst_pipeline_template` | false / H.264 NVDEC | Jetson hardware decode |
| `api.port` / `preview` / `preview_fps` / `jpeg_quality` / `preview_banner` | 8000 / true / 15 / 70 / true | REST + MJPEG |
| `source.enabled` / `poll_interval_sec` / `prefer_sub` | false / 15 s / true | dynamic camera list |
| `source.max_streams` / `max_streams_per_host` | **8** / 4 | resource cap / NVR cap (relay hosts exempt from per-host) |
| `forward.enabled` / `interval_sec` / `monitor_by_stream` | false / 5 s / {} | backend push |
| env `BACKEND_URL`, `SERVICE_TOKEN` | — | fallback for source/forward URL + token |
| env `HEADCOUNT_RELAY_HOSTS`, `HEADCOUNT_SKIP_OFFLINE` | see §2.1 / true | cap exemption, dead-camera skip |
| Hard-coded | tracker `iou_thr 0.3`, `centroid_frac 0.8`, `area_ratio_gate 4`, `coast_min_sec 0.8`, `arrival_protection_sec 300`, `strong_evidence_hits 3`; zones `exit_margin_frac 0.35`, `exit_hold_sec 1.0`; batch `max_batch 16`, `max_wait_ms 8`, `iou 0.45`, `topk 300`; gate 160x90, delta 12 | edit code to change |

Backend env: `OCCUPANCY_GAUGE_TTL_SEC` 30, `OCCUPANCY_ALERT_THRESHOLD` 0, `OCCUPANCY_CONFIRM_POLLS` 3,
`OCCUPANCY_CLEAR_MARGIN` 5, `OCCUPANCY_STALE_AFTER_SEC` 35, `OCCUPANCY_EVAL_MS` 10000,
`OCCUPANCY_FLUSH_MS` 60000, `OCCUPANCY_ROLLUP_MS` 300000.

Note: with relay URLs the per-host cap does not apply, so **`max_streams: 8` is the effective limit
per service instance**. `config.docker.yaml` does not raise it. To count more than 8 cameras you must
set `source.max_streams`.

---

## 7. Performance numbers already measured

**Throughput / CPU** (`../docs/HEADCOUNT_OPTIMIZATION_REPORT.md`):
- §1, 8 live production cameras, CPU torch: inferences went from ~32 inf/s (every 3rd frame) to **~0.04–1 inf/s**,
  and CPU from ~1,300% to **~65%** (≈0.08 cores/camera, §8.3). There were 0 phantom heads on empty rooms.
- §3.1 gate A/B: 790% → 240% CPU, 1,491 → 34 inferences, **99.0% skip**.
- §3.2 heartbeat 1.5 → 10 s: ~145% → ~70% CPU, skip 85.5% → 97.4%, counts unchanged.
- §4 CPU torch latency on a 640x360 frame: imgsz 640 = **17.0 ms**; rect (384,640) = 16.9 ms (no gain);
  480 = 11.7 ms; (224,384) = 9.6 ms. 480 and smaller were *not adopted* (no accuracy-parity data).
- §9.3 synthetic: p50 23.8 ms, p95 35.6 ms, 99.1% skip. §9.6 production daytime (9 cameras, CPU):
  p50 49–82 ms, p95 56–95 ms, skip 77.7%.
- Production CPU inference: ~55 ms (`Dockerfile.gpu` header, §5).

**GPU / batching** (`batch_engine.py` docstring, measured 2026-08-10, RTX-class GPU):
`model.predict` = **5.05 ms/frame**, of which only **0.41 ms** is GPU compute (92.5% idle). The batch
engine at batch 32 gives **0.94 ms/frame (5.4x)**, single-threaded, with identical boxes (median corner error
0.50 px). The engine at batch 1 is 6.5 ms, hence the solo route. Compose comment: GPU ~5 ms vs ~17 ms CPU.

**GIL ceiling** (engineering notes 2026-08-10, not in the repo docs): one stream costs 5.4 ms per frame, made up of GPU
forward 2.78 ms, CPU preprocess 0.42 ms and **Python + NMS + launch 2.2 ms (41%)**. GPU utilisation is 7.5%.
In-service with 12 camera threads, batching gives only **1.1x**. With the stock path, 1 → 12 threads goes from 176 to 159 fps
aggregate. **4 separate processes = 240 fps (1.39x).** The ceiling is about **175 inferences/s per process**
(≈34 cameras at 5 fps). The shipped engine gives **+13% at 12 cameras** and no regression at 1.
Production L4 after the GPU move: p50 55–82 ms → **15–24 ms**.

**Detail level** (`../docs/HEADCOUNT_DEPLOYMENT_SPEC.md` §6): GPU model call alone 640 = 5.6 ms,
1280 = 5.8 ms. End-to-end per frame, 640 ≈ 8.2 ms and 1280 ≈ 17.4 ms (about 2x). CPU is ~2.5x.
`ai.controller.js` comment: 640 → 1280 found **71% more people** in identical footage (all distant).

**Deployment limits** (DEPLOYMENT_SPEC; the reference is the model itself at imgsz 1536 / conf ≥ 0.60
on one 1280x720 daylight clip, so these figures measure **degradation, not absolute accuracy**):

| Factor | Measured | Spec |
|---|---|---|
| Head px at model input (§1) | <8 px 20.5% · 8–10 81.6% · 10–12 95.0% · **12–14 97.8%** · 16–20 99.2% · 20–32 100% | ≥12 px = **50 px/m** at head plane; 16 px = 67 px/m |
| Megapixels (§1) | cancel out after letterbox: `px = (V/W)·imgsz·h_head/(2·d·tan(vfov/2))` | 4K needs 300 px/m native at imgsz 640 |
| Range (§2), 12 px tier | 2.8 mm: 6.3 / 9.4 / 12.6 m · 4 mm: 9.0 / 13.5 / 18.0 m at imgsz 640 / 960 / 1280 | pick lens + imgsz per room |
| Mount/tilt (§3) | crowding not binding: 99.2% at 1.0–1.5 head diameters | 3–4 m high, 10–20° down |
| Light (§4) | 0 stops 99.5% · ~9 lux 97.4% · ~5 lux 94.2% · ~2.3 lux 84.8% · ~1.2 lux 34.2% · ~0.6 lux 0% | **≥10 lux** at head height; IR **unmeasured** |
| Motion blur (§4) | 0 px 99.5% · 5 px 97.5% · 7 px 92.0% · **9 px 68.5%** · 13 px 14.7% | shutter **≤1/30 s** (≤1/100 s if also doing face) |

**Accuracy:** the figure used is "head count **98%**" live in the platform (engineering notes
2026-08-10, repeated in `DRISHYAM_SALES_BOOKLET.md`). **No labelled dataset exists.** The report says
MAE/exact-count on human labels is the open acceptance gate (OPTIMIZATION_REPORT §9.4, §9.6). Treat 98% as a
spot-check, not a benchmark.

**Jetson:** `Dockerfile.jetson` was never validated on a device (OPTIMIZATION_REPORT §7, §9.4). The field
report (Anil) is that the edge box **lags on a single camera**. It runs PyTorch eager with no TensorRT export,
so quote 1 camera per box until that work is done.

---

## 8. Known weaknesses and concrete improvement ideas

**Runtime / embedded**
1. **TensorRT on Jetson (biggest lever).** Export on the device itself:
   `yolo export model=models/abel/best.pt format=engine half=True imgsz=640 device=0`
   (or ONNX → `trtexec --fp16`). Ultralytics `YOLO("best.engine")` loads it, so `model.py:Detector`
   needs no change for the per-frame path. Two catches. First, `BatchInferenceEngine` calls
   `model.model.to(device)` and assumes a torch `nn.Module`, so gate batching on a `.pt` suffix or build a TRT batch profile.
   Second, engines have a fixed shape unless exported `dynamic=True`, which conflicts with per-camera
   `imgsz`. Restrict Jetson to one or two engine sizes (e.g. 640 and 960 for 16:9 → 384x640 / 544x960).
2. **INT8** (TensorRT on Jetson, OpenVINO/ONNX Runtime on x86 CPU): calibrate on ~500 frames
   of our own footage. This is accuracy-gated: needs the labelled set first (report §8.2).
3. **FP16 on the x86 GPU:** `config.docker.yaml` has `half: false`, so the GPU runs FP32. It is a one-line change;
   verify box parity like the batch-engine test did.
4. **Decode is now the floor.** Every frame is software-decoded by OpenCV FFmpeg even when 97% are
   gated away (report §7.3: ~40–70% CPU for 8 cameras). Options: NVDEC on x86 (GStreamer
   `nvh264dec`, or PyAV with hwaccel, as the face pipeline did); ask the stream service for a
   low-fps sub-stream; or decode keyframes only while the gate is idle.
5. **Less per-frame Python** (41% of the frame). Ideas: run the batch engine's own preprocess and NMS for the solo path too
   (but it currently loses at batch 1, so profile `_decode` first); vectorise tracker association
   (an O(T·D) Python loop of `iou()` calls → one numpy IoU matrix); drop the double `zc.evaluate` per track
   (`confirmed_count` + `counts_by_zone`).
6. **Escape the GIL.** Shard cameras across processes (measured 1.39x at 4 processes), or follow the face
   pipeline's Phase 2 pattern: one inference process plus N camera-shard processes over shared memory.
   This is also what lets cross-camera batching pay off (in-thread batching gave only 1.1x).
7. **Viewer-gated preview:** `_encode_preview` JPEG-encodes on every inference and every 0.5 s for
   every camera, whether anyone is watching or not. Gate it on active `/video` clients, as the AI overlay already does with
   `/api/internal/ai/viewers`.
8. **Global inference scheduler** for 50+ cameras (deferred in §9.4). Today each camera schedules itself.

**Correctness / ops**
9. NMS IoU differs between paths (0.7 per-frame vs 0.45 batched). Pass `iou` explicitly to
   `predict` and expose it in `DetectorConfig` (along with `batch`, `batch_max`, `batch_wait_ms`, which are
   read through `getattr` but can never be set from YAML).
10. The `top-k 300` pre-NMS cut in `_decode` could truncate in very dense scenes at imgsz 1280.
11. `ZoneCounter._state` is never pruned (`forget()` is never called), so it grows slowly per track id.
12. Env override for list items silently does nothing (§6).
13. `max_streams` 8 is a hidden ceiling (§6).
14. `:8020` and the nginx `/headcount/*` proxy are unauthenticated, and CORS is `*`.
15. Camera-level hysteresis computes a `clear` edge but drops it. Room-level (spaces) is the
    path that pairs breach and clear.
16. Licensing: Ultralytics is AGPL-3.0, and the weights come from a third-party HF repo with an unknown licence
    and dataset. Both need a decision before claiming "own model" commercially.

**Model / data**
17. **Build the labelled set first.** Cover stationary seated people, head-down poses, crossings, IR night,
    exposure flips, hats/helmets/hijabs, top-down views and children. Score MAE and exact-count%. Every frozen
    knob (imgsz 480, weak tier) is waiting on this.
18. **Retrain for our views.** The checkpoint was trained only 30 epochs with **mosaic off**, at 640, on an
    unknown dataset. Fine-tune on CrowdHuman-head / SCUT-HEAD plus our own top-down and oblique footage, with
    mosaic and small-object augmentation. Add a second "furniture/head-shaped" hard-negative pass
    (chair headrests scored 0.57).
19. **Distillation.** Pseudo-label our footage with a teacher (YOLOv8s/m or YOLO11s at imgsz 1280–1536, the
    same reference the bench scripts use), then train the n-sized student at 640, or 480 to hit the measured −31%
    latency. The aim is to recover the small-head recall below 12 px, where recall drops off a cliff.
20. **Tiling (SAHI-style) for deep rooms** instead of a global imgsz 1280. Tile only the far band of the
    frame, where heads are under 12 px.

---

## 9. How to run standalone and test

Everything below runs from `code/head-count/`.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,preview]"          # Jetson/Pi: install the vendor torch wheel FIRST
pytest -q                                # 104 test functions; torch/cv2 tests importorskip
```

Test files: `test_head_tracker.py` (16: confirm, coast, furniture, rehab, area gate),
`test_zones.py` (20), `test_source_caps.py` (20: relay exemption, offline skip, imgsz allow-list),
`test_batch_engine.py` (18: letterbox, grouping, deadlock, routing; stubbed forward, no GPU needed),
`test_preview_contract.py` (7), `test_motion_gate.py` (6), `test_static_suppress.py` (6),
`test_config.py` (6), `test_counter.py` (5).

**Run the service on a webcam/file/RTSP** (static streams, no backend):
```bash
# edit config/config.yaml -> streams[0].source: 0 | /path/clip.mp4 | rtsp://<cam>/...
headcount --config config/config.yaml    # or: python -m headcount --config ... | make run
# dashboard http://localhost:8000/   counts: curl localhost:8000/streams
```
To pull cameras from a VMS instead, set `source.enabled: true` and `forward.enabled: true` and export
`BACKEND_URL` and `SERVICE_TOKEN` (the token must match the backend's).

**GUI preview** (no API, raw model + median smoothing): `python scripts/preview.py --source 0
--weights models/abel/best.pt --conf 0.35 --imgsz 640` (`make preview`).

**Docker builds**
```bash
docker build -t head-count:cpu -f Dockerfile .          # CPU torch, config.docker.yaml
docker build -t head-count:gpu -f Dockerfile.gpu .      # CUDA torch; run with --gpus all
docker build -t head-count:jetson -f Dockerfile.jetson --build-arg BASE=dustynv/l4t-pytorch:r36.4.0 .
docker run --rm -p 8020:8000 -v $PWD/config:/srv/head-count/config \
  -v $PWD/models:/srv/head-count/models -e BACKEND_URL=... -e SERVICE_TOKEN=... head-count:gpu
```
The Jetson build checks `cv2` GStreamer and prints `torch.cuda`. At runtime, look for the log line
`NVDEC (GStreamer) decode active`. Match `BASE` to `/etc/nv_tegra_release`. In the full stack:
`docker compose -p drisyam-original -f docker-compose.drisyam-original.yml up -d head-count`
(it mounts the config, so a YAML edit plus `docker restart` applies without a rebuild).

**Bench scripts** (`bench/`). They expect the model at `/srv/head-count/models/abel/best.pt` and a clip at
`/demo/crowd.mp4`, so run them inside the GPU image (DEPLOYMENT_SPEC appendix):
```bash
docker run --rm --gpus all -v <models>:/srv/head-count/models:ro -v <clip>:/demo/crowd.mp4:ro \
  -v $PWD/bench:/out head-count:gpu python /out/px_sweep.py
```
`bench.py` = latency vs imgsz (640–1280); `px_sweep.py` = recall vs head px; `env_sweep.py` = recall vs
light and blur; `crowd_sweep.py` = recall vs spacing/density; `geometry.py` = lens/mount/range tables
(pure math, runs anywhere).

**Profiling a live instance:** `GET /streams` → compare `read_fps` (decode/camera health) with
`infer_ms`/`infer_p95` (model health); `frames_skipped_static / frames_processed` is the gate skip ratio;
`count_age_s` is staleness. On GPU, the batch engine's `stats()` (batches, avg_batch, fill_ema) is
internal and not exposed on the API, so add it to `/health` if you tune batching.
