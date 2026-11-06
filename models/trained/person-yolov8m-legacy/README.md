# 08 - Legacy human detection (people count per camera, fine-tuned YOLOv8m)

Source: `smart-cam-ai/app/human_detection/` (`backend/main.py`, `backend/vision_engine.py`,
`backend/database.py`, `backend/best.pt`, `frontend/src/`). Bundle copy:
`code/human_detection/` (`best.pt` shipped; the `yolov8n.pt` base checkpoint and the
`cameras.db` SQLite file are not, since the latter holds camera source URLs).

## What it does / status

A self-contained FastAPI service that opens one OpenCV capture per camera, runs a custom
**single-class "person" YOLOv8m** with Ultralytics tracking on every frame, and reports the
current number of tracked people plus an annotated MJPEG stream. A small React dashboard
(`frontend/src/components/Dashboard.jsx`) adds, edits, retries and views cameras.

**Status: experiment, not wired into the product.** No compose service, no
`/api/internal/*` calls, no backend proxy; `docs/05-codebase-guide.md` calls it a
"body-detection experiment". Person detection in the live stack is done elsewhere: vms_face's
person detector (`PIPELINE_PERSON_MODEL_PATH=/srv/data/models/yolov8n.onnx`) and the
head-count service (`../02-head-count`). Its value today is the **fine-tuned `best.pt`**,
which could be evaluated as a replacement person model.

## Call path (file:function)

1. `main.py:lifespan` - creates the `cameras` table, starts a `VisionEngine` for every row,
   then `camera_watchdog` every 60 s restarts engines in `error` or `standby`.
2. Start a camera: `POST /monitor/{monitor_id}/start` (source
   `rtsp://<MEDIAMTX_RTSP_HOST>:<MEDIAMTX_RTSP_PORT>/<monitor_id>`, defaults `localhost:8554`;
   note: no `cam_` prefix, unlike every other service) or `POST /cameras?name=&ip_address=`
   (any OpenCV source string; a digit string means a local webcam index).
3. `vision_engine.py:CameraManager.get_engine` -> `VisionEngine.start` -> daemon thread
   `process_video`.
4. `process_video`: `cv2.VideoCapture(src)`, `CAP_PROP_BUFFERSIZE=1`, loop
   `cap.read()` -> `self.model.track(frame, persist=True, classes=[0], device=..., verbose=False)`
   -> count -> draw -> `cv2.imencode('.jpg')` into `latest_frame` under a lock.
5. Readers: `GET /monitor/{id}/count`, `WS /ws/{monitor_id}` (1 msg/s), `GET /status/{id}`,
   `GET /system-status`, `GET /health`, `GET /stream/{camera_id}` (MJPEG via
   `generate_frames`, 0.1 s per frame, a black "RECONNECTING..." / "OFFLINE" frame when empty).

## Pre-processing

None in this code: full-resolution BGR frames go straight to Ultralytics, which letterboxes
to the model's `imgsz` 640 and normalises to [0,1]. Every decoded frame is inferred (no frame
skip, no motion gate). Device: `mps` if available, else `cuda`, else `cpu`
(`VisionEngine.get_device`).

## Model + tensor + runtime

`backend/best.pt` metadata, read without unpickling any code (stub unpickler, no tensors
loaded):

| Field | Value |
|---|---|
| Created | 2026-05-05, Ultralytics 8.4.46, licence string AGPL-3.0 |
| Base | `yolov8m.pt` (COCO-pretrained, `pretrained: True`) - file size 52 MB is consistent with YOLOv8m |
| Task / classes | `detect`, `nc: 1`, `names: {0: 'person'}` |
| Training | `data.yaml` (dataset not in the repo), `epochs 50`, `patience 20`, `imgsz 640`, `batch 16`, `optimizer auto`, `lr0 0.01`, run name `yolov8_human_detection-8` |
| Validation metrics (stored in the checkpoint) | precision 0.867, recall 0.752, mAP50 0.818, mAP50-95 0.573 |
| `epoch: -1`, `optimizer` stripped | a finalised "best" export |

Tensor: input `1x3x640x640` float32, letterboxed RGB; YOLOv8 anchor-free head at strides
8/16/32 (80x80 + 40x40 + 20x20 = 8400 candidates), each 4 box values (DFL) + 1 class score.
Runtime: PyTorch through `ultralytics` (`requirements.txt`: `ultralytics`, `torch`,
`torchvision`, `opencv-python`, `numpy`, `fastapi`, `uvicorn`, `sqlalchemy`,
`python-multipart`, plus an unused `face-recognition`).

