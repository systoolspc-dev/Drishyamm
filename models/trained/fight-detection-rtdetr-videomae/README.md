# Fight detection: RT-DETR-L + ByteTrack + VideoMAE (3-class)

Study guide for the in-house fight/violence detector. Every behavioural claim cites
`v12.py:<function or line>` (the script in `project/`). Numbers marked *estimate* are
published or back-of-envelope figures, not measurements on Drishyam hardware.

## 1. What it does / status

A single offline Python script (`project/v12.py`, 906 lines) that reads one video file,
finds and tracks people, computes cheap "suspicion" signals, and only when suspicion is
high runs a VideoMAE video transformer that classifies a 16-frame clip as
**FIGHT / NORMAL / CROWD**. It writes an annotated MP4 and a per-frame feature CSV.

- Status: research prototype. Single video, single process, synchronous loop. No RTSP
  handling, no alert/event API, no multi-camera support.
- Integration with Drishyam: **not integrated.** A grep of `smart-cam-ai` for
  `videomae|fight` finds only unrelated comments ("fighting over the same session") in the
  face pipeline. The web console has an Aggression page, but it is demo-only:
  `smart-cam-app/src/ai-analytics/components/Aggression/aggressionIncidentData.js` holds static
  incidents and `AggressionLiveFeed.jsx` draws hard-coded overlay boxes on an optional demo
  clip. `smart-cam-backend/src/controllers/adminAccounts.controller.js` (line 66) maps event
  types `aggression|fight|violence` to the `aggression` feature key, but nothing produces such events.
- Accuracy: **never measured** (no eval set, no metrics file, no training logs).

## 2. Pipeline call path

```
__main__ (v12.py:904)  -> run_pipeline(video_path)                       v12.py:666
  load_models(device)                                                     v12.py:85
  loop per frame (cv2.VideoCapture.read)                                  v12.py:717
    low-light CLAHE if mean gray < 60                                     v12.py:723-729
    clean_frame = frame.copy()        (buffer copy, no overlays)          v12.py:738
    detector_model.track(... bytetrack_cctv.yaml ...)                     v12.py:741
    get_tracks_from_yolo_track_result -> [TrackObj]                       v12.py:121
    draw person boxes + IDs on `frame`                                    v12.py:751-758
    is_mobile_closeup (avg box area > 15% of frame and >= 2 people)       v12.py:767
    InteractionTracker.update / compute_proximity / compute_overlap       v12.py:156,191,214
    get_smart_roi_bboxes (pair clustering -> ROI boxes)                   v12.py:335
    every 2nd frame: align_frames + compute_motion_and_chaos per ROI      v12.py:238,276
    compute_suspicion -> 0..1                                             v12.py:318
    frame_buffer.append(clean_frame)                                      v12.py:795
    gate: suspicious AND 0.5 s cooldown AND buffer >= 16                  v12.py:799-802
      classify_roi(full frame) + classify_roi(each ROI)                   v12.py:469, 829-838
        get_peak_motion_indices -> 16 indices                             v12.py:437
      pick most "threatening" result (threat_score)                       v12.py:816
      TemporalVoter.update / get_result (+ is_confirmed_fight)            v12.py:508, 70
    else: confidence decay                                                v12.py:864-871
    draw_hud -> VideoWriter.write -> optional cv2.imshow                  v12.py:584, 881-891
```

## 3. Pre-processing

**Per frame (before anything else)** - `run_pipeline` lines 723-729: if the mean grey level
is below 60, CLAHE (clipLimit 2.0, 8x8 tiles) is applied to the L channel in LAB space. The
enhanced frame is what both the detector and the clip buffer see.

**Detector input** - `detector_model.track(..., imgsz=YOLO_INFER_SIZE)` with
`YOLO_INFER_SIZE = 1280` (line 47). Note: the task brief said 640; the code uses **1280**.
Ultralytics' `RTDETRPredictor.pre_transform` uses `LetterBox(imgsz, auto=False, scale_fill=True)`,
so a 16:9 frame is **stretched** (not padded) to 1280x1280.

**Clip buffer** - `frame_buffer = deque(maxlen=max(16, int(fps * 2.0)))` (line 691), holding
**full-resolution clean frames** of the whole scene (not per-track crops). At 25-29 fps that
is 50-58 frames; `fps` is `int(CAP_PROP_FPS)`, so 29.97 becomes 29 (line 675). The buffer
slides every frame; crops are cut only at classification time.

