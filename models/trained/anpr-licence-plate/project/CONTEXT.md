# Trinetra ANPR — Number-Plate Model Context (handoff for a fresh session)

> Paste/reference this whole file when starting a new chat to work on the ANPR
> model. It is self-contained: models, pipeline, file paths, what's already
> wired, what was MEASURED, how to run, the roadmap, and the open questions
> for Gujarat Police. Last rewritten **2026-08-28** after the v2 worker landed;
> GIS layer (§6e), the decode-first scale story (§6d) and Indian vehicles +
> night reading (§6f) added the same day.

---

## 0. TL;DR

Trinetra is a CCTV video-management + analytics platform entered in the
**Gujarat Police Sentinel Hackathon 2026** (portal
https://sentinel.gujarat.gov.in/problems — registration closes 7 Sep, event
10–11 Sep, i-Hub Gandhinagar; target scale ~80,000 cameras). The mandatory
test case: judges name a **vehicle registration number**; we must identify it
on the ~50 government feeds and show the **complete route with timestamps**,
correlate against a watchlist, and raise **automated alerts**.

Two ANPR paths, one server-side spine (**sighting → watchlist → alert →
Find-a-Vehicle route**). A match is always **a lead, never a verdict**.

1. **Single-image API** (`/anpr/read`) — ONNX pip packages in the main AI
   container.
2. **Live worker** (`anpr_worker/worker.py`, compose service
   `anpr-worker`, **running on all corp8 feeds**) — GPU, ByteTrack, plate
   **restoration** (motion deblur / night / glare), multi-hypothesis OCR with a
   **format-constrained decoder**, **per-character temporal voting**, evidence
   **records + H.264 clips**, VAHAN-style **registry enrichment**.

Everything below "§4 wired" exists and has been run on the live Gujarat feeds.

---

## 1. The models

### Path A — single-image ANPR (`vms_face/services/anpr.py`)
- Plate detection: `open-image-models` → `yolo-v9-t-384-license-plate-end2end` (ONNX).
- Plate OCR: `fast-plate-ocr` → **`cct-s-v2-global-model`** (10 slots, 64×128 RGB).
  ⚠ The v1 CCT models (`cct-xs-v1…`) and `global-plates-mobile-vit-v2` have
  **9 output slots** — they physically cannot emit a 10-character Indian
  plate. Every `GJ01AB1234`-style read before 2026-08-28 was silently
  truncated. Keep v2 first in `_OCR_CANDIDATES`.
- Weights auto-download into `/root/.cache/{open-image-models,fast-plate-ocr}`.

### Path B — live worker (this folder)
- **`models/best.pt`** (23.4 MB) — custom YOLOv8 plate detector (Roboflow
  *License Plate Recognition* v4, 24k images, CC BY 4.0).
- **`models/yolov8n.pt`** — COCO vehicle detector (car/motorcycle/bus/truck =
  2/3/5/7). Since 2026-08-28 the worker derives the class filter, canonical
  names and per-class confidence floors from the model's own `names`
  (`vehicle_types.py`, §6f) — `ANPR_VEHICLE_MODEL=models/vehicle_ft.pt` after
  the IDD fine-tune adds `autorickshaw` with no other change.
- **Tracking:** `bytetrack_lite.py` — self-contained ByteTrack (Kalman +
  two-stage IoU/Hungarian association). Ids reset on every reconnect.
- **OCR:** same fast-plate-ocr v2 model, but driven through its ONNX head
  directly so the **whole per-slot distribution** is available
  (`plate_ocr.py: constrained_decode`).
- **Engine:** `ANPR_ENGINE=auto` → ultralytics/torch on CUDA in the worker
  image; falls back to `yolo_onnx.py` (onnxruntime) if torch is absent —
  export with `yolo export model=models/best.pt format=onnx` (not yet done).

### Hardware / images
- GPU: NVIDIA RTX A3000 Laptop 12 GB.
- Worker image `trinetra/anpr-worker` = `FROM drisyam-face-reconstruct:latest`
  (local, verified CUDA torch 2.7.1+cu128) + ultralytics + fast-plate-ocr +
  imageio-ffmpeg. NOT built from `pytorch/pytorch` (3–4 GB pull fails on this
  network) and NOT on `trinetra/ai` (its `onnxruntime` is the CPU wheel —
  1.29 overwrote onnxruntime-gpu, so InsightFace there is on CPU too).

---

## 2. The live pipeline (v2, `worker.py`)

Per camera, one thread; detectors + OCR are shared (locked) across threads:

```
VideoSource (PyAV → static ffmpeg → cv2)             video_source.py   keeps NEWEST frame only
  → loop at CLIP_FPS (5): push frame to ClipRecorder  clip_recorder.py  rolling JPEG ring buffer
  → detection at TARGET_FPS (3): motion gate           R10               skip static frames
  → vehicle detect + ByteTrack ids                     yolov8n / bytetrack_lite
  → plate detect + geometry sanity                     best.pt           aspect 1.2–6.5, not OSD band
  → ASSESS crop: sharpness, luminance, glare, polarity,
    cepstral motion-blur (length, angle, prominence)    plate_enhance.assess
  → RESTORE → candidate variants (gated by assessment) plate_enhance.candidates
      base = denoise(night) → auto-gamma → CLAHE → moments-deskew
      night: log_clahe · retinex   glare: blackhat · retinex   inverted: 255-x
      motion: Wiener + Richardson-Lucy-TV with the estimated kernel
      defocus: RL-gauss + blind RL (line prior)   else: unsharp
      two-row plates: split rows → OCR each → concat  (bikes / trucks)
      optional Real-ESRGAN x2 via face-reconstruct /api/upscale (OFF, see §5)
  → OCR every variant in ONE batch, full per-slot distributions
  → format-constrained MAP decode  ĉᵢ = argmax p_ocr(c|x)·p_format(c|i)
    over Indian templates (SS DD L0-3 NNNN, BH series 22BH1234AA)
    + state-code prior; rules fallback                 plate_ocr.py / plate_rules.py
  → per-track per-CHARACTER weighted vote across frames × variants
    weight = ocr conf × variant prior × det conf        plate_votes.py   R4 + R5
  → confirm when frames ≥ MIN_VOTES(3) AND agreement ≥ MIN_AGREEMENT(0.6)
  → POST /api/ai/anpr/sighting {plate, raw, camera, coords, ts (frame time),
        confidence, bbox, vehicle_type, snapshot_b64 (vehicle), plate_b64, meta}
  → evidence record on disk + clip (pre 6 s → post 4 s, H.264) → upload
        POST /api/ai/anpr/sighting/{id}/media                       R13
  → unresolved tracks (TTL) → data/review/  (relabel queue)
```

Config: all `ANPR_*` env (see the docstring at the top of `worker.py` and the
compose service). Tunables that matter: `ANPR_TARGET_FPS`, `ANPR_MIN_VOTES`,
`ANPR_MIN_AGREEMENT`, `ANPR_ENH_MOTION_Z` (cepstral trust), `ANPR_ENH_WIENER_K`.

---

## 3. The live feeds

30 Gujarat Police CCTV feeds as cameras `corp8_NN` (provider
`live.corp8.cloud`, MediaMTX). **HLS over :443 only** (RTSP/WebRTC
firewalled): `https://live.corp8.cloud/live/stream/{N}/index.m3u8`
(LL-HLS v10, 1080p H.264 @ 10 fps on the ones probed). The pip
`opencv-python` FFmpeg cannot fetch its segments — PyAV / ffmpeg can; that is
why `video_source.py` exists. Cameras carry real coordinates.

Plate pixel sizes seen live (66 crops, 4 feeds): median **80×42 px**, many at
70×35 (≈7 px per character — below what any OCR resolves). corp8_07 gives
readable plates; corp8_10/13 mostly not. corp8_03's "plates" are the camera
**OSD caption** (filtered now).

---

## 4. What's WIRED (do not redo)

