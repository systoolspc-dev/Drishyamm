# Face Recognition — Zero-Lag, Lightweight, Edge-to-Server Plan

> **Goal:** real-time face recognition that feels instant, runs on small low-power devices
> as well as the dGPU server, and loses nothing on accuracy that the user can see.
> **Written:** 2026-09-19. Research sweep of 2025-26 literature, vendor pipelines and shipping
> products (sources in section 10), anchored to what we measured in
> `FACE_LIGHTWEIGHT_TARGET.md` and `FACE_ACCURACY_BENCHMARK.md`.
> **Supersedes nothing** — this is the edge/latency layer on top of those two documents.

---

## 0. The goal, in numbers

"Zero lag" is three different latencies. Each needs its own mechanism; conflating them is
how teams end up chasing the wrong millisecond.

| Latency | What the user perceives | Target (server) | Target (edge) | Mechanism |
|---|---|---:|---:|---|
| **Box lag** | box trails a walking person | ≤ 1 frame | ≤ 1 frame | tracker prediction every frame + client-side interpolation; detector cadence decoupled *(built, Aug 2026)* |
| **Time-to-identity (TTI)** | how long until the name appears | ≤ 500 ms | ≤ 1.2 s | identity latch + hot-gallery cache + early "provisional" publish (section 4) |
| **Freshness** | overlay shows what is happening *now*, not 3 s ago | ≤ 250 ms glass-to-glass analytics lag | ≤ 400 ms | latest-frame-wins queues; never process a stale frame (section 3.1) |

Throughput and cost targets per device class (planning estimates until Phase 2 measures them):

| Tier | Device | Cameras @ 4 fps detect | Power | Detect p95 | Notes |
|---|---|---:|---:|---:|---|
| A | dGPU server (RTX PRO 5000) | ≥ 180 | — | ≤ 40 ms | target from `FACE_LIGHTWEIGHT_TARGET.md` §2 |
| B | Jetson Orin Nano Super 8 GB | 8-10 | ≤ 25 W | ≤ 80 ms | hard ceiling = **11x 1080p30 H.265 decode**; no NVENC |
| C | Rockchip RK3588 box | 8-16 | ≤ 12 W | ≤ 120 ms | 6 TOPS INT8 NPU (3 cores); **32x 1080p30 decode** |
| D | Intel N100 / N305 mini-PC | 4-8 | ≤ 15 W | ≤ 120 ms | OpenVINO on iGPU; Frigate's recommended first choice |
| E | Raspberry Pi 5 + Hailo-8L / 10H | 1-3 / 3-6 | ≤ 10 W | ≤ 150 ms | Hailo ships a reference face pipeline |

Accuracy targets hold across tiers: **FNIR@FPIR = 1e-3 on our own CCTV probe set** (not IJB-C),
per camera, with the edge tier allowed to trail the server tier by at most the gap that
*escalation* (section 6.1) closes. Accuracy is the second-class citizen on no tier.

---

## 1. Why "just use a small model" is not the plan

`FACE_LIGHTWEIGHT_TARGET.md` §1 measured it: on the dGPU the recognizer is launch-bound at
0.4-0.85 ms/face while the detector is 5.9-7.7 ms/frame. A smaller *model* buys nothing there.
Elsewhere it buys a lot — but the research says the same thing from the other side:

> On **TinyFace** (real surveillance crops), every lightweight model in 2026 sits at
> **46-50% Rank-1** (FaceLiVTv2-XS/S/M/L: 46.1 / 47.8 / 49.6 / 49.5). Large backbones with
> low-quality training reach **68-72%** (DArFace 68.2-69.4, AdaFace R100 72.3).

That 20-point gap is not on LFW or IJB-C — it is on exactly the imagery CCTV produces. So the
small-model penalty is concentrated where our accuracy lives. The plan therefore has three
legs, and drops none of them:

1. **Eliminate work, not model size** — cadence, caching, batching, hardware decode.
   This is what makes edge real-time at all.
2. **A small model on the edge, a big model one hop away** — a cascade. The edge decides the
   easy 85-95% locally; the ambiguous band escalates one best crop to the server model.
3. **Distil the big model into the small one on *our* footage** — the one lever that closes
   the TinyFace gap for a small backbone, and the one that also fixes our licensing exposure.

---

## 2. What the field says (2025-26), and what we take from it

### 2.1 Detectors — the "hard" set is a distraction for recognition

WIDER FACE validation AP, VGA input, from the SCRFD model table:

| Model | Easy | Medium | Hard | FLOPs | Params | Licence |
|---|---:|---:|---:|---:|---:|---|
| SCRFD-500M-KPS | 90.97 | 88.44 | 69.49 | 0.5 G | 0.57 M | InsightFace weights — **non-commercial** |
| SCRFD-2.5G-KPS | 93.80 | 92.02 | 77.13 | 2.5 G | 0.82 M | same |
| **SCRFD-10G-KPS** *(ours)* | 95.40 | 94.01 | 82.80 | 10 G | 4.23 M | same |
| SCRFD-34G | 96.06 | 94.92 | 85.29 | 34 G | 9.80 M | same |
| **YuNet** (2023/2026may) | 83.4 | 82.4 | 70.8 | ~0.1 G | **75 K** | **MIT** (OpenCV Zoo); detects 10-300 px faces |
| EResFD (CLOVA) | — | — | 80.43 | lowest in class | — | check |
| FeatherFace (2025) | — | — | 87.2 overall | — | 0.49 M | uses deformable conv → **NPU-hostile** |
| YOLO-face family | ±1 of SCRFD | | | | | **AGPL** — avoid |

