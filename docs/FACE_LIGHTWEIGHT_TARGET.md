# Face Recognition — Lightweight & Speed Target

> **Goal:** much lighter, much faster, *better* accuracy.
> **Measured:** 2026-09-19 on `drisyam-original-ai`, RTX PRO 5000 Blackwell 72 GB,
> ORT 1.26.0 / CUDA EP, `buffalo_l` (SCRFD-10GF `det_10g` + ArcFace R50 `w600k_r50`).
> Companion docs: `FACE_RECOGNITION_RESEARCH_2026.md` (what model to pick),
> `FACE_ACCURACY_BENCHMARK.md` (how accuracy is measured).

---

## 0. The headline, first

**We are paying ~4.5x more recognizer GPU time than the pipeline's own design asks for,
and the code written to prevent that is dead.**

`infra/recognizers/insightface_arc.py` does not embed anything — it returns the embedding
that `FaceAnalysis.get()` *already computed during detection*. InsightFace computes it
for **every detected face, on every detect call, one face at a time**:

```python
# insightface/app/face_analysis.py - FaceAnalysis.get()
for i in range(bboxes.shape[0]):       # <- per face
    for taskname, model in self.models.items():
        model.get(img, face)           # <- ArcFaceONNX.get() = 1 forward pass, batch of 1
```

So every gate the orchestrator carefully applies *after* detection — the quality verdict,
`embed_every_n_frames = 5`, `pool.would_admit()` — saves **zero GPU**. They all sit behind
`reuse_existing()`, which hands back a vector that was already paid for.

Confirmed on the live service:

```
vms_embed_latency_seconds_count   0.0            <- the explicit embed path has never run
vms_embed_skipped_total           (no samples)   <- the pool-saturation saving never fires
vms_detect_latency_seconds_count  1,825,798      @ 19.5 ms lifetime avg
```

This is the single largest and cheapest win available, and **it costs nothing in accuracy**
(proof in section 3).

---

## 1. Measured baseline — where the milliseconds actually go

Per-stage, isolated, CUDA EP, 50 iterations after warm-up:

| Stage | Shape | ms/call | ms/img |
|---|---|---:|---:|
| SCRFD `det_10g` — **square (what we run)** | 1x3x960x960 | **7.74** | 7.74 |
| SCRFD `det_10g` — 16:9 rectangular | 1x3x544x960 | **5.90** | 5.90 |
| SCRFD `det_10g` — 16:9 larger | 1x3x736x1280 | 8.02 | 8.02 |
| ArcFace R50 — **batch 1 (what we run)** | 1x3x112x112 | **3.82** | 3.82 |
| ArcFace R50 — batch 8 | 8x3x112x112 | 4.18 | **0.52** |
| ArcFace R50 — batch 16 | 16x3x112x112 | 6.75 | **0.42** |
| ArcFace R50 — batch 32 | 32x3x112x112 | 12.64 | 0.40 |
| genderage — batch 1 / batch 8 | 96x96 | 1.97 / 1.32 | 1.97 / **0.17** |

On **real faces** end-to-end (6 detected faces, alignment included):

```
per-face  get_feat x6 = 22.82 ms   (3.803 ms/face)   <- what runs today
batched   get_feat(6) =  5.10 ms   (0.850 ms/face)   <- 4.5x cheaper, same output
```

**Cost model, F faces per frame:** `7.74 + F x 3.82` ms.
At F = 4 this is **23.0 ms/frame**, which matches the live 19.5 ms lifetime average
(about 3 faces on average).

### The conclusion that matters for "lightweight model"

> At batch >= 8 the recognizer costs **0.4-0.85 ms/face**. The detector costs
> **5.9-7.7 ms/frame**. Swapping ArcFace R50 for MobileFaceNet/EdgeFace saves roughly
> **0.3 ms/face** and costs accuracy.

