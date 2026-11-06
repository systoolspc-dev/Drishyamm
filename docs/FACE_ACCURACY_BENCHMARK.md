# Face Recognition — Benchmark Baseline & Results

> **Purpose:** a reproducible accuracy baseline so every future change is *measured*, not assumed.
> **First run:** 2026-08-09 · **Harness:** `vms_face/eval/` (NIST FRVT-style, FNIR@FPIR + DET curve)

---

## 1. The benchmark set

Built from the live system's own enrolled faces via a **held-out split** — first 3 images
per person enrolled, the rest become probes:

```bash
python -m vms_face.eval.build_eval_data \
    --known-faces data/known_faces --out /tmp/eval_data --gallery-n 3
```

| | |
|---|---|
| Persons | **49** |
| Gallery images | **147** (3/person) |
| Probe images (held out) | **97** |
| Source | real enrolled staff photos, 6000×3368 group shots |

**⚠️ Known limitation:** probes are enrollment stills, which are cleaner than live CCTV
crops. These numbers are an **upper bound** — a regression baseline and threshold-calibration
aid, *not* production accuracy. For production-representative numbers, add human-labelled
CCTV crops as probes (see `eval/README.md`).

### Run it

```bash
docker exec drisyam-original-ai sh -c 'cd /srv/app/face_detection/vms_face && \
  python -m vms_face.eval.harness \
    --gallery /tmp/eval_data/gallery --probe /tmp/eval_data/probe \
    --manifest /tmp/eval_data/manifest.csv --threshold 0.45 \
    --out /tmp/eval_data/report'
```

---

## 2. Results

Model under test: **buffalo_l** — `det_10g.onnx` (SCRFD-10GF) + `w600k_r50.onnx` (ArcFace R50),
`recognizer=insightface_arc`, match threshold 0.45.

| Metric | Before (`det_thresh=0.7`) | **After (`det_thresh=0.5`)** | Target | Δ |
|---|---|---|---|---|
| **Detection rate** | 0.794 🔴 | **1.000** ✅ | ≥ 0.95 | **+20.6 pp** |
| **TPR / recall** | 0.773 🔴 | **0.969** ✅ | ≥ 0.95 | **+19.6 pp** |
| **F1** | 0.872 | **0.984** ✅ | ≥ 0.85 | +11.2 pp |
| **FPR** | 0.000 ✅ | **0.000** ✅ | ≤ 0.02 | unchanged |
| Wrong identities | 0 | 0 | — | — |

Lower thresholds (0.35, 0.25) measured **identical** to 0.5 on this set — so 0.5 is the
knee of the curve; going lower adds compute and spurious detections in the wild for no gain.

---

## 3. 🔎 Finding: `det_thresh=0.7` was silently costing ~20% of faces

**Root cause.** `docker-compose` set `INSIGHTFACE_DET_THRESHOLD: "0.7"`, overriding the code
default of `0.5` (`config/settings.py:132`). At 0.7 the detector returned **zero faces** on
20 of 97 probes; the same images yield a face at 0.5. Verified directly:

```
aakash-baghel__heldout1.jpg   max1=0  all=0  thr0.2=1
chitra__heldout1.jpg          max1=0  all=0  thr0.2=1
```

**Why it mattered so much:** a face that is never *detected* can never be matched — detection
rate is a hard ceiling on recall. The recognizer was actually doing well all along
(0.773 / 0.794 = **97.4%** of detected faces matched correctly); the loss was entirely upstream.

**Fix applied:** `INSIGHTFACE_DET_THRESHOLD: "0.7"` → `"0.5"` in
`docker-compose.drisyam-original.yml` (both `smart-cam-ai` and `smart-cam-ai-worker`).

**Caveat for live CCTV:** this benchmark is clean stills. A lower floor means more marginal
detections on live video — more tracks and embed work, and more chance of a non-face. The
downstream quality gate + 0.45 match threshold are the protection, and FPR stayed 0.000 here.
Re-measure on CCTV probes before assuming the same on live streams.

---

## 4. Diagnostic tooling added

| Tool | Purpose |
|---|---|
| `eval/build_eval_data.py` | build a held-out eval set from `data/known_faces` |
| `eval/det_size_sweep.py` | detection rate vs detector input size, ± 2×2 tiling |

`det_size_sweep` on this set (40 images, 6000×3368):

```
  det_size   found>=1    rate   faces   ms/img
       960         40   1.000      40     31.6
      1280         40   1.000      41     24.5
      1600         40   1.000      42     45.1
      2048         32   0.800      34     78.0   ← larger is NOT always better
  tiled2x2         40   1.000      90     47.4
```

Two lessons: **960 is sufficient** for this imagery (no need to raise `det_size`), and
**2048 is actively worse** — a reminder to measure rather than assume "bigger = better".
Tiling surfaced 90 faces vs 40 (these are group photos), which is the lever to reach if
far/small faces ever become the bottleneck on real CCTV.

---

## 5. AdaFace A/B (2026-08-09)

Same benchmark, same detector (det_thresh 0.5); recognizer swapped to
**AdaFace IR101 @ WebFace12M** (ONNX from `Evn9172/cvlface_adaface_ir101_webface12m_onnx`,
match threshold 0.35 — its calibrated default).

| Metric | ArcFace R50 (buffalo_l) | **AdaFace IR101/WF12M** |
|---|---|---|
| TPR / recall | 0.969 | **0.979** |
| F1 | 0.984 | **0.990** |
| FPR | 0.000 | **0.000** |
| Median margin above threshold | 0.220 | **0.293** |

Per-probe: AdaFace matched **everything ArcFace matched, plus one more**
(`ashwani-tiwari__heldout2`); nothing regressed. The wider margin (+0.073) means more
headroom before borderline faces fall under the threshold — the research predicts this gap
*grows* on low-quality CCTV crops (TinyFace: AdaFace 72.29 vs ArcFace-class ~64).

**Not switched on in prod yet because:**
1. AdaFace WebFace12M weights carry the same non-commercial restriction as buffalo_l —
   the licensing question (P0) covers both.
2. Embeddings are **not compatible across models** — switching means re-embedding the whole
   enrolled gallery (re-enrolment run), not just flipping the env var.
3. IR101 is ~2× the compute of R50 — fine on the dGPU, needs measuring on Jetson.

Lab weights kept at `/tmp/adaface_ir101_webface12m.onnx` in the ai container (ephemeral).

## 6. Next measurements to run

1. **CCTV-crop probes** — the number that actually matters. Needs human labelling.
2. **Per-camera threshold calibration** via `eval/frvt.py` → FNIR@FPIR, not a global cosine.
3. **Gallery-size sensitivity** — FPIR scales with gallery size; re-check as enrolment grows.
4. **AdaFace on CCTV probes** — where its low-quality advantage should actually show.

Related: `docs/FACE_RECOGNITION_RESEARCH_2026.md` (SOTA research + upgrade plan).