**ROI (crop) construction** - `get_smart_roi_bboxes` (line 335):
1. One person: that box padded by 50 px (line 347).
2. Two or more: every pair gets `intensity = IoU + avg_size / dist` (line 367); pairs sorted
   high to low; greedy union-find merges a pair when `IoU > iou_thresh` or
   `dist < avg_size * dist_thresh` (CCTV: 0.0 / 1.5; mobile close-up: 0.15 / 0.5, lines 374-375),
   capped at 5 people per cluster (line 377). `size` = mean of box width and height (`TrackObj`, line 117).
3. Only clusters of >= 2 people become ROIs; if none, the single highest-intensity pair is used
   even if they are far apart (lines 400-402).
4. Each cluster box is padded by 60% of its width/height (`CROP_PAD_RATIO`, line 40) and clipped.
   If either side is under 224 px the box is **replaced** by a 224x224 square around its
   centre (lines 421-427) - this can also shrink the side that was already large.
5. In mobile close-up mode no ROIs are used at classification time, full frame only (line 809).

**Frame sampling (temporal stride)** - `get_peak_motion_indices` (line 437): every buffered
frame is cropped to the ROI, resized to 80x80 grey, and absolute frame differences are
computed; the frame with peak difference becomes the centre of a window of
`min(len(buffer), 50)` frames, from which 16 indices are taken with `np.linspace`
(stride about 3.3 frames, about 1.7-2 s at 25-29 fps). The 50 is hard-coded, so at 50 fps the
window covers only 1 s, despite the comment that the model was trained on about 2 s.

**VideoMAE image processor** (`videomae-best-3class/preprocessor_config.json`, applied in
`classify_roi` line 488): BGR to RGB PIL; resize shortest edge to 224 (resample 2 = bilinear);
**centre-crop 224x224**; rescale by 1/255; normalise with ImageNet mean
`[0.485, 0.456, 0.406]`, std `[0.229, 0.224, 0.225]`. Result: `pixel_values` of shape
`(1, 16, 3, 224, 224)`, float32. The centre crop throws away the sides of any non-square input:
a 16:9 full frame keeps only the middle 56% of its width.

## 4. Models, input tensors, runtime

| | RT-DETR-L (person detector) | VideoMAE-Base (clip classifier) |
|---|---|---|
| File | `rtdetr-l.pt` (stock Ultralytics COCO, not shipped) | `videomae-best-3class/` + `videomae_best_3class.pt` |
| Load | `RTDETR(DETECTOR_MODEL_PATH)` `load_models` line 90 | `VideoMAEForVideoClassification.from_pretrained`, line 94 |
| Input | 1x3x1280x1280 (stretched), every frame | 1x16x3x224x224, per gate x (1 + number of ROIs) |
| Filter | `conf=0.30`, `classes=[0]` (COCO person), lines 21-22, 743 | softmax over 3 logits, line 496 |
| Params | ~32 M (published) | **86,238,723** (counted from state_dict) |
| Cost | ~110 GFLOPs at 640; ~440 GFLOPs at 1280 (*estimate*, 4x pixels) | ~180 GFLOPs per clip (*estimate*, VideoMAE-B 16x224) |

**VideoMAE config** (`config.json`): `model_type videomae`, `hidden_size 768`,
`num_hidden_layers 12`, `num_attention_heads 12`, `intermediate_size 3072`, `hidden_act gelu`,
`image_size 224`, `patch_size 16`, `tubelet_size 2`, `num_frames 16`, `qkv_bias true`,
`use_mean_pooling true` (mean of all tokens -> `fc_norm` LayerNorm -> `classifier` Linear 768->3),
dropout 0.0, `id2label {0: FIGHT, 1: NORMAL, 2: CROWD}`, `problem_type single_label_classification`,
saved with `transformers_version 5.5.3`. Token count = (16/2) x (224/16)^2 = 8 x 196 =
**1568 tokens**. The patch embedding is a 3D conv with weight shape `(768, 3, 2, 16, 16)`.
The `decoder_*` keys are leftovers from MAE pre-training and are unused by the classifier.
Position embeddings are fixed sinusoids generated from the config
(`transformers/models/videomae/modeling_videomae.py`, `get_sinusoid_encoding_table`) and are
**not** in the state_dict.

**How the `.pt` is loaded** - `load_models` lines 93-100: the HF folder is loaded with
`ignore_mismatched_sizes=True` and the script's own label maps, then
`torch.load(videomae_best_3class.pt, weights_only=True)` is applied with
`load_state_dict` (strict by default). Read-only inspection shows the `.pt` is an
OrderedDict of 198 float32 tensors whose keys and values are **bit-identical** to
`model.safetensors` (0 differing tensors). The second load is redundant: it costs 345 MB of
extra disk and load time and changes nothing.

