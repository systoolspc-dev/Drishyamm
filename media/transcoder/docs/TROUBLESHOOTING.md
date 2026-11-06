# smart-cam-transcoder — Troubleshooting

Symptom → cause → fix.

## `docker compose build smart-cam-transcoder` hangs on apt-get

**Cause** — slow network pulling 1+ GB of CUDA runtime + FFmpeg.

**Fix** — let it finish (5-10 min on a fresh build). If it stays stuck for an hour, `docker compose build --no-cache --progress=plain smart-cam-transcoder` for verbose output, then check which exact apt mirror is slow.

## Container starts but `/health` 502 / connection refused

**Cause** — Uvicorn crashed at startup. Most common: Python deps didn't install.

**Fix** —
```sh
docker logs smart-cam-transcoder --tail 50
# Look for ModuleNotFoundError, pip errors, or "fatal:" lines.
docker exec smart-cam-transcoder python -c "import fastapi; print(fastapi.__version__)"
# If this fails, rebuild the image with --no-cache.
```

## `POST /transcoders/<id>` returns 201 but no `cam_<id>_clean` path appears in MediaMTX

**Cause #1** — FFmpeg crashed silently. Most common: source path doesn't exist (`cam_<id>` not ready in MediaMTX), or NVENC OpenSession failed.

**Diagnosis** —
```sh
curl -s http://localhost:8004/transcoders/<id> | jq '.recent_logs[-20:]'
```

Common log lines:
- `Connection refused` — MediaMTX isn't up or the source path doesn't exist
- `No such file or directory` — usually means `-i` couldn't open the RTSP URL; check `mediamtx_rtsp_base` + camera_id spelling
- `OpenEncodeSession failed: out of memory (10): no NVENC capable devices found` — GPU isn't exposed; check `gpus: all` in compose
- `OpenEncodeSession failed: invalid encoder param (8)` — wrong driver / FFmpeg-NVENC version mismatch
- `OpenEncodeSession failed: out of memory (10): code=1`, persisting — encoder slot ceiling reached

**Cause #2** — RTSP republish back to MediaMTX is being rejected.

**Diagnosis** —
```sh
curl -s -u drishyam:drishyam123 http://localhost:9997/v3/paths/list | \
  jq '.items[] | select(.name | endswith("_clean")) | {name, state, source}'
```
If state is `notReady` and source is null, MediaMTX didn't accept the publish. Most often: `authInternalUsers` doesn't permit `publish` from the transcoder's IP. The default config (user `any`, `ips: []`) allows everything; check `mediamtx.yml` for tighter rules.

## NVENC slots exhausted — repeated `code=10` failures

**Cause** — More transcoders running than the GPU has NVENC sessions. RTX PRO 5000 = 5 slots.

**Fix** —
1. List active: `curl -s http://localhost:8004/transcoders | jq '.[] | {camera_id, running}'`
2. Stop one or more: `curl -s -X DELETE http://localhost:8004/transcoders/<id>`
3. See ARCHITECTURE.md → encoder-slot math for the long-term unlock paths (community NVENC patch, second GPU, selective transcoding).

## FFmpeg keeps restarting every ~5 s

**Cause** — Camera is offline, or NVDEC can't decode the camera's codec (e.g. camera is HEVC and the pipeline is configured for H.264 decode).

**Diagnosis** —
```sh
curl -s http://localhost:8004/transcoders/<id> | jq '.recent_logs[-30:]'
```

Look for:
- `[rtsp @ ...] Could not connect to the server` — camera offline or path doesn't exist
- `Codec not currently supported in container` — output muxer (rtsp) rejecting the codec. Check audio path; `-c:a copy` fails if the source has a codec rtsp doesn't accept (G.722, opus weirdness). Switch to `-c:a aac`.
- `Stream specifier ':a' in filtergraph description matches no streams.` — camera has no audio. Set `NVENC_AUDIO=` to drop audio entirely (controller change needed; or build a `:a?` optional selector).

**Fix priorities**
1. Stop the transcoder — `DELETE /transcoders/<id>` — until the underlying camera is healthy. Encoder slot recovered.
2. If the camera streams HEVC and you want clean output: future enhancement — make `h264_cuvid` choice configurable per camera so HEVC sources use `hevc_cuvid` decode.

## Recordings break after enabling transcoding

**Cause** — smart-cam-backend's recording service reads `cam_<id>` (the raw path). If it accidentally got switched to `cam_<id>_clean`, the recording stops when no operator is watching (clean path has no viewers → MediaMTX closes it).

**Fix** — recording should ALWAYS read raw `cam_<id>`. Per [ARCHITECTURE.md](ARCHITECTURE.md), AI also reads raw. Only the operator-facing SPA WebRTC/HLS path switches to `_clean`. If recordings broke, something in the backend's stream-supervisor accidentally picked the clean path — check the supervisor's path-name builder.

## GPU temperature climbing with 3+ transcoders running

**Cause** — NVENC isn't free at scale. Each session is ~10-20 W on Blackwell; 5 transcoders = ~75 W extra heat budget vs idle.

**Fix** — Not really a fix; this is by design. If thermals are a real constraint, transcode fewer cameras or improve GPU cooling. The Phase 2.1 Grafana board has the per-camera frame-error metric so you can prioritise WHICH cameras justify the GPU spend.

## `recent_logs` always empty even though FFmpeg is clearly running

**Cause** — `loglevel warning` filters most output. We use `warning` deliberately so the ring buffer doesn't fill with per-frame `Past duration too small` noise.

**Fix** — bump to `info` or `debug` temporarily by overriding the args in [transcoder.py](../app/transcoder.py). Don't ship loglevel=debug to prod; it generates 100s of MB of stderr per camera per day.

## Stopping a transcoder takes 5+ s to return

**Cause** — `stop()` waits up to 5 s for SIGTERM to finish before SIGKILL. If FFmpeg is mid-NVENC-flush it can stall.

**Fix** — accept the latency; it's bounded. If 5 s is a real problem, change `await asyncio.wait_for(state.process.wait(), timeout=5)` in [transcoder.py](../app/transcoder.py) to a lower timeout.

## After a backend restart, transcoders for previously-enabled cameras don't auto-resume

**Cause** — `_registry` is in-process; container restart loses it. Phase 3 ships with the supervisor pattern documented but the actual streamSupervisor watcher is a Phase 3.4 backend addition.

**Fix** — manually call `POST /transcoders/{id}` for each camera that was previously enabled. Or wait for the Phase 3.4 work that wires `camera.settings.transcode.enabled` to an auto-reconcile loop.

## Cross-references

- [README.md](README.md)
- [ARCHITECTURE.md](ARCHITECTURE.md) — process model + encoder math
- [DEPLOYMENT.md](DEPLOYMENT.md) — env reference