**Worker (`anpr_worker/`)**
| File | Role |
|---|---|
| `worker.py` | the pipeline above; torch/onnx engine switch; records; stats every 30 s |
| `plate_enhance.py` | assess + lighting + deskew + two-row split + Wiener/RL/blind-RL + SR hook; `python plate_enhance.py` self-test |
| `plate_ocr.py` | fast-plate-ocr wrapper, batched, per-slot distributions, `constrained_decode`, `read_two_line` |
| `plate_rules.py` | Indian templates incl. no-series-letter and BH plates, position-aware correction, `near_match` (Levenshtein); **copied to** `vms_face/services/plate_rules.py` — keep in sync |
| `plate_votes.py` | per-character weighted temporal voter (`TrackVotes`, `Consensus.confidence`) |
| `bytetrack_lite.py` | tracker (no torch) |
| `video_source.py` | HLS/RTSP/file reader, latest-frame, reconnect backoff 2→30 s, `epoch` for tracker reset |
| `clip_recorder.py` | ring buffer → libx264 mp4 (imageio-ffmpeg / system ffmpeg) |
| `yolo_onnx.py` | ONNX YOLOv8 fallback engine |
| `collect_crops.py` | harvest real plate crops from feeds → `data/crops/raw/` + `index.jsonl` |
| `eval_enhance.py` | A/B harness: raw vs enhanced vs oracle, CER, blur-estimator error (R14) |
| `probe_hls.py` | which decode path works for a url in this image |
| `plate_verify.py` | render-and-compare verifier (advisory on today's crop sizes) + `calibrate()` |
| `export_labels.py`, `train_ocr.py`, `train_detector.py` | the retraining loop (datasets → fine-tune → promote if better) |
| `auto_retrain.py` | the automation: compose service `anpr-trainer`, writes `data/train/status.json` |
| `calibrator.py`, `train_calibrator.py` | learned confidence P(read correct) from officer labels → `models/calibrator.json` (hot-reloaded) |
| `synth_plates.py` | confusion-targeted synthetic Indian plates degraded with kernels sampled from live traffic; `style='painted'` hand-painted autos/tempos/tractors (22 %), `ir_bloom` IR-camera domain (18 %) |
| `vehicle_types.py` | **the one Indian vehicle vocabulary** (§6f): canonical `car, motorcycle, autorickshaw, bus, truck, erickshaw, tractor, vehicle`; `from_detector(id_or_name, model.names)`, `trackable_ids(names)`, `from_vahan(text)`, `canonical()`, `compatible(a, b)`, `registry_mismatch(camera_type, vahan_class)` (lead wording), `DISPLAY` labels; `python vehicle_types.py` self-test. **Identical copy at `../ai_service/vms_face/services/vehicle_types.py`** (the API imports that one) — change both |
| `train_vehicle_detector.py` | IDD (VOC XML, `Annotations/` + `JPEGImages/`) → YOLO in the taxonomy (+ our frames pseudo-labelled ≥ 0.5) → fine-tune from `yolov8n.pt` → per-class AP50 → promote to `models/vehicle_ft.pt` + `.names.json` + `.report.json` only if shared classes do not regress AND autorickshaw AP50 ≥ 0.40. Needs the IDD archive (registration at idd.insaan.iiit.ac.in) |
| `night_report.py` | per-camera night-reading report (night = 19:00–06:00 IST) from records + review → `data/reports/night_<date>.{json,jpg}`; verdicts `reads at night` / `no night reads (dark)` / `(lit — check feed)` / `no night data`; flags data gaps > 30 min |
| `eval_night.py` | A/B of the IR-bloom variants on last night's crops (off / on / on_day / on_loose) → `data/tmp/eval_night.json`; hand-labelled truth for 5 IR crops |
| `retention.py` | storage policy on disk: sweeps `data/records`, `review`, `confirmed` every 6 h by `ANPR_RETAIN_*` days per kind (crop / snapshot / clip / json), keeps `watch_hit` records for the hit period, never visits `data/outbox`; `ANPR_RETENTION_DRY_RUN=1` |
| `export_records.py` | **the officer's folder**: copies `data/records/<date>/**` + that day's `data/reports/*` from the volume to `ANPR_EXPORT_DIR` (`/srv/anpr/export` = host `trinetra-ai\app\anpr_worker\export\records\<date>\`) — sequential, nice +10, same-size skip, `.part` + rename, skips files < 120 s old, logs files/MB/s. `run_export(date)`, `export_default_dates()` (today + 2 previous IST days — record folders are UTC dates), `start_daily_export(log)` / `seconds_until_export_hour()` for the retention thread at `ANPR_EXPORT_HOUR_IST` (02:30); CLI `--date` / `--days` / `--dry-run` (§ ANPR_SYSTEM.md 9b) |
| `migrate_data_to_volume.ps1` | one-off (idempotent) move of `data/` from the Windows bind mount to the named volume `drisyam_trinetra-anpr-data`: `docker volume create` → `cp -a` via a throwaway alpine → per-folder counts host vs volume; `-DeltaOnly` (`cp -a -u`), `-Switch` (py_compile the sources, `docker compose up -d --no-deps anpr-worker anpr-trainer trinetra-ai`, post-switch delta, `docker inspect` mounts, counts), `-Finalize` (rename host `data/` → `data_host_backup_<date>/`, create empty `data/` + `export/`), `-CountsOnly`. Never compose down, never deletes |
| `rehearsal.py` | **judge-task rehearsal** against the live stack (find, movement history via `/api/ai/anpr/report`, where-next, watchlist round-trip, stolen-vehicle alert drill at GNR-GATE-01) → `data/reports/rehearsal_<ts>.txt`; `--reset` calls `POST /anpr/demo/reset` (is_test rows only, seed re-applied). Run in `trinetra-anpr-trainer`. Playbook with steps/answers/pitfalls: `../../docs/JUDGE_TASKS.md` |
| `../ai_service/vms_face/services/anpr_lab.py` | **Test the reader**: `POST /anpr/lab` runs one upload through this folder's full pipeline, returns every variant/read; saves as a test sighting |
| `../ai_service/vms_face/services/roads.py` | road router (OSRM via httpx, `ROADS_PROVIDER` / `OSRM_URL`): `haversine_km`, `bearing_deg`, `road_route` → `RoadLeg(km, s, coords, snapped, provider)`; LRU 1024, 3-failure / 120 s circuit breaker, straight-line fallback (× 1.25, 60 km/h) |
| `../ai_service/vms_face/services/transitions.py` | camera→camera transit matrix: `camera_positions`, `refresh` (real sightings only, 60 s ≤ Δt ≤ 3 h, 30 d; nearest-8 road prefill ≤ 400 router calls), `predict_next` / `cone` (observed window when n ≥ 5, else `[0.6, 1.8] × road_s`; p ∝ n+1, `exp(−km/40)` decay), hourly `run_transitions_refresher` |
| `../ai_service/vms_face/services/route_geo.py` | route legs for `GET /anpr/route?format=geojson`: road geometry from `camera_transitions` (either direction) or the router, implied km/h, flags `ok / fast / impossible / same_camera / unknown`, `summary.cloned_suspect`, lead-not-verdict notes |
| `../ai_service/vms_face/alembic/versions/0011_anpr_gis.py` | migration **0011**: `camera_transitions` (PK tenant/from/to; road_km, road_s, geometry, snapped, provider, n, median/p10/p90, last_seen_at, road_updated_at) + `camera_health` (PK tenant/camera; sample fields, tier, tier_reason, history ≤ 48, priority_until/reason). No PostGIS |
| `../../../infra/osrm/README.md` | self-hosted OSRM: Geofabrik extract → `osrm-extract` / `osrm-partition` / `osrm-customize` → compose service `osrm` (profile `roads`, port 127.0.0.1:5001) → `OSRM_URL=http://osrm:5000` |
| `data/tmp/seed_gis_demo.sql` | idempotent `is_test` demo rows for both tenants: `GJ01AB1234` NH-48 route (re-timed, one amber leg) and `GJ18CD7788` cloned-plate demo (every leg impossible) |
| `Dockerfile`, `Dockerfile.train`, `.dockerignore` | worker image / training image (deps only; source bind-mounted) |
| `../../docs/ANPR_SYSTEM.md` | **the full handbook** (also published as the "Trinetra ANPR Handbook" artifact) |
| `data/` (git-ignored) | `crops/raw`, `frames`, `confirmed`, `review/<date>/`, `records/<date>/<cam>/`, `outbox`, `train`, `reports`, `tmp`, `eval`, `contact`. **Since 2026-08-28 this is the named volume `drisyam_trinetra-anpr-data`** (`/srv/anpr/data` in worker + trainer, `/srv/app/anpr_worker/data` in trinetra-ai) — the host `data/` is an empty placeholder, the pre-migration copy is `data_host_backup_2026-08-28/`, and the officer-facing copy is `export/records/<date>/` (bind mount) |

**Compose:** service `anpr-worker` (all corp8 cameras, 3 det/s, clips on,
SR off). `docker compose up -d anpr-worker`; restart to pick up code edits.
Worker env added 2026-08-28: `ANPR_CLIP_POLICY=all`, `ANPR_HEALTH_EVERY=60`,
`ANPR_PRIORITY_POLL=30`, `ANPR_RETAIN_{CROPS,SNAPSHOTS,CLIPS,HIT}_DAYS`
= 90/30/30/365, `ANPR_RETENTION_DRY_RUN=0`. `trinetra-ai` env added:
`ROADS_PROVIDER=osrm`, `OSRM_URL` (public demo, dev-only), `ANPR_FAST_KMH=120`,
`ANPR_MAX_KMH=150`. New optional service `osrm` (profile `roads`,
`trinetra-osrm`, `osrm/osrm-backend`, `osrm-routed --algorithm mld`,
`./infra/osrm/data:/data`, host 127.0.0.1:5001) — `docker compose --profile
roads up -d osrm` after preparing the data (see `infra/osrm/README.md`).
Worker env added 2026-08-28 (vehicles / night / filters / recall, §6f):
`ANPR_VEHICLE_CONF_MIN=0.15`, `ANPR_MOTO_CONF=0.18`, `ANPR_AUTO_CONF=0.25`,
`ANPR_MAX_ASPECT_MOTO=7.0`, `ANPR_NIGHT_LUM=60`, `ANPR_NIGHT_DET_ENHANCE=1`,
`ANPR_PLATE_MAX_SAT=0.45`, `ANPR_STATIC_TTL=1800`, `ANPR_POSSIBLE=1`,
`ANPR_POSSIBLE_MIN_CONF=0.55`, `ANPR_POSSIBLE_MIN_WEIGHT=0.5`,
`ANPR_CONFIRM_2FRAME_WEIGHT=0.9`, `ANPR_MERGE_WINDOW=4`; `ANPR_VEHICLE_MODEL`
(default `models/yolov8n.pt`) is read by the worker. AI setting
`ANPR_CLASS_CHECK_ALERT` (default on). Compose env changes need
`docker compose up -d --no-deps anpr-worker`, not a plain restart.
Storage & performance (2026-08-28 evening, `docs/ANPR_SYSTEM.md` §9b): volume
`trinetra-anpr-data` (pin `name: drisyam_trinetra-anpr-data`) at `/srv/anpr/data`
(worker, trainer) and `/srv/app/anpr_worker/data` (trinetra-ai); export bind
`./trinetra-ai/app/anpr_worker/export:/srv/anpr/export` (worker, trainer);
worker env `ANPR_EXPORT_DIR=/srv/anpr/export`, `ANPR_EXPORT_HOUR_IST=2:30`,
`ANPR_WRITE_QUEUE=512`, `ANPR_REVIEW_POLICY=valid`, `ANPR_REVIEW_MIN_WEIGHT=0.3`,
`ANPR_REVIEW_SAMPLE=20`, `ANPR_REVIEW_MAX_PER_DAY=4000`, `ANPR_DECODE_ERRORS_MAX=25`,
`ANPR_HALF=1`; trinetra-ai `ORT_INTRA_OP_THREADS=2`, `ORT_INTER_OP_THREADS=1`.

**AI service (`vms_face`)**
- `POST /anpr/sighting` — now accepts `ts`, `bbox`, `vehicle_type`, `meta`,
  `snapshot_b64`, `plate_b64` → MinIO `vms-snapshots/anpr/{tenant}/{plate}/…`;
  **near-match**: 1-char-off a watchlisted plate still alerts
  (`meta.near_match`, reason prefixed `NEAR-MATCH`).
- `POST /anpr/sighting/{id}/media` (multipart clip/snapshot → `meta.clip_uri`).
- `GET /anpr/media?uri=` — evidence relay with correct content type (mp4!).
- `GET /anpr/route/{plate}?fuzzy=1` — stitches same-length ±1-char reads.
- `POST /anpr/vehicle {plate}` — the camera side only since 4 Oct 2026 (hot-list status, `record: null`, `registry: "ask"`); the GET with the plate in the path answers 410. The VAHAN/SARATHI adapter below moved to the government gateway (docs/govt/API.md). Historical notes:
  (`services/vehicle_registry.py`): `VAHAN_PROVIDER=off|mock|http`, URL/body
  templates + dotted field map for any JSON API (NIC VAHAN, API Setu, eGujCop,
  aggregators), per-tenant cache table `vehicle_registry_cache` (migration
  **0008**), PII masked, every fresh lookup **audited**. Mock is deterministic
  and labelled "Demo data — VAHAN not connected".
- Sightings expose `meta` (frames, agreement, assessment/scenario, winning
  variants, plate_snapshot_uri, clip_uri, near_match).
- **GIS layer (2026-08-28, §6e):** `GET /anpr/route/{plate}?format=geojson`
  (default `json` byte-identical) → Point per stop + LineString per leg
  (road km, Δt, implied km/h, `ok/fast/impossible/same_camera/unknown`) +
  `summary` (`cloned_suspect`) + `next` (forward cone);
  `GET /anpr/cameras/{code}/next?at=`; `POST /anpr/pursuit`; `GET /anpr/priority`;
  `POST /anpr/camera-health`; `GET /anpr/fleet`; `POST /anpr/transitions/refresh`.
  Watchlist alerts now carry `forward_cone` (top 5), `map_link`, `camera_name`.
  MinIO objects tagged `kind/hit/test`; tag-based lifecycle rules installed at
  startup (`anpr-clip-nohit`, `anpr-snapshot-nohit`, `anpr-crop-nohit`, `anpr-hit`).
- **Indian vehicles + night (2026-08-28, §6f):** `GET /anpr/vehicle/{plate}
  ?camera_type=` → additive `class_check {camera, registered, ok, known,
  reason, camera_label, registered_label, registered_class, note,
  camera_type_source}` (registry class vs camera type, lead wording); ingest
  stores `meta.class_check` from the registry **cache** only and publishes a
  `high` alert `REGISTRY MISMATCH — …` on a hard contradiction (confirmed
  reads only; `ANPR_CLASS_CHECK_ALERT`); `/anpr/sightings` + `/anpr/route`
  accept `vehicle_type=` (canonical or display name; Python match on
  `meta.vehicle_type` over a bounded window, `note` says how many rows) and
  rows carry `vehicle_type` / `vehicle_label`; the cross-camera appearance
  check uses `vehicle_types.compatible()`; `GET /anpr/fleet` items gain
  `night {samples, hours, reads_per_hr_night, reads_per_hr_day,
  scene_lum_night, ir_seen, dark_hours, posted_night, status, dark_flag,
  note}` and the tier reason may say "dark after 19:00 — check IR illuminator
  / exposure". Health history rows are now
  `[ts, fps, reads, plate_h_med, motion_frac, scene_lum, night, ir,
  posted_night, review_night, posted_possible, night_frac]` (≤ 48, compacted
  to span > 6 h). Mock VAHAN class by last digit: odd → Motor Cycle, 0/2 →
  3WN, else LMV.

**Backend:** proxies `/api/ai/anpr/vehicle/:plate`, `/api/ai/anpr/sighting/:id/media`,
`/api/ai/anpr/media` (binary relay) in `ai.controller.js` + `ai.routes.js`;
GIS proxies `/api/ai/anpr/cameras/:code/next`, `/pursuit` (operator header),
`/priority`, `/camera-health` (4 MB body), `/fleet`, `/transitions/refresh`;
`/api/ai/anpr/route/:plate` passes `format` through; `priority` and
`camera-health` are exempt from the rate limiter.

**Frontend (`FindVehicle.jsx`):** Registration-record card (VAHAN), evidence
thumbnails, "restored · night/motion/glare · Nf" chips, **Vehicle records**
feed (every camera, latest first, camera filter, plate crop + clip viewer
modal), snapshot + clip buttons per route stop. `aiService.mediaSrc(uri)` in `ai.js`.
GIS (2026-08-28): route query with `format=geojson`; road-snapped leg
polylines (ok navy / fast amber / impossible red dashed / unsnapped dotted)
with popups; `SummaryStrip`; `ClonedCard` ("Two places at once …", two crops,
"Trace this jump"); `LegsTimeline`; `PlaybackControls` (×1/×10/×60, scrubber,
reduced-motion aware); `WhereNext` cone list + "Pursuit mode (15 min)";
`FleetCard` (tiers, refetch 60 s). Leaflet kept.
Vehicles / night (2026-08-28, §6f): vehicle-type chip with `DISPLAY` labels
(bike / auto / …) on cards and route stops; Registration-record card shows
`class_check` — green "camera and registry agree: bike" or a red card "Plate
says bike, camera saw auto — possible stolen or cloned plate. A lead for an
officer, not a verdict."; Vehicle Records type filter (all / car / bike / auto
/ bus / truck / other → `vehicle_type=`); `FleetCard` night column (Moon):
`n/h night · d/h day`, badge `IR` / `dark — no IR` / `reads at night` /
`no night data yet`, totals chip "N read at night", copy "night = 19:00–06:00 IST".

**Real vs test data (2026-08-28):** `vehicle_sightings.is_test` /
`vehicle_watchlist.is_test` (migration **0009**). The API hides test rows
unless `include_test=1`; the page has a **"Test data"** button (URL `?test=1`,
amber banner, `TEST` chips) that reveals the seeded demo route
(`GJ01AB1234` across GNR-GATE-01 → SUR-KAMREJ-11), the cloned-plate demo
(`GJ18CD7788`, §6e) and demo watch entries for a walkthrough. Default view =
only what the live reader read. Seed scripts must send `"test": true`; test
rows never feed the transit matrix or the fleet's 24 h counts. Yesterday's demo rows (non-`corp8_*` cameras) and
the e2e self-test rows were tagged by SQL; the synthetic `GJ98TEST02` alert
row was deleted from MySQL `ai_events`.

**face-reconstruct:** `POST /api/upscale` — pure Real-ESRGAN x2 (no face
pipeline), returns JPEG bytes.

---

## 5. What was MEASURED (2026-08-28) — numbers, not vibes

| Test | Result |
|---|---|
| Cepstral motion-blur estimator, synthetic blurs 6–18 px | mean length error **0.5 px**, direction correct; Wiener/RL raise sharpness 2–3× |
| Enhancement A/B on **66 real crops** (4 feeds), single frame | rule-valid reads **7 → 11** (old recipe → enhanced + constrained decode) |
| Real-ESRGAN x2 on 29 real crops < 40 px | valid 3 → 4, **+89 ms/crop**, reads change but don't improve → **OFF by default** (generic GAN SR hallucinates glyphs; needs a plate-tuned SR) |
| OCR slot bug | v1 models: 9 slots → 10-char plates truncated → **fixed by v2 (10 slots)** |
| Per-crop cost (worker, GPU box) | enhance ≈ 3 ms, OCR (all variants, CPU ONNX) ≈ 45 ms |
| Live dry-run corp8_07 | first confirmed plate in ~100 s: `GJ18Z8601` conf 0.95, 3 frames, 97 % agreement (`inverted` variant won) |
| Voter unit test | 5 frames each with a different wrong char → exact plate, agreement 0.90 |
| **Live, all 30 feeds** (after the fixes below) | ~12 confirmed plates / 5 min, e.g. `GJ11DB3552` 0.84, `GJ18ZT0355` 0.87, `GJ16CN1665` 0.77 (corp8_09/21); each with vehicle snapshot + plate crop + 4–10 s clip; `/anpr/media` serves image/jpeg and video/mp4 |
| Feed probe (30 streams, from the AI container) | 19 decode live, 5 offline server-side (16/17/18/22/30), 6 "end" every ~15 s = ffmpeg blocking on an in-progress LL-HLS segment (now: immediate reopen, `ANPR_READ_TIMEOUT=30`) |
| Host load | 24 cores; worker alone was 1078 % CPU (thread pools per camera thread) → thread budget + 3-process sharding → ~800 %; `trinetra-ai` face pipeline holds ~1050 % on CPU (its onnxruntime is the CPU wheel) and re-tries RTSP for all 30 corp8 cameras every 40 s |

**Bugs found by the review workflow and fixed the same day:** 413 on every
worker POST (Express 10 KB JSON limit — raised to 4 MB for
`/api/ai/anpr/sighting`, plus a worker fallback that posts without images and
uploads them as multipart); HLS bursts collapsing to one frame per segment
(PTS-paced decode); PSF larger than the crop crashing a camera thread;
shared CLAHE object not thread-safe; motion gate firing on noise (noise floor
√(2 ln n)); OCR budget counting variants not frames; tracker reset not
clearing vote state; orphan cell blinding its spot; constrained decoder
dropping two-row halves; JSON body templates breaking the VAHAN HTTP
provider; media relay not tenant-scoped; cache-insert race; rate limiter
counting thumbnails; nested buttons in the timeline.

Eval on real crops with synthetic degradation only found 4 sharp+valid
originals — the flywheel (`data/crops`, `data/review`, `data/records`) must
grow before that number means anything. **Label 200+ real crops** (file
names `PLATE_*.jpg` or `labels.csv`) and run
`python eval_enhance.py --labelled DIR` — that is the benchmark to beat.

---

## 6. How to run / verify

```bash
# worker on all corp8 cameras (compose)
docker compose up -d anpr-worker && docker logs -f trinetra-anpr-worker
# dry-run one feed, no backend
docker run --rm --gpus all -v "$PWD/trinetra-ai/app/anpr_worker:/srv/anpr" -w /srv/anpr \
  -e ANPR_DRY_RUN=1 -e ANPR_MAX_CAMERAS=1 \
  -e "ANPR_SOURCES=corp8_07=https://live.corp8.cloud/live/stream/7/index.m3u8" \
  trinetra/anpr-worker:latest python -u worker.py
# inside the AI container (no torch): harvest + eval
docker exec -w /srv/app/anpr_worker trinetra-ai python collect_crops.py --cams corp8_07,corp8_10 --frames 400
docker exec -w /srv/app/anpr_worker trinetra-ai python eval_enhance.py --synth data/crops/raw --n 150
docker exec -w /srv/app/anpr_worker trinetra-ai python plate_enhance.py     # estimator self-test

# GIS layer (§6e)
docker compose --profile roads up -d osrm          # self-hosted road router (prepare infra/osrm/data first)
curl "http://127.0.0.1:5001/route/v1/driving/72.5714,23.0225;72.6369,23.05?overview=false"   # {"code":"Ok",…}
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/ai/anpr/transitions/refresh  # force a refresh
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/ai/anpr/fleet | jq .totals           # check fleet tiers
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:5000/api/ai/anpr/route/GJ01AB1234?format=geojson&include_test=1" | jq .summary
docker exec -i trinetra-ai-postgres psql -U vms -d vms_face < trinetra-ai/app/anpr_worker/data/tmp/seed_gis_demo.sql   # demo rows, idempotent
```
Records: `trinetra-ai/app/anpr_worker/data/records/<YYYY-MM-DD>/<camera>/HHMMSS_PLATE.{jpg,_plate.jpg,json,mp4}`.
UI: `/ai-analytics/vehicle` (records feed when no plate is typed).

---

## 6b. The RETRAINING LOOP (2026-08-28) — the reader learns from its mistakes

```
Find-a-Vehicle record  ──✓ Correct / ✗ Wrong (+true plate) / Not a plate──►  POST /anpr/sightings/{id}/label
                                                                              (anpr_labels table, migration 0010,
                                                                               audited; a corrected plate moves the
                                                                               sighting under the true plate at once)
GET /anpr/labels/stats     → overall + per-camera + per-scenario accuracy, char confusions (UI: "Read accuracy")
GET /anpr/labels/export    → human labels + confident auto-labels (conf ≥ 0.9, agreement ≥ 0.95)

python export_labels.py    → data/train/ocr/{images,train.csv,val.csv}   (fast-plate-ocr: image_path,plate_text)
                             data/train/det/… + data.yaml                 (YOLO, from records/*_frame.jpg + bbox;
                                                                            not_plate = negative image)
                             data/labelled/PLATE_id.jpg                   (eval_enhance.py --labelled)
python train_ocr.py        → fine-tunes cct_s_v2_global.keras (--weights-path) on our crops, exports ONNX,
                             evaluates base vs fine-tuned on val, PROMOTES to models/ocr/ only if better
python train_detector.py   → fine-tunes models/best.pt on our frames, promotes to models/best_ft.pt if mAP50 improves
restart anpr-worker        → picks up models/ocr/model.onnx (ANPR_OCR_MODEL_DIR) / ANPR_PLATE_MODEL
```
Training extras (Keras 3 + TensorFlow, ~600 MB, one-off): `python train_ocr.py --install`.
Run training in a throwaway copy of the worker image on the compose network:
`docker run --rm --gpus all --network drisyam_default -v "<repo>/trinetra-ai/app/anpr_worker:/srv/anpr" -w /srv/anpr trinetra/anpr-worker:latest python train_ocr.py --install --epochs 30`.
Minimums: 40 OCR crops / 60 frames before the scripts will train — label the
wrong reads first, they teach the most. Posting floor now 0.7 conf / 0.7
agreement (0.8 for 8-char plates); everything below is still recorded in
`data/review/` for labelling.

## 6c. The COMPARISON stage (2026-08-28) — string vs. pixels before anything is posted

Three independent opinions must agree before a plate reaches the console:
1. **Voter** — per-character consensus across frames × enhancement variants
   (agreement ≥ 0.7, calibrated confidence ≥ 0.7; 0.8 for 8-char plates).
2. **Second reader** — `PlateOcrEnsemble` runs a *different* recogniser
   (`cct-xs-v2`, plus the fine-tuned model when present) on every crop; its
   reads enter the same vote tagged `@r1`, so a glyph only one model saw
   loses (`ANPR_OCR_READERS`).
3. **Verifier** — `plate_verify.py` renders each candidate string as a
   synthetic plate (bold near-monospace glyphs, same text band) and
   correlates it with the real glyph mask per character. The consensus must
   score ≥ `ANPR_VERIFY_MIN`; a valid alternative that matches the pixels
   better by `ANPR_VERIFY_MARGIN` replaces it when the voter was unsure.
   Per-character scores are stored in `meta.verify` (evidence + export).
   `python plate_verify.py data/labelled` prints true-vs-wrong score
   separation so the threshold is set from measurements.
   **Measured 2026-08-28:** on a clean synthetic plate it separates cleanly
   (true 0.29 vs wrong 0.13 / −0.05, per-glyph scores flag the wrong
   character); on the real 40–60 px corp8 crops it does NOT yet (true 0.06
   vs wrong 0.07 — the binarised glyphs are too degraded at that size). So
   `ANPR_VERIFY_MIN=0` (advisory: scores recorded, nothing blocked) until
   either the crops get bigger (Sentinel cameras) or a learned glyph
   similarity replaces NCC. The second reader (2) is the comparison that
   works today.
Anything failing 1–3 is still recorded (`data/review/`, with the scores) —
it just isn't a lead.

## 6d. Scaling to 1 lakh feeds — the shape that survives it

What runs today on one laptop: 30 feeds, 3 processes (`ANPR_PROCESSES`),
thread budget, PTS-paced PyAV software decode, motion gate. Every number
below is an **estimate**; the pipeline is the one running today.

**The cost truth: at 1 lakh feeds the dominant cost is VIDEO DECODING, not
detection or OCR.** YOLOv8n batched under TensorRT is ≈ 1–2 ms/frame, so one
L4-class GPU sustains thousands of detections/s; OCR is ≈ 45 ms/crop on CPU
and only runs on plates. Decoding 100k H.264 streams (1080p @ 10 fps,
≈ 4–8 Mbps each) is ≈ 100 Gbps of ingest and thousands of concurrent decode
sessions — that line item sizes the fleet. Software decode is fine for 30
feeds and is exactly what must not be multiplied by 3,300.

Three levers, in order:
1. **Substream motion gating** — run the motion gate (the 160×90 mean-|Δ|
   test we already use) on the NVR's D1/480p substream on CPU (a few hundred
   fps per core); pull + decode the main stream only while something moves.
   Static most of the day → ≈ 150–300 cameras per GPU instead of ≈ 30.