**Runtime** - `device = cuda if available else cpu` (line 667); FP32 everywhere, no autocast,
no batching (each ROI is a separate forward pass, lines 829-838), no `torch.compile`, no ONNX/TRT.
Source venv: Python 3.11.6, torch 2.13.0+cu130, torchvision 0.28.0, transformers 5.14.1,
ultralytics 8.4.115, opencv-python 5.0.0.93.

## 5. Tracking (ByteTrack, `bytetrack_cctv.yaml`)

Invoked through `detector_model.track(persist=True, tracker=BYTETRACK_CONFIG)` (line 741). The
semantics below are from the installed `ultralytics/trackers/byte_tracker.py`; the Hinglish
comments in the yaml are partly wrong (noted).

| Key | Value | What it really does |
|---|---|---|
| `tracker_type` | bytetrack | IoU + Kalman tracker, no appearance ReID |
| `track_high_thresh` | 0.5 | Detections >= 0.5 enter the first association round |
| `track_low_thresh` | 0.1 | Detections in (0.1, 0.5) enter the second round (matched with fixed cost thresh 0.5). Because the detector already drops everything below `conf=0.30`, the effective low band is **0.30-0.5** |
| `new_track_thresh` | 0.6 | An unmatched detection starts a new ID only if score >= 0.6 |
| `track_buffer` | 60 | A lost track is kept for 60 **frames** (2 s at 30 fps, 1.2 s at 50 fps); not scaled by fps in this version |
| `match_thresh` | 0.85 | Max *cost* in round 1, cost = 1 - IoU x score when fused. It is permissive (roughly IoU x score >= 0.15), not "85% overlap" as the yaml comment says |
| `fuse_score` | True | Multiplies IoU similarity by detection score before matching |

Only tracked boxes come back, so `person_count` counts tracks, not raw detections. If a frame has
no IDs, `get_tracks_from_yolo_track_result` falls back to per-frame indices (lines 133-136),
which makes `InteractionTracker` pair keys meaningless for that frame.

## 6. Suspicion gate (cheap signals)

All computed every frame (lines 770-792):

- `compute_proximity` (line 191): min over pairs of centre distance / mean box size ->
  1.0 if < 0.5, 0.7 if < 1.5, 0.3 if < 2.5, else 0.
- `compute_overlap` (line 214): max pairwise IoU.
- `InteractionTracker.update` (line 156): longest time any pair has stayed at ratio < 1.5
  (`CLOSE_RATIO`); pairs are forgotten after 5 frames of absence (`id_grace_frames`).
- `align_frames` (line 238): camera-shake compensation; corners (max 200) outside person boxes on a
  half-size frame, LK flow, RANSAC partial affine, warp the previous frame.
- `compute_motion_and_chaos` (line 276): Farneback flow on each ROI resized to 160x160;
  `motion = mean(|flow|) / 6.0` capped at 1; `chaos = 1 - R` (circular variance of flow angles over
  pixels with |flow| > 0.9). Run every 2nd frame (`FLOW_EVERY_N_FRAMES`), max over ROIs, cached between.
- `compute_suspicion` (line 318): `0.20*[persons>=2] + 0.25*proximity + 0.20*overlap +
  0.15*motion + 0.10*chaos + 0.10*min(interaction_time/0.6, 1)`, clipped to 0..1.

Gate (lines 799-802): `(suspicion >= 0.40 and persons >= 1) or is_mobile_closeup`, and at least
0.5 s since the last classification, and buffer holds >= 16 frames. One person can reach at most
0.25, so in practice two people are needed; two people at ratio < 0.5 already score 0.45 with zero
motion, so **any close pair fires the classifier** about twice a second.

## 7. Post-processing, thresholds, temporal logic

1. **Per-gate candidate pick** (lines 811-840): the full frame is always classified, then every
   ROI. `threat_score(label, conf)` = conf + 3.0 for FIGHT with conf > 0.6 (+2.0 for RIOT,
   +1.0 for CROWD). The highest score wins, so any single crop with FIGHT > 0.6 beats everything.
2. **Stale flush** (lines 845-847): if more than 2.0 s passed since the previous classification,
   the voter history is cleared.
3. **TemporalVoter** (line 508, `max_window=4`): averages the probability vectors of the last 4
   classifications (CCTV) or last 2 (mobile close-up), arg-max of the average.
4. **is_confirmed_fight** (line 70): FIGHT is kept only if its averaged probability >= 0.80; with
   more than 5 people the bar rises by 0.02 per extra person, capped at 0.95. Otherwise the label
   falls back to CROWD if P(CROWD) > 0.15, else NORMAL (line 542).
