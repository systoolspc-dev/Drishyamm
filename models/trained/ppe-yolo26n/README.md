# PPE detector (YOLO26-N, Construction-PPE): ADVISORY ONLY

This model is sold as "advisory" (about 52 % mAP50). The confusion matrix shows why. The PPE items it
finds are mostly right, but the **violation classes** (`no_helmet`, `no_goggle`, `no_gloves`, `no_boots`)
are almost never detected. A "violation" alert therefore cannot come from those classes. It has to be
inferred: a Person box with no helmet or vest inside it.

## 1. What it detects (`ppe.yaml` / `dataset/data.yaml`)

| id | class | train | val | test |
|---|---|---|---|---|
| 0 | helmet | 1,357 | 201 | 192 |
| 1 | gloves | 1,162 | 136 | 163 |
| 2 | vest | 1,283 | 171 | 178 |
| 3 | boots | 1,251 | 151 | 211 |
| 4 | goggles | 427 | 47 | 52 |
| 5 | none | 654 | 81 | 65 |
| 6 | Person | 1,790 | 239 | 236 |
| 7 | no_helmet | 400 | 45 | 40 |
| 8 | no_goggle | 337 | 41 | 33 |
| 9 | no_gloves | 442 | 56 | 58 |
| 10 | no_boots | **88** | **4** | 23 |

- Instance counts come from the label files.
- Images: train 1,132, val 143, test 141. There are 1,142 train label files, i.e. 10 orphan labels.
- Source: the **Ultralytics "Construction-PPE" dataset**
  (`https://github.com/ultralytics/assets/releases/download/v0.0.0/construction-ppe.zip`, docs at
  docs.ultralytics.com/datasets/detect/construction-ppe).
- `dataset/LICENSE` is **AGPL-3.0**. That matters for commercial redistribution of anything derived from
  the dataset.
