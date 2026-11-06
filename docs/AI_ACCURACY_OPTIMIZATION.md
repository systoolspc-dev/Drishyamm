# AI Accuracy & Optimization — Design Doctrine

> How Drishyam's recognition pipeline stays accurate under real CCTV conditions, and the
> knobs that trade accuracy vs throughput. Companion to `SYSTEM_DESIGN.md` §7 and
> `DETECTION_LOGGING_ALERTING_POLICY.md`.

---

## 1. Accuracy philosophy

1. **Precision over recall at the alert layer.** A missed face costs a re-detection a few
   frames later; a false match costs operator trust. Every gate below biases toward
   "unknown" when uncertain.
2. **Vote across a track, never trust one frame.** CCTV frames are individually bad
   (blur, pose, compression). All identity and attribute decisions aggregate over the
   track, not a single frame.
3. **Measure like NIST, not like a demo.** The eval harness (`vms_face/eval/`) reports
   **FNIR @ FPIR = 1e-3** (open-set identification), not "accuracy %" — the metric that
   matches a watchlist deployment where almost everyone is NOT enrolled.
4. **No super-resolution inside recognition.** SR/GAN enhancement (facerecounstruct) is
   for *human review artifacts only* (snapshots, reports). Hallucinated pixels must never
   feed an embedding — it manufactures matches.

---

## 2. The accuracy chain (where errors are stopped)

```
RTSP frame → motion gate → SCRFD detect → zone filter → tracker
  → quality gate → embed gating → track embedding pool → matchability gate
  → ANN search (tenant-filtered) → threshold + top-1 margin guard
  → K-of-N / min-hits → event classification → alert policy (dedup/cooldown)
```

| Stage | Mechanism | What it prevents |
|---|---|---|
| Motion gate (`services/motion_gate.py`) | Skip detection on static empty scenes | Wasted GPU + false boxes from noise |
| Detection | **SCRFD** (buffalo_l), `det_size=960`, thr 0.5 |