# ANPR / licence-plate worker (from Trinetra) - study guide

Source: `C:\projects\trinetra-full-2026-10-05\trinetra\trinetra-ai\app\anpr_worker\` (Trinetra, Drishyam's
sister product, snapshot 2026-10-05). The bundle copy is `project/` in this folder. The original
`C:\projects\licence plate` prototype no longer exists on disk; its only trace here is `anpr_engine.py`
(see "Known weaknesses"). Every behavioural claim below cites `file:function`; every number cites the
file it came from. "Code default" means the value in source, "compose" means the value the Trinetra
`docker-compose.yml` `anpr-worker` block sets (the deployed value).

## 1. What it does / status

A per-camera live reader: decode -> vehicle detect + track -> plate detect -> crop restoration ->
two-reader OCR with an Indian-format-constrained decoder -> per-character vote across frames -> tiered
decision -> `POST /api/ai/anpr/sighting` with crop, snapshot, clip and a large `meta` block. A read is
always posted as "a lead, not a verdict" (`worker.py:CameraWorker._post`).

- Status in Trinetra: running in compose as `anpr-worker` (GPU, 3 processes, `ANPR_TARGET_FPS=3`) plus an
  `anpr-trainer` service running `auto_retrain.py` (OCR + calibrator retrain; detector retrain parked).
- Status in Drishyam: NOT integrated. `grep -rilw anpr smart-cam-ai --include=*.py` (excluding `.venv`)
  returns nothing. The only ANPR in Drishyam is UI: `smart-cam-app/src/ai-analytics/components/ANPR/
  ANPRDashboard.jsx` imports `anprMockData`, and `smart-cam-backend/src/utils/featureCatalog.js` lists
  `anpr` with `demo: true` ("Demo: sample data"). Drishyam does not run this model today.

## 2. Pipeline call path, frame by frame

Process level: `worker.py:main` lists cameras with plate reading on (`_enabled_cams`), shards them
(`_container_shard`, `ANPR_SHARD=k/n`, stable hash of monitorId), spawns `ANPR_PROCESSES` processes
(`spawn`, not fork, for CUDA) each running `run_cams`. Each process owns ONE `Models` set (vehicle
detector, plate detector, OCR ensemble, calibrator; about 300 MB VRAM) shared by its camera threads
behind locks, and one thread per camera (`CameraWorker.run`).

| # | Step | Where | What happens |
|---|---|---|---|
| 1 | Decode | `video_source.py:VideoSource._loop`, `open_reader` | Reader order PyAV -> static ffmpeg pipe -> OpenCV. RTSP forced to TCP. Decoded continuously on a thread; only the NEWEST frame is kept. Software decode only (no `cuvid`/hwaccel anywhere in `video_source.py`). `ANPR_DECODE_THREADS` frame threads (HEVC forced single-thread so damage logs are visible). Reconnect back-off 2 s -> 30 s; `epoch` bumps per reconnect. |
| 2 | Damage gate | `video_source.py:_PyAvReader._next_frame` + `CameraWorker.run` | libavcodec log lines ("concealing", "missed N packets", HEVC RPS errors) mark frames corrupt until a key frame or 5 s; the worker skips them for OCR and evidence. |
| 3 | Clock | `video_source.py:PtsClock` | pts -> wall time; RTSP anchored at the live edge; backward jumps = loop point -> tracker reset. |
| 4 | Rate | `CameraWorker.run` | Loop at max(target fps, clip fps); frames go to the clip ring (`clip_recorder.py:ClipRecorder.push`), detection only every `1/target_fps` s. |
| 5 | Scene + motion | `CameraWorker.run`, `CameraWorker._scene` | 160x90 thumbnail: scene-cut test (mean abs diff >= 45 -> reset), motion gate (mean abs diff < 1.0 and no live tracks -> skip), night = EMA(lum) < 60, IR = mean abs(B-R) < 6. |
| 6 | Detector input | `CameraWorker._det_frame`, `worker.py:night_enhance`, `_apply_roi` | At night the detectors see a gamma + CLAHE (YCrCb luma) COPY; optional per-camera ROI blacks out the rest. Crops are always cut from the ORIGINAL frame. |
| 7 | Vehicle detect | `worker.py:Detector.__call__`, `Models.filter_vehicle_dets` | `models/yolov8n.pt` (COCO), conf 0.15 at inference, then per-class floors: car/bus/truck 0.35, motorcycle 0.18, other 0.25. Person class counted only (`ANPR_PEOPLE`), never tracked. |
| 8 | Track | `bytetrack_lite.py:ByteTrackLite.update` | Built as `ByteTrackLite(track_thresh=max(0.5, ANPR_VEHICLE_CONF)=0.5, lost_buffer=ANPR_TRACK_TTL=25, min_hits=2)`; class defaults `match_iou=0.2`, `low_match_iou=0.5`. Constant-velocity Kalman on (cx,cy,w,h), stage-1 Hungarian on high-score dets, stage-2 on low-score dets. Vehicle class re-voted every frame, area-weighted, capped at 12 (`_process`). |
| 9 | Plate detect | `CameraWorker._detect_plates` | `models/best.pt` full frame (conf 0.30) PLUS a batched "native-resolution" pass on vehicle crops narrower than 30 % of frame width (min 40x30, 12 % + 4 px margin). Duplicates merged at IoU > 0.45, higher conf kept. |
| 10 | Geometry gates | `CameraWorker._process` | Drop boxes < 12x6 px, aspect < 1.2 or > 6.5 (7.0 for motorcycle tracks), wider than 35 % of frame, or ending in the top 7 % (OSD band). Burn-in zones (`_in_static_zone`), coloured lettering (`worker.py:_looks_decal`, glyph saturation > 0.45, yellow and blue-cast exempt). Plate with no vehicle box -> "orphan" pseudo-track keyed by 80 px cell. |
| 11 | Crop + quality | `CameraWorker._process`, `worker.py:crop_quality` | Padding 6 % width + 2 px, 12 % height + 2 px. `plate_enhance.assess` then quality = sqrt(min(1, sharp/800)) x min(1, w/120) x blur term x glare term. First 3 crops of a track read at once; later ones queue by quality (max 8 pending), best 1 per frame once mature (4 frames), rest at track end; budget 12 frames per track. |
| 12 | Enhance | `plate_enhance.py:candidates` | Up to 6 variants (fewer when > 2 plates in frame), see section 3. |
| 13 | OCR | `plate_ocr.py:PlateOcrEnsemble.read_many` -> `PlateOcr._distributions` -> `constrained_decode` | Every variant of every plate in the frame in ONE batch per reader; full per-slot softmax read from the ONNX head. |
| 14 | Weight | `CameraWorker._ocr_jobs` | read weight = variant prior x mean char conf x reader weight (1.0 / 0.9) x max(0.2, det conf) x (0.3 + 0.7 x quality). Two-row path adds `read_two_line`. Fragment merge (`_try_merge`, Hamming <= 1 within 4 s). |
| 15 | Vote | `plate_votes.py:TrackVotes.add_frame`, `consensus` | Per-length buckets, per-position weighted char tally; best read per frame full weight, up to 3 others at 0.25. |
| 16 | Decide | `CameraWorker._decide`, `_length_fix`, `_short_confirmable`, `_verify` | Superstring rule, detector-conf gate, confirmed / possible / review (section 5). |
| 17 | Confidence | `calibrator.py:Calibrator.predict_features` or `plate_votes.py:Consensus.confidence` | Learned P(correct) when `models/calibrator.json` loads, else heuristic. |
| 18 | Emit | `CameraWorker._post` -> `Backend.submit` -> `Backend._deliver` | Record on disk via `DiskWriter`, payload to one sender thread, outbox on failure, clip uploaded after post-roll. |

Throughput, measured: `bench_gpu.py` on 120 real 1080p frames (3.93 vehicles/frame): vehicle detect
13.6 ms, plate detect 43.0 ms, OCR ensemble 48.7 ms, total 105 ms mean (p95 204 ms) = 9.5 fps per GPU;
640x360 gave 8.6 fps, so cost tracks vehicles in shot, not resolution. The production worker sustained
about 1.6 fps on one camera end to end (`docs/hld/LOAD_TEST_RESULTS.md`). GPU: RTX A3000 Laptop 12 GB
(`CONTEXT.md` section 1). One process is GIL-bound at about 30-40 predicts/s (`worker.py` comment at
`PROCESSES`), which is why compose runs 3 processes.

## 3. Pre-processing

Detector side: frames go to ultralytics as BGR ndarrays; `Detector` passes no `imgsz`, so the
checkpoint's 640 is used (all three checkpoints record `imgsz=640`, read from their `train_args`);
letterbox, FP16 on CUDA (`ANPR_HALF=1`, `quantize=16` on ultralytics >= 8.4). ONNX path:
`yolo_onnx.py:YoloOnnx._letterbox` (pad 114, RGB, /255, NCHW), class-agnostic `cv2.dnn.NMSBoxes`.

Crop side (`plate_enhance.py:candidates`), all classical OpenCV/numpy:

1. `assess`: Laplacian-variance sharpness, mean lum, std (contrast), saturated fraction (>= 250),
   polarity, cepstral motion-blur (length, angle, z-score), plate-field stats for IR bloom. Flags:
   dark = mean < 70, glare = sat frac > 0.12, blurry = sharpness < 120, low contrast = std < 28,
   motion = cepstral z >= max(3.5, noise floor - 0.6) and length >= 2.5 px.
2. Convert to grey, cubic upscale to height 96 (max 4x). Base variant = the upscaled crop
   (`ANPR_ENH_BASE=resize`; the old gamma+CLAHE base lost in the 2026-09-02 ablation), bilateral denoise
   first when dark, moments deskew when tilt >= 2.5 deg (single-row shapes only).
3. Gated variants with priors: `inverted` 0.9 (light-on-dark), `retinex` 0.9 (dark/glare/flat),
   `blackhat` 0.8 (glare), `rl_tv` 0.95 (motion; Richardson-Lucy + TV, 12 iters), `rl_gauss` 0.85
   (defocus), `unsharp` 0.9 (clean). Dropped by default (`ANPR_ENH_DROP`): `log_clahe`, `wiener`,
   `blind_rl`. IR bloom variants (`bloom_gamma/thin/thresh`, prior 0.85) only behind a strict gate.
   Optional Real-ESRGAN (`ANPR_SR_URL`) is off.
4. `_build_within` keeps base plus the highest priors up to the cap and never computes a variant it
   would drop. Every variant is grey replicated to 3 channels (`_bgr`), so the RGB OCR model is in
   practice fed greyscale.
5. Two-row split (`split_two_line`): projection profile, two ink bands each >= 18 % height, crop
   aspect <= 2.4.

## 4. Models, input tensors, runtime

| Role | File (active) | Architecture | Input | Runtime |
|---|---|---|---|---|
| Vehicle detector | `models/yolov8n.pt` (NOT shipped in bundle) | YOLOv8n, COCO 80 classes, uses ids 2/3/5/7 (+person count) | BGR letterbox 640, FP16 | ultralytics/torch CUDA; ONNX fallback |
| Plate detector | `models/best.pt` (compose `ANPR_PLATE_MODEL` default) | YOLOv8n, 1 class `License_Plate`; checkpoint saved at epoch 21 with optimizer state (hence 24.5 MB) | 640 letterbox, full frame + vehicle crops | same |
| Plate detector (alt) | `models/best_ft.pt` | YOLOv8n fine-tuned 2026-09-11 from best.pt, 30 ep, freeze 4, lr0 0.002 | 640 | only if `ANPR_PLATE_MODEL` points at it |
| OCR primary | `models/ocr/model.onnx` + `plate_config.yaml` | fast-plate-ocr CCT-S v2 fine-tune (5 conv tokenizer, 5 transformer layers, 2 heads, dim 112, DyT norm; `ocr_base/cct_s_v2_global_model_config.yaml`) | `input` uint8 NHWC `[N,64,128,3]` (verified from the ONNX graph; opset 15, tf2onnx), 1/255 rescale inside the graph | onnxruntime, shared session behind a lock, `ANPR_OCR_THREADS=4` |
| OCR second reader | hub `cct-xs-v2-global-model` (downloaded to `~/.cache/fast-plate-ocr` at first use; NOT shipped) | CCT-XS v2, 10 x 37 | same | same, weight 0.9 |
| Calibrator | `models/calibrator.json` | logistic regression, 23 features | `meta.features` | numpy |

OCR output `plate` float `[N,10,37]`: 10 slots (`max_plate_slots: 10`), alphabet `0-9A-Z_` (37),
pad `_`, `keep_aspect_ratio: false`, linear resize, `image_color_mode: rgb` (`models/ocr/plate_config.yaml`).
`plate_ocr.py:PlateOcr.__init__` loads the fine-tuned dir first, so the PRIMARY reader today is the
fine-tune, not the hub model that `MODEL_REGISTRY.json` (dated 2026-09-02) still names as `ocr_primary`.
`PlateOcr._prep` converts BGR->RGB; `_distributions` softmaxes if the export emits logits.

## 5. Post-processing, voting, format rules, thresholds

Constrained decode (`plate_ocr.py:constrained_decode`): for each Indian template of plausible length
(greedy length -1..+1, 8..11) it forces L slots to letters and D slots to digits, with look-alike
probability sharing at 0.7 (`ANPR_LOOKALIKE_SHARE`: a "Z" in a digit slot lends 0.7 of its mass to
"2"). Score = sum log p + length (pad-position) term + template log-prior + state-code prior (best valid
pair among the top-3 letters of slots 0-1, else -4) + one-digit-district penalty (-5 for states whose
RTO codes are always two digits) + per-camera registration-code prior (`plate_rules.py:code_log_prior`,
log-odds of codes confirmed on that camera, clipped +-2, needs >= 10 confirmed). The constrained text is
accepted only if valid and within 6 nats of the greedy read (`_CONSTRAIN_MAX_PENALTY`); otherwise
`validate_or_correct(greedy)`. Raw greedy text is kept separately (`meta.ocr.raw_top`).

Format tables (`plate_formats.json`, loaded by `plate_rules.py:load_formats`; data, not code):

- 40 state/UT codes (old and new kept: OR/OD, UA/UK, TS/TG).
- Templates: 8 `LLDLDDDD`, `LLDDDDDD`; 9 `LLDLLDDDD`, `LLDDLDDDD`, `DDBHDDDDL`; 10 `LLDDLLDDDD`,
  `DDBHDDDDLL`, `LLDLLLDDDD`; 11 `LLDDLLLDDDD`. No 7-char template on purpose.
- Template log-priors: `LLDDLLDDDD` 0.0 (standard, e.g. XX00XX0000), `LLDDLDDDD` -0.3, Bharat series
  -1.2 / -1.5, `LLDDDDDD` -2.0, rarer shapes -1.5 to -2.5.
- Position-aware confusions: to digit `O Q D->0, I L->1, Z->2, S->5, B->8, G->6, T->7, A->4`; to letter
  `0->O, 1->I, 2->Z, 5->S, 8->B, 6->G, 4->A, 7->T`; whole-code fixes `state_fix` (e.g. WH->MH).
- Structural regexes stay in code: `PLATE_RE` = `LL D{1,2} L{1,3} DDDD` or `LL DD DDDD`; `BH_RE`.
  `is_valid_plate` never corrects; `validate_or_correct` / `correct_plate` do (`plate_rules.py`).

Voting (`plate_votes.py:TrackVotes`): each char adds `weight x max(0.05, p_char)` to its column in the
bucket of its length; consensus = heaviest bucket, column argmax; agreement = mean winner share.
`Consensus.longer` reports a valid read one char longer that is the consensus with one insertion
(look-alike classes `0OQD, 1IL, 2Z, 5S, 8B, 6GCE, 4A, 7T`).

Decision (`worker.py:CameraWorker._decide`), deployed values (compose / code):

| Gate | Rule |
|---|---|
| Length fix | `_length_fix`: if consensus < 10 chars and a valid one-longer read weighs >= 0.05 x bucket, post the longer one, unless the raw OCR read is already a valid short plate (4 Oct 2026 fix) |
| Detector | mean plate-detector conf over the track >= 0.45, else never posted |
| Confirmed, votes | frames >= 3 and agreement >= `ANPR_MIN_AGREEMENT` (compose 0.7, code default 0.9; 8-char: 0.95) |
| Confirmed, 2-frame | strict-valid, 2 frames, agreement >= 0.9, top whole-string weight >= 0.9 |
| Short hold | < 10 chars and not BH: readers' mean char agreement >= 0.9 and top weight >= 0.6, else demoted |
| Verifier | `_verify` render-and-compare; `ANPR_VERIFY_MIN` default 0 -> returns immediately (verifier does not run at all) |
| Confidence floor | confirmed needs conf >= 0.7 (8-char 0.8) |
| Possible (track end) | strict-valid, top weight >= 0.5, (>= 2 frames, agree >= 0.7) or (1 frame, >= 2 reads, agree >= 0.8) or `possible_single` (1 frame, >= 10 chars or BH, agree >= 0.95, conf >= 0.8, weight >= 0.3); conf >= 0.55 |
| Dedup | same plate on a camera within 120 s dropped unless a confirmed upgrades a possible |

Anything failing goes to `data/review/` per `ANPR_REVIEW_POLICY=valid` (`_review_reason`): the relabel
queue that feeds training.

## 6. Calibration / abstain

`calibrator.py`: standardised inputs, class-balanced, L2 = 1.0, 600 GD iterations, lr 0.2, 5-fold CV
(`cross_validate`, seed 7). Features (contract, `FEATURES`): agreement, mean_conf, min_conf,
readers_agree, n_frames, reads, crop_h, crop_w, sharpness, motion_len, has_motion, is_dark, is_glare,
inverted, low_contrast, plate_len, template_prior, verify_score, quality, alt_margin, two_row, orphan,
det_conf (log1p on the heavy-tailed ones). A file whose feature list differs is ignored.

Shipped fit (`models/calibrator.json` meta): trained 2026-10-05, n = 679 (606 positive; 352 human,
327 auto), CV AUC 0.77 judged on human labels vs 0.553 for the heuristic, CV acc 0.722. Largest
coefficients: mean_conf +1.21, readers_agree +0.86, n_frames +0.73, crop_h +0.62, two_row +0.58,
agreement +0.52; `verify_score` coef 0.0 with std 1e-6 (dead, because the verifier is off).
Fallback heuristic (`plate_votes.py:Consensus.confidence`): agreement x sqrt(mean_conf) x
min(1, frames / 3). Abstain = not posting: below the floors the read is written to review, not the
console. The calibrator is hot-reloaded by `Models.watch` (60 s mtime/size poll).

## 7. Output events

`POST /api/ai/anpr/sighting` (via the backend; 2 tries, 401 re-login, 413 -> post without images then
multipart media, 5xx/429 -> `data/outbox/`, 400/422 -> `outbox/rejected`; `Backend._deliver`). Payload
built in `CameraWorker._post`:

- top level: `plate` (normalised), `raw` (heaviest uncorrected OCR read), `camera_code`, `camera_name`,
  `test` (true for `demo*` sources), `confidence`, `latitude`, `longitude`, `ts` (evidence-frame time),
  `bbox`, `vehicle_type` (honest "vehicle" when the detector has no auto-rickshaw class),
  `snapshot_b64` (vehicle, <= 640 px), `plate_b64` (<= 320 px).
- `meta`: `tier` (confirmed/possible) + `tier_note`, `features` (the 23 + tier/rule/top_weight/
  length_fix), `confidence_source`, `frames`, `reads`, `agreement`, `consensus`, `alternatives`,
  `winning_variants`, `assessment`, `verify`, `readers`, `readers_agree`, `vehicle_type_raw`,
  `vehicle_colour`, `scene` {lum, night, ir}, `ocr` {raw_top, raw_alternatives, consensus, normalized,
  rules_changed}, `length_fix`, `models` (sha256 fingerprints + registry tags), `track`
  {uid, tracker_id, first/last frame, orphan, merged, n_reads}, `latency` {first_read_to_post_s,
  enh_ms, ocr_ms}, `snapshot_box`, `pipeline_version` = `bytetrack-enhance-v5`.
- Then `POST /api/ai/anpr/sighting/{id}/media` for the clip (6 s pre, 4 s post, H.264, 1280 wide,
  CRF 20, replayed at 25 fps; policy `ANPR_CLIP_POLICY`).
- On disk: `data/records/<date>/<camera>/<HHMMSS>_<plate>.{jpg,_plate.jpg,_frame.jpg,json,mp4}`;
  the JSON carries a YOLO-normalised plate box (detector training data).
- Side channels: live boxes to `/api/internal/ai/overlay` every 0.33 s (`_publish_overlay`, ephemeral);
  camera health to `/api/ai/anpr/camera-health` every 60 s; pursuit priority poll every 30 s
  (fps x2 capped at 6 on boosted cameras, `_apply_boost`).

## 8. Model registry

`model_registry.py` (stdlib only): `file_fingerprint` (name, bytes, first 12 hex of sha256, cached by
mtime/size), `describe_models`, `compact` (goes into `meta.models`), `summary_line`. Facts come from
`models/MODEL_REGISTRY.json` (schema 1, updated 2026-09-02). Entries and version tags: `yolov8n.pt`
`coco-8.0.0`; `best.pt` `roboflow-lpr-v4-e25`; `cct-s-v2-global-model` `v2-global`;
`cct-xs-v2-global-model` `v2-global`; `calibrator.json` `logistic-v1`; `ocr_base` `v2-global-keras`.
Stale points: no entry for `best_ft.pt` or for the fine-tuned `models/ocr/model.onnx` (the active
primary reader); the calibrator note quotes the first fit (347 labels, AUC 0.778), the shipped file is
a later fit (679 labels, AUC 0.77). Licences per registry: Ultralytics weights AGPL-3.0, Roboflow
dataset CC BY 4.0, fast-plate-ocr MIT. AGPL matters for any closed embedded product.

## 9. Training recipe + data

- OCR (`train_ocr.py`): base `ocr_base/cct_s_v2_global.keras`; `fast-plate-ocr train` with lr 1e-4,
  30 epochs, batch 32, warm-up 0.1, early stop 10; export ONNX; compare against the DEPLOYED model on
  `data/train/ocr/val.csv`; promote only if exact match improves (or ties with better char acc), no
  scenario regresses > 0.05, and val >= 20 human crops (`ANPR_TRAIN_MIN_VAL`).
- Data (`export_labels.py`): human labels weight 1.0, auto labels (conf >= 0.9, agreement >= 0.95)
  0.5; group split BY PLATE (`tests/test_export_split.py`); synthetic plates from `synth_plates.py`
  (15 per trainable label, max 5000; styles include hand-painted and IR bloom), train only.
- Detector (`train_detector.py`): from `best.pt`, imgsz 640, 40 epochs (trainer passes 30), batch 16,
  lr0 0.002, lrf 0.05, freeze 4, fliplr 0, degrees 5, scale 0.3; promote to `best_ft.pt` if mAP50 on
  "our" val improves. PARKED in compose (`ANPR_TRAIN_DET_MIN_IMAGES=1000000000`) because the training
  boxes are the reader's own detections, which is circular.
- Vehicle detector (`train_vehicle_detector.py`): IDD + pseudo-labelled frames; promote to
  `vehicle_ft.pt` only if shared classes hold and autorickshaw AP50 >= 0.40. Never run (needs IDD).
- Calibrator (`train_calibrator.py`) refits every trainer cycle.
- Loop (`auto_retrain.py:cycle`): every 15 min check labels; train when weighted labels >= 40 and
  >= 20 new or 24 h passed (compose); worker hot-swaps promoted files (`Models.watch`).
- Base plate-detector data: Roboflow "License Plate Recognition" v4, ~24k mixed-country web images,
  25 epochs, batch 64 (checkpoint `train_args`, `MODEL_REGISTRY.json`). No Indian fine-tune.

## 10. Measured results

| What | Number | Source |
|---|---|---|
| Plate detector `best.pt`, Roboflow val split | mAP50 0.981, mAP50-95 0.686, P 0.977, R 0.960 | checkpoint metrics, `MODEL_REGISTRY.json` |
| `best_ft.pt` on its own self-labelled val | mAP50 0.976, mAP50-95 0.668 | checkpoint metrics (circular, not accuracy) |
| Detector on deployment feeds, independent GT | NOT MEASURED | `experiments/registry.yaml`, `docs/ANPR_EVALUATION.md` section 7 |
| Funnel | about 1 in 4 vehicles gets a plate box (476 vehicles, 3 Sep) | `docs/ai/measurements/FORENSIC_MEASUREMENTS_2026-10.md` |
| OCR fine-tune promote gate | val exact 0.731 -> 0.769, char 0.969 -> 0.973, on 26 val crops (= 19/26 -> 20/26) | `models/ocr/MODEL_CARD.txt` |
| OCR single crop, held-out | 83.4 % exact (78.4-87.4), n = 265 | FORENSIC_MEASUREMENTS |
| Single-frame ablation (2026-09-02) | resize-only 54.4 %, gamma+CLAHE 51.7 %, best valid 56.4 %, with second reader 67.1 %, ensemble oracle 81.2 % | `docs/ANPR_EVALUATION.md` section 7, `plate_enhance.py` comment |
| End to end, posted plate exact | 72.0 % (61.4-80.5), 82 unique passages, "sure" labels; slices on 124 sure+guess: 9-char 23.8 %, 10-char 75.7 %, two-row 45.5 % | FORENSIC_MEASUREMENTS |
| After superstring fix | 81.7 % offline replay (n = 82); live 9/10 sure (n too small to quote) | FORENSIC_MEASUREMENTS |
| Human labels 2026-09-02 | 66 % exact (150 judged, 58-73), CER 0.083, dropped chars 47 % of errors | `docs/ANPR_EVALUATION.md` |
| Vehicle class precision | car 98.2 %, two-wheeler 90.2 %, bus/truck 42.6 % | FORENSIC_MEASUREMENTS |
| Night (one night) | reads / (reads + rejects) 4.1 % vs 2.8 % by day; IR bloom variants: 55/120 rule-valid on and off (no gain) | `CONTEXT.md` section 6f |
| Plate size on live feeds | median 80x42 px, many about 7 px/char | `CONTEXT.md` section 3 |
| Calibrator | CV AUC 0.77 vs heuristic 0.553 | `models/calibrator.json` |

Every `metrics:` field in `experiments/registry.yaml` is literally `NOT MEASURED` by design; recorded
runs live in `data/experiments/` (not shipped, not read).

## 11. Knobs (code default; compose value where it differs)

| Env var | Default | Effect | File |
|---|---|---|---|
| `ANPR_ENGINE` | auto | torch, else ONNX (`<model>.onnx` beside the .pt) | worker.py:Detector |
| `ANPR_DEVICE` / `ANPR_HALF` | 0 / 1 | GPU index or cpu; FP16 | worker.py:Detector |
| `ANPR_VEHICLE_MODEL` / `ANPR_PLATE_MODEL` | yolov8n.pt / best.pt | weights | worker.py |
| `ANPR_OCR_MODEL_DIR` / `ANPR_OCR_READERS` | models/ocr / `primary,cct-xs-v2-global-model` | fine-tune dir; ensemble | plate_ocr.py |
| `ANPR_TARGET_FPS` | 8 (compose 3) | detections/s/camera | worker.py |
| `ANPR_MOTION_GATE` / `ANPR_MOTION_MIN` | 1 / 1.0 | skip static frames | CameraWorker.run |
| `ANPR_VEHICLE_CONF_MIN`, `_VEHICLE_CONF`, `_MOTO_CONF`, `_AUTO_CONF` | 0.15, 0.35, 0.18, 0.25 | vehicle floors | Models.filter_vehicle_dets |
| `ANPR_PLATE_CONF` | 0.30 | plate detector conf | Models |
| `ANPR_NATIVE_RES_DET` / `_NATIVE_MAX_FRAC` | 1 / 0.30 | second plate pass on vehicle crops | _detect_plates |
| `ANPR_MIN_ASPECT`/`_MAX_ASPECT`/`_MAX_ASPECT_MOTO`/`_OSD_BAND` | 1.2/6.5/7.0/0.07 | plate geometry | _process |
| `ANPR_PLATE_MAX_SAT`, `ANPR_STATIC_TTL` | 0.45, 1800 | decal + burn-in filters | _looks_decal, _in_static_zone |
| `ANPR_NIGHT_LUM` / `_NIGHT_DET_ENHANCE` | 60 / 1 | night pre-pass for detectors | _det_frame |
| `ANPR_ENH_MAX_VARIANTS`, `_ENH_BASE`, `_ENH_DROP` | 6, resize, log_clahe,wiener,blind_rl | variant budget | plate_enhance.py |
| `ANPR_ENH_TARGET_H`, `_ENH_MOTION_Z`, `_ENH_BLOOM` | 96, 3.5, 1 | upscale height, deblur trust, IR path | plate_enhance.py |
| `ANPR_FAST_READS`/`_MAX_READS`/`_MAX_PENDING`/`_TRACK_TTL` | 3/12/8/25 | OCR budget per track | worker.py |
| `ANPR_MIN_VOTES`, `ANPR_MIN_AGREEMENT`, `_SHORT` | 3, 0.9 (compose 0.7), 0.95 | confirm gates | _decide |
| `ANPR_MIN_CONF`, `_MIN_CONF_SHORT`, `_MIN_DET_CONF` | 0.7, 0.8, 0.45 | confidence floors | _decide |
| `ANPR_LEN_SWITCH`, `_LEN_SWITCH_RATIO` | 1, 0.05 | superstring rule | _length_fix |
| `ANPR_POSSIBLE*`, `_POSSIBLE_SINGLE*` | 1, 0.55/0.5/0.7/0.8; 0.95/0.8/0.3 | possible tier | _decide |
| `ANPR_VERIFY_MIN`, `_VERIFY_MARGIN` | 0, 0.10 | verifier gate (0 = off) | _verify |
| `ANPR_LOOKALIKE_SHARE` | 0.7 | confusion sharing in decode | plate_ocr.py |
| `ANPR_PLATE_FORMATS` | plate_formats.json | format tables | plate_rules.py |
| `ANPR_CALIBRATOR` | models/calibrator.json | learned confidence | worker.py |
| `ANPR_PROCESSES`, `ANPR_MAX_CAMERAS`, `ANPR_SHARD` | 1 (3), 3 (60), 0/1 | scale-out | main |
| `ANPR_*_THREADS` | math 2, cv 2, torch 4, ocr 4, decode 2 (compose 1) | thread budgets (set before imports) | worker.py |
| `ANPR_CLIP_POLICY`, `ANPR_REVIEW_POLICY` | all, valid | evidence and relabel volume | worker.py |
| `ANPR_ROI` / `ANPR_ROI_FILE` | none | per-camera detector mask | RoiTable |

## 12. Known weaknesses + concrete improvement ideas for embedded deployment

Weaknesses that the code and measurements show:

- The detector, not the reader, is the first loss: about 1 in 4 vehicles gets a plate box; `best.pt`
  never saw Indian two-row bike plates or Gujarat fonts; no independent detector GT exists.
- 10 OCR slots: an 11-char plate cannot be read (E4 planned). 9-char plates read far worse (23.8 %).
- The "fine-tune" promotion rests on 26 val crops; a one-crop change is inside noise.
- Verifier is off, so `verify_score` is a dead calibrator feature.
- Pure Python per-frame logic, GIL-bound; OCR on CPU in the measured setup (`CONTEXT.md` section 5:
  enhance about 3 ms, OCR about 45 ms per crop). Decode is software.
- The second reader needs a hub download; on an air-gapped box it silently drops out
  (`PlateOcrEnsemble.from_env` prints and continues) and `_short_confirmable` then skips the
  reader-agreement test (one reader = weight gate only).
- `anpr_engine.py` is dead legacy (imports a missing `config` module and PaddleOCR); ignore it.

Concrete ideas, ordered by expected value on an edge box (Jetson Orin / RTX 5070 class):

1. TensorRT for both detectors. `yolo export format=engine half=True` (or `int8=True` with ~500
   frames from `data/records/*_frame.jpg` as calibration), run via `ANPR_ENGINE=onnx` with
   `ANPR_DEVICE=tensorrt` (`yolo_onnx.py:_providers` already selects `TensorrtExecutionProvider`).
   Gate INT8 on `eval_detector.py` recall per height bucket (< 20 px) against a hand-boxed set, not mAP.
2. Plate detection at lower imgsz on vehicle crops only. Plate detect is 43 ms mean, the largest
   detector cost. Run `best` at 320 on the batched vehicle crops (already built in `_detect_plates`) and
   drop the full-frame 640 pass to every Nth frame (`ANPR_IDLE_FULL_EVERY`); measure orphan reads first
   (26-34 % of reads come from the full-frame pass). Longer term, one detector with vehicle + plate
   classes (an unused `weights/yolo26n.pt` sits in the source) removes one pass.
3. OCR batching across cameras. Today each camera thread batches its own frame and the session lock
   serialises cameras. A per-process OCR queue that collects crops from all cameras for a few ms and
   runs one static-shape batch (export with a fixed N, e.g. 16) suits TensorRT/NPUs; the current
   export has a dynamic batch dim. Cut variants to 2-3 (ablation: resize beats gamma+CLAHE; most of the
   gain is the second reader), and since variants are grey, a 1-channel CCT is a free saving.
4. Ship the second reader inside `models/` (pin cct-xs-v2 ONNX) so edge boxes are deterministic.
5. NVDEC/V4L2 hardware decode in `video_source.py` (`h264_cuvid`/`hevc_cuvid`, or GStreamer on
   Jetson) and substream motion gating; `CONTEXT.md` section 6d names decode as the dominant cost at scale.
6. Night/IR: measured, more deblurring does not help (bloom A/B 55/120 both ways). The levers are the
   reader (label IR crops, `ir_bloom` synthetic share) and the camera (shutter <= 1/500 s, IR gain low
   enough that retro-reflective plates do not bloom). Move `night_enhance` (38 ms per 1080p frame, CPU)
   to the GPU or run it on the downscaled detector input.
7. Re-identification. Tracks are short (median 1 detection frame on the main provider feed) and colour agrees
   only 31 % of the time; add a small vehicle ReID embedding on the vehicle crop for cross-camera linking
   and fragment merging. This could share the body-ReID work in Drishyam's journey platform.
8. Region formats. Indian rules are data (`plate_formats.json`) but the decoder assumes L/D templates
   and a Latin 37-char alphabet; another region needs its own templates, codes and priors, and a
   non-Latin script needs a new OCR head and alphabet. Keep one formats file per region and select by
   tenant/camera.
9. Close the active-learning loop properly (`auto_retrain.py`). Prioritise review items by uncertainty
   (low `alt_margin`, `readers_agree` < 0.9, length-fix cases, night/IR) instead of `valid`-only; have
   officers BOX missed plates so the detector retrain gets independent GT and can be un-parked; raise
   `ANPR_TRAIN_MIN_VAL` to >= 100 and require the Wilson interval to move, not the point.
10. Long term, port the frame loop to DeepStream (nvinfer for both detectors, nvtracker, OCR as a
    secondary GIE), keeping `plate_votes`/`plate_rules`/`calibrator` as a small Python or C++
    post-processor per track; this removes the GIL ceiling.

## 13. How to run / test (read-only study; nothing here was executed)

- Unit tests (pure logic, no models/backend): `python -m pytest tests -q` from `project/`.
  12 files, about 150 tests: `test_plate_rules.py` (23), `test_worker_units.py` (24),
  `test_export_split.py` (23), `test_metrics.py` (19), `test_video_source_pts.py` (19),
  `test_plate_votes.py` (11), `test_analysis_heartbeat.py` (11), others for OCR lock, enhance budget,
  clip idle, export prune, rehearsal parsing.
- Self-tests: `python plate_votes.py`, `python bytetrack_lite.py`, `python plate_enhance.py`.
- Dry run on one source (no backend): `ANPR_DRY_RUN=1 ANPR_MAX_CAMERAS=1 ANPR_SOURCES=name=<url>
  python -u worker.py` inside the worker image (`Dockerfile`: `FROM drisyam-face-reconstruct:latest` +
  `ultralytics>=8.3,<9`, `fast-plate-ocr[onnx]>=1.1`, `imageio-ffmpeg`, optional PyAV).
  Needs `models/yolov8n.pt` (not shipped) and network for the hub second reader.
- Evaluation: `eval_labels.py` (human-label scorecard, Wilson CI, ECE, sweeps), `eval_e2e.py` (worker on
  a clip vs human GT), `eval_detector.py` (independent boxes only), `ablation_preprocess.py`,
  `eval_night.py`, `bench_gpu.py`; record runs with `run_experiment.py`.

## 14. Files in this folder

Shipped under `project/` (from the source path above): all `*.py` (worker, decoder, tracker, enhance,
OCR, rules, votes, verify, calibrator, registry, training, eval, retention/export, rehearsal),
`README.md`, `CONTEXT.md`, `Dockerfile`, `Dockerfile.prod`, `Dockerfile.train`, `requirements-dev.txt`,
`experiments/{README.md,registry.yaml}`, `tests/`, `plate_formats.json`, and in `models/`:
`best.pt` (24.5 MB), `best_ft.pt` (6.2 MB), `calibrator.json`, `MODEL_REGISTRY.json`,
`ocr/{model.onnx (4.9 MB), plate_config.yaml, MODEL_CARD.txt}`,
`ocr_base/{cct_s_v2_global.keras (17.7 MB), cct_s_v2_global_model_config.yaml,
cct_s_v2_global_plate_config.yaml}`. Default login and provider-address values in the code are
redacted (`<redacted>`); set them by env.

Not shipped: `models/yolov8n.pt` (stock Ultralytics COCO, required by the worker), `weights/yolo26n.pt`
(unused by any script), the fast-plate-ocr hub models in `~/.cache/fast-plate-ocr/`, `data/` (records,
review, labels, train sets, experiment records), `export/`, `sighting_ts.csv`. Measurement docs cited
above live outside the worker folder in the Trinetra repo: `trinetra-ai/docs/ANPR_EVALUATION.md`,
`trinetra-ai/docs/ANPR_SYSTEM.md`, `docs/ai/measurements/FORENSIC_MEASUREMENTS_2026-10.md`,
`docs/hld/LOAD_TEST_RESULTS.md`.
