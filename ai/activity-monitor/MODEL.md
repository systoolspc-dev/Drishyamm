> **Study guide** (written 2026-10-20 for the AI study bundle). Paths in it are relative to that bundle: `code/activity-monitor/…` = this folder; weights = `ai/activity-monitor/models/`; `../10-trained-models/` = `models/trained/`; `../docs/…` = `docs/…`; `../integration/backend` = `backend/`; `../integration/compose` = the root `docker-compose.yml`. Model catalogue: `models/README.md`.

# 04 — Activity monitor (phone usage · productivity · attendance · live tracker)

A study guide for the `activity-monitor` service. It covers how each feature is computed, the real
defaults, and which file and function to change to improve it. All paths are relative to
`code/activity-monitor/` (original: `smart-cam-ai/app/activity-monitor/`) unless noted.

One process holds **four features**. They have different inputs, so treat them as separate pipelines:

| Feature | Input | Model | Main code |
|---|---|---|---|
| A. Phone usage / working state (per person) | Its own RTSP pull of operator-selected cameras | YOLOv8s-pose + custom YOLO26n `phone.pt` | `stream_worker.py`, `activity.py`, `tracker.py`, `ledger.py` |
| B. Identity fusion (names on body tracks) | vms_face Redis `vms.cam.state:*` | none (geometry) | `identity.py` |
| C. Attendance + policy alerts | vms_face Postgres `detection_events` (polled) | none (session clustering) | `recognition_sync.py`, `alert_policy.py`, `attendance.py`, `crossing.py` |
| D. Live tracker (who is where + trail) | vms_face Redis `vms.cam.state:*` | none (K-of-N + learned graph) | `live_tracker.py` |

The bundle ships `models/phone.pt`. The `yolov8s-pose.pt` / `yolov8n-pose.pt` base checkpoints are not
shipped; Ultralytics downloads them by name. Trained phone runs are in
`../10-trained-models/phone-usage-yolo26/`.

---

## 1. What it does + process topology

```
                    Backend (Node)                                     activity-monitor (FastAPI :8000, host :8010)
 operator toggles  ─ POST /api/ai/activity-cameras ─> pushActivityCameras() ─POST /activity/cameras─> StreamManager.reconcile_streams()
 settings.ai.activityMonitoring                       (FULL desired set, all orgs)                         │ one StreamWorker per camera
                                                                                                           ▼
 stream-service ─rtsp://<host>:8554/cam_<monitorId>──> reader thread (latest frame) → processor thread
                                                         ├─ Detector "phones" (phone.pt)   ┐ under ONE global model lock
                                                         ├─ ActivityAnalyzer: pose + IoU   ┘
                                                         │   tracker + rules + hysteresis
                                                         ├─ IdentityProvider.resolve()  <── Redis vms.cam.state:* (vms_face)
                                                         └─ ActivityLedger.observe() ──> SQLite (daily_activity, phone_sessions)
 vms_face Postgres detection_events ──poll 20 s──> RecognitionSync → AlertPolicy ──> SQLite (attendance, crossings, alerts)
 Redis vms.cam.state:* ──────────────────────────> AttendanceWatcher (face-box line fallback), LiveTracker (who-is-where)
 Browser ─> backend /api/ai/activity/*, /api/ai/track/* (JWT, per-org scoping) ─proxy─> activity-monitor REST
```

Runtime: one CPU container (`Dockerfile`: `python:3.11-slim` + CPU-only torch, ffmpeg). Compose service
`activity-monitor` in `docker-compose.drisyam-original.yml`; config is bind-mounted, the SQLite DB lives
in volume `activity-monitor-data` (`/srv/activity-monitor/data/activity.db`). `config/config.docker.yaml`
has `streams: []`. Cameras arrive at runtime from the backend and are persisted in the store as setting
`activity_cameras`, then restored at boot (`manager.py:StreamManager.start`). The source is the
stream-service `cam_<monitorId>` path that vms_face already reads, so there is no extra NVR pull.

---

## 2. Frame-by-frame call path

### 2A. Phone usage / working state

