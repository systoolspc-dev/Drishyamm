# Vehicle colour classifier (YOLO11n-cls, 15 colours)

This is an image classifier, not a detector. It takes a vehicle crop (from a vehicle detector or the ANPR
vehicle box) and returns one of 15 colours.

## 1. What it predicts

| id | colour | train | valid | test |
|---|---|---|---|---|
| 0 | beige | 846 | 86 | 47 |
| 1 | black | 876 | 72 | 50 |
| 2 | blue | 1,641 | 146 | 67 |
| 3 | brown | 1,212 | 121 | 66 |
| 4 | gold | 441 | 37 | 23 |
| 5 | green | 1,203 | 126 | 55 |
| 6 | grey | 852 | 103 | 43 |
| 7 | orange | 1,140 | 118 | 58 |
| 8 | pink | 1,047 | 95 | 51 |
| 9 | purple | 1,179 | 117 | 44 |
| 10 | red | 1,356 | 121 | 75 |
| 11 | silver | 765 | 67 | 36 |
| 12 | tan | 879 | 82 | 37 |
| 13 | white | 864 | 76 | 37 |
| 14 | yellow | 1,260 | 115 | 53 |
| | **total** | **15,561** | **1,482** | **741** |

- Counts are the number of files in each class folder.
- The folder-format dataset has 17,784 images.
- Class ids follow alphabetical folder order (Ultralytics classify convention). `names` in the checkpoint
  match the table.
- Source: Roboflow "Color Vehicle" v1 (exported 2026-06-10; the README lists classes as "1-…-14"). No
  workspace, URL or licence is recorded in the export: **licence unknown**.
- **Roboflow preprocessing applied to every image:** auto-orient and **auto-contrast (contrast stretching)**.
- **Roboflow augmentation (train only), 3 versions per source:** horizontal flip, **brightness ±20 %**,
  blur up to 1 px, 0.46 % salt-and-pepper.
- On disk: `C:\projects\vehicle color\Color Vehicle.v1i.folder\{train,valid,test}\<colour>\*.jpg`.

## 2. Architecture and training recipe

| item | value |
|---|---|
| architecture | YOLO11n-cls (`yolo11n-cls.yaml`), 1.55 M params, 3.3 GFLOPs at 640 (about 0.4 GFLOPs at 224) |
| base | `yolo11n-cls.pt` (ImageNet-pretrained) |
| imgsz / batch / epochs | **640** (unusually large for classification; the default is 224) / 16 / 50 (all ran) |
| optimizer | auto (lr0 0.01 nominal, lrf 0.01), patience 100 |
| augmentation (Ultralytics classify path) | RandomResizedCrop, fliplr 0.5, **`auto_augment: randaugment`**, `erasing: 0.4` |
| Ultralytics | 8.4.63, 2026-06-10 |

How the classify augmentation works in Ultralytics 8.x (`classify_augmentations`):
- When `auto_augment` is set, the HSV colour jitter is **disabled**.
- Torchvision **RandAugment** is used instead. Its ops include Color (saturation), Brightness, Contrast,
  Posterize, **Solarize**, Equalize and AutoContrast.
- Several of these change the apparent colour. Solarize, for example, inverts bright pixels, so white
  becomes dark.

## 3. Results (valid split, 1,482 images)

| row | epoch | top-1 | top-5 | val loss |
|---|---|---|---|---|
| **best (fitness = mean of top-1 and top-5), shipped** | 29 | **0.864** | 0.988 | 0.639 |
| final | 50 | 0.855 | 0.988 | 0.775 |
| lowest val loss | 8 | n/a | n/a | 0.494 |

- The quoted "86 % top-1" is the best row.
- Train loss fell from 1.40 to 0.024 while val loss rose from its epoch-8 minimum (0.494) to 0.775. The
  model **overfits strongly after about epoch 10**, though top-1 stays flat at 0.85 to 0.86.

**Normalized confusion matrix** (`project/runs/classify/vehicle_color_detection/run_1/confusion_matrix_normalized.png`).
Read down each "True" column:

| class | correct | main confusion |
|---|---|---|
| blue | 0.98 | |
| purple | 0.97 | |
| red | 0.96 | |
| yellow | 0.95 | |
| green | 0.93 | |
| white | 0.93 | |
| pink | 0.91 | |
| orange | 0.90 | |
| brown | 0.88 | |
| black | 0.85 | |
| silver | 0.85 | |
| grey | 0.71 | 0.15 called silver, 0.07 black |
| gold | 0.70 | 0.11 called beige, 0.11 brown |
| beige | 0.64 | 0.20 called tan |
| **tan** | **0.51** | **0.38 called beige** |

