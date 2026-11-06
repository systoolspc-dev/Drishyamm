> In this repository: each folder keeps the original `project/` layout (code, configs, result plots, the chosen weights). De-duplicated: the phone nano run is `ai/activity-monitor/models/phone.pt` (byte-identical, not copied here) and the fight model ships only as `videomae-best-3class/model.safetensors`. Added: `person-yolov8m-legacy/` (the old human-detection demo's model). Overview of all models, live and trained: `../README.md`.

# In-house trained models (from C:\projects and Downloads)

These are models trained outside the drisyam repo. **None of them runs in the Drishyam platform today**, except
the phone detector, which the activity monitor uses (`04-activity-monitor/code/activity-monitor/models/phone.pt` is
byte-identical to the nano run in `phone-usage-yolo26/`). Each folder has `project/` (code, configs, results plots and
the chosen weights at their original relative path) and a `README.md` study guide.

Metrics come from each run's own `results.csv` (held-out validation split of the same dataset), not field tests.

| Folder | Detects | Architecture | imgsz | P / R / mAP50 (or top-1) | Notes |
|---|---|---|---|---|---|
| `weapon-yolov12l/` | Gun, Knife, Non Weapon | YOLO26-L (folder says v12l; only the failed first attempt used yolo12l) | 960 | 0.942 / 0.900 / 0.950 | run v12l-4, stopped by hand at epoch 47/100, still improving; test split never evaluated |
| `weapon-v2-yolo11n-experimental/` | 237 merged classes (pistol, knife, gun, decoys, numeric junk labels) | YOLO11n | 640 | 0.604 / 0.226 / 0.285 (best) | broken label merge; do not deploy |
| `fire-smoke-yolo26/` | fire, smoke | YOLO26-M | 960 | 0.846 / 0.778 / 0.847 | run -5, stopped at epoch 80/100, still improving |
| `ppe-yolo26n/` | 11 classes (helmet, gloves, vest, boots, goggles, none, Person, no_helmet, no_goggle, no_gloves, no_boots) | YOLO26-N | 640 | 0.630 / 0.511 / 0.536 (run -4 best) | violation classes found only 0-27% of the time; "advisory" |
| `no-helmet-yolo11s/` | No Helmet | YOLO11s | 960 | 1.0 / 1.0 / 0.995 | INVALID: val frames are the next frames of the same 2 training videos |
| `triple-rider-yolo11n/` | Single-Double-Rider, Triple Rider | YOLO11n | 640 | 0.721 / 0.834 / 0.806 (best, ep 25) | only 13 Triple instances in val; 46% of triples mis-called |
| `accident-yolo26m/` | Accident, Non Accident | YOLO26-M | 640 | 0.934 / 0.921 / 0.961 (best, ep 85) | 100 epochs |
| `vehicle-colour-yolo11n-cls/` | 15 vehicle colours (classifier) | YOLO11n-cls | 640 | top-1 0.864 / top-5 0.988 (best epoch) | |
| `phone-usage-yolo26/` | using phone | YOLO26-N and YOLO26-M | 640 | n: 0.842 / 0.827 / 0.904; m: 0.861 / 0.856 / 0.922 | nano = activity monitor's phone.pt |
| `crowd-people-yolo26m/` | people (head-sized boxes) | YOLO26-M | 640 | 0.789 / 0.468 / 0.490 | recall capped: ~20% of val images exceed the 300-box max_det |
| `fall-detection/` | falls per tracked person | YOLOv8s-pose + 1-D CNN on 24x39 keypoint windows | pose 640 | GMDCSA s2 sens 0.920 / spec 0.826; in-the-wild ~0.52 / 0.76 | 3 variants |
| `fight-detection-rtdetr-videomae/` | FIGHT / NORMAL / CROWD | RT-DETR-L + ByteTrack + VideoMAE ViT-B | det 1280, clip 16x224x224 | never measured | offline script only |
| `age-gender/` | age (regression), gender | EfficientNet-B0 + 2 heads | 224 | not recorded | production uses InsightFace genderage instead |
| `stampede-anomaly/` | crowd anomaly / crush risk | A: CNN-LSTM on flow; B: motion + CSRNet fusion | A: 16x224x224x2 | A: AUC 0.7485 (UCSD), overfit | backend endpoint exists, no detector runs |
| `anpr-licence-plate/` | Indian plates (text) | YOLOv8n vehicle + plate det + CCT OCR + voting + calibrator | 640, OCR 64x128 | plate det mAP50 0.981; end-to-end exact 72% | from sister product Trinetra |

Common improvement path for all YOLO models (details in each README): export to TensorRT FP16/INT8
(`yolo export format=engine half=True` / `int8=True data=...`), distil the large model into a nano student for the
edge, mine hard negatives from your own camera footage, and never alert on a single frame: confirm K-of-N per track
first (`../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`).

Licences: Ultralytics YOLO code and weights are AGPL-3.0 (matters for a closed embedded product; an Ultralytics
Enterprise licence removes that). Roboflow datasets carry their own licence in each `README.roboflow.txt`.