| # | Stage | Where | What happens (real values) |
|---|---|---|---|
| 1 | Camera set | `ai.controller.js:pushActivityCameras` → `api.py POST /activity/cameras` → `manager.py:reconcile_streams` | Desired list `{id: monitorId, name, source: rtsp://<rtspHost>:<port>/cam_<monitorId>, vms_camera: monitorId}`. Adds/stops workers without a restart (`_make_worker`: its own `ActivityAnalyzer` + `LineCrosser`). |
| 2 | Decode | `stream_worker.py:StreamWorker._read_loop` | `cv2.VideoCapture(source)`, `BUFFERSIZE=1`, RTSP over TCP (compose `OPENCV_FFMPEG_CAPTURE_OPTIONS`). CPU FFmpeg decode of every frame. Only the latest frame is kept (`_latest_frame`, `_latest_seq`). Reconnect 3 s doubling to 30 s. |
| 3 | Sampling | `_process_loop` | Polls the slot every 5 ms. Skips unless `seq` changed, then runs every `pipeline.infer_every`-th new frame (docker **2**, default 1). `target_fps` 0 = no cap. A watchdog marks `reconnecting` after `read_timeout` (docker 20 s). |
| 4 | Phone detector | `model.py:Detector.infer` (shared by all workers) | `YOLO('models/phone.pt').predict(frame, device, imgsz, conf, classes=None)`. Docker: `device cpu`, `imgsz 640`, `conf 0.50`, `half` unset (False). `config.yaml`: `imgsz 1280`, device auto. Raw box count goes through `counter.py:RollingCounter` (median of 5) for the dashboard banner only. |
| 5 | Pose model | `activity.py:ActivityAnalyzer.analyze` (one instance per camera) | `YOLO('models/yolov8s-pose.pt').predict(frame, imgsz, conf=0.40)` → person boxes `xyxy` + keypoints `(17,3)` = COCO-17 `(x, y, conf)`. Docker `imgsz 640`, `config.yaml` 1280. |
| 6 | Tracking | `tracker.py:IoUTracker.update` | Greedy IoU ≥ `track_iou` 0.3 (best pairs first). Then a centre-distance fallback: within `track_center_dist_ratio` 0.6 × box width. Unmatched boxes become new IDs. Tracks survive `track_max_misses` 45 processed frames. No Kalman, no appearance. |
| 7 | Phone attribution | `ActivityAnalyzer._base_state`, `_phone_overlap`, `_phone_near_hand` | For each phone box: `inter / phone_area ≥ phone_overlap` 0.30. If `phone_require_hand`, the phone centre must also lie within `phone_hand_radius` 1.3 × shoulder width of any visible (`kpt_conf` ≥ 0.30) wrist (9, 10), nose, eye or ear. With no usable keypoint it falls back to overlap only. Pass → `on_phone`. |
| 8 | Posture rules | `activity.py:posture_state` | Both shoulders (5, 6) ≥ 0.30, else `unknown`. `head` = most confident of nose/eyes/ears. If head conf < `posture_face_min` 0.45: `not_working` (buried head) when both shoulders ≥ 0.5, else `unknown`. `head_lift = (shoulder_y - head_y) / shoulder_width`; < `posture_head_down` −0.50 → `not_working`. If both hips (11, 12) visible: `tilt = atan2(|Δx|, |Δy|)` in degrees > `posture_tilt_max` 28 → `not_working`. Otherwise `working`. |
| 9 | Talking (off) | `_talking_pairs` | Yaw from nose vs ear/eye midpoint. Pair if they face each other (yaw ≥ 0.20 / ≤ −0.20) and centre distance ≤ 2.5 × average box width. `talking_enabled: false` in both YAMLs. Note: the pydantic default is **True**. |
| 10 | Hysteresis | `_PersonState.update` | A new instant state must persist `hold_seconds` 1.5 s before it is committed. `unknown` keeps the last committed state. State objects for IDs absent from **this** frame are deleted. |
| 11 | Identity | `identity.py:IdentityProvider.resolve` | Latest vms_face frame for `camera_code == vms_camera`, if younger than `ttl_sec` 3 s. Face centre (normalised) must be inside the body box's x-range and in its top `head_region` 0.6. The candidate nearest the body's horizontal centre wins. `"Unknown"` is ignored. |
| 12 | Ledger | `ledger.py:ActivityLedger.observe` | Key = name or `"{stream}#{track}"`. Adds `dt = min(now - last_ts, 5 s)` to the **previous** committed state. `unknown` frames are skipped. `on_phone` edges open/close **phone sessions**. `manager._sweep_loop` (1 s) closes sessions unseen for `session_gap_sec` 3 s. Flushes `daily_activity` every `ledger_flush_sec` 30 s and resumes the day after a restart. |
| 13 | Line crossing | `crossing.py:LineCrosser.update` | Foot-point side test against a drawn line, `min_frames` 3. Only static `config.streams` with `vms_camera` get their line routed here (`manager.set_line`). For runtime-added cameras the crosser is dormant and the line goes to the face-box fallback (2C). |
| 14 | Preview | `_encode_preview` | Annotated JPEG (docker quality 60), served at `/snapshot/{id}` and `/video/{id}` (MJPEG `preview_fps` 15). |
| 15 | Output | REST only | Nothing is pushed. The backend proxies `GET /activity/people`, `/sessions`, `/history`, `/streams`, `/cameras`, and scopes each response to the caller's own camera codes or names (`ai.controller.js`, fails closed). |

