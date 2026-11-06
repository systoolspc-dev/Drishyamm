# Train the Triple Rider detector

This folder contains the Roboflow YOLO dataset and a training script for the
two classes in `data.yaml`:

1. `Single-Double-Rider`
2. `Triple Rider`

## Requirements

- Python 3.9 or newer
- A computer with internet access for installing Ultralytics and downloading
  the pretrained YOLO11n weights on the first run
- NVIDIA GPU, a working NVIDIA driver, and a CUDA-enabled PyTorch installation

## Setup and train

Open a terminal in this folder (or run the script by its full path), then:

```bash
python -m venv .venv
```

Activate the environment:

```bash
# Windows PowerShell
.venv\Scripts\Activate.ps1

# macOS / Linux
source .venv/bin/activate
```

Install PyTorch with CUDA support using the command recommended by the
[official PyTorch install selector](https://pytorch.org/get-started/locally/).
Choose the target computer's operating system, package manager, Python, and a
CUDA build compatible with its NVIDIA driver. Then verify CUDA is visible:

```bash
python -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA GPU not found')"
```

The first value must be `True`. Next install the training dependency and start
training:

```bash
python -m pip install -r requirements.txt
python train.py
```

The script fine-tunes pretrained `yolo11n.pt` for 50 epochs at 640-pixel
image size and explicitly selects GPU 0. It stops with an error if CUDA is not
available, so it will not fall back to CPU. Adjust `batch` in `train.py` if
the GPU runs out of memory.

## Outputs

Training outputs are written to:

```text
runs/triple-rider-yolo11n/
```

The best checkpoint is `runs/triple-rider-yolo11n/weights/best.pt`; the final
epoch checkpoint is `runs/triple-rider-yolo11n/weights/last.pt`. The training
directory also contains metrics, plots, and validation results.

To evaluate on the held-out test split after training, run:

```bash
yolo detect val model=runs/triple-rider-yolo11n/weights/best.pt data=data.yaml split=test
```

To run prediction on an image:

```bash
yolo detect predict model=runs/triple-rider-yolo11n/weights/best.pt source=path/to/image.jpg
```

Keep the `train`, `valid`, and `test` directories with their `images` and
`labels` subdirectories, as well as `data.yaml`, when transferring the dataset
to another device.