2. **NVDEC hardware decode** for whatever is decoded — the GPU video engine
   leaves the CUDA cores to YOLO. In `video_source.py` that is choosing the
   `h264_cuvid`/`hevc_cuvid` decoder; nothing downstream changes.
3. **Tiered camera policy** from the fleet tiers the worker already reports
   (§6e): chokepoints / toll / city entry-exit full-rate; interior lanes
   motion-gated best-effort; ANPR-infeasible cameras (≈ 7 px/char, wrong
   angle — measured) cost zero GPU. The fleet map is a deliverable: "these N
   cameras produce usable reads, these M need repositioning".

Sizing (estimates): gating + NVDEC + tiering ≈ **400–700 GPUs** (L4/A3000
class) for 1 lakh feeds, not the naive 3,300 workers (≈ 30 feeds/GPU).
On-prem ≈ **₹15–30 crore** of hardware amortised over years; cloud GPU rental
costs a comparable sum every year at list prices and the footage leaves the
state. On-prem keeps every frame, crop and lookup inside government
infrastructure (DPDP + optics).

Target architecture (same code; `ANPR_SHARD=k/n` already lets replica k own
every n-th camera):
```
cameras ─RTSP/HLS─► INGEST+DETECT nodes (GPU)   substream motion gate · NVDEC · YOLO (TensorRT, batched) · ByteTrack
                     │  plate crop + track id + ts (≈5 KB msg)
                     ▼
                  Kafka topic anpr.crops (partition = camera)      ← durable, replayable: promote a better OCR
                     ▼                                               and re-read last week's crops, no camera touched
              OCR+VERIFY workers (CPU, stateless, autoscaled)      enhance · ensemble OCR · vote · verify
                     ▼
              POST /anpr/sighting (per tenant)  →  Postgres (partition by month, (plate, ts) index) + MinIO evidence
                     ▼
              watchlist / near-match / cone → Redis alert bus → Alerts UI ; labels → retraining
```
**Kafka is the TARGET shape, not the running one**: today the worker posts
each sighting over HTTP (`POST /api/ai/anpr/sighting` via the backend, disk
outbox on failure) and nothing on the ANPR path produces or consumes Kafka
(the only producer in the stack is `journey.events`). Camera→worker
assignment moves from env to a Redis lease (claim, heartbeat, release on
death); the ingest catalogue is the Sentinel `/api/ingest` feed list.

