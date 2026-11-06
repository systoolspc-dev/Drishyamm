# Drishyam Face Engine — System Design at Every Level

**Status:** design, 2026-09-20. Measured on `drisyam-original` (RTX PRO 5000 72 GB Blackwell; Docker VM 16 vCPU / 47 GB; CUDA 12.8.1, cuDNN 9, ORT 1.26.0).
**Builds on:** `FACE_LIGHTWEIGHT_TARGET.md` (model-level measurements, 2026-09-19) and `FACE_EDGE_REALTIME_PLAN.md` (cache system L0–L4, edge tiers, roadmap). Those two are the *what*; this is the umbrella *how* — hardware → OS/process → pipeline → data → web → model — with, at every level, the mechanism, the measured number that justifies it, and the gate that proves it.

> **Thesis.** The model is not the bottleneck; the system around it is. Today one camera costs **0.40 CPU cores just to decode a stream we use 30% of**, the detector's Python wrapper costs **~2× the model**, **99.85% of detections are thrown away** after paying for tracking, and TensorRT is advertised but **not installed**. None of that is fixed by a smaller `.onnx`. All of it is fixed below, and every fix is gated by a parity check so no stored embedding ever changes.

---

## 0. The design in one table

Per camera, at 8 fps ingest / 4 fps detect, faces present. "Today" is measured on this box unless marked *modelled*.

| Resource | Today | Designed | Mechanism | Level |
|---|---:|---:|---|---|
| CPU to decode | **0.40 core** (1080p HEVC, software, 27 fps × 14.6 ms) | ≤ 0.02 core | 720p sub-stream + NVDEC; one decoder per camera per host | HW · SYS |
| Host CPU per detect call | **~11 ms** (resize, pre/post-proc, NMS, lock wait, executor hop) | ≤ 2 ms | GPU pre-processing, IOBinding, no lock, no thread hop | HW · OS |
| GPU per detect | 5.9 ms (960×544, CUDA EP FP32) | ≤ 2.5 ms | TensorRT FP16 + cross-camera batch 4–8 | HW |
| GPU per face embed | 0.68 ms batched (3.8 ms at batch 1) | ≤ 0.4 ms | already batched; FP16 | HW |
| Embeds per track | ≤ 5 (identity latch, shipped) | ≤ 4 median | L0 latch + quality-weighted fusion | SYS |
| Threads in the process | **546** (480 ORT/pool threads + 16 decoder threads per camera) | ≤ 80 | thread caps; NVDEC needs 1 | OS |
| VRAM per process | ~0.4–0.6 GB (3 detector replicas) | ≤ 0.3 GB | one thread-safe session, no replicas | HW · OS |
| Overlay traffic | 8 Hz Redis + 5 Hz HTTP, every camera, always | 5 Hz binary, only cameras being watched | viewer-gated, per-camera rooms | WEB |
| Wasted detections | **99.85%** rejected `too_small`; 139k phantom tracks / 143k detections | ≤ 20% | size-aware detection *before* tracking; per-camera min face px | SYS |
| Cameras per GPU @ 4 fps | ~32 *(modelled, never load-tested)* | ≥ 60 (Phase 0–1) · ≥ 180 (Phase 2) | all of the above | — |

Accuracy is held constant by construction: no step changes a stored embedding (`recognizer_parity` cosine ≥ 0.9999 is a hard gate), and FNIR @ FPIR = 1e-3 on our own probe set is the accuracy gate once an impostor set exists (§4).

---

## 1. Measured baseline — 2026-09-20

### 1.1 Hardware and runtime, as found

- **GPU** RTX PRO 5000 72 GB Blackwell (compute 12.0, driver 582.16). Datacenter NVENC/NVDEC — no concurrent-session cap. Host: Core Ultra 9 285K (24 threads), 127 GB RAM; Docker VM 16 vCPU / 47 GB.
- **TensorRT is not installed.** ORT 1.26.0 advertises `TensorrtExecutionProvider`, but `ldd libonnxruntime_providers_tensorrt.so` → `libnvinfer.so.10 => not found`, `libnvonnxparser.so.10 => not found`. Every session silently runs CUDA EP FP32. Check `session.get_providers()[0]`, never `get_available_providers()`.
- **NVDEC is reachable** (this supersedes the August finding that it was a no-op on PyAV 13): PyAV 17.0.1 / libavcodec 62 ships `hevc_cuvid`; hw devices `cuda, qsv, drm, amf`; `/usr/lib/x86_64-linux-gnu/libnvcuvid.so.1` is present; the system ffmpeg has `-hwaccel cuda`. NVENC already works from the VMS transcoder in the same Docker/WSL2, so the video capability is passed through.
- Not in the image: `tensorrt`, `cupy`, `torch`, `PyNvVideoCodec`, `pycuda`.

### 1.2 Decode cost (camera `fc7efa19`, 120 frames after warm-up, CPU-seconds including BGR conversion)

| Path | Resolution | CPU per frame | Cores while decoding |
|---|---|---:|---:|
| Software (what runs today) | 1920×1080 HEVC | **14.6–15.1 ms** | 0.38–0.40 |
| NVDEC `hwaccel=cuda` + download + NV12→BGR on CPU | 1920×1080 | 9.6 ms | 0.27 |
| Software, sub-stream | 640×360 HEVC | **2.5 ms** | 0.04 |

The decoder must decode every frame the camera sends (27 fps) although the pipeline consumes 8 — a P/B-frame stream has no "decode only what I use". The bill is per *source* frame. NVDEC alone saves 36%; the residual is the 6.2 MB device-to-host copy plus colour conversion of 2 MP. The real lever is pixels: the sub-stream cuts CPU **5.8×**; GPU-resident frames cut it to ~0.

### 1.3 The process (uvicorn pid 43, uptime 4.1 days, 2 orchestrators)

- **546 threads.** 480 unnamed (`uvicorn`) = ORT intra-op pools — insightface's `model_zoo` builds every session with default `SessionOptions`, i.e. one spinning pool sized to all 16 vCPUs *per session* — plus ingest pool 256, io 32, gpu 4, asyncio. 48 `av:hevc:df0..15` decoder threads = 16 per decoder × **3 decoders for 2 orchestrators** (56 stream restarts in the window — check for a decoder leak on restart).
- RSS 4.6 GB. 0.55 core at 2 cameras with no faces.
- **Models:** `det_10g` ×3 replicas, each behind its own `Lock` (insightface `FaceAnalysis` is not thread-safe); `w600k_r50` ×1 (process singleton via `insightface_batched`); `genderage` on demand; aux landmark heads (`2d106det`, `1k3d68` = 142 MB) correctly not loaded. Sessions: `graph_optimization_level=ALL` only — no FP16, no IOBinding, no CUDA graphs.
- **Detect batching is off in practice:** `det_10g.onnx` pins batch = 1, so `BatchedSCRFD` latches `_batched_unavailable` and falls back per image. Embed batching is on, mean batch 1.0 at 2 cameras (`vms_batch_size`).

### 1.4 Pipeline counters (4 days, main-stream 1080p ingest at 8 fps)