The neutral and earth tones (beige/tan/gold/brown and grey/silver/black) are the weak region. Some of
these are label-definition problems: beige vs tan is subjective.

Plots included: `confusion_matrix.png`, `confusion_matrix_normalized.png`, `results.png`. No test-split
evaluation was run.

## 4. Inference

```python
from ultralytics import YOLO
m = YOLO("project/runs/classify/vehicle_color_detection/run_1/weights/best.pt")
r = m.predict(vehicle_crop_bgr, imgsz=640)[0]
colour = r.names[r.probs.top1]; conf = float(r.probs.top1conf); top5 = r.probs.top5
```
- **Preprocessing (Ultralytics `classify_transforms`):** resize the shorter side to 640, centre-crop
  640x640, `ToTensor` (RGB, divided by 255), Normalize with mean (0,0,0) and std (1,1,1), so in practice
  only the /255 applies. A centre-crop cuts the sides of wide vehicle crops, so pad to square first if the
  car is long.
- **Postprocessing:** softmax over 15 classes, then top-1 and top-5. ONNX output is `(1, 15)` probabilities.
- **Training/serving mismatch to fix.** The training images were **auto-contrast stretched by Roboflow**.
  Apply the same stretch to live crops, e.g. per-channel 0.5 to 99.5 percentile stretch, or train without it.
- **Platform status: NOT integrated.**
  - The ANPR worker (`../anpr-licence-plate/project/worker.py`, `dominant_colour()` at about line 1870)
    names vehicle colour with a hand-written heuristic, not this model.
  - Its `CONTEXT.md` lists "vehicle colour/make classifier on the vehicle box" as future work.
  - The console's vehicle-colour fields are ANPR sample data.

## 5. Known weaknesses

- **Colour-destroying augmentation.** Roboflow brightness ±20 % plus RandAugment (Solarize, Posterize,
  Color) work against a colour task. That is part of why grey/silver/white and beige/tan blur together.
- **Lighting and IR.** At night, cameras switch to IR monochrome and colour is physically unavailable. The
  model will still answer with confidence. Sodium-vapour or LED street lighting shifts hue. White balance
  varies by camera.
- **Data source.** The images are probably web or stock photos of whole cars, not CCTV crops. Domain gap
  in angle, compression and motion blur.
- Overfitting after about epoch 10. Only 15,561 train images, and they are 3x augmented copies (about
  5.2k unique).
- 640 px input is wasteful: colour does not need 640.

## 6. Improvement ideas (embedded)

1. **Retrain with colour-safe augmentation.** Example:
   `YOLO("yolo11n-cls.pt").train(data=…, imgsz=224, epochs=60, auto_augment=None, hsv_h=0.0, hsv_s=0.2, hsv_v=0.3, erasing=0.1, fliplr=0.5)`.
   Re-export the dataset from Roboflow **without** brightness augmentation and auto-contrast.
2. **Downsize to 224 (or 160).** About 12x fewer FLOPs than 640, and colour accuracy is usually unchanged.
3. **Gate by illumination.** If the frame is IR or grey-scale (low channel variance), output `unknown`
   instead of a colour.
4. **Merge confusable classes** if the business allows it (`beige+tan`, `grey+silver`), or report top-2.
5. **Vote per track.** Average softmax over 5 to 10 crops of the same vehicle track and pick the argmax.
   This cuts flicker a lot. See `../../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md` for the
   detect / decide / alert split.
6. **Export:**
   - `yolo export model=best.pt format=onnx imgsz=224` (export at the size you serve)
   - `format=engine half=True imgsz=224`
   - `int8=True data="C:/projects/vehicle color/Color Vehicle.v1i.folder"`
   - Batch all vehicle crops of a frame into one call.
7. **Build a CCTV test set.** 50 crops per colour from your own cameras, day and night, then report
   per-class recall.

## 7. Files in this folder

| shipped | path |
|---|---|
| weights (3.2 MB, sha256 prefix `818b0a856e245d8f`) | `project/runs/classify/vehicle_color_detection/run_1/weights/best.pt` |
| run | `project/runs/classify/vehicle_color_detection/run_1/{args.yaml,results.csv}` + 3 PNGs |
| metadata / script | `project/Color Vehicle.v1i.folder/README.roboflow.txt`, `project/train.py`, `project/requirements.txt` |

**Not shipped** (all under `C:\projects\vehicle color\`):
- `run_1/weights/last.pt`
- `yolo11n-cls.pt` and `yolo26n.pt`
- the image folders and `*.cache`
- `venv/`

The bundle path to `best.pt` exceeds 260 characters under a deep temp folder. Extract to a short root or
use `\\?\` paths on Windows.
