# Stampede Detection — Build Plan

Production crowd-stampede / dangerous-crowd-behavior detection from video (CCTV/RTSP).
**Stack:** Python + PyTorch · **Deploy:** central GPU server · **Goal:** production system.

---

## 1. Core design decision

Do **not** build a single "stampede / no-stampede" video classifier. Real stampede
footage is extremely rare, and — critically — a 2024 cross-dataset audit
(*"Benchmark AUC Is Not Deployable Reliability"*) showed off-the-shelf anomaly
detectors that score **0.704 AUC collapse to 0.499 (chance level)** when calibrated on
one camera scene and tested on another. **Cross-scene transfer essentially fails.**

Therefore: build an **interpretable risk-indicator fusion pipeline** with **mandatory
per-camera calibration**. A stampede is physically characterized by three co-occurring
signals:

1. **High crowd density** (people / m²)
2. **High / sudden crowd motion** (flow speed, acceleration, kinetic energy)
3. **Convergent or chaotic flow** (funneling toward a blockage; order breakdown)

This is validated in the literature — e.g. the *Engineering Applications of AI, 2024*
"Stampede detector … using dense optical flow" paper (Farneback flow → deep classifier),
and deployed weighted-fusion systems (CSRNet density + LSTM + clustering + rules).

---

## 2. Architecture

```
RTSP stream ─► frame sampler ─┬─► [1] Density (CSRNet)        ─► people/m² (via homography)
                              ├─► [2] Motion (Farneback flow) ─► speed, accel, divergence, KE, MI
                              ├─► [3] Anomaly (RTFM, optional)─► weakly-supervised anomaly score
                              └─► [4] Fusion + temporal logic ─► per-zone RISK (NORMAL/MOD/HIGH/CRIT)
                                                                       └─► alerting / dashboard
```

### Model picks (all PyTorch, pretrained weights available)

| Component | Pick | Why | Notes |
|-----------|------|-----|-------|
| Density   | **CSRNet** (baseline), P2PNet (upgrade) | Proven in deployed fusion systems; handles dense crowds where detection fails | Fine-tune on ShanghaiTech |
| Optical flow | **Farneback** (baseline), RAFT-small (upgrade) | Farneback is what the 2024 stampede paper used — cheap, real-time; RAFT more accurate | Farneback runs CPU/GPU cheaply |
| Flow features | speed, acceleration, divergence (∇·v), kinetic energy, **Mutual Information** (order parameter) | Physics-based, need ~no training data; falling MI signals order breakdown before crush | |
| Anomaly (optional) | **RTFM** or **MGFN** | Weakly-supervised (video-level labels only) | Only if end-to-end signal is wanted |
| Low-density fallback | YOLOv8 + DeepSORT | Counting/tracking when crowd is sparse | |

### Fusion (start simple, learn later)
- **v1:** weighted risk score + **temporal persistence** (sustained N seconds) + per-zone logic.
  Reference weighting from a deployed system: density 35% / prediction 30% / clustering 25% / rules 10%.
- **v2:** replace weights with a small learned fusion model once labeled events are collected.

---

## 3. Datasets

| Dataset | Use | Notes |
|---------|-----|-------|
| **UMN Unusual Crowd Activity** | Primary panic/escape benchmark | 11 seqs, 3 scenes, 640×480@30fps, static cam, normal→panic |
| **ShanghaiTech** (counting) | Train/fine-tune CSRNet density | |
| UCF-QNRF / NWPU-Crowd | Dense-counting robustness | |
| PETS2009, Motion-Emotion | Additional crowd behavior | |
| UCSD / Avenue / ShanghaiTech-anomaly | Generic anomaly baselines | Beware cross-scene collapse |
| **Synthetic (social-force / agent-based sim)** | Generate labeled crush/convergence scenarios | Fills the real-stampede-footage gap |

> Real stampede footage barely exists publicly — lean on UMN + synthetic simulation +
> physics-based indicators that need little training data.

---

## 4. Production engineering
- **Ingestion:** RTSP → frame sampler (OpenCV/FFmpeg/GStreamer), target 10–15+ fps/stream on GPU.
- **Per-camera calibration (mandatory):** homography for pixel→meter density; per-camera thresholds.
- **False-alarm control:** temporal persistence + zone logic + tunable sensitivity. FAR/hour is the real KPI.
- **Reference deployment:** Seoul Metropolitan Gov "Intelligent Disaster Safety System" (post-Itaewon).

## 5. Evaluation metrics
- **AUC** (frame-level) — but validate **cross-scene**, not just same-scene.
- **Early-warning lead time** (seconds before crush) — the metric that matters most.
- **False-alarm rate per hour** — governs operator trust.

---

## 6. Phased roadmap
- **Phase 0** — Repo scaffold, deps, config; acquire UMN + ShanghaiTech.
- **Phase 1** — Motion pipeline (Farneback flow features); reproduce 2024-paper baseline on UMN.
- **Phase 2** — Density (CSRNet) + per-camera homography calibration.
- **Phase 3** — Fusion + temporal persistence → risk score; eval harness (AUC / lead time / FAR).
- **Phase 4** — RTSP real-time serving + alerting/dashboard.
- **Phase 5** — Per-camera calibration workflow; optional learned fusion + anomaly model.

_Findings sourced from a deep-research pass (leads, not all independently verified)._
