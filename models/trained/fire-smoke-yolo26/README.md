# Fire and smoke detector (YOLO26-M, 960 px)

## 1. What it detects

| id | class | train inst. | val inst. | test inst. |
|---|---|---|---|---|
| 0 | fire | 90,837 | 24,201 | 408 |
| 1 | smoke | 33,600 | 11,091 | 9,346 |

- The counts come from the label files only.
- Split sizes: train 45,473, valid 12,992, test 6,496 images (64,961 total).
- Background images (empty labels): 2,416 in train (5.3 %), 20 in valid, 10 in test.
- **The test split has a different distribution:** 96 % of its instances are smoke, and its filenames
  (`bothFireAndSmoke_CV…`) come from a different source than train and val. It has never been evaluated.
- Source: Roboflow Universe `chirag-sharma-ksqai/fire-and-smoke-industrial-jm4v6`, exported 2026-06-19.
  No preprocessing or augmentation. **Licence: CC BY 4.0.**
- Dataset on disk: `C:\projects\Fire and Smoke Industrial.yolo26\` (`data.yaml`, `train|valid|test`).

## 2. Architecture and training recipe

| item | value |
|---|---|
| architecture | YOLO26-M (`yolo26m.yaml`, end2end NMS-free head, reg_max 1) |
| parameters / GFLOPs | 21.78 M / 75.0 at 640 (unfused). Trained at **960**, so about 169 GFLOPs per frame |
| base | `yolo26m.pt` COCO-pretrained |
| imgsz / batch / epochs | **960** / 32 / 100 planned. **80 ran**, then the run was stopped |
| optimizer | auto (lr0 0.01, lrf 0.01, mom 0.937, wd 5e-4, warmup 3), patience 20 |
| augmentation | mosaic 1.0 (close 10), hsv 0.015/0.7/0.4, translate 0.1, scale 0.5, fliplr 0.5, no mixup or copy-paste. `dropout 0.3` has no effect on detection |
| wall time | 129,421 s (about 36 h) for 80 epochs on the RTX PRO 5000 |
| Ultralytics | 8.4.75, checkpoint 2026-06-26 05:17 |

- The shipped `best.pt` still holds its optimizer state (`epoch` = 79, 131 MB), and `best.pt == last.pt`.
  So the run was **interrupted at epoch 80 while it was still improving**; it was not early-stopped.
- Runs `fire_and_smoke_detection` and `-2` (batch 16) have no weights. `-4` also has no weights.
- `-3` (batch 16) ran 17 epochs. Its 131 MB `best.pt` was not shipped, and its `last.pt` is a 0-byte
  file, a sign of a crash during save.

## 3. Results (validation, 12,992 images)

| row | epoch | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|---|
| final = best (fitness) = best mAP50, shipped | 80 | 0.846 | 0.778 | 0.847 | 0.580 |
| earlier run `-3` (for comparison) | 17 | 0.720 | 0.648 | 0.732 | 0.441 |

- These are the figures quoted elsewhere: precision 85 %, recall 78 %, mAP50 0.847.
- Loss trend, epochs 1 to 80: train box 1.55 to 1.01, cls 2.31 to 0.66. Val box 1.63 to 1.13, val cls 1.78
  to 0.80, still falling.
- **No PNG plots are included** because the interrupted run never wrote its final plots, and there is no
  per-class breakdown.
- Fire and smoke almost certainly differ a lot: smoke boxes are diffuse and their IoU with the labels is
  unstable. Measure it with `yolo detect val model=… data=data.yaml imgsz=960` (prints per-class AP).

## 4. Inference

```bash
yolo detect predict model=project/runs/detect/runs/fire_and_smoke_detection-5/weights/best.pt \
     source=rtsp://... imgsz=960 conf=0.25 stream=True
