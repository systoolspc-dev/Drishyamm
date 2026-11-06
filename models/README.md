# Model catalogue

Every model weight in this repository, where it lives, what loads it, how
good it is and under which licence. Two groups:

* **Live** — loaded by a running service. Weights that a service bakes into
  its own image stay next to that service's code; shared or large weights
  live here in `models/` and are mounted.
* **Trained, not integrated** — in-house models from the training projects,
  with their training code, configs, result plots and study README. No
  service loads them yet.

Accuracy numbers are from each model's own validation split unless marked
"live" (measured on real cameras). Study guides with the frame-by-frame call
path, thresholds, weaknesses and improvement ideas are in each service's
`MODEL.md` and each trained model's `README.md`.

## Live models

| Feature | Model | File(s) | Loaded by | Accuracy |
|---|---|---|---|---|
| Face detection | SCRFD-10G-KPS (InsightFace `buffalo_l`) | `models/insightface/models/buffalo_l/det_10g.onnx` | `ai/face-service` (TensorRT FP16 engine built on first start; 960×544 input) | face detect ~95 % live |
| Face recognition | ArcFace ResNet-50, 512-d (`buffalo_l`) | `…/buffalo_l/w600k_r50.onnx` | `ai/face-service` | TPR 0.979 / FPR 0.000; FNIR@FPIR=1e-3 = 0.021 (office benchmark) |
| Gender / age | `buffalo_l` genderage head | `…/buffalo_l/genderage.onnx` | `ai/face-service` (per-track vote) | not separately benchmarked |
| Landmarks (pack members) | 2d106 / 1k3d68 | `…/buffalo_l/2d106det.onnx`, `1k3d68.onnx` | part of the pack InsightFace loads | — |
| Light face pack (edge / CPU) | SCRFD-500M + MobileFaceNet | `models/insightface/models/buffalo_sc/` | `ai/face-service` when `INSIGHTFACE_MODEL=buffalo_sc` | lower; see `docs/FACE_EDGE_REALTIME_PLAN.md` |
| Body ReID (journey) | OSNet x1.0 (MSMT17) | `ai/face-service/vms_face/data/models/osnet_x1_0_msmt17.onnx` | `ai/face-service` journey fusion | — |
| Head count | YOLOv8n, 1 class (head) | `ai/head-count/models/abel/best.pt` | `ai/head-count` | ~98 % live spot-check; recall 97.8 % for heads ≥ 12 px |
| Restricted-zone person | YOLOv8n COCO (person) | `models/person/yolov8n.pt` | `ai/zone-guard` | recall 90.3 % isolated / 21 % overlapping people (harness) |
| Activity: pose | YOLOv8s-pose (n = lighter alternative) | `ai/activity-monitor/models/yolov8s-pose.pt`, `yolov8n-pose.pt` | `ai/activity-monitor` | posture rules not validated |
| Activity: phone | YOLO26-N, in-house | `ai/activity-monitor/models/phone.pt` | `ai/activity-monitor` | P 0.842 / R 0.827 / mAP50 0.904 |
| Forensic face restore | RetinaFace + ParseNet + CodeFormer + Real-ESRGAN x2 | `models/face-reconstruct/` | `ai/face-reconstruct` (`--profile enhance`) | none — output can hallucinate; never use for ID |

The InsightFace folder is mounted at `/root/.insightface` (the library's
default home), so `models/insightface/models/<pack>/` is exactly where
InsightFace looks. TensorRT engine caches are written next to it at first
start (`models/insightface/trt_cache/`, git-ignored): they are specific to
the GPU and TensorRT version and are rebuilt automatically.

Optional: dropping a `yolov8n.onnx` into `data/ai-models/` and setting
`PIPELINE_PERSON_DETECTION_ENABLED=true` makes the face service count
full-body presence too.

## Trained, not integrated — `models/trained/`

