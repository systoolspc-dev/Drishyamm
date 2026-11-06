# Face Detection Strategy

A self-contained strategy document for making **face detection** in
`vms_face` measurably better. Detection is the first stage of the pipeline
(`RTSP → decode → SCRFD → tracker → quality → embed → match`). Everything
downstream — recognition, tracking, journey, ReID — is bottlenecked by the
quality of what the detector finds. This document is opinionated about what
matters, ordered by ROI, and pinned to specific files in the codebase so an
incoming engineer can pick a phase and ship.

> Companion documents:
> - [README.md](README.md) — operator-facing setup, deployment, env vars.
> - [SERVICES.md](SERVICES.md) — per-component reference for every service.
> - This file is the **face-detection-only** strategy: what failure modes
>   we have today, what to do about each, in what order, with what budget.

---

## 1. Goal

Maximise detector recall on a representative sample of footage from the
deployed cameras while holding precision above an operator-set floor.
"Better detection" means:

1. **More true positives** — fewer faces missed, especially small / distant
   / off-angle / partially occluded ones.
2. **No more false positives than today** — any recall gain that comes
   with a precision drop is debt, not progress.
3. **Reproducible across cameras** — a configuration that works on the
   parking lot also works on the lobby, or it's per-camera tuned and
   documented.

The detector is **SCRFD-10G** today (inside InsightFace's `buffalo_l`
bundle, file `det_10g.onnx`, ~17 MB on disk). Anything in this document
that talks about "the detector" means SCRFD-10G unless otherwise noted.

---

## 2. How we measure "better" — benchmark protocol

A configuration change isn't an improvement unless a benchmark says so.
This is non-negotiable: every claim downstream of this section ("X helps",
"Y costs N% accuracy") needs a measurement that shipped with it.

### 2.1 Probe set

Build a **per-deployment** probe set. Public benchmarks (WIDER FACE,
Pascal-FACE, FDDB) are diagnostic, not authoritative — they don't share
the noise distribution of your CCTV. Capture:

- **5k–10k frames** spanning each camera that matters, sampled across
  morning / afternoon / evening / night.
- **Hand-labeled bounding boxes** for every face >= 16 px on the short
  side. Don't pre-filter by visibility or pose — the labeling pass is
  what defines ground truth.
- **Tags per face**: `tiny` (<32 px), `low_light`, `blur`, `occluded`,
  `off_axis`, `backlit`, plus the source camera id. Tags let you measure
  recall **per failure mode**, not just an aggregate that hides regressions.
- **Camera-balanced split**: don't let one chatty camera dominate the
  probe. Cap per-camera images.

Store the probe in `eval_data/detection/` as JSONL:

```json
{"image_path": "cam-12/2026-05-08T19-23-04.jpg", "boxes": [[x1,y1,x2,y2,...]], "tags_per_box": [["tiny","low_light"],...], "camera_id": "cam-12"}
```

### 2.2 Metrics

Report all four. Don't quote one in isolation.

| Metric | Definition | Why it matters |
|---|---|---|
| **Recall @ IoU=0.5** | TP / (TP + FN) at 0.5 IoU | The "did we find the face" number — the operator's gut metric. |
| **Precision @ IoU=0.5** | TP / (TP + FP) at 0.5 IoU | Tells you whether recall came at the cost of false detections. |
| **AP (mAP)** | Area under precision-recall curve | Threshold-independent — the academic standard. |
| **Recall @ size bucket** | Recall split by `tiny / small / medium / large` per `tag` | Shows which failure mode the change actually fixed. The aggregate is misleading. |

### 2.3 Significance

For each change report: **point estimate + 95% bootstrap CI** computed by
resampling images. A 1% recall jump on 5k images has a CI of roughly ±0.6%
— if the change is inside the CI, it's noise.

### 2.4 Where the harness lives

- [eval/harness.py](eval/harness.py) — extend to add `--mode detection`
  that compares predicted boxes vs ground-truth boxes per the JSONL above.