**Streaming watchlist join:** ≈ 1,440 reads/camera/day → ≈ 144 M sightings/
day (≈ 1,700/s). The watchlist (+ precomputed 1-edit neighbours) lives in
memory in a consumer as a hash/trie; one lookup per read + ≤ 10×36 neighbour
lookups against 50k entries is trivial CPU work on one node. Alerts carry map
link, evidence, confidence — lead, not verdict. Today the AI service does the
same join per POST against Postgres, and the alert already carries
`forward_cone`, `map_link`, `camera_name`.

**Storage policy:** 144 M/day × a clip each (≈ 1 MB) ≈ 100+ TB/day —
unaffordable. Tier it: JSON + plate crop for everything (few KB, 90 d),
vehicle snapshot for confirmed reads (30 d), clips only for watchlist hits
and officer-flagged (365 d / per case). Implemented today by `ANPR_CLIP_POLICY`
(`all` demo / `hits` scale default), `retention.py` (every 6 h;
`ANPR_RETAIN_CROPS_DAYS=90`, `ANPR_RETAIN_SNAPSHOTS_DAYS=30`,
`ANPR_RETAIN_CLIPS_DAYS=30`, `ANPR_RETAIN_HIT_DAYS=365`, `ANPR_RETAIN_JSON_DAYS`,
`ANPR_RETAIN_REVIEW_DAYS=30`, `ANPR_RETENTION_DRY_RUN`) and MinIO tag-based
lifecycle (`kind`/`hit`/`test` tags → rules `anpr-clip-nohit`,
`anpr-snapshot-nohit`, `anpr-crop-nohit`, `anpr-hit`, same env names on the
AI side).