### 2B/2C. Attendance and alerts (no video)

| # | Stage | Where | Values |
|---|---|---|---|
| 1 | Poll | `recognition_sync.py:RecognitionSync._sync_once` | Every `RECOGNITION_SYNC_SEC` 20 s, reads **today's** `detection_events ⋈ persons ⋈ cameras` (name, ts, camera code, similarity) since IST midnight. Optional `RECOGNITION_CAMERAS` (camera UUIDs). |
| 2 | Sessions | `_cluster` / `_summarise` | Per name, a silence longer than `RECOGNITION_SESSION_GAP_SEC` starts a new visit (compose **3600**, code default 600). Mid-visit silences ≥ `RECOGNITION_BREAK_GAP_SEC` 900 count as "away" (excluded from on-site time). A visit is open if its last sighting is within the gap. |
| 3 | Log gates | `_sync_once` | Keep a closed visit only if `count ≥ RECOGNITION_MIN_DETECTIONS` 3, `active_sec ≥ RECOGNITION_MIN_SESSION_SEC` 0 and `max_sim ≥ RECOGNITION_MIN_SIMILARITY` (compose **0.5**, code default 0). Open visits are always kept. |
| 4 | Direction | `_summarise` | If `RECOGNITION_ENTRY_CAMERAS` is set, IN = first door-camera sighting and OUT = last; otherwise first/last seen anywhere. |
| 5 | Persist | `store.py:upsert_attendance`, `add_crossing` | Per (date, name) rollup plus an in/out feed. In-memory `_logged_in/_logged_out` sets dedupe the feed (preloaded from the last 5,000 crossings at boot). |
| 6 | Alerts | `alert_policy.py:AlertPolicy` | `evaluate_known`: **watchlist** (critical, name in `ALERT_WATCHLIST`), **after_hours** (warning, visit enter outside `ALERT_BUSINESS_HOURS` 07:00–21:00 IST). `evaluate_strangers`: unknown faces (`person_id IS NULL`) clustered per camera with `ALERT_STRANGER_GAP_SEC` 60. Dwell ≥ `ALERT_STRANGER_DWELL_SEC` (compose **180**, code 120). Daytime open-area strangers are skipped (`ALERT_STRANGER_AFTER_HOURS_ONLY` 1). `ALERT_STRANGER_ZONES` cameras → critical at any hour. |
| 7 | Cooldown | `AlertPolicy._fire` → `store.add_alert` | `dedup_key = date|type|subject|session_enter_ts` is UNIQUE, so the cooldown is one alert per identity per visit. |
| 8 | Face-line fallback | `attendance.py:AttendanceWatcher._ingest` | For cameras with a saved line: `LineCrosser` on vms_face **face** boxes from `vms.cam.state:*`, so the "foot-point" is the chin. Logs every crossing, known or unknown. |

### 2D. Live tracker

`live_tracker.py:LiveTracker._observe`, on every named box in a `vms.cam.state` frame:

- **K-of-N:** needs `TRACK_CONFIRM_HITS` 3 sightings within `TRACK_CONFIRM_WINDOW_SEC` 5 s on a camera.
- **Teleport guard:** a camera change faster than `max(TRACK_MIN_TRANSIT_SEC 2, 0.5 × learned median
  transit)` needs +`TRACK_TELEPORT_EXTRA_HITS` 2 sightings.
- **Contention guard:** if the current camera saw the person within `TRACK_HANDOFF_QUIET_SEC` 2 s, the
  new camera must have strictly more recent hits.
