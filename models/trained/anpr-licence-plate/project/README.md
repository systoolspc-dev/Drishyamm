# anpr_worker — live number-plate reader

## Purpose

Reads number plates from the live camera feeds on the server and turns each
confirmed plate into a sighting in the AI service, which runs the existing
sighting → watchlist → alert → Find a Vehicle route spine. A read is a lead for
an officer, never a verdict: every sighting carries its confidence, its tier
(`confirmed` or `possible`), the plate crop, a snapshot and usually a short
H.264 clip.

Per camera, one thread (see the docstring at the top of `worker.py`):

```
video (RTSP/HLS/file, newest frame only)         video_source.py
 -> fps cap + motion gate
 -> vehicle detect (YOLOv8n) + ByteTrack ids     bytetrack_lite.py, vehicle_types.py
 -> plate detect (models/best.pt or best_ft.pt) + geometry / colour / burn-in filters
 -> assess crop (blur, night, glare) -> restored variants      plate_enhance.py
 -> OCR every variant in one batch, per-slot distributions      plate_ocr.py
 -> Indian-plate format decode + rules                          plate_rules.py, plate_formats.json
 -> per-track, per-character weighted vote across frames        plate_votes.py
 -> confirm (votes + agreement gates) or 'possible' tier or review queue
 -> POST /api/ai/anpr/sighting, then clip/snapshot media        clip_recorder.py
```

This folder also holds the retraining loop (`auto_retrain.py` and friends), the
evaluation scripts, and `rehearsal.py`, which runs the judge tasks against the
live stack.

The long-form handbook is [CONTEXT.md](CONTEXT.md) in this folder and
[trinetra-ai/docs/ANPR_SYSTEM.md](../../docs/ANPR_SYSTEM.md); the judge playbook
is [trinetra-ai/docs/JUDGE_TASKS.md](../../docs/JUDGE_TASKS.md). Some details
there are dated (for example, they describe the provider feeds as HLS-only;
`stream_for()` in `worker.py` now reads them over RTSP).

## How it runs

| | `anpr-worker` | `anpr-trainer` |
|---|---|---|
| Container | `trinetra-anpr-worker` | `trinetra-anpr-trainer` |
| Image | `trinetra/anpr-worker:latest` from `Dockerfile` (`FROM drisyam-face-reconstruct:latest` + ultralytics, fast-plate-ocr, imageio-ffmpeg, optional PyAV) | `trinetra/anpr-train:latest` from `Dockerfile.train` (adds Keras/TensorFlow) |
| Command | `python worker.py` | `python auto_retrain.py` |
| Working dir | `/srv/anpr` | `/srv/anpr` |
| Volumes | `./trinetra-ai/app/anpr_worker:/srv/anpr` (code + models), named `trinetra-anpr-data:/srv/anpr/data`, `./export:/srv/anpr/export` | same three |
| GPU | yes | yes, plus `cpus: 8`, `shm_size: 2gb` |
| Ports | none | none |

Code and models are bind-mounted: restart the service to pick up an edit
(`docker compose restart anpr-worker`); rebuild only when dependencies change.
Promoted models are hot-swapped by the worker within about a minute.

## Configuration

All `ANPR_*` environment variables; the complete list with defaults is the
docstring at the top of `worker.py`, and the values in use are in the
`anpr-worker` block of `docker-compose.yml`. The ones that matter most:

