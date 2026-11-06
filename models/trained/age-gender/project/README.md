# Age + Gender Detection (PyTorch, transfer learning)

A multi-task CNN that predicts **age** (regression, in years) and **gender**
(male/female) from a face image. One shared pretrained backbone
(EfficientNet-B0 by default) with two heads. Trained on the **UTKFace** dataset.

```
age-gender-model/
├── data/                # put the UTKFace images in data/UTKFace/
├── checkpoints/         # best.pt / last.pt are written here during training
├── src/
│   ├── config.py        # all hyperparameters & paths
│   ├── dataset.py       # UTKFace loader + augmentation
│   ├── model.py         # backbone + age head + gender head
│   ├── train.py         # training loop (run this)
│   └── predict.py       # inference on an image
├── requirements.txt
└── venv/                # virtual env (don't copy this between machines)
```

---

## 1. Set up on the training PC

A `venv/` exists in this folder but **virtual envs are not portable** — recreate
it on the machine where you'll train:

```bash
cd age-gender-model
python3 -m venv venv

# activate it
source venv/bin/activate          # macOS / Linux
# venv\Scripts\activate           # Windows (PowerShell: venv\Scripts\Activate.ps1)
```

Install PyTorch **for your GPU** first (pick the command from
https://pytorch.org/get-started/locally/ — it depends on your CUDA version):

```bash
# example for CUDA 12.1
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

Then the rest:

```bash
pip install -r requirements.txt
```

Verify the GPU is visible:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
```

## 2. Get the data

Download **UTKFace** (the "Aligned & Cropped Faces" set) and extract the `.jpg`
files into `data/UTKFace/` so you have e.g. `data/UTKFace/23_1_0_2017...jpg`.

- Kaggle: https://www.kaggle.com/datasets/jangedoo/utkface-new
- Official page: https://susanqq.github.io/UTKFace/

Filenames encode the labels: `[age]_[gender]_[race]_[datetime].jpg`, where
gender `0 = male`, `1 = female`. The loader parses these automatically and skips
any malformed names.

## 3. Train

```bash
python src/train.py --data-dir data/UTKFace --epochs 30 --batch-size 64
```

Useful flags (see `python src/train.py --help` for all):

| flag | meaning |
|------|---------|
| `--backbone` | `efficientnet_b0` (default), `resnet50`, `mobilenet_v3_large` |
| `--batch-size` | raise it if your GPU has spare memory |
| `--lr` | learning rate (default 3e-4) |
| `--age-weight` / `--gender-weight` | rebalance the two losses |
| `--resume checkpoints/last.pt` | continue an interrupted run |

The backbone is frozen for the first couple of epochs (heads warm up), then
unfrozen for full fine-tuning. Each epoch prints **val age MAE** (mean error in
years) and **val gender accuracy**. The best model by validation loss is saved to
`checkpoints/best.pt`.

What to expect on UTKFace: roughly **5–6 years age MAE** and **~90%+ gender
accuracy** with EfficientNet-B0 after ~30 epochs.

## 4. Predict

```bash
python src/predict.py --ckpt checkpoints/best.pt --image some_face.jpg
```

Feed a tightly-cropped face for best results (UTKFace images are face crops).

---

## Notes & ideas

- **Exact age is hard.** Regression gives a usable estimate; if you only need
  age *brackets*, you can later swap the age head for a classifier.
- **Add a face detector** (e.g. MTCNN / OpenCV Haar / MediaPipe) in front of
  `predict.py` to handle full photos instead of pre-cropped faces.
- **Bias caveat:** UTKFace is imbalanced across ages/ethnicities, so accuracy
  varies by group. Don't use this for high-stakes decisions.
