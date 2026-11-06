# Face Detection & Recognition — SOTA Research + Upgrade Plan

> **Date:** 2026-08-09 · **Scope:** what would actually improve Drishyam's face accuracy
> **Method:** 3 parallel research agents (web + GitHub + arXiv + NIST), then every high-value
> claim re-verified against this repo's source. Findings that contradict our code are corrected below.
> **Current stack:** SCRFD (detect) → SORT/Kalman → quality pool → ArcFace `buffalo_l` (embed) → Qdrant 1:N

---

## 0. Executive summary — the five things that matter

1. **Don't swap the detector.** SCRFD is still on the speed/accuracy Pareto frontier in 2026. Every real-time alternative lands within ±1 AP on WIDER-HARD. **Resolution + tiling beats any model swap** for far/small faces.
2. **Don't lead with a recognizer swap either.** The biggest published wins (track aggregation, quality-gated selection) are **already implemented here** — verified in code. What's left is *enrollment quality* and *threshold calibration*.
3. **⚠️ LICENSING IS THE REAL BLOCKER.** We ship InsightFace pretrained weights, which are **non-commercial research only**. There is now an official commercial path: `recognition-oss-pack@insightface.ai`. This is the single highest-leverage action in this document.
4. **NVDEC is a verified no-op with an exact root cause** (wrong API + pinned `av==13.1.0`). Biggest untapped throughput lever.
5. **Reset expectations:** at true SOTA, CCTV→CCTV Rank-1 identification is **~40%**. CCTV probe → *clean enrollment photo* is **~72%**. Architect the product around the second number.

---

## 1. Face detection — SCRFD is still the right choice

WIDER FACE **HARD** subset (small/occluded faces = the CCTV-relevant metric):

| Model | HARD AP | Notes |
|---|---|---|
| **SCRFD-34GF** | **85.3** | our practical ceiling |
| SCRFD-10GF | 83.1 | typical deploy |
| YOLOv5l-face | 86.1 | ~tie, **GPL-3.0** |
| YOLO11s-face | 85.2 | ~tie, **AGPL-3.0** |
| YOLOv8m-face | 84.7 | worse, GPL |
| MogFace / TinaFace | 92–94 | **not real-time** (ResNet-50+); offline forensics only |

Everything real-time sits in an **83–86 band**. A swap is a wash — and would trade our MIT-code position for GPL/AGPL.

**What actually helps small/far faces:**
- **SAHI tiled inference** — slice frame into overlapping crops, detect per tile, merge. Documented **+6.8 to +14.5 AP on small objects**. MIT: https://github.com/obss/SAHI
- **Higher input resolution** (matters more than architecture — arXiv 2507.23341)
- **SCRFD-10GF → 34GF** on GPU nodes: +2.2 HARD AP for ~2× compute
- **Fine-tune on our own camera footage** — beats any cross-model swap
- **Do NOT** add super-resolution (confirmed again; identity not preserved)

---

## 2. Face recognition — what's actually SOTA

### 2a. Correction: we are not running R100
`buffalo_l`'s recognizer is **`w600k_r50`** — ResNet**50** @ WebFace600K (IJB-C 97.25). The R100 pack is `antelopev2`.
Demographic sub-scores (MR-ALL): S.Asian **93.16**, African 90.29, Caucasian 94.70, **E.Asian 74.96** ← 20-point hole.

### 2b. Ranked models (surveillance-relevant metrics)

