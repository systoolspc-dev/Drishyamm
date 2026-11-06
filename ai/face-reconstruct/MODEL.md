> **Study guide** (written 2026-10-20 for the AI study bundle). Paths in it are relative to that bundle: `code/facerecounstruct/…` = this folder; `weights/…` = `models/face-reconstruct/…`; `../docs/…` = `docs/…`; `../integration/backend` = `backend/`; `../integration/compose` = the root `docker-compose.yml`. Model catalogue: `models/README.md`.

# 05 - Forensic face reconstruction (CodeFormer + Real-ESRGAN)

Source: `smart-cam-ai/app/facerecounstruct/` (the folder name is misspelled in the repo; keep
it, compose builds from that path). Bundle copy: `code/facerecounstruct/` (CodeFormer sample
inputs and asset images are not shipped; `weights/` holds only the README, since weights
download at container start).

## What it does / status

An operator-triggered "Enhance this face" tool. One image in, a set of base64 PNGs out:
the original, three classic-CV enhancement stages, and a GAN reconstruction. It is **not**
part of any live pipeline and never runs on video.

- Status: **live, on-demand.** Container `face-reconstruct` in both compose files
  (port 8002, `gpus: all`, weights volume `face-reconstruct-weights`). Reached only through
  the backend proxy `POST /api/ai/enhance` (`ai.controller.enhanceFace`, feature gate
  `face_watchlist` / `face_detection`).
- UI: `smart-cam-app/src/core/components/EnhanceFaceDialog.jsx`, used from
  `modules/alerts/Alerts.jsx` and `modules/face/FaceLearning.jsx`. The dialog does not
  auto-run; the operator must click Enhance.
- The standalone `frontend/` (Vite + React, `App.jsx`) is the original demo UI. It posts
  to `VITE_API_URL ?? http://127.0.0.1:8001/api/reconstruct` (port 8001 is wrong for the
  container, which listens on 8002). The product does not use it.

> **Hard rule: a reconstructed face must never be used for recognition, enrollment or
> identification.** CodeFormer replaces low-quality facial detail with codebook entries
> learned from FFHQ faces. At low fidelity weight it invents eyes, teeth, skin texture and
> even facial structure that were not in the pixels. The output is a plausible face, not
> evidence. Treat it as an investigative aid for a human viewer only, label it as "AI
> enhanced" wherever it is shown or exported, and keep the original next to it.
> The 2026-05 recognition research reached the same conclusion: no super-resolution in the
> recognition path.

## Call path (file:function)

1. Browser `aiService.enhanceFace(blob, {fidelityWeight=0.5})` -> `POST /api/ai/enhance`
   (multipart `file`, `fidelity_weight`).
2. Backend `ai.controller.enhanceFace`: `multer` memory upload, forwards to
   `${FACE_RECONSTRUCT_BASE}/api/reconstruct` (default `http://face-reconstruct:8002`),
   timeout 30 s, max body 50 MB, returns `{success, data}`. (Its comment says the upstream
   returns `{triage, before, after}`; the real keys are listed under Outputs below.)
3. `backend/app/main.py:reconstruct_face` - checks `content_type` starts with `image/`,
   `0 <= fidelity_weight <= 1`, non-empty body; `decode_upload_image` (`cv2.imdecode`, BGR).
   The pipeline is a lazy singleton (`get_pipeline`), so the first request pays the model load.
4. `backend/app/pipeline.py:FaceReconstructionPipeline.run`:
   `_triage` -> `_forensic_enhancement(iterations=3)` -> smart router -> one of
   `CodeFormerRestorer.restore_pure_sr`, `.restore_aligned`, `.restore`.
5. `CodeFormer/basicsr/archs/codeformer_arch.py:CodeFormer.forward(x, w, adain=True)`.
6. `CodeFormer/facelib/utils/face_restoration_helper.py:FaceRestoreHelper`
   (`get_face_landmarks_5`, `align_warp_face`, `get_inverse_affine`,
   `paste_faces_to_input_image`).

## Pre-processing

- `_triage` (grayscale): blur = variance of Laplacian; noise sigma = 3x3 Laplacian-of-
  Laplacian kernel response (Immerkaer style); JPEG blockiness = mean step across 8-px block
  boundaries minus mean step inside blocks, / 255.
- `_forensic_enhancement`, 3 iterations, each kept as a stage: bilateral filter
  (`d = max(3, 7 - 2i)`, sigmaColor = sigmaSpace = 25), CLAHE on the L channel of LAB
  (`clipLimit=1.2`, 8x8 tiles), Laplacian unsharp with weight `0.15/(i+1)`.
  These stages are returned for display only; they are **not** fed into CodeFormer.