**What stays exactly the same:** the read pipeline (enhancement, two readers,
per-character voting, grammar decode, calibrated confidence, self-training)
does not change between 30 and 1 lakh cameras; scale multiplies workers and
partitions and adds the lease; per-camera priors + health metrics become the
fleet dashboard.

## 6e. The GIS layer (2026-08-28) — route on a map, speed, cone, fleet

Type a plate → every place seen on the map, road route, implied speed per
leg, impossible-jump / cloned-plate flags, forward cone + pursuit, route
playback, fleet tiers. The router is asked once per **camera pair**, never
per sighting. Every flag / cone / match is a **lead, not a verdict** — the
API strings and the console say so.

- **Data model** (migration `0011_anpr_gis`): sightings carry denormalised
  lat/lng (nothing added); `camera_transitions` (PK tenant/from/to: road_km,
  road_s, geometry `[[lat,lng]…]`, snapped, provider, n, median/p10/p90_s,
  last_seen_at, road_updated_at); `camera_health` (PK tenant/camera: latest
  sample, ≤ 48 history, tier, tier_reason, priority_until/reason). **No
  PostGIS** — the image is `pgvector/pgvector:pg16` (cube/earthdistance
  available); haversine in Python; PostGIS is a drop-in at deployment (gate
  it like 0003 gates TimescaleDB). The `(plate, ts)` index answers "where was
  X" in ms; ingest is batch inserts. Positions from `transitions.camera_positions`
  (latest sighting per camera, AI `cameras` row overrides). All writes are
  single-row upserts with per-row commits (4-way race test passed).