**On dGPU, a smaller recognition model is the wrong lever.** The recognizer is launch-bound,
not compute-bound — 174 MB of weights and 6.3 GFLOPs are not what is slowing us down;
*calling it 5x too often at batch 1* is. Lightweight-by-model-swap belongs in a separate
**edge profile** (Jetson / CPU / on-prem relay), never as the dGPU default. See section 5.

---

## 2. Target

Per processed frame at F = 4 faces, 4 fps/camera, 3 runtime replicas:

| Metric | Baseline (measured) | **Target** | Factor |
|---|---:|---:|---:|
| GPU per processed frame | 23.0 ms | **<= 4.0 ms** | **5.7x** |
| GPU per camera-second | 92 ms | **<= 16 ms** | 5.7x |
| Cameras per GPU @ 4 fps | ~32 | **>= 180** | 5.6x |
| Recognizer cost per face | 3.80 ms | **<= 0.85 ms** | 4.5x |
| Model VRAM (3 replicas) | 573 MB | **<= 230 MB** | 2.5x |
| p95 detect latency @ 32 cams | ~1500 ms *(prod A/B)* | **<= 40 ms** | — |
| TPR on held-out eval set | 0.969 | **>= 0.98** | — |
| FPR on held-out eval set | 0.000 | **<= 0.001** | hold |
| Gallery re-enrollment required | — | **none** | hard constraint |

**Hard constraint:** no step in the speed track may change a stored embedding. The enrolled
Qdrant gallery and every calibrated threshold must survive untouched. Accuracy changes
(AdaFace) are a *separate*, opt-in track with their own re-enrollment run.

---

## 3. The plan — each step with its measured effect

### P0 · Decouple recognition from detection, and batch it — **modelled 5.7x, zero accuracy cost**

Build a standalone `BatchedArcFaceRecognizer` on InsightFace's own `ArcFaceONNX`, pair it
with `FaceRuntime(run_recognition=False)`, and let the existing gates finally bite.

Three things become true at once:

1. **The gates work.** `embed_every_n_frames = 5`, the quality verdict and
   `pool.would_admit()` start skipping real forward passes:
   F x 3.80 ms becomes (F/5) x 0.85 ms.
2. **Embeds batch across cameras.** `AsyncBatcher` already exists and AdaFace already uses
   it; `get_feat()` already accepts a list — 3.80 to 0.85 ms/face at 6 faces, 0.42 at 16.
3. **VRAM stops scaling the big model with replicas.** Replicas hold the 17 MB detector;
   one shared embedder holds the 174 MB. 3x191 MB becomes 3x17 + 174 = 225 MB.

**Why accuracy is untouched — verified, not assumed.** Reusing InsightFace's own
`ArcFaceONNX` keeps the preprocessing byte-identical (`cv2.dnn.blobFromImages`,
mean/std 127.5, `swapRB=True`) and the weights identical. Measured against the current path
on real enrolled faces — see the parity gate below. **The gallery does not need
re-enrolling.**

**Shipped and verified 2026-09-19.** `infra/recognizers/batched_arcface.py`, selected with
`RECOGNIZER_BACKEND=insightface_batched`. That value is deliberately absent from the
run-recognition list in `FaceRuntime.__init__`, so choosing it also stops the detector
loading the recognition head — no extra wiring.

Parity gate (`eval/recognizer_parity.py`, 10 enrolled faces, same session):

```
worst cosine   : 0.9999999404   (gate >= 0.9999)     max|d| 1.49e-08
per-face x10   :   36.11 ms (3.611 ms/face)   <- what 'insightface' runs
batched(10)    :    6.78 ms (0.678 ms/face)   <- 5.3x
PASS - vectors are interchangeable; gallery and thresholds are safe.
```

Detection-only mode confirmed — `w600k_r50.onnx` is no longer loaded per replica:

```
model ignore: .../w600k_r50.onnx recognition
runs_recognition: False      allowed_modules: ['detection']
obs.embedding   : None       <- the quality / embed_every_n / pool gates now bite
```