```
- **Preprocessing:** letterbox to 960 (grey 114 pad), BGR to RGB, CHW, divide by 255.
- **Postprocessing:** end-to-end output of up to 300 rows `[x1, y1, x2, y2, score, cls]` (cls 0 = fire,
  1 = smoke). No NMS; filter by score only. ONNX/TRT output is `(1, 300, 6)`.
- **Platform status: NOT integrated.** The console "Fire Detection" feature is `demo: true` (sample data)
  in `smart-cam-backend/src/utils/featureCatalog.js`. The backend has a `fire` alert-email category and
  report vocabulary, but no producer feeds it. The model runs only on the training box.

## 5. Known weaknesses

- **Probable clip-level leakage, not verified.**
  - Filenames are named after source videos, e.g. `-FORKLIFT-CATCHES-FIRE-…`,
    `Electrical-panel-short-circuit-accident`.
  - 39 video prefixes occur in both train and valid.
  - 7,347 of 10,934 unique valid source stems also appear in train, though none byte-identical.
  - Frames from the same YouTube clip on both sides of the split inflate val mAP. The 0.847 is an upper
    bound for unseen sites.
- **Typical fire and smoke false-positive sources** are not represented as background:
  - sunsets, orange or red signage, vehicle tail-lights
  - welding sparks, steam, fog, dust, headlight glare, flickering IR at night
- **Smoke at night under IR** is close to invisible, and there are no explicit IR samples.
- Never converged (stopped at 80/100). The odd test split was never scored.
- Heavy: about 169 GFLOPs per frame at 960.

## 6. Improvement ideas (embedded)

1. **Evaluate honestly first.** Run on the test split and on 1 to 2 hours of your own site footage with
   known events. Report fire recall and smoke recall separately.
2. **Export:**
   - `yolo export model=best.pt format=engine imgsz=960 half=True`
   - INT8: `yolo export model=best.pt format=engine imgsz=960 int8=True data=data.yaml fraction=0.1` (a
     small calibration subset is enough)
   - `format=onnx imgsz=640 simplify=True` for CPU or OpenVINO testing
3. **Resolution.** Fire is usually large enough at 640. Smoke plumes are large but faint. Try a 640 student
   first: it costs 0.44x the compute of 960.
4. **Distil** to `yolo26s`/`yolo26n` with `distill_model=<this best.pt>` (Ultralytics 8.4.137 built-in).
   Compare on the same honest test set.
5. **Hard negatives.** Mine false positives from your own non-fire footage (night, rain, kitchens, welding
   bays) and add them as empty-label images. Aim for 10 to 20 % backgrounds rather than 5 %.
6. **Temporal logic matters more than mAP here.**
   - Fire flickers and smoke grows; glare does not.
   - Require K-of-N per tracked region, for example 8 of 12 frames over 2 s.
   - Optionally add a growth or motion check (box area increasing, frame-difference energy inside the box)
     before alerting.
   - Alert once per region transition. See `../../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`.
7. **Dataset fixes.** Re-split by source video prefix. Add IR and night clips. Rebalance smoke (currently
   about 1:2.7 vs fire in train).

## 7. Files in this folder

| shipped | path |
|---|---|
| final weights (unstripped, 131 MB, sha256 prefix `bca699265060d062`) | `project/runs/detect/runs/fire_and_smoke_detection-5/weights/best.pt` |
| run configs / curves | `args.yaml` for runs (none, -2, -3, -4, -5); `results.csv` for -3 and -5 |
| dataset metadata + script | `project/data.yaml`, `project/README.dataset.txt`, `project/README.roboflow.txt`, `project/train.py` |

**Not shipped** (all under `C:\projects\Fire and Smoke Industrial.yolo26\`):
- `-5/weights/last.pt` (same as best)
- `-3/weights/best.pt` (17-epoch run) and its 0-byte `last.pt`
- `yolo26m.pt` and `yolo26n.pt`
- the 64,961-image dataset
- `venv/`

The bundle path to `best.pt` is longer than 260 characters when unpacked under a deep temp folder. Extract
it to a short root (e.g. `C:\ai\`) or use `\\?\` long paths on Windows.
