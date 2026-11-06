# Phase 2 — Production Deployment Blueprint

Phase 1 (this repo) is the validated detection **engine**. Phase 2 wraps it in
the services a real CCTV deployment needs. This document is the blueprint; the
components below are the build order.

## Target topology (GPU server, live RTSP, web dashboard)

```
  IP cameras (RTSP)
        │
        ▼
 ┌─────────────────┐   frames    ┌──────────────────┐  events   ┌────────────┐
 │ Stream workers  │ ──────────► │ Inference service│ ────────► │ Event/API  │
 │ (1 per camera)  │             │ YOLO-pose(TensorRT)│         │ service    │
 │ reconnect,      │             │ + ByteTrack       │  ┌──────►│ (FastAPI)  │
 │ resample→15fps  │             │ + FallEngine      │  │        └─────┬──────┘
 └─────────────────┘             └──────────────────┘  │              │
                                         │ snapshot/clip │        ┌────▼─────┐
                                         ▼               │        │ Dashboard│
                                  ┌─────────────┐        │        │ (web UI) │
                                  │ Object store│        │        └──────────┘
                                  │ (MinIO/S3)  │        │
                                  └─────────────┘   ┌────▼─────┐
                                                    │ Postgres │  events, cameras
                                                    └──────────┘
        Message bus (Redis/NATS) connects workers ⇄ inference ⇄ events.
        Prometheus + Grafana scrape FPS / GPU / queue depth / alert latency.
```

## Build order

1. **Stream worker** (`src/stream/worker.py`) — `cv2.VideoCapture(rtsp_url)` with
   auto-reconnect + backoff, resample to `TARGET_FPS`, drop frames if behind
   (never buffer unbounded). One process per camera. Reuses `FallEngine`.
2. **Event/API service** (FastAPI) — receives `FallEvent`s, writes to Postgres,
   stores snapshot + a ±10s clip to MinIO/S3, exposes `/events`, `/cameras`,
   `/stream/{id}` (MJPEG preview), and a websocket for live alerts.
3. **Web dashboard** — camera grid, live status per person, event log with
   thumbnail + clip playback, acknowledge/resolve buttons.
4. **Alerting** — websocket push to the dashboard (chosen), pluggable webhook
   for future SMS/WhatsApp.
5. **Packaging** — `docker-compose.yml`: `stream-worker` (×N), `inference`,
   `api`, `postgres`, `minio`, `dashboard`, `prometheus`, `grafana`.
6. **Scale** — TensorRT-export YOLO-pose (`yolo export ... format=engine`);
   batch frames across cameras into the GPU; horizontal-scale stream workers.

## Sizing rule of thumb (single modern GPU, e.g. RTX 4090 / L4)
- `yolov8s-pose` TensorRT ≈ 3–6 ms/frame → ~150–300 fps of pose budget.
- At 15 fps/camera that's **~10–20 cameras per GPU** (fewer with many people
  per frame). The fall CNN is negligible (<0.5 ms). Add GPUs to scale linearly.

## Reliability must-haves
- Per-camera watchdog + auto-reconnect; mark camera "offline" in the dashboard.
- Idempotent events (debounced per track) so one fall = one alert.
- Store raw clips for every alert (audit + false-alarm review + retraining data).
- Health endpoint + Prometheus metrics: fps in/out, GPU util, queue depth,
  end-to-end alert latency.
- Retention/purge policy for clips (privacy + disk).

## Privacy
All inference is local to your server; only fall **events** (+ optional clips
you control) leave the box. No frames go to any third party — same privacy
stance as the paper, kept at CCTV scale.
