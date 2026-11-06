# AI services

Each folder is an independently deployable service. They all read video from
the Stream Service (`rtsp://stream-service:8554/cam_<monitorId>`), never from
cameras directly, and report back to the backend over `/api/internal/*` with
the shared `X-Service-Token` (`SERVICE_TOKEN` in the root `.env`). A feature
runs on a camera only after it is enabled for that camera in the console.

| Service | Compose service(s) | Port | GPU | What it does | Read next |
|---|---|---|---|---|---|
| [`face-service/`](face-service/) | `smart-cam-ai` (+ `smart-cam-ai-worker`, `journey-stitch-worker`; scale: `smart-cam-ai-1..4`, `smart-cam-infer..-3`) | 8001 | yes | Face detection + recognition, watchlists, unknown-person alerts, gender/age, face learning, footfall lines, person journey (forensic search + stitched video), inference server | [MODEL.md](face-service/MODEL.md), [vms_face/README.md](face-service/vms_face/README.md), [../docs/FACE_SYSTEM_DESIGN.md](../docs/FACE_SYSTEM_DESIGN.md) |
| [`head-count/`](head-count/) | `head-count` | 8020 | yes (CPU / Jetson builds too) | Head counting for occupancy, counts every 5 s to the backend | [MODEL.md](head-count/MODEL.md), [README.md](head-count/README.md), [DEPLOY.md](head-count/DEPLOY.md) |
| [`zone-guard/`](zone-guard/) | `zone-guard` | — | yes | Person boxes for restricted-zone intrusion, face or no face | [README.md](zone-guard/README.md), [MODEL.md](zone-guard/MODEL.md) |
| [`activity-monitor/`](activity-monitor/) | `activity-monitor` | 8010 | no (CPU) | Working / not working / on phone, attendance from face recognitions, live "who is where" tracker | [MODEL.md](activity-monitor/MODEL.md), [README.md](activity-monitor/README.md) |
| [`face-reconstruct/`](face-reconstruct/) | `face-reconstruct` (`--profile enhance`) | 8002 | yes | Forensic enhancement of one uploaded face (CodeFormer + Real-ESRGAN) | [MODEL.md](face-reconstruct/MODEL.md), [README.md](face-reconstruct/README.md) |

Weights: see [../models/README.md](../models/README.md). The face service is
one image (`drishyam/face-service`) whose role is chosen by the compose
`command:` — API/shard, inference server, match worker, stitch worker.

## Conventions every AI service follows

* **Ephemeral vs persisted.** Per-frame boxes go to
  `POST /api/internal/ai/overlay` (drawn live, never stored, never alerted).
  Only confirmed, meaningful detections go to `POST /api/internal/ai/events`
  and can become alerts. This split is what keeps alerts from flooding.
* **Detect per frame, decide per track, alert per identity transition.**
  Confirm K-of-N frames on a track before acting; alert once when the state
  changes. [../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md](../docs/DETECTION_DECISION_ALERT_FRAMEWORK.md).
* **RTSP over TCP** (`OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp`):
  H.265 NVRs drop UDP packets and corrupt decode.
* **Tenancy.** The face service scopes every query by the tenant in the JWT
  (`tid`), never by a request parameter.