End-to-end accuracy regression, 49 persons / 147 gallery / 97 probes, threshold 0.45:

| | `insightface` (before) | `insightface_batched` (after) |
|---|---|---|
| detection_rate | 1.000 | **1.000** |
| TPR | 0.9691 | **0.9691** |
| FPR | 0.000 | **0.000** |
| F1 | 0.9843 | **0.9843** |

Identical to four decimals, as the parity gate predicts.

### P1 · Config the local stack up to what prod already runs — **-24% detector, free**

`docker-compose.drisyam-original.yml` never got the 2026-08-07 prod tuning. Locally we run
square input, detect on every frame, motion gate off:

| Setting | Local now | Should be | Effect |
|---|---|---|---|
| `INSIGHTFACE_DET_ASPECT` | `0.0` (square) | `1.7778` | 7.74 to 5.90 ms (-24%), +33% range |
| `DETECT_EVERY_N_FRAMES` | `1` | `2` | halves detector calls; Kalman fills the gap |
| `MOTION_GATE_ENABLED` | `false` | `true` | -70 to -95% on quiet cameras |
| `TARGET_FPS` | `4` (default) | `4` | already right |

All four are built and shipped — this is configuration, not code.

**Applied 2026-09-19** to both `smart-cam-ai` and `smart-cam-ai-worker` in
`docker-compose.drisyam-original.yml` — `INSIGHTFACE_DET_ASPECT=1.7778` and
`DETECT_EVERY_N_FRAMES=2`. `MOTION_GATE_ENABLED` is deliberately left off: it is the one
lever here that has never been measured on this stack, and a mis-tuned gate drops faces
rather than just costing GPU. Turn it on separately and watch `vms_motion_gate_skips_total`.

### P1b · `PIPELINE_BATCHED_INFERENCE` was a landmine — now safe

The flag is documented as "3-5x detect, ~2x embed". Enabling it on the shipped model pack
**would have killed detection outright.** `buffalo_l`'s `det_10g.onnx` pins its batch
dimension to 1 (`[1, 3, '?', '?']` — height and width are symbolic, batch is not).
`BatchedSCRFD` constructed fine, because it only checked that SCRFD's *attributes* existed,
then every `session.run` with 2+ frames failed:

```
INVALID_ARGUMENT : Got invalid dimensions for input: input.1
 index: 0 Got: 2 Expected: 1
```

and `_run_batched_detect` re-raises everything that isn't a CUDA fault — so the camera's
detect loop would die rather than degrade. Fixed in `infra/batched_scrfd.py`: the batch
dimension is checked at construction, where the class's stated contract is already "raise
`InferenceError` and the caller falls back to per-image detection". `FaceRuntime` latches
`_batched_unavailable` and never retries. Verified:

```
warning  batched detect unavailable; falling back to per-image
         err="SCRFD ONNX has a fixed batch dimension of 1 ... Re-export the
              detector with a dynamic batch axis to enable it."
detect_async #0: 1 faces   batched_unavailable=True
RESULT: detection survives PIPELINE_BATCHED_INFERENCE=true
```

So the flag is now safe and is enabled — the **embed** path batches, the detect path keeps
its per-image call. Re-exporting SCRFD with a dynamic batch axis is what unlocks the rest.

### P1c · The flag also silently moved inference onto the wrong thread pool

Enabling it made things *worse* before it made them better, and the reason is worth keeping.
`core/executors.py` deliberately splits work into three pools, with a **4-thread** `gpu_pool`
because "GPU work is serialized on the GPU itself; more host threads doesn't help and
increases lock contention". But the orchestrator branches:

```python
if settings.pipeline_batched_inference:
    observations = await self._runtime.detect_async(frame.bgr)          # no pool named
else:
    observations = await loop.run_in_executor(get_gpu_pool(), ...)      # correct pool
```

