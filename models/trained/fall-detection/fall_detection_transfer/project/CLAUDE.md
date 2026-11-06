# CLAUDE.md — project context for Claude Code

> If you're Claude Code reading this on a new machine: this file is your
> onboarding. It explains what this project is, how to train it, and how to fix
> the problems that actually come up. Read it fully before acting.

## What this project is

A **production-grade CCTV human fall-detection pipeline**. It detects falls from
body pose (skeleton keypoints), so it's lightweight and privacy-preserving (no
raw video leaves the box — only fall *events*).

Pipeline:
```
frame → YOLO-pose + ByteTrack (multi-person, per-person track IDs)
      → camera-invariant features (hip-centered, torso-scaled)
      → 2s sliding window → 1-D CNN classifier → P(fall)
      → per-track state machine (debounce + "stayed-down" confirm) → FALL event
```

It improves on Alam et al. (2024) "Real-Time Human Fall Detection using a
Lightweight Pose Estimation Technique" by replacing that paper's hard-coded,
camera-dependent thresholds with (a) scale/translation-invariant features and
(b) a learned temporal model — so it generalizes across camera angles and
handles crumpled/backward/seated falls and multiple people.

## The user's situation (important)

- Feature extraction (the slow step) was ALREADY DONE on a Mac. The result,
  `data_prepared/windows.npz`, was transferred here. **It is device-independent
  numeric data — training reads only this file, never the raw videos.**
- This machine is the **NVIDIA GPU PC** where the user wants to TRAIN.
- The user may NOT have the raw GMDCSA24 videos here. That's fine for training.
  They're only needed to re-extract features or to run live/video detection.

## Project layout

```
config.py                  all tunable constants (window size, thresholds, device)
requirements.txt
data_prepared/windows.npz  the prepared training data (X, y, groups) ← train reads this
src/
  pose/yolo_pose.py        YOLO-pose + ByteTrack backend (auto-picks cuda/mps/cpu)
  pose/factory.py, base.py
  features/normalize.py     camera-invariant per-frame features (39 dims)
  features/windows.py       sliding-window builder
  data/prepare_dataset.py   videos → windows (only needed to RE-extract)
  data/gmdcsa24.py          GMDCSA24 dataset adapter (builds data_raw/ + annotations.csv)
  data/datasets.py          dataset links + expected layout
  model/model.py            temporal 1-D CNN (PyTorch)
  model/train.py            training loop + metrics ← main training entrypoint
  model/export_onnx.py      Keras-free ONNX export for serving
  engine/detector.py        per-track fall state machine (runtime brain)
  engine/run_video.py       run on a video/RTSP, annotate, log events
tests/smoke_test.py         end-to-end check with synthetic data (no GPU/data needed)
docs/TRAIN_ON_GPU.md        the training handoff guide
docs/DEPLOY.md              Phase-2 production services blueprint (RTSP, dashboard)
```

## The data: `data_prepared/windows.npz`

- `X`: float32 `(N, 30, 39)` — N windows, 30 frames each (2s @ 15fps), 39 features/frame.
- `y`: float32 `(N,)` — 1 = fall window, 0 = normal.
- `groups`: `(N,)` — subject id (`s1`..`s4`) used to split by PERSON.
- Built from GMDCSA24 (Alam et al. 2024, v2.0): 4 subjects, 160 videos,
  ~2993 windows (~953 fall / ~2040 normal). Single-person dataset.

## PRIMARY TASK: train the model

```bash
# 1. env
python3 -m venv venv
./venv/bin/pip install -r requirements.txt          # Windows: venv\Scripts\pip

# 2. install a CUDA build of torch matching the machine's CUDA (example: cu121)
./venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu121

# 3. verify GPU
./venv/bin/python -c "import torch; print('cuda:', torch.cuda.is_available())"

# 4. train
./venv/bin/python -m src.model.train --data data_prepared/windows.npz --out models/fall_cnn.pt
```

Training trains on 3 subjects, validates on the held-out 4th (generalization to
an unseen person), handles class imbalance, and prints per epoch:
`sens` (sensitivity/recall of falls — the key metric, paper got ~0.94),
`spec`, `prec`, `f1`. Best-sensitivity checkpoint saves to `models/fall_cnn.pt`.

Sanity-check the wiring anytime (no GPU/data needed):
```bash
./venv/bin/python -m tests.smoke_test
```

## TROUBLESHOOTING (the problems that actually occur)

**`torch.cuda.is_available()` is False / "Invalid CUDA device=0"**
The installed torch is CPU-only. Reinstall the CUDA wheel for this machine's CUDA
version (cu118 / cu121 / cu124 — check with `nvidia-smi`, top-right CUDA version):
`./venv/bin/pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu121`
The code auto-falls back to CPU if no GPU, so training still runs, just slower.

**Windows paths** — use `venv\Scripts\python.exe -m src.model.train ...`
(not `./venv/bin/python`). Run commands from the project root.

**`ModuleNotFoundError: No module named 'src'`** — run from the project root
directory, and always via `-m` (e.g. `python -m src.model.train`), not by path.

**ultralytics complains about `lap`** — it auto-installs it; if offline,
`pip install lap` (it's already in requirements.txt).

**Headless Linux server: cv2 / `imshow` errors** — don't use `run_video --show`
(needs a display). Use `--out annotated.mp4` to write a file instead. For a pure
headless box, `pip install opencv-python-headless` instead of `opencv-python`.

**Out of GPU memory during training** — lower `BATCH_SIZE` in `config.py`
(try 32 or 16). This model is tiny, so OOM usually means something else is on the GPU.

**Loss becomes NaN** — lower `LEARNING_RATE` in `config.py` (e.g. 5e-4).

**Want to RE-extract windows** (needs raw videos on this machine) —
`python -m src.data.gmdcsa24 --root <GMDCSA24 folder>` then
`python -m src.data.prepare_dataset --raw data_raw --out data_prepared`.

**Want to test detection on a video after training** — you need a video file
here: `python -m src.engine.run_video --video clip.mp4 --model models/fall_cnn.pt --out out.mp4`.

## Known limitations / next steps (if the user asks to improve accuracy)

- GMDCSA24 is single-person. The engine is multi-person (runs the classifier per
  tracked person), but for best multi-person CCTV accuracy, add multi-person /
  varied-angle data (Le2i, UP-Fall — links in `src/data/datasets.py`) and retrain.
- Production services (RTSP workers, FastAPI, web dashboard, Docker) are designed
  but NOT built yet — see `docs/DEPLOY.md` for the blueprint (Phase 2).
- For serving at scale: TensorRT-export YOLO-pose (`yolo export model=yolov8s-pose.pt
  format=engine`) and ONNX-export the classifier (`src/model/export_onnx.py`).

## Conventions

- Single DL framework: **PyTorch** (YOLO-pose is torch-based; no TensorFlow).
- All tunables live in `config.py` — change them there, not scattered in code.
- `POSE_BACKEND="yolo"` and `YOLO_DEVICE=0` (CUDA) are the production defaults;
  device auto-resolves to mps/cpu when CUDA is absent.
