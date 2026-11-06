> **Study guide** (written 2026-10-20 for the AI study bundle). Paths in it are relative to that bundle: `code/zone-sim/…` = this folder; `zone_sim.py` is in this folder; weights = `models/person/yolov8n.pt`; the cctv-test-harness referenced below was not carried over; `../docs/…` = `docs/…`; `../integration/backend` = `backend/`; `../integration/compose` = the root `docker-compose.yml`. Model catalogue: `models/README.md`.

# 03 — Restricted zone / person detection ("zone-guard")

A study guide for the pipeline that raises "N person(s) in restricted zone" alerts. It covers what
the code does today, with file:function references and real defaults, and lists the measured failure
modes you can work on.

Bundle paths used below:

| Bundle path | Original | What it is |
|---|---|---|
| `code/zone-sim/zone_sim.py` | `smart-cam-ai/app/zone-sim/zone_sim.py` | The detector process (the "zone-guard") |
| `code/cctv-test-harness/` | `C:\projects\intrusion-detection\...\smart-cam-ai\app\cctv-test\` | Test/benchmark harness on real NVR footage. Clip/snapshot corpus NOT shipped; credentials and IPs redacted |
| `../integration/backend/src/services/zoneIntrusion.service.js` | `smart-cam-backend/src/services/` | The zone decision engine (Node) |
| `../integration/backend/src/services/occupancyHysteresis.js` | same | Capacity-mode anti-flap |
| `../integration/backend/src/services/alertEngine.js` | same | Push/email gating |
| `../integration/backend/src/routes/internal.routes.js` | `smart-cam-backend/src/routes/` | `/api/internal/ai/overlay`, `/api/internal/cameras` |
| `../docs/` | `docs/` | `RESTRICTED_ZONE_DETECTION.md`, `DETECTION_DECISION_ALERT_FRAMEWORK.md`, `DETECTION_LOGGING_ALERTING_POLICY.md` |

---

## 1. What it does + process topology

It detects **bodies, not faces**. The zone engine originally only received face boxes from the face
pipeline, so a person with their back to the camera, looking down at a desk, or too far away produced
no box and the zone stayed silent. `zone_sim.py` runs COCO person detection on every selected camera
and posts body boxes to the same ephemeral overlay channel. The backend engine decides whether those
boxes are an intrusion. Nothing in the detector writes an alert.

```
 NVR/camera ──RTSP──> stream-service (MediaMTX) ──rtsp://stream-service:8554/cam_<monitorId>──┐
                                                                                             │
 ┌───────────── zone-sim container (image drishyam/head-count, gpus: all) ─────────────────┐ │
 │ main(): poll GET /api/internal/cameras every 60 s → 1 thread per monitorId              │<┘
 │ camera_worker(): cv2 decode EVERY frame → YOLOv8n.track @ 4 fps → boxes                  │
 │                 └─ POST /api/internal/ai/overlay  (only when ≥1 box)                     │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
                                   │ HTTP JSON, X-Service-Token
 ┌───────────── smart-cam-backend (Node) ───────────────────────────────────────────────────┐
 │ internal.routes POST /ai/overlay → emit(EVENTS.AI_LIVE_OVERLAY)  (never persisted, 202)  │
 │   ├─ ws.service: socket 'ai.live' to browsers that are watching (on-video boxes)         │
 │   └─ zoneIntrusion.handleFrame(): zone polygons × foot-point → occupancy FSM per zone    │
 │         └─ fireAlert(): AIEvent 'zone.intrusion' (MySQL) → emit AI_EVENT_DETECTED        │
 │               (toast + bell) → alertEngine.maybeAlert() → Expo push / SMTP email         │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

Compose (`docker-compose.drisyam-original.yml`, service `zone-sim`, container
`drisyam-original-zone-sim`): entrypoint `python -u /srv/zone-sim/zone_sim.py`, image reused from
head-count because it already has ultralytics + OpenCV; weights mounted at `/models/yolov8n.pt`. The POC
compose runs the same script the same way. Which cameras get covered is set only by `ZONE_SIM_MONITORS`
(compose default = the local demo camera; set a comma list of monitorIds or `all`).

---

## 2. Frame-by-frame call path