| Variable | Meaning |
|---|---|
| `ANPR_BACKEND_URL` | Backend base (`http://trinetra-backend:5000`) |
| `ANPR_EMAIL`, `ANPR_PASSWORD` | Console account the worker logs in as; sightings belong to its org |
| `SERVICE_TOKEN`, `ANPR_OVERLAY` | Live boxes to `/api/internal/ai/overlay` (off without the token) |
| `ANPR_CAMERAS` | CSV of monitorIds to read; empty = every camera with plate reading on |
| `ANPR_CAMERA_PREFIXES` | Optional fence by monitorId prefix |
| `ANPR_SOURCES` | Extra `name=url` sources read in addition (compose adds `demo_recorded`) |
| `ANPR_SOURCE_VIA_MEDIAMTX` | `1` = read provider cameras through the media server's `cam_<id>` path (default `0`) |
| `MEDIAMTX_RTSP_BASE` | Media server RTSP base (`rtsp://trinetra-stream:8554`) |
| `CORP8_RTSP_HOST`, `CORP8_RTSP_PORT`, `CORP8_RTSP_USER`, `CORP8_RTSP_PASS` | Provider grid RTSP endpoint and account (credentials are redacted from logs) |
| `ANPR_MAX_CAMERAS` | Per-node camera budget; cameras beyond it are logged by name and not read |
| `ANPR_SHARD` | `k/n` slice for horizontal scale: cameras are assigned by a stable hash of the monitorId |
| `ANPR_PROCESSES` | Processes per container (each loads its own models) |
| `ANPR_MATH_THREADS`, `ANPR_CV_THREADS`, `ANPR_TORCH_THREADS`, `ANPR_OCR_THREADS`, `ANPR_DECODE_THREADS` | Thread budgets (set before numpy/torch import) |
| `ANPR_TARGET_FPS`, `ANPR_MOTION_GATE` | Detection rate per camera, skip static frames |
| `ANPR_MIN_VOTES`, `ANPR_MIN_AGREEMENT`, `ANPR_MIN_CONF` | Confirm gates |
| `ANPR_POSSIBLE*`, `ANPR_CONFIRM_2FRAME_WEIGHT`, `ANPR_MERGE_WINDOW`, `ANPR_LEN_SWITCH*`, `ANPR_SHORT_CONFIRM_*` | Recall tiers and the 9/10-character rules |
| `ANPR_VEHICLE_CONF_MIN`, `ANPR_MOTO_CONF`, `ANPR_AUTO_CONF`, `ANPR_MAX_ASPECT_MOTO` | Per-class vehicle floors (two-wheelers, autos) |
| `ANPR_NIGHT_LUM`, `ANPR_NIGHT_DET_ENHANCE`, `ANPR_PLATE_MAX_SAT`, `ANPR_STATIC_TTL` | Night pre-pass, coloured-text and burn-in filters |
| `ANPR_PLATE_MODEL`, `ANPR_OCR_MODEL_DIR`, `ANPR_ENGINE`, `ANPR_DEVICE`, `ANPR_HALF` | Models and inference engine (`auto` / `torch` / `onnx`) |
| `ANPR_ROI_FILE` / `ANPR_ROI` | Per-camera plate region; `data/calibration/roi.json` is re-read within 30 s |
| `ANPR_CLIPS`, `ANPR_CLIP_*`, `ANPR_CLIP_POLICY` | Evidence clip size, rate and which reads get one (`all` / `hits` / `review`) |
| `ANPR_REVIEW_POLICY`, `ANPR_REVIEW_*`, `ANPR_WRITE_QUEUE` | Review-file policy and the disk-writer queue |
| `ANPR_RETAIN_*`, `ANPR_RETENTION_DRY_RUN`, `ANPR_EXPORT_DIR`, `ANPR_EXPORT_HOUR_IST` | Retention sweep and daily export to the host |
| `ANPR_SR_URL` | Real-ESRGAN upscale endpoint for tiny crops (off; measured no gain) |
| `ANPR_HEALTH_EVERY`, `ANPR_PRIORITY_POLL` | Camera-health report and pursuit-priority poll intervals |
| `ANPR_DRY_RUN` | Read and log without posting (used by tests) |

Trainer: `ANPR_TRAIN_CHECK_MIN`, `ANPR_TRAIN_INTERVAL_H`, `ANPR_TRAIN_MIN_SAMPLES`,
`ANPR_TRAIN_NEW_LABELS`, `ANPR_TRAIN_VAL_TARGET`, `ANPR_TRAIN_AUTO_MAX_SHARE`,
`ANPR_TRAIN_EPOCHS`, `ANPR_TRAIN_DET_MIN_IMAGES`, `ANPR_AUTO_LABELS`,
`ANPR_AUTO_LABEL_MIN_FRAMES`, plus TensorFlow GPU variables (`XLA_FLAGS`,
`LD_LIBRARY_PATH`, `TF_FORCE_GPU_ALLOW_GROWTH`).

## Interfaces

Calls to the backend (`ANPR_BACKEND_URL`):

| Call | Purpose |
|---|---|
| `POST /api/auth/login` | Get a JWT for `ANPR_EMAIL` (rate-limited; the worker backs off) |
| `GET /api/cameras/geo` | Camera list with coordinates and the `anprEnabled` switch |
| `POST /api/ai/anpr/sighting` | Post a confirmed or possible read |
| `POST /api/ai/anpr/sighting/{id}/media?kind=clip\|plate\|snapshot` | Attach evidence |
| `POST /api/ai/anpr/camera-health`, `GET /api/ai/anpr/priority` | Fleet health report; pursuit-boosted cameras |
| `GET /api/internal/cameras`, `POST /api/internal/ai/overlay` | Camera owners; live boxes for the Live Plate Reading page (service token) |
| `POST /api/upscale` on face-reconstruct | Only when `ANPR_SR_URL` is set |

Trainer: `POST /api/ai/anpr/labels/auto`, `GET /api/ai/anpr/labels/stats`,
`GET /api/ai/anpr/labels/export`, `GET /api/ai/anpr/media`; it writes
`data/train/status.json`, which the AI service serves at `/anpr/training/status`.

Video sources (`stream_for()` in `worker.py`):

- `corp8_NN` provider cameras: direct RTSP to the provider grid
  (`CORP8_RTSP_HOST`, path `/stream/camNN`), or `cam_corp8_NN` on the media
  server when `ANPR_SOURCE_VIA_MEDIAMTX=1`.
- Every other camera: the media server's passthrough path
  `rtsp://trinetra-stream:8554/cam_<monitorId>`.
- `ANPR_SOURCES` entries: the given URL (compose: `demo_recorded`).