| Counter | Value | Reading |
|---|---:|---|
| frames ingested | 386,257 | 8 fps × 2 cameras |
| motion-gate skips | 326,259 (193k cadence · 133k motion) | 84% of frames never reach the detector — the gate works |
| detect calls | 59,998 | mean **18.4 ms**; 71% ≤ 20 ms; 99% ≤ 50 ms |
| detections | 143,235 | |
| quality rejects | 143,019 — 142,982 `too_small` (< 40 px) | **99.85%** of detections are unusable |
| tracks opened | **139,496** | ≈ one track per detection: phantom-track churn |
| embeddings | 207 | |
| latch decisions / verdicts | 213 / 46 | |
| `vms_pipeline_frame_latency` | 163.8 ms mean | *includes the wait for the next frame* (125 ms period at 8 fps) — not a cost metric; split it into stage timers |

On 1080p main-stream frames the detector finds hundreds of thousands of 10–40 px faces it can never use, and each costs tracker time, a quality check and Python. Detection has to be size-aware and it has to run on the sub-stream.

### 1.5 Web path, as built

AI orchestrator → **(a)** Redis pub/sub per frame (8 Hz) for the AI's own `/ws`, and **(b)** HTTP `POST /internal/ai/overlay` every ≥ 200 ms per camera (`backend_overlay_min_interval_sec`) → Node emits Socket.IO `ai.live` to the `user:<id>` room → `AIOverlay.jsx` keeps a per-track velocity model and draws the *predicted* box every animation frame (extrapolation cap 250 ms, stale 1.2 s). The consumer side is already right. The producer side pushes for every camera whether or not anyone is watching, on two channels, as JSON.

### 1.6 Evaluation assets

`data/known_faces`: 50 identities, 245 images (≈ 4.9 / identity). `data/unknown_faces`: **0 images** → FNIR @ FPIR is not computable today. Tooling exists: `eval.harness` (TPR/FPR/F1), `eval.frvt` (FNIR @ FPIR), `eval.recognizer_parity`, `eval.remote_parity`, `eval.det_size_sweep`, `eval.video_pilot`.

---

## 2. Principles every level obeys

1. **Do each piece of work once.** Decode once per camera per host. Embed a few times per track. Search once per identity.
2. **Move bytes less.** Frames stay on the GPU. Crops travel as PNG only across machines. Results travel as ids, not vectors.
3. **Batch across cameras, never within one.** Latency stays at one frame; throughput comes from the fleet.
4. **Latest frame wins at every boundary.** Frame *age* ≤ one period is the contract; frame *rate* is negotiable.
5. **Cache by identity, not by frame** (L0 → L4, shipped).
6. **Nothing ships without a number.** Parity gate for vectors, FNIR @ FPIR for accuracy, cameras/GPU at p95 for capacity.

---

## 3. The design, level by level

### 3.1 Hardware — GPU, NVDEC, PCIe

**Decode on NVDEC and keep frames on the GPU.**