**The take:** going 10G → 2.5G costs **1.4 AP easy / 1.7 medium / 5.2 hard**. "Hard" is
faces of ~10-20 px — below any recognition floor we run (`match_min_face_px` is 15-80). For
faces large enough to *recognise*, the 2.5G detector loses about 1.5 points for **4x fewer
FLOPs**. That is the edge detector. 10G stays on the server. 500M loses ~5 points on the
faces we care about — too much except as a motion-gated pre-filter.

### 2.2 Recognizers — the lightweight frontier is ~96 IJB-C at 180-310 MFLOPs

| Model | Params | MFLOPs | IJB-C TAR@1e-4 | TinyFace R1 | Weights licence |
|---|---:|---:|---:|---:|---|
| ArcFace R50 `w600k_r50` *(ours)* | 43.6 M | ~6,300 | 97.25 | ~64 | InsightFace — **non-commercial** |
| AdaFace IR101 / WF12M | 65 M | ~12,000 | 97.66 | 72.3 | **non-commercial** |
| **FaceLiVTv2-S** (Apr 2026) | 4.62 M | 179 | **95.99** | 47.8 | code **MIT**; weights trained on **Glint360K → non-commercial** |
| FaceLiVTv2-M | 7.02 M | 258 | 96.42 | 49.6 | same |
| FaceLiVTv2-L | 8.52 M | 309 | 96.59 | 49.5 | same |
| GhostFaceNetV1-1 | 4.1 M | 216 | 94.94 | — | MS1MV3 → non-commercial |
| EdgeFace-XS / -S (Idiap) | 1.77 / 3.6 M | 154 / 306 | 94.85 / 94.66 | — | **cc-by-nc-sa-4.0** |
| MobileFaceNet `w600k_mbf` | 0.99 M | 440 | ~95 class | — | InsightFace — non-commercial |
| AuraFace-v1 (fal) | R100, ~65 M | ~12,000 | — (CFP-FP 95.2 vs ArcFace 98.9) | — | **commercial** — but heavy and 3-4 pts weaker |

Measured latency (FaceLiVTv2 paper): **-S = 5.35 ms on Jetson AGX Orin GPU, 1.64 ms on an
i5 CPU, 0.54 ms on iPhone 15 Pro** — 20-41% faster than EdgeFace at higher accuracy.

**The take:** a 180-300 MFLOP recognizer is now within **0.7-1.3 IJB-C points** of our R50 at
**20-35x less compute**. That is the edge recognizer class. But every one of them is trained
on a dataset that forbids commercial use, and the two that are architecturally hybrid
CNN-Transformer (FaceLiVT, EdgeFace) may not compile on NPUs that lack attention ops —
MobileFaceNet-class is the portable fallback. Section 2.8 resolves the licence problem.

### 2.3 Devices — decode is the ceiling, not TOPS

| Device | AI | HW decode (H.265) | Measured face work | Verdict |
|---|---|---|---|---|
| **Jetson Orin Nano Super** ($249) | 67 TOPS INT8 | **1x 4K60 / 2x 4K30 / 5x 1080p60 / 11x 1080p30**; **no encoder** | FaceLiVTv2-S 5.35 ms on AGX Orin GPU → ~2-3x on Nano | 8-10 cams; decode-bound before compute-bound |
| **RK3588** | 6 TOPS INT8, **3 NPU cores** | **32x 1080p30**, 16x encode | face-rec 30+ FPS (community); AuraFace & RetinaFace RKNN ports exist | 8-16 cams; cheapest per camera; INT8 only on NPU |
| **Intel N100 / N305** | iGPU 24-32 EU via OpenVINO | QSV, ~8-12x 1080p30 | Frigate runs ArcFace-large on the iGPU here | 4-8 cams; x86, easiest ops |
| **RPi5 + Hailo-8L** (~$70 kit) | 13 TOPS | RPi5: HEVC decode only, 1-2 streams | SCRFD ~311 FPS on 8L; scrfd_2.5g+MBF **42 ms** vs 194 CPU; 10G+R50 **99 ms** vs 669 (community) | 1-3 cams |
| **RPi5 + Hailo-10H** (AI HAT+ 2, Jan 2026) | 40 TOPS + 8 GB | same host limit | — | 3-6 cams |

Hailo's own reference face pipeline (`hailo-apps-infra`) is **SCRFD-10G + ArcFace-MobileFaceNet**
— a vendor with 13 TOPS chose the mobile embedder and kept the bigger detector. That matches
section 2.1: spend the budget on finding faces, not on the embedder.

Our own August incident is the other half of this row: software H.265 decode cost **~1100%
CPU** on the server. On an edge box software decode is not slow, it is *fatal*. Hardware decode
(NVDEC / RKMPP / QSV) is a Phase-2 gate, not an optimisation.

### 2.4 Quantization — INT8 the detector freely, the embedder only with QAT and a gate

- Detectors: post-training INT8 typically lands within **0.3%** of FP16 (NVIDIA TensorRT
  guidance); RKNN and Hailo are INT8-native anyway.
- Embedders: the research is explicit that *activation* quantization of embedding models is
  the sensitive part; naive PTQ degrades, **QAT recovers FP32-level accuracy**. Gate any INT8
  embedder on our `eval/frvt.py` FNIR@FPIR sweep, never on LFW (the famous "99.8% INT8"
  figure is Intel CPU + saturated LFW).
