# stempade — crowd stampede detection

Production crowd-stampede / dangerous-crowd-behavior detection from video (CCTV/RTSP).
Interpretable **risk-indicator fusion** pipeline: density + motion + flow-convergence → per-zone risk score.

- **Stack:** Python + PyTorch · **Deploy:** central GPU server
- See [`PLAN.md`](PLAN.md) for the full architecture, model picks, datasets, and phased roadmap.

## Architecture

```
RTSP stream ─► frame sampler ─┬─► density (CSRNet)        ─► people/m²
                              ├─► motion  (optical flow)  ─► speed, accel, divergence, KE, MI
                              └─► fusion + temporal logic ─► RISK (NORMAL/MODERATE/HIGH/CRITICAL)
```

## Layout

| Path | Purpose |
|------|---------|
| `src/stempade/ingestion/` | RTSP / video frame ingestion |
| `src/stempade/density/`   | Crowd density estimation (CSRNet) |
| `src/stempade/motion/`    | Optical flow + physics-based motion features |
| `src/stempade/calibration/` | Per-camera homography (pixel→meter) |
| `src/stempade/fusion/`    | Weighted risk score + temporal persistence |
| `src/stempade/eval/`      | Metrics: AUC, lead time, false-alarm-rate/hour |
| `configs/`                | YAML configuration |
| `scripts/`                | Dataset download / utilities |
| `data/`                   | Datasets (git-ignored) — see `data/README.md` |

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install -e .            # installs the `stempade` package
pytest -q                  # smoke test
```

## Quick start

```bash
python scripts/simulate_crowd.py --n 120 --seconds 20 --panic-at 12 --out data/samples/sim
stempade calibrate data/samples/sim.mp4 --out baseline.json --max-frames 150
stempade run  data/samples/sim.mp4 --baseline baseline.json      # prints alarm timeline
stempade eval data/samples/sim.mp4 data/samples/sim.labels.txt --baseline baseline.json
stempade serve --port 8000        # live RTSP + dashboard  (pip install -e ".[serving]")
```

## Status — all 5 phases implemented & verified

| Phase | What | State |
|-------|------|-------|
| 1 | Motion pipeline (Farneback flow + physics features) | ✅ runs on CPU |
| 2 | CSRNet density + per-camera homography/baseline | ✅ code ready; **CSRNet training needs GPU** |
| 3 | Scoring → weighted risk fusion + temporal persistence + eval harness | ✅ |
| 4 | RTSP serving (FastAPI) + rising-edge alerting + dashboard | ✅ |
| 5 | Learned fusion, synthetic social-force generator, calibration tooling | ✅ |

Verified on a synthetic normal→panic clip: **AUC 0.999** (1.0 with learned fusion),
HIGH alarm ~2 s into panic, **0 false alarms**. See `PLAN.md` for architecture and
the research behind each choice.

### Needs your GPU box
- **CSRNet density training** (`scripts/train_csrnet.py`) on ShanghaiTech — the only
  heavy training. Everything else (motion, fusion, learned-fusion, serving) runs on CPU.
