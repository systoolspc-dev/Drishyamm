# Weapon detector (folder name says "yolov12l", the model is YOLO26-L)

The folder and run are named `weapon_detection_v12l`. The final run's checkpoint is not YOLOv12. Its
`train_args.model` is `yolo26l.pt` and its `model.yaml` is `yolo26l.yaml` (end-to-end, NMS-free head).
Only the first attempt (`weapon_detection_v12l`, no suffix) used `yolo12l.pt`, at 1280 px and batch 32.
That attempt never finished an epoch: it has no `results.csv` and an empty `weights/`. `train.py` still
has the comment "Load the YOLOv12l model", but the line below it loads `yolo26l.pt`.

## 1. What it detects

| id | class | train inst. | val inst. | test inst. |
|---|---|---|---|---|
| 0 | Gun | 3,279 | 1,383 | 649 |
| 1 | Knife | 2,115 | 891 | 389 |
| 2 | Non Weapon | 5,408 | 1,538 | 949 |

- The instance counts come from the label `.txt` files. No image was opened.
- Split sizes: train 7,970, valid 2,989, test 1,495 images (12,456 total, matching `README.dataset.txt`).
- `Non Weapon` is a labelled class, not background. It holds look-alike objects (pens, phones and so on)
  that the model has to box and name. Only 1 train image is an empty (pure-background) label file.
- Source: Roboflow Universe `vidit-ghai-7vysa/non-weapon-433gb-imhwd` v1, exported 2026-06-16.
  "Pistol-Knife-non-weapon", no Roboflow augmentation. **Licence: CC BY 4.0** (attribution required).
- Dataset on disk: `C:\projects\weapon\weapon detection final boss\weapon detection final boss\dataset\`
  (`data.yaml`, `train|valid|test/images|labels`).

## 2. Architecture and training recipe (from `args.yaml` and the checkpoint)

| item | value |
|---|---|
| architecture | YOLO26-L (`yolo26l.yaml`, scale `l`, `end2end: True`, `reg_max: 1`), strides 8/16/32 |
| parameters | 26.18 M (counted from the checkpoint EMA) |
| GFLOPs | 93.5 at 640 (unfused, as Ultralytics `get_flops` reports it). Trained at **960**, so about 2.25x that per frame (~210 GFLOPs) |
| base checkpoint | `yolo26l.pt` (COCO-pretrained), `pretrained: true` |
| imgsz / batch / epochs | **960** / 16 / 100 planned. Ran **47** epochs, then stopped (see below) |
| optimizer | `auto` (lr0 0.01, lrf 0.01, momentum 0.937, wd 0.0005, warmup 3 epochs, no cosine) |
| patience | 20 |
| augmentation | mosaic 1.0 (off for the last 10 epochs), mixup 0, copy_paste 0, hsv h/s/v 0.015/0.7/0.4, translate 0.1, scale 0.5, fliplr 0.5, flipud 0, degrees/shear/perspective 0 |
| other | `dropout: 0.3` has no effect on a detect model (it only affects classify heads). `workers: 0` (Windows dataloader workaround), AMP on, seed 0, deterministic |
| Ultralytics version | 8.4.75. Checkpoint date 2026-06-22 17:27 |

**The run was stopped by hand at epoch 47 of 100.** In the shipped `best.pt`, `epoch` is 46 (0-based) and
the optimizer state is still inside, which is why the file is 158 MB. A run that finishes normally saves a
stripped file of about 53 MB. `best.pt` and `last.pt` are byte-identical in size, so the last epoch was
also the best one. Nothing shows the model had converged.

## 3. Results (validation split, 2,989 images)

| row | epoch | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|---|
| final epoch (= best mAP50-95 / fitness) | 47 | 0.942 | 0.900 | 0.950 | 0.786 |
| best mAP50 | 44 | 0.937 | 0.906 | 0.950 | 0.765 |

- Shipped weights = epoch 47. The figures quoted elsewhere (P 94 %, R 90 %, mAP50 0.950) are this row.
- Loss trend, epochs 1 to 47: train box 1.14 to 0.75, cls 2.95 to 0.53. Val box 1.53 to 0.76, val cls 1.59
  to 0.43. All were still falling.
- Earlier aborted runs: `-2` (2 epochs, mAP50 0.728) and `-3` (4 epochs, mAP50 0.684 at the last epoch).
  Their `results.csv` files are included for reference.
- **No result PNGs are included.** An interrupted run never writes the final confusion matrix or PR curves.
  The 1,495-image test split has **never been evaluated**.

## 4. Inference pipeline

```bash
yolo detect predict model=project/runs/detect/runs/weapon_detection_v12l-4/weights/best.pt \
     source=clip.mp4 imgsz=960 conf=0.25
```
```python
from ultralytics import YOLO
m = YOLO("project/runs/detect/runs/weapon_detection_v12l-4/weights/best.pt")
for r in m.predict("rtsp://...", imgsz=960, conf=0.25, stream=True):
    r.boxes.xyxy, r.boxes.conf, r.boxes.cls   # cls 0=Gun 1=Knife 2=Non Weapon