- `FaceRestoreHelper.read_image` upsizes any image whose short side is under 512 px to 512.
- Detection runs on a copy resized so the short side is 640 (`resize=640`), faces with eye
  distance under 5 px are dropped (`eye_dist_threshold=5`).

## Model + tensor + runtime

| Part | Model | Weights (fetched by `docker-entrypoint.sh`) | Size noted in script |
|---|---|---|---|
| Face detector + 5 landmarks | RetinaFace ResNet-50 (`det_model='retinaface_resnet50'`) | `weights/facelib/detection_Resnet50_Final.pth` (CodeFormer v0.1.0 release) | ~110 MB, required |
| Face parsing (paste-back mask) | ParseNet, 512 in / 512 out, 19 classes (`use_parse=True`) | `weights/facelib/parsing_parsenet.pth` | ~85 MB, required |
| Restoration | CodeFormer: VQ autoencoder + 9-layer transformer | `weights/CodeFormer/codeformer.pth` (`params_ema`, `strict=True`) | ~380 MB, required |
| Background / pure SR | Real-ESRGAN x2plus, RRDBNet (64 feat, 23 blocks, grow 32, scale 2) | `weights/realesrgan/RealESRGAN_x2plus.pth` (Real-ESRGAN v0.2.1 release) | ~64 MB, optional |

The entrypoint uses `wget --tries=3 --timeout=60`, skips files already on the volume, deletes
partial files, exits if a required weight fails, and continues without Real-ESRGAN.

CodeFormer configuration in `CodeFormerRestorer.__init__`: `dim_embd=512`,
`codebook_size=1024`, `n_head=8`, `n_layers=9`, `connect_list=['32','64','128','256']`.
Tensor flow for one face:

- Input `1x3x512x512`, RGB, scaled to [0,1] then normalised with mean 0.5 / std 0.5 to [-1,1].
- Encoder down to a `16x16x256` latent (`lq_feat`); flattened to 256 tokens, projected to
  512-d (`feat_emb`), plus a learned position embedding (`latent_size=256`).
- Transformer predicts, for each of the 256 positions, logits over the 1024-entry codebook;
  `topk(1)` picks one code per position; `get_codebook_feat` rebuilds `16x16x256`.
  With `adain=True` the code features are re-normalised to the input's channel statistics.
- Generator decodes back to `1x3x512x512`. At sizes 32/64/128/256 a `Fuse_sft_block` adds
  `w * (dec * scale + shift)` computed from the encoder features. **`w` is the fidelity
  weight**: `w = 0` skips fusion entirely (pure codebook face, most "restored", most
  hallucinated); `w = 1` gives the input features the most influence (closer to the
  original identity, fewer invented details, more residual blur). Default 0.5
  (`DEFAULT_CODEFORMER_WEIGHT`), same as upstream `inference_codeformer.py -w`.
- Output via `tensor2img(min_max=(-1,1))`.

