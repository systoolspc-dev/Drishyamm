# Triple-rider detector (YOLO11n)

## 1. What it detects

| id | class | train inst. | val inst. | test inst. |
|---|---|---|---|---|
| 0 | Single-Double-Rider | 6,310 | 385 | 154 |
| 1 | Triple Rider | 2,570 | **13** | **6** |

- One box per two-wheeler-plus-riders. The class is the rider count.
- Counts come from the label files.
- Images: train 3,410 (5 empty), valid 64, test 32. Total 3,506.
- **Train is 5x Roboflow-augmented** (Gaussian blur 0 to 2 px), so there are 648 unique train source
  frames. That means roughly 514 unique Triple Rider instances behind the 2,570.
- Source: Roboflow `chirags-workspace-vwgbn/triple-rider-detection-el6cv` v1 (app.roboflow.com),
  exported 2026-10-09. **Licence: "Private"** per the export. Confirm the redistribution rights before
  shipping derived weights to customers.
- On disk: `C:\projects\Triple Rider Detection.v1i.yolov11\` (`data.yaml` with `path: .`, `train|valid|test`).

## 2. Architecture and training recipe

| item | value |
|---|---|
| architecture | YOLO11n, 2.59 M params, 6.5 GFLOPs at 640 |
| base | `yolo11n.pt` COCO-pretrained |
| imgsz / batch / epochs | 640 / 16 / 50 planned. Early-stopped at **35** (patience 10, best epoch 25) |
| optimizer | auto, which resolved to **AdamW, lr0 0.001667** (Ultralytics auto rule for small runs), lrf 0.01, no cosine |
| augmentation | mosaic 1.0 (close 10), hsv 0.015/0.7/0.4, translate 0.1, scale 0.5, fliplr 0.5, seed 42 |
| script | `train.py` (refuses to run without CUDA), `README_TRAINING.md` (setup plus test-split val command) |
| Ultralytics | 8.4.174, 2026-10-09 |

## 3. Results (valid split, 64 images)

| row | epoch | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|---|
| best (fitness), shipped | 25 | 0.721 | 0.834 | 0.806 | 0.606 |
| final | 35 | 0.708 | 0.734 | 0.732 | 0.535 |

- Losses: train box 1.17 to 0.73. Val box flat around 0.96 to 0.99. Val cls bottomed at epoch 17
  (0.687), was 0.711 at epoch 25 and 0.844 at epoch 35. The model is overfitting after about 20 to 25
  epochs.

**Normalized confusion matrix** (`project/runs/triple-rider-yolo11n/confusion_matrix_normalized.png`):

- **Triple Rider**: 0.54 predicted correctly. **0.46 predicted as Single-Double-Rider.**
- **Single-Double-Rider**: 0.86 correct, 0.13 predicted as Triple Rider, 0.01 missed.
- **Background false positives**: 86 % are labelled Single-Double, 14 % Triple.
- With **13 Triple Rider instances in val** (6 in test), one instance moves recall by about 8 points. The
  Triple Rider numbers are not statistically meaningful. The averaged mAP50 of 0.81 is dominated by the
  easy class.

PNG plots included: confusion matrices, PR/P/R/F1 curves, `results.png`.

## 4. Inference

```bash
yolo detect predict model=project/runs/triple-rider-yolo11n/weights/best.pt source=junction.mp4 imgsz=640 conf=0.25 iou=0.7
yolo detect val     model=project/runs/triple-rider-yolo11n/weights/best.pt data=<dataset>/data.yaml split=test
```
- **Preprocessing:** letterbox 640, RGB, divide by 255.
- **Postprocessing:** YOLO11 raw output `(1, 6, 8400)` followed by NMS (conf 0.25, iou 0.7, max_det 300).
  Use `nms=True` at export to bake NMS in.
- **Output:** one box per vehicle-with-riders, class 0 or 1.
- **Platform status: NOT integrated.** There are no references in `smart-cam-ai/` or the backend. It would
  sit next to the ANPR pipeline (`../anpr-licence-plate`), which already tracks vehicles and could attach a
  rider-count verdict to a plate read.

## 5. Known weaknesses

- **Severe imbalance and a tiny eval set:** 13 val and 6 test positives.
- **Confusion is the main failure.** Nearly half of the triples are called single or double. The classes
  differ only by one partly occluded person.
- **Clip leakage, filename evidence.** All three splits share frames from the same videos
  (`00000000188000000_mp4-*`, `video_20240825_112943`, …). 9 val and 4 test source stems also occur in train.
- Night, rain and IR are not represented as far as filenames show. The box covers the whole rider group,
  so occlusion by other vehicles at a busy junction is a problem.
- Early-stopped after only 35 epochs on a small set.

## 6. Improvement ideas (embedded)

1. **Re-split by video** and build a test set with at least 150 to 200 triple-rider instances from cameras
   not used in training.
2. **Alternative formulation, often more robust:** detect `motorcycle` (COCO class 3) plus `person` (COCO
   class 0) with a stock model, assign persons to a bike by overlap or keypoints, and count them. Then use
   this model only as a second opinion, or train a crop classifier (`1 / 2 / 3+ riders`) on the motorcycle
   crop.
3. **Class rebalancing.** Oversample Triple Rider (copy-paste augmentation of rider groups, or repeated
   triple images). Collect more real triples. Consider `cls_pw` (class-weighting power, present in the
   8.4.1xx args) if your Ultralytics version uses it.
4. **Export:**
   - `yolo export model=best.pt format=onnx imgsz=640 nms=True`
   - `format=engine half=True`
   - `format=engine int8=True data=data.yaml`
   - A nano model at 640 runs comfortably on edge.
5. **Temporal confirmation.** Vote the class over the vehicle track, e.g. Triple in at least 60 % of frames
   across 1 s and at least 5 frames, before raising a violation. Alert once per vehicle track or plate. See
   `../../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`.

## 7. Files in this folder

| shipped | path |
|---|---|
| weights (5.4 MB, sha256 prefix `f8deb1d33fb7f227`) | `project/runs/triple-rider-yolo11n/weights/best.pt` |
| run | `project/runs/triple-rider-yolo11n/{args.yaml,results.csv}` + 7 PNGs |
| config / docs | `project/data.yaml`, `project/README.roboflow.txt`, `project/README_TRAINING.md`, `project/requirements.txt`, `project/train.py` |

**Not shipped** (all under `C:\projects\Triple Rider Detection.v1i.yolov11\`):
- `runs/triple-rider-yolo11n/weights/last.pt`
- `yolo11n.pt` and the `weights/` folder
- the dataset images and labels
- `venv/`
