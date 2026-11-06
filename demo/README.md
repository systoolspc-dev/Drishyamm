# Demo without a real camera

```bash
docker compose --profile demo up -d
```

| Service | Does |
|---|---|
| `local-demo-cam` | Loops `videos/crowd.mp4` (re-encoded to a short-GOP H.264) into the Stream Service at `rtsp://stream-service:8554/demo_src`. Add a camera in Camera Setup with that URL; Live View, head count, zones and occupancy then have a real source. |
| `footfall-demo` | `footfall_publisher.py` loops `videos/FootfallVideo.mp4` as `cam_demo-entrance` and registers it with the face service as a footfall camera with a horizontal counting line, so `/ai-event/footfall` counts with no hardware. |

For restricted zones on the demo camera set
`ZONE_GUARD_SOURCES=<monitorId>=rtsp://stream-service:8554/demo_src` in the
root `.env` (the demo publisher path is always on, unlike on-demand `cam_*`
paths) and restart `zone-guard`.

The console's own feature demo videos (fire, weapon, ANPR, human detection)
are under `frontend/public/demos/` and `frontend/src/ai-analytics/assets/`.
