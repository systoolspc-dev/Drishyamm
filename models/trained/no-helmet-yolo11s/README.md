# No-helmet detector (YOLO11s): the P = R = 1.0 result is NOT real-world accuracy

**Read this first.** The final metrics (precision 1.000, recall 1.000, mAP50 0.995, mAP50-95 0.994) come
from a validation set that cannot measure generalisation. The model saw one or two riders filmed in two
clips, and it was validated on the very next frames of the same clips. Treat it as **unvalidated** until it
is scored on footage from another camera.

## 1. What it detects

| id | class |
|---|---|
| 0 | No Helmet |

- Source: Roboflow `work-account-s-workspace/no-helmet-pluth-2bumn` v1 (a private app.roboflow.com URL),
  exported 2026-10-09. **Licence: CC BY 4.0** per the export.
- 5,000 images = **1,000 source video frames x 5 Roboflow augmentations** (brightness ±25 %, blur up to
  3.2 px, 1.41 % salt-and-pepper). All 5,000 were exported into `train/`; `valid/` and `test/` are empty.
- `train_yolo11s.py` builds its own split, written to `splits/train.txt`, `splits/val.txt` and
  `splits/data_split.yaml`:
  - all 5 augmented copies of a frame stay in the same split
  - val = the last 15 % of frames of each video
  - result: 4,250 train / 750 val images
- On disk: `C:\projects\No Helmet.v1i.yolov11\train\{images,labels}`.

### What the split and labels actually contain (from filenames and label text; no image opened)

| fact | value |
|---|---|
| source videos | **2** (`vid2`, `vid3`) |
| vid2 frames | train 1000 to 1279, val **1280** to 1329 |
| vid3 frames | train 1330 to 1899, val **1900** to 1999 |
| frame step | **1**: every consecutive frame was labelled |
| gap between last train frame and first val frame | **1 frame** (about 40 ms at 25 fps) |
| boxes per image | exactly **1** in every image (no empty images, no multi-person frames) |
| median box size | **47 % of image width x 94 % of image height** (one large subject filling the frame) |

So the "held-out" frames are visually almost identical to the last training frames. Every image holds
exactly one big positive box, and there are **zero negatives**: no helmeted riders, no empty roads.

- The script avoids exact-duplicate leakage, since the 5 augmentations of a frame never straddle the split.
- It cannot avoid scene and identity leakage: same rider, same background, same camera.
- That is why validation hit mAP50 0.995 by epoch 6.

## 2. Architecture and training recipe

| item | value |
|---|---|
| architecture | YOLO11s (`yolo11s.yaml`), 9.43 M params, 21.7 GFLOPs at 640. Trained at **960**, about 49 GFLOPs |
| base | `yolo11s.pt` COCO-pretrained |
| imgsz / batch / epochs | 960 / 32 / 100 planned. Early-stopped at **65** (patience 30, best epoch 35) |
| optimizer | auto, which resolved to **AdamW, lr0 0.002**, cosine LR (`cos_lr: true`), lrf 0.01 |
| augmentation | mosaic 1.0 (close 10), hsv 0.015/0.7/0.4, translate 0.1, scale 0.5, fliplr 0.5, flipud 0, `cache: true` (RAM) |
| Ultralytics | 8.4.174, 2026-10-09 |

The first run, `yolo11s_no_helmet`, ran 1 epoch: mAP about 0, val losses 4.7/7.8/7.1. It was abandoned,
and its 76 MB unstripped weights were not shipped.

## 3. Results (750 "val" frames)

| row | epoch | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|---|
| final | 65 | 1.000 | 1.000 | 0.995 | 0.994 |
| best (fitness), shipped | 35 | 1.000 | 1.000 | 0.995 | 0.995 |
| first epoch reaching mAP50 0.995 | 6 | 0.995 | 1.000 | 0.995 | 0.964 |

- Val box loss fell from 1.36 to 0.09.
- Plots included in `project/runs/yolo11s_no_helmet-2/`: confusion matrices, PR/P/R/F1 curves, `results.png`.
- The confusion matrix is trivially perfect.

## 4. Inference

```bash
yolo detect predict model=project/runs/yolo11s_no_helmet-2/weights/best.pt source=clip.mp4 imgsz=960 conf=0.25 iou=0.7
```
- **Preprocessing:** letterbox 960, RGB, divide by 255.
- **Postprocessing:** YOLO11 head output `(1, 5, N)` (4 box + 1 class) followed by NMS (iou 0.7, conf 0.25).
  Pass `nms=True` at export to fuse NMS into ONNX/TRT.
- **Expected behaviour on real CCTV:** it will probably fire on **any** large person or rider, helmet or
  not. It has never seen a negative.
- **Platform status: NOT integrated.** There are no references in `smart-cam-ai/` or `smart-cam-backend/src`.

## 5. Known weaknesses

- **Leakage and trivial validation**, as described above. The 1.0 metrics are not evidence.
- No negatives, so the false-positive rate is unknown and probably high.
- One label per image, always large. Small, distant riders at a junction camera will not be detected.
- The training subject and clothing are unknown, so bias toward that look is likely.
- Roboflow blur and noise augmentation were added on top of Ultralytics augmentation, and this is the only
  diversity the model got.

## 6. Improvement ideas (embedded)

1. **Build a real test set before anything else.** 300 to 500 frames from 3 or more other cameras, with
   both helmeted and bare-headed riders and empty scenes. Score with
   `yolo detect val model=best.pt data=<new yaml> imgsz=960`.
2. **Change the label design to two classes, `helmet` and `no_helmet`, boxed on the head.** Today the box
   is the whole subject (94 % of frame height). Head boxes force the model to look at the head.
   - Better still, use a rider or motorcycle detector, then a head-crop classifier (YOLO11n-cls at 128 px)
     for helmet / no helmet.
3. **Split by video**, not by frame tail. Hold out whole clips or whole cameras.
4. **Add hard negatives:** helmeted riders, caps, turbans, hoods, dark hair at night.
5. **Model size.** After the data fix, an `n` model at 640 with head crops is enough for edge use.
   - `yolo export model=best.pt format=engine half=True imgsz=640`
   - `int8=True data=<yaml>` for Jetson
6. **Temporal confirmation per rider track** (K-of-N, e.g. 6 of 10 frames with the head visible), then one
   alert per track. See `../../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`.

## 7. Files in this folder

| shipped | path |
|---|---|
| weights (19.2 MB, sha256 prefix `78d20008f1b2f2d6`) | `project/runs/yolo11s_no_helmet-2/weights/best.pt` |
| run | `project/runs/yolo11s_no_helmet-2/{args.yaml,results.csv}` + 7 PNGs; `project/runs/yolo11s_no_helmet/{args.yaml,results.csv}` (aborted 1-epoch run) |
| split + config | `project/splits/{train.txt,val.txt,data_split.yaml}`, `project/data.yaml`, `project/README.roboflow.txt` |
| script | `project/train_yolo11s.py` |

- The split lists contain absolute `C:/projects/No Helmet.v1i.yolov11/...` paths, so rewrite them if you
  move the dataset.

**Not shipped** (all under `C:\projects\No Helmet.v1i.yolov11\`):
- `-2/weights/last.pt`
- `yolo11s_no_helmet/weights/*.pt` (76 MB)
- `runs/detect/val/` (plots of the post-train validation)
- `yolo11s.pt` and `weights/yolo26n.pt`
- the 5,000 images
- `venv/`