- `ppe.yaml` is a corrected copy with an absolute `path:`.
- On disk: `C:\projects\ppe\dataset\` (`images/{train,val,test}`, `labels/…`).

## 2. Architecture and training recipe

| item | value |
|---|---|
| architecture | YOLO26-N (`yolo26n.yaml`, end2end NMS-free), 2.51 M params, 5.9 GFLOPs at 640 |
| base | `yolo26n.pt` COCO-pretrained |
| imgsz / batch | 640 / AutoBatch (`batch: -1`, which picked **101** on the 72 GB GPU) |
| epochs | 100 planned. Early-stopped: run -4 stopped at **84** (patience 25, best epoch 59). Run -3 stopped at 56 (patience 10, best epoch 46) |
| optimizer | auto (lr0 0.01, lrf 0.01, mom 0.937, wd 5e-4) |
| augmentation | Ultralytics defaults: mosaic 1.0 (close 10), hsv 0.015/0.7/0.4, translate 0.1, scale 0.5, fliplr 0.5 |
| script | `train.py` (trains, then `model.val(split="test")`) |
| Ultralytics | 8.4.92, 2026-07-11 |

## 3. Results (val split, 143 images)

| run / row | epoch | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|---|
| **-4 best (shipped, recommended)** | 59 | 0.630 | 0.511 | **0.536** | 0.260 |
| -4 final | 84 | 0.639 | 0.523 | 0.527 | 0.258 |
| -3 best (shipped) | 46 | 0.736 | 0.462 | 0.509 | 0.253 |
| -3 final | 56 | 0.616 | 0.500 | 0.527 | 0.251 |
| -2 best (not shipped; epochs=50, early-stopped at 29) | 26 | 0.493 | 0.457 | 0.464 | 0.239 |

- "PPE about 52 %" in sales notes is this mAP50 (0.51 to 0.54).
- Losses: val cls 5.68 to 1.27. Val box stays flat around 1.75 to 1.79 while train box keeps falling, so
  box quality saturates early on this small dataset.

**Normalized confusion matrix for -4** (`project/runs/yolo26n_ppe-4/confusion_matrix_normalized.png`). Each
value is the fraction of true instances detected as the correct class:

| class | correct | missed (predicted background) |
|---|---|---|
| Person | 0.88 | 0.10 |
| boots | 0.79 | 0.21 |
| helmet | 0.77 | 0.23 |
| vest | 0.69 | 0.28 |
| gloves | 0.67 | 0.32 |
| none | 0.53 | 0.43 |
| goggles | 0.49 | 0.51 |
| **no_helmet** | **0.27** | **0.73** |
| **no_gloves** | **0.04** | **0.96** |
| **no_goggle** | **0.00** | **1.00** |
| **no_boots** | **0.00** | **1.00** |

- False positives on background are spread over helmet (21 %), Person (18 %), boots (17 %) and gloves (16 %).
- Plots included for -3 and -4: confusion matrices, `BoxPR/P/R/F1_curve.png`, `results.png`.
- The test-split evaluation plots (`runs/detect/val`, `val-2`) exist on disk but were not shipped. No test
  numbers were saved.

## 4. Inference

```python
from ultralytics import YOLO
m = YOLO("project/runs/yolo26n_ppe-4/weights/best.pt")
r = m.predict(frame, imgsz=640, conf=0.25)[0]   # end2end: no NMS
# r.boxes.cls: 0 helmet 1 gloves 2 vest 3 boots 4 goggles 5 none 6 Person 7..10 no_*
```
- **Preprocessing:** letterbox 640, RGB, divide by 255.
- **Postprocessing:** end-to-end output `(1, 300, 6)` `[x1, y1, x2, y2, score, cls]`, score filter only.
- **Recommended decision logic.** Do not trust the `no_*` classes:
  1. Take each `Person` box.
  2. Look for a `helmet` box whose centre falls in the top 30 % of the person box, and for a `vest`
     overlapping the torso.
  3. Declare a violation only if none is found across K-of-N frames of the same track.
- **Platform status: NOT integrated.** The backend has the vocabulary only (`ppe.violation` in
  `smart-cam-backend/src/services/reportPdf/vocabulary.js`). There is no PPE service in `smart-cam-ai/`.

## 5. Known weaknesses

- **Tiny dataset.** 1,132 training images for 11 classes. `no_boots` has 88 train and only 4 val instances,
  so its AP is statistically meaningless.
- **"Absence" classes are inherently hard.** A bare head or bare hand looks like the background classes,
  and the matrix confirms the model gives up on them.
- **Semantic overlap.** `none` overlaps with the `no_*` classes. Mixing "item present" and "item absent"
  labels in one detector creates conflicting supervision.
- Small objects: goggles and gloves are tiny at CCTV distances, and a nano model at 640 misses about half.
- **Domain gap.** These are construction-site photos, not overhead campus or factory CCTV. Night and IR are
  absent.

## 6. Improvement ideas (embedded)

1. **Re-define the task.**
   - Detect `Person` and the positive items only (helmet, vest, optionally gloves, goggles, boots).
   - Compute violations geometrically per person track.
   - Or run a second-stage classifier on the person or head crop (`helmet / no_helmet`, `vest / no_vest`).
     Crops make small items large, and a YOLO11n-cls at 128 to 224 px is cheap.
2. **Data.**
   - Add 3 to 5k frames from your own sites. Label positives only, and include many bare-head people as
     plain `Person`.
   - Merge with larger open PPE sets (check each licence).
   - Train at 960 or tile the frame for goggles and gloves.
3. **Bigger teacher, small student.** Train `yolo26s/m` at 960, then
   `YOLO("yolo26n.pt").train(data="ppe.yaml", distill_model="<teacher best.pt>")`.
4. **Export:**
   - `yolo export model=best.pt format=onnx imgsz=640 simplify=True`
   - `format=engine half=True`
   - `format=engine int8=True data=ppe.yaml` (calibrate on site frames if possible)
   - Nano INT8 runs comfortably on Jetson Orin Nano class devices.
5. **Temporal confirmation.**
   - Raise "violation" only after a person track has lacked a helmet for, say, 10 of 15 frames and the
     head is visible: a face or head keypoint must be present, so a person seen from behind or occluded
     does not fire.
   - Alert per identity transition. See `../../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`.

## 7. Files in this folder

| shipped | path |
|---|---|
| -4 weights (recommended, 5.4 MB, sha256 prefix `a7dfa48b92bdaa83`) | `project/runs/yolo26n_ppe-4/weights/best.pt` |
| -3 weights (5.4 MB, sha256 prefix `0e8686506ccd09e7`) | `project/runs/yolo26n_ppe-3/weights/best.pt` |
| run files | `args.yaml` for runs (none, -2, -3, -4); `results.csv` for -2, -3, -4; 7 PNGs each for -3 and -4 |
| config / script | `project/ppe.yaml`, `project/dataset/data.yaml`, `project/dataset/LICENSE`, `project/train.py` |

**Not shipped** (all under `C:\projects\ppe\`):
- `runs/yolo26n_ppe-2/weights/{best,last}.pt` (21 MB, unstripped)
- `last.pt` for -3 and -4
- `runs/detect/val`, `val-2` (test-split plots)
- `yolo26n.pt`
- the images and labels
- `venv/`