- **`GET /anpr/route/{plate}?format=geojson`**: Point per stop (`kind: stop`,
  seq, plate, read_plate, fuzzy, camera, ts, confidence, snapshot/plate
  crop uris, watch_hit, is_test, near_match, hamming) + LineString per leg
  (`kind: leg`, from/to seq+code+name, road_km, straight_km, dt_s,
  implied_kmh, flag, reason, snapped, provider) + `summary` (stops, cameras,
  road_km, duration_s, avg_kmh, first/last_ts, n_fast, n_impossible,
  cloned_suspect, note) + `next` (cone from the last stop). Coordinates are
  `[lng, lat]`; the console converts for Leaflet. Stops without coordinates
  stay in `stops`, get no Point / leg. Default `json` is byte-identical.
- **Road snapping** (`services/roads.py`): OSRM `/route/v1/driving/…
  ?overview=full&geometries=geojson`, one call per new pair cached in
  `camera_transitions` (reverse reused) + LRU 1024; breaker 3 fails → 120 s;
  fallback straight line (haversine × 1.25, 60 km/h, `snapped=false`,
  `provider=straight`) rendered dotted. Self-hosted: compose `osrm` (profile
  `roads`); `infra/osrm/README.md` measured: western-zone extract peaked
  4.2 GB RAM, partition 320 s, customize 17 s, ≈ 3 GB graph, GNR → SUR in
  28 ms (270.9 km / 207 min). Public demo server = dev only. Only camera
  coordinates go to the router.
- **Implied speed + flags** (`services/route_geo.py`): `road_km / Δt`;
  `fast` > `ANPR_FAST_KMH` 120 (amber), `impossible` > `ANPR_MAX_KMH` 150
  (red dashed) → "misread or cloned plate — compare the plate crops";
  `same_camera` (waited/loop), `unknown` (clocks). `cloned_suspect` = ≥ 2
  impossible legs, or 1 with both reads ≥ 0.85 confidence → note "Two places
  at once — misread or cloned plate. Compare the plate crops before acting."
  Cloned-plate detection falls out of the GIS layer; no new model.
- **Forward cone** (`services/transitions.py`): matrix from all vehicles'
  transits per pair (consecutive real sightings, same plate, different
  camera, 60 s ≤ Δt ≤ 3 h, 30 d) → n, median, p10, p90; road-time prior
  `[0.6, 1.8] × road_s` until n ≥ 5; p ∝ (n+1), `exp(−km/40)` decay while
  nothing observed; top 8 with ETA windows. Hourly refresh
  (`ANPR_TRANSITIONS_REFRESH_MIN`, first run +2 min; nearest-8 within 150 km
  prefilled, ≤ 400 router calls, road answers refreshed after 7 d) +
  `POST /anpr/transitions/refresh` → `{ok, pairs, observed, router_calls,
  skipped}` (measured: 69 pairs, 59 calls first run then 0; observed 0 — no
  real cross-camera transit yet). **Pursuit**: `POST /anpr/pursuit {plate |
  camera_code, minutes=15}` → `camera_health.priority_until` on the cone's
  cameras, audit `anpr_pursuit`, note "Priority raised on N cameras for 15
  min. A match there is a lead for an officer, not a verdict."; worker polls
  `GET /anpr/priority` every 30 s → per-camera `boost_until`: fps ×2 (cap
  `ANPR_BOOST_FPS_CAP` 6), FAST_READS +2, MAX_READS +6, DRAIN +1, logged
  on/off. Alerts carry `forward_cone` (top 5, read-only path), `map_link`.
- **Route playback** (console): Play/Pause, ×1/×10/×60, scrubber, vehicle
  marker interpolated along leg geometries by time; reduced-motion → no
  auto-advance, scrubber still works.
- **Fleet tiers**: worker POSTs `/anpr/camera-health` every `ANPR_HEALTH_EVERY`
  (60 s) per process (fps, frames, reads, reads_per_hr, plate_h_med,
  motion_frac, decode_errors, native_frac, alive, backend, codec) from one
  aggregator thread. Rules: `unknown` (no frames / sample); `infeasible`
  (median plate height < 14 px over ≥ 30 min, or no reads for 6 h with
  motion); `gated` (motion_frac < 0.15); `full` otherwise. `GET /anpr/fleet`
  → items (tier, reason, yield, plate px, lat/lng, alive, priority,
  sightings_24h) + totals (+ boosted). Pursuit stub rows show as `unknown`
  until the worker reports on them. Only gated/full/unknown exercised live.
- **Console** (`FindVehicle.jsx`): legs ok navy / fast amber / impossible red
  dashed / unsnapped dotted with popups ("31 km by road · 22 min · 84 km/h"
  + reason); numbered markers, hollow near-matches; summary strip; red
  cloned card with both crops + "Trace this jump"; legs timeline (click
  zooms); playback; "Where next?" list (road km, ETA window, p, `road prior`
  vs `observed n=…`) + "Pursuit mode (15 min)" → "Priority raised on N
  cameras until HH:MM — a hit there is a lead, an officer decides."; "Fleet
  health" card (refetch 60 s). All of it works in Test data mode.
- **Demo data** (`data/tmp/seed_gis_demo.sql`, is_test only, both tenants,
  idempotent): `GJ01AB1234` GNR 06:45 → AMD 07:07 → NDD 07:43 → VAD 08:11 →
  BRC 09:01 → SUR 09:49 on 2026-08-27 (76/106/126/95/89 km/h → one amber
  `fast` leg; measured 6 points, 5 legs, 5/5 snapped, avg 98.2 km/h,
  cloned_suspect false, 4 cone candidates from SUR-KAMREJ-11); `GJ18CD7788`
  SUR 10:00 → GNR 10:12 → SUR 10:25 → AMD 10:40 → BRC 10:55 → 4 impossible
  legs (787–1,330 km/h), cloned_suspect true.
- **Endpoints** (AI; Express proxies under `/api/ai`): `GET /anpr/route/{plate}
  ?format=geojson` · `GET /anpr/cameras/{code}/next?at=` · `POST /anpr/pursuit`
  · `GET /anpr/priority` · `POST /anpr/camera-health` · `GET /anpr/fleet` ·
  `POST /anpr/transitions/refresh`.
- **Config**: AI `ROADS_PROVIDER=osrm|none`, `OSRM_URL`, `ROADS_TIMEOUT_S=6`,
  `ANPR_FAST_KMH=120`, `ANPR_MAX_KMH=150`, `ANPR_TRANSITIONS_REFRESH_MIN=60`,
  `ANPR_RETAIN_{CROPS,SNAPSHOTS,CLIPS,HIT}_DAYS` (MinIO lifecycle); worker
  `ANPR_CLIP_POLICY`, `ANPR_HEALTH_EVERY`, `ANPR_PRIORITY_POLL`,
  `ANPR_BOOST_FPS_CAP`, `ANPR_RETAIN_*` (+ `_JSON_DAYS`, `_REVIEW_DAYS`),
  `ANPR_RETENTION_DRY_RUN`.

## 6f. Indian vehicles + night reading (2026-08-28) — bikes, autos, IR

Full text: `docs/ANPR_SYSTEM.md` §3b (vehicles) and §3c (night). The short
version for a fresh session:

**The COCO problem.** `yolov8n.pt` has no auto-rickshaw class and gives
distant two-wheelers 0.2–0.4; one flat `ANPR_VEHICLE_CONF=0.35` cut them
before ByteTrack's low-score pass could hold them, and the 6.5 plate-aspect
ceiling clipped bike front strips (28.5 × 4.5 cm ≈ 6.3:1).

**Fix ladder.**
- *Tonight (done, live)*: detector at `ANPR_VEHICLE_CONF_MIN` 0.15, per-class
  floors AFTER inference — car/bus/truck 0.35 (unchanged), motorcycle
  `ANPR_MOTO_CONF` 0.18, auto/e-rickshaw/tractor/`vehicle` `ANPR_AUTO_CONF`
  0.25; every kept box → ByteTrack (`track_thresh` unchanged). Classes and
  names come from `model.names` via `vehicle_types.trackable_ids` /
  `from_detector` (COCO ids as fallback), logged once per shard as
  `vehicle classes: [2, 3, 5, 7] names: {…} (model; …)`. Sighting
  `vehicle_type` is canonical (`motorcycle`, not `bike`). Motorcycle tracks use
  `ANPR_MAX_ASPECT_MOTO` 7.0. Stats line: `plate_h_med` per type, `plateless`
  per type; health sample: `plate_h_by_type`, `plateless_by_type`.