5. **Idle decay** (lines 864-871): on every non-classifying frame `current_conf *= 0.85`; below
   0.15 the label resets to NORMAL. This is per frame, not per second.
6. **Alarm** - only visual: `draw_hud` (line 650) re-runs `is_confirmed_fight` on the decayed
   confidence and paints "!! FIGHT DETECTED !!". Person boxes turn red while label is FIGHT and
   conf > 0.4 (line 753). Because of per-frame decay, a 0.95 result drops under 0.80 after 2 idle
   frames, so the banner shows for about 1-3 frames out of every ~15 between classifications (flicker).
7. "RIOT" appears in colours and checks but is not a model class; it is dead code.

## 8. Output

- `./fight_detection_output/<name>_v12.mp4` (mp4v, source fps and size; line 686) with HUD, boxes,
  probability bars, suspicion %, magenta crop box ("CROP REGION (fed to model)").
- `./fight_detection_output/<name>_features.csv` (`FeatureLogger`, line 550): one row per frame with
  `frame_num, timestamp_s, person_count, proximity, overlap, motion, chaos, interaction_time,
  suspicion_score, gate_fired, videomae_label, videomae_conf`. The label column is the **raw**
  pre-vote pick. The docstring intends this CSV to train a learned gate (logistic regression/XGBoost).
- Console line per classification; optional `cv2.imshow` window (`SHOW_LIVE_WINDOW = True`, line 51).
- No webhook, no event record, no snapshot/clip export.

## 9. Training recipe and data

**The training script, dataset and logs are not present.** What can be inferred:
- Labels FIGHT/NORMAL/CROWD (`config.json` `id2label`); 16 frames at 224, about 2 s per clip
  ("2 seconds matches training", line 27; comment at lines 458-460).
- Backbone is VideoMAE ViT-B; the starting checkpoint (Kinetics or SSv2, MCG-NJU or other) is not
  recorded in the config. Saved with transformers 5.5.3.
- Code comments mention a `test.py` that sends full frames and a `fit_temperature()` for offline
  calibration (lines 493-495, 827); neither file exists in the source folder.
- `VIDEO_SOURCE` (line 17) defaults to a local Linux path of a downloaded web compilation clip, which
  suggests development on non-CCTV web footage.

## 10. Measured results

No accuracy numbers anywhere. The one recorded run is
`C:\projects\fight detection 3 class\fight detection 3 class\fight_detection_output\fight_0098 2_features.csv`
(not shipped). Stats derived from it (no ground truth, so not accuracy):
- 7,019 frames over 242 s (29 fps timeline), up to 11 people per frame.
- Suspicion >= 0.40 on 1,891 frames (27%); classifier fired 165 times (2.4% of frames, about 0.68/s).
- Raw picks: NORMAL 132, FIGHT 31, CROWD 2. Every FIGHT pick had conf >= 0.86 and 28 of 31 printed as
  1.000 (over-confident softmax). FIGHT picks clustered at 84-107 s, plus 188.8 s and 194.5 s.

## 11. Known weaknesses

1. Optical flow reads `gray` from `frame` **after** person boxes and ID labels are drawn on it
   (line 774 vs 751-758). The bug fixed for the buffer (line 734) still exists for flow; boxes
   that turn red during FIGHT can feed back into motion.
2. Centre crop of non-square inputs (section 3) drops people at the edges of wide ROIs and of the full frame.
3. The 224-px minimum crop rule (lines 421-427) can cut a tall/wide ROI down to 224x224.
4. Max-over-(1 + K) candidates with a +3 bonus for FIGHT > 0.6 raises the false-alarm rate as more
   ROIs are tried; there is no calibration (T = 1.0, line 493).
5. Full-resolution frame buffer: 1080p x 58 frames is about 360 MB per camera; 720p about 160 MB.
6. Detector at 1280 every frame is the dominant cost (~440 GFLOPs *estimate* x 29 fps, about 12.8
   TFLOP/s per camera) - higher than VideoMAE at the observed 0.68 gates/s (~0.25 TFLOP/s with K = 1).
7. Fully synchronous: a gate with 5 ROIs runs 6 sequential VideoMAE passes (~1.1 TFLOPs *estimate*)
   inside the frame loop; `get_peak_motion_indices` also re-resizes the whole buffer for each pass.
8. Per-frame time constants (decay 0.85, `track_buffer 60`, 50-frame window, grace 5 frames) change
   behaviour with fps.
