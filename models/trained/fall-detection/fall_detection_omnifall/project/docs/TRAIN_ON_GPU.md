# Training on your GPU PC (handoff)

The slow, device-independent step (pose extraction → `data_prepared/windows.npz`)
is already done on the Mac. Training on the GPU box just loads that file, so it's
fast. The `.npz` contains only numeric feature windows — identical no matter what
hardware produced it — so it transfers perfectly.

## 1. Copy these to the GPU PC
```
fall detection/
  ├── src/               (all code)
  ├── config.py
  ├── requirements.txt
  ├── data_prepared/windows.npz     ← the prepared training data (the key file)
  └── docs/
```
You do NOT need to copy `data_raw/`, the raw GMDCSA24 videos, or `venv/`.
(You only need the videos again if you want to re-extract or run live detection.)

## 2. Set up the environment (with CUDA)
```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
# install a CUDA build of torch matching your CUDA version, e.g.:
./venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu121
```
Verify the GPU is seen:
```bash
./venv/bin/python -c "import torch; print('cuda', torch.cuda.is_available())"
```

## 3. Train
```bash
./venv/bin/python -m src.model.train --data data_prepared/windows.npz --out models/fall_cnn.pt
```
- **Data augmentation is ON by default** (mirror flips, keypoint dropout for
  occlusion, coordinate noise) — this is the main lever for a more robust model
  and helps the occlusion-related misses. Disable with `--no-augment` to compare.
- Trains on 3 subjects, validates on the held-out 4th (generalization to an
  unseen person).
- Prints **sensitivity / specificity / precision / F1** each epoch (same metrics
  as the paper). Saves the best-sensitivity checkpoint to `models/fall_cnn.pt`.
- CPU training also works but is slower; a GPU just makes it quicker.

## 4. (Optional) export for serving + run detection
```bash
./venv/bin/python -m src.model.export_onnx --model models/fall_cnn.pt
./venv/bin/python -m src.engine.run_video --video some_clip.mp4 --out annotated.mp4
```

## Training on the COMBINED dataset (GMDCSA + VideoDataset)

For a more view-robust model (multi-angle, 33 subjects), train on both datasets.
The combined windows are prepared as `data_prepared_combined/windows.npz`:
```bash
./venv/bin/python -m src.model.train \
    --data data_prepared_combined/windows.npz --out models/fall_cnn.pt
```
If you need to (re)build the combined windows on this PC (needs both raw
datasets present), run the two adapters then prepare — see CLAUDE.md
"Datasets & adapters". Note `WINDOW_SIZE=24` (set in config.py) so short
VideoDataset clips fit; keep it consistent between extract and train.

## Notes
- `config.YOLO_DEVICE = 0` already targets CUDA for inference; it auto-falls back
  to CPU/MPS elsewhere, so no code change needed.
- To re-extract windows from raw videos on the GPU PC instead of copying the
  `.npz`, copy `data_raw/` (or re-run the GMDCSA24 adapter) and run
  `python -m src.data.prepare_dataset --raw data_raw --out data_prepared`.
- Want more/other data later? Add videos under `data_raw/fall` and `data_raw/adl`
  (+ `annotations.csv`) and re-run prepare → train.