- [eval/metrics.py](eval/metrics.py) — add a `detection_metrics()` function
  that returns the four metrics + per-tag breakdown + bootstrap CI.
- A `make benchmark-detection` target wired into a future CI gate
  (Tier-3 task O2 in the README roadmap).

Acceptance for any detection change in the rest of this document is:
**run the harness, report all four metrics + per-tag breakdown, and
include the JSON output in the PR description.**

---

## 3. Failure modes — what's actually missing today

Order by typical impact on a campus VMS. The fix for each is a separate
section below; this section is just the inventory.

| Failure mode | Symptom | Root cause | Best fix |
|---|---|---|---|
| **Tiny / distant faces** | Parking lots, hallway long shots, anyone past ~10 m. | Detector input size (`det_size=960`) compresses 8 px faces to <2 px before the FPN. | Per-camera `detection_input_size` (already supported); operator must tune. Phase A. |
| **Low light** | Lobby at 22:00, outdoor cameras after dusk. | SCRFD trained on mostly-daylight imagery; ISO noise looks like edges, swamping the FPN heads. | Pre-detection exposure normalisation; eventually fine-tune on dark frames. Phase E + D. |
| **Motion blur** | Running entry, fast pan-tilt-zoom cameras. | Blurred faces lose the edge structure SCRFD's anchors expect; detector returns low scores. | Quality gate filters them post-hoc, but the detector should filter earlier. Phase D fine-tune. |
| **Occlusion (mask, hat, hand)** | Anyone wearing a mask. | SCRFD treats partially-occluded faces as low-confidence. Today's quality gate doesn't know about occlusion. | Add a mask/occlusion classifier (Tier-1 task A3 in the README); also helps recognition. |
| **Off-axis pose** | Side profile near a side-mounted camera. | SCRFD anchor priors weight frontal faces; profiles get lower scores. | Lower threshold + post-filter on landmark confidence; or fine-tune on profiles. Phase A and D. |
| **Backlighting / glare** | Person standing in front of a window. | Detector saturates on the bright background; face becomes a silhouette. | Image enhancement (CLAHE on the detector's input). Phase E. |
| **Compression artifacts** | Low-bitrate RTSP streams from cheap cameras. | H.264 macroblock noise looks like edges. | Operator-side: increase camera bitrate. Pipeline-side: detect only on I-frames, or pre-decode denoise. Phase E. |
| **Camera angle (overhead, fisheye)** | Top-down hallway cameras, panoramic 360° fisheyes. | SCRFD's anchor box prior assumes faces are roughly upright + portrait-aspect. | Geometric un-warp (fisheye dewarp) before detect, OR a detector trained on top-down (rare). |

---

## 4. Levers, ranked by ROI

This is the entire space of detection improvements. Take them top-to-bottom
unless a specific failure mode forces a jump.

| # | Lever | Cost | Lift (recall %) | Phase |
|---|---|---|---|---|
| 1 | **Per-camera `detection_input_size`** | 0 GPU-hours / 1 eng-day to capture data + tune | +5–15% on tiny/distant cameras specifically; 0% elsewhere | A |
| 2 | **`INSIGHTFACE_DET_THRESHOLD` per-camera** | 0 / 0.5 day | ±2% (mostly precision/recall trade) | A |
| 3 | **Switch from SCRFD-10G → SCRFD-34G** | +2× GPU compute / 1 day | +2% aggregate (WIDER FACE Hard 83.05% → 85.29%); larger lift on hard cameras | C |
| 4 | **Multi-scale TTA (test-time augmentation)** | +2× GPU compute / 3 days | +1–3% recall, especially on tiny faces | E |
| 5 | **Image enhancement preproc (CLAHE / gamma)** | +1–2 ms CPU/frame / 1 week | +3–8% on low-light + backlit cameras | E |
| 6 | **Motion-zone gating** | -50–80% GPU on quiet cameras / 3 days | 0% recall change; pure compute saving (frees budget for higher det_size) | E |
| 7 | **Tile-based detection for wide scenes** | +N× GPU per tiled camera / 1 week | +5–15% on parking-lot-scale frames where 1 face is < 1% of frame area | E |
| 8 | **Fine-tune SCRFD on local data** | 1 GPU-week + labeling cost / 4–6 weeks | +5–15% per-deployment | D |
| 9 | **Switch detector family (YOLOv10-face, etc.)** | Variable / 2–3 weeks | Maybe +1–3%; not a clear win per project memory | (skip unless data justifies) |
| 10 | **Custom anchor design** | 1+ GPU-week / 4 weeks | +1–3% on extreme aspect ratios (overhead cams) | (rare) |

The first three are 80% of the practical value. Do them first.

---

## 5. Phase A — Tune what we already have (Day 1)

The fastest detection improvements are configuration changes. The pipeline
already supports per-camera detector input size via
`Camera.detection_input_size`; it's just rarely tuned in practice. This
phase has no code changes — it's an operator playbook.

### 5.1 Per-camera `detection_input_size`

Today the global default is `INSIGHTFACE_DET_SIZE=960`. The
[FaceRuntimePool](infra/insightface_runtime.py) keys runtimes by det_size,
so cameras with different `Camera.detection_input_size` values run on
different `FaceRuntime` instances in parallel.

Recommended starting points:

| Camera type | Faces typically | Recommended `detection_input_size` |
|---|---|---|
| Doorway / lobby (face fills 1/3 of frame) | 50–200 px | 640 |
| Indoor mid-shot (faces 50–150 px) | 50–150 px | 960 |
| Hallway long-shot (faces 30–80 px) | 30–80 px | 1280 |
| Parking lot / outdoor wide | 16–60 px | 1280–1600 |
| Top-down ceiling cam | varies, often elongated | 960 + post-processing |

To set per camera:

```bash
curl -X PATCH http://api/cameras/{camera_id} \
  -H "Authorization: Bearer $JWT" \
  -d '{"detection_input_size": 1280}'
```

GPU cost is roughly **quadratic in `det_size`**: 640→1280 is ~4× detect
compute. The resource savings from the recent batch of optimizations (aux
landmark heads dropped, pre-embed gate, etc. — see "Resource tuning" in
[README.md](README.md)) leave headroom for raising it on the cameras that
need it.

### 5.2 Per-camera detector threshold

Currently `INSIGHTFACE_DET_THRESHOLD` is global at 0.5. The right value
varies by camera:

- **Cooperative / well-lit**: 0.5 is fine. Higher than 0.5 trades recall
  for fewer false positives.
- **Outdoor / variable lighting**: try 0.4. The quality gate downstream
  filters most extra detections.
- **Tiny-face heavy (parking lot)**: 0.35–0.4. SCRFD's confidence on tiny
  faces is systematically lower because those anchors saw less variety
  during training.

The pipeline doesn't currently support per-camera thresholds — the
`FaceRuntime` is keyed only by det_size. Phase A.1 below is the small
code change to add per-camera threshold:

> **Phase A.1 (1 day)**: Extend `Camera` schema to add
> `detection_threshold: Float = 0.5`. Pass it through `StreamContext` and
> override `FaceRuntime.detect(..., threshold=ctx.detection_threshold)`.
> The underlying SCRFD model accepts a threshold parameter at call time,
> so no FaceRuntime rebuild is needed.

### 5.3 Acceptance for Phase A

Re-run the per-camera benchmark from §2 and:
- Recall on tiny-face-heavy cameras increases by ≥ 5%.
- Precision on doorway / lobby cameras unchanged or improved.
- Per-camera detect latency rises only on cameras that needed it (the
  cheap cameras stay cheap).

---

## 6. Phase B — Per-camera benchmark + targeted tuning (Week 1–2)

Capture data from each camera, run the detection benchmark, decide whether
each camera needs Phase A.1 (threshold), Phase A.2 (det_size), or has a
deeper failure mode (Phase C/D/E).

### 6.1 Data capture

For each camera:
1. Pull 200–500 frames spanning a 24-hour period via the appearance
   snapshot bucket (already in MinIO at `vms-snapshots/{tenant}/{camera}/`).
2. Hand-label every face ≥ 16 px short side. ~10 sec/face for a competent
   labeler; 1 person × 1 day produces ~1500 labeled boxes.
3. Tag with the failure-mode taxonomy from §3.

### 6.2 Per-camera report

The harness output goes into a per-camera markdown with:
- Recall @ IoU=0.5 (overall + per tag)
- Precision @ IoU=0.5
- AP
- Recommended config: `detection_input_size`, `detection_threshold`
- Open issues for any camera where the recommended config is below an
  acceptance threshold (e.g. recall < 0.85 on the `medium` size bucket
  with no obvious tag).

### 6.3 Acceptance for Phase B

A `eval_data/per_camera_reports/` directory exists with a markdown per
camera. Each camera with recall < 0.80 has a documented next step
(escalate to Phase C/D/E).

---

## 7. Phase C — Model upgrade (Week 2–4)

When Phase A's tuning floor isn't enough — typically when recall on
small/distant faces is < 0.70 — upgrade the detector itself.

### 7.1 SCRFD-10G → SCRFD-34G

InsightFace ships SCRFD-34G inside the `antelopev2` model bundle. It's
the same architecture family, just with more channels and depth.

| Model | WIDER FACE Hard | Inference cost (rel.) | When to use |
|---|---|---|---|
| SCRFD-10G (`buffalo_l`) | 83.05% | 1.0× | Default; 50–500 cameras per node. |
| SCRFD-34G (`antelopev2`) | 85.29% | 2.0× | Hard cameras (small faces, low-light), forensic passes. |
| SCRFD-2.5G (smaller variant) | 79.5% | 0.4× | Edge / Jetson deployments only; not a campus VMS pick. |

The swap is a config change:

```env
INSIGHTFACE_MODEL=antelopev2
```

After the swap:
- Re-run the Phase B benchmark per camera.
- Recognition is unaffected — the recognizer is a separate model.
- GPU compute roughly doubles per detect call; either accept fewer cameras
  per node, or use SCRFD-34G **selectively** on hard cameras (per-camera
  model selection — see Phase C.1).

### 7.2 Phase C.1 — per-camera detector selection (1 week)

Today the `FaceRuntimePool` keys runtimes by `det_size`. Extend it to key
by `(model_name, det_size)` so different cameras can run different models
in parallel:

- Add `Camera.detector_model: String = "buffalo_l"`.
- `StreamContext` carries it through.
- `FaceRuntimePool.get(det_size, model_name=...)` returns a
  per-`(model, size)` runtime.
- Detect time becomes `runtime.detect(frame)`; the runtime knows its
  model.

This lets the operator put SCRFD-34G on the 5 hard cameras and keep
SCRFD-10G on the other 195. The 5 cameras pay the 2× cost; the 195
don't.

### 7.3 Acceptance for Phase C

- Hard cameras' recall improves by ≥ the WIDER FACE delta (~2% aggregate,
  more on small-face buckets).
