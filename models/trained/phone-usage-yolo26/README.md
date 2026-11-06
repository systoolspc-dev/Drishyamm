# Phone-usage detector (YOLO26 nano + medium)

Two runs on the same data. The **nano** run (`phone_yolo26`) is the model the activity monitor uses today.

## 1. What it detects

| id | class | train inst. | val inst. | test inst. |
|---|---|---|---|---|
| 0 | using phone | 27,995 | 8,081 | 3,983 |

- Images: train 8,892, val 2,541, test 1,270 (12,703 total), about 3.1 boxes per image.
- Only **74 / 18 / 8** images are empty (background), i.e. under 1 %.
- Box size (val labels): median **4.9 % x 7.4 %** of the frame, 10th percentile 2.1 % x 4.0 %.
  - On the 2048x1152 source frames that is about 100x85 px.
  - After letterboxing to 640 it is about **31x27 px**, and the small ones are about 13x15 px.
  - The box is the phone or hand-and-phone region, not the whole person.
- Source: an **Ultralytics Platform** dataset, "phone and no phone" (owner `vidit-ghai`), exported as
  NDJSON (`phone-and-no-phone.ndjson`). `converter.py` downloads the images from signed CDN URLs and writes
  YOLO labels plus `dataset/data.yaml`. `verify_dataset.py` checks image/label pairing, box ranges and
  empty counts. **No licence is stated in the export.**
- Image names (`frame_00041…`, `phone_holder_000319…`, `01_jpg…`) show it is built from video frames plus
  a few small collections.
- On disk: `C:\projects\phone-no_phn\phone-no_phn\dataset\{images,labels}\{train,val,test}`.

## 2. Architecture and training recipe

| item | nano: `phone_yolo26` | medium: `phone_yolo26-2` |
|---|---|---|
| base / yaml | `yolo26n.pt` / `yolo26n.yaml` | `yolo26m.pt` / `yolo26m.yaml` |
| params / GFLOPs at 640 | 2.50 M / 5.9 | 21.77 M / 75.0 |
| imgsz / batch / epochs | 640 / 8 / 50 (all ran; patience 50) | 640 / 8 / 50 (all ran) |
| optimizer | auto (lr0 0.01, lrf 0.01) | auto |
| augmentation | mosaic 1.0 (close 10), hsv 0.015/0.7/0.4, translate 0.1, scale 0.5, fliplr 0.5 | same |
| date / Ultralytics | 2026-07-02 / 8.4.84 | 2026-07-08 / 8.4.84 |

Both are end-to-end (NMS-free) YOLO26 heads. The script is `train.py` (defaults: medium, 50 epochs,
batch 8, test-split evaluation at the end).

## 3. Results (val split, 2,541 images)

| run / row | epoch | P | R | mAP50 | mAP50-95 |
|---|---|---|---|---|---|
| **nano** final = best (shipped, deployed) | 50 | 0.842 | 0.827 | 0.904 | 0.498 |
| **medium** final = best fitness (shipped) | 50 | 0.861 | 0.856 | 0.922 | 0.533 |
| medium best mAP50 | 49 | 0.858 | 0.861 | 0.923 | 0.532 |

- In both runs the best epoch is the last one, so **neither has converged**. 50 epochs is short.
- Loss, nano: train box 2.20 to 1.44. Val box 2.00 to 1.50, val cls 1.82 to 0.70.
- The medium model gains about 2 to 3 points of P, R and mAP over the nano.
- The low mAP50-95 relative to mAP50 shows loose localisation on small boxes.
- Plots in both run folders: confusion matrices, PR/P/R/F1 curves, `results.png`.
- The test-split evaluation plots (`runs/detect/val`, `val-2`) were not shipped. No test numbers were saved.

## 4. Inference and platform integration

```python
from ultralytics import YOLO
m = YOLO("project/runs/detect/runs/detect/phone_yolo26/weights/best.pt")
r = m.predict(frame, imgsz=1280, conf=0.50)[0]     # what the activity monitor does on GPU
phone_boxes = r.boxes.xyxy.tolist()
```
- **Preprocessing:** letterbox to `imgsz`, RGB, divide by 255.
- **Postprocessing:** end-to-end output `(1, 300, 6)`. No NMS; score filter only.

**Platform status: INTEGRATED, in the activity monitor (local stack).**
- `smart-cam-ai/app/activity-monitor/models/phone.pt` (5,352,325 bytes) is **byte-identical to the nano
  run's `best.pt`** (sha256 prefix `776732010699cda7` on both).