| # | Stage | Where | What happens (real values) |
|---|---|---|---|
| 1 | Camera discovery | `zone_sim.py:main` → `fetch_cameras` | `GET {BACKEND_URL}/api/internal/cameras` every `ZONE_SIM_REGISTRY_REFRESH`=60 s. Backend `internal.routes.js` returns `{monitorId,userId,name,rtsp,rtspSub}`; `rtsp` = `drishyamStreaming.getRtspEgressUrl(monitorId,false)` (main stream). `ZONE_SIM_SOURCES` can override the URL per monitorId. Threads are only added, never removed. |
| 2 | Source open | `open_capture` | `cv2.VideoCapture(url, cv2.CAP_FFMPEG)`, `CAP_PROP_BUFFERSIZE=1`. Compose sets `OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp` (H.265 over UDP corrupts). Reconnect backoff 1 s doubling to 30 s. |
| 3 | Decode | `camera_worker` loop, `cap.read()` | FFmpeg **software** decode inside OpenCV, every frame, on the worker thread. Output BGR uint8 H×W×3 at native resolution (1920×1080 in the tests). No NVDEC. |
| 4 | Sampling | `camera_worker` | Paces the **model, not the decoder**: infer only when `monotonic() - last_post >= 1/ZONE_SIM_FPS` (= 0.25 s). The check runs once per decoded frame, so at 25 fps the real rate is 3.6 fps (C01). |
| 5 | Pre-processing | Ultralytics `predict`/`track` internals | `LetterBox(imgsz=640)` with `auto=True` for a PyTorch model → minimum rectangular padding to stride 32: 1920×1080 → **640×384**, pad value 114. BGR→RGB, HWC→CHW, `/255.0`, float32. No mean/std. |
| 6 | Model | `YOLO(MODEL_PATH)`, one instance **per camera thread** | **YOLOv8n** COCO (80 classes, `classes=[0]` = person). Checkpoint metadata (read from `yolov8n.pt`): 3,157,200 params, stored FP16, Ultralytics 8.0.0.dev0, 2022-12-30, trained `imgsz 640`, 500 epochs. Architecture: CSPDarknet backbone with C2f blocks, PAN-FPN neck, anchor-free decoupled head at strides 8/16/32. At 640×384 the head emits 5,040 candidates × (4 box + 80 class). Runtime: PyTorch eager, **FP32** (`half` not passed), device = `ZONE_SIM_DEVICE` or Ultralytics auto (cuda:0 when visible). |
| 7 | Post-processing | Ultralytics NMS | `conf=ZONE_SIM_CONF`=0.35, IoU = Ultralytics default 0.7 (not set in code), `classes=[0]`, `max_det` 300; boxes rescaled to the original frame. |
| 8 | Tracking | `model.track(persist=True)` when `ZONE_SIM_TRACK`=true (default) | Ultralytics default tracker = **BoT-SORT** (`botsort.yaml`; exact thresholds depend on the installed Ultralytics version). The tracker's output **replaces** the detections, so boxes that are not yet confirmed tracks are dropped. If `lap` is missing the worker falls back to `predict()` for its whole life. The engine ignores `trackId`; only the browser overlay uses it. |
| 9 | Failure guard | `camera_worker` | 10 consecutive inference exceptions (`ZONE_SIM_INFER_FAIL_LIMIT`) → rebuild the model on CPU ("a watched zone beats an unwatched one"). |
| 10 | Serialise | `camera_worker` | Per box `{"bbox":[x1,y1,x2,y2] (0.1 px), "conf": 3 dp, "trackId": int?}`. **No `name`** on purpose (an unnamed body is what the engine treats as an intruder). **No `snap`** (no crop). |
| 11 | Output | `post_overlay` | Only if `boxes` is non-empty: `POST /api/internal/ai/overlay` `{userId, monitorId, ts(ms), frameW, frameH, boxes}`, header `X-Service-Token`, timeout 6 s, **synchronous** in the worker loop. Cadence ≈ 4 Hz per camera while anyone is in view; ~11 POST/s for the office cameras (`FACE_SYSTEM_DESIGN.md`). |
| 12 | Ingest | `internal.routes.js` `POST /ai/overlay` | 400 without userId/monitorId; otherwise `emit(EVENTS.AI_LIVE_OVERLAY, {userId, frame})` → 202. 2 MB JSON limit, no user rate limiter. |
| 13 | Zone lookup | `zoneIntrusion.service.js:zonesFor` | Per-user cache, `ZONE_RELOAD_MS`=60 s. Zones are dropped if the account's `restricted_zone` entitlement is off (`entitlements.service`). Only `enabled: true` rows. |
| 14 | Arming | `isArmed` | `enabled` && (`schedule==='always'` or no `armWindow` → armed) else HH:MM compare in `ALERT_TIMEZONE` (default Asia/Kolkata), overnight wrap supported. |
| 15 | Geometry | `handleFrame` + `inZone` / `pointInPolygon` | Foot-point: `xPct = ((x1+x2)/2)/frameW*100`, `yPct = y2/frameH*100`. Zone coords are percent 0..100 (`RestrictedZone.points`/`rect`). Polygon = even-odd ray casting; rectangle = inclusive on all edges. |
| 16 | Count | `handleFrame` | `total` = everyone in zone; `count` = in zone and `box.name` not in `zone.allowed` (case-insensitive). |
| 17 | Capacity mode | `handleFrame` → `occupancyHysteresis.update` | If `maxOccupancy > 0`: breach after `OCCUPANCY_CONFIRM_POLLS`=3 consecutive frames with `total >= cap`; clears at `cap - OCCUPANCY_CLEAR_MARGIN`(5). Event `occupancy.threshold`. These zones skip the intrusion path. |
| 18 | Intrusion FSM | `handleFrame`, `zoneOcc` map (in memory) | **ENTER** when `count>0` continuously for `max(CONFIRM_MS=800, dwellSec*1000)` (DB default `dwellSec`=5) → `fireAlert`. **STAY**: one heartbeat re-alert per `ZONE_REALERT_MS`=300 s. A frame with `count==0` resets `firstInside`. **CLEAR**: `present=false` once a frame arrives with nobody inside and `now - lastInside > ZONE_CLEAR_MS`=8 s. State GC after `OCC_TTL_MS`=10 min. |
| 19 | Persist + fan-out | `fireAlert` | Optional crop upload to MinIO `vms-snapshots/zone/<monitorId>/...` (only if a box carried `snap`). `AIEvent.create` `eventType 'zone.intrusion'`, severity `critical` (`warning` if `zone.priority==='low'`), payload `{zoneId, zoneName, count, personId:'zone:<id>', matchedName:'N persons', snapshotUri}`. `emit(AI_EVENT_DETECTED)` → toast + bell. Then `alertEngine.maybeAlert`. |
| 20 | Alert gate | `alertEngine.js:maybeAlert` | Only `warning`/`critical`. Category `intrusion`; subject `id:zone:<zoneId>` (one identity per zone). Redis `SET NX EX` cooldowns per (user, camera, category, subject): push `ALERT_PUSH_COOLDOWN_SEC`=90, email `ALERT_EMAIL_COOLDOWN_SEC`=600. Email burst cap `ALERT_EMAIL_MAX_PER_WINDOW`=8 per `ALERT_EMAIL_WINDOW_SEC`=600 per user. Account switches `mobile_app` / `email_alerts`. Recipient filter by `minSeverity` and `eventTypes`. Fails open if Redis is down. |