9. CLAHE toggles on and off around mean grey 60, which can produce flow spikes.
10. No ReID; ByteTrack ID swaps in a scuffle reset `InteractionTracker` timers.
11. Licences to check before shipping: Ultralytics RT-DETR weights/code are AGPL-3.0 (checkpoint
    metadata says so); MCG-NJU VideoMAE pre-trained checkpoints are non-commercial (CC BY-NC 4.0) if
    that was the starting point - unknown here.

## 12. Improvement ideas for embedded deployment

- **Reuse Drishyam person tracks.** The platform already runs YOLO person/body tracking
  (zone-guard, head-count). Feed those tracks in and delete RT-DETR; or run RT-DETR/YOLO at 640 on
  every 2nd-3rd frame (about 8-12x less than 1280 every frame).
- **Classify interacting pairs only.** Drop the always-on full-frame pass (line 829) or run it only
  when no ROI exists; batch all ROIs into one `(K, 16, 3, 224, 224)` forward pass.
- **Square, aspect-correct crops.** Pad ROIs to a square (letterbox) before the processor so the
  centre crop removes nothing; store 224-px crops or a 256-px downscaled buffer instead of full frames.
- **FP16 / TensorRT.** Export VideoMAE to ONNX with a fixed `1x16x3x224x224` input and build an
  FP16 TensorRT engine (attention + GELU fuse well); expect roughly 2x+ over FP32 PyTorch
  (*estimate*). INT8 needs calibration on CCTV clips. FP16 weights: ~172 MB vs 345 MB.
- **Fewer frames.** `num_frames 8` gives 784 tokens (under half the FLOPs; attention part about
  4x less). Weights load unchanged (sinusoidal position embeddings) but **must be fine-tuned**.
- **Smaller backbone.** VideoMAE-S (~22 M params) or a VideoMAE V2 distilled small model, fine-tuned
  on the same 3 classes.
- **Distil to a mobile video net.** Use this model as teacher for X3D-S/XS or MoViNet-A0/A2
  (single-digit GFLOPs per clip, published figures) for Jetson/RK3588 class devices.
- **Pose-based alternative.** YOLO-pose/RTMPose keypoints per track, then a skeleton classifier
  (ST-GCN/PoseC3D-lite) on pairs; tiny classifier, robust to clothing/lighting, privacy friendly.
- **Learned gate.** Train the gate on the CSV features (as `FeatureLogger` intends) instead of the
  hand weights in `compute_suspicion`.
- **Decision layer per Drishyam doctrine** (`docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`): detect per
  clip, decide per track pair with K-of-N votes in seconds (not frames), alert once per incident
  transition with cooldown, attach a snapshot/clip; then calibrate (temperature) and measure
  FNIR/FPIR on a labelled CCTV set before any accuracy claim.

## 13. How to run (source machine)

```
cd "C:\projects\fight detection 3 class\fight detection 3 class"
venv\Scripts\python.exe v12.py "path\to\clip.mp4"
```
- Paths are relative (lines 18-25, 44): run from the folder that holds `v12.py`, the yaml, the
  `videomae-best-3class/` folder and the `.pt`. `rtdetr-l.pt` is downloaded by Ultralytics if missing.
- Set `SHOW_LIVE_WINDOW = False` (line 51) when headless; press `q` to stop the window.
- No argument -> `VIDEO_SOURCE` (line 17), a Linux path that does not exist on Windows.
- New environment: `pip install torch torchvision transformers ultralytics opencv-python pillow`
  (versions in section 4). There is no requirements file.

## 14. Files in this folder

| Path | Size (bytes) | Shipped | Source / note |
|---|---|---|---|
| `project/v12.py` | 38,894 | yes | `C:\projects\fight detection 3 class\fight detection 3 class\v12.py` |
| `project/bytetrack_cctv.yaml` | 692 | yes | same folder |
| `project/videomae-best-3class/config.json` | 936 | yes | same folder |
| `project/videomae-best-3class/preprocessor_config.json` | 415 | yes | same folder |
| `project/videomae-best-3class/model.safetensors` | 344,978,836 | yes | same folder |
| `project/videomae_best_3class.pt` | 345,039,311 | yes | identical tensors to the safetensors; removable if line 98-99 are dropped |
| `rtdetr-l.pt` | 66,496,757 | no | stock Ultralytics release (v8.1.25, 2024-03-09, AGPL-3.0); auto-downloads |
| `rtdetr-l-repaired.pt` | 66,437,007 | no | same pickle as `rtdetr-l.pt`, re-zipped; not referenced by v12.py |
| `fight_detection_output/` | ~75 MB | no | one run: `fight_0098 2_v12.mp4` + `_features.csv` |
| `venv/`, `__pycache__/` | - | no | local environment |
