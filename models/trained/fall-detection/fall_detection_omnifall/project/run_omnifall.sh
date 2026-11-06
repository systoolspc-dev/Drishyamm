#!/usr/bin/env bash
# Extract mcfd+le2i features -> merge with the validated combined windows ->
# train with GMDCSA s2 held out. Runs in WSL2 Ubuntu-24.04 on the GPU.
set -euo pipefail
export PYTHONUNBUFFERED=1
# avoid the torch/opencv OpenMP double-free (heap corruption) — force single-threaded
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
# force single-threaded FFmpeg decode so corrupt-macroblock AVIs don't crash the decoder
export OPENCV_FFMPEG_CAPTURE_OPTIONS="threads;1"
export OPENCV_FFMPEG_LOGLEVEL=-8   # silence harmless mp3float 'Header missing' spam
cd /mnt/c/projects/fall_detection_omnifall
PYBIN="$HOME/fall_venv/bin/python"

echo "############ [1/3] FEATURE EXTRACTION (YOLO-pose over 325 videos) ############"
date
"$PYBIN" -m src.data.prepare_dataset --raw data_raw \
    --out data_prepared_omnifall --annotations annotations.csv

echo
echo "############ [2/3] MERGE with data_prepared_combined ############"
"$PYBIN" - <<'PYEOF'
import numpy as np
from pathlib import Path
a = np.load("data_prepared_combined/windows.npz", allow_pickle=True)   # GMDCSA + VideoDataset (has s2)
b = np.load("data_prepared_omnifall/windows.npz", allow_pickle=True)   # mcfd + le2i hard negatives
X = np.concatenate([a["X"], b["X"]]).astype("float32")
y = np.concatenate([a["y"], b["y"]])
g = np.concatenate([a["groups"], b["groups"]])
Path("data_prepared_all").mkdir(exist_ok=True)
np.savez("data_prepared_all/windows.npz", X=X, y=y, groups=g)
print("combined:", a["X"].shape, "+ omnifall:", b["X"].shape)
print("MERGED   :", X.shape, "| falls", int((y == 1).sum()), "| normal", int((y == 0).sum()),
      "| groups", len(set(g.tolist())))
assert "s2" in set(g.tolist()), "s2 missing from merged groups -> holdout would be empty!"
print("s2 present in merged groups: OK")
PYEOF

echo
echo "############ [3/3] TRAIN (holdout s2) ############"
date
"$PYBIN" -m src.model.train --data data_prepared_all/windows.npz \
    --out models/fall_cnn_omnifall.pt --holdout s2

echo
echo "############ DONE ############"
date