Runtime: PyTorch, CUDA if available else CPU. Image `pytorch/pytorch:2.7.1-cuda12.8-cudnn9-
runtime` (needed for Blackwell sm_120 kernels; older torch fails with "no kernel image",
which the pipeline's `try/except` used to hide by returning the CV stage instead).
Real-ESRGAN runs in fp16 on GPU, tiled (`tile=400, tile_pad=10`). `torch.cuda.empty_cache()`
after every call. Latency: the UI comment says 1-3 s per call; not measured here. Pins:
`realesrgan==0.3.0`, `basicsr==1.4.2`, `facexlib==0.3.0`, `numpy<2`, `opencv-python<4.11`.

## Post-processing & thresholds (real values)

Triage classes (`_classify_*`):

| Signal | mild | moderate | severe |
|---|---|---|---|
| Blur (Laplacian variance) | >= 160 | 60 - 160 | < 60 |
| Noise sigma | <= 10 | 10 - 22 | > 22 |
| Blockiness | <= 0.04 | 0.04 - 0.09 | > 0.09 |
| Overall (1/2/3 points each) | sum < 5 | 5 - 7 | >= 8 |

Smart router in `run`:

1. **Pure SR mode** if blur is `severe` AND compression is `moderate` or `severe`: Real-ESRGAN
   x2 only, no GAN face (the anti-hallucination path). Without Real-ESRGAN it returns the
   original unchanged.
2. **Aligned mode** if `is_cropped_face`: RetinaFace on the centre face; face box area /
   image area > `threshold_ratio = 0.35`. Then `restore_aligned` resizes the whole crop to
   512x512 with `INTER_LINEAR` (no landmark alignment, no aspect preservation), runs
   CodeFormer, and resizes back to the input size.
3. **Scene mode** otherwise (`restore`): Real-ESRGAN x2 on the full frame, detect all faces
   (RetinaFace `conf_threshold=0.8`, `nms_threshold=0.4`), `align_warp_face` (similarity
   transform `estimateAffinePartial2D` LMEDS to the FFHQ 5-point template at 512), CodeFormer
   per face, inverse affine, paste back with a ParseNet soft mask (two 101x101 Gaussian blurs)
   into the upscaled background (`upscale_factor=2` when Real-ESRGAN loaded, else 1).
   No face found: returns the Real-ESRGAN background or the original.

Any exception in the router is caught: `reconstruction_image` becomes CV stage 3 and
`reconstruction_error` is set.

## Temporal/decision logic

None. Single image, stateless, no tracking, no events, no alerts.

## Outputs & consumers

JSON from `/api/reconstruct`: `triage` (blur_variance, blur_level, noise_sigma, noise_level,
compression_blockiness, compression_level, overall_level), `original_image`,
`enhancement_stages[{stage, image}]` (3), `final_enhanced_image` (stage 3),
`reconstruction_image`, `fidelity_weight`, `device`, optional `reconstruction_error`.
All images base64 PNG. Consumer: `EnhanceFaceDialog.jsx` shows `reconstruction_image`
(falls back to `final_enhanced_image`), the triage, and a "Download enhanced" link
(`face-enhanced.png`). Nothing is stored server-side.

## Config knobs

| Knob | Where | Default |
|---|---|---|
| `fidelity_weight` (w) | form field / UI slider | 0.5, range 0..1 |
| `FACE_RECONSTRUCT_BASE` | backend env | `http://face-reconstruct:8002` |
| Proxy timeout / max body | `ai.controller.enhanceFace` | 30 s / 50 MB |
| `threshold_ratio` (crop vs scene) | `is_cropped_face` | 0.35 |
| Detection resize / eye-distance floor | `get_face_landmarks_5` call | 640 / 5 px |
| Triage cut-offs | `_classify_blur/noise/compression` | see table |
| Real-ESRGAN tile | `CodeFormerRestorer.__init__` | 400, pad 10, fp16 on GPU |

## Licence

- **CodeFormer code and weights: S-Lab License 1.0 (`CodeFormer/LICENSE`) - non-commercial
  use only.** "In the event that redistribution and/or use for commercial purpose ... is
  required, please contact the contributor(s)." Shipping this in a paid product (including
  as an optional feature) needs a commercial licence from S-Lab / the authors, or a
  replacement model. The bundled `basicsr` fork and `facelib` live inside the CodeFormer
  tree, whose only licence file is that S-Lab LICENSE (upstream basicsr itself is
  Apache-2.0, but this fork ships no separate notice).
- RetinaFace / ParseNet weights are downloaded from the CodeFormer release, so the same
  question applies to them.
- Real-ESRGAN is BSD-3-Clause upstream (permissive).

## Known weaknesses + improvement ideas

1. **Licence blocker** (above). Options: get an S-Lab commercial licence; or drop the GAN and
   keep only Real-ESRGAN plus the CV stages; or evaluate permissively licensed restorers and
   check each one's weight licence, not only its code licence.
2. **Hallucination is not surfaced in the UI as a warning.** Add a fixed "AI-generated detail,
   not for identification" banner and watermark the downloaded PNG. The download plus the
   Face Learning page means an operator can upload an enhanced image to the watchlist; block
   that path or tag such files.
3. **Aligned mode skips alignment** and squashes non-square crops to 512x512. Detect landmarks
   and warp to the FFHQ template (as scene mode does), then inverse-warp.
4. **The CV stages are cosmetic**: computed every call, shown, not used. Either feed stage 1
   into the GAN (test it) or make them optional to save time.
5. **Single global model, no concurrency control.** Two simultaneous requests share one
   `FaceRestoreHelper` (mutable state: `clean_all`, `det_faces`). Add a lock or a small queue.
6. **No auth on port 8002 and `allow_origins=["*"]`.** Keep it off the public network; only
   the backend should reach it.
7. **No audit trail.** For forensic use, log who enhanced which image with which `w`, and hash
   input and output. (Also: stale torch-2.2.2 comment in requirements; wrong response shape in
   the backend controller comment.)

## How to run/test

- `docker compose -f docker-compose.drisyam-original.yml up -d face-reconstruct` (first start
  downloads about 640 MB of weights); `GET :8002/health` -> `{"status":"ok"}`.
- `curl -F file=@face.jpg -F fidelity_weight=0.7 http://localhost:8002/api/reconstruct`;
  check `device` is `cuda:0` and no `reconstruction_error`. In the product: an alert with a
  face snapshot -> "Enhance face". Upstream CLI: `python inference_codeformer.py -w 0.5
  --input_path <dir> [--bg_upsampler realesrgan] [--has_aligned]`.
