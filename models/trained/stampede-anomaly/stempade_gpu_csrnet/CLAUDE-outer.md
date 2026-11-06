# CLAUDE.md — stempade (crowd stampede detection)

> Context for Claude Code running on the **GPU PC**. Read this first, then help the user
> complete the one task this machine exists for: **training the CSRNet density model**.

## What this project is

`stempade` detects dangerous crowds from video (CCTV/RTSP) — both **crushes** (people
squeezed too tightly, e.g. Itaewon) and **panic/escape** (people running). It's a
Python + PyTorch **risk-indicator fusion** pipeline: motion + density → per-camera
risk score → alerts. Design and rationale are in `PLAN.md`.

The full system was built and tested on another machine. **On the real UMN benchmark,
the panic-detection half already works** (leave-one-scene-out AUC ≈ 0.84, learned
fusion). The **crush half is not trained yet** — that's this PC's job.

## Why this PC exists: train the density (crush) model

The crush signal is **people-per-square-meter**, which comes from a crowd-counting model
called **CSRNet** trained on the **ShanghaiTech** dataset. Training needs a GPU. That is
the single task here. Everything else in the repo runs fine without a GPU.

### The task, start to finish
Step-by-step (with troubleshooting) is in **`GPU_SETUP.md`** — follow it. Summary:

```bash
# 1. environment
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -e ".[density]"                          # torch(GPU) + torchvision + scipy
python -c "import torch; print(torch.cuda.is_available())"   # MUST print True

# 2. dataset — ShanghaiTech Part A, arranged as:
#   data/shanghaitech/part_A/train_data/{images,ground-truth}/
#   data/shanghaitech/part_A/test_data/{images,ground-truth}/
#   images are IMG_<n>.jpg, ground truth GT_IMG_<n>.mat  (get it from Kaggle)

# 3. train (~20-60 min on a normal GPU)
python scripts/train_csrnet.py --data data/shanghaitech/part_A --epochs 100 \
    --out weights/csrnet_shanghaitech.pth
```

**Deliverable to hand back to the user:** the file `weights/csrnet_shanghaitech.pth`
(~60 MB). That's it. Nothing else needs to leave this PC.

### Sanity check after training
```bash
python -c "
from stempade.density import DensityEstimator
d = DensityEstimator(weights='weights/csrnet_shanghaitech.pth', device='cuda').load()
import cv2; img = cv2.imread('data/shanghaitech/part_A/test_data/images/IMG_1.jpg')
print('estimated people:', round(d.count(img)))"
```
A plausible count = success.

## How to help the user
- The user is **not deeply technical** — explain in plain language, avoid jargon, give
  exact copy-paste commands, and say what "success" looks like at each step.
- If `torch.cuda.is_available()` is `False`, STOP and fix it first (CPU training is
  impractically slow). It usually means the CPU-only PyTorch build got installed —
  reinstall per pytorch.org for their CUDA version.
- If `train_csrnet.py` errors on `.mat` files, the dataset folders aren't in the exact
  layout above — fix paths and retry.
- Training saves the best model so far continuously; Ctrl-C is safe.
- **Alternative worth offering:** a pre-trained CSRNet-on-ShanghaiTech checkpoint may
  exist online and could skip training entirely — but it must match this repo's CSRNet
  architecture (`src/stempade/density/csrnet.py`) to load. If you find one, verify it
  loads with `DensityEstimator(weights=...).load()` before trusting it.

## Repo orientation (for debugging)
- Package: `src/stempade/` (installed editable as `stempade`). Console entry: `stempade`.
- `density/csrnet.py` — CSRNet architecture + `DensityEstimator` (torch, lazy-imported).
- `motion/` — optical flow + physics features (CPU). `fusion/` — scoring, risk, learned
  fusion. `pipeline.py` — ties it together. `serving/` — FastAPI + dashboard.
- `scripts/train_csrnet.py` — the training script for THIS machine.
- Torch/fastapi are **optional extras** and lazy-imported, so non-GPU parts import
  without them. Only `.[density]` is needed here.

## What NOT to do
- Don't retrain or modify the motion/panic side — it's already validated elsewhere.
- Don't change the CSRNet architecture — the weights must load back on the other machine.
- Don't send the whole repo or dataset back — only `weights/csrnet_shanghaitech.pth`.
