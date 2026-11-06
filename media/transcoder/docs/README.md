# smart-cam-transcoder

Per-camera **NVENC** normaliser. For cameras whose firmware emits awkward H.264 (long GOP, B-frames, weird encoder profile) this service spawns one FFmpeg subprocess per camera that re-encodes to baseline H.264 + 2 s GOP + no B-frames, then publishes the result back to MediaMTX at a sibling path `cam_<id>_clean`. The SPA + AI consume the clean path transparently — same monitorId UI, different MediaMTX path.

This is Phase 3 of the streaming improvement plan ([docs/STREAMING-IMPROVEMENT-PLAN.md](../../docs/STREAMING-IMPROVEMENT-PLAN.md)). It's the bandaid for camera-side problems we cannot fix at the source — long GOPs we can't change on cameras whose web UI we don't have, B-frames Hikvision firmware refuses to disable, scenes-cause-bitrate-spikes that VBR encoders can't be coaxed out of.

## When to enable a camera

Per-camera opt-in. The default is **off** for every camera — encoder slots are scarce (1 NVENC slot per active transcoder; modern NVIDIA cards have 3-8). Enable when:

- The per-camera Grafana panel ([camera-streams.json](../../observability/grafana/dashboards/camera-streams.json)) shows sustained frame errors on the raw `cam_<id>` path
- MediaMTX HLS muxer logs "unable to extract DTS: too many reordered frames" for that camera
- The Phase 1.1 camera-config sweep returned `unsupported` or `Invalid XML Content` for that camera's encoder PUT
- Operators consistently report "this one camera lags / freezes" while neighbours are clean

Don't blanket-enable: it doubles GPU encoder pressure for no payoff on cameras that are already streaming clean H.264.

## API surface

| Verb | Path | Purpose |
|---|---|---|
| `GET`    | `/health`                       | liveness |
| `GET`    | `/transcoders`                  | list every running transcoder + state |
| `GET`    | `/transcoders/{camera_id}`      | one transcoder's state + recent FFmpeg logs |
| `POST`   | `/transcoders/{camera_id}`      | start (idempotent); body `{ bitrate_kbps? }` |
| `DELETE` | `/transcoders/{camera_id}`      | stop; idempotent |

Internal-only — bound to the docker-internal network. Backend talks to it at `http://smart-cam-transcoder:8004`. Operator-facing toggle is the backend endpoint [`PATCH /api/admin/cameras/:id/transcode`](../../smart-cam-backend/src/routes/admin.routes.js).

## Per-camera flow

```
RTSP from camera ──▶ MediaMTX ──▶ cam_<id>            ──▶ AI service (always, raw)
                                       │
                                       │ if transcode flag = true
                                       ▼
                                smart-cam-transcoder
                                  FFmpeg + NVENC
                                       │
                                       ▼
                                  cam_<id>_clean   ──▶ SPA WebRTC / HLS (when flag set)
```

The SPA's stream picker reads `camera.settings.transcode.enabled` and appends `_clean` to the MediaMTX path when set. The AI service always reads the raw path because re-encoding before face detection adds latency for no recognition benefit.

## What the FFmpeg pipeline actually does

```
-hwaccel cuda -hwaccel_output_format cuda      # NVDEC decode (no CPU)
-i rtsp://mediamtx/cam_<id>                    # source (TCP transport)
-c:v h264_nvenc -preset p4 -tune ll            # NVENC encode, low-latency
-profile:v baseline -bf 0                      # no B-frames (HLS muxer-friendly)
-g <fps*gop_seconds>                           # 2s GOP @ 25fps = 50
-b:v 4000k -maxrate 5000k -bufsize 5000k       # ~CBR
-c:a copy                                      # audio passthrough
-f rtsp -rtsp_transport tcp                    # republish
rtsp://mediamtx/cam_<id>_clean
```

Every flag has a documented "why" in [transcoder.py](../app/transcoder.py).

## When NOT to use this

- **Stream is already clean** — wasted GPU encoder slot.
- **GPU encoder slots exhausted** — see TROUBLESHOOTING for capacity math.
- **Camera publishes HEVC/H.265** — `h264_cuvid` won't decode it; need to switch the decoder to `hevc_cuvid` and handle the unmix.

## Cross-references

- [ARCHITECTURE.md](ARCHITECTURE.md) — process model, encoder-slot math, restart semantics
- [DEPLOYMENT.md](DEPLOYMENT.md) — compose entry, env vars, smoke tests
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common failures + diagnostics
- [../../docs/STREAMING-IMPROVEMENT-PLAN.md](../../docs/STREAMING-IMPROVEMENT-PLAN.md) — Phase 3 in the broader roadmap
- [../../docs/STREAMING-WORLD-CLASS-MAP.md](../../docs/STREAMING-WORLD-CLASS-MAP.md) — why transcoding exists in the modern streaming stack
