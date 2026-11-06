# Stampede / crowd-anomaly models (two in-house codebases)

Study guide for the two crowd-stampede projects, read from code, configs and saved results (nothing re-run).

- **A: `stempade_project_ucsd/`** (source `C:\projects\stempade project\`): a TensorFlow/Keras
  reproduction of Bhola et al., *Stampede detection and crowd analysis using CNN-LSTM and
  Farneback optical flow*, Sci. Rep. 2026, 16:16155. Trained on UCSD Ped1+Ped2 only.
- **B: `stempade_gpu_csrnet/`** (source `C:\projects\stempade_gpu\stempade\`): a PyTorch
  "risk-indicator fusion" pipeline (Farneback physics features + CSRNet density + rules +
  persistence gate) with a CLI, RTSP worker, FastAPI dashboard and webhook alerting.

## 1. What it does / status

| | A: CNN-LSTM (UCSD) | B: fusion + CSRNet |
|---|---|---|
| Question it answers | 16-frame window -> normal / moderate / dense / risky | per frame -> risk score in [0,1] -> NORMAL / MODERATE / HIGH / CRITICAL |
| Trained artefact | `best.keras`, 26,547,940 params (Keras 3.15.1, saved 2026-08-25) | `csrnet_shanghaitech.pth`, 16,263,489 params, fp32 (saved 2026-07-24) |
| Measured result | window AUC 0.7485 vs UCSD anomaly GT (`eval_anomaly.json`) | no saved result file; UMN AUC ~0.84 is a claim in `CLAUDE.md` only |
| Runs live? | No. Offline cache-based train/eval only, no streaming entry point | Yes: `stempade run` / `stempade serve` (RTSP or file) |
| Density branch | none (density proxy is used only to make labels) | coded, but `density.enabled: false` in `configs/default.yaml` |
| In Drishyam | not integrated | backend webhook exists; detector not deployed anywhere |

Neither is production-ready. A is an honest paper reproduction that overfits (train 0.956 / val 0.552).
B is more deployable, but its crush (density) half was never evaluated and its panic-half result was not saved.

## 2. How A and B relate

They are independent, not versions of one another. B was written first (sources dated
2026-07-24); A is newer (2026-08-25). **B is the better base for Drishyam**: it streams, it
calibrates per camera, its alert semantics already match the backend webhook, and every signal
is interpretable. A adds a learned spatio-temporal classifier over the flow field, plus a
carefully documented label derivation and evaluation protocol (clip-wise stratified split,
Youden's J), but no runtime. The useful thing to carry from A into B is A's measurement
discipline and its 4 scalar descriptors, not the 26.5 M-parameter network.

## 3. Pipeline call paths

**A (offline, 3 stages)**
1. `src/preprocess.py:preprocess_ucsd` -> `_backgrounds` -> `ucsd_labels.py:build_background`
   (per-pixel median of every 10th Train frame, per subset) -> `clip_occupancy` ->
   `ucsd_labels.py:frame_occupancy` -> `density_thresholds` (tertiles) -> `process_clip` ->
   `_process_frames` (per frame: `features.py:resize_frame`, `to_gray`, `farneback_multichannel`,
   `compute_scalars`, `normalize_flow`) -> `ucsd_labels.py:labels_from_occupancy` ->
   `_calibrate_and_finalise` (corpus p1-p99 ranges -> `scalars_to_bits`) -> `cache/<clip>/`.
2. `src/train.py:main` -> `sequence.py:split_by_clip` -> `build_index` -> `SequenceGenerator`
   -> `model.py:build_model` + `compile_model` -> `fit` with EarlyStopping / ModelCheckpoint.
3. `src/evaluate.py:in_domain` (4-class), `:anomaly` (risky-vs-rest), `:latency`.

**B (streaming, per frame)**
`cli.py:cmd_run` / `serving/worker.py:StreamWorker.run` -> `pipeline.py:StampedePipeline.run`
-> `ingestion/stream.py:FrameSource.__iter__` (decimate + resize) ->
`motion/analyzer.py:MotionAnalyzer.process` -> `motion/optical_flow.py:farneback_flow` ->
`motion/features.py:motion_features` -> `pipeline.py:_people_per_m2` (only if density enabled
AND homography given) -> `fusion/scoring.py:Scorer.sub_scores` -> `fusion/risk.py:RiskFuser.update`
-> `serving/alerting.py:AlertManager.consider` -> `WebhookSink.emit`.

## 4. Pre-processing and features

**A** (`src/config.py`, `src/features.py`)
- Resize every frame to 224x224 bilinear (`resize_frame`). UCSD frames are grayscale, so
  `farneback_multichannel` detects identical channels and computes flow once (exact, 3x cheaper).
- Farneback, OpenCV defaults (`config.FARNEBACK`): pyr_scale 0.5, levels 3, winsize 15,
  iterations 3, poly_n 5, poly_sigma 1.2, flags 0. Flow is clipped at `FLOW_CLIP = 3.0` px/frame
  and scaled to [-1,1] (`normalize_flow`); 3.0 was chosen by a sweep (0.10 % pixels clipped).
- 4 scalar descriptors per frame (`compute_scalars`): acceleration = mean |flow_t - flow_t-1|;
  divergence = mean |du/dx + dv/dy| with 3x3 Sobel; scene change = 1 - global SSIM on grayscale;
  motion entropy = Shannon entropy (32 bins over [0, FLOW_CLIP]) of flow magnitude.
- Each descriptor is clipped to a range, quantised to 8 bits, then unpacked to bits
  (`quantize`, `binarize`): 4 x 8 = **32 binary features per frame**. Training ranges are the
  corpus p1-p99 in `cache/scalar_ranges.json`: acceleration 0.0648-0.2323, divergence
  0.0888-0.2916, scene change 0.00125-0.0294, entropy 1.081-2.796.
- Occupancy (labels only): |frame - background| > 20/255, 3x3 morphological open, foreground
  fraction, 5-frame running median (`ucsd_labels.py:frame_occupancy`, `smooth_occupancy`).

**B** (`configs/default.yaml`, `src/stempade/motion/`)
- `FrameSource`: stride = round(src_fps / target_fps), target 15 fps, resize 640x480 (default).
  `eval_umn.py` overrides to 30 fps, 320x240.
- Grayscale Farneback with the same OpenCV-default parameters (`farneback_flow`). The config keys
  `motion.method: farneback | raft` and `motion.features` are **never read**; RAFT is not implemented.
- `motion_features` (scene-level means): speed = mean |v|; kinetic_energy = mean |v|^2;
  acceleration = |speed_t - speed_t-1|; divergence = mean signed (np.gradient) divergence;
  convergence = max(0, -divergence); order_parameter = magnitude-weighted Vicsek coherence;
  angular_entropy = normalised 16-bin direction entropy (pixels with |v| > 0.25 only).
- `motion/clustering.py:cluster_metrics`: DBSCAN (eps 20, min_samples 8) on up to 2,000 moving
  pixels (|v| > 0.5) -> moving_fraction, largest_cluster. Runs **every frame** on CPU.
- Per-camera baseline (`calibration/baseline.py:estimate_baseline`): mean/std of each feature
  over a normal clip; `Baseline.zscore` turns live features into z-scores.
- Homography (`calibration/homography.py`): from >=4 pixel/metre pairs; `_frame_ground_area`
  uses the whole frame's 4 corners (shoelace) to get m^2 for people/m^2.

## 5. Models, input tensors and runtime

**A: `stampede_cnn_lstm`** (`src/model.py:build_model`; layer list confirmed from `best.keras` config.json)

| Stage | Layer (TimeDistributed over T = 16) | Output per frame | Params |
|---|---|---|---|
| input `flow` | (16, 224, 224, 2) float, [-1,1] | | |
| conv1 + BN + pool | Conv2D 32 3x3 relu | 112x112x32 | 608 (+BN) |
| conv2 + pool | Conv2D 64 3x3 relu | 56x56x64 | 18,496 |
| conv3 + BN + pool | Conv2D 128 3x3 relu | 28x28x128 | 73,856 (+BN) |
| flatten + bottleneck | Dense 256 relu (added: not in paper) | 256 | **25,690,368** |
| fusion | concat with input `scalars` (16, 32) | 288 | |
| lstm_1 / lstm_2 | LSTM 256 (seq) -> LSTM 128 (last), dropout 0.3 each | 128 | 558,080 / 197,120 |
| head | Dense 64 relu -> BN -> Dense 4 softmax | 4 | ~8.8 k |

Total 26,547,940 parameters (counted from `model.weights.h5`); 97 % sit in the 100,352 x 256 bottleneck. `best.keras` is 318.7 MB because it also stores 53.1 M Adam slots; the
weights alone are ~106 MB fp32. Literal paper spec (`CNN_BOTTLENECK = 0`) is 103 M params in
LSTM-1 alone (`TRAINING.md`). Compute is ~0.5 GMAC per frame (my arithmetic, not measured).
Runtime: TF >= 2.20 required on Blackwell sm_120; GPU needs WSL2/Linux (`requirements.txt`).

**B: CSRNet** (`src/stempade/density/csrnet.py:build_csrnet`)
- Frontend = VGG-16 conv1_1..conv4_3 (10 convs, 3 max-pools), ImageNet-initialised; backend =
  6 dilated (d=2) 3x3 convs 512,512,512,256,128,64; 1x1 conv -> 1 channel. No BN.
- Input: BGR -> RGB, ImageNet mean/std, **full frame, any size** (fully convolutional;
  `DensityEstimator._preprocess`). At the default 640x480: tensor (1,3,480,640) -> density map
  (60, 80), i.e. **output stride 8**. Count = sum of the map (`DensityEstimator.count`).
- 16,263,489 params (7.64 M frontend), 65 MB fp32 checkpoint `{"model": state_dict}`.
  Roughly 125 GMAC per 640x480 frame (layer arithmetic, not measured). This is the heavy part.
- People/m^2 = count / ground area of the whole frame (`pipeline.py:_people_per_m2`).

**B: learned fuser** (`fusion/learned.py:LearnedFuser`): sklearn LogisticRegression
(class_weight balanced) over the 4 sub-scores in order motion, density, clustering, rules
(missing ones become 0.0). Saved with joblib; enabled via `fusion.learned_model`. No trained
`.joblib` exists on disk.

## 6. Post-processing, scoring and thresholds

**A**: softmax over 4 classes. For anomaly use, the score is P(risky)
(`evaluate.py:anomaly`); the operating point is Youden's J chosen **on the evaluation set
itself** = **0.0048** (paper: 0.5512). The model almost never outputs a confident risky
probability, so this is a calibration problem as well as an accuracy one. No threshold is stored
in code; there is no live decision logic.

**B** (`fusion/scoring.py:Scorer`, values hard-coded unless noted)
- `motion_score` = 0.30 speed + 0.20 KE + 0.25 convergence + 0.15 angular entropy + 0.10 order-drop,
  each a logistic ramp. With a baseline: midpoints on z-scores (speed 3, KE 3, convergence 2,
  entropy 2, -order 2; scale 1.5). Without: raw midpoints (speed 3.0 px/frame, KE 12,
  convergence 0.15, entropy 0.85, order 0.4), which depend on resolution and fps.
- `density_score` = logistic(people/m^2, midpoint 5.0, scale 1.5).
- `clustering_score` = min(1, largest_cluster x (0.5 + moving_fraction)).
- `rules_score` tripwires: z(speed) > 5 -> 0.8; z(convergence) > 4 -> 0.9; > 7 people/m^2 -> 1.0.
- Fusion (`fusion/risk.py:RiskFuser.combine`): weights from `configs/default.yaml`
  rules 0.10 / clustering 0.25 / motion 0.30 / density 0.35, renormalised over the sub-scores
  present. With density off this becomes motion 0.46 / clustering 0.38 / rules 0.15.
- Levels (`default.yaml fusion.thresholds`): moderate 0.45, high 0.60, critical 0.80.

## 7. Temporal / decision logic

- **A**: windows of `SEQ_LEN = 16` frames, overlap 12 (stride 4) (`sequence.py:window_starts`).
  A window takes the highest class in it (`WINDOW_LABEL = "max"`, `window_label`), which lifts
  risky from 30.7 % of frames to 33.9 % of training windows.
- **B**: `RiskFuser.update` keeps the last `persistence_frames = round(3.0 s x target_fps)` = 45
  instantaneous levels; it emits the highest level held in >= 66 % of them, and NORMAL until the
  buffer is full (3 s warm-up). `AlertManager.consider` fires only on a rising edge into
  >= HIGH, with a 30 s per-camera cooldown; `WebhookSink` POSTs `{camera, level, score, time_s}`.
  This already follows Drishyam's detect / decide / alert-on-transition doctrine
  (`docs/DETECTION_LOGGING_ALERTING_POLICY.md` section 5.4).

## 8. Training recipe and data

**A** (`src/config.py`, `TRAINING.md`): UCSD Ped1+Ped2, 98 clips, 18,560 frames -> 18,462 flow
frames (~3.5 GB cache). Labels: risky = UCSD's frame-level anomaly flags (bikes, skaters, carts:
**not** crowd crushes); normal / moderate / dense = tertiles of occupancy over non-anomalous
frames. Frame balance 23.1 / 23.1 / 23.1 / 30.7 %. Split by clip, stratified by
subset/split/dominant class: 77 train / 21 val clips, 3,346 / 907 windows (`split.json`). Adam 1e-3,
batch 8, categorical cross-entropy, 40 epochs max, EarlyStopping on val_accuracy patience 10 with
restore-best, seed 42. Run `ucsd_gpu` on an RTX PRO 5000 (WSL2, TF 2.21, CUDA 12.9).

**B CSRNet** (`scripts/train_csrnet.py`): ShanghaiTech Part A (300 train / 182 test images on
disk). Targets = point annotations blurred with a **fixed** Gaussian sigma 15, resized to 1/8 and
multiplied by 64 to preserve the count. SGD lr 1e-6, momentum 0.95, wd 5e-4, batch 1, MSE (sum),
no augmentation or crops. **"Best" is chosen on training loss; no validation and no test MAE is
ever computed.** File timestamps suggest ~30 minutes of training; epoch count is unknown.

**B fusion** (`scripts/train_fusion.py`): runs the pipeline over (video, 0/1 labels) pairs,
fits `LearnedFuser`. Synthetic data from `scripts/simulate_crowd.py` (Helbing social-force,
single exit, desired speed 1.2 -> 4.5 px/frame at panic onset).

## 9. Measured results

| Metric | Value | Source |
|---|---|---|
| A best epoch | 23 of 33 (early stop) | `artifacts/ucsd_gpu/history.csv` row 22 |
| A train / val accuracy | 0.956 / **0.552** (val loss 2.084, rising to 3.19) | `history.csv` |
| A 4-class held-out accuracy | 501/907 = 0.5524 | `eval_in_domain.json` |
| A one-vs-rest AUC | normal 0.892, moderate 0.673, dense 0.768, risky 0.809 | `eval_in_domain.json` |
| A anomaly ROC AUC (window-level, 10 Test clips, 443 windows, 318 abnormal) | **0.7485** | `eval_anomaly.json` |
| A at Youden threshold 0.0048 | TP 236, FN 82, TN 78, FP 47: TPR 0.742, FPR 0.376 | `eval_anomaly.json` |
| A EER | not computed by any script | |
| A latency (flow + descriptors + inference, GPU) | 0.1439 s per 16-frame window = 9.0 ms/frame, 111.2 FPS | `latency.json` |
| B CSRNet MAE / MSE | **never measured** | |
| B UMN, hand-weighted fusion | script exists (`scripts/eval_umn.py`), no output saved | |
| B UMN, leave-one-scene-out LR | "AUC ~0.84" claimed in `CLAUDE.md`; no output saved; UMN data not on disk | `scripts/eval_umn_learned.py` |
| B synthetic clip | "AUC 0.999 (1.0 learned), HIGH ~2 s into panic, 0 false alarms" claimed in `README.md` | |

Reading A: the 4-class numbers are inflated by clip recognition (density is near-constant inside
a UCSD clip), and 12 normal/risky confusions occurred (paper claims 0). The anomaly AUC is the
honest headline, but it is window-level, risky-vs-rest, on 10 clips, with the threshold tuned on
the same windows. Latency was measured on 17 random-noise 320x240 frames, not real video.

Reading B: the ~0.84 comes from `eval_umn_learned.py`, which fits LR directly on 7 z-scored
motion features. That is **not** the code path `stempade run` executes (sub-scores + weighted
sum + persistence). UMN labels come from the burned-in "Abnormal Crowd Activity" overlay; the
appearance of that text in-frame may itself leak a flow/scene-change spike at the onset (unchecked).

## 10. Integration status in Drishyam

- `grep -ril "stampede|stempade|csrnet" smart-cam-ai --include=*.py`: **no hits** (no AI code, no container).
- Backend: `smart-cam-backend/src/routes/internal.routes.js` `POST /api/internal/stampede-alert`
  (auth `?token=<SERVICE_TOKEN>`), body `{camera, level, score?, time_s?}` exactly matching
  B's `WebhookSink`. It maps the camera **name** to a VMS camera, stores an `AIEvent`
  `crowd.stampede` (CRITICAL -> critical, else warning) and calls `alertEngine.maybeAlert`.
- UI: `crowd.stampede` renders as "Crowd Surge" (`smart-cam-app/src/core/services/ai.js`,
  `modules/ai-feed/aifeed/event-model.js`, `reportPdf/vocabulary.js`).
- To go live, B needs a `cameras:` list (name must equal the VMS camera name) and
  `alerting.webhook_url` in its YAML (`serving/app.py:create_app`, `_build_workers`).

## 11. Known weaknesses and concrete improvements for embedded deployment

Bugs / traps found while reading:
1. **A train/serve skew**: `config.SCALAR_RANGES` is the paper's ranges and nothing loads
   `cache/scalar_ranges.json` (the comment "overridden by calibration below" is false). Any new
   inference using `features.scalars_to_bits` without passing ranges quantises differently from
   training. That file is also not in this bundle; the values are copied in section 4.
2. **B density can't switch on as shipped**: `density.enabled: false`; `_people_per_m2` also needs
   a homography; `DensityEstimator` defaults to `device="cuda"`; and `build_csrnet()` always
   downloads ImageNet VGG-16 weights (`load_vgg=True`) even when loading the checkpoint, which
   fails on an offline edge box. Pass `load_vgg=False` when loading weights.
3. **Whole-frame divergence is weak**: by the divergence theorem, the frame-mean of div(v) is
   just net flux through the image border, so B's `convergence` mostly measures people
   entering/leaving the frame. Compute divergence per grid cell or per zone polygon and take the
   most negative cell (PLAN.md already intends per-zone risk).
4. **Time base**: `FrameSource` rounds the stride (25 fps source -> stride 2 -> 12.5 fps), but the
   persistence window and `time_s` assume `target_fps`. Use real timestamps.
5. **Cost hot spots**: DBSCAN on 2,000 points every frame (`cluster_metrics`); CSRNet on every
   frame; A re-runs the CNN on all 16 frames for every window although the CNN is per-frame.
6. **Ground area** uses the full frame's corners, including sky and walls; use a ground ROI polygon.

Model and runtime ideas:
- **Density at a lower rate and lower cost.** Density changes over seconds, so run it at 1-2 fps
  while motion runs at 10-15 fps. Downscale the input (stride-8 output still gives 40x30 at
  320x240). Swap the VGG frontend for a MobileNet/ShuffleNet-class counter. DM-Count is a training
  loss (optimal transport), not a light architecture; its reference model is VGG-19, so use its
  loss on a light backbone. For sparse to medium crowds, reuse Drishyam's YOLOv8 head-count
  service (:8020) and switch to density regression only above an occlusion threshold.
- **Cheaper flow.** The features are frame or zone statistics, so 160x120-320x240 flow is enough
  (scale px/frame thresholds with resolution). Options by cost: H.264/H.265 **codec motion
  vectors** (nearly free, the decoder already runs); **NVIDIA hardware optical flow** (NVOFA on
  Turing+ dGPUs and Jetson Orin, via OpenCV `cuda.NvidiaOpticalFlow_2_0` or VPI, 4x4 grid,
  no CUDA-core load); Farneback on CPU (current); RAFT-small (~1 M params, more accurate, GPU-heavy).
- **A, if kept**: replace Flatten + Dense(100352->256) with global average pooling or a strided
  conv to 7x7 (drops ~25.7 M params to well under 1 M), cache per-frame embeddings and use a
  stateful LSTM so each new frame costs one CNN pass and one LSTM step. Recalibrate the output
  (temperature scaling) so the threshold is not 0.0048.
- **Export**: CSRNet is fully convolutional and exports cleanly to ONNX -> TensorRT FP16 with a
  fixed input size. INT8 is risky for density regression; check count drift on held-out images
  before adopting it. A's Keras model -> ONNX via tf2onnx; LSTMs are supported in TensorRT.
- **Retrain CSRNet properly**: hold out a validation set and report MAE/MSE on Part A test; use
  geometry-adaptive kernels for Part A; add Part B (sparser, closer to CCTV) and random crops and
  flips; select the checkpoint on validation MAE, not training loss.
- **Data is the real limit.** UCSD anomalies are bicycles, not stampedes; UMN is 11 staged panic
  sequences in 3 scenes; ShanghaiTech is still images. Neither project has seen a real crush.
  Collect per-site footage from Drishyam deployments (events, gates, festivals), keep the
  per-camera baseline, and score what PLAN.md names as the real KPIs: false alarms per hour on
  long normal footage, and lead time before onset, not only AUC.

## 12. How to run / test

```bash
# A (from the project root; TF >= 2.20 under WSL2/Linux for GPU)
pip install -r requirements.txt
python src/preprocess.py --workers 12          # needs datasets/ucsd (not shipped)
python src/train.py --require-gpu              # writes artifacts/<run>/
python src/evaluate.py --run ucsd_gpu [--anomaly | --latency]

# B
pip install -e ".[density,serving,learned]"
pytest -q                                      # 8 unit tests (tests/test_smoke.py, test_pipeline.py)
python scripts/simulate_crowd.py --n 120 --seconds 20 --panic-at 12 --out data/samples/sim
stempade calibrate data/samples/sim.mp4 --out baseline.json --max-frames 150
stempade run  data/samples/sim.mp4 --baseline baseline.json
stempade eval data/samples/sim.mp4 data/samples/sim.labels.txt --baseline baseline.json
python scripts/eval_umn_learned.py             # needs data/umn/scene{1,2,3}.avi + labels (absent)
python scripts/train_csrnet.py --data data/shanghaitech/part_A --epochs 100 --out weights/csrnet_shanghaitech.pth
stempade serve --port 8000                     # /api/status + dashboard
```

## 13. Files in this folder

| Path here | Shipped? | Source |
|---|---|---|
| `stempade_project_ucsd/project/src/*.py` (9 files), `pipeline.md`, `TRAINING.md`, `note.txt`, `requirements.txt`, `.gitignore` | yes, identical to source | `C:\projects\stempade project\` |
| `.../artifacts/ucsd_gpu/best.keras` (318.7 MB), `eval_*.json`, `latency.json`, `history.csv/json`, `split.json`, `confusion_matrix.png`, `roc_curves.png` | yes | `...\artifacts\ucsd_gpu\` |
| `.../datasets/README.md` | yes (README only) | `...\datasets\` |
| `final.keras` (last epoch), `cache/` (~3.5 GB incl. `scalar_ranges.json`), `datasets/ucsd/` (1.2 GB), `stampede_sample/` (16 mp4), paper PDF `s41598-026-45262-1.pdf` | **no** | `C:\projects\stempade project\` |
| `stempade_gpu_csrnet/project/` src, scripts, tests, configs, docs, `pyproject.toml` | yes, identical to source | `C:\projects\stempade_gpu\stempade\` |
| `.../project/weights/csrnet_shanghaitech.pth` (65 MB) | yes | `...\stempade\weights\` |
| `stempade_gpu_csrnet/CLAUDE-outer.md` | yes (byte-identical to the inner `CLAUDE.md`) | `C:\projects\stempade_gpu\CLAUDE.md` |
| `data/` (ShanghaiTech Part A + download zips), `.venv/`, `src/stempade.egg-info/` | **no** | `C:\projects\stempade_gpu\stempade\` |
| UMN videos/labels, `fusion_lr.joblib`, any eval logs | do not exist on this machine | |