- Easy cameras unaffected.
- GPU memory stays bounded — verify `vms_runtime_degraded` doesn't
  start spiking after the swap.

---

## 8. Phase D — Local fine-tuning (Month 2–3)

The biggest detection accuracy lever. SCRFD's public weights see WebFace,
WIDER FACE, MAFA-style datasets — they don't see your specific cameras'
sensor, optics, lighting, compression. A fine-tune on your data closes
that gap.

### 8.1 What you need

- **Labeled training set**: 10–20k frames with face boxes. Aim for
  balance across cameras and times-of-day. Re-use the Phase B labeling
  effort and extend it.
- **Compute**: 1× A100 / H100 / Blackwell-class GPU for ~5–7 days, OR
  cloud equivalent (~$500–$1500). Multi-GPU shaves wall-clock time but
  not total compute.
- **Augmentation pipeline**: motion blur kernel sweep, gamma jitter,
  ISO noise, JPEG round-trip, random downsample. The augmentation
  is what makes the fine-tune robust to your noise distribution.
- **Eng time**: 2–4 weeks for someone who's done detector training
  before; 6–8 weeks if not.

### 8.2 Pipeline

1. **Reproduce the SCRFD baseline.** Clone insightface's training repo
   (`detection/scrfd/`), train SCRFD-10G from scratch on WIDER FACE for
   one epoch, verify the resulting weights produce ≈ the published
   number. This is a sanity check — if you can't repro the baseline,
   anything you train next is unfalsifiable.
