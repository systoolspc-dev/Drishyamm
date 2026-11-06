# Fall detection (pose-based, in-house) - study guide

Three snapshots of one in-house project: a CCTV human-fall detector that runs
YOLOv8s-pose with ByteTrack, turns each tracked person's 17 keypoints into 39
camera-normalised features per frame, classifies a 24-frame window with a tiny
1-D CNN (66,625 parameters), and decides per track with a fraction-based state
machine. Paths below are relative to `<variant>/project/` unless they start with
`C:\projects\`.

## 1. What it does / status

- **Output**: a `FallEvent(track_id, time_sec, bbox)` per tracked person,
  raised on the NORMAL -> FALL transition (`src/engine/detector.py:FallEngine.process`).
- **Status**: Phase-1 research engine only, run on a file or RTSP URL via
  `src/engine/run_video.py:main`. The Phase-2 services in `docs/DEPLOY.md`
  (stream workers, FastAPI, Postgres, dashboard) were never built.
- **Not integrated into Drishyam**: grepping `smart-cam-ai` and the backend for
  `fall_cnn|FallEngine|fall_detection|FallCNN` finds only the unrelated
  `vms_face/alembic/versions/0005_footfall.py`. No event type, container or UI.
- **Runtime default** in all variants is `models/fall_cnn.pt`
  (`config.py:FALL_CLASSIFIER_PATH`). v2 was never promoted:
  `GIVE_THIS_TO_CLAUDE.md` section 4 says "Do NOT promote it to fall_cnn.pt yet"
  until it passes a re-check on the Mac sample clips.

## 2. Variants compared

| | `fall_detection_transfer` | `fall_detection_omnifall` | `fall_detection_v2_gpu` |
|---|---|---|---|
| Last code/model change | 2026-07-14 12:13 | 2026-07-16 15:18 (v1 model), 07-18 edits | **2026-07-17 10:45 (newest)** |
| Shipped checkpoints | `fall_cnn.pt` (GMDCSA-only) | `fall_cnn.pt` (combined), `fall_cnn_omnifall.pt` (v1) | `fall_cnn.pt` (combined, byte-identical weights to omnifall's), `fall_cnn_omnifall_v2.pt` (v2) |
| Window | 30 frames (2.0 s), stride 5 | 24 frames (1.6 s), stride 3 | 24 / 3 |
| Training data | GMDCSA24 only, 2,993 windows, 4 subjects | + VideoDataset, Le2i, MCFD: 28,958 windows, 190 groups | + OOPS train split: 34,817 windows, 300 groups |
| State machine | debounce + "stay horizontal" (`is_horizontal`), CANDIDATE state | fraction-based + grounded (legs) gate + IoU track hand-off | same as omnifall |
| Augmentation / `--holdout` | no / no (random `GroupShuffleSplit`) | yes / yes | yes / yes |
| OOPS handling | n/a | eval only (`run_pipeline --fetch-oops`) | 70/30 scene split: train as positives, val held out (`src/data/omnifall.py:_in_part`) |
| Known defects | - | `src/run_pipeline.py` line 1 truncated -> `IndentationError` (does not parse) | `prepare_dataset.py` lacks the `cv2.setNumThreads(0)` crash fix the omnifall copy has |

**Which is newest, which is best.** `fall_detection_v2_gpu` is the newest, and
its code is a superset of omnifall's (it adds the OOPS train/val split; both
add `eval_npz`, `--holdout` and augmentation over transfer). Use it as the code
base. No checkpoint wins on every axis (section 9): v2 fixes v1's seated /
hands-and-knees blind spot, but at the deployed 0.8 threshold it is *less*
sensitive on held-out wild OOPS windows than the older combined `fall_cnn.pt`
(0.425 vs 0.524). Pick a checkpoint only after an event-level engine run on the
CCTV clips you care about.

## 3. Pipeline call path

```
run_video.py:main                      cv2.VideoCapture; resample to TARGET_FPS by index skipping
  -> pose/factory.py:get_pose_estimator("yolo") -> pose/yolo_pose.py:YoloPoseEstimator
  -> YoloPoseEstimator.track(frame)    model.track(persist=True, tracker=bytetrack.yaml, conf=0.4)
                                       returns TrackedPose(track_id, kps(17,3) y,x,score in [0,1], bbox)
  -> engine/detector.py:FallEngine.process(poses, t_sec)       per track:
       IoU hand-off of lost track state (IoU>0.4, lost <=1.5 s)
       features/normalize.py:extract_features(kps) -> (39,) appended to deque(maxlen=24)
       FallEngine._classify -> sigmoid(FallCNN(window[None]))  (0.0 until 24 frames seen)
       prob_hist.append((t, prob, normalize.py:is_grounded(kps)))
       FallEngine._fallish_fraction -> (frac>=0.8, grounded frac, have_full)
       NORMAL->FALL emits FallEvent; FALL->NORMAL when frac<=0.25
  -> run_video.py:_draw + events.json
