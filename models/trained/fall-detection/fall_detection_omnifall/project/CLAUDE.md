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

## Current validated performance

`models/fall_cnn.pt` = the COMBINED model (GMDCSA + VideoDataset, 33 subjects,
multi-view), trained with augmentation, **s2 held out** for validation. State
machine tuned for it: `FALL_PROB_THRESHOLD=0.8, CONFIRM_SECONDS=1.0,
CONFIRM_FRACTION=0.7`.

Real-engine, held-out:
- **GMDCSA s2** (long clips, event-level): sens **0.920**, spec **0.826** (23/25
  falls, 4 FP/23 ADL).
- **VideoDataset v10** (unseen multi-view subject, window-level): sens **0.977**.
  NOTE: VideoDataset clips are ~1.9s — too short for event-level (the engine
  needs ~warmup 1.6s + confirm 1.0s of continuous video), so window-level is the
  right metric there. Real CCTV streams are continuous, so this is not a
  deployment limitation.

BENDING-FALSE-POSITIVE FIX (engine-side, no retrain): `is_grounded()` in
normalize.py + a "grounded gate" in detector.py veto a fall unless the LEGS are
horizontal (body on the ground). Someone bending/shoveling keeps legs vertical,
so it no longer false-fires. Verified on real clips: shoveling 5 FP -> 0, real
falls still detected, held-out s2 unchanged (0.920/0.826). Knobs:
`LEG_VERTICAL_MAX_ANGLE`, `GROUNDED_FRACTION` in config.py.

Trade-off vs the old GMDCSA-only model (0.920/0.870 on s2): same sensitivity,
slightly lower s2 specificity, but gains real multi-angle robustness the
single-view model lacked. The combined model is "eager" (high prob readily) due
to VideoDataset's whole-clip labels — hence the 0.8 fire threshold.

NEXT gain: use the VideoDataset wearable-IMU acceleration spike to label only the
actual fall frames (not the whole ~1.9s clip). Cleaner labels -> less eager model
-> higher specificity. For a FINAL deployment model, retrain WITHOUT `--holdout`
to use all subjects.

## Datasets & adapters

Two datasets are wired in via adapters that build the `data_raw/{fall,adl}/`
symlink layout + merge `annotations.csv` (subject-prefixed names so training can
hold out whole subjects):
- **GMDCSA24** (`src/data/gmdcsa24.py`): 4 subjects (`s1`-`s4`), long clips
  (4-12s), frame-accurate fall intervals. Single view.
- **VideoDataset** (`src/data/videodataset.py`): ~29 subjects (`v01`-`v29`),
  4 camera views (F/B/L/R), 4 locations, ~2000 short (~1.9s) clips, whole-clip
  fall labels. Adds the camera-angle/subject diversity GMDCSA lacks.
- **OmniFall** (`src/data/omnifall.py`): re-annotates 8 staged datasets + a real
  in-the-wild set (`of-itw` = OOPS) with a 16-class temporal taxonomy that
  separates `fall` from `squat`/`kneel`/`sit`/`lie`/`fallen`. This is the
  DATA-DRIVEN fix for the bent-forward / squat / occluded-legs false positives
  (we deliberately did NOT hard-code more geometry). Adapter maps `fall`(1) →
  positive, all other states → hard negatives; groups per-dataset by scene
  (`mcfdN`/`le2iN`/`cmdN`/`edfN`/`occuN`/`itwN`) to prevent train/val leakage.
  HF holds annotations only — videos come from each source (see docs/OMNIFALL.md).
  Needs `pip install datasets` (in requirements.txt). **Full runbook:
  docs/OMNIFALL.md** — train on staged configs, validate honestly on `of-itw`.
  `prepare_dataset` now supports multiple fall intervals per video (OmniFall
  clips contain several falls); backward compatible with GMDCSA/VideoDataset.

ONE-COMMAND path (adapters → prepare → train, skips missing datasets):
```
python -m src.run_pipeline --omnifall-videos <VID> --configs le2i,mcfd --holdout s2
# add --gmdcsa/--videodataset if present, --fetch-oops for in-the-wild eval
```
`src/model/eval_npz.py` scores any windows.npz (used for the of-itw wild test).

Combine them manually (run BOTH adapters into one `data_raw`, GMDCSA first):
```
python -m src.data.gmdcsa24    --root <GMDCSA root>       --out data_raw --annotations annotations.csv
python -m src.data.videodataset --root <VideoDataset root> --out data_raw --annotations annotations.csv
python -m src.data.prepare_dataset --raw data_raw --out data_prepared_combined --annotations annotations.csv
python -m src.model.train --data data_prepared_combined/windows.npz --out models/fall_cnn.pt --holdout s2
```
`--holdout s2` forces GMDCSA subject 2 into validation so the new model's
held-out s2 numbers are directly comparable to the current model's 0.920. Try
`--holdout v10` too to check a held-out VideoDataset (multi-view) subject.
NOTE: `WINDOW_SIZE=24` (1.6s) so the model fits VideoDataset's ~1.9s clips. The
model is sequence-length-agnostic (Conv1d + adaptive pool), so a window change
doesn't break loading, but re-extract + retrain for correctness after changing it.

## The data: `windows.npz`

Shape: `X` float32 `(N, 24, 39)` (24 frames = 1.6s @ 15fps, 39 features/frame);
`y` `(N,)` 1=fall/0=normal; `groups` `(N,)` = subject id, split by PERSON.

- **`data_prepared_combined/windows.npz`** — CURRENT training set. GMDCSA24 +
  VideoDataset combined: **9,271 windows (3,608 fall / 5,663 normal), 33 subjects**
  (`s1`-`s4`, `v01`-`v29`), multi-view. This is what to train on now.
- `data_prepared/windows.npz` — older GMDCSA-only set (was `(N,30,39)`); the
  current `models/fall_cnn.pt` (0.920 s2 sensitivity) was trained from it.
  Superseded by the combined set once the combined model is trained + validated.

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
