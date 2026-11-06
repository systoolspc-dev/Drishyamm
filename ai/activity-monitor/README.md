# Activity Monitor

Per-person **activity monitoring** on office/CCTV streams: each person tagged
`working` / `not_working` / `on_phone`, over a REST API with a live dashboard.
Posture-based (angle-robust), headless, edge-friendly. Head counting lives in the
separate `head-count` project.

> **Attendance & Alerts** (recognition-driven who/when/how-long + a policy alert
> layer) run in this same service but are documented separately —
> see **[docs/ATTENDANCE_ALERTS.md](docs/ATTENDANCE_ALERTS.md)**.

## Layout
```
activity-monitor/
├── pyproject.toml              # packaging, deps, console script
├── Makefile                    # install / test / run / probe
├── config/config.yaml          # detectors (phones) + activity + streams
├── src/activity_monitor/       # the package (src layout)
│   ├── __main__.py             #   python -m activity_monitor / `activity-monitor`
│   ├── activity.py             #   posture + phone + (optional) talking logic
│   ├── tracker.py              #   per-stream IoU tracker (person IDs)
│   ├── api.py config.py counter.py manager.py model.py stream_worker.py
│   └── web/                    #   dashboard (static files)
├── scripts/
│   ├── probe_activity.py       #   tune/validate thresholds on an image
│   ├── render_video.py         #   render an annotated clip
│   └── export_model.py         #   ONNX/TensorRT export for edge
├── models/                     # phone.pt, yolov8s-pose.pt, yolov8n-pose.pt
├── deploy/activity-monitor.service
└── tests/
```

## Install
```bash
python3 -m venv venv && source venv/bin/activate   # or reuse a shared venv
pip install -e ".[dev]"      # runtime + dev deps + `activity-monitor` script
```
> **Jetson/Pi:** install the vendor PyTorch wheel **first**, then `pip install -e .`.

## Run
```bash
activity-monitor --config config/config.yaml       # console script
# or:  python -m activity_monitor --config config/config.yaml
# or:  make run
```
Dashboard: **http://localhost:8000/**. Env override prefix is `MONITOR_`
(e.g. `MONITOR_ACTIVITY__DEVICE=cuda`, see `.env.example`).

## How activity is decided (`activity.py`)
Per person the pose model finds, using **upper-body posture** (angle-robust):
```
phone box overlaps them                 → on_phone
head clearly below shoulders            → not_working  (slumped/head-down)
clear shoulders but no visible face     → not_working  (head buried in arms)
head up + hips visible + torso reclined → not_working  (feet-up / leaning back)
otherwise                               → working
```
Any head keypoint (nose/eye/**ear**) is used, so people **facing away** from the
camera are still classified. Temporal hysteresis smooths states over ~1s.

## REST API
| Endpoint | Returns |
|----------|---------|
| `GET /count` | counts + `activity_totals` |
| `GET /streams` · `GET /count/{id}` | per-stream, incl. `people[]` (state, posture) |
| `GET /video/{id}` · `GET /snapshot/{id}` | live MJPEG · single JPEG |
| `GET /health` | status, device, detectors |

## Tune on real footage
```bash
python scripts/probe_activity.py frame.jpg           # prints per-person state + posture
python scripts/probe_activity.py frame.jpg --tilt 24 # try a reclined-torso threshold
python scripts/render_video.py in.mp4 out.mp4        # annotated clip
```

## Key config (`config/config.yaml`)
- `activity.imgsz: 1280` — recall on wide/overhead shots (raise for distant people).
- `activity.posture_tilt_max` / `posture_head_down` / `posture_face_min` — posture thresholds.
- `activity.talking_enabled: false` — talking is off (unreliable at CCTV angles).
- `detectors[0].conf: 0.50` — phone confidence gate.

## Known limits
- Phone model is **close-range** (`yolo26n`); misses small/distant phones — retrain
  at `s` scale on CCTV data to improve.
- Upright-working vs upright-idle can't be split by posture (needs a trained classifier).

## Test / deploy
```bash
make test
sudo cp deploy/activity-monitor.service /etc/systemd/system/   # edge (see file header)
```