2. **Start from the public SCRFD-10G checkpoint** (don't train from
   scratch on your data; you don't have enough).
3. **Mix datasets**: 70% WIDER FACE, 30% your data. Pure local-data
   fine-tune over-fits hard.
4. **Fine-tune for 5–10 epochs at LR 1e-4** with the public optimizer
   schedule. Watch the per-tag recall on a held-out local validation set.
5. **Stop when local recall stops improving** (typically 7–10 epochs);
   don't keep going to chase WIDER FACE numbers — those will saturate
   first because the public weights already saw WIDER FACE.
6. **Export to ONNX** with the same `convert_to_onnx.py` insightface
   ships. The output is a drop-in replacement for `det_10g.onnx` in the
   `buffalo_l` directory.
7. **Drop the new ONNX into the model bundle** at the
   `~/.insightface/models/buffalo_l/det_10g.onnx` path. No code changes
   needed.

### 8.3 What gain to expect

Honest range, based on similar fine-tunes in the literature:

- **+5–10% recall on tiny / low-light / motion-blur** (the failure modes
  with the largest train/test distribution shift today).
- **0–2% on already-good cases** (cooperative indoor) — public weights
  are already strong here.
- **No precision regression** if the augmentation is set up right; a
  precision *drop* means the model is now confident on noise that
  resembles your augmentations. Re-tune the threshold per Phase A.2.

### 8.4 Anti-patterns

- **Don't fine-tune the recognizer at the same time.** Detection and
  recognition fine-tunes have different data needs (boxes vs. identity
  pairs) and different acceptance criteria. One project at a time.
- **Don't train from scratch on local data.** Your dataset is too
  small. The public weights are 99% of what you need; you're just
  shifting the last percent.
- **Don't deploy without an A/B comparison** against the previous
  weights. Roll out via `INSIGHTFACE_MODEL=buffalo_l_v2` (drop your
  fine-tuned ONNX into a new bundle) so rollback is a config flip.

### 8.5 Acceptance for Phase D

- Recall on the per-tag local probe set improves by ≥ 5% on the
  failure-mode buckets that motivated the work.
- Aggregate WIDER FACE Hard recall does not regress by more than 1%
  (we want a "specialist" model for your data, not one that forgets
  the public benchmark).
- The fine-tuned ONNX runs at ≤ 1.1× the original SCRFD-10G inference
  cost (no architectural change).

---

## 9. Phase E — Advanced & specialised (later, when D plateaus)

Reach for these when the previous phases stop yielding improvements.

### 9.1 Multi-scale TTA at inference

Run SCRFD at two or three scales (e.g. 960 and 1280), merge boxes via
NMS. Catches faces that fall between anchor scales.

- **Cost**: 2–3× detect compute on the cameras that opt in.
- **Lift**: +1–3% recall, mostly on tiny faces.
- **Where**: new `infra/multi_scale_detector.py` that wraps multiple
  `FaceRuntime` instances at different `det_size` and merges their
  outputs. Plumb a `Camera.detector_scales: list[int]` to enable it.

### 9.2 Image enhancement preproc

Before SCRFD, optionally run:

- **CLAHE** (contrast-limited adaptive histogram equalisation) on the
  L channel of LAB — fixes most backlight / glare issues for ~1 ms
  CPU/frame.
- **Gamma normalisation** to a target mean luminance — fixes night
  cameras at the cost of ~0.5 ms CPU/frame.
- **Bilateral or NLM denoise** for cheap-IP-camera noise — 5–10 ms
  CPU/frame; usually too expensive at 2k cameras.

The right place is a `services/image_enhancement.py` module called
between `pipeline.ingest.read_frame()` and `runtime.detect()`. Only
enable per-camera (`Camera.enhancement_profile: str | None`) — running
it on already-clean indoor cameras hurts more than it helps.

> **Important** — do not put GFPGAN, CodeFormer, or any face super-
> resolution model in the **detection** path either. These models are
> trained to produce *plausible* faces from low-res inputs; they
> hallucinate features that aren't really there. The detector then
> finds those hallucinated faces. Even more harmful here than in the
> recognition path. SR belongs only on the human-review thumbnail
> bucket, asynchronously.

### 9.3 Motion-zone gating

Instead of running SCRFD on every frame, run it only on frames where
a cheap CPU motion check (frame difference, MOG2 background subtract)
indicates motion in the relevant region. On quiet cameras this skips
70–95% of detect calls.

- **Cost**: ~1–2 ms CPU/frame for the motion check.
- **Lift**: pure resource saving — no recall change.
- **Where**: new `services/motion_gate.py`; orchestrator skips detect
  when motion < threshold for the configured zones.
- **Caveat**: introduces ~1 frame latency to first detect when motion
  starts. Not OK for high-stakes ingress points; great for parking
  lots.

### 9.4 Tile-based detection for wide scenes

For very wide cameras (panoramic, parking lots) where one face is
< 1% of the frame area, divide the frame into overlapping tiles, run
SCRFD on each tile, merge with NMS.

- **Cost**: N× detect compute, where N is tile count (typically 4–9).
- **Lift**: +5–15% recall on tiles' content; significant for parking
  lots.
- **Where**: extends `BatchedSCRFD` — each tile is a batch row, so
  the tiling is "free" within the batched primitive.

### 9.5 Fisheye / panoramic dewarp

For 360° fisheye cameras, dewarp to a flat panoramic strip first,
then detect on the strip. The detector only knows about upright
roughly-rectangular faces; the dewarp lets it see them as such.

- **Cost**: 5–15 ms CPU per frame for the dewarp.
- **Lift**: depends on how curved the camera is — minimal for
  hemispheric cameras, dramatic for fisheyes.
- **Where**: new `services/dewarp.py`; orchestrator pre-processes
  per-camera based on `Camera.lens_profile`.

---

## 10. Resource & compute budget

Hardware sizing for each phase, assumed against the project target of
~2,000 cameras on Blackwell-class GPUs.

| Phase | New GPU need | New CPU need | Eng time | Storage |
|---|---|---|---|---|
| **A — config tuning** | 0 | 0 | 1 day | 0 |
| **A.1 — per-camera threshold** | 0 | 0 | 1 day | 0 |
| **B — per-camera benchmark** | 0 | 0 | 1–2 weeks (mostly labeling) | ~5 GB labeled probe set |
| **C — SCRFD-34G** | +50–100% on cameras using it | 0 | 1 day | +143 MB model |
| **C.1 — per-camera model** | (depends on adoption) | 0 | 1 week | +143 MB per model variant |
| **D — local fine-tune (training)** | 1 GPU × 5–7 days for training | 0 | 4–6 weeks (mostly labeling + experimentation) | ~50 GB training data + checkpoints |
| **D — local fine-tune (deploy)** | same as Phase A baseline | 0 | 1 day to deploy | +17 MB model |
| **E.1 — multi-scale TTA** | +100–200% on cameras using it | 0 | 3 days | 0 |
| **E.2 — CLAHE/gamma** | 0 | +1–2 ms/frame on cameras using it | 1 week | 0 |
| **E.3 — motion gating** | -50–80% on quiet cameras | +1–2 ms/frame | 3 days | 0 |
| **E.4 — tile detection** | +(tile count − 1)× on tiled cameras | 0 | 1 week | 0 |
| **E.5 — fisheye dewarp** | 0 | +5–15 ms/frame on fisheye cameras | 2 weeks | 0 |

**Combined recommendation for the 2k-camera target**:
- Phase A done at deployment (free).
- Phase B run quarterly per-camera (1 day of labeling per quarter).
- Phase C used selectively — SCRFD-34G on the 5–10% of cameras that
  need it, SCRFD-10G everywhere else.
- Phase D once, after 3 months of operation (so you have real data to
  train on). Re-do annually as the camera fleet / season / population
  evolves.
- Phase E only on the cameras that demonstrably need it. Don't enable
  globally.

---

## 11. Anti-patterns — what NOT to do

A list of changes that look like detection improvements but aren't, with
why. If someone proposes one, push back with the citation.

1. **Super-resolution before detection** (GFPGAN, CodeFormer, Real-ESRGAN).
   These models hallucinate face features; the detector then finds those
   hallucinated faces. Even worse than putting SR before recognition.
   The project memory's research findings (2026-05-07) explicitly call
   this out.
2. **Lowering threshold globally to 0.2 or below.** You will get
   recall, you will also get many false detections that the quality
   gate then has to filter. Fix the camera + det_size + model first.
3. **Switching to a totally different detector family without
   benchmarking** (YOLOv8-face, MediaPipe, RetinaFace, etc.). The
   research memo says SCRFD vs YOLOv8/v11-face is not a clear win —
   small differences that wash out in deployment-specific noise.
4. **Quoting WIDER FACE numbers as production accuracy.** The two are
   not comparable. WIDER FACE images are curated; CCTV is everything
   that hits the sensor.
5. **Tuning a single global threshold.** Cameras have different
   distributions. Per-camera or fail.
6. **Tracking detection accuracy via "alerts seen per day".**
   Confounded by camera mix, time of day, recognition accuracy. Use
   the harness numbers from §2.
7. **Deploying a fine-tuned model without a feature flag.** When
   accuracy regresses (and the first one might), rollback is a
   config flip, not a redeploy.
8. **Optimising detection separately from quality gate + tracker.**
   A detector that finds 10% more faces of which 9% fail the quality
   gate cost you GPU for zero downstream benefit. Measure the
   end-to-end "matchable face count", not raw detection.

---

## 12. Concrete file map

Where each phase lands in the codebase.

### Already exists (touch only)

- [config/settings.py](config/settings.py) — `INSIGHTFACE_MODEL`,
  `INSIGHTFACE_DET_SIZE`, `INSIGHTFACE_DET_THRESHOLD`. Phase A.
- [domain/models.py](domain/models.py) — `Camera.detection_input_size`.
  Already wired through `StreamContext` and honored by
  `FaceRuntimePool`. Phase A.
- [infra/insightface_runtime.py](infra/insightface_runtime.py) —
  `FaceRuntimePool` (currently keyed only by `det_size`). Extend in
  Phase C.1 to key by `(model_name, det_size)`.
- [infra/batched_scrfd.py](infra/batched_scrfd.py) — already in the
  inference path; Phase E.4 extends it to handle tiled inputs.
- [pipeline/orchestrator.py](pipeline/orchestrator.py) — call site for
  detect; per-camera threshold plumbing lives here. Phase A.1 + B.
- [eval/harness.py](eval/harness.py) — extend to add `--mode detection`.
  Phase B.
- [eval/metrics.py](eval/metrics.py) — add `detection_metrics()` with
  per-tag breakdown + bootstrap CI. Phase B.

### New modules (create)

- `services/image_enhancement.py` — Phase E.2.
- `services/motion_gate.py` — Phase E.3.
- `infra/multi_scale_detector.py` — Phase E.1.
- `services/dewarp.py` — Phase E.5.
- `eval_data/detection/` — labeled probe set. Phase B.
- `eval_data/per_camera_reports/` — markdown reports. Phase B.
- `tools/finetune_scrfd/` — training scripts (probably out-of-tree
  if they need a separate deps stack; keep a thin pointer here).
  Phase D.

### Schema changes

- `Camera.detection_threshold: Float` (default 0.5) — Phase A.1.
- `Camera.detector_model: String` (default `buffalo_l`) — Phase C.1.
- `Camera.detector_scales: list[int]` (default empty) — Phase E.1.
- `Camera.enhancement_profile: str | None` (default null) — Phase E.2.
- `Camera.lens_profile: str | None` (default null) — Phase E.5.
  Each becomes a new alembic migration; bundle them per phase, not
  one giant migration.

---

## 13. Phase-by-phase acceptance criteria (the contract)

A change is "done" when:

| Phase | Acceptance |
|---|---|
| **A** | Per-camera `detection_input_size` set on every camera. Phase B benchmark shows ≥ 5% recall improvement on the cameras whose `detection_input_size` was raised; precision unchanged. |
| **A.1** | `Camera.detection_threshold` honored end-to-end. Cameras with threshold < 0.5 show recall lift on the probe set without precision drop > 2%. |
| **B** | Markdown report per camera in `eval_data/per_camera_reports/`. Every camera with recall < 0.80 has a documented next step. |
| **C** | `INSIGHTFACE_MODEL=antelopev2` produces ≥ 2% recall lift aggregate vs `buffalo_l` on the local probe. GPU utilisation rises but `vms_runtime_degraded` stays at 0. |
| **C.1** | Two cameras run different detectors in parallel for at least 24 h with no degradation. Per-camera detect latency is independent. |
| **D** | Local fine-tuned ONNX gives ≥ 5% recall lift on failure-mode buckets vs public weights. WIDER FACE Hard recall does not regress by > 1%. Inference cost ≤ 1.1× the original. Behind a feature flag. |
| **E.1** | Multi-scale TTA on a chosen subset of cameras delivers ≥ 1% additional recall on tiny-face bucket; doesn't regress precision. |
| **E.2** | CLAHE or gamma enhancement on a chosen subset delivers ≥ 3% recall lift on `low_light` and `backlit` tags; quality gate rejection rate doesn't spike. |
| **E.3** | Motion gating on quiet cameras reduces detect call count by ≥ 70% without dropping any face that would have been detected (verified via a "shadow mode" run on labeled video). |
| **E.4** | Tile-based detection on parking-lot cameras delivers ≥ 5% recall lift on tiny-face bucket. |
| **E.5** | Fisheye dewarp on the relevant cameras shows recall on the dewarped images at least matching SCRFD's recall on equivalent rectilinear footage. |

---

## 14. Honest summary

Three short statements you can quote upward.

1. **"The detector itself is unchanged in the recent optimisation pass.
   We made it faster and cheaper to run, not more accurate."** Resource
   savings = headroom. Headroom is what funds Phases A, B, C, E.
2. **"Per-camera tuning (Phase A + B) is 80% of the practical
   improvement available without a training project."** Most teams
   never do it; they ship a global config and stop. Doing it is the
   cheapest detection win in the system.
3. **"Local fine-tuning (Phase D) is the only path to detection
   accuracy that outperforms what off-the-shelf models can ever do on
   our cameras."** Everyone who claims defense-grade or world-best
   detection has done it; everyone who hasn't is below ceiling.

Read this with [README.md](README.md) and [SERVICES.md](SERVICES.md)
for the full picture: what we have today, how to deploy it, and what
the next year of detection-quality work looks like.