and `detect_async`'s non-batched fallback did `run_in_executor(None, ...)` — asyncio's
**default** pool, `min(32, cpu+4)` threads. Its docstring claimed "the orchestrator's
existing run_in_executor wrapper still works"; because of the branch, it does not. So
turning the flag on moved detect from the deliberate 4-thread pool to 32 threads, all
piling onto `FaceRuntime._call_lock` and the GIL.

Fixed: both `detect_async` fallbacks now dispatch on `get_gpu_pool()`, and `AsyncBatcher`
takes an explicit `executor` that the inference batchers set to the GPU pool instead of
inheriting the default.

**This one is a correctness fix, not a measured win.** It was found by reading the branch,
not by the numbers: the first post-change samples (detect 35 ms, then 43 ms *after* the
fix) were both taken ~60–75 s after a container restart, against a "before" taken on a
process that had been warm for 26 hours. That comparison is worthless in both directions —
ORT autotunes on first calls and the cameras are still re-syncing. Steady-state numbers are
in §6; treat anything sampled inside the first few minutes after a restart as warm-up.

**The general lesson:** `run_in_executor(None, ...)` on an inference path is a bug
regardless of what the benchmark says. The pool split in `core/executors.py` only helps if
every dispatch site actually names a pool.

### P2 · Genderage on-demand + batched — **-1.8 ms/face where it runs**

`INSIGHTFACE_ONDEMAND_GENDERAGE` already defaults to `True`, so the per-track vote already
bounds this to `attributes_max_votes` calls per track rather than one per face per frame.
Batching the remaining calls takes them from 1.97 to 0.17 ms/face — a smaller, later win.

### P3 · TensorRT FP16 — **blocked, and not by us**

ORT reports `TensorrtExecutionProvider` as available. **It is not.** The library is missing
from the image and every session silently falls back to CUDA:

```
Failed to load library .../libonnxruntime_providers_tensorrt.so:
libnvinfer.so.10: cannot open shared object file: No such file or directory
*** EP Error *** Falling back to ['CUDAExecutionProvider', 'CPUExecutionProvider']
```

Any past or future "TRT is enabled" claim based on `get_available_providers()` is worthless —
check `session.get_providers()[0]` instead. Needs TensorRT in the Dockerfile before it can
even be measured. Pin outside TRT 10.0-10.5 (NMS/NonZero regression hits SCRFD post-proc).

### P4 · Accuracy track (separate, opt-in, needs re-enrollment)

Ranked by measured or research-backed effect, not by novelty:

1. **3-5 pose-diverse enrollment images per person** (1 frontal + 2 profiles) — the largest
   accuracy lever we have, and it is not a model change.
2. **Per-camera FNIR@FPIR thresholds** via `eval/frvt.py` instead of one global cosine.
   FPIR scales with gallery size; a 200-enrollee threshold over-fires at 5,000.
3. **AdaFace as default recognizer** — measured +1.0 pp TPR, +0.073 median margin, a strict
   superset of ArcFace matches. Affordable *only because P0 frees the compute*. Requires a
   full gallery re-embed.
4. **CCTV-crop probe set.** Today's benchmark is enrollment stills — an upper bound.
   Until this exists we are tuning against the easy case.

---

## 4. What we are deliberately *not* doing

| Not doing | Why |
|---|---|
| Swapping SCRFD for YOLO-face / MogFace | Every real-time alternative is within +/-1 AP on WIDER-HARD. Resolution + tiling beats the swap. |
| Swapping R50 for MobileFaceNet on dGPU | Saves ~0.3 ms/face, costs accuracy. Wrong lever (section 1). |
| INT8 on the embedder | The "99.80% INT8" figure is Intel CPU + saturated LFW; it cannot see tail degradation at low FPIR. Detector-only, and only gated on `eval/frvt.py`. |
| Super-resolution before embedding | No 2024-26 study shows SR-then-recognize beating quality-aware FR. Thumbnails only. |
| DeepStream | Not until ~100+ cams/GPU. No built-in landmark alignment. |