End-to-end latency to an alert ≈ RTSP/decoder lag + dwell + ≤ 1 sample (0.25 s) + < 1 ms engine.

---

## 3. Pre/post-processing and model details

| Item | Value | Set by |
|---|---|---|
| Weights | `/models/yolov8n.pt` (compose mounts `smart-cam-ai/app/Customer-Footfall-Count-main/yolov8n.pt`) | `ZONE_SIM_MODEL` |
| Classes | COCO 0 `person` only, filtered at inference | `PERSON_CLASS = 0` in `zone_sim.py` |
| Input size | 640 (letterboxed rect 640×384 for 16:9) | `ZONE_SIM_IMGSZ` |
| Colour / norm | RGB, 0..1 float32, pad 114 | Ultralytics defaults |
| Precision | FP32 PyTorch eager (no `half`, no TensorRT/ONNX) | not set → default |
| Device | auto (CUDA if visible) / CPU fallback after 10 failures | `ZONE_SIM_DEVICE`, `ZONE_SIM_INFER_FAIL_LIMIT` |
| Confidence | 0.35 | `ZONE_SIM_CONF` |
| NMS IoU | 0.7 | Ultralytics default (not exposed) |
| Tracker | BoT-SORT default config, `persist=True` | `ZONE_SIM_TRACK` |
| Analysis rate | 4 fps target per camera | `ZONE_SIM_FPS` |

