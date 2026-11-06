"""Train YOLO26n on the Construction-PPE dataset.

Run from the project root with the project venv:

    venv\\Scripts\\python.exe train.py

Edit the constants below to tweak the run. Nothing here starts automatically
unless you execute the file.
"""

from pathlib import Path

from ultralytics import YOLO

# --- Paths ------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent
DATA = ROOT / "ppe.yaml"          # corrected dataset config (absolute paths)

# --- Hyperparameters --------------------------------------------------------
MODEL = "yolo26n.pt"              # nano YOLO26; weights auto-download on first run
EPOCHS = 100
IMGSZ = 640
BATCH = -1                        # -1 = AutoBatch (picks a batch for ~60% VRAM)
DEVICE = 0                        # GPU 0 (RTX PRO 5000); use "cpu" to force CPU
WORKERS = 8                       # dataloader workers
PATIENCE = 25                     # early-stop after N epochs without improvement

PROJECT = str(ROOT / "runs")      # where results/weights are saved
NAME = "yolo26n_ppe"              # run subfolder name


def main() -> None:
    model = YOLO(MODEL)

    model.train(
        data=str(DATA),
        epochs=EPOCHS,
        imgsz=IMGSZ,
        batch=BATCH,
        device=DEVICE,
        workers=WORKERS,
        patience=PATIENCE,
        project=PROJECT,
        name=NAME,
        exist_ok=False,           # set True to overwrite an existing run folder
    )

    # Evaluate the best checkpoint on the held-out test split.
    metrics = model.val(data=str(DATA), split="test")
    print(f"\nTest mAP50-95: {metrics.box.map:.4f}  |  mAP50: {metrics.box.map50:.4f}")


if __name__ == "__main__":
    main()
