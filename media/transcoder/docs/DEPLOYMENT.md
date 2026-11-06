# smart-cam-transcoder — Deployment

## Compose entry

Already wired in [docker-compose.yml](../../docker-compose.yml) at the `smart-cam-transcoder` block. Brings up alongside everything else:

```sh
docker compose up -d smart-cam-transcoder
docker compose logs -f smart-cam-transcoder
```

You should see:
```
INFO:     Started server process [1]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8004
```

If you see `ffmpeg: not found` on startup, the Dockerfile build failed silently — `docker compose build --no-cache smart-cam-transcoder` and check stderr.

## Smoke test (no transcoding yet — just service liveness)

```sh
# Liveness
curl -s http://localhost:8004/health
# expected: {"status":"ok","service":"smart-cam-transcoder","version":"0.1.0"}

# Empty roster (no transcoder running yet)
curl -s http://localhost:8004/transcoders
# expected: []

# NVENC encoder list (proves NVENC is wired in the image)
docker exec smart-cam-transcoder cat /etc/ffmpeg-nvenc-encoders.txt
# expected: lines including h264_nvenc + hevc_nvenc
```

## Smoke test (transcode one camera end-to-end)

Pick a camera whose `cam_<monitor_id>` is currently `ready` in MediaMTX (see Grafana → drisyam — per-camera streaming health). Call:

```sh
curl -s -X POST http://localhost:8004/transcoders/<monitor_id>
# expected: {"camera_id":"...","src_path":"rtsp://mediamtx:8554/cam_...","dst_path":".../cam_..._clean",
#            "bitrate_kbps":4000,"running":true,...}
```

Within ~5 s, MediaMTX should show a new path:

```sh
curl -s -u drishyam:drishyam123 http://localhost:9997/v3/paths/list | jq '.items[] | select(.name | endswith("_clean"))'
# expected: at least one entry, state=ready, tracks > 0
```

Now visually verify: in the SPA open Live View on that camera, with the URL hash overridden to add `?clean=1` (the SPA reader for `?clean=1` is part of Phase 3.4 backend integration). If you don't have that yet, hit the WHEP endpoint directly:

```
http://localhost:8889/cam_<monitor_id>_clean/whep
```

… in a webrtc test page (e.g. Trickle ICE) to confirm video frames arrive.

To stop:

```sh
curl -s -X DELETE http://localhost:8004/transcoders/<monitor_id>
# expected: {"stopped":true,"camera_id":"..."}
```

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 8004 | service port |
| `MEDIAMTX_RTSP_BASE` | rtsp://mediamtx:8554 | source + destination RTSP base |
| `MEDIAMTX_API_URL` | http://mediamtx:9997 | MediaMTX REST API (path management) |
| `MEDIAMTX_API_USER` / `MEDIAMTX_API_PASS` | drishyam / drishyam123 | MediaMTX basic auth |
| `CLEAN_PATH_SUFFIX` | `_clean` | what gets appended to the camera path for the published clean stream |
| `NVENC_CODEC` | h264_nvenc | encoder; HEVC = `hevc_nvenc` (browser support patchy) |
| `NVENC_PRESET` | p4 | p1..p7 (fastest..slowest); p4 is balanced |
| `NVENC_TUNE` | ll | low-latency NVENC tune |
| `NVENC_PROFILE` | baseline | no B-frames; HLS-muxer-friendly |
| `NVENC_BITRATE_KBPS` | 4000 | per-stream output bitrate (CBR-ish) |
| `NVENC_MAXRATE_KBPS` | 5000 | ceiling for bursts |
| `NVENC_GOP_SECONDS` | 2.0 | keyframe interval in seconds |
| `NVENC_FPS` | 25 | locked output framerate |
| `NVENC_AUDIO` | copy | audio handling; `copy` = passthrough, `aac` = re-encode |
| `MAX_CONCURRENT_TRANSCODERS` | 16 | safety ceiling; real hardware cap is the NVENC slot count |
| `FFMPEG_RESTART_BACKOFF_SEC` | 5 | wait between supervisor restarts |
| `FFMPEG_LOG_TAIL_LINES` | 200 | ring-buffer size for `/transcoders/{id}` recent_logs |

## Verifying NVENC is actually running on the GPU

If FFmpeg silently falls back to libx264, you get smooth output but NVENC sees zero traffic — and after a few cameras the CPU dies. The forward check:

```sh
# Inside the host:
nvidia-smi --query-compute-apps=pid,process_name,used_memory \
  --format=csv,noheader

# expected when 2 transcoders running:
# 12345,ffmpeg,~300 MiB
# 12346,ffmpeg,~300 MiB
```

If you don't see ffmpeg processes here, NVENC isn't engaging. Check `docker logs smart-cam-transcoder` for `[h264_nvenc @ ...]` warnings during the FFmpeg spawn.

## Updating the NVENC profile

Per-camera bitrate goes through the start endpoint:

```sh
curl -s -X POST http://localhost:8004/transcoders/<id> \
  -H 'Content-Type: application/json' \
  -d '{"bitrate_kbps": 6000}'
```

For preset / GOP / fps changes, edit the env vars in `docker-compose.yml` and restart the container. All running transcoders pick up the new defaults on their next supervisor-driven respawn — which means they will briefly pop unclean to operators. Restart during maintenance window.

## Rollback

Per camera: `DELETE /transcoders/{id}`. SPA + AI continue reading the raw `cam_<id>` path. Zero downstream impact.

Whole service: `docker compose stop smart-cam-transcoder`. Same — raw paths keep flowing.

## Cross-references

- [README.md](README.md) — service intent + when to enable
- [ARCHITECTURE.md](ARCHITECTURE.md) — process model + encoder math
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — diagnostics