- `config/config.yaml` (GPU/edge): `detectors[phones]`, `weights: models/phone.pt`, **`conf: 0.50`**
  (raised from 0.35 to cut hand-near-face false positives), **`imgsz: 1280`**.
- `config/config.docker.yaml`: `device: cpu`, **`imgsz: 640`**, `conf: 0.50`.
- The phone boxes feed `activity.py`. A person is `on_phone` only when:
  - a phone box is at least 30 % inside the person box (`phone_overlap 0.30`), **and**
  - it lies within 1.3 shoulder-widths of a wrist or head keypoint from `yolov8s-pose.pt`
    (`phone_require_hand: true`, `phone_hand_radius: 1.3`).
- Sessions close after 3 s unseen (`session_gap_sec`).
- Deployment: the `activity-monitor` service in `docker-compose.drisyam-original.yml` (image
  `drisyam/activity-monitor`, port 8010, weights baked into the image).
- The console's "Activity Monitoring" feature is still `demo: true` (sample data) in
  `smart-cam-backend/src/utils/featureCatalog.js`, so customers do not see this model's output by default.
- The activity-monitor README already notes: "Phone model is close-range (`yolo26n`); misses small/distant
  phones — retrain at `s` scale on CCTV data".

## 5. Known weaknesses

- **Trained at 640, served at 1280** on GPU. Upscaling inference helps small phones but moves the object
  scale away from training. Validate at 1280 to see the real effect:
  `yolo detect val model=… imgsz=1280 data=dataset/data.yaml`.
- **Very few negatives (under 1 %).** The model has rarely seen hands near faces without a phone, remotes,
  wallets, cups or ID cards. Hence the conf 0.50 and the pose-gate workaround.
- **Probable split leakage, filename evidence only.** 1,766 of 1,894 unique val stems and 1,008 of 1,093
  test stems also exist in train. Frames of the same videos are spread across splits, so 0.90 mAP50 is
  optimistic.
- Small objects. The label class is "using phone", which mixes the phone object with the act of using it.
  Phones lying on a desk are ambiguous.
- Night and IR coverage unknown. Not converged after 50 epochs.

## 6. Improvement ideas (embedded)

1. **Swap to a distilled small model.** Train `yolo26s` at 960 to 1280 with the medium run as teacher:
   `YOLO("yolo26s.pt").train(data="dataset/data.yaml", imgsz=1280, epochs=100, distill_model="project/runs/detect/runs/detect/phone_yolo26-2/weights/best.pt")`.
   Then serve at the same imgsz you trained.
2. **Hard negatives from your own office cameras.** Add frames of people at desks with no phone, hands at
   the face, cups, mice and remotes, as empty labels. Target 10 to 20 % background.
3. **Crop-based second stage.** Run the phone detector only inside person crops from the pose model, e.g.
   the upper-body crop resized to 320. This raises effective resolution without a full 1280 frame.
4. **Export for the edge box:**
   - `yolo export model=best.pt format=engine imgsz=1280 half=True`
   - INT8 with `int8=True data=dataset/data.yaml`
   - `format=openvino imgsz=640` for the CPU docker path (`activity-monitor/scripts/export_model.py`
     already wraps `YOLO(weights).export(format=…, half=…, imgsz=…)`).
5. **Temporal confirmation is already partly done** (session gap and pose gate). Add K-of-N within the
   person track before opening a session, e.g. 3 of 5 frames, so one stray box cannot start a phone
   session. See `../../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`.
6. **Re-split by source video,** then run the test-split evaluation and keep the numbers.

## 7. Files in this folder

| shipped | path |
|---|---|
| nano weights (5.35 MB, sha256 prefix `776732010699cda7`, = activity-monitor `phone.pt`) | `project/runs/detect/runs/detect/phone_yolo26/weights/best.pt` |
| medium weights (44.0 MB, sha256 prefix `b72e4087fb195a22`) | `project/runs/detect/runs/detect/phone_yolo26-2/weights/best.pt` |
| runs | `args.yaml`, `results.csv` and 7 PNGs for each run |
| tools | `project/train.py`, `project/converter.py`, `project/verify_dataset.py`, `project/dataset/data.yaml` |

**Not shipped** (all under `C:\projects\phone-no_phn\phone-no_phn\`):
- `last.pt` of both runs
- `runs/detect/runs/detect/phone_yolo26.zip`
- `runs/detect/val`, `val-2`
- `yolo26n.pt` and `yolo26m.pt`
- the 12,703 images and labels
- `phone-and-no-phone.ndjson`: it holds time-limited signed CDN URLs and is deliberately left out
- `scratchpad_download.log`
- `venv/`