- *This week*: `train_vehicle_detector.py` — needs the IDD Detection archive
  (46,588 images; register at idd.insaan.iiit.ac.in; layout
  `Annotations/<category>/<seq>/*.xml` + `JPEGImages/…`). Run:
  `docker run --rm --gpus all -v "$PWD/trinetra-ai/app/anpr_worker:/srv/anpr"
  -v "D:/datasets/IDD_Detection:/idd:ro" -w /srv/anpr trinetra/anpr-worker:latest
  python train_vehicle_detector.py --idd /idd --frames data/records --epochs 30`.
  Promote gate: shared classes no regression (mean AP50 within 0.02 of base on
  the same val images) AND autorickshaw AP50 ≥ 0.40 → `models/vehicle_ft.pt`
  + `.names.json`; deploy with `ANPR_VEHICLE_MODEL=/srv/anpr/models/vehicle_ft.pt`.
- *Taxonomy everywhere (done)*: `vehicle_types.py` (two identical copies).
- *VAHAN class cross-check (done, mock provider)*: `class_check` on
  `GET /anpr/vehicle/{plate}` and at ingest (cache only) → `REGISTRY
  MISMATCH` alert, severity high, lead wording; soft pairs (car↔auto,
  car↔truck) never flag.

**Policy.** car / bike / auto / bus / truck: detected, tracked, OCR.
e-rickshaw: OCR attempted, plateless is normal (still logged). tractor +
trolley: OCR attempted. tempo / goods: truck class, yellow plates. bicycle /
handcart: detected, NOT tracked, no OCR. person / rider: not a vehicle
(`rider` kept in IDD training for a later helmet check).
Synthetics: `style='painted'` (22 %) — hand-lettered autos/tempos/tractors.

**Night — what runs.** Crop side (Scenario A in `plate_enhance.candidates`):
assess (sharpness, lum, `sat_frac` glare, polarity, cepstral blur, plate-field
stats) → upscale 96 px → base = bilateral denoise (dark) → auto-gamma → CLAHE →
deskew → `inverted` (IR) → `log_clahe` (night) → `retinex` (dark/glare/flat)
→ `blackhat` (glare) → deblur variants → Scenario C `bloom_*` behind a strict
gate. NEW detector side: per camera `scene_lum` = EMA of the motion-gate
thumbnail mean; `night = scene_lum < ANPR_NIGHT_LUM` (60); `ir` = mean
|B−R| < 6; when night and `ANPR_NIGHT_DET_ENHANCE=1` BOTH detectors see a
gamma (γ = clamp(log 0.5 / log(lum/255), 0.4, 1)) + CLAHE (Y of YCrCb, 38 ms
/ 1080p) copy of the frame; crops ALWAYS from the original. Stats line
`lum= night= ir=`; health `scene_lum/night/ir/night_frac/posted_night/
review_night`; record `meta.scene`. Offline: γ 6–8 darkened frames —
corp8_30 0 → 6 vehicles, corp8_10 6 → 8, corp8_09 1 → 3; NOT yet measured
on real night traffic.

**Night — what was measured (night_report.py, 2026-08-28 00:00–05:00 IST;
host slept 04:09–10:49, fixed).** 17 reads / 402 rejects at night (4.1 %) vs
200 / 6,855 by day (2.8 %); 9 of 25 cameras "read at night" but only
corp8_10 produced a verifiably correct plate (`26BH9249H` 0.97). IR cameras
corp8_03/06/07 truncate BLOOMING plates at high confidence
(`GJ11CQ7992 → GJ11C0799` 0.91, `GJ18BY7580 → GJ18B7758` 0.70); corp8_12
collapsed a two-line yellow plate (`GJ18 / BT8415 → GJ180341` 0.58);
corp8_08/14/24's "reads" were text false positives (`BUGATTI-1` decal →
DD14000, `DELIGHT` OSD caption → DD13511, `GSRTC` lettering); 8 cameras had
night traffic and zero reads (motion smear / glare; corp8_30 rear-facing,
tail-light wash); 8 had no night data (05, 09, 15, 20, 23, 25, 26, 29).
Bloom A/B (`eval_night.py`, 120 crops): rule-valid 55/120 off AND on, gate
fired 5×, changed 1 read, helped 0 → premise (thin strokes) NOT supported;
IR failures are recogniser errors. Bloom path kept behind the strict gate
(prior 0.85, `ANPR_ENH_BLOOM=0` off). The night lever is the READER: label
night/IR reads, `ir_bloom` synthetic domain (18 %), calibrator features.
Do not claim deblurring fixed night.