| Model | IJB-C 1e-4 | TinyFace R1 | IJB-S S2Si | Weights licence | ONNX |
|---|---|---|---|---|---|
| **buffalo_l (R50)** ← we are here | 97.25 | n/p | n/p | **non-commercial** | ✅ |
| KP-RPE + AdaFace (ViT-B/WF12M) | 97.13 | **76.18** | ~73.0 | non-commercial | ❌ |
| AdaFace + ARoFace (R100/WF12M) | n/p | 74.00 | 72.28 | dataset-restricted | ❌ |
| **AdaFace (R100/WebFace12M)** | **97.66** | 72.29 | **71.35** | dataset-restricted | ❌ |
| LVFace-B (ViT-B, ICCV'25) | 97.70 | n/p | n/p | explicitly non-commercial | ✅ |
| TransFace-L (ViT-L/WF42M) | **98.16** | n/p | n/p | **no LICENSE at all** | ❌ |
| ArcFace (R100/MS1MV2) — classic | 96.03 | 63.81 | 57.35 | non-commercial | ✅ |
| **AuraFace-v1 (R100)** | not published ⚠ | n/p | n/p | **Apache-2.0** ✅ | ✅ |

**The number that resets expectations:** surveillance→surveillance Rank-1 is **~35–40%** at absolute SOTA; surveillance→clean-enrollment is **~71–73%**. **That ~2× gap means enrollment image quality is worth more than any model swap.**

### 2c. What helps on blurry/small/off-angle faces
The 2024–2026 literature converges: **alignment robustness is the dominant failure mode**, not representation. The three papers that most improve TinyFace/IJB-S — **KP-RPE** (CVPR'24), **ARoFace** (ECCV'24), **DArFace** (2025) — are all *alignment* papers. ARoFace alone: ArcFace TinyFace 63.81 → 67.54.
Also: **training-set scale beats loss function** (ArcFace@WF4M 71.11 > AdaFace@MS1MV2 68.21).

---

## 3. ⚠️ Licensing — the binding constraint

**No public FR training set permits training a commercial-grade model.** Verified by reading the actual licences:

- **Glint360K / WebFace260M / CASIA** — non-commercial; the restriction **explicitly reaches trained models**
- **MS-Celeb-1M** — withdrawn by Microsoft 2019; no licensor exists to grant rights
- **DigiFace-1M** (synthetic ≠ free) — R-UDA bars commercial use of *"the Data or any Results"*, and defines models trained on it as Results
- **MIT/Apache on a repo tells you nothing about the weights** — AdaFace code is MIT, every checkpoint is dataset-restricted. TransFace has **no LICENSE file at all** (worse than NC — no rights granted).

### The three genuinely commercial options

| Option | Accuracy | Licence | Effort |
|---|---|---|---|
| **License buffalo_l** → `recognition-oss-pack@insightface.ai` | unchanged (97.25) | paid, clean | **zero code change** |
| **fal/AuraFace-v1** | LFW 99.65 / CFP-FP 95.19; **no IJB-C** ⚠ | **Apache-2.0** | drop-in |
| OpenVINO face-reid-retail-0095 | much weaker (256-d) | Apache-2.0 | rewrite |

**⚠️ AuraFace gotcha (SHA-256 verified):** 4 of its 5 ONNX files are **byte-identical to InsightFace antelopev2**. Only `glintr100.onnx` differs. If adopted, take **only its recognition ONNX**; use MIT [YuNet](https://github.com/opencv/opencv_zoo/tree/master/models/face_detection_yunet) for detection. Its card admits limited ethnicity coverage — **must re-benchmark on our own footage**.

**For face quality, use [OFIQ](https://github.com/BSI-OFIQ/OFIQ-Project)** (MIT, German BSI, ISO/IEC 29794-5) — **not** CR-FIQA or SER-FIQ (both non-commercial).

---

## 4. NIST FRTE 1:N — the real ceiling

Leaderboard 2026-08-04 (681 algorithms): **NEC**, **Idemia**, QazSmartVision lead (FNIR@FPIR=0.003 ≈ **0.0005–0.0007** at N=12M).

**Open-source gap, quantified:** InsightFace's own FRTE 1:1 submission is within **~1.35×** of best on clean mugshots but **2.5×** on non-cooperative border imagery. A 2019-era academic ArcFace submission was **~48× worse** at 12M-gallery 1:N. Our gallery is small, which shrinks this a lot — but the direction is clear.

**NIST, verbatim, on non-cooperative capture:** *"error rates are much higher, often in excess of 20% … algorithms remain intolerant of face cropping (at image edge) and of large downward head pitch."*
Degradation vs mugshot: webcam ~11×, **downward-pitch kiosk ~89×**, profile 90° ~92×.
👉 **Camera mounting angle is a first-class accuracy parameter — target ≤30° from horizontal, eye-level where possible.**

**Demographics (NISTIR 8280):** false-positive rates vary **10× to 100×+** across demographics; **2–5× higher for women**. A single global threshold produces materially unequal error rates — a DPDP exposure, not just accuracy.

---

## 5. ✅ Already implemented (verified in code — do NOT redo)

The research ranked these as the top wins. We already have them:

| Technique | Status | Evidence |
|---|---|---|
| **Track-level template aggregation** | ✅ **DONE** | `services/track_embedding_pool.py` `pooled()` = quality-weighted average, re-L2-normed; `orchestrator.py:884,936` matches on the **pooled template**, not per-frame |
| **Quality-gated frame selection** | ✅ **DONE** | top-K quality pool + `would_admit()` short-circuit |
| **Min-face-size gate** | ✅ **DONE** | `match_min_face_px = 80` (research floor 32px, recommended 64px) |
| Rectangular detector input | ✅ DONE | `INSIGHTFACE_DET_ASPECT=1.7778` |
| Runtime replicas / batched SCRFD | ✅ DONE | `infra/insightface_runtime.py`, `AsyncBatcher` |
| AdaFace implementation | ✅ built, **not default** | `infra/recognizers/adaface.py` |

**This is why a model swap is not the priority — the multi-frame machinery that makes published numbers achievable is already here.**

---

## 6. 🎯 What's actually left — prioritized

### P0 — Business-critical
1. **Email `recognition-oss-pack@insightface.ai`** — we ship non-commercial weights in a paid product. Zero code change, preserves thresholds + stored gallery embeddings. Fallback: AuraFace-v1 (re-benchmark, don't assume threshold transfers).
2. **Ship `THIRD_PARTY_MODELS.md`** — SHA-256 + source + licence + training dataset per weight file. (The AuraFace/antelopev2 hash collision is exactly what this catches.)

### P1 — Accuracy (biggest remaining real-world gains)
3. **Multi-image, pose-diverse enrollment (3–5 per person).** Research: semantic diversity beats count — the optimal 3 were *"one frontal + two profiles from each side"*; plateau ~50. Given the ~2× S2Si-vs-S2Sv gap, **this is where our accuracy actually lives.**
4. **Threshold calibration as FNIR@FPIR, per camera.** Two distinct problems currently collapsed into one global value: (a) FPIR scales with gallery size — a threshold tuned at 200 enrollees over-fires at 5,000; (b) per-camera lighting/pitch shifts the score distribution. Use `eval/frvt.py`.
5. **Audit the alignment path** (`infra/aligner.py`) — confirm SCRFD kps → similarity transform → 112×112 and that the *aligned* crop is pooled. Misalignment is the most common silent cause of "recognition randomly bad" (~+1.7pp CFP-FP when correct).
6. **Switch default recognizer to AdaFace** (already built) — +3.5% Rank-1, +2.4% TPIR@FPIR=1% on IJB-S (surveillance video) vs next-best. ⚠️ AdaFace expects **BGR** input vs InsightFace **RGB**; licence still applies.
7. **Add a real FIQA signal** (OFIQ) to the pool's quality term — the pool is only as good as the score it ranks by; detector confidence + face size is a weak proxy.
8. **Test-time horizontal flip** — embed crop + mirror, average, re-normalise. Standard in every FR eval protocol. (Fancier generative TTA adds only +0.72% — not worth it.)

### P2 — Throughput
9. **Fix NVDEC properly** — `av>=14.0.1` + PyAV linked against FFmpeg with `--enable-cuvid/--enable-nvdec`, real `HWAccel` API. **Root cause found:** `options["hwaccel"]` in `ingest.py:158-166` is an *ffmpeg CLI* flag that libavformat silently discards, and we pin `av==13.1.0`. Pair with IOBinding so frames don't round-trip to host. *(Jetson needs a different path — GStreamer `nvv4l2decoder`/NVMM; PyNvVideoCodec is dGPU-only.)*
10. **Batch the embed stage** (extend `AsyncBatcher`) — ArcFace batch=1→64 gives **~3× better per-face** throughput.
11. **ORT TensorRT EP, FP16 + engine/timing cache** — engine caching is mandatory (session init 384s → 1.9s). ⚠️ TRT 10.0–10.5 has an NMS/NonZero regression that hits SCRFD post-processing — pin outside that range.
12. **INT8: detector only, never the embedder** (yet). The famous "99.80% INT8" figure is **Intel CPU + saturated LFW** — it cannot detect tail degradation at low FPIR. Gate any INT8 embedder on our own `eval/frvt.py`.
13. **Qdrant tenant-optimized index** — we run the documented worst case: default HNSW + `tenant_id` filter on every search. Qdrant docs: traversal *"still visits nodes belonging to other tenants"* and heavy filtering can make points **graph-unreachable, silently dropping recall**. Fix: `HnswConfigDiff(payload_m=16, m=0)` + `is_tenant=True`; also `prefer_grpc=True` (one line).
14. **Port OC-SORT's observation-centric re-update** into `services/face_tracker.py` (~100 lines, MIT) — every ID switch loses a pooled template. ⚠️ **Avoid BoxMOT — AGPL-3.0.**

### P3 — Deferred
15. **DeepStream** — revisit only past ~100 cameras/GPU. It has **no built-in landmark alignment** between detector and recognizer; NVIDIA's own answer is "write a custom `nvdspreprocess` library." Proprietary EULA.

---

## 7. Jetson notes
- Plan **8–12 cameras per Orin NX** and validate empirically (AGX Orin caps at **22×1080p30 decode alone**, before inference).
- `onnxruntime-gpu` has **no aarch64 PyPI wheels** — use https://pypi.jetson-ai-lab.io or [jetson-containers](https://github.com/dusty-nv/jetson-containers) (MIT).
- **Build TensorRT engines on-device** — not portable across compute capability/TRT version.
- JetPack 6.2 "Super Mode" (25W Orin Nano / 40W Orin NX) ≈ up to 2× perf; `nvpmodel` + `jetson_clocks`. MAXN SUPER is uncapped → needs real cooling.
- Reference: arXiv 2505.04524 reports **290 FPS @1080p, ~6 faces/frame on AGX Orin** using all HW engines + a tracker so recognition runs only on *new* faces — architecturally what our `would_admit()` already does.

---

## 8. Key sources
Detection: [SCRFD](https://github.com/deepinsight/insightface/tree/master/detection/scrfd) · [SAHI](https://github.com/obss/SAHI) · [MogFace](https://github.com/damo-cv/MogFace)
Recognition: [AdaFace](https://github.com/mk-minchul/AdaFace) · [KP-RPE](https://github.com/mk-minchul/kprpe) · [ARoFace](https://arxiv.org/html/2407.14972) · [LVFace](https://github.com/bytedance/LVFace) · [AuraFace](https://huggingface.co/fal/AuraFace-v1) · [model zoo](https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md)
Quality: [OFIQ](https://github.com/BSI-OFIQ/OFIQ-Project) · [TransFIRA](https://arxiv.org/html/2510.06353v2)
NIST: [FRTE 1:N](https://pages.nist.gov/frvt/html/frvt1N.html) · [NISTIR 8280](https://nvlpubs.nist.gov/nistpubs/ir/2019/nist.ir.8280.pdf)
Pipeline: [ORT TensorRT EP](https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html) · [InsightFace-REST](https://github.com/SthPhoenix/InsightFace-REST) · [OC-SORT](https://github.com/noahcao/OC_SORT) · [Qdrant multitenancy](https://qdrant.tech/documentation/manage-data/multitenancy/) · [jetson-containers](https://github.com/dusty-nv/jetson-containers)
