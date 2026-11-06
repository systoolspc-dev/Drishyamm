# Weapon v2: YOLO11n on a merged 237-class dataset (EXPERIMENTAL, do not deploy)

This was an earlier (2026-06-13) attempt to teach a nano model "weapon vs. look-alike". It failed
because of how the two datasets were merged, not because of the model. It is kept as a lesson and as a
starting point. The production-candidate weapon model is `../weapon-yolov12l/`, a YOLO26-L trained on a
cleaned 3-class dataset from the same Roboflow workspace.

## 1. What it detects

`Combined_Dataset/data.yaml` has **nc = 237**. It was built by `merge_datasets.py` as the union of two
datasets' class lists:

- **Dataset 1, `Weapon Detection.v1i.yolo26`** (6 classes):
  - ids 0 to 5: `billete` (banknote), `knife`, `monedero` (wallet), `pistol`, `smartphone`, `tarjeta` (card)
  - Roboflow `vidit-ghai-7vysa/weapon-detection-t2esr-rujn8` v1, **CC BY 4.0**, 16,903 images
  - Roboflow made 3 augmented copies of each source image (flip, brightness ±25 %, exposure ±10 %,
    blur ≤1.5 px, 0.5 % salt-and-pepper noise). That is why train has 14,790 images but only 4,930
    unique sources.
- **Dataset 2, `non_weapons.v1i.yolo26`** (232 classes):
  - 201 bare numbers (`'0'`, `'102'`, … `'98'`)
  - about 30 pen and stationery names (`Pen`, `Pens`, `ball pen`, `pencil`, `monami`, `step3`, …)
  - `gun`, `knife` and `non-weapon`
  - Roboflow `vidit-ghai-7vysa/non_weapons-or4bo` v1, **CC BY 4.0**, 5,413 images
- Merged ids: 0 to 5 as above, then 6 to 206 are the numeric labels, 207 to 236 are the stationery names
  plus `gun` (217) and `non-weapon` (220). `knife` was de-duplicated into id 1.