- *Step 1 (now):* PyAV `HWAccel(device_type='cuda')` — measured working today; 9.6 ms CPU/frame at 1080p and ~2 ms at 720p (modelled from pixels). Wire it to the existing `RTSP_HWACCEL` setting and assert `frame.format.name == 'nv12'` at open so a silent software fallback is impossible.
- *Step 2 (scale):* GPU-resident path. `PyNvVideoCodec` (NVIDIA's Python NVDEC, CUDA-array-interface output) → CuPy/NPP resize + NV12→planar RGB float16 on the GPU → `OrtValue` on device via IOBinding → SCRFD. **Zero host↔device copies per frame.** DeepStream (the `Dockerfile.deepstream` image exists, unwired) does decode → pre-proc → TensorRT → tracker in C and is the shape for ≥ 100 cameras/GPU per the 2k-camera plan; the Python zero-copy path is the ≤ 100 shape that keeps every line of identity logic in `vms_face` unchanged.
- *PCIe budget:* a 1080p BGR frame is 6.2 MB. 100 cameras × 8 fps = **5 GB/s** host→device if frames are uploaded — near a PCIe 4 ×16 link and entirely avoidable. Rule: upload nothing per frame; download only 112×112 crops when the embedder runs on another machine.

**Inference on TensorRT FP16 with cached engines.**

- Put `libnvinfer.so.10` in the image (`pip install tensorrt-cu12-libs==10.x` matching the minor ORT 1.26 was built against, or apt `libnvinfer10`) and verify `session.get_providers()[0] == 'TensorrtExecutionProvider'` at startup — fail loud, never fall back silently.
- Provider options: `trt_fp16_enable=1`, `trt_engine_cache_enable=1`, `trt_engine_cache_path=/srv/data/trt`, `trt_timing_cache_enable=1`, explicit `trt_profile_{min,opt,max}_shapes` for the dynamic batch axis (detector `1/4/8 × 3×544×960`; recognizer `1/16/32 × 3×112×112`), `trt_cuda_graph_enable=1` where shapes are static.
- Expected: `det_10g` 5.9 → ~2.5–3 ms; R50 at batch 16 0.42 → ~0.2 ms/face. **Gate:** `recognizer_parity` cosine ≥ 0.9999 against CUDA FP32. If FP16 drifts, the embedder stays FP32 and only the detector takes TensorRT — still the larger win. Detector gate: boxes within ±1 px and scores within ±0.01 on the probe set.
- Engines build in minutes and are **not portable across GPU SKUs**: build into a named volume at container start, never in the request path; ship prebuilt engines per SKU for prod.

**Load weights once, share them with every camera in the process.** ORT `InferenceSession.run()` is thread-safe. The three replicas and three locks exist only because insightface `FaceAnalysis` is not. Replace `FaceAnalysis` on the hot path with our own SCRFD wrapper over **one** session (`BatchedSCRFD` already owns pre/post-processing): no lock, no replicas, VRAM ÷ 3, and the number of cameras in flight is bounded by the GPU, not a mutex. Keep `FaceAnalysis` for enrollment and tools.

**Edge tiers** are unchanged from `FACE_EDGE_REALTIME_PLAN.md` §5 (Orin Nano / RK3588 / N100 / RPi5+Hailo). Same pipeline, smaller profile; detect-track-crop-only with server embeds is the first shape and is already shipped (`RECOGNIZER_BACKEND=remote`, `/edge/*`).

### 3.2 OS, container and process

**Threads: 546 → under 80.**
`SessionOptions.intra_op_num_threads = 2` and `inter_op_num_threads = 1` for every GPU session (the GPU does the work; host threads only launch kernels), `add_session_config_entry("session.intra_op.allow_spinning", "0")` so idle pools stop burning CPU; PyAV `stream.thread_count = 2` with `thread_type = 'FRAME'` (1 with NVDEC); ingest pool sized `min(cameras + 4, 64)` instead of a fixed 256; `OMP_NUM_THREADS=1` and `cv2.setNumThreads(1)` per process so NumPy/OpenCV don't spawn their own pools.

**Memory.** Per-session `gpu_mem_limit` and `arena_extend_strategy=kSameAsRequested` so one ORT arena cannot balloon and evict another process; pinned host buffers only where a copy is unavoidable; `--cpus` / `--memory` per service so decode can never starve inference; Redis with transparent hugepages off.

**Process model — the GIL escape.** One process currently does decode, tracking, Python bookkeeping and inference dispatch for every camera; the GIL caps it (head-count hit the same ceiling at ~175 inferences/s per process). Split it:

| Process | Owns | Nature |
|---|---|---|
| `camera-worker` × K | 8–16 cameras each: NVDEC decode, motion gate, tracker, identity latch, overlay | CPU-bound Python, no models, no inference context |
| `inference-service` × 1 per GPU | the ORT/TensorRT sessions; cross-camera batching | GPU-bound, no per-camera state |
| `api` × 1 | FastAPI, enrollment, `/edge/*`, `/ws`, metrics | I/O |

Transport between workers and the inference service is a **shared-memory ring per camera** (`/dev/shm`, sequence-numbered, latest-wins) carrying frames or aligned crops in, boxes and vectors out — no JSON, no sockets on the hot path; dispatch stays under 0.3 ms. This is the existing `AsyncBatcher` moved across a process boundary. **Triton Inference Server** (gRPC, dynamic batching, TensorRT backend, model warm-up) is the same idea for the multi-host case and slots in behind the same interface — adopt it only when inference must be shared across machines.

Failure domains: a worker crash loses its cameras for seconds and nothing else; an inference restart makes workers hold their latest frame and resume. Each is supervised independently.

**Scheduling.** Workers `nice 5`, inference `nice -5`; keep two cores free of decoder threads for the inference dispatcher. On Linux prod, CUDA MPS when several processes share a GPU (not available on the WSL2 dev box).

**Container.** `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video` (present), `ulimit -n 65536`, RTSP over TCP with `rw_timeout` (present), a health endpoint per process, TensorRT engine cache on a named volume.

### 3.3 System — the pipeline

**Shared decode tier.** One decoder per camera per host feeds every analytics consumer — face, head-count, zone-guard, activity — through the shared-memory frame bus. Today the same camera is decoded by the face engine (PyAV), head-count (OpenCV, with its global RTSP mutex) and the VMS transcoder (ffmpeg): three decodes of one stream. Consumers subscribe at their own cadence; latest-wins per consumer.

**Sub-stream ingest at 1280×720, 8–10 fps.** Reconfigure the NVR sub-stream from 640×360 to 1280×720 (≈ 0.3–0.5 Mbps per camera; all 17 ≈ 8 Mbps — the NVR's limit was reconnect *rate*, never bandwidth). Detector input 960×544 (0.44 MP, a cheap 2× downscale on the GPU) or 1280×736 native for long-range cameras at +36% GPU. The main stream is for humans. Range is set by physics, not megapixels: a 40 px face at 720p is the same physical face as 60 px at 1080p, and head-count's measured px/lux/shutter limits still apply.

**Size-aware detection.** (a) Reject faces below the camera's `min_face_px` at the detector output, *before* the tracker — this removes the 139k phantom tracks for free. (b) Derive `min_face_px` per camera from calibration: the recognizer needs ≥ 40 px, enrollment quality ≥ 60. (c) For cameras whose minimum usable face is ≥ 40 px, export an SCRFD variant without the stride-8 head — those anchors only detect 10–32 px faces, and they are ~60% of all anchors and most of the NMS work.

**Zones.** Detect only inside configured face zones (crop → smaller tensor, fewer false positives). Zones already exist for alerts; reuse them.

**Attention scheduling.** Per camera: 1 fps while the motion gate is quiet, 4 fps baseline, burst to 8 fps for ≤ 2 s while any track is `NEW`/`CANDIDATE` (time-to-identity is what the user sees), back to 4 once latched. GPU time is spent where identity is still undecided.

**Cross-camera batching.** Re-export SCRFD with a dynamic batch axis (unblocks `BatchedSCRFD`); batcher window 3 ms, max 8 → 3–5× detect throughput in the earlier benchmark. Embed batches already exist; at scale the mean batch rises by itself.

**Embedding budget.** The latch keeps embeds ≤ 5 per track (shipped). Add quality-weighted template fusion — weight by quality score, drop |yaw| > 30° — an accuracy lever at zero cost.

**Tracker.** SORT/Kalman in NumPy is fine at ≤ 50 real tracks per camera once phantoms are gone; Hungarian on ≤ 20×20 is microseconds.

**Backpressure.** Depth-1 leaky queues at every boundary (ingest has one; the shm bus enforces it). If inference falls behind, cameras drop frames — they never age.

**Match.** L0–L4 as shipped. Brute-force float32 over a local gallery of 10k identities × 512 dims is 5 M MACs ≈ 1 ms in NumPy; int8 at 100k; Qdrant remains the source of truth and the path beyond that.

### 3.4 Data and cache

- **Hierarchy (shipped):** L0 identity latch per track · L1 track template pool · L2 hot set per camera/tenant · L3 local gallery (float32/int8, versioned, pub/sub-invalidated) · L4 Qdrant + Postgres.
- **Add:** a crop-similarity memo — skip the embed when the aligned crop is within ε of the last embedded crop for that track (32×32 MSE, microseconds); a verdict memo per (camera, track) with TTL; snapshot de-duplication per track (top-k exists).
- **Payloads:** candidates carry a crop id plus an int8/float16 vector — or no vector when the worker can read the local gallery itself (−60–90% Redis bytes); msgpack instead of JSON on `vms.detections`.
- **Redis:** stream caps done (4.25 GB → 496 MB); fix consumer-group ack hygiene (`reid-workers` had 215k pending).
- **Qdrant:** scalar int8 quantization with rescoring, HNSW `m=16 / ef_construct=128`, payload index on tenant; float16 snapshots for edges (shipped).
- **Postgres:** batch `DetectionEvent` inserts above ~50/s (COPY / executemany); Timescale retention (shipped).

### 3.5 Web and API

- **One overlay channel.** Retire the per-frame Redis pub/sub path for the console; Node fans out from the 5 Hz forwarder. Rooms per **camera** (`cam:<id>`), not per user — fan-out cost becomes per camera, viewers join rooms.
- **Viewer-gated publishing.** The AI publishes overlay frames only for cameras with ≥ 1 subscriber (Node tracks subscriber counts and announces changes on a channel the AI listens to). Recognition and alerts run regardless; overlay bytes do not.
- **Binary delta frames.** `[camera, ts, n, (track u16, x u16, y u16, w u16, h u16, state u8)…]` ≈ 10 bytes per box against ~120 as JSON; names and labels go once per track on change. Client-side prediction stays as built.
- **Snapshots:** WebP q80 for thumbnails; uploads already off the hot path.
- **Edge API:** HTTP/2 keep-alive for `/edge/embed` and `/edge/embed/batch`; PNG only (JPEG q92 measured at cosine 0.977–0.994 — not interchangeable); gallery snapshot ETag = version (shipped).
- **Frontend:** DOM/canvas writes inside `requestAnimationFrame`, no React re-render per frame (shipped).

### 3.6 Model and accuracy

- The server keeps **SCRFD-10G-KPS + ArcFace R50** — the accuracy ceiling for this embedding space. TensorRT FP16 behind the parity gate; INT8 only for the detector, post-training quantised, behind a boxes-parity gate.
- Accuracy levers that outweigh any model swap, in order: enrollment quality (≥ 5 images with pose spread — the gallery is at 4.9), alignment parity, per-camera threshold from an FPIR sweep, quality-weighted template fusion, K-of-N + margin (shipped), a negative gallery for known non-persons (staff on posters, mannequins).
- Edge models (MobileFaceNet / EdgeFace-class, distilled on our own footage) follow the plan's Phase 3; escalation to the server closes their gap and its API is shipped.
- The server model is **not retrained** in Phases 0–2, so its public-benchmark numbers equal the reference model's by construction. Claims are made on our own probe set with the FRVT metric.

---

## 4. Benchmarks — what we beat, and how we prove it

**Reference** = InsightFace `FaceAnalysis(buffalo_l)` as shipped: detect at 960² on every frame, embed every face at batch 1, no state between frames. Cost `7.74 + F × 3.82 ms` per frame → 23 ms at F = 4 → ~32 cameras/GPU at 4 fps; time-to-identity is "whenever the next frame comes".

| Axis | Reference | Today (ours) | Phase 0 gate | Phase 1 gate | Proof |
|---|---:|---:|---:|---:|---|
| GPU ms / processed frame (F = 4) | 23.0 | ~8.6 (5.9 + 4 × 0.68) | ≤ 5.5 | ≤ 4.0 | microbench + `vms_detect_latency` |
| Host CPU ms / detect call | — | ~11 | ≤ 4 | ≤ 2 | stage timers |
| CPU cores / camera (decode) | 0.40 | 0.40 | ≤ 0.06 | ≤ 0.02 | decode bench (§8) |
| Cameras / GPU @ 4 fps detect | ~32 | ~32 *(modelled)* | ≥ 60 | ≥ 180 (Phase 2) | load rig, p95 detect ≤ 40 ms |
| Time-to-identity provisional / confirmed | — | 0.47 s / 1.06 s | hold | ≤ 0.4 / ≤ 0.9 s | `vms_time_to_identity_seconds` |
| Embeds per track (median) | faces × frames | ≤ 5 | ≤ 5 | ≤ 4 | `vms_embed_skipped_total` |
| VRAM / process | — | ~0.4–0.6 GB | ≤ 0.3 GB | ≤ 0.3 GB | `nvidia-smi` |
| Threads / process | — | 546 | ≤ 80 | ≤ 40 per worker | `/proc/<pid>/status` |
| Overlay bytes / camera / s while viewed | — | ~2 KB JSON × 13 Hz | hold | ≤ 0.3 KB × 5 Hz | wire capture |
| Wasted detections | — | 99.85% | ≤ 20% | ≤ 10% | `vms_quality_rejects_total` |
| TPR / FPR on the probe set | 0.969 / 0.000 | same (bit-identical vectors) | same | same | `eval.harness` |
| FNIR @ FPIR = 1e-3 | not measurable | **0.021** (48 mated stills + 300 office impostors, 2026-09-21) | measured ✓ | ≤ reference | `eval.harness` |
| Vector parity vs reference | 1.0 | 1.0 | ≥ 0.9999 | ≥ 0.9999 | `eval.recognizer_parity` |

The Phase 0 action that unblocks the accuracy rows: build an **impostor set** — ≥ 500 face crops of people who are not enrolled (other sites with consent, plus a public distractor set) — so FPIR is measurable. Until then "accuracy" is a threshold anecdote, and no benchmark claim is honest.

**Load rig** (no customer NVR involved): `ffmpeg -re -stream_loop -1` of face footage published to N MediaMTX paths on the host, the engine subscribed to all N; raise N until p95 detect > 40 ms or frame age > 250 ms. That number is "cameras per GPU".

---

## 5. Roadmap with gates

| Phase | Scope | Deliverables | Exit gate (measured) |
|---|---|---|---|
| **0 · Stop wasting** (≈ 1 week, no new services) | HW · OS · SYS | NVR sub-stream → 1280×720 @ 8–10 fps and AI template → `cam_{id}_sub` · NVDEC on through PyAV (assert `nv12`) · thread caps (ORT, PyAV, OMP, pools) · size filter before the tracker + per-camera `min_face_px` · TensorRT libs in the image, engine cache, FP16 detector, parity gates · one thread-safe SCRFD session, replicas = 1, no lock · stage timers replacing the frame-loop metric | CPU ≤ 0.06 core/camera · detect p95 ≤ 12 ms at 8 cameras · threads ≤ 80 · wasted detections ≤ 20% · parity ≥ 0.9999 · TPR/FPR unchanged |
| **1 · Scale in one box** (2–3 weeks) | SYS · DATA · WEB | dynamic-batch SCRFD export → cross-camera batches · IOBinding + GPU pre-processing · attention scheduling · viewer-gated overlays, per-camera rooms, binary frames · shared decode tier feeding head-count · impostor set + FNIR gate · load rig | ≥ 60 cameras/GPU @ 4 fps with p95 detect ≤ 40 ms · FNIR @ FPIR = 1e-3 measured · overlay bytes −80% |
| **2 · Escape the GIL** (3–4 weeks) | OS · HW | `camera-worker` + `inference-service` over shared memory · GPU-resident decode (PyNvVideoCodec or DeepStream) · Triton evaluated for multi-host | ≥ 180 cameras/GPU (plan tier A) · frame age ≤ 250 ms at that load |
| **3 · Edge and small models** | MODEL | plan's Phase 2–3: edge container per tier, distilled embedder, INT8 detector, per-camera thresholds | plan's gates (student within 1.5× teacher FNIR; edge tiers ≥ 6 cameras at 4 fps) |
| **4 · Fleet** | SYS · DATA | multi-host inference, gallery sync with versioned deltas, per-NVR admission control | delete propagates ≤ 60 s · no NVR exceeds its measured session budget |

Phase 0 is entirely configuration, thread settings, one image change and one wrapper — and it removes the four largest costs measured above. Do it first; decide on the process split only if Phase 0 + 1 do not reach 60 cameras.

### Phase 0 — shipped 2026-09-20 (same day), measured on the same box

Everything below is live on `drisyam-original` and baked into the `smart-cam-ai` image (TensorRT 10.16 libs, ORT 1.26.0 pinned, `LD_LIBRARY_PATH`, `OMP_NUM_THREADS=1`). Code is bind-mounted; a container restart picks it up.

| Piece | Where | Result (measured) |
|---|---|---|
| TensorRT actually loaded — libnvinfer preloaded with `RTLD_GLOBAL`, checked by `dlopen`, never by `get_available_providers()` | `infra/ort_session.py` | detector, recognizer and genderage sessions report `TensorrtExecutionProvider`; engines cached on the insightface bind mount (`trt_cache/`) |
| Detector on TensorRT FP16 via a **static 1×3×544×960 re-export** — the shipped export names H and W with the same symbol `'?'`, which TensorRT reads as "must be equal" and refuses (profile or not) | `ort_session.ensure_static_detector`, loader hook | **3.56 ms vs 5.63 ms** CUDA FP32 per call (−37%); raw-output parity max \|Δscore\| 0.0019, max \|Δbox\| 0.23 px, 98.9% anchor agreement; ~6 s one-time build, 8–13 ms warm-up from cache |
| Recognizer on TensorRT FP32 | same | cosine vs CUDA FP32 **0.999999** (FP16 0.999964 — passes the 0.9999 gate but is no faster at batch 16: 0.63 vs 0.49 ms/face, so it stays FP32) |
| One session, no lock, no replicas (`FaceRuntime._guard`; `shared()` delegates to the pool) | `infra/insightface_runtime.py` | one detector session per size for pipeline *and* API (was 2 + 3 replicas) |
| ORT thread budget (2 intra / 1 inter, spinning off), decoder threads 2 (1 on NVDEC), OpenCV 1 | `ort_session.session_options`, `pipeline/ingest.py` | **546 → 102–114 threads**; RSS 4.6 → 2.0–2.6 GB |
| insightface loader hook: skip excluded heads *before* a session exists | `ort_session.install_insightface_session_policy` | 142 MB of landmark models no longer loaded and discarded at every start |
| NVDEC through PyAV's `HWAccel` (the old demuxer-option form was a silent no-op) | `pipeline/ingest.py`, `RTSP_HWACCEL=cuda` | all cameras `frame_format=nv12 hw=True threads=1`; NVDEC util 4–5%; `vms_hw_decode` gauge |
| Size + score filter **before** the tracker | `orchestrator._filter_observations` | 1,623 too-small + 30 low-score detections dropped, **9 kept, 1 track opened** — was one track per detection |
| Snapshot fallback encodes a ≤640 px copy at ≤2 fps, not the 1080p frame at 4 fps | `services/snapshot_cache.py` | overlay-stage median 2 ms (was 3–5) |
| Stage timers `vms_pipeline_stage_seconds{wait,detect,track,overlay,faces,work}` | `core/metrics.py`, orchestrator | the old frame timer measured the loop *period* (150 ms); work is 15.6 ms mean |

**Gate check, honestly:** threads ≤ 80 → **114** (close; the rest are ORT/TRT internals and pools). Wasted detections ≤ 20% → **met** (tracker sees only gate-passing faces). Parity ≥ 0.9999 → **met**. CPU per camera → ~0.15 core at 1080p main-stream (decode is now free; the remainder is per-frame Python) — **not yet 0.06**: that needs the sub-stream and the overlay work below. Detect p95 ≤ 12 ms → **not met**: median ~13 ms, p95 ~45 ms at 4 cameras. The model is 3.6 ms; the rest is insightface's host-side pre/post-processing and event-loop contention — the Phase 1 GPU-preprocessing/IOBinding item, not a TensorRT problem.

**What the stage timers exposed (next targets, in order):**
1. `overlay` has a 10% tail of 20–500 ms on *every* frame, faces or not. Median is 2 ms, so this is not the publish itself — it is the asyncio loop being starved by GIL-holding threads (decode conversion, detector post-processing). That is the §3.2 process split, measured.
2. Detect host overhead ~10 ms/call over a 3.6 ms model — GPU pre-processing + IOBinding (§3.1).
3. Sub-stream ingest — the yield test (`substream_yield.py`) must run during office hours; an empty office proves nothing.

**Gotchas that cost time (so nobody pays twice):** ORT's TensorRT options take the literal strings `True`/`False` — `"1"` fails the whole provider silently. Protobuf `dim_value`/`dim_param` are a oneof: pin with `dim_value` only; clearing `dim_param` afterwards un-pins the dim to `None`, which insightface reads as an input size of `(None, None)`. `FaceAnalysis` builds a session for every `.onnx` before honouring `allowed_modules`. `docker exec` needs `-i` for a heredoc. A non-reentrant module lock around a function that calls back into itself deadlocked the service at startup — `RLock`. The rebuilt image carries PyAV 18.1 (requirements float `av>=13.1`); the `HWAccel` path is verified on it.

### Phase 1 — in progress 2026-09-20 (evening): batching live, and the first load test

| Piece | Where | Result (measured) |
|---|---|---|
| **Cross-camera detect batching** — dynamic-batch static-H×W export (`det_10g_960x544_batchN_static.onnx`), TensorRT profile 1/4/8, `BatchedSCRFD` reading this export's image-major `(B·A, C)` rows | `ort_session.ensure_static_detector(batch="N")`, `batched_scrfd.py` | `batched SCRFD detect enabled max_batch=8` on every session. Mean batch **1.09 at 20 cameras** — the 3 ms window rarely coincides while the detector runs every 2nd frame per camera; it fills at higher density |
| Why the graph would not batch: the export carries *intermediate* `value_info` with batch 1 baked in; ORT's buffer planner trusted it (`Shape mismatch attempting to re-use buffer {1,…} != {2,…}`). Dropping `value_info` fixes it; the `Reshape`s were already `[-1, C]` | same | batch of 2 verified image-major on CPU and CUDA |
| Recognizer TensorRT **FP16** | `settings.tensorrt_fp16_recognizer=True` | parity 0.999964 (gate 0.9999); **1.77 ms/face at batch 1** vs 5.50 FP32 — live batches are ~1.06, so FP16 wins where it matters |
| Overlay publish-on-change: ≤ 5 Hz with tracks, immediate on clear, 1 Hz heartbeat when empty | `orchestrator._update_overlay` | Redis publishes 8 → 5 Hz per camera with faces, ~1 Hz on empty scenes (most real cameras, most of the time) |
| Detector replicas 3 (cheap now: ~10 MB engines, no lock) | compose `INSIGHTFACE_RUNTIME_REPLICAS` | detect ≤ 10 ms share 26% → 36% at 4 cameras |
| **Ingest pacing fix** — emit on a schedule, not 125 ms after the previous emit | `pipeline/ingest.py` | 4.8 → 7.24 fps per camera at 21 cameras; real cameras had been running at ~6 fps against a target of 8 all along |
| **Camera sharding** — N processes, ownership by `id % N`, primary forwards start/stop, singletons on the primary only | `services/sharding.py`, `api/main.py`, `legacy.py`, `streams.py`, compose `smart-cam-ai-1` | 22 of 32 rig cameras forwarded to shard 1; no duplicates after restarts |
| **Load rig** — N publishers loop a 720p H.264 face slideshow into local MediaMTX with `-c copy`; cameras registered through the AI API; no NVR involved | `scratchpad/loadrig.py up N / measure S / down`, slideshow at `data/insightface/loadrig/faces_720p.mp4` | below |

**Load test, corrected the same evening.** The first run reported one process "pinned at ~100 frames/s from 12 cameras on". That was wrong, and the reason is a finding in its own right: the ingest throttle measured its 125 ms period from the *previous emit* instead of a schedule, so a 25 fps camera could only clear the bar every 4th–5th frame (6.25 fps) and an 8 fps source with a hair of jitter only every other frame (~5 fps). Every camera, at every load, ran at 4.8–6.0 fps against a target of 8 — including the four real cameras all along. Fixed in `pipeline/ingest.py` (schedule the next emit from the previous *due* time, accept a frame up to 25% early, resync without bursting if behind): 4.8 → **7.24 fps per camera** at the same load. The tables below are measured after the fix.

**Camera sharding (`services/sharding.py`)** — `camera.id.int % AI_SHARD_COUNT` decides which process owns a camera; shard 0 is the primary (runs the bus-fed singletons and is the address the backend calls) and forwards start/stop for cameras it does not own to the owner, verbatim; the reconciler restarts only its own. `smart-cam-ai-1` in compose inherits the primary's service and env through YAML anchors and overrides only its index. Verified: 32 rig cameras registered through shard 0 → 22 forwarded, both shards' reconcilers restart exactly their own after a restart, no camera ran twice.

| Cameras (synthetic + real) | Processes | Ingest | Detect mean / p95 / p99 | Work per frame | CPU | GPU |
|---|---|---:|---:|---:|---:|---:|
| 21 (16 + 5) | 1 | **146 frames/s** · 6.9 fps/cam | 17 ms / ≤ 50 / ≤ 100 | 13.6 ms | 2.3 cores | 19% |
| 21 (16 + 5) | 2 shards | **152 frames/s** · 7.2 fps/cam | 14 ms / ≤ 50 / ≤ 50 | 11.1 ms | 1.75 + 0.9 | 11% |
| 37 (32 + 5) | 1 | 125 frames/s · 3.3 fps/cam — **collapsed** | 142 ms / ≤ 500 / ≤ 500 | 239 ms | 3.7 cores | 24% |
| 37 (32 + 5) | 2 shards | **194 frames/s** · 5.2 fps/cam — saturating | 69 ms / ≤ 200 / ≤ 500 | 102 ms | 2.4 + 2.0 | 34% |

Worst case by construction (a face in every synthetic frame). Reading: one process keeps up to ~21 cameras (its `wait` stays under the 125 ms period) and collapses well before 37; two shards carry 21 with headroom and 37 at the edge of saturation; the GPU is at 34% at 37 cameras, so on this box the limit is CPU per process, not the card. Two more things the split exposed: shard 0 used **2.4 cores for 14 cameras** while shard 1 used 2.0 for 23 — the primary's singletons cost ~1.2 cores at this load, most of it the overlay forwarder POSTing up to 5 Hz × 37 cameras at the Node backend (viewer-gating, §3.5, removes that entirely); and cross-camera batching only starts to pay under pressure (mean batch 1.2 at two shards, 2.0 in the collapsing single process). Planning number for today: **~20 cameras per process at 7 fps, ~30–35 per two-shard box** — superseded by the Phase 2 layout below (~45 cameras at 7 fps on this box, 11 per camera shard).

### Office-hours test — 2026-09-21, real cameras, people at their desks

Everything below was measured on the live office cameras with staff present, on the two-shard deployment.

**Sub-stream, settled.** Usable faces (score ≥ 0.6, short side ≥ 40 px) in 90 s: cafeteria **920 on main vs 0 on the 640×360 sub**; WorkStation 2 **475 vs 3**; Support 12 vs 0. At 640×360 every face lands under 40 px. The main stream stays for recognition (NVDEC makes it affordable); the sub-stream is only an option if the NVR's second stream is raised to 720p, and even then range shrinks by 1.5×.

**Recognition was broken — by tenancy, not by the model.** In the first hour: **9,282 identity events, 9 known, 9,273 unknown**, 92 persons enrolled. Every enrolled person lived in tenant `c88df319` (`drisyam-default`, the only tenant the known-faces bootstrap fills); every real camera runs under tenant `3f715841` (the org tenant the per-org JWT created on 2026-08-27), which had **no gallery at all**. Isolation worked exactly as designed. Fix: `DEFAULT_TENANT_NAME` now points at the org tenant in compose (a customer deployment enrols through the UI under its own org and never depends on the bootstrap); the in-process bootstrap task hangs on this box, so the gallery was loaded through the API (49 persons, 258 vectors). Customer check-list item: **the gallery must be in the tenant the cameras are in.**

**Controlled recognition test, org tenant, live pipeline:** a slideshow camera of the enrolled staff → **69 known / 0 unknown, similarity p50 0.914**, every name correct. The pipeline and the gallery are sound.

**Why the office cameras still show mostly unknowns:** scoring the last 400 live candidates against the org gallery directly gives top-1 cosine **p50 0.233, p90 0.297**, 363 of 400 under 0.30, and an *empty* 0.35–0.45 near-miss band. Those are stranger scores, not near-threshold ones: the people at those desks are not among the 49 enrolled. Faces are 42–67 px on those cameras, which caps what enrolment can achieve there anyway. The matcher now records the top-1 similarity on a miss (`face_matcher.match_one` searches unfloored, threshold applied after) — before, every miss was stored as 0.000 and this analysis was impossible from the database.

**Accuracy gate, first honest run.** Held-out split from `known_faces` (196 gallery / 48 mated probes) plus **300 real office impostor crops** harvested from unknown tracks (`data/unknown_faces`, one best-quality snapshot per track — needs a human skim for enrolled-but-unmatched staff): **TPR 0.979, FPR 0.000, F1 0.990, detection rate 0.937, FNIR @ FPIR = 1e-3 = 0.021.** Mated probes are enrolment stills, so the mated side is an upper bound; the impostor side is production-representative.

**Overlay, verified with people in the room.** Boxes and labels draw on WorkStation 2 (7 boxes at once) and on the HR camera that shard 1 owns (cross-shard path: shard-1 orchestrator → Redis → shard-0 forwarder → Node → browser). The overlay is **opt-in per session** (`LiveView.jsx`: the "Face detection overlay" toggle on the AI Detection tab) — off by default is the product's choice, not a break. **Viewer gating shipped** (§3.5): browsers announce `ai.watch`/`ai.unwatch`; the backend exposes `GET /api/internal/ai/viewers`; the forwarder mirrors it into Redis (`vms:overlay:viewers`, sentinel + TTL, fail-open); orchestrators publish at 5 Hz only for watched cameras and a 1 Hz keep-alive otherwise (people-counts and the admin monitor stay fresh); the forwarder makes no overlay POST for unwatched cameras; the Node socket fan-out is gated for every producer. Measured: WorkStation 2 **0.8 Hz unwatched → ~3 Hz watched**, forwarder POSTs **0** while nobody watches, a watch appears in the set within a second of opening the page. Found on the way: the zone-guard posts person boxes to the same endpoint continuously (~11/s for the office) for the intrusion engine — kept, its socket fan-out now gated; and killed headless test browsers keep their sockets alive until socket.io's ping timeout, which held watches for a minute in testing.

**Sharding under real traffic.** The backend's `aiLifecycle` `/set-camera` calls land on shard 0 and forward; each shard's reconciler restarts only its own cameras; a forwarded stop landed on shard 1 ("stream stopped cam_load01"); camera **delete** now forwards to the owner and stops its orchestrator first (it deleted only the row before).

**Source layer, still the NVR:** WorkStation 2's main stream drops 4–8 times an hour at the NVR (`stopped: an error occurred`), each an EOS restart in the AI. Everything else was clean: no detect errors, worker idle at 1%, GPU 14% with 6 cameras.

---

### Phase 2 — shipped 2026-09-21: one inference service, many small camera workers

The process split from §3.2, built and measured the same day. What runs now on `drisyam-original`:

| Process | Owns | Holds on the GPU | CPU at 43 cameras |
|---|---|---|---|
| `smart-cam-infer`, `smart-cam-infer-1` (`vms_face/workers/infer_server.py`) | detect + embed for every camera of every shard | SCRFD batchN static export **with preprocessing in the graph** (uint8 NHWC in), ArcFace, 3 replicas each | 0.65 + 0.58 cores |
| `smart-cam-ai` (shard 0) | API, migrations, the singletons (forwarders, subscribers, reid, retention, bootstrap); **no cameras** | nothing | 0.4 core |
| `smart-cam-ai-1..4` (camera shards) | decode (NVDEC), pacing, tracking, quality gate, latch, overlays, snapshots — ~11 cameras each, balanced | NVDEC contexts only | 1.1–1.6 cores each |

**Transport.** One multiplexed TCP connection per shard (`infra/infer_proto.py`: `u32 header | u32 payload | JSON | raw bytes`). The worker letterboxes the frame to the detector input with the same `_letterbox` the service uses, so the service's own letterbox is an exact no-op and boxes come back **bit-identical** to the in-process path (max |Δbox| 0.00000 px on 39 faces; embedding cosine 0.9999999). A blocking `SyncInferClient` serves the few callers that run `detect()` synchronously (API routes, enrollment) so they can never deadlock the loop; those callers now also run in `asyncio.to_thread`. Outage policy: skip frames (tracker coasts) and reconnect every 5 s; local models are loaded only after 30 s down — a service restart never makes N workers pull N copies of every engine. A second service process is a comma in `INFER_SERVICE_URL`; a shard picks `urls[shard_index % len]`.

**What the first cut measured, and what it took to make the split pay.**

| Layout (43 cameras: 37 synthetic + 6 real) | frames/s | fps / camera | detect stage | service side | GPU |
|---|---|---|---|---|---|
| 2 shards, models in-process (Phase 1 baseline, 37 cams) | 194 | 5.2 | 69 ms | — | 34% |
| 2 shards + 1 service (first cut) | 138 | 3.2 | 124 ms | 18 ms | 25% |
| 4 shards + 1 service | 246 | 5.7 | 91 ms | 60 ms · 140% CPU | 30% |
| 5 shards (shard 0 empty) + 1 service, uint8 preprocessing in-graph | 277 | 6.45 | 50 ms | 16 ms · 85% CPU | 40% |
| + 2nd service, balanced 11/11/10/11, steady state | **290** | **7.08** | **21.5 ms** (p50 ≤ 20, p95 ≤ 50, p99 ≤ 100) | 10.7 ms · 65% + 58% | 29–40% |

Three findings, each from an instrument added for it:

1. **The loop-lag law.** The first cut was *slower* than the baseline although the service answered in 18 ms and the GPU sat at 25%. A 100 ms timer probe (`vms_loop_lag_seconds`) and a GIL profile (py-spy `--gil`) showed the worker's asyncio loop starving behind its own PyAV decode threads: `packet.decode()` held the GIL for a third of all GIL time; the main thread used 18–29% of a core yet ran 20–35 ms late. Lag against cameras per process: **7 → 2 ms, 8 → 3–4 ms, 13 → 10–16 ms, 15 → 20–35 ms**, and shard 0's singletons on top made it 27 ms. `sys.setswitchinterval(0.5 ms)` bought ~10%. The answer is many small shards, shard 0 owning no cameras (`AI_SHARD_PRIMARY_OWNS_CAMERAS=false`), and a **balanced sticky assignment** (`ai_shard_assignment=balanced`: Redis hash `vms:shard:owners`, HSETNX least-loaded, ties to the hash owner; hashing had split 43 cameras 15/7/8/13). At 11 cameras per shard the steady-state lag is 1.6–3.5 ms.
2. **Preprocessing belongs in the graph.** With one service at 116 detects/s, `cv2.dnn.blobFromImage` was 16% of its CPU and the service took 60 ms per request at 140% of a core. `ensure_u8_detector` prepends Cast → NHWC→NCHW → BGR→RGB → (x−127.5)/128 to the batchN export (input `input_u8` [N,H,W,3], TensorRT profile 1/4/8): bit-identical output, **9.5 → 5.7 ms CPU per frame at batch 1, 8.8 → 3.7 at batch 8**, preprocess 2.85 → 0.05 ms, host→device copy 4× smaller. Service: 60 → 16 ms per request.
3. **Where the CPU is now.** Four camera shards spend ~5.6 cores for 290 frames/s — **~19 ms of CPU per emitted frame**, almost all of it in the per-camera decode threads (PyAV decodes every source frame at 25 fps to emit 8, downloads NV12 from NVDEC and converts to BGR inside the interpreter). The GPU is at 40%. The next lever is therefore not the model or the service but **decode outside the interpreter**: an ffmpeg/NVDEC pipe per camera (`-hwaccel cuda`, `fps=8` before `hwdownload`, raw BGR over a pipe read that releases the GIL) or GPU-resident decode (PyNvVideoCodec / DeepStream) — Phase 2.5 in the roadmap.

**Stability.** During the rig teardown one shard segfaulted ~20 s after its cameras were stopped. Root cause in `ingest.close()`: it joined the reader thread for 2 s and then closed the PyAV container *regardless*; under a load average of 77 the join expired while the thread was still inside a demux read, and when that read finally returned it touched freed libav memory. Now the thread owns the close whenever it does not come back in time (it closes the container on exit, bounded by the RTSP timeout), and a stop request is honoured inside the demux loop instead of after the next due frame. `faulthandler` is on in every worker and in the service, so a native crash prints Python stacks. Verified with three mass stops (24 cameras; 32 with the sources killed first; 16 with the sources paused so reads block): no crash, no restart, no leftover reader threads; plus a deterministic unit test of the deferred close (`tests/test_ingest_close.py`).

Threads per shard had crept to ~350 because executor pools never shrink and the ingest pool's default (256) was sized for one process running every camera; `VMS_INGEST_POOL_SIZE=48` per shard brings a 7–8-camera shard to 144–169 threads (25–44 at 1–3 cameras); what remains is per-camera decoder and CUDA threads, which leave the process with the decode move.

Also fixed along the way: `/set-camera` forwarding between shards failed with "Stream consumed" (the handler's `Form()` had drained the body; the forwarder now re-encodes the parsed form); the known-faces bootstrap of 288 images ran `detect()`/`embed()` synchronously on shard 0's event loop (211 ms detect stage while it ran); `DETECT_LATENCY` was counted twice on the remote path.

Gates for this phase: parity ✔ (0.00000 px, cosine 0.9999999), latency ✔ (detect p95 ≤ 50 ms at 43 cameras vs the ≤ 40 ms target at 4 fps — met at 7 fps), throughput ✔ (+50% on the same box, 3× lower detect latency), resilience ✔ (service restart → frames skipped for 5 s, reconnect, no local fallback; mass camera stops under load no longer crash a shard). Not yet: the ≥ 180 cameras/GPU target needs the decode move above; with the rig, `docker stats` and the VM's load average (55–77 on 16 vCPU with the demo generators running) the honest per-box number today is **~45 cameras at 7 fps with 2 cores per 11 cameras of decode**.

Repro: `scratchpad/loadrig.py up 37` → wait ≥ 3 min (RTSP opens are a transient) → `AI_SHARD_CONTAINERS=drisyam-original-ai-1,…-4 python loadrig.py measure 60` → `down`; per-shard `vms_loop_lag_seconds`, `vms_infer_client_seconds{phase}`, service `vms_infer_request_seconds`, `vms_infer_transit_seconds`; `scratchpad/u8_parity.py` and `infer_selftest.py` (`INFER_TEST_REMOTE=tcp://127.0.0.1:9010`) for parity. Pause `drisyam-original-zone-sim` and `demo-cam` while measuring.

### Phase 2.5 / 2.6 — 2026-09-22: decode outside the interpreter, attention cadence, compact overlays — and the platform wall

**Built and measured.**

| Piece | Mechanism | Measured |
|---|---|---|
| ffmpeg ingest (`pipeline/ingest_ffmpeg.py`, `RTSP_INGEST_BACKEND=ffmpeg`) | one ffmpeg per camera: NVDEC decode, `fps=N` applied to the CUDA frames *before* the download, one NV12→BGR per kept frame, raw BGR over a pipe; the reader thread's per-frame Python is a GIL-free `readinto()` | per 1080p camera at 8 fps: interpreter CPU **11.4% → 2.8%** of a core (ffmpeg process 10.2%, ~105 MB PSS); rig at 43 cameras: **301 frames/s (7.4 fps/cam), detect stage 17.3 ms, event-loop lag 1.1–1.9 ms** (PyAV: 290 / 21.5 ms / 1.6–3.5 ms); shard Python RSS 0.4 GB (was 2.1–2.9 GB) |
| Attention scheduling (`orchestrator._detect_cadence`, `ATTENTION_SCHEDULING`) | detector every frame while any track is undecided or the scene is empty; every 4th once everyone in view is latched to a known identity; every 2nd when only latched strangers remain; the Kalman tracker carries boxes in between and the overlay's `max_miss` follows the live cadence | live: `vms_motion_gate_skips_total{reason="attention"}` runs at 1.1–1.5× the detect count on the rig (faces latch within a second, then coast at 2 fps) — the detect rate per camera roughly halves; the full on/off throughput comparison at 43 cameras could not be completed (below) |
| Compact overlay frames (`backend_forwarder` v=2, `AIOverlay.jsx` decodes both) | positional rows `[trackId, x1, y1, x2, y2, conf%, name, gender, state]`, integer pixels | reference 4-box frame **643 → 341 bytes** (121 → 45 per box); at 5 Hz 3.1 → 1.7 KB/s per watched camera. Below the spec's 0.3 KB only for ≤ 3 boxes — the rest needs binary frames |
| CUDA gate (`infra/cuda_gate.py`, volume `vms-locks`) | flock-serialised CUDA/NVDEC context creation and TensorRT engine builds across every AI container; engines build under the lock via a warm-up run; genderage warmed at shard start off the event loop; stale owner-map entries pruned; camera delete succeeds locally when the owning shard is down | removed the corrupt-engine failure mode (a shard had segfaulted deserialising an engine two processes wrote at once); tests 35/35 |

**The platform wall.** Going from 43 to 60 cameras on the ffmpeg backend, the kernel began logging `misc dxg: dxgk: dxgkio_create_context_virtual: invalid host handle` — Docker Desktop's WSL2 GPU paravirtualisation layer. From that moment every new CUDA or NVDEC context on the box segfaults inside `libcuda` (even a lone `ffmpeg -hwaccel cuda` in a fresh container) while existing contexts keep running, and only a VM reboot (`wsl --shutdown`) clears it. Serialising creation and destruction through the gate did not prevent it: after each reboot the layer degraded again within minutes of bringing 43 cameras up, on the PyAV backend as well (four reboots on 2026-09-22 00:00–01:30). The same 43-camera PyAV configuration had run for hours on 2026-09-21 without one such error; the difference is not understood (four inference services instead of two, engine warm-ups at start, and the gate are the candidates). Consequences:

- **This box is a development environment, not a capacity reference.** Native Linux has no dxgkrnl layer; the ≥ 180-cameras-per-GPU target must be measured there. The load numbers above (43 cameras) stand; the 60-camera run gave 8.9 fps/camera at 6 ms loop lag on three shards before the layer failed, and is not quoted as a result.
- PyAV stays the default ingest here (`RTSP_INGEST_BACKEND=pyav`); ffmpeg is the native-Linux setting. Both are gated.
- The next decode step is the same on either platform: **decoder groups** — one ffmpeg with K inputs sharing one CUDA context (`-init_hw_device cuda=gpu -hwaccel_device gpu`, one rawvideo output per input on `pipe:3..`), ~100 MB per camera instead of ~270 and K× fewer contexts. Or GPU-resident decode (PyNvVideoCodec) in a decode service.
- Reset procedure, when `dmesg` shows `invalid host handle`: `wsl --shutdown`, `docker desktop start`; containers that were `docker stop`ped stay stopped; the load rig's publishers (`docker run --rm`) do not come back.

**Time-to-identity, re-measured on the Phase 2 layout** (two slideshow cameras of enrolled staff, n = 96 tracks): provisional **0.29 s mean** (p50 ≤ 0.5), confirmed **0.93 s mean** (p50 ≤ 1.5 bucket) — was 0.47 / 1.06 s; the ≤ 0.4 s provisional gate is met, confirmed sits at the ≤ 0.9 s line.

**Phase 3, first data point — the off-the-shelf edge pack is not usable as is.** Same harness, same gallery/probes/impostors, pipeline detector settings, inside the inference container: teacher `buffalo_l` (det_10g + w600k_r50) TPR 0.979 / FPR 0.000 / **FNIR @ FPIR = 1e-3 = 0.021**; edge candidate `buffalo_sc` (det_500m + w600k_mbf, 16 MB) TPR 0.896 / FPR 0.000 / **FNIR 0.104 — 5.0× the teacher**, against a gate of ≤ 1.5×. Detection rate 0.925 vs 0.937. So the edge tier cannot ship the stock small models; the distil-on-own-footage step of `FACE_EDGE_REALTIME_PLAN.md` is mandatory, and its target is now numeric: FNIR ≤ 0.031 on this probe set.

**Decoder groups, built and measured** (`pipeline/ingest_ffmpeg_group.py`, `RTSP_INGEST_BACKEND=ffmpeg` + `FFMPEG_GROUP_SIZE=K`): cameras that open within 0.75 s of each other share one ffmpeg process and one CUDA context (`-init_hw_device cuda=gpu`, one rawvideo pipe per input); the box-wide gate is taken once per group. Four live 1080p office cameras: **one process, 8.1 fps each, 9.0% of a core per camera, 769 MB PSS for four (192 MB per camera against ~276 MB per single-camera process) and one context instead of four**. On this box that is the shape to run the ffmpeg backend in; PyAV remains the default until it is proven at 43 cameras here, which the platform did not allow tonight.

**Not done in this pass.** Shared-memory frames (Phase 2.6b: the service parses 1.5 MB per detect on its event loop; at 4 services and 43 cameras that is 3–6 % CPU each and 2–3 ms of transit — not the bottleneck today); per-camera overlay rooms; time-to-identity re-measurement; Phase 3 (edge tier). All still owed.

## 6. What we will not do

- Swap the server recognizer for a lighter model: ~0.3 ms per face saved for a measurable accuracy loss.
- Decode main streams for analytics.
- Put float vectors as JSON on any bus.
- Run several uvicorn workers that each load the models: VRAM × N and no cross-camera batching.
- TensorRT INT8 on the embedder without quantisation-aware training and an FNIR gate.

## 7. Risks

- FP16 parity on the embedder may fail → detector-only TensorRT (still the larger win).
- 720p sub-streams need access to the customer's NVR configuration → fallback 640×360 with `min_face_px = 30`.
- The process split changes deployment to three services → gated behind Phase 0/1 results.
- The WSL2 dev box is not Linux prod (no MPS, different NVDEC path) → cameras/GPU is promised only after a Linux measurement.
- Suspected decoder leak across stream restarts (3 decoders for 2 orchestrators) → verify before Phase 0 ships.

## 8. Reproducing the numbers

```bash
# decode cost, software vs NVDEC (inside the ai container; one camera, ~30 s)
docker cp scratchpad/nvdec_bench.py drisyam-original-ai:/tmp/ && \
MSYS_NO_PATHCONV=1 docker exec drisyam-original-ai python /tmp/nvdec_bench.py rtsp://mediamtx:8554/cam_<id>

# TensorRT really available?
docker exec drisyam-original-ai sh -c 'ldd $(python -c "import onnxruntime,os;print(os.path.dirname(onnxruntime.__file__))")/capi/libonnxruntime_providers_tensorrt.so | grep nvinfer'

# threads by name and CPU-seconds
docker exec -i drisyam-original-ai python - < scratchpad/threads.py

# live counters
curl -s http://127.0.0.1:8001/metrics | grep -E "vms_(detect_latency|quality_rejects|tracks_opened|embeddings|motion_gate)"

# gates
python -m vms_face.eval.recognizer_parity --images data/known_faces --limit 10   # cosine >= 0.9999
python -m vms_face.eval.harness --gallery … --probe … --threshold 0.45           # TPR/FPR/F1
python -m vms_face.eval.frvt …                                                    # FNIR@FPIR, needs impostors
```