```
- **Preprocessing:** letterbox to 960 (keeps aspect ratio, pads with grey 114). The PyTorch path pads only
  to a stride multiple. An exported static engine pads to the full 960x960 square. Then BGR to RGB, HWC to
  CHW, divide by 255, FP16 or FP32.
- **Postprocessing:** YOLO26 is end-to-end. The one-to-one head returns up to `max_det` = 300 candidates,
  each `[x1, y1, x2, y2, score, cls]`, and **no NMS is needed**, so `iou` is irrelevant. Keep rows with
  score >= `conf` (predict default 0.25). In an exported ONNX/TRT model the output tensor is `(1, 300, 6)`.
  Check this against your export's output signature.
- At inference, drop class 2 (`Non Weapon`) or use it as a negative. Alert only on Gun or Knife.
- **Platform status: NOT integrated.**
  - `smart-cam-ai/app/weapon_detection/` is an empty stub folder.
  - In `smart-cam-backend/src/utils/featureCatalog.js` the console "Weapon Detection" feature is
    `demo: true`, which means sample data and off unless an admin switches it on.
  - The backend already has the event vocabulary (`weapon.detected` in `reportPdf/vocabulary.js`) and the
    alert category mapping (`alertEngine.js`, `alertEmail.controller.js`). A real producer only has to post
    `weapon.*` events.
  - Today the model runs only on the training box (RTX PRO 5000 Blackwell).

## 5. Known weaknesses

- **Probable train/val leakage, not verified.**
  - Checked by filename only: 761 of 2,751 unique valid source stems (the text before `.rf.`) also appear
    in train. 17 frame-sequence prefixes such as `20220603...` occur in both splits.
  - None of them are byte-identical, so they could be filename collisions or near-duplicate frames from the
    same clip.
  - Treat 0.95 mAP50 as optimistic until the model is re-scored on footage from a different source.
- Most of the data is close-up web and product imagery (for example `0-7mm-Foska-Cheap-Ball-Pen...`), not
  overhead CCTV. Small, distant or partly hidden handguns at 2 to 6 m camera height are under-represented.
- Night and IR (grey-scale) frames are not identifiable in the data. Expect a drop in performance on IR.
- Never validated on a held-out split, and stopped before convergence.
- Large model: 26 M parameters at 960 px is too heavy for edge boxes.

## 6. Improvement ideas (embedded)

1. **Finish or redo training.** Resume works because the optimizer state is still in the file:
   `YOLO("…/last.pt").train(resume=True)`. Then run
   `yolo detect val model=best.pt data=dataset/data.yaml split=test imgsz=960`.
2. **Export:**
   - `yolo export model=best.pt format=onnx imgsz=960 simplify=True`
   - `yolo export model=best.pt format=engine imgsz=960 half=True`
   - INT8 needs calibration images: `yolo export model=best.pt format=engine imgsz=960 int8=True data=dataset/data.yaml`.
     On Ultralytics 8.4.1xx you can also write `quantize=8` (it replaces half/int8).
   - Build the engine on the target GPU or Jetson.
3. **Resolution trade-off:** 960 roughly doubles the cost of 640 but is what keeps small pistols visible.
   For edge, use 640 with ROI crops (door or counter zones) rather than a full-frame 960.
4. **Distil to a small model.** The installed Ultralytics (8.4.137) has built-in distillation:
   `YOLO("yolo26s.pt").train(data=…, imgsz=960, distill_model="…/weapon_detection_v12l-4/weights/best.pt")`
   (loss weight `dis`, default 6.0). Then compare s and n against this L model on the same test split.
5. **Hard-negative mining.** Run on hours of your own site footage with no weapons. Add every false
   positive (umbrellas, phones, staplers, black wallets, tools) as unlabelled background images. Today only
   1 train image is background.
6. **Temporal confirmation.** A per-frame score must not raise an alert. Track the boxes (ByteTrack), then
   require K-of-N, for example 4 of 6 consecutive frames at >= 0.5. Alert once per track transition. See
   `../../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`. Pair the alert with a person box: a "gun" with no
   person nearby should be suppressed.
7. **Dataset fixes.**
   - Re-split by source video or clip, not by frame.
   - Add CCTV-angle, low-light and IR samples.
   - Report recall per class (Gun and Knife separately), not just the averaged P/R.

## 7. Files in this folder

| shipped | path (bundle-relative) |
|---|---|
| final weights (unstripped, 158 MB, sha256 prefix `8ee5a4c9c638edb5`) | `project/runs/detect/runs/weapon_detection_v12l-4/weights/best.pt` |
| run configs / curves | `project/runs/detect/runs/weapon_detection_v12l{,-2,-3,-4}/args.yaml`, `results.csv` (-2/-3/-4) |
| scripts | `project/train.py` (the run used here), `project/train_yolo26x.py` (planned YOLO26-X at 1280, never run), `project/requirements.txt` |

**Not shipped** (all under `C:\projects\weapon\weapon detection final boss\weapon detection final boss\`):
- `last.pt` for runs -2, -3 and -4 (each about 158 MB)
- `best.pt` for -2 and -3
- the base checkpoints `yolo12l.pt`, `yolo26l.pt` and `yolo26n.pt`
- the `dataset/` folder (12,456 images)
- `labels.jpg` and `train_batch*.jpg`
- `venv/`