Files (on the `trinetra-anpr-data` volume, `/srv/anpr/data`): `records/<date>/<camera>/`
(snapshot, plate crop, JSON, MP4 per read), `review/<date>/`, `confirmed/`,
`outbox/` (unsent sightings), `train/`, `reports/` (rehearsal transcripts),
`calibration/roi.json`. Once a day `export_records.py` copies a day of records
to `./export/records/<date>/` on the host.

## Code layout

| Path | Responsibility |
|---|---|
| `worker.py` | The live pipeline, gates, sender/outbox, overlay publisher, health and priority threads, sharding |
| `video_source.py` | Decoder chain (PyAV → static ffmpeg → OpenCV), newest-frame-only, corrupt-frame gate |
| `bytetrack_lite.py` | Self-contained ByteTrack (Kalman + IoU association) |
| `plate_enhance.py` | Crop assessment and restoration variants (deblur, night, glare, deskew) |
| `plate_ocr.py` | fast-plate-ocr ensemble (stock + fine-tuned reader), constrained decode |
| `plate_rules.py`, `plate_formats.json` | Indian plate formats, state codes, validation and correction |
| `plate_votes.py` | Per-track, per-character vote |
| `plate_verify.py`, `calibrator.py` | Independent string-vs-pixels check; learned confidence |
| `vehicle_types.py` | Canonical vehicle classes and per-class floors |
| `clip_recorder.py` | Rolling frame buffer and H.264 evidence clips |
| `model_registry.py`, `models/` | Which weights produced a read (`MODEL_REGISTRY.json`); `best.pt`, `best_ft.pt`, `yolov8n.pt`, `ocr/`, `ocr_base/` |
| `yolo_onnx.py`, `anpr_engine.py` | ONNX detector path; the pipeline as an importable generator |
| `retention.py`, `export_records.py` | Retention sweep, daily host export |
| `auto_retrain.py`, `auto_labels.py`, `export_labels.py`, `train_ocr.py`, `train_detector.py`, `train_vehicle_detector.py`, `train_calibrator.py` | Retraining loop; promotes a model only if it beats the current one on held-out officer-labelled crops |
| `eval_*.py`, `abl*.py`, `acc_by_model.py`, `anpr_metrics.py`, `funnel_ab.py`, `bench_gpu.py`, `night_report.py`, `run_experiment.py`, `experiments/` | Evaluation, ablations, GPU benchmark, measurement records |
| `collect_crops.py`, `synth_plates.py`, `build_plate_dataset.py` | Dataset harvesting and synthesis |
| `rehearsal.py` | Judge tasks against the live stack; exits 1 if any task fails |
| `probe_hls.py` | Which decode path works for a given URL |
| `tests/` | pytest for pure logic (no models, no backend) |

## Common tasks

- Run the tests: `docker exec -w /srv/anpr trinetra-anpr-worker python -m pytest tests -q`
- Rehearse the judge tasks: `docker exec -w /srv/anpr trinetra-anpr-trainer python rehearsal.py`
  (`--no-alert` for a read-only pass, `--reset` to put demo rows back). Run it
  in the trainer, never the worker.
- Read one feed without posting:
  `docker run --rm --gpus all -v "$PWD/trinetra-ai/app/anpr_worker:/srv/anpr" -w /srv/anpr -e ANPR_DRY_RUN=1 -e ANPR_MAX_CAMERAS=1 -e "ANPR_SOURCES=<name>=<url>" trinetra/anpr-worker:latest python -u worker.py`
- Look at stored data: `docker exec -w /srv/anpr trinetra-anpr-worker ls data/records`
  (the host `data/` folder is an empty placeholder).
- Change plate formats or rules: edit `plate_rules.py` here and
  `vms_face/services/plate_rules.py` identically; same for `vehicle_types.py`.

## Gotchas

- Never put a high-churn folder on the Windows bind mount (26 ms per small
  write measured). New per-read files go under `data/` and through the
  DiskWriter queue, not the camera thread.
- Set thread budgets before numpy/torch/cv2 import; default pools in a
  30-thread process burned 1000 %+ CPU with the GPU at 17 %.
- Use fast-plate-ocr v2 models (10 output slots). The v1 models have 9 slots and
  silently truncate 10-character Indian plates. The v2 model takes RGB.
- The night pre-pass only changes what the detectors see; crops come from the
  original frame. Do not crop from the enhanced frame.
- Static-text suppression hides a parked car's plate after a few minutes; it
  expires after `ANPR_STATIC_TTL`.
- `ANPR_CLIP_POLICY=review` behaves as `hits`: by the time a below-floor read is
  finalised the clip buffer no longer holds it.
- Reads from `demo_recorded` are real plates at a false time and place, so they
  are posted flagged as test and never enter a real vehicle history.
- While `trinetra-ai` restarts, the backend answers 5xx; the worker retries
  with backoff and keeps unsent sightings in `data/outbox/`.
- Raising `ANPR_MAX_CAMERAS` past what one GPU serves reads every camera worse;
  scale out with more workers and `ANPR_SHARD`.