- **States** (`_tick_once`, 1 s): ACTIVE → TRANSIT after `TRACK_ACTIVE_TTL_SEC` 6 s, then LOST after
  `TRACK_LOST_TTL_SEC` 120 s. A revisit after `TRACK_REHOP_GAP_SEC` 60 s opens a new hop.
- **Movement graph** (`_learn_graph`): every `TRACK_ADJ_REFRESH_SEC` 900 s, an SQL `LEAD()` over
  `TRACK_ADJ_LOOKBACK_DAYS` 14 days of `detection_events`. Transitions of 1–600 s give camA→camB count
  and median time, which drive the top-3 "predicted next camera".
- **Trail:** capped at `TRACK_TRAIL_CAP` 60 hops.

Input cadence comes from vms_face (`config/settings.py`): boxes are published at most every 0.2 s
(5 Hz) while a browser watches the camera, and every 1.0 s otherwise (`overlay_unwatched_interval_sec`,
viewer gating on). There is a 1 s heartbeat for empty scenes.

---

## 3. Pre/post-processing and model details

Checkpoint metadata below was read with `torch.load` (Ultralytics 8.4 venv). The pre-processing is
Ultralytics `predict`: `LetterBox(imgsz)` with `auto=True` for `.pt` → a 16:9 frame becomes **640×384**
at 640 and **1280×736** at 1280, pad 114, BGR→RGB, `/255`, float32. Inference is PyTorch eager **FP32**
on CPU in the docker image; `half` only applies on CUDA.

| Model | Architecture | Classes | Params | Trained | Inference settings (docker / config.yaml) | Post-proc |
|---|---|---|---|---|---|---|
| `models/phone.pt` | **YOLO26n** detect (`yolo26n.yaml`, scale n; NMS-free end-to-end head) | 1: `using phone` | 2,504,190 | from `yolo26n.pt`, imgsz 640, 50 epochs, batch 8, Ultralytics 8.4.84, 2026-07-02; stored FP16 | conf 0.50, imgsz 640 / 1280, cpu / auto | YOLO26 one-to-one head, max_det 300 |
| `yolov8s-pose.pt` (default `pose_weights`) | YOLOv8s-pose (C2f backbone, PAN, pose head) | 1: person, kpt_shape [17,3] | 11,626,046 | COCO-pose, Ultralytics 8.0.77 (2023-04) | conf 0.40, imgsz 640 / 1280, `kpt_conf` 0.30 | NMS IoU 0.7 (Ultralytics default) |
| `yolov8n-pose.pt` (alternative) | YOLOv8n-pose | person, [17,3] | 3,295,470 | COCO-pose | not used by the shipped configs | — |

Phone training data (`C:\projects\phone-no_phn\...\dataset`, label stats only): 8,892 train / 2,541 val /
1,270 test images, 19,178 / 5,559 / 2,722 boxes. Mean box is 5.1 % × 8.6 % of the image and the median
area is 0.37 % of the frame, so a box is a phone-in-hand region, not a whole person.

---

## 4. Tracking / temporal logic and anti-flood rules

- **Per-person state** (2A): IoU + centre-distance tracker → instant rule → 1.5 s hold → ledger. The
  ledger caps `dt` at 5 s (stalled-stream guard). Phone sessions close after 3 s unseen. Aggregate
  views hide tracks with less than `min_present_sec` 3 s total.
- **Attendance** (2C) follows the doctrine in `DETECTION_LOGGING_ALERTING_POLICY.md` §5.6:
  - entity = recognised identity;
  - confirm = ≥ 3 detections and best match ≥ 0.5;
  - debounce = 1 h visit gap and 15 min break;
  - alert = one per identity per visit (UNIQUE `dedup_key`).
- **Live tracker** (2D): K-of-N, teleport guard, contention guard, TTL state machine.
- **Alert reach:** activity alerts live **only** in this service's SQLite and the console
  (Attendance Report / Event Log). They do not create backend `ai_events`, so push and email
  (`alertEngine.js`) never see them. `ATTENDANCE_ALERTS.md`: "critical-alert → phone push" blocked.
- Framework row f (`DETECTION_DECISION_ALERT_FRAMEWORK.md` §6): phone usage is **not alert-shaped**.
  It is a session ledger, and that is how the code treats it.

---

## 5. Outputs and consumers

