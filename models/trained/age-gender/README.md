# Age + Gender (in-house, UTKFace, EfficientNet-B0)

Study guide for Drishyam's in-house age/gender model, and how it compares to the
InsightFace `genderage` head that production actually runs today.

Paths in this guide:
- `project/...` is the copy in this folder (byte-identical to the source, checked with `cmp`).
- Source of truth: `C:\projects\age-gender-model\age-gender-model\`.
- Production paths are relative to the drisyam repo; `vms_face/` means
  `smart-cam-ai/app/face_detection/vms_face/`.

## 1. What it does / status

- One face crop in, two answers out: age in years (regression) and gender (male/female,
  softmax over 2 logits). `project/src/model.py:AgeGenderModel`.
- Trained once. The checkpoint holds 30 epochs; `best.pt` is from epoch 5 (section 7).
- **Not integrated anywhere in production.** A grep of the whole drisyam repo for
  `age-gender-model`, `AgeGenderModel`, `age_head`, `gender_head`, `UTKFace` and
  `efficientnet_b0` finds nothing. Production gender/age comes from InsightFace
  `buffalo_l/genderage.onnx` (section 6).
- No face detector. `predict.py` resizes whatever image it gets to 224x224. Its docstring
  (line 7) says "feed a tightly-cropped face".
- No metrics log was kept. Only the combined validation loss sits in the checkpoint.

## 2. Pipeline call path (file:function)

Training (`python src/train.py`):
1. `train.py:parse_args` copies CLI flags into `config.py:Config`.
2. `dataset.py:make_dataloaders` calls `scan_samples` and `_parse_filename`, which read
   labels from UTKFace filenames `[age]_[gender]_[race]_[datetime].jpg`. A file is skipped
   unless 0 <= age <= 116 and gender is 0 or 1. Then `random_split` with seed 42, then
   train and val `UTKFaceDataset` views.
3. `train.py:main` builds `AgeGenderModel`, `L1Loss`, `CrossEntropyLoss`, `AdamW`,
   `CosineAnnealingLR` and `GradScaler`, and freezes the backbone.
4. Each epoch, `train.py:run_epoch` runs train then val. It saves `last.pt` every epoch and
   `best.pt` whenever the val loss drops (`main`, lines 163-177).

Inference (`python src/predict.py --ckpt ... --image ...`):
1. `predict.py:main` loads the checkpoint and reads `config.backbone/max_age/image_size`.
   It rebuilds `AgeGenderModel(pretrained=False)`, calls `load_state_dict` and `eval()`.
2. `predict.py:predict` runs PIL RGB, then `build_transforms(train=False)`, then `model(x)`.
   Age comes out as `age_pred * max_age`. Gender is the argmax of the softmax, and its
   probability is reported as the confidence.

## 3. Pre-processing

`dataset.py:build_transforms`:
- Eval: `Resize((224, 224))` (a stretch, not an aspect-preserving resize), then
  `ToTensor` (0..1), then ImageNet `Normalize(mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225])`.
- Train adds `RandomHorizontalFlip`, `ColorJitter(brightness=0.2, contrast=0.2, saturation=0.2)`
  and `RandomRotation(10)`.
- No blur, downscale, noise, JPEG, grayscale/IR or crop jitter. Every training face is a
  clean, aligned, roughly 200 px UTKFace "chip". That is the main domain gap against CCTV.
- Labels (`UTKFaceDataset.__getitem__`): age target = `age / 116` as float32. Gender is a
  long, **0 = male, 1 = female**. InsightFace uses the opposite, 1 = male
  (`vms_face/pipeline/orchestrator.py:_gender_label`). Any integration must flip it.

## 4. Model, input tensor, runtime

- Input: `float32 [B, 3, 224, 224]`, RGB, ImageNet-normalised (`config.py:Config.image_size = 224`).
- Backbone: torchvision `efficientnet_b0(weights="DEFAULT")` (ImageNet). The classifier is
  replaced with `Identity`, which leaves a 1280-d pooled feature (`model.py:_build_backbone`).
  `resnet50` and `mobilenet_v3_large` are also wired and selectable with `--backbone`.
- Heads (`model.py:AgeGenderModel.__init__`), both on the shared 1280-d feature:
  - age: `Dropout(0.3) -> Linear(1280,128) -> ReLU -> Linear(128,1) -> Sigmoid`, output in [0,1]
  - gender: `Dropout(0.3) -> Linear(1280,128) -> ReLU -> Linear(128,2)` (logits [male, female])
- Losses (`train.py:run_epoch`): `loss = 1.0 * L1(age_scaled) + 1.0 * CE(gender)`. The weights
  come from `Config.age_loss_weight` and `gender_loss_weight` and can be overridden with
  `--age-weight` / `--gender-weight`.
- Size, measured by loading `best.pt` read-only: 4,335,871 learnable parameters
  (backbone about 4.0 M, heads 328,323). The `.pt` is 52.5 MB because it also stores the
  AdamW state; the weights alone are about 17 MB in fp32.
- Runtime: plain PyTorch eager, batch 1 in `predict.py`. It picks CUDA, then MPS, then CPU
  (`pick_device`). There is no ONNX/TensorRT export and no measured latency or fps.

## 5. Post-processing and thresholds

- Age: `sigmoid_output * 116` years, printed rounded (`predict.py:predict`, `main`). The
  output is continuous with no buckets, and the Sigmoid caps it at 0..116.
- Gender: argmax of the softmax. The confidence is the winning probability.
  **No threshold, no abstain, no calibration.** A 51% call prints the same as a 99% call.
- Nothing aggregates across frames or tracks. Each image is classified alone.

## 6. Production comparison: InsightFace genderage + track voting

### 6.1 Which one runs in production

Production runs **InsightFace `genderage.onnx`** from the `buffalo_l` pack (present at
`smart-cam-ai/data/insightface/models/buffalo_l/genderage.onnx`, 1.32 MB).
`vms_face/infra/genderage.py:_default_model_path` finds it by globbing `*genderage*.onnx`
under `~/.insightface/models/<insightface_model>`, and `insightface_model = "buffalo_l"`
(`vms_face/config/settings.py`, line 118). The in-house model is not referenced.

### 6.2 The genderage model

- Loader: `GenderAgeEstimator.__init__` calls `insightface.model_zoo.get_model`, which gives
  an `Attribute` object (`taskname` must equal `"genderage"`). The session goes through
  `vms_face/infra/ort_session.py`: TensorRT if libnvinfer loads, else CUDA, else CPU. The
  TensorRT profile is `data:1x3x96x96 / 8x3x96x96 / 16x3x96x96` (lines 204-207).
- Crop (`insightface/model_zoo/attribute.py:Attribute.get`; vendored copy at
  `smart-cam-ai/app/face_detection/insightface-master/python-package/`): it centres on the
  bbox, scales so 1.5 x max(w, h) fills 96 px, uses `rotate = 0`, and warps with
  `face_align.transform`. Then `blobFromImage` applies BGR to RGB with mean/std 127.5/128
  or 0/1, depending on the graph's first nodes.
- **Landmarks are ignored.** `estimate()` passes `kps` in, but `Attribute.get` only reads
  `face.bbox`. There is no 5-point alignment.
- Output: 3 floats. `gender = argmax(pred[:2])` (1 = male, 0 = female) and
  `age = int(round(pred[2] * 100))`. The class probability is thrown away.
- Cost: 1.97 ms at batch 1, 0.17 ms/img at batch 8 (`docs/FACE_LIGHTWEIGHT_TARGET.md`, line 57).
  Production calls it **one face at a time** behind a lock (`GenderAgeEstimator.estimate`),
  so the batch-16 TensorRT profile is never used.
- Failure posture (`get_genderage_estimator`): if the model is missing or fails to load,
  it latches `_unavailable` and returns None, and gender stays unknown.
  `vms_face/api/main.py` (around line 229) warms it up before cameras start.

### 6.3 When it is called

`vms_face/pipeline/orchestrator.py:_handle_tracked` runs the quality gate first. If
`verdict.passed` is False it returns (line 1012). Otherwise it calls `_maybe_vote_attributes`
(line 1023) before the embed gates, which:
1. returns if `face_attributes_enabled` is False;
2. returns if `min(face w, h) < attributes_min_face_px` (48);
3. uses `obs.gender/obs.age` if the head already ran inline. Otherwise, if
   `attrs.needs_sample()` is True, it runs `estimator.estimate(frame.bgr, obs.bbox, obs.landmark_5)`
   on the GPU pool and increments `vms_genderage_calls_total`;
4. calls `attrs.add_vote(gender, age, verdict.score)`.

With `insightface_ondemand_genderage = True` (the default), `insightface_runtime.py`
(lines 127-144) leaves genderage out of `FaceAnalysis`. So step 3 is always the explicit
on-demand call.

### 6.4 Track voting (`vms_face/services/track_attributes.py:TrackAttributes`)

| constant | value | where set | effect |
|---|---|---|---|
| `face_attributes_enabled` | True | settings.py:399 | master switch (env `FACE_ATTRIBUTES_ENABLED`) |
| `insightface_ondemand_genderage` | True | settings.py:406 | per-track on-demand call instead of every face, every frame |
| `attributes_min_face_px` | 48 | settings.py:409 | faces with a short side under 48 px never vote |
| `attributes_min_votes` | 3 | settings.py:414 | no label before 3 votes |
| `attributes_max_votes` | 8 | settings.py:415 | sampling stops at 8 votes per track |
| `attributes_min_agreement` | 0.70 | settings.py:416 | label only if one side holds 70% or more of the weighted mass |
| `_EARLY_STOP_AGREEMENT` | 0.90 | track_attributes.py:33 | stop sampling early at 3+ votes and 90% or more agreement |
| `backend_overlay_min_gender_conf` | 0.85 | settings.py (around line 708) | overlay shows gender only at 0.85+ agreement and never shows age |
| quality gate | 40 px, det 0.6, yaw 45, pitch 30, brightness 15-240 | settings.py:419-425 | must pass before any vote |

- Vote weight = `verdict.score` = `0.45*det_score + 0.25*size + 0.20*blur + 0.10*brightness`
  (`vms_face/services/face_quality.py:evaluate`, lines 97-105), floored at 1e-3 (`add_vote`).
- `gender_label()` returns None below min_votes or below min_agreement. A 50/50 split after
  8 votes stays None for good.
- `gender_confidence()` is the weighted agreement in [0.5, 1]. It is **not** a model probability.
- `age_estimate()` is the quality-weighted mean of the per-crop ages. Ages of 0 or below
  are dropped, and it is not gated on min_votes.
- Consumers: the overlay (`orchestrator.py`, around line 748), FaceCandidate `gender / gender_conf / age`
  (around line 1224) and the people-count gender split. With attributes disabled, the
  fallback `_reviewable_gender_label` needs quality 0.65+, blur_var 50+ and a 100 px+ face.

### 6.5 Side by side

| | in-house (this folder) | production genderage |
|---|---|---|
| input | 224x224 RGB, ImageNet norm, stretch resize | 96x96, bbox x1.5 context, no landmark alignment |
| backbone | EfficientNet-B0, 4.34 M params | small CNN in a 1.32 MB ONNX (architecture not inspected) |
| age | Sigmoid x 116, L1 trained | `pred[2] * 100`, rounded int |
| gender | 2-way softmax, probability available | argmax of 2 logits, probability discarded |
| training data | UTKFace, 23,708 aligned crops | InsightFace (not documented in this repo; not verified) |
| runtime | PyTorch eager, no export | ONNX Runtime with TensorRT/CUDA, about 2 ms per face |
| licence | own code; **UTKFace data is non-commercial research only (verify)** | **InsightFace pretrained weights are non-commercial research only** |
| integrated | no | yes, every face shard |

**Known risk:** the production feature runs on InsightFace weights that are licensed
non-commercial (see `docs/FACE_EDGE_REALTIME_PLAN.md`, around line 185). That makes this
model strategically important. But it was trained on UTKFace, which also carries a
non-commercial research licence, so it does not clear the risk until it is retrained on
commercially usable or own footage.

## 7. Training recipe + data

From `config.py:Config` and `train.py:main`:
- Data: UTKFace, labels parsed from filenames. The source folder holds 23,708 files in
  `data/UTKFace/` (only counted, not opened; **not shipped**).
- Split: random 85/15 by image, seed 42 (`make_dataloaders`), giving 20,152 train and 3,556 val.
  UTKFace has no identity labels, so the same person can land on both sides.
- Optimiser: AdamW, lr 3e-4, weight_decay 1e-4, betas (0.9, 0.999).
- Schedule: `CosineAnnealingLR(T_max=30)`, stepped once per epoch.
- 30 epochs, batch 64, `drop_last=True` (314 steps per epoch), AMP plus GradScaler on CUDA.
- Warm-up: backbone frozen for the first 2 epochs (`warmup_freeze_epochs = 2`), then unfrozen.
  BatchNorm running stats still update while frozen, because `model.train(True)`.
- Model selection: lowest combined val loss, saved to `best.pt`.

The checkpoint confirms this. The AdamW `step` counters in `best.pt` read 1,570 for the
8 head tensors (5 epochs x 314) and 942 for the 211 backbone tensors (3 epochs x 314),
which shows the 2-epoch freeze and the 23,708-image split. `last.pt` reads 9,417 heads and
8,789 backbone, i.e. 30 epochs minus 3 skipped steps. Skipped steps only happen with an
active GradScaler, which points to a CUDA run.

## 8. Measured results

| metric | value | source |
|---|---|---|
| best epoch | index 4 (the 5th of 30) | `checkpoints/best.pt["epoch"]` |
| best combined val loss (L1 on age/116 + CE) | **0.21730** | `best.pt["best_val"]` (`last.pt` has the same value) |
| LR at the best epoch | 2.799e-4 (cosine had barely moved) | `best.pt["optimizer"]["param_groups"]` |
| val age MAE (years) | **not recorded** | only printed to the console in `run_epoch`; no log kept |
| val gender accuracy | **not recorded** | same |
| "5-6 yr MAE, ~90%+ gender" | an expectation, not a measurement | `project/README.md`, section 3 |

What this tells you:
- After epoch 5 the val loss never improved over 25 more epochs. That is overfitting or
  overconfident gender CE. `best.pt` saw only 3 epochs of backbone fine-tuning.
- The combined loss is dominated by gender. Age L1 is in /116 units: a 6-year MAE is only
  0.05 of loss, against roughly 0.2 for CE. So checkpoint selection mostly tracks gender
  CE, and `last.pt` (source only, not shipped) may well have a better age MAE. Nobody has
  measured it.
- There are no CCTV-domain numbers at all.

## 9. Known weaknesses + concrete improvement ideas (embedded)

Fix the evidence first:
1. Write per-epoch `train/val loss, age MAE, gender acc` to a CSV, and keep `best_mae.pt`
   and `best_acc.pt` as separate checkpoints. Also save the scheduler and scaler state;
   `--resume` restores only the model and optimizer, so the cosine LR restarts.
2. Build a held-out CCTV set from our own cameras. Report gender accuracy and age MAE in
   face-size bins (48 / 64 / 96 / 128 px, matching `attributes_min_face_px = 48`) and
   per demographic group. Run the same set through production genderage for a head-to-head.

Close the domain gap:
3. Augment for CCTV: random downscale to 24-64 px and back up, Gaussian and motion blur,
   JPEG/H.264 quality 20-60, grayscale/IR, gamma, crop jitter, and pose. Add surveillance-like
   data with a commercial-use licence, or pseudo-label our own footage (`docs/FACE_EDGE_REALTIME_PLAN.md`,
   distil on own footage).
4. Match the production crop. Align with SCRFD's 5 landmarks (already in `obs.landmark_5`)
   to a fixed template, then train and infer on the same crop.

Make it embedded-friendly:
5. Lower the input resolution to 96 or 112. 224 is about 4-5x the pixels of a 48-100 px CCTV
   face, and compute scales with pixel count (112 costs about a quarter of 224).
6. Choose a backbone: `mobilenet_v3_large` is already wired; MobileNetV3-Small or
   EfficientNet-Lite0 are other options. EfficientNet-B0 uses SiLU and squeeze-excite,
   which INT8 compilers such as RKNN and Hailo handle worse than the ReLU6/no-SE Lite variants.
7. Export to ONNX with a dynamic batch. Put the normalisation in the graph (uint8 NHWC
   input, like the Phase 2 SCRFD path), plus `*max_age` and the softmax. Then build TensorRT
   FP16 (Blackwell/Orin) or INT8 with a calibration set of real CCTV crops.
8. Batch per frame: collect every face that needs a vote and make one call. The current
   estimator is serial behind a lock.

Make the outputs meaningful:
9. Swap the age regression for buckets (for example 0-12, 13-19, 20-35, 36-55, 56+), or
   for ordinal/DLDL. The product overlay never shows age, and reports need brackets, not
   years. If regression stays, raise `--age-weight` to around 5-10 or compute L1 in years/10.
10. Calibrate gender with temperature scaling on a CCTV val set. Weight each track vote
    by `p(gender) * quality` instead of quality alone, and abstain below a probability
    floor. Today the production vote cannot see model confidence.

Integrating it:
11. Wrap the model behind the same interface as `GenderAgeEstimator.estimate(frame_bgr, bbox, kps) -> (gender, age)`.
    Flip the gender to InsightFace's 1 = male and switch on a setting. The
    `TrackAttributes` voting then needs no change.

## 10. How to run / test

Use the existing venv in the source folder (torch 2.12.1+cu130). This copy has none;
see `project/README.md`, section 1.

```
cd C:\projects\age-gender-model\age-gender-model
venv\Scripts\python.exe -I src\predict.py --ckpt checkpoints\best.pt --image face1.jpg face2.jpg
venv\Scripts\python.exe -I src\train.py --data-dir data\UTKFace --epochs 30 --batch-size 64
```

Always pass a tight face crop, because there is no detector. `best.pt` loads with
`torch.load` at its default `weights_only` setting (checked). Quick sanity test without
data: load `best.pt` and run `model(torch.zeros(1, 3, 224, 224))`. It should return a
`(1,)` age in [0, 1] and `(1, 2)` logits.

## 11. Files in this folder

| path | shipped | source |
|---|---|---|
| `README.md` (this guide) | yes | written for the bundle |
| `project/README.md`, `requirements.txt`, `.gitignore` | yes | `C:\projects\age-gender-model\age-gender-model\` |
| `project/src/config.py, dataset.py, model.py, predict.py, train.py` | yes | `...\age-gender-model\src\` |
| `project/checkpoints/best.pt` (52.5 MB, epoch 5, includes optimizer state) | yes | `...\age-gender-model\checkpoints\best.pt` |
| `checkpoints/last.pt` (epoch 30) | no | `...\age-gender-model\checkpoints\last.pt` |
| `data/UTKFace/` (23,708 images) | no (licence and size) | `...\age-gender-model\data\UTKFace\`, or Kaggle `jangedoo/utkface-new` |
| `venv/` | no (not portable) | `...\age-gender-model\venv\` |
| training logs / metrics | none exist | - |

`requirements.txt` leaves out torch and torchvision on purpose; install the CUDA-matched
build first.
