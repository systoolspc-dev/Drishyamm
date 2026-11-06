# CCTV Fall Detection — Production Pipeline

A **production-grade human fall-detection system for CCTV**: multi-person,
multi-camera (RTSP), GPU-served, with a web dashboard for alerts.

Built on the core idea from Alam et al. (2024) — detect falls from body
keypoints so it's lightweight and privacy-preserving — but re-engineered for
real CCTV and to fix that paper's two fatal weaknesses:

| Paper's weakness | Our fix |
|---|---|
| Hard-coded, camera-dependent thresholds (break in a new room/angle) | **Scale/translation-invariant features** (center on hips, scale by torso) |
| Judges a single frame's pose | **Temporal 1-D CNN** over a ~2s window — a fall is *motion*, not a pose |
| Only flat sideways falls | Learns crumpled / seated / backward falls from data |
| Confuses "lying down on purpose" with a fall | **"Stayed-down" confirmation** state machine + learned dynamics |
| Single subject only | **YOLO-pose + ByteTrack** — every person tracked & judged independently |

## Architecture

```
 Camera(s) RTSP ─► YOLO-pose + ByteTrack ─► per-person feature window
                   (multi-person, IDs)       (scale/translation invariant)
                        │                              │
                        ▼                              ▼
                 per-track state           1-D CNN classifier ─► P(fall)
                 machine (debounce +               │
                 stayed-down) ◄────────────────────┘
                        │
                        ▼
                  FALL event ─► snapshot/clip ─► web dashboard + alert
```

## Two-phase plan

**Phase 1 — detection engine (this repo, DONE & runnable):**
YOLO-pose → tracking → per-person temporal classifier → fall state machine,
validated on video files with an annotated output + JSON event log.

**Phase 2 — production services (next):** RTSP stream workers (1/camera),
event store (Postgres), clip storage, web dashboard, alerting, Docker Compose.
See `docs/DEPLOY.md`.

## Install (venv)

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## Quickstart

```bash
# 0. sanity check the whole chain (no data/GPU needed)
./venv/bin/python -m tests.smoke_test

# 1. see pose+tracking on any video, no trained model yet
./venv/bin/python -m src.engine.run_video --video clip.mp4 --pose-only --out annotated.mp4
```

## Full training pipeline

```bash
# 2. lay out datasets:  data_raw/fall/*.mp4  data_raw/adl/*.mp4
#    optional annotations.csv:  video,fall_start_sec,fall_end_sec
#    (dataset links in src/data/datasets.py — URFD, Le2i, UP-Fall, GMDCSA)

# 3. videos -> labeled temporal windows
./venv/bin/python -m src.data.prepare_dataset --raw data_raw --out data_prepared

# 4. train the classifier (reports sensitivity/specificity/precision/F1)
./venv/bin/python -m src.model.train --data data_prepared/windows.npz

# 5a. run the full detector on a video / RTSP url
./venv/bin/python -m src.engine.run_video --video clip.mp4 --out annotated.mp4
./venv/bin/python -m src.engine.run_video --video "rtsp://user:pass@cam/stream" --show

# 5b. export for the GPU server (ONNX / TensorRT)
./venv/bin/python -m src.model.export_onnx --model models/fall_cnn.pt
yolo export model=yolov8s-pose.pt format=engine   # YOLO -> TensorRT
```

## GPU server notes
- On the server, install a **CUDA** build of torch (this dev venv is CPU/MPS).
- Set `YOLO_DEVICE=0` (or the CUDA index) in `config.py`.
- For throughput at scale: TensorRT-export YOLO-pose, and one stream worker per
  camera feeding a shared inference process (Phase 2).

## Project layout
```
config.py                    all tunable constants
src/
  pose/base.py               multi-person tracked-pose contract
  pose/yolo_pose.py          YOLO-pose + ByteTrack backend (default)
  pose/factory.py            backend selector
  features/normalize.py      camera-invariant features  ← the key upgrade
  features/windows.py        sliding-window builder
  data/datasets.py           dataset registry + links + expected layout
  data/prepare_dataset.py    videos -> labeled windows
  model/model.py             temporal 1-D CNN classifier (PyTorch)
  model/train.py             training + medical metrics
  model/export_onnx.py       Keras-free ONNX export for the server
  engine/detector.py         per-track state machine (the runtime brain)
  engine/run_video.py        run on video/RTSP, annotate, log events
tests/smoke_test.py          end-to-end check with synthetic data
```