| Endpoint (activity-monitor) | Backend proxy | Consumer |
|---|---|---|
| `GET /activity/people`, `/sessions`, `/history?days` | `/api/ai/activity/people|sessions|history` | Productivity page (`ai-analytics/.../Productivity`) |
| `GET/POST /activity/cameras` | `/api/ai/activity-cameras` | Monitored-cameras chips (per-camera toggle) |
| `GET /activity/attendance`, `/crossings`, `POST /attendance/reset` | `/api/ai/activity/attendance|crossings` | Attendance Report, AI Feed attendance panel |
| `GET /activity/alerts`, `POST /alerts/{id}/ack`, `/alerts/clear` | `/api/ai/activity/alerts` (+ack) | Attendance Report alerts panel |
| `GET /activity/metrics?date` | `/api/ai/activity/metrics` | Funnel-health strip (dedup ratio, recognition rate) |
| `GET /activity/events` | `/api/ai/activity/events` | Event Log page |
| `GET/PUT /activity/line` | `/api/ai/activity/line` | Line drawing on AI Feed |
| `GET /track/live[/name]`, `/track/graph`, `POST /track/reset` | `/api/ai/track/*` | Live tracker page |
| `GET /count`, `/streams`, `/health`, `/snapshot/{id}`, `/video/{id}` | `/api/ai/activity/streams`, snapshot | Live annotated feed |

SQLite tables (`store.py`, WAL): `phone_sessions`, `daily_activity`, `settings`, `crossings`,
`attendance`, `alerts` (UNIQUE `dedup_key`).

---

## 6. Configuration knobs

YAML keys can be overridden by env vars `MONITOR_<SECTION>__<KEY>` (`config.py:_apply_env_overrides`).

| Name | Default (code) / docker | Effect |
|---|---|---|
| `detectors[phones].conf` | 0.35 / **0.50** | Phone confidence gate |
| `detectors[phones].imgsz` | 640 / 640 (`config.yaml` 1280) | Small/distant phone recall vs CPU cost |
| `detectors[phones].device`, `.half` | auto, false / cpu | Device; FP16 only on CUDA |
| `activity.pose_weights` | `models/yolov8s-pose.pt` | Pose model |
| `activity.conf` / `imgsz` / `kpt_conf` | 0.40 / 640 / 0.30 | Pose gates |
| `activity.phone_overlap` | 0.30 | Fraction of the phone box inside the person box |
| `activity.phone_require_hand` / `phone_hand_radius` | true / 1.3 | Hand/head proximity gate (× shoulder width) |
| `activity.posture_head_down` | −0.50 | Head-lift threshold for slumped |
| `activity.posture_tilt_max` | 28° | Reclined torso (hips visible) |
| `activity.posture_buried_head` / `posture_face_min` | true / 0.45 | Hidden-face → not_working |
| `activity.hold_seconds` | 1.5 | State persistence before switching |
| `activity.talking_enabled` | **true** (code) / false (YAML) | Pairwise talking |
| `activity.track_iou` / `track_max_misses` / `track_center_dist_ratio` | 0.3 / 45 / 0.6 | Tracker |
| `activity.min_present_sec` | 3.0 | Ghost-track filter in views |
| `activity.session_gap_sec` / `ledger_flush_sec` | 3.0 / 30 | Phone-session close / persistence |
| `pipeline.infer_every` / `target_fps` | 1 / **2**, 0 | Frame skip / rate cap |
| `pipeline.smooth_window` | 5 | Median window for detector counts |
| `pipeline.read_timeout` | 10 / **20** s | Dead-stream watchdog |
| `identity.enabled` / `ttl_sec` / `head_region` | false / **true**, 3.0, 0.6 | Face-name fusion |
| `api.preview` / `jpeg_quality` / `preview_fps` | true, 70 / **60**, 15 | Dashboard preview |
| `RECOGNITION_SYNC_SEC` | 20 | DB poll interval |
| `RECOGNITION_SESSION_GAP_SEC` | 600 / **3600** | Visit debounce |
| `RECOGNITION_MIN_DETECTIONS` | 3 | Robustness gate |
| `RECOGNITION_MIN_SIMILARITY` | 0 / **0.5** | Confidence gate |
| `RECOGNITION_BREAK_GAP_SEC` | 900 | "Stepped out" |
| `RECOGNITION_ENTRY_CAMERAS` | empty / **3 door-camera codes** in compose | Directional in/out (IN at first door sighting, OUT at last) |
| `RECOGNITION_CAMERAS` | empty (all cameras) | Restrict the poll to these vms_face camera UUIDs |
| `ALERT_BUSINESS_HOURS` | 07:00-21:00 | After-hours policy (IST) |
| `ALERT_STRANGER_DWELL_SEC` / `_GAP_SEC` | 120 / **180**, 60 | Stranger dwell |
| `ALERT_STRANGER_AFTER_HOURS_ONLY` / `ALERT_STRANGER_ZONES` | 1 / empty | Daytime suppression / secure cameras |
| `ALERT_WATCHLIST`, `ALERTS_ENABLED`, `ALERT_AFTER_HOURS`, `ALERT_STRANGER`, `ALERT_WATCHLIST_ON` | empty, 1, 1, 1, 1 | Policy switches |
| `TRACK_*` (see 2D) | 3, 5 s, 6 s, 120 s, 2 s, +2, 2 s, 60 s, 14 d, 900 s, 60 | Live tracker |
| `RECOGNITION_PG_DSN` / `TRACK_PG_DSN` | AI Postgres DSN | Read-only source (set in env; do not hard-code credentials) |