The metrics are on an unknown validation split, so they cannot be compared directly with the
head-count service or with COCO numbers. Recall 0.75 at precision 0.87 means about one person in
four is missed at the default operating point; check on our own footage before use.

Licence: Ultralytics YOLOv8 code and weights are AGPL-3.0; fine-tuned weights are a derived
work. Shipping this in a closed product needs an Ultralytics Enterprise licence (the same issue
applies to the head-count and zone models).

## Post-processing & thresholds (real values)

- `classes=[0]` (the only class). No explicit `conf` or `iou`: `Model.track` in Ultralytics
  defaults confidence to 0.1 for the tracker (low-score boxes feed the second association pass)
  and NMS IoU to 0.7; tracker = BoT-SORT `botsort.yaml` defaults. These are library defaults
  and change between versions; pin them explicitly.
- Count = `len(results[0].boxes.id)`, i.e. boxes that carry a track id; `boxes.id is None`
  gives 0. Drawn boxes are only those tracked boxes; no labels, ids or scores on screen.

## Temporal/decision logic

- Tracking: `persist=True` keeps BoT-SORT state across calls on the same model object (one
  YOLO instance per camera, so cameras do not share state).
- No smoothing, no hysteresis, no "unknown" state: the count is the raw per-frame number.
  A dead stream leaves `current_people_count` at its last value while `status` turns `error`
  (`/monitor/{id}/count` still returns that number).
- Read failures: retry every 0.5 s; after 10 s without a frame `status = error` and the thread
  exits; the watchdog restarts it within 60 s.

## Outputs & consumers

JSON counts (`{monitor_id, count, status}`), MJPEG annotated stream, and aggregate
`total_people` across active engines. Only the bundled React dashboard consumes them; it is
hard-coded to `http://localhost:8000` (`Dashboard.jsx`), polls `/cameras` and `/status/{id}`
every 5 s, and `FaceUpload.jsx` posts to `/upload`, which the backend does not implement.
Nothing is persisted except the camera list in `cameras.db`
(`Camera{id, name, ip_address unique, is_active}`).

## Config knobs

| Knob | Where | Default |
|---|---|---|
| `MEDIAMTX_RTSP_HOST` / `MEDIAMTX_RTSP_PORT` | env, `main.py` | `localhost` / `8554` |
| Model path | `VisionEngine.__init__` `YOLO("best.pt")` | relative to the working directory |
| DB | `database.py` `sqlite:///./cameras.db` | working directory |
| Watchdog period | `camera_watchdog` | 60 s |
| Stream timeout | `process_video` | 10 s |
| MJPEG pacing / WS rate | `generate_frames` / `ws_monitor` | 0.1 s / 1 s |

## Known weaknesses + improvement ideas

1. **No auth, wildcard CORS with credentials, and camera CRUD with source URLs in query
   strings** (`POST /cameras?ip_address=...`): credentials in RTSP URLs end up in logs. Never
   expose it.
2. **One full YOLOv8m per camera, every frame, plus a JPEG encode per frame.** No batching,
   no frame skip, no motion gate. Head-count measured the GIL as the ceiling at about
   175 inferences/s per process with a smaller model; this design hits it far sooner.
3. **Count honesty.** It reports a stale number for a dead camera. Apply the occupancy rule
   (`count NULL` when unknown) used in `../integration` before any reuse.
4. **No hysteresis or temporal smoothing** of the count; use a median over 1-2 s and the
   backend's K-of-N plus deadband if it ever drives alerts.
5. **Evaluate `best.pt` properly**: run it and the live `yolov8n` person model on the same
   labelled clips from our own cameras at the same input size, report precision/recall at fixed confidence and per-distance
   recall, and export to ONNX/TensorRT if it wins. Recover `data.yaml` and the dataset, or
   the numbers above cannot be reproduced.
6. **RTSP path mismatch** (`/<monitor_id>` vs `cam_<monitor_id>`) means the monitor endpoints
   will not find product cameras on the stream service without a change.
7. Dead code: `face-recognition` dependency and `FaceUpload.jsx` with no backend route;
   `.DS_Store` files in the tree.

## How to run/test

```bash
cd smart-cam-ai/app/human_detection/backend
pip install -r ../requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000      # run from backend/ so best.pt and cameras.db resolve
curl -X POST "http://localhost:8000/cameras?name=test&ip_address=/path/to/clip.mp4"
curl http://localhost:8000/status/1
# browser: http://localhost:8000/stream/1 ; dashboard: cd ../frontend && npm install && npm run dev
```

Use a local clip or a demo RTSP path; do not point it at production NVR paths.
Quick model check without the service: `yolo predict model=best.pt source=<clip> classes=0`.