- **Stored embeddings** (the gallery) quantize far better than models: int8 keeps **99.3%** of
  float retrieval with rescoring at **4x** less memory / **~3.7x** faster; binary keeps
  **92.5% (96% with rescoring)** at **32x** less memory / **25-45x** faster. Those are text
  embedding numbers — face embeddings must be validated (some models suffer "dimension
  collapse" under binarization). This is what makes the L3 cache (section 4) free on ARM.

### 2.5 Distillation — the lever that fixes accuracy *and* licensing

- **AdaDistill** (ECCV 2024): margin-softmax with teacher class centres, student MobileFaceNet,
  SOTA on IJB-B/C among KD methods.
- **QUD** (BMVC 2024): **unsupervised** KD — no identity labels needed.
- **SynthDistill** (IJCB 2023, Idiap): KD on **unlabeled synthetic** faces; student LFW 99.52.
- Unified KD framework (2025): fine-grained alignment + geometric relationship preservation.

**The take:** we do not need a labelled face dataset to train our own small model. Distil a
teacher into a small student using **our own unlabeled CCTV crops** (consented, in-domain).
That does two things nobody else's checkpoint can: it adapts the student to *our* cameras
(the TinyFace gap), and it produces weights whose licence is the **teacher's** licence — so
pick the teacher for its licence (section 2.8).

### 2.6 Low-resolution recognition — the 2026 result that saves us from a mistake

An August 2026 study of five ways to synthesise low-resolution training data found that
"the degradation setting that is optimal on synthetic benchmarks is **not** the one that is
optimal on real LR", that learned super-resolution **under-performed** simply feeding aligned
LR crops to the backbone, and that "**simple interpolation augmentation of a compact backbone
is the only synthesis that improves over its own baseline**". Validate on *real* LR only.

This re-confirms two standing decisions: **no SR in the recognition path**, and **the CCTV
probe set is the only benchmark that counts** — it is still the top open item from August.

### 2.7 How Frigate does it — the one shipping open-source edge NVR with face recognition

Person detected first → face detected inside the person → recognition runs on **many frames
while the person is in view**, results **weighted by face area**, identity assigned as a
`sub_label` on the *tracked object* once `min_faces` attempts agree; `min_area` 750 px²,
`recognition_threshold` 0.9, `unknown_score` 0.8, blur-based confidence filtering;
small model (FaceNet, CPU) vs large (ArcFace, iGPU/NPU); 5-10 enrolment images minimum,
20-30 recommended; recognition on the *detect* (sub) stream.

Every one of those ideas already exists in our pipeline in a stronger form (quality-weighted
pooling instead of area weighting, K-of-N confirmation, top-1 margin guard, per-track
attribute votes). What Frigate has that we don't: **recognition explicitly bound to the
tracked-person lifecycle** as the unit of work and of memory. That is the identity latch in
section 4, made first-class.

### 2.8 Licensing — still the binding constraint, now with a way out

| Asset | Licence for us | Status |
|---|---|---|
| InsightFace **code** | MIT | fine |
| InsightFace **weights** (SCRFD, w600k_r50, w600k_mbf, antelopev2) | non-commercial research | **shipping in a paid product — P0 since Aug** |
| EdgeFace weights | cc-by-nc-sa-4.0 | no |
| FaceLiVTv2 weights | MIT code, **Glint360K-trained** | weights tainted; architecture reusable |
| GhostFaceNets / UniFace / PocketNet weights | MS1MV2/3-trained | no |
| YuNet | MIT | **yes** — the only clean detector at quality |
| AuraFace-v1 | commercial-data trained | **yes**, but R100-heavy and 3-4 pts weaker |
| OFIQ (quality) | MIT | yes |

Two legal paths, run in parallel:

- **Path A (now):** the InsightFace commercial pack — `recognition-oss-pack@insightface.ai`
  (README, Nov 2025). Zero code change, keeps every stored embedding and threshold, and
  unlocks *all* sizes (SCRFD-2.5G-KPS, `w600k_mbf`) for the edge tiers. The email from the
  August plan has not been sent. **Send it this week.**
- **Path B (strategic):** own the weights. Teacher = AuraFace (commercial) or the licensed
  InsightFace R50; student = MobileFaceNet-class or FaceLiVTv2-S *architecture* trained from
  scratch by unsupervised distillation on our own footage (2.5). Slower, but ends the
  dependency and is the only route to a model tuned to Indian CCTV.

---

## 3. Architecture — the Drishyam Face Engine, server and edge

One codebase, one pipeline, two deployment shapes. The edge is not a different product; it is
the same stages with a smaller model profile and a local gallery cache.

```
 camera (sub-stream 720p/960x540, 8 fps) ─ HW decode ─┐
                                                       │  leaky queue, depth 1  ← latest frame wins
                                                       ▼
   ┌────────────────────── per-camera worker ───────────────────────────────┐
   │ motion gate ─▶ DETECT (every 2nd frame, ROI-aware) ─▶ TRACK (Kalman,   │
   │                                                        every frame)     │
   │        ▼ quality gate ─▶ embed_every_n / pool.would_admit ─▶ EMBED      │
   │                                                     (batched across cams)│
   │        ▼ IDENTITY LATCH (L0) ─▶ hot gallery (L2) ─▶ local gallery (L3)  │
   │        ▼ provisional identity published at once; confirmed after K-of-N │
   │        ▼ ambiguous band ─▶ ESCALATE best crop ─▶ server big model        │
   └─────────────────────────────────────────────────────────────────────────┘
                                                       │
            overlay (predicted boxes every frame) ◀────┘──▶ events / alerts / journey
                                                       │
                              gallery sync (versioned deltas) ◀──▶ central Qdrant (L4)
```

### 3.1 Freshness: latest-frame-wins, everywhere

Every stage boundary is a **depth-1 leaky queue**: a new frame replaces the one waiting, never
queues behind it. A pipeline that is 20% over capacity with normal queues drifts to seconds of
lag in a minute; with leaky queues it drops 20% of frames and stays at ~one frame of lag
forever. Frame *rate* is negotiable; frame *age* is not. The tracker already tolerates gaps
(that is what `DETECT_EVERY_N_FRAMES` relies on), so dropping is free.

### 3.2 Cadence: detect at 4, track at 8, draw at 30

Ingest the sub-stream at 8 fps. Detect every 2nd frame (4 fps). Kalman-predict boxes on
every ingested frame. The client interpolates to display rate. Boxes move at 30 fps while the
detector runs at 4 — that is the whole "zero box lag" trick, and it is already live on the
server (measured −49% detector calls at identical box-update rate).

### 3.3 Decode: hardware or nothing

NVDEC on Jetson (11x 1080p30 on Orin Nano — the ceiling), RKMPP on RK3588 (32x), QSV on
Intel. The PyAV wheel we ship has **no** hardware decode (`ingest.py` `hwaccel` option is a
silent no-op, Aug finding). Phase 2 replaces the ingest backend with GStreamer per platform
(`nvv4l2decoder` / `mppvideodec` / `vaapih265dec`), keeping the OpenCV path for dev.

### 3.4 Sub-stream ingest

Analytics never touch the main stream. The camera's second stream at 720p / 960x540 is what
the detector sees; a 960x544 detector input then costs *no* resize. Snapshot crops come from
the same frame. Main-stream frames are only for the human (recording, live view) — this is also
what keeps us under the ≤6-sessions-per-NVR rule.

---

## 4. The cache system

"Cache" here means: **never compute twice what the world has not changed**. The pipeline
already has three of these (track template pool, predicted boxes, per-track attribute votes,
best-crop snapshot). This section makes the identity path a proper multi-level cache with
explicit keys, hit paths, and invalidation. Latencies are order-of-magnitude design targets.

### L0 · Identity latch — per track (the big one)

The unit of work is the **track**, not the frame. Once a track has an identity, stop asking.

```
 NEW ──(pool ≥ min_hits)──▶ CANDIDATE ──(K-of-N agree, margin ok)──▶ LATCHED(id, conf)
   │                            │                                        │
   │                            └──(N tries, no match)──▶ UNKNOWN-LATCHED  │ re-verify on:
   │                                       │  retry budget: quality jump   │  • quality jump ≥ Δq
   │                                       │  or every T_unknown (20 s)     │  • every T_verify (10-15 s)
   │                                       │  escalate once (edge)          │  • tracker uncertainty spike
   └── track lost ──▶ evict (keep 30 s for re-association)                  │  two disagreements → TRANSITION
```

- **Key:** `(camera_id, track_id)`. **Value:** identity, confidence, pooled template,
  last-verified time, verify count, escalation state.
- **Hit path:** LATCHED → publish the cached identity with the predicted box. **No embed, no
  search.** This is where the 5x recognizer saving from `FACE_LIGHTWEIGHT_TARGET.md` becomes
  20x in practice: a 30-second track at 4 fps is 120 detections and **~3-5 embeds**.
- **Publish early, correct later:** CANDIDATE publishes a *provisional* identity (rendered
  dimmed / dashed); LATCHED publishes *confirmed*. TTI drops to the first good crop; correctness
  arrives with K-of-N. Alerts fire only on confirmed **identity transitions**, per
  `docs/DETECTION_DECISION_ALERT_FRAMEWORK.md` — the latch is that doctrine's memory.
- **Negative cache:** UNKNOWN-LATCHED stops the per-frame full-gallery query that unknown
  visitors generate today (they are the majority of faces on a public camera). Retry only on
  a quality jump or on a timer.
- **Re-association:** a track lost for < 30 s that reappears with a matching template inherits
  the latch — occlusion no longer resets identity.

### L1 · Track template pool — per track *(exists)*

`services/track_embedding_pool.py`: quality-weighted top-K pooled template, re-L2-normed.
Unchanged; it feeds L0. One addition: OFIQ-lite quality (MIT) as the admission score when
Phase 3 lands, replacing blur+brightness heuristics.

### L2 · Hot gallery — per camera / per site (spatio-temporal prior)

People seen in the last 30-60 minutes on this camera or on cameras adjacent to it in the
learned movement graph (`feature_live_tracker`), plus roster-expected identities (shift /
schedule). Typically **50-300 identities** at a site of 5,000 enrolled.

- **Hit path:** 1:N over ≤300 int8 vectors — **~0.05 ms** on an ARM core. Accept immediately
  if top-1 ≥ τ_confident *and* passes the margin guard; else fall through to L3.
- **Why it also helps accuracy:** FPIR grows with gallery size (`FACE_RECOGNITION_RESEARCH_2026.md`).
  Resolving 90% of queries against a candidate set 20x smaller lowers the false-positive
  exposure at the same threshold. The fall-through with a *stricter* acceptance for cold hits
  keeps the true-but-cold person from being mis-latched to a hot lookalike.
- **Invalidation:** LRU by last-seen; entries expire; deletion events purge.

### L3 · Local full gallery — per edge node (and per server process)

The whole tenant gallery resident in RAM, **binary-packed for search, int8 for rescoring,
float only for the final top-k** — the HF "binary search + scalar rescore" recipe, validated on
face embeddings before use (2.4).

- **Size:** 50,000 identities x 512-d = **3.2 MB binary + 25.6 MB int8**. Fits on any tier.
- **Hit path:** binary popcount over 50k x 64 B **< 1 ms** single ARM core; rescore top-32 in
  int8 **~0.1 ms**. No vector database on the edge. Brute force is the fast path at this size.
- **Server side:** the same L3 sits in front of Qdrant and absorbs the per-frame query load
  that makes Qdrant the bottleneck at scale (research doc: "Qdrant runs the documented worst
  case" with tenant filters). Qdrant becomes the source of truth and the forensic index,
  not the hot path.

### L4 · Central gallery — Qdrant + Postgres *(exists)*

Source of truth. Edge nodes pull **versioned deltas** (`gallery_version` monotonic per tenant)
over long-poll; enrol/update/delete are events. **DPDP hard-delete propagates to every L3 and
purges every L0 latch referencing the identity within ≤ 60 s, with an ack** — the edge cache
must never be the place a deleted person survives.

### Auxiliary caches (cheap, decisive)

| Cache | Key | Saves | Status |
|---|---|---|---|
| Predicted boxes (Kalman) | track | detector calls on skipped frames | **live** (−49% measured) |
| Motion gate | camera | detector calls on static scenes | built, off — measure then enable |
| ROI mask | camera | detector *area* — run SCRFD only on motion regions / crop to union box | Phase 2 |
| Compiled engines (TRT / RKNN / HEF / OpenVINO blob) | model + device SKU + shape | cold start 384 s → ~2 s; persisted per node, prebuilt in CI per SKU | Phase 2 |
| Attribute votes (gender/age) | track | genderage per frame → ≤ 8 per track | **live** |
| Best-crop snapshot | track | MinIO PUTs | **live** |
| Escalation memo | track | one server round-trip per track per 30 s | Phase 1 |

---

## 5. Model matrix per tier

| Tier | Detector | Precision | Recognizer | Precision | Runtime | Escalates to |
|---|---|---|---|---|---|---|
| A · dGPU server | SCRFD-10G-KPS @ 960x544 | FP16 (TRT once installed) | ArcFace R50 → AdaFace IR101 (opt-in track) | FP16 | ORT CUDA → TRT EP | — |
| B · Orin Nano Super | SCRFD-2.5G-KPS @ 960x544 | INT8 TRT (PTQ) | FaceLiVTv2-S-class / MBF-class | FP16 TRT | ORT TRT EP, engine cache | A |
| C · RK3588 | SCRFD-2.5G-KPS @ 640x384 | INT8 RKNN | MobileFaceNet-class | INT8 RKNN **(QAT, FNIR-gated)** | rknn-toolkit2 via ORT/RKNN EP | A |
| D · Intel N100/N305 | YuNet (MIT) or SCRFD-2.5G | FP16 iGPU | MobileFaceNet-class | FP16 iGPU | ORT OpenVINO EP | A |
| E · RPi5 + Hailo | SCRFD-2.5G / 10G (HEF) | INT8 | ArcFace-MobileFaceNet (HEF) | INT8 | hailo-apps-infra pipeline | A |

Rules that hold across the matrix:

- **Detector never below 2.5G** for recognition cameras (section 2.1). 500M only as a
  motion-gated pre-filter on doorway cameras with big faces.
- **Recognizer INT8 only on RKNN/Hailo where FP16 does not exist**, and only after QAT with
  `eval/frvt.py` sign-off on the CCTV probe set.
- **One embedding space per deployment.** An edge running MobileFaceNet-class cannot search a
  gallery embedded by R50. Either the edge holds a gallery embedded by *its* model (re-embed on
  sync from stored enrolment images, not from vectors), or the edge only *detects/tracks/crops*
  and the server embeds. Both shapes are supported; the second is the cheapest first step.
- **Hybrid CNN-Transformer recognizers (FaceLiVT, EdgeFace) must be compile-tested per NPU
  before they are promised.** RKNN and Hailo op coverage for attention is uneven; the
  MobileFaceNet-class fallback is always in the matrix for that reason.

---

## 6. The accuracy programme for small models

### 6.1 Cascade with escalation — small-model speed, big-model correctness

The edge decides three ways: **confident match** (score ≥ τ_hi, margin ok) → latch;
**confident unknown** (score ≤ τ_lo after N good crops) → unknown-latch; **ambiguous band**
(τ_lo < score < τ_hi, or margin fails) → send the single best-quality aligned crop
(~15 KB JPEG) to the server, which answers with its R50/AdaFace verdict; the edge latches on
the answer. Budget: ≤ 1 escalation per track per 30 s; expected 5-15% of tracks. The user
sees big-model accuracy exactly where the small model is unsure, at negligible bandwidth,
and nothing waits on the network for the easy majority.

### 6.2 Distil on our own footage *(Phase 3)*

Teacher: licensed R50 / AdaFace (or AuraFace for Path B). Student: MobileFaceNet-class and
FaceLiVTv2-S architecture. Data: **our unlabeled CCTV crops** (consented deployments, DPDP
retention respected) + simple interpolation LR augmentation — the one synthesis the 2026
study found to help. Method: QUD/AdaDistill-style. Exit gate: student FNIR@FPIR=1e-3 on the
CCTV probe set within 1.5x of teacher; TinyFace Rank-1 within 10 points of teacher.

### 6.3 Things that move accuracy more than any model, in order

1. **Enrolment: 3-5 pose-diverse images per person** (1 frontal + 2 profiles). Frigate says 5-10
   minimum, 20-30 recommended. This is where our accuracy lives (August research).
2. **Per-camera thresholds as FNIR@FPIR** via `eval/frvt.py`, not one global cosine.
3. **The CCTV probe set** — human-labelled, per site. Everything above is unmeasurable without it.
4. **Camera geometry:** ≤ 30° from horizontal, eye-level; NIST measured ~89x degradation from
   downward pitch. A first-class deployment parameter, not an afterthought.
5. Quality gating with OFIQ-lite; alignment robustness; test-time flip only where the budget
   allows (server, not edge).

---

## 7. Roadmap with gates

| Phase | Weeks | Deliverables | Exit gate (measured) |
|---|---|---|---|
| **0 · Foundations** | 0-2 | Licence email sent (Path A); CCTV probe set v1 (≥ 200 labelled crops, 3 sites); SLO definitions in `core/metrics.py`; buy 1x Orin Nano Super, 1x RK3588 box, 1x N100, 1x RPi5+Hailo-8L | probe set exists; `eval/frvt.py` runs on it |
| **1 · Cache system, server first** | 2-5 | L0 identity latch state machine; L2 hot gallery; L3 int8/binary local gallery in front of Qdrant; provisional/confirmed publish; escalation API (server side); latest-frame-wins queues; motion gate measured and enabled where it helps | TTI ≤ 500 ms p50 on server; embeds per track ≤ 5 median; Qdrant QPS −80%; accuracy unchanged on probe set |
| **2 · Edge runtime** | 5-10 | `drishyam-edge` container: GStreamer HW-decode ingest per platform; ORT with TRT / RKNN / OpenVINO EPs; engine cache; 2.5G-KPS detector profile; gallery sync protocol with versioned deltas + delete acks; detect-track-crop-only mode (server embeds) as the first shipped shape | Tier B/C/D each run ≥ 6 cams at 4 fps detect with detect p95 within target; glass-to-glass ≤ 400 ms; delete propagates ≤ 60 s |
| **3 · Small models, honestly** | 8-14 | Edge embedder (MBF-class FP16/INT8-QAT); compile-test FaceLiVTv2-S per NPU; distillation pipeline on own crops; INT8 detector PTQ; per-camera FNIR@FPIR thresholds | student within 1.5x teacher FNIR on probe set; INT8 embedder passes `frvt.py` gate or stays FP16 |
| **4 · Scale** | 14+ | TRT FP16 on server (needs libnvinfer in image); dynamic-batch SCRFD export for batched detect; DeepStream/zero-copy only if a node must exceed ~100 cams/GPU | server ≥ 180 cams/GPU @ 4 fps measured under load |

Phase 1 pays for itself on the server before any edge hardware arrives, and every later phase
depends on it — build it first.

### Phase 1 — shipped 2026-09-19 (server-side cache system)

| Piece | Where | Status |
|---|---|---|
| L0 identity latch (state machine, K-of-N, negative latch, re-verify triggers) | `services/identity_latch.py`, wired in `pipeline/orchestrator.py` | **live** |
| Re-association bank (dead track → new track inherits identity) | `identity_latch.RecentIdentityBank`, `face_tracker.dropped_last_step` | **live** |
| Verdict feedback channel (worker → owning orchestrator, published *before* DB work) | `infra/verdict_bus.py`, `redis_bus.publish_verdict`, `match_worker._process_one` | **live** |
| Names on the overlay from the latch (`identity_state` = unknown / provisional / confirmed) | `orchestrator._update_overlay`, `backend_forwarder` (`identityState`), `detection_cache` patch rule | **live** |
| L3 local gallery (float32 exact, int8 option) + L2 hot set + refresh/invalidation | `services/gallery_cache.py`, `face_matcher.match_one`, `enrollment.notify_gallery_changed` | **live** |
| Shadow-check against Qdrant | `gallery_cache_shadow_check_rate` (off; enable 0.05 for a day) | built |
| Latest-frame-wins at decode→detect | already the ingest default (`rtsp_drop_old_frames`) | pre-existing |
| Escalation API (server half of the edge cascade) | `POST /edge/escalate` in `api/routes/edge.py` | **live** — 121 ms round trip incl. detect, right person, audited |
| Motion gate measured + enabled | `MOTION_GATE_ENABLED=true` in compose; skip metric split by reason | **live** — see below |
| Unit tests | `vms_face/tests/` — latch, gallery cache, remote recognizer — 29 tests | pass |

**Motion gate, measured (4 demo cameras, 160 s after a cold start):** 2,792 frames ingested,
1,396 eligible for detection after the every-2nd-frame cadence, **397 detector calls** —
the gate removed **~72% of eligible detect calls**. Three static cameras skipped ~95%; the one
busy camera (966 detections in the window) skipped 329 and kept detecting at its previous rate.
Kept on. (`vms_motion_gate_skips_total` used to count cadence skips and gate skips together — it
now carries `reason=cadence|motion` so this number reads straight off the metric.)

### Phase 2 building blocks — shipped 2026-09-19/20 (no edge hardware needed)

The first edge shape from §5 exists end-to-end and is verified against the live server:

| Piece | Where | Verified |
|---|---|---|
| `RECOGNIZER_BACKEND=remote` — edge aligns crops, server embeds | `infra/recognizers/remote.py` (circuit breaker, batch path, binds to the server's embedding-space name) | 5 unit tests on a mock transport |
| `GET /edge/info` · `POST /edge/embed` · `POST /edge/embed/batch` | `api/routes/edge.py`; `embed_aligned()` on the ArcFace and AdaFace backends | `eval/remote_parity.py`: **PNG cosine 1.0000000 on 6/6 faces**, ~21 KB/crop, ~20 ms warm |
| `GET /edge/gallery/version` · `GET /edge/gallery/snapshot` (`.npz`, float16/float32/int8) | same; version = Redis `INCR` on every enrol/delete | 554 vectors → 537 KB float16, norms verified |
| `POST /edge/escalate` | same; uses the worker's exact 1:N + margin logic | Aarti Kumari 0.93, 121 ms |

**Finding — JPEG is not an option for aligned crops.** At q=92 the remote vector drifts to
cosine **0.977–0.994** against the local one (I had predicted ~1e-3; the measurement says
~1e-2, the size of the ambiguity margin). A 112×112 crop is so small that JPEG removes exactly
the detail the embedder keys on. PNG is lossless and only ~21 KB, so PNG is the default and
JPEG is left as a documented, measured trade-off, not a recommendation.

**Finding — Redis was the hidden bottleneck, and it was self-inflicted.** `vms.detections` was
capped at 200,000 entries of ~32 KB each (a 512-float JSON embedding per candidate): **4.25 GB in
one stream**, Redis pinned at **100% CPU / 3.95 GB**, and the match worker's `XREADGROUP`
timing out and *killing the process* three times in one day (no reconnect in its loop). Fixed on
three fronts: cap lowered to 20,000 (`redis_stream_detections_maxlen`; consumers ack in
milliseconds, and post-latch that is still over an hour of backlog), the worker's consume loop
now reconnects with backoff instead of exiting, and a one-time `XTRIM … LIMIT 0`. Result:
**496 MB, 0.8% CPU.** Still open: the `reid-workers` consumer group had **215k unacked entries**
(a separate, pre-existing backlog problem in `reid_worker.py`), and candidate payloads could be
~60% smaller by rounding embedding floats.

**Measured on the live `drisyam-original` process** — six enrolled people, slideshow published over
RTSP to a camera path, 16 tracks over ~90 s (numbers from `/metrics` + `detection_events`):

| | Value | Meaning |
|---|---:|---|
| candidates published / track | **1.9** (31 for 16 tracks) | `first_template` + one `candidate`, then nothing — every track confirmed on the 2nd verdict |
| embeds suppressed by the latch | **44** of 103 detections (59 spent) | `vms_embed_skipped_total{reason="identity_latched"}` — on 2.5 s tracks; on a 30 s track the ratio is far higher |
| suppress reasons | immature 16 · candidate_gap 12 · identity_latched 44 | the old pipeline paid for all of these |
| transitions | candidate→latched **16/16**; new→candidate via re-association **1** | `vms_track_reassociations_total` |
| verdict tier | **`local`** on every verdict | 554 vectors, 82 ms reload, Qdrant never on the hot path |
| TTI provisional | **0.47 s** mean (15 samples) | first hit on the overlay |
| TTI confirmed | **1.06 s** mean; 5/16 ≤ 1 s, **16/16 ≤ 2 s** | K-of-N=2 confirm; the floor is `identity_latch_candidate_gap_sec` (0.5) + `track_min_hits_to_match` |
| wrong identities | 0 | all 11 checked tracks matched the right enrolled person, similarity 0.92–0.98 (enrolment stills — an upper bound) |

Two things this test does **not** show: the negative-latch path (no unknown visitors in the slideshow)
and the long-track saving (tracks here were ~2.5 s). Both are unit-tested; the live numbers for a
30-second unknown visitor are the next thing to measure on a real camera.

**Operational notes from the rollout:** the demo cameras on this stack produce no
quality-passing faces, so nothing in this path runs on them — validation needed real faces
(the RTSP slideshow trick above; a file source through `RTSPIngest` does not work, it drops every
frame that arrives within a frame period and a file decodes instantly). The match worker crashed
once on a Redis read timeout during the day (`redis.exceptions.TimeoutError`, Redis at 100% CPU) and
was restarted by `unless-stopped` — pre-existing, but the latch makes the worker's own load a
non-issue and Redis's load is worth a look.

---

## 8. What we will not do, and why

| Not doing | Because |
|---|---|
| Super-resolution before embedding | 2026 study: learned SR under-performs feeding LR directly; SR hallucinates identity. Thumbnails only. |
| Swap R50 for a small model **on the dGPU** | recognizer is launch-bound there (0.4-0.85 ms/face); saves ~0.3 ms, costs accuracy. |
| INT8 embedder via PTQ | activation quantization is the sensitive part; QAT + FNIR gate or FP16. |
| YOLO-face / BoxMOT | AGPL. |
| Detectors with deformable convolution (FeatherFace) on NPUs | op coverage; compile risk on RKNN/Hailo. |
| A vector database on the edge | 50k x 512 binary is 3.2 MB and < 1 ms brute force. A DB adds latency and an ops surface. |
| Software video decode on any edge tier | 1100% CPU on the server in August; fatal on a 4-core ARM. |
| Per-frame 1:N for unknown faces | the negative cache exists precisely to stop this. |
| Trusting `ort.get_available_providers()` | it advertised TensorRT in an image without libnvinfer. Check `session.get_providers()[0]`. |

---

## 9. Risks

- **Licence (P0, unchanged since August).** Every weight we run is non-commercial. Path A is an
  email; Path B is a quarter of work. Both start now.
- **NPU op coverage** for hybrid recognizers and for SCRFD's post-processing; mitigated by the
  MobileFaceNet-class fallback and by exporting post-processing to the host.
- **Two embedding spaces** if edge and server run different recognizers; mitigated by shipping
  detect-track-crop-only edge first, and by re-embedding galleries from enrolment *images* on
  sync.
- **Cache staleness under DPDP** — a deleted identity lingering in an edge latch is a legal
  event, not a bug; hence versioned deltas, purge acks, and a ≤ 60 s SLO with a metric.
- **Measurement discipline.** Everything sampled within ~5 minutes of a restart is warm-up
  (`FACE_LIGHTWEIGHT_TARGET.md` §6). Every gate above is warm-to-warm and rate-based.

---

## 10. Sources

Detection — [SCRFD model table](https://github.com/deepinsight/insightface/tree/master/detection/scrfd) ·
[YuNet (OpenCV Zoo)](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) ·
[EResFD](https://github.com/clovaai/EResFD) · [FeatherFace](https://github.com/dohun-mat/FeatherFace) ·
[FDLite](https://arxiv.org/pdf/2406.19107)

Recognition — [FaceLiVTv2 (Apr 2026)](https://arxiv.org/abs/2604.09127) · [FaceLiVT code](https://github.com/novendrastywn/FaceLiVT) ·
[EdgeFace](https://arxiv.org/abs/2307.01838) · [EdgeFace licence (cc-by-nc-sa)](https://huggingface.co/Idiap/EdgeFace-XXS) ·
[GhostFaceNet++ (2025)](https://link.springer.com/article/10.1007/s11554-025-01768-x) ·
[PocketNet](https://arxiv.org/abs/2108.10710) · [AuraFace](https://huggingface.co/blog/isidentical/auraface) ·
[UniFace (MIT toolkit)](https://github.com/yakhyo/uniface)

Low-resolution FR — [Synthetic data & the LR domain gap (Aug 2026)](https://arxiv.org/abs/2608.06580) ·
[Center-aligned representations + quality gating (Sep 2026)](https://arxiv.org/abs/2609.01014) ·
[DArFace](https://arxiv.org/abs/2505.08423) · [FaceMoE](https://arxiv.org/abs/2606.32040)

Distillation — [AdaDistill (ECCV 2024)](https://arxiv.org/abs/2407.01332) · [QUD (BMVC 2024)](https://bmva-archive.org.uk/bmvc/2024/papers/Paper_707/paper.pdf) ·
[SynthDistill (IJCB 2023)](https://arxiv.org/abs/2308.14852) · [Unified KD (2025)](https://arxiv.org/abs/2508.11376)

Quantization — [NVIDIA QAT for INT8](https://developer.nvidia.com/blog/achieving-fp32-accuracy-for-int8-inference-using-quantization-aware-training-with-tensorrt/) ·
[Embedding quantization (binary/int8 + rescoring)](https://huggingface.co/blog/embedding-quantization)

Devices — [Orin Nano Super](https://developer.nvidia.com/blog/nvidia-jetson-orin-nano-developer-kit-gets-a-super-boost/) ·
[Orin Nano datasheet (decode)](https://files.seeedstudio.com/wiki/Jetson-Orin-Nano-DevKit/jetson-orin-nano-developer-kit-datasheet.pdf) ·
[Orin Nano has no NVENC](https://industrialmonitordirect.com/blogs/knowledgebase/resolving-missing-nvv4l2h264enc-on-jetson-orin-nano) ·
[RK3588 NPU benchmarks](https://tinycomputers.io/posts/rockchip-rk3588-npu-benchmarks.html) ·
[RK3588 decode 32x1080p](https://www.forlinx.net/industrial-news/rockchip-rk3588-447.html) ·
[rknn_model_zoo RetinaFace](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/RetinaFace) ·
[AuraFace on RK3588](https://huggingface.co/dulimov/AuraFace-v1-rk3588) ·
[Hailo-8L face pipeline numbers](https://community.hailo.ai/t/face-recognition-on-rpi5/2307) ·
[Hailo SCRFD ~311 FPS](https://github.com/dmmdea/Hailo-8L-Analysis-Pipelines) ·
[Hailo reference pipeline (SCRFD-10G + ArcFace-MobileFaceNet)](https://wiki.seeedstudio.com/facial_recognition_on_the_recomputer/) ·
[Raspberry Pi AI HAT+ 2 / Hailo-10H](https://www.raspberrypi.com/news/introducing-the-raspberry-pi-ai-hat-plus-2-generative-ai-on-raspberry-pi-5/) ·
[Hailo-8 vs 8L vs 10H](https://edgeaistack.ai/blog/hailo-8-vs-8l-vs-10h-2026/)

Shipping edge NVR — [Frigate face recognition](https://docs.frigate.video/configuration/face_recognition/) ·
[Frigate hardware guide 2026](https://edgeaistack.ai/blog/best-hardware-for-frigate-nvr-2026/) ·
[Frigate ArcFace on RK3588 issue](https://github.com/blakeblackshear/frigate/discussions/22058)

Licensing — [InsightFace commercial licensing](https://www.insightface.ai/solutions/face-recognition-licensing)

Internal — `FACE_LIGHTWEIGHT_TARGET.md` · `FACE_RECOGNITION_RESEARCH_2026.md` · `FACE_ACCURACY_BENCHMARK.md` ·
`DETECTION_DECISION_ALERT_FRAMEWORK.md`