---

## 5. The edge profile — where "lightweight model" *is* the answer

Everything above is the dGPU story. On Jetson Orin / CPU relay nodes the arithmetic inverts:
the recognizer stops being launch-bound and 174 MB / 6.3 GFLOPs becomes real cost.

That deployment gets its own profile — smaller recognizer, smaller detector, INT8 detector —
selected by config, **never** by changing the dGPU default. Keep the two honest and separate;
a gallery embedded by one model cannot be searched by the other.

---

## 6. Live result on `drisyam-original` — what actually moved

Both samples are rate-based deltas (counter A, gap, counter B) on the same 4 demo cameras
at the same ingest rate. "Before" is a process warm for 26 hours; "after" is warm for
6.5 minutes — `quality` returning to 0.42 ms confirms the warm-up had cleared.

| | Before | After | |
|---|---:|---:|---|
| frames ingested | 23.2 fps | 23.8 fps | same load |
| **detect calls** | **23.19/s** | **11.89/s** | **−49%** |
| detect mean latency | 16.25 ms | 17.46 ms | unchanged (noise) |
| quality mean latency | 0.38 ms | 0.42 ms | unchanged |
| detector time per camera-second | **94 ms** | **52 ms** | **−45%** |

**Read this carefully — the win here is fewer calls, not faster calls.** `DETECT_EVERY_N_FRAMES=2`
halved the detector's workload at identical ingest and identical box-update rate (the Kalman
tracker publishes predicted boxes on the skipped frames). Per-call latency did **not**
improve: the 16:9 input saves ~1.8 ms of ONNX tensor time, but live detect is ~17 ms of
which only ~6 ms is the ONNX call — the rest is frame resize, SCRFD post-processing in
numpy, lock wait and the executor hop. That 1.8 ms disappears into the noise. If per-call
detect latency is the target, **the remaining cost is host-side, not model-side**, and a
smaller detector would not fix it either.

**What this sample does NOT show:** the 5.3x recognizer win. `vms_embeddings_total` was
**0 in both windows** — the demo cameras produced no quality-passing faces while sampling,
so the embed path never ran in either configuration. The evidence for that win is the
microbenchmark and the parity gate (§1, §3), not this table. Re-run the comparison against
a camera with real face traffic before quoting a combined figure.

Targets in §2 are therefore **partially evidenced**: the detector half is measured, the
recognizer half is measured in isolation, and cameras-per-GPU has not been load-tested.

---

## 7. How each claim here was measured

```bash
# parity gate - MUST pass before enabling insightface_batched anywhere, and
# again after any change to alignment, preprocessing or the model pack
docker exec drisyam-original-ai sh -c 'cd /srv/app/face_detection/vms_face && \
  python -m vms_face.eval.recognizer_parity --images data/known_faces --limit 10'

# A/B the two backends end-to-end (they share an embedding space, so the
# numbers are directly comparable)
docker exec drisyam-original-ai sh -c 'cd /srv/app/face_detection/vms_face && \
  python -m vms_face.eval.harness --gallery /tmp/eval_data/gallery \
    --probe /tmp/eval_data/probe --manifest /tmp/eval_data/manifest.csv \
    --threshold 0.45 --recognizer insightface_batched --out /tmp/eval_data/report_new'

# accuracy regression gate
docker exec drisyam-original-ai sh -c 'cd /srv/app/face_detection/vms_face && \
  python -m vms_face.eval.harness --gallery /tmp/eval_data/gallery \
    --probe /tmp/eval_data/probe --manifest /tmp/eval_data/manifest.csv \
    --threshold 0.45 --out /tmp/eval_data/report'
```

Lifetime metric averages (`vms_*_latency_seconds_sum/count`) reset on restart and are skewed
by warm-up — **never A/B with them**. Sample the counter twice with a gap and take the delta.