---

## 7. Measured performance / accuracy

| What | Number | Source |
|---|---|---|
| Phone model, own val split | P 0.842, R 0.827, mAP50 0.904, mAP50-95 0.498 (epoch 50) | `phone.pt` checkpoint `train_metrics`; run `phone_yolo26/results.csv` |
| YOLO26m retrain (not deployed) | P 0.861, R 0.856, mAP50 0.922, mAP50-95 0.533 | run `phone_yolo26-2/results.csv` (`../10-trained-models/phone-usage-yolo26/`) |
| Posture thresholds | **not validated**; config marks them "UNVALIDATED defaults" | `config/config.yaml` comment; `docs/ACCURACY.md` §1 |
| Talking | disabled, "unreliable on overhead/side CCTV" | `config.yaml`, README "Known limits" |
| Attendance dedup | 203:1 (47,298 detections → 233 events, one live day) | `docs/ATTENDANCE_ALERTS.md` "Measured results" |
| Confidence gate | dropped 1 of 31 low-confidence visits | same |
| Robustness gate | filtered 2 flimsy 1–2-frame arrivals of 44 people | same |
| Recognition rate by camera | 70 % / 60 % (eye-level entry) … 39 % … 5 % (overhead) | same |
| Break tracking | one live visit read on-site 187 min / away 62 min | same |
| Alert cooldown | a watchlisted person in 2 visits → exactly 2 critical alerts | same |
| Unit tests | 44 tests (activity 17, config 9, counter 5, identity 6, ledger 7); not run for this guide | `tests/` |

There is no measured precision/recall for the end-to-end `on_phone` / `working` labels on CCTV, and no
measured CPU fps or latency in a repo document.

---

## 8. Known weaknesses + concrete improvement ideas