| Folder | Detects | Architecture | Result (P / R / mAP50) | Status |
|---|---|---|---|---|
| `weapon-yolov12l/` | gun, knife | YOLO26-L @960 (folder name says v12l) | 0.942 / 0.900 / **0.950** | best candidate; stopped at epoch 47/100, still improving |
| `fire-smoke-yolo26/` | fire, smoke | YOLO26-M @960 | 0.846 / 0.778 / **0.847** | good; stopped at 80/100 |
| `accident-yolo26m/` | accident / non-accident | YOLO26-M @640 | 0.934 / 0.921 / **0.961** | good |
| `phone-usage-yolo26/` | using phone | YOLO26-M @640 | mAP50 0.922 | the nano run of this project **is** `ai/activity-monitor/models/phone.pt` (not duplicated here) |
| `vehicle-colour-yolo11n-cls/` | 15 vehicle colours | YOLO11n-cls | top-1 0.864 / top-5 0.988 | good |
| `triple-rider-yolo11n/` | single/double vs triple rider | YOLO11n @640 | 0.721 / 0.834 / 0.806 | weak: only 13 triple-rider val instances |
| `ppe-yolo26n/` | helmet, vest, gloves, boots, goggles (+ "no_*") | YOLO26-N @640, 11 classes | 0.630 / 0.511 / 0.536 | **advisory only**: violation classes 0-27 % recall |
| `crowd-people-yolo26m/` | people (dense crowds) | YOLO26-M @640 | 0.789 / 0.468 / 0.490 | recall capped by max_det 300 |
| `fall-detection/` | falls per tracked person | YOLOv8s-pose + 1-D CNN on keypoint windows | sens 0.920 / spec 0.826 (GMDCSA); ~0.52 / 0.76 in the wild | 3 variants; newest (v2) never promoted |
| `fight-detection-rtdetr-videomae/` | fight / normal / crowd | RT-DETR-L + ByteTrack + VideoMAE ViT-B | never measured | offline script only; RT-DETR weights are stock (not shipped) |
| `age-gender/` | age, gender | EfficientNet-B0 | not recorded | production uses InsightFace genderage instead |
| `stampede-anomaly/` | crowd anomaly / crush risk | CNN-LSTM on optical flow; motion + CSRNet fusion | UCSD AUC 0.7485 (overfit) | research |
| `anpr-licence-plate/` | Indian plates (text) | YOLOv8n vehicle + plate detector + CCT OCR + voting | plate det mAP50 0.981; end-to-end exact 72 % | full project from the sister product |
| `no-helmet-yolo11s/` | no helmet | YOLO11s @960 | 0.995 — **INVALID** | validation frames leak from training videos; retrain before use |
| `weapon-v2-yolo11n-experimental/` | 237 merged classes | YOLO11n | mAP50 0.285 | broken label merge — **do not deploy** |
| `person-yolov8m-legacy/` | people | YOLOv8m, 1 class + BoT-SORT | 0.867 / 0.752 / 0.818 | superseded by the live head-count + zone-guard models |

Full per-model tables, class lists and caveats: [trained/README.md](trained/README.md).

Two deliberate de-duplications versus the original training folders: the
fight model ships once as `videomae-best-3class/model.safetensors` (the
project's `videomae_best_3class.pt` held identical tensors — load with
`VideoMAEForVideoClassification.from_pretrained(<that folder>)` and drop the
extra `torch.load`), and the phone nano run is the activity monitor's
`phone.pt`.

### Integrating a trained model

The path every new detector should follow (see
[../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md](../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md)):

1. Export for the GPU: `yolo export model=best.pt format=engine half=True`
   (or `int8=True data=...`).
2. Run it as its own service like `ai/zone-guard` / `ai/head-count`: pull
   `rtsp://stream-service:8554/cam_<id>` for cameras that have the feature
   enabled, post boxes to `POST /api/internal/ai/overlay` with
   `X-Service-Token`.
3. Never alert on a single frame: confirm K-of-N per track, alert once per
   transition, then add the event kind to the backend's alert engine.
4. Measure on your own camera footage before selling it (mine hard
   negatives; field numbers are usually well below validation numbers).

## Licences

| Weights / code | Licence | Implication |
|---|---|---|
| InsightFace `buffalo_l`, `buffalo_sc` | non-commercial research | a commercial face-recognition product needs a licence from InsightFace (contact them) or different weights |
| CodeFormer | S-Lab, non-commercial | same for forensic enhance |
| UTKFace (age-gender training data) | non-commercial | |
| Ultralytics YOLO (v8 / 11 / 12 / 26 weights and code) | AGPL-3.0 | closed-source distribution needs an Ultralytics Enterprise licence |
| OSNet | MIT | fine |
| Real-ESRGAN, RetinaFace (facelib) | BSD-3 / MIT | fine |
| Roboflow datasets | per dataset | see each `README.roboflow.txt` |

Customer-facing material should not name model architectures; the product
position is "our own models, trained in-house".