```

Training path: `src/run_pipeline.py:main` runs the adapters (`src/data/gmdcsa24.py`,
`videodataset.py`, `omnifall.py`), then `src/data/prepare_dataset.py:main`, then
`src/model/train.py:main`, then optionally `src/model/eval_npz.py:main`.

## 4. Pre-processing

- **Frame rate**: decimated to `TARGET_FPS = 15` by index skipping, identically
  in `run_video.py:main` and `prepare_dataset.py:_frame_features`; a 0
  `CAP_PROP_FPS` falls back to 15, so a wrong RTSP FPS silently rescales time.
- **Pose**: stock Ultralytics `yolov8s-pose.pt` (verified with torch.load:
  11,626,046 params, COCO-pose, `imgsz 640`, ultralytics 8.0.77 build,
  2023-04-17). `yolo_pose.py:track` passes no `imgsz`, so inference runs at
  Ultralytics' default of 640. Keypoints are divided by frame H and W
  separately.
- **Features** (`normalize.py:extract_features`, `N_FEATURES = 39`): [0:34] 17
  keypoints (x, y), centred on the mid-hip and divided by torso length
  (mid-shoulder to mid-hip, `_body_center_and_scale`; falls back to keypoint
  spread), keypoints with conf < 0.3 (`KP_CONF_THRESHOLD`) zeroed; [34,35] sin/cos
  of the trunk angle from vertical (`trunk_angle_deg`); [36] width/height aspect
  of the valid keypoints; [37] hip vertical position in frame (0 = top, NOT
  camera-invariant); [38] mean keypoint confidence.
- **Windows** (`features/windows.py:make_windows`): (T, 39) becomes (N, 24, 39)
  with stride 3 at training time. A window is labelled 1 if *any* frame in it is
  a fall frame. At runtime the deque slides by 1, so the CNN runs on every frame
  of every track.
- **Frame labels** (`prepare_dataset.py:_labels_for`): each annotated fall
  interval plus a `CONFIRM_SECONDS` tail (1.0 s v2, 2.0 s transfer) is fall; an
  unannotated fall clip is fall in full (VideoDataset ~1.9 s clips, by design).
- **Training extracts only the largest person per frame**
  (`prepare_dataset.py:_largest`) and repeats the last features when nobody is
  detected. Runtime is per track and appends nothing on a miss: train/serve skew.

## 5. Model, input tensor, runtime

`src/model/model.py:FallCNN` is identical in all three variants. Input
`(batch, 24, 39)`; it is transposed to (batch, 39, 24) for Conv1d. The layers:

```
Conv1d(39->64,k5,p2)+BN+ReLU -> Conv1d(64->64,k5,p2)+BN+ReLU -> MaxPool1d(2)
-> Conv1d(64->128,k3,p1)+BN+ReLU -> AdaptiveAvgPool1d(1) -> Flatten -> Dropout(0.3)
-> Linear(128->64)+ReLU -> Linear(64->1)   => one logit per window; P(fall)=sigmoid
```

- **Size**: 66,625 trainable parameters in all 5 checkpoints (each loaded; each
  holds only `{state_dict, n_features=39}`, no metrics or epoch). ~260 KB fp32
  (files 277 KB), ~1.1 M MACs per window.
- **Measured on this Windows dev PC, CPU, 1 thread**: torch batch 1 0.198 ms,
  batch 32 1.35 ms; ONNX Runtime batch 1 0.036 ms. Pose sets the cost, not this CNN.
- **ONNX** (`src/model/export_onnx.py:main`): opset 17, input `window`, output
  `fall_logit`, dynamic **batch only**. An in-memory export of v2 (same call) is
  266,672 bytes with ops Conv, MaxPool, GlobalAveragePool, Gemm, Relu,
  Transpose, Flatten, Squeeze, Constant (BatchNorm folded into the convs); max
  |diff| vs torch 6e-7. The time axis is fixed at 24 (T=16 is rejected) and
  sigmoid is not in the graph, so apply it downstream. No `.onnx` exists on disk.
- **Device**: `FallEngine.__init__` picks cuda, then mps, then cpu.
  `yolo_pose.py:_resolve_device` honours `YOLO_DEVICE = 0`. `docs/DEPLOY.md`
  estimates 3-6 ms per frame for TensorRT pose, which is about 10-20 cameras per
  GPU at 15 fps. That is an estimate, not a measurement.

## 6. Post-processing and thresholds (v2 / omnifall values, all in `config.py`)

| Constant | Value | Used in | Meaning |
|---|---|---|---|
| `YOLO_CONF` | 0.4 | `yolo_pose.py:track` | person detection confidence |
| `KP_CONF_THRESHOLD` | 0.3 | `normalize.py:_valid`, `extract_features` | keypoint usable |
| `HORIZONTAL_TRUNK_ANGLE` | 55.0 deg | `normalize.py:is_horizontal` | v2 uses it only in the smoke test; transfer used it to gate the fall |
| `LEG_VERTICAL_MAX_ANGLE` | 35.0 deg | `normalize.py:is_grounded` | legs within 35 deg of vertical veto the fall; legs not visible count as grounded |
| `FALL_PROB_THRESHOLD` | **0.8** (transfer: 0.5) | `detector.py:_fallish_fraction`, `eval_npz` | per-frame "fall-ish" |
| `CONFIRM_SECONDS` | **1.0 s** (transfer: 2.0) | `_fallish_fraction`, `prepare_dataset._labels_for` | look-back window, and also the label tail |
| `CONFIRM_FRACTION` | 0.7 | `process` | 70% of the last 1 s must be fall-ish |
| `GROUNDED_FRACTION` | 0.3 | `process` | 30% of the last 1 s must be grounded |
| `RECOVER_FRACTION` | 0.25 | `process` | FALL clears when the fall-ish fraction is 25% or less |
| hand-off IoU / max gap | 0.4 / 1.5 s | hard-coded in `process` | inherit a lost track's state |
| track forget | 5.0 s | hard-coded in `process` | drop unseen tracks |
| transfer only: `DEBOUNCE_WINDOWS` 2, `RECOVER_GRACE_SECONDS` 1.0 | | transfer `detector.py:process` | CANDIDATE logic |

The 0.8 threshold exists because the combined model is "eager": the
VideoDataset labels cover whole clips. The config.py comment says the setting
`(1.0 s, 0.7, 0.8)` was tuned on s1/s3/s4 and validated on s2. The sweep script
for that (`sweep_combined.py`, cited in `docs/OMNIFALL.md` step 5) is not in any
of the three folders.

## 7. Temporal / decision logic

- Per track, `prob_hist` holds (t, p, grounded) for the last 1.0 s (~15 entries
  at 15 fps). FALL fires once per NORMAL -> FALL transition when `have_full`
  (span >= 0.9 s), frac >= 0.7 and grounded_frac >= 0.3 all hold.
- Latency: a new track gets p = 0 for its first 24 frames (1.6 s). Once the CNN
  output stays >= 0.8 it takes ~0.7-0.8 s to fill 70% of the look-back, so an
  alert comes ~0.8 s after the classifier goes high, and never sooner than
  ~2.3 s after a person first appears.
- Duration is what tells a fall from lying down on a sofa: lying down spikes
  only about 0.5 s (docstring of `detector.py`). The grounded gate is what tells
  a fall from bending or shoveling.
- No cooldown beyond the state: an ID switch the IoU hand-off misses re-alerts.

## 8. Training recipe and data

- `src/model/train.py:main`: Adam lr 1e-3, batch 64, 40 epochs,
  `BCEWithLogitsLoss(pos_weight = n_neg/n_pos)`, seed 42; `--holdout s2` makes
  val exactly subject s2, otherwise `GroupShuffleSplit(0.2)`. Online augmentation
  (`features/augment.py:augment_window`): L/R flip p 0.5, whole-window keypoint
  dropout p 0.1 each, coordinate noise sigma 0.01.
- **Checkpoint rule**: save when val sensitivity at **0.5** is >= the best so far
  and precision > 0.3, so the *last* such epoch is kept. It uses the same s2 set
  that is later reported, and 0.5 rather than the deployed 0.8.
- **Datasets** (names and paths only; window counts read from the `windows.npz`
  files):

| Dataset | Where | Groups | Windows in training set |
|---|---|---|---|
| GMDCSA24 (Alam et al. 2024), subjects s1-s4 | from Mac (`data_prepared_combined/windows.npz`) | s1-s4 | 5,257 |
| VideoDataset (multi-view, ~29 subjects, ~1.9 s clips) | from Mac | v01-v29 | 4,014 |
| MCFD "Multiple Cameras Fall" (folders `chute01..chute24`; "chute" = MCFD, not Le2i) | `C:\projects\fall_detection_{omnifall,v2_gpu}\dataset\chuteNN` | mcfd1-24 | 9,497 |
| Le2i (Coffee_room_01/02, Home_01/02, Lecture_room, Office; 320x240 25 fps per `README.txt`) | `...\dataset\le2i` | 133 (per-file, see bug) | 10,190 |
| OOPS / OmniFall `of-itw` (165 YouTube clips, `oops_videos/extract_report.json` found 165/165) | `C:\projects\fall_detection_v2_gpu\oops_videos\falls` | itw: 110 train / 55 val | 5,859 train, 2,929 val |

OmniFall has 16 classes; only `fall` is positive, and squat/kneel/sit/lie/crawl
etc. are hard negatives (`src/data/omnifall.py` docstring). Totals: v1 28,958
windows (5,687 fall), v2 34,817 (7,923 fall). v1 was built by `run_omnifall.sh`
in WSL (extract, merge with combined, train `--holdout s2`); the script that
merged the OOPS train split into `data_prepared_v2` is not in the repo.

## 9. Measured results

Recorded in the project docs (event-level, real engine, Mac-side; no raw logs
survive):

- `fall_cnn.pt` (combined), held-out GMDCSA s2: sens **0.920** / spec **0.826**
  (23/25 falls, 4 FP / 23 ADL); VideoDataset v10 window-level sens 0.977;
  shoveling FPs 5 -> 0 after the grounded gate; older GMDCSA-only model s2
  0.920 / 0.870. Source: `CLAUDE.md` "Current validated performance".
- v1 `fall_cnn_omnifall.pt`, s2: **1.000 / 0.913**. Squat and shovel FPs are
  gone, but a seated or hands-and-knees fall scored p = 0.05. Source:
  `docs/OMNIFALL.md` "v2 - closing the ... blind spot",
  `GIVE_THIS_TO_CLAUDE.md` section 2.
- v2: **no recorded result anywhere**. There are no training logs; `live.log` is
  a dangling link to a deleted temp file.

Computed for this README on 2026-10-20: window-level, raw CNN, no state
machine, read-only inference on the local `.npz` windows. No model trained on
OOPS-val. The combined and v1 models selected their checkpoint on s2 (documented
`--holdout s2`); v2 is assumed to have done the same (the documented command,
no log). s2 numbers are therefore optimistic. The transfer model's random split
also lands on s2 (reproduced with `GroupShuffleSplit(random_state=42)`).

| Model | OOPS-val sens/spec @0.5 | OOPS-val @0.8 | s2 @0.5 | s2 @0.8 |
|---|---|---|---|---|
| transfer `fall_cnn.pt` (30-frame windows) | - | - | 0.847 / 0.897 | 0.809 / 0.913 |
| combined `fall_cnn.pt` | 0.619 / 0.655 | **0.524** / 0.756 | 0.890 / 0.857 | 0.861 / 0.906 |
| v1 `fall_cnn_omnifall.pt` | 0.285 / 0.847 | 0.220 / **0.912** | 0.897 / 0.910 | 0.817 / **0.964** |
| v2 `fall_cnn_omnifall_v2.pt` | **0.670** / 0.584 | 0.425 / 0.782 | **0.943** / 0.772 | 0.859 / 0.919 |

v2 meets its own success test, "sensitivity clearly higher than v1"
(`GIVE_THIS_TO_CLAUDE.md` step D), but at the deployed 0.8 it does not beat the
production model in the wild. Every model is weak in the wild (F1 ~0.47-0.56),
consistent with the OmniFall finding quoted in `docs/OMNIFALL.md` that
staged-trained models collapse there.

## 10. Known weaknesses, and concrete improvements for embedded deployment

1. **Anisotropic geometry (real bug).** `yolo_pose.py:track` divides y by H and
   x by W, then `trunk_angle_deg`, `leg_angle_deg` and the aspect ratio use those
   unequal units. On 16:9 video a 55 deg trunk (pixels) measures ~39 deg, so the
   55/35 deg gates and features shift with resolution (Le2i 4:3 vs CCTV 16:9).
   Fix: scale x by W/H before any angle/aspect; re-extract and retrain.
2. **Store raw keypoints.** `windows.npz` holds only the 39-dim features, so any
   feature change means re-running YOLO on every video. Save (T,17,3) keypoints
   plus W,H per clip in `prepare_dataset.py`.
3. **Fall dynamics are mostly invisible.** Hip-centring removes body motion; the
   only motion cue left is camera-dependent [37] vpos. Add hip velocity and
   acceleration divided by torso length (camera-invariant); consider dropping [37].
4. **Train/serve skew.** Training uses the largest person and repeats features
   on a miss; runtime is per track with no hold. Extract per ByteTrack ID in
   `prepare_dataset.py` and treat dropouts identically at runtime.
5. **Pose dominates compute.** Try `yolov8n-pose` (listed in config.py) and
   `imgsz` 416-480 for fixed cameras; TensorRT FP16/INT8 or DeepStream nvinfer;
   gate pose on Drishyam's existing person detection (zone-guard / head-count).
   The CNN (0.036 ms) needs no quantisation.
6. **Batch the CNN.** `FallEngine._classify` is batch 1 per track per frame.
   Batch across tracks and cameras, or score every 3rd frame (the training
   stride) and re-check `CONFIRM_FRACTION`.
7. **FPS is part of the model.** The window is 24 *frames* at 15 fps; running
   pose at 10 fps needs new `TARGET_FPS`/`WINDOW_SIZE`, re-extraction and
   retraining. The exported ONNX has fixed T = 24.
8. **Calibration and selection.** The checkpoint is chosen at 0.5 on the reported
   s2 set; the engine fires at 0.8. Use separate val/test splits, select on
   PR-AUC, and temperature-scale so thresholds transfer between models.
9. **Le2i grouping bug.** `prepare_dataset.py:_group_of` regex `^([a-zA-Z]+\d+)_`
   fails on `le2i3_...`, so each Le2i file is its own group (133, not ~6 scenes)
   and a split without `--holdout` leaks scenes. Fix: a letters-only
   `DATASET_CODE["le2i"]` in `omnifall.py`.
10. **Engine constants and alert policy.** Move IoU 0.4 / 1.5 s / 5.0 s into
    `config.py`; add a per-identity cooldown, snapshot and clip (DEPLOY.md) in
    line with Drishyam's detect/decide/alert doctrine.
11. **Licensing.** Ultralytics YOLOv8 is AGPL-3.0, which matters for commercial
    edge firmware. An Apache-2.0 pose model (e.g. RTMPose) only needs a new
    `pose/` backend behind `PoseEstimator`.
12. **Housekeeping.** Repair omnifall's `src/run_pipeline.py`; port
    `cv2.setNumThreads(0)` into v2's `prepare_dataset.py`; commit an event-level
    evaluator; drop the dead "candidate" colour in `run_video.py`.

## 11. How to run / test

All commands run from `<variant>/project` with `python -m` (CLAUDE.md
"Conventions"). Install `requirements.txt`: ultralytics>=8.1, torch>=2.1, lap,
scikit-learn, onnx, onnxruntime, datasets.

```
python -m tests.smoke_test          # synthetic stand->lie sequence; checks features, windows, CNN, state machine
python -m src.engine.run_video --video clip.mp4 --model models/fall_cnn_omnifall_v2.pt --out out.mp4
python -m src.model.eval_npz --data <windows.npz> --model models/<ckpt>.pt     # threshold sweep 0.3-0.9
python -m src.model.export_onnx --model models/<ckpt>.pt --out models/fall_cnn.onnx
python -m src.run_pipeline --dry-run ...   # prints the full prepare/train/eval chain (v2 variant)
```

Put `yolov8s-pose.pt` in the project root first (otherwise Ultralytics
auto-downloads it). The smoke test writes `/tmp/_smoke_fall.pt`.

## 12. Files in this folder

Each `<variant>/project/` is a copy of `C:\projects\<variant>\`; its `src/` is
byte-identical to the source (checked with `diff -rq`).

- **Shipped**: `config.py`, `src/**`, `tests/smoke_test.py`, `requirements.txt`,
  `README.md`, `CLAUDE.md`, `docs/*.md`, `START_HERE.txt` and
  `GIVE_THIS_TO_CLAUDE.md` where present, `annotations*.csv`, omnifall's WSL
  helper scripts (`run_omnifall.sh`, `validate_cpu.sh`, `reencode_*.sh`,
  `rebuild_le2i.sh`, `_progress.sh`), Le2i's `README.txt`. Checkpoints:
  transfer `models/fall_cnn.pt`; omnifall `models/fall_cnn.pt` and
  `fall_cnn_omnifall.pt`; v2 `models/fall_cnn.pt` and `fall_cnn_omnifall_v2.pt`.
- **Not shipped** (still in `C:\projects\<variant>\`): `yolov8s-pose.pt`
  (23.5 MB); `omnifall_annotations/*.csv` (without them
  `src/data/omnifall.py:_load_segments` downloads from HuggingFace); all videos
  (`dataset/`, `oops_videos/`, `data_raw*/`); all `data_prepared*/windows.npz`;
  `annotations.csv.orig`, the only copy with the MCFD/Le2i fall intervals (the
  current `annotations.csv` has GMDCSA and VideoDataset rows only); `venv/`.