**Night — filters built from the report.** Coloured-text filter
(`ANPR_PLATE_MAX_SAT` 0.45 on the glyph pixels, yellow 8–40 and the colour
cameras' blue-cast band 95–125 exempt, must be ONE colour) → `rejected_decal`;
validated on 299 confirmed crops: only BUGATTI and DELIGHT flagged. Per-camera
static-text suppressor: a plate box recurring (IoU ≥ 0.6) across ≥ 3 tracks
over ≥ 300 s with the same / no read → zone suppressed for `ANPR_STATIC_TTL`
1800 s, `rejected_static`, one log line `static text zone at x,y,wxh — '…'`;
a parked car's plate is suppressed after 5 min (accepted). Live zones:
corp8_21 ×2, corp8_11 ×2, corp8_05.

**Fleet night status.** `GET /anpr/fleet` `items[].night` (see §4 AI bullet):
night samples = worker `night` flag, else IST 19:00–06:00; status
`no night data yet` / `reads at night` / `dark — no reads at night`;
`dark_flag` + tier reason "dark after 19:00 — check IR illuminator /
exposure" when ≥ 2 h of night samples had `scene_lum < 25`, nothing posted
at night, day rate > 0. Console: Moon column + badge, "N read at night".

**Camera asks for Gujarat Police.** IR illuminator aimed at the plate zone
(gain low enough that a retro-reflective plate does not bloom); shutter
≤ 1/500 s at chokepoints; no headlight-/tail-light-facing mounts (or
polariser / ND); WDR on. Every flag is a lead, not a verdict.

## 7. Roadmap — what's left to make it beast

Done today: R2 (SR hook, measured, off), R3 (constrained decode, two-row,
deskew), R4, R5, R8 (near-match + fuzzy route), R10, R12 (geometry filters),
R13 (flywheel dirs + records), R14 (harness), VAHAN adapter, evidence clips.

**Accuracy (in order of expected gain)**
- **R1 — fine-tune the plate DETECTOR on Indian feeds** (YOLOv11n from COCO;
  research says Indian data beats adapting foreign ANPR). Data: `data/frames`,
  `data/records`, Roboflow/Kaggle Indian sets. Target: two-wheeler front
  strips, HSRP, night IR.
- **R3a — retrain the recogniser** (fast-plate-ocr CCT, 10–11 slots, Indian
  fonts, two-row) on labelled crops from the flywheel + synthetic HSRP renders
  with CycleGAN/WGAN-GP style transfer. This is the single biggest win once
  ≥ 5k labelled crops exist. Until then the constrained decoder + voting carry it.
- Plate-tuned SR (LPDGAN/CharDiff-LP style) before re-enabling `ANPR_SR_URL`.
- Calibrate `MIN_VOTES` / `MIN_AGREEMENT` per camera from the review queue.
- **Vehicle detector IDD fine-tune** (§6f): get the IDD archive, run
  `train_vehicle_detector.py`, deploy `models/vehicle_ft.pt` → real
  `autorickshaw` boxes; then re-measure `plateless_by_type` and the
  `class_check` mismatch rate.
- **Two-line yellow commercial plates**: `split_two_line` assumes similar row
  heights; a small top row (`GJ18` over `BT8415`) collapses into one wrong
  string (corp8_12 at night). Row split by profile valleys with unequal heights.
- **Night = the reader**: label the confident-wrong IR reads first; the
  `ir_bloom` synthetic domain and the calibrator's night/inverted/length
  features are the levers, not more deblurring (measured, §6f).
**Scale**
- TensorRT FP16/INT8 export (ultralytics `format=engine`), batched detection
  across cameras, N worker replicas with disjoint `ANPR_CAMERAS`.
- Decode is the real cost at 1 lakh (§6d): substream motion gating on CPU,
  NVDEC (`h264_cuvid`) in `video_source.py`, tier-driven fps from
  `camera_health`; then the Kafka `anpr.crops` consumer (nothing consumes
  Kafka today).
- Sentinel grid: read `/api/ingest` catalogue, RTSP-over-TCP (video_source
  already forces it), tracker reset on loop point (epoch mechanism exists).
**Product**
- Vehicle colour/make classifier on the vehicle box → richer BOLO; direction/
  speed from track deltas; pre-index looping feeds so a plate query is instant.

---

## 8. Open questions for Gujarat Police / Sentinel (ask before the demo)

1. **Feed quality:** what resolution/fps are the ~50 sandbox feeds and how big
   is a plate in pixels at the capture point? (Below ~12 px/char no software
   helps — we measured 7 px/char on some corp8 feeds.) Any dedicated ANPR
   (IR, high-shutter) cameras in the set?
2. **The designated plate:** will the vehicle physically pass the cameras
   during our slot, or is it inside the **looping** recorded feeds? If the
   latter, we should pre-index every loop continuously and answer from the
   index instantly.
3. **Time base:** do their feeds carry a trustworthy timestamp (OSD or RTP),
   or is "when" our ingest clock? Loop replay makes ingest time meaningless
   for a route — we need a rule for the demo.
4. **Watchlist source/format:** CSV, API, or eGujCop/CCTNS? Which fields
   (plate, reason, severity, case no.)? Do near-matches (1 char off) count as
   a hit for scoring?
5. **VAHAN / SARATHI access:** does Gujarat Police have an API Setu / NIC
   VAHAN key we can use for the sandbox, or must the demo stay on labelled
   mock data? Which owner fields may be displayed to an operator, and what is
   the audit/retention requirement (DPDP 2023)?
6. **Evidence:** is a JPEG + 10 s H.264 clip per sighting acceptable evidence,
   and how long must it be retained? Who may download it?
7. **Scoring:** is the test pass/fail on *finding the plate anywhere*, or on
   the completeness of the route (every camera it passed)? Are false
   positives penalised?
8. **Infra at the venue:** our box or theirs? GPU? Outbound internet for
   model weights (we cache everything, but confirm)? Are RTSP ports open to
   their gateway from the venue network?
9. **Plate formats in the test set:** two-wheelers (two-row), commercial
   yellow plates, BH series, non-Gujarat states, damaged/hand-painted?
10. **Compliance:** is a "lead, not verdict" workflow (human acknowledges
    every alert) acceptable, and is automated action explicitly disallowed?

---

## 9. Gotchas

- **Never put a churn folder on a Windows bind mount.** Measured 2026-08-28:
  26 ms per small-file write on `./trinetra-ai/app/anpr_worker:/srv/anpr`
  (vs 0.25 ms on the container FS), 377 s to `os.walk` the 34k files of
  `data/review`, 93 s for `data/records`. That is why `data/` is the named
  volume `drisyam_trinetra-anpr-data` and the host only gets the once-a-day
  `export/records/<date>/` copy. Code + models stay bind-mounted. Look at the
  data with `docker exec -w /srv/anpr trinetra-anpr-worker ls data/…`, not
  Explorer; the host `data/` folder is an empty placeholder (pre-migration copy:
  `data_host_backup_2026-08-28/`). Adding a new per-read file? It goes under
  `data/`, and its write goes through the DiskWriter queue, never the camera thread.
  Copying a bind-mounted tree with busybox: `cp -pR`, not `cp -a` — `-a` also
  preserves hard links by inode and the bind mount recycles inode numbers for
  files created mid-copy ("can't create link", 44 files on migration day).
  Measured: full copy 43k files ≈ 21 min, delta pass ≈ 2 min, export of one day
  (5.3k files / 378 MB) ≈ 8 min onto the bind mount.
- **PowerShell scripts must be ASCII (or UTF-8 with BOM)**: Windows PowerShell
  5.1 reads a BOM-less file as ANSI, so an em-dash or `…` inside a string
  becomes `â€"` and breaks parsing (`migrate_data_to_volume.ps1` hit this).
- **No `--reload` in the AI container** — restart `trinetra-ai` to pick up
  Python edits; the worker is bind-mounted too — `docker compose restart anpr-worker`.
  While `trinetra-ai` restarts the backend answers 500 (ECONNREFUSED) to the
  worker; the worker now retries 5xx four times with backoff.
- **Express JSON limit is 10 KB by default** (`app.js`); any new worker →
  backend JSON route carrying images needs its own limit line.
- **Thread budget matters more than the GPU**: never run numpy/torch/cv2/
  PyAV with default thread pools in a 30-thread process (`ANPR_*_THREADS`).
- **Posting thresholds**: `ANPR_MIN_CONF` 0.6 (0.75 for 8-char plates) —
  reads below go to `data/review`, not the console. Raise for the demo if the
  judges only get sharp plates; lower to see more (noisier) leads.
- **The face pipeline tries to open every corp8 camera over RTSP** every ~40 s
  (`stream open failed rtsp://trinetra-stream:8554/cam_corp8_NN`) — CPU and
  log noise; corp8 feeds are HLS-only. Disable AI/face detection on the
  corp8 cameras in the backend camera settings.
- **Plate rules live in two places** (`anpr_worker/plate_rules.py` and
  `vms_face/services/plate_rules.py`) — copy after editing.
- **`vehicle_types.py` lives in two places too** (`anpr_worker/` and
  `vms_face/services/`) — change both identically and keep
  `python vehicle_types.py` passing. Never re-implement the taxonomy locally.
- **Night pre-pass never touches the crop**: the detectors see the gamma +
  CLAHE copy, plate crops come from the original frame — do not "fix" the
  worker into cropping from `det_frame`, the OCR stack would double-process.
- **Static text zones suppress a parked car's plate after ~5 min** (it was
  read when it arrived); a zone is logged once per camera and expires after
  `ANPR_STATIC_TTL` (30 min) unless it keeps recurring.
- **`night_report.py --date` is an IST calendar date** (night = 00:00–05:59
  and 19:00–23:59 of that date); record folders are named by UTC date, so the
  script scans every folder and places files by their `ts`.
- **fast-plate-ocr v2 model is RGB** (v1 xs was grey); `plate_ocr.py` converts
  from the config — never pass BGR straight in.
- **Cepstrum trust threshold** `ANPR_ENH_MOTION_Z=3.5`: lower → more
  deconvolution attempts (and more ringing on sharp plates).
- **Real-ESRGAN endpoint refuses inputs > 512 px** (`max_side`) — crops only.
- **Snapshot relay:** `/api/person-tracker/snapshot` always says image/jpeg;
  use `/api/ai/anpr/media` (`aiService.mediaSrc`) for clips.
- Two databases: MySQL `trinetravms` (cameras/users) vs Postgres `vms_face`
  (sightings, watchlist, registry cache); join on `monitor_id` ↔ `camera_code`.
- HEVC feeds decode fine server-side; the browser may not play them.
- **ANPR data is tenant-split**: the console (org JWT) sees tenant
  `a7d3083f…`, direct dev-bypass calls to :8001 see `trinetra-default`
  `7e4edceb…`. The GIS seed writes both; a query that shows nothing is
  usually the other tenant, not a bug.
- **Public OSRM is dev-only** (rate-limited, no SLA). The breaker logs
  `road router circuit open` and legs go dotted for 120 s; for a deployment
  run `docker compose --profile roads up -d osrm` and set
  `OSRM_URL=http://osrm:5000`. Compose env changes need
  `docker compose up -d trinetra-ai` (a plain `docker restart` keeps the old env).
- `GET /anpr/fleet` lists every `camera_health` row, so the 4 test cameras a
  pursuit boosted appear as `unknown` stub rows — filter on `ts != null`
  client-side if only worker-reported cameras are wanted.
- Cone candidates may include test cameras near real ones (Adalaj corp8_12
  is 8 km from GNR-GATE-01); pass `include_test=False` to
  `camera_positions` in `predict_next` if that is unwanted.
- `seed_gis_demo.sql` re-times the NH-48 demo (VAD/BRC/SUR at 08:11/09:01/
  09:49); the original 25/22-minute legs implied ≈ 190 km/h and made the
  clean route look cloned. Revert the `retimed` CTE if the old timestamps
  matter.
- `ANPR_CLIP_POLICY=review` behaves as `hits`: a below-floor read is
  finalised only after TRACK_TTL frames, by which time the clip ring no
  longer holds it.
