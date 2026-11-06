# Running the density (crush) training on your GPU PC

This is the one heavy step that needs a GPU. You'll train the "people-per-square-meter"
model (**CSRNet**) on a public dataset, then copy one small file back. Everything else
runs fine without a GPU.

Follow these steps in order. Copy-paste the commands. Estimated time: **30–90 min**,
most of it unattended training.

---

## Step 0 — What you need on the GPU PC
- An NVIDIA GPU with recent drivers (any modern gaming/workstation GPU is fine).
- Python 3.10 or newer.
- ~5 GB free disk space (dataset + libraries).
- Internet access.

Quick check the GPU is visible:
```bash
nvidia-smi
```
If that prints a table with your GPU, you're good. If "command not found", install the
NVIDIA driver first.

---

## Step 1 — Unpack the project
Copy `stempade_gpu.tar.gz` (the file I'm giving you) onto the GPU PC, then:
```bash
tar -xzf stempade_gpu.tar.gz
cd stempade
```

## Step 2 — Set up Python
```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate
# Mac/Linux:
source .venv/bin/activate

pip install --upgrade pip
pip install -e ".[density]"      # installs PyTorch (GPU), torchvision, scipy
```
This downloads PyTorch (~2 GB) — that's normal, let it finish.

Confirm PyTorch sees the GPU:
```bash
python -c "import torch; print('GPU available:', torch.cuda.is_available())"
```
It must print `GPU available: True`. If it says `False`, the training will be far too
slow — stop and fix the GPU/PyTorch install before continuing.

## Step 3 — Download the training dataset (ShanghaiTech)
This is a standard public crowd-counting dataset. Get **ShanghaiTech Part A** and put it
so the folders look like this:
```
data/shanghaitech/part_A/train_data/images/       IMG_1.jpg, IMG_2.jpg, ...
data/shanghaitech/part_A/train_data/ground-truth/ GT_IMG_1.mat, GT_IMG_2.mat, ...
data/shanghaitech/part_A/test_data/images/
data/shanghaitech/part_A/test_data/ground-truth/
```
Where to get it: search "ShanghaiTech crowd counting dataset" on **Kaggle** (easiest —
it comes pre-organized in exactly this layout) and unzip it under `data/shanghaitech/`.

Quick check the layout is right:
```bash
ls data/shanghaitech/part_A/train_data/images | head
```
You should see `IMG_1.jpg`, `IMG_2.jpg`, ...

## Step 4 — Train the model
```bash
python scripts/train_csrnet.py --data data/shanghaitech/part_A --epochs 100 \
    --out weights/csrnet_shanghaitech.pth
```
What you'll see: a line printed per epoch with a decreasing `loss/img` number, and
`saved weights/...` whenever it improves. Let it run. On a normal GPU this is roughly
20–60 minutes. You can stop it early with Ctrl-C — it keeps the best model saved so far.

## Step 5 — Send one file back
When it finishes, the only thing you need to bring back is this small file:
```
weights/csrnet_shanghaitech.pth      (~60 MB)
```
Copy it back to me / this machine. That's the trained crush model.

---

## Step 6 (optional) — quick sanity check on the GPU PC
Confirm the model loads and produces a crowd count on any image:
```bash
python -c "
from stempade.density import DensityEstimator
d = DensityEstimator(weights='weights/csrnet_shanghaitech.pth', device='cuda').load()
import cv2; img = cv2.imread('data/shanghaitech/part_A/test_data/images/IMG_1.jpg')
print('estimated people in IMG_1:', round(d.count(img)))
"
```
If it prints a plausible number, training worked.

---

## What I do once you send `csrnet_shanghaitech.pth` back
- Turn on the density branch (`density.enabled: true` + the weights path in the config).
- The system then measures **people-per-square-meter**, which is the core **crush** signal.
- Combined with the motion (panic) detection we already validated, that covers **both**
  dangers you asked for.

## Troubleshooting
- **`GPU available: False`** → PyTorch installed the CPU build. Reinstall following the
  official selector at pytorch.org for your CUDA version, then redo Step 2's last line.
- **`.mat` file errors in Step 4** → your dataset folders aren't in the exact layout
  from Step 3. Fix the folder names/paths and rerun.
- **Out-of-memory** → the script uses batch size 1 already; close other GPU apps. It
  should fit on 4 GB+.