Other base checkpoints: the harness used Ultralytics **yolo11n/s/m/l/x** COCO checkpoints
(`C:\projects\intrusion-detection\...\app\models\`, not shipped; Ultralytics downloads them by name).
`study.py` uses **yolo11x @ 1280, conf 0.25** as the pseudo ground truth ("reference"). Production
remains yolov8n @ 640.

---

## 4. Tracking / temporal logic and anti-flood rules

What is built is an **occupancy model per zone**, not the per-track FSM in the spec. Track IDs churn
under occlusion, and keying on them flooded alerts, so `zoneIntrusion.service.js` keeps one small
state record per zone: `{present, firstInside, lastInside, lastAlert}`.

| Layer | Mechanism | Value | Code |
|---|---|---|---|
| L1 detect | person conf floor | 0.35 | `zone_sim.py` |
| L2 track | BoT-SORT (display only) | — | Ultralytics |
| L3 confirm (M1) | continuous presence for `max(800 ms, dwellSec)` | dwell default 5 s; UI offers Instant/3/5/10/30 s | `CONFIRM_MS`, `zone.dwellSec` |
| L3 clear (M2) | empty for 8 s, evaluated only when a frame arrives | 8 000 ms | `ZONE_CLEAR_MS` |
| L3 stay | heartbeat re-alert while occupied | 300 s | `ZONE_REALERT_MS` |
| L3 capacity | K consecutive frames + deadband | K=3, margin 5 | `occupancyHysteresis.js` |
| L5 cooldown (M3) | per (user, cam, category, zone) | push 90 s, email 600 s | `alertEngine.js` |
| L5 burst (M4) | per-user email cap | 8 / 600 s | `alertEngine.js` |
| Authorisation | `box.name ∈ zone.allowed` → not counted | only works for named (face) boxes | `handleFrame` |

**Spec vs. code.** `RESTRICTED_ZONE_DETECTION.md` §4/§9 and `DETECTION_LOGGING_ALERTING_POLICY.md` §5.3
describe a per-(track × zone) FSM (K-of-N 5/8 entry, 1.5 s exit debounce, 2.5 s track-lost grace, 60 s
per-track cooldown, 1 alert/10 s/zone rate cap, 2 s identity grace, `zone_events` audit log with
enter/leave rows) in a planned `vms_face/services/zone_intrusion.py`. That file does not exist. Today
there is no leave event, no audit row for authorised entries, and a disarmed zone logs nothing.

---

## 5. Outputs and consumers

| Output | Shape | Consumer |
|---|---|---|
| Overlay frames (ephemeral) | `ai.live.overlay` bus event → socket `ai.live` | On-video AI overlay (only while a browser watches that camera; `ws.service.js` gates fan-out) and the zone engine (always) |
| `ai_events` row | `zone.intrusion` / `occupancy.threshold`, payload above | Alerts list, Event Log, Reports library, Cloud Playback evidence |
| Socket `ai.event` | the row | Operator toast + notification bell |
| Push | Expo, title "Zone intrusion" | Mobile app |
| Email | per recipient, inline crop if `snapshotUri` resolves | `AlertEmail` recipients |

Zone CRUD: `restrictedZone.routes.js` (`GET` needs `restricted_zone` or `headcount`; `POST/PUT/DELETE`
need `restricted_zone`). The controller checks only `monitorId` and `name`.

---

## 6. Configuration knobs

| Name | Default | Effect |
|---|---|---|
| `BACKEND_URL` | `http://smart-cam-backend:5000` | Registry + overlay target |
| `SERVICE_TOKEN` | required | Internal API auth; process exits if unset |
| `ZONE_SIM_MONITORS` | code `all`; compose = demo camera | Which monitorIds get a worker |
| `ZONE_SIM_SOURCES` | empty (compose: demo publisher path) | `monitorId=rtsp://...` URL overrides |
| `ZONE_SIM_MODEL` | `/models/yolov8n.pt` | Weights path (any Ultralytics detect model) |
| `ZONE_SIM_FPS` | 4 | Analysed frames/s per camera |
| `ZONE_SIM_CONF` | 0.35 | Person confidence floor |
| `ZONE_SIM_IMGSZ` | 640 | Letterbox size |
| `ZONE_SIM_DEVICE` | auto | `cuda:0` / `cpu` |
| `ZONE_SIM_TRACK` | true | BoT-SORT on/off (see §7: on drops people) |
| `ZONE_SIM_REGISTRY_REFRESH` | 60 s | Camera registry poll |
| `ZONE_SIM_INFER_FAIL_LIMIT` | 10 | Failures before CPU fallback |
| `ZONE_SIM_LOG` | INFO | Log level |
| zone `dwellSec` | 5 (DB default) | Confirm time; floor 0.8 s |
| zone `priority` | `high` | `low` → severity warning, else critical |
| zone `schedule` / `armWindow` | `always` / null | Arming window (IST) |
| zone `maxOccupancy` | null | >0 switches the zone to capacity mode |
| zone `allowed` | null | Names that are not intruders |
| `OCCUPANCY_CONFIRM_POLLS` / `OCCUPANCY_CLEAR_MARGIN` | 3 / 5 | Capacity anti-flap |
| `ALERT_TIMEZONE` | Asia/Kolkata | Arming clock |
| `ALERT_PUSH_COOLDOWN_SEC` / `ALERT_EMAIL_COOLDOWN_SEC` | 90 / 600 | Per-zone channel cooldowns |
| `ALERT_EMAIL_MAX_PER_WINDOW` / `ALERT_EMAIL_WINDOW_SEC` | 8 / 600 | Email burst cap |
| `AI_MINIO_ENDPOINT` / `AI_MINIO_BUCKET` | `http://minio:9000` / `vms-snapshots` | Crop store |
| Engine constants (code only) | `CONFIRM_MS` 800, `ZONE_CLEAR_MS` 8000, `ZONE_REALERT_MS` 300000, `ZONE_RELOAD_MS` 60000, `OCC_TTL_MS` 600000 | Hard-coded in `zoneIntrusion.service.js` |

---

## 7. Measured performance / accuracy

Source: `code/cctv-test-harness/TEST_REPORT.md` (Hikvision 32-channel NVR, 18 IP cameras, 1080p H.265,
recordings from 16–17 Oct 2026; Windows 11, 24 threads, RTX PRO 5000). Testing was stopped after 10 of
24 tests. Accuracy is relative to the yolo11x@1280 pseudo ground truth (no hand labels).

| Test | Result | Key number |
|---|---|---|
| C01 single camera (simulated RTSP from a real clip) | PASS | read 25/25 fps; analysed 3.6 fps; pre 1.5 ms, GPU inference p50 4.2 / p95 7.3 ms, post 1.3 ms, total p50 7.8 / p95 13.0 ms; engine hand-off 0.3 ms; no backlog; GPU 3.6 % avg (`results/bench/c01.json`) |
| B03 dwell at 5 s | PASS | fires at 5.04 s every time (±0.24 s sampling); a 5.0 s stay may not qualify |
| B06 one person stays 2–5 min | PASS | exactly 1 incident per stay (tracker on or off) |
| E02 polygon geometry vs shapely | PASS with notes | 0 disagreements off-border on 40,401-point grids; border points inconsistent; bow-tie accepted |
| B02 seated person near a zone edge | FAIL | foot-point jitter σ 42 px (x) / 26 px (y); 1–5 false alerts per 5 min within 80 px of an edge (12–60/hour) |
| B04 exit and re-entry | FAIL | re-entry after >8 s missed when the person is alone in view (no empty frames posted); one missed detection with others in view delays the alert by up to 3.9 s |
| B05 overlapping zones | FAIL (by design) | one person → one alert per zone |
| D03 restart with active incident | FAIL | duplicate alert 6.6 s after restart (state is in memory only) |
| D04 alert destination down | FAIL (by inspection) | no retry; cooldown claimed before send |
| E05 invalid zone config | FAIL | one `null` corner throws and stops every zone on that camera; many bad values silently disable a zone |
| A04 crowds (partial, demo clip) | indicative | recall 90.3 % isolated vs 21.1 % overlapping (only 19 overlap cases); 35 track IDs for 44 reference people; 2 ID switches in 659 matches (`results/tests/A04.json`) |
| B01 brief crossings (controlled) | indicative | at dwell 0, ≤1.0 s in zone never alerts, ≥1.25 s always does (`results/tests/B01.json`) |
| Tracker effect (fixed in session) | noted | default `model.track` at 4 fps dropped 56 % of detected people → report recommends `ZONE_SIM_TRACK=false` |

Product-level claim: `docs/DRISHYAM_SALES_BOOKLET.md` states **96–99 %** for restricted zone /
intrusion. That figure is a sales-booklet number; it is not reproduced by the harness above.

---

## 8. Known weaknesses + concrete improvement ideas

Ordered by impact-per-effort. Each one maps to a measured failure or a reading of the code.

1. **Post empty frames (B04).** `zone_sim.py` posts only when `boxes` is non-empty, so a zone never
   clears when the scene empties and a later re-entry raises nothing until the 5-minute heartbeat.
   Fix: post `boxes: []` at ≥1 Hz (a heartbeat) even with no detections. Small change, large effect.
2. **Gap-tolerant dwell.** In `handleFrame`, any frame with `count==0` resets `firstInside`. Keep a
   ~1 s grace (`if now - lastInside > 1000` before resetting) so one missed detection does not restart
   the dwell timer.
3. **Boundary hysteresis (B02).** Smooth each track's foot-point (median/EMA of 3–5 samples), then
   enter on an inset polygon and leave on an outset one (2–3 % of frame). This needs `trackId` in the
   engine, so do it after item 8.
4. **Producers interfere on one channel.** Face frames and body frames both drive the same `zoneOcc`
   record. A face frame whose boxes are outside the zone sets `count==0` and resets the dwell timer.
   Body boxes never carry `name`, so `allowed` cannot suppress an authorised person whenever zone-sim
   covers the camera. Also, `allowed` is described as categories (`['Staff', …]`) but compared against
   person names. Fix: tag frames with a `source`, run zone logic on body boxes only, and attach
   identity by face-in-head-region containment (same method as `activity-monitor/identity.py`).
5. **Persist FSM state (D03).** Store `present/lastAlert` per zone in Redis (already a dependency) or
   rebuild from the last open `zone.intrusion` row at boot.
6. **Isolate zones (E05).** Wrap each zone's evaluation in its own try/catch. Validate with Joi in
   `restrictedZone.controller.js`: ≥3 numeric points in 0..100, no self-intersection, `dwellSec ≥ 0`,
   `HH:MM` arm times.
7. **Delivery reliability (D04).** Send via a BullMQ job with retry/backoff. Claim the cooldown only
   after a successful send.
8. **Tracker.** The engine ignores `trackId`, but tracking currently removes unconfirmed boxes (56 %
   loss at 4 fps). Either default `ZONE_SIM_TRACK=false`, or use ByteTrack with the detector conf
   lowered to ~0.1 so its low-score association stage works, and filter on track score later.
9. **Port the frame-edge fix.** The harness copy of the engine
   (`C:\projects\intrusion-detection\...\smart-cam-backend`) clamps foot-points to 0.5–99.5 %
   (`EDGE_INSET_PCT`, `clampPct`). Without it, a person cut off by the bottom edge (y=100 %) is never
   inside a zone drawn to the edge. The main repo and `../integration` copy do **not** have this fix.
10. **Evidence image.** zone-sim never sends `snap`, so alerts and emails have no crop. Either send a
    JPEG crop for in-zone boxes at ≤1 Hz, or have `fireAlert` pull a frame from the stream-service
    snapshot at fire time.
11. **Compute path (embedded view).** Today each camera gets: full-resolution software HEVC decode of
    every frame, its own PyTorch FP32 model instance, its own Python thread (GIL-bound, the head-count
    service measured ~175 inf/s per process), and a blocking HTTP POST in the loop. Levers, in order:
    - Decode the **sub-stream**: the registry already returns `rtspSub`, and a 640-input model gains
      nothing from 1080p. This cuts decode cost about 4×.
    - Hardware decode (NVDEC via ffmpeg/PyAV) and a shared decode tier (`FACE_SYSTEM_DESIGN.md`
      "Shared decode tier").
    - Export to TensorRT FP16 (`yolo export format=engine half=True imgsz=640`) and batch across
      cameras through one inference server, as the face pipeline's Phase 2 does.
    - Move the POST off the inference thread (queue + sender thread).
12. **Recall on hard cases.** Overlap recall was 21 % (A04). Try yolo11s/m at 640–960, or tiled
    inference for distant people. Measure with the harness's E01 confidence sweep and a small
    hand-labelled set (the reference detector is itself a model).
13. **Hard zones at dwell 0.** The 800 ms floor at 4 fps means a ≤1 s touch is never alerted (B01).
    For armoury-type zones, raise fps on that camera or lower the floor to two consecutive samples.
14. **Overlapping zones (B05).** Warn at save time, or add a priority order so a person in an overlap
    counts for one zone only.
15. **NVR lockout risk.** A wrong password plus the 1→30 s reconnect loop tripped the NVR's
    illegal-login lock for 30 minutes during D01. Detect 401s and back off for minutes, not seconds.
16. **Capacity clears.** With a small cap (say 3) the clear level is `max(0, 3-5)=0`, and an empty
    scene posts nothing, so a capacity breach can stay latched. Item 1 fixes this as well.

---

## 9. How to run standalone / test

**In the stack (needs the backend):**

```bash
# from the repo root, project drisyam-original
ZONE_SIM_MONITORS=<monitorId>[,<monitorId>…] \
docker compose -p drisyam-original -f docker-compose.drisyam-original.yml up -d --no-deps zone-sim
docker logs -f drisyam-original-zone-sim     # "frame 1920x1080", overlay POST warnings
```

Drop the `ZONE_SIM_SOURCES` default for real cameras. Draw a zone in the Restricted Zone UI on the same
camera, then watch backend logs for `ZONE INTRUSION`.

**Bare Python (any machine that can reach a backend):**

```bash
pip install ultralytics opencv-python-headless lap
export BACKEND_URL=http://<backend>:5000 SERVICE_TOKEN=<token> ZONE_SIM_MONITORS=<monitorId>
export ZONE_SIM_MODEL=yolov8n.pt ZONE_SIM_DEVICE=cuda:0 OPENCV_FFMPEG_CAPTURE_OPTIONS="rtsp_transport;tcp"
python -u code/zone-sim/zone_sim.py
```

**Harness (offline, no backend, real engine).** Needs Python 3.10+, Node ≥ 18, and
`pip install ultralytics opencv-python numpy shapely psutil imageio-ffmpeg requests fastapi uvicorn matplotlib`.

```bash
cd code/cctv-test-harness
# 1) Point the JS harness at an engine copy (the default ../../../smart-cam-backend/src is not in the bundle)
export ZONE_ENGINE_ROOT=$PWD/baseline/src          # pre-fix engine snapshot shipped with the harness
#    or ../../../integration/backend/src — but that copy requires ./entitlements.service, which
#    engine_harness.js does not stub: add
#    [path.join(BACKEND,'services','entitlements.service.js'), { getEntitlements: async () => null, allowsAny: () => true }]
#    to its `stubs` map first.
# 2) Detector weights: DEFAULT_MODEL = ../Customer-Footfall-Count-main/yolov8n.pt (not shipped)
mkdir -p ../Customer-Footfall-Count-main && python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')" \
  && mv yolov8n.pt ../Customer-Footfall-Count-main/
# 3) Run
python cctv_test.py frame clip.mp4 --at 10 --out grid.jpg     # 10 % grid to draw zones on
python cctv_test.py run case.json --out results/mine          # detect → replay real engine → PASS/FAIL
python tests_engine.py e02                                     # geometry vs shapely (no video needed)
python web_server.py --port 8765                               # browser dashboard: add a camera/video, draw zones, see alerts
python bench_sim.py c01 --minutes 2                            # needs a mediamtx binary at ../tools/mediamtx + clips
```

A test case JSON (see the `cctv_test.py` docstring) holds `video`, `zones` (percent points, `dwellSec`,
`maxOccupancy`, `allowed`, `schedule`), `fps 4`, `conf 0.35`, `imgsz 640`, `postEmpty` (set `true` to
test fix #1) and `expect` (`alerts`, `minAlerts`, `firstAlertWithinSec`). `analyze.py`, `study.py`,
`tests_engine.py e05` and `bench*.py` live scenarios need the real-camera corpus (`corpus/clips`,
`corpus/det`), which is not shipped. Re-record your own with `study.py record` / `nvr_export.py`
after filling in your NVR address and credentials. `analyze.py E06` replays every scenario against
`baseline/src` to diff behaviour after an engine change; use it as the regression gate for items 1–9.