- Split sizes: train 18,579, valid 2,492, test 1,245 images.
- Key validation instances: pistol 702, knife 735, gun 439, smartphone 171. 103 classes appear in val.
- Dataset on disk: `C:\projects\Weapon Detection New\Combined_Dataset\`, plus the two source folders next
  to it.

## 2. Architecture and training recipe

| item | value |
|---|---|
| architecture | YOLO11n (`yolo11n.yaml`, scale n), standard NMS head |
| parameters / GFLOPs | 2.70 M / 7.1 at 640 (wide head because nc = 237) |
| base | `yolo11n.pt` COCO-pretrained |
| imgsz / batch / epochs | 640 / 16 / 100 (all 100 ran; patience 100) |
| optimizer | auto (lr0 0.01, lrf 0.01, mom 0.937, wd 5e-4, warmup 3) |
| augmentation | mosaic 1.0 (close 10), hsv 0.015/0.7/0.4, translate 0.1, scale 0.5, fliplr 0.5, no mixup or copy-paste |
| Ultralytics | 8.4.46, 2026-06-14 |

## 3. Results (validation, 2,492 images)

| row | epoch | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|---|
| final | 100 | 0.598 | 0.234 | 0.278 | 0.210 |
| best (fitness = mAP50-95), shipped `best.pt` | 91 | 0.604 | 0.226 | 0.285 | 0.215 |

- Losses fell steadily (train box 1.03 to 0.43, val cls 1.57 to 0.58), so the model did learn.
- The **headline numbers are averaged over every class present in val (103 of them)**. Most of those are
  numeric or pen labels with a handful of instances each, and they drag the mean down. Pistol and knife
  alone are likely much better, but `results.csv` has no per-class values.
- To get them: `yolo detect val model=… data=Combined_Dataset/data.yaml` prints per-class AP.
- Included plots in `project/runs/weapon_detect/`: `confusion_matrix(_normalized).png`, `BoxPR/P/R/F1_curve.png`,
  `results.png`. A 237x237 matrix is too large to read class by class.

## 4. Inference

```bash
yolo detect predict model=project/runs/weapon_detect/weights/best.pt source=img.jpg imgsz=640 conf=0.25 iou=0.7
```
```python
m = YOLO("project/runs/weapon_detect/weights/best.pt")
r = m.predict(frame, imgsz=640, conf=0.25, iou=0.7, classes=[1, 3, 217])[0]  # knife, pistol, gun only
```
- **Preprocessing:** letterbox 640, RGB, divide by 255.
- **Postprocessing:** YOLO11 is not end-to-end. The raw output is `(1, 4+237, 8400)`, followed by
  class-wise NMS (conf 0.25, iou 0.7, max_det 300). Exported ONNX models have no NMS unless you pass
  `nms=True` at export.
- **Platform status: not integrated anywhere.** The console "Weapon" feature is demo-only (see
  `../weapon-yolov12l/README.md`).

## 5. Known weaknesses (why it failed)

1. **Class explosion.**
   - `merge_datasets.py` copies every source class name as its own class instead of mapping all
     non-weapon labels to one "negative" class (or to background).
   - The result is 201 meaningless numeric classes and about 30 near-synonyms (`Pen`, `Pens`, `pen`,
     `ball pen`, `pen body`, …) that the model is forced to tell apart.
2. **Split weapon classes.** `pistol` (from dataset 1) and `gun` (from dataset 2) are different ids for the
   same object, so the model is penalised for confusing them.
3. **Look-alikes are classes, not negatives.** `smartphone`, `billete`, `monedero` and `tarjeta` are
   decoys. Training them as positives spends capacity; what you need is to suppress them.
4. **Leakage risk inside dataset 1.** All splits come from the same 7 frame-sequence prefixes (`ABbframe…`,
   `DSC…`), so neighbouring video frames sit in train and val (filename check; no shared exact stems).
5. A nano model at 640 on small handguns.

## 6. What to do instead (and embedded notes)

- **Rebuild the merge script with an explicit map.** `{pistol, gun} -> Gun`, `knife -> Knife`, everything
  else -> drop the box but keep the image as background, or map it to a single `Non Weapon` class. That is
  effectively what the `../weapon-yolov12l` dataset did.
- Re-split by video or sequence prefix.
- Retrain n or s at 640 to 960, or better, distil from the YOLO26-L weapon model:
  `YOLO("yolo26n.pt").train(data=<3-class yaml>, distill_model="../weapon-yolov12l/project/runs/detect/runs/weapon_detection_v12l-4/weights/best.pt")`.
- **Export:**
  - `yolo export model=best.pt format=onnx imgsz=640 nms=True`
  - `yolo export model=best.pt format=engine half=True imgsz=640`
  - `yolo export model=best.pt format=engine int8=True data=<yaml>` (uses val images for calibration)
- Alert only after K-of-N confirmation per track (`../../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`).

## 7. Files in this folder

| shipped | path |
|---|---|
| weights (5.7 MB, sha256 prefix `1d9e1e69cf045b62`) | `project/runs/weapon_detect/weights/best.pt` |
| run | `project/runs/weapon_detect/args.yaml`, `results.csv`, 7 PNG plots |
| data configs | `project/Combined_Dataset/data.yaml`, `project/merge_datasets.py`, `project/Weapon Detection.v1i.yolo26/{data.yaml,README.*}`, `project/non_weapons.v1i.yolo26/{data.yaml,README.*}` |

**Not shipped** (all under `C:\projects\Weapon Detection New\`):
- `runs/weapon_detect/weights/last.pt`
- `yolo11n.pt` and `yolo26n.pt`
- all images and labels (the `Combined_Dataset` and both source datasets)
- `train_batch*.jpg` and `val_batch*.jpg`

No training script was found in the folder. The run args are in `args.yaml`.