1. **One global inference lock.** `StreamManager._model_lock` serialises phone **and** pose inference
   across **all** cameras. Each camera also loads its own pose model copy (memory with no
   parallelism). Fix: one pose model, batched across cameras (or an inference server, as the face
   pipeline's Phase 2 does), with tracker/rules state per camera. Run phone detection only on frames
   with ≥ 1 person.
2. **CPU + FP32 at 640.** `ACCURACY.md` says small-phone recall needs imgsz ≥ 1280, which CPU cannot
   afford. Levers:
   - `scripts/export_model.py --format openvino` (x86) or `--format engine --half` (Jetson/NVIDIA);
   - ROI cropping: run the phone model on upper-body crops from pose (wrist/head boxes upscaled)
     instead of the whole 1280 frame. That is cheaper and gives better recall on distant people;
   - a GPU image (`ACCURACY.md` "Note on compute").
3. **Hysteresis state lost on a one-frame miss.** `ActivityAnalyzer.analyze` deletes `_states[tid]`
   whenever the ID is absent from the current frame, even though the tracker keeps the track 45
   frames. After any flicker the person is `unknown` for ≥ 1.5 s, and the ledger skips that time.
   Fix: expire `_states` on tracker death, not per frame.
4. **Identity is per-frame and not time-aligned.** `resolve()` matches the latest cam-state frame (up to
   3 s old, 1 Hz when nobody watches, from a different decode) and never latches. Two people side by
   side can swap names, and the ledger key flips between `stream#id` and the name, splitting time.
   Fix: per-track name voting (K-of-N over ~2 s), then latch.
5. **Posture rules are hand-tuned and unvalidated.** Upright-idle vs upright-working cannot be
   separated (documented blind spot). Next step: log keypoints plus a few labelled minutes per
   camera, fit thresholds per camera angle, then train a tiny temporal classifier on keypoint
   sequences (e.g. a 1D-conv/GRU over 2 s of 17×3 keypoints; cheap on CPU).
6. **Phone gate geometry.** `phone_hand_radius` is in shoulder widths. For a side-on or overhead
   person, shoulder width collapses and the radius shrinks. Use torso length or box diagonal as the
   scale fallback. The overlap-only fallback (no keypoints) lets desk phones back in; consider
   requiring ≥ 2 consecutive frames.
7. **Runtime cameras have no body-line crossing.** `manager.set_line` / `_body_stream_for` only know
   static `config.streams`. Lines for operator-added cameras go to the face-box fallback, which uses
   the chin as the "foot". Route lines by `vms_camera` across `_dynamic_ids` too.
8. **Attendance poll is O(day).** `_sync_once` re-reads all of today's `detection_events` every 20 s
   (≈ 47k rows on the measured day) and re-clusters everyone. Make it incremental (`occurred_at >
   last_ts`, keep open sessions in memory). The `_logged_in/_logged_out` sets grow without bound across
   days; prune them by date.
9. **Activity alerts never reach push/email.** Forward critical policy alerts to backend
   `/api/internal/ai/events` so `alertEngine` cooldowns and channels apply.
10. **Live tracker vs. viewer gating.** At 1 Hz unwatched publishing, a "too fast" handoff needs 5
    hits in a 5 s window, which is borderline, so handoffs can stall when nobody is watching. Make
    the window adaptive to the observed publish rate, or subscribe at full rate.
11. **Single-tenant store.** Scoping is done in the backend proxy by camera code or name. A shared
    name across orgs can leak through name-keyed rows. Add `org_id` to the store keys.
12. **Stale test.** `tests/test_config.py::test_requires_at_least_one_stream` expects empty `streams`
    to fail, but the validator now allows it (attendance runs with no cameras).
13. **Retrain the phone model at `s`/`m` on site footage** (`ACCURACY.md` §3). The yolo26m run already
    gains +1.8 mAP50 on the same split. Measure on CCTV crops, not the training distribution.

---

## 9. How to run standalone / test

```bash
cd code/activity-monitor
python -m venv venv && . venv/bin/activate          # Windows: venv\Scripts\activate
pip install -e ".[dev,identity]" psycopg2-binary     # torch comes via ultralytics (install the vendor wheel first on Jetson)
pytest -q                                            # 44 unit tests (expect the stale stream test to fail)

# Webcam / file / RTSP with the default config (models/yolov8s-pose.pt auto-downloads by name)
activity-monitor --config config/config.yaml         # dashboard http://localhost:8000/
MONITOR_ACTIVITY__DEVICE=cuda MONITOR_ACTIVITY__IMGSZ=1280 activity-monitor --config config/config.yaml

# Add a camera at runtime, as the backend does
curl -X POST localhost:8000/activity/cameras -H 'Content-Type: application/json' \
  -d '{"cameras":[{"id":"cam1","name":"Desk","source":"rtsp://<host>:8554/cam_<monitorId>","vms_camera":"<monitorId>"}]}'
curl localhost:8000/activity/people ; curl localhost:8000/streams

# Tune rules on a still / render a clip
python scripts/probe_activity.py frame.jpg --tilt 24
python scripts/render_video.py in.mp4 out.mp4
python scripts/export_model.py --format onnx          # or engine --half / openvino
```

In the stack (from repo root): `docker compose -p drisyam-original -f docker-compose.drisyam-original.yml
build activity-monitor && ... up -d --no-deps --force-recreate activity-monitor`. The source is baked
into the image; config edits only need a recreate. Attendance, alerts and the live tracker need vms_face
running (Redis `vms.cam.state:*` and its Postgres `detection_events`). `scripts/smoke_attendance.sh`
publishes synthetic cam-state frames through the whole attendance chain and cleans up after itself.
Edit its camera code and login variables for your setup before running it.
