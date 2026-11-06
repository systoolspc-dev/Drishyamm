# smart-cam-transcoder — Architecture

## Process model

One container, one FastAPI app, **one FFmpeg subprocess per active camera**. The FFmpeg processes are managed by an in-process asyncio supervisor (see [transcoder.py](../app/transcoder.py)) that:

1. Spawns FFmpeg with the constructed argv (NVENC pipeline)
2. Pumps stderr into a fixed-size ring buffer (last 200 lines per camera) so `/transcoders/{id}` can return recent diagnostics without disk writes
3. Waits for exit
4. Backs off `FFMPEG_RESTART_BACKOFF_SEC` (default 5 s)
5. Respawns — unless `stop_requested` is set

No external supervisor (systemd / supervisord). Asyncio handles it because the work is I/O-bound (waiting on FFmpeg), the restart policy is trivial, and adding a separate supervisor would mean two layers of process management that can fight each other.

## State

In-process only. The `_registry: dict[camera_id, TranscoderState]` map is module-scoped. **Restarting the container loses every running transcoder.** Recovery is:

- Backend's `streamSupervisor` watches `camera.settings.transcode.enabled` flags every 2 s
- On container restart, the supervisor sees its expected-running set vs the empty live set and re-issues `POST /transcoders/<id>` for each
- Result: ~5–10 s of un-transcoded streaming after a transcoder container restart, then back to clean

If we ever need across-restart persistence, the right shape is a Redis hash of `camera_id → desired-state`. Not building it until we actually have per-camera-state worth persisting (per-camera profile overrides, last-error reasons, etc).

## Encoder-slot math

NVENC sessions are a hard hardware limit per GPU:

| GPU | NVENC sessions |
|---|---|
| RTX A4000 / A5000 / 5000 (consumer-driver) | 3 |
| RTX A6000 / A100 / H100 / RTX PRO 5000 (datacenter / pro) | 5 |
| With `nvidia-patch` | unlimited (best-effort, not officially supported) |

drisyam's Blackwell RTX PRO 5000: **5 slots**. Three live consumers compete:

- `smart-cam-ai` recording transcode (per camera that records): 1 slot per active recording
- `face-reconstruct` ESRGAN encode: 0 slots (uses raw CUDA, not NVENC)
- `smart-cam-transcoder`: **1 slot per active transcoder**

So practical ceiling for transcoder: **3 cameras** when recording is on for the rest, **5** if recordings are off. `MAX_CONCURRENT_TRANSCODERS=16` is a safety net for misconfigured deploys; the NVENC OpenSession call will fail before we hit 16 anyway.

If the ceiling becomes a real constraint, the unlock paths in order:

1. **NVENC patch** — community patch removing the session cap. Works on consumer cards; voids NVIDIA support but the only real fix.
2. **Second GPU** — adds another 3-5 slots.
3. **Selective transcoding** — only worst N cameras (auto-detected from Phase 2.1 telemetry).
4. **Move to AV1 / external encoder farm** — outside Phase 3 scope.

## FFmpeg pipeline rationale

```
ffmpeg -hide_banner -loglevel warning
       -hwaccel cuda -hwaccel_output_format cuda     # NVDEC decode on GPU
       -rtsp_transport tcp -i <src>                  # TCP matches MediaMTX config
       -c:v h264_nvenc -preset p4 -tune ll           # low-latency NVENC preset
       -profile:v baseline -bf 0                     # baseline = no B-frames
       -b:v <kbps>k -maxrate <max>k -bufsize <max>k  # CBR-ish
       -g <fps*gop_seconds> -keyint_min <same>       # short GOP, 2s @ 25fps
       -r <fps>                                      # locked frame rate
       -force_key_frames "expr:gte(t,n_forced*<gop>)" # belt + suspenders
       -c:a copy                                     # audio passthrough
       -f rtsp -rtsp_transport tcp <dst>
```

| Choice | Why |
|---|---|
| `h264_cuvid` for input | NVDEC decode keeps the CPU clean. Falls back to software if the stream isn't H.264. |
| `h264_nvenc` for output | Universal browser support, what MediaMTX HLS muxer wants. |
| `preset p4` | NVENC presets are p1 (fastest, lowest quality) … p7 (slowest, best quality). p4 is the live-streaming sweet spot. |
| `tune ll` | "Low Latency" — disables look-ahead, B-frames, scene-cut detection. Matches WebRTC's expectations. |
| `profile baseline` | No B-frames. HLS muxers can extract DTS without ambiguity. Hikvision firmware emitting Main profile + B-frames is exactly what triggers MediaMTX's `unable to extract DTS` errors. |
| GOP = 2s × fps | Fast packet-loss recovery; sub-second cold-start when a new viewer joins. |
| `-bf 0` | Reinforces baseline — even on encoder presets that would otherwise sneak B-frames in. |
| CBR-ish via `maxrate + bufsize` | Predictable network usage. VBR encoders bursting on scene changes is what kills viewers on tight uplinks. |
| `-c:a copy` | Re-encoding audio adds ~50 ms latency for no quality win on CCTV mics. Skip. |
| `-f rtsp -rtsp_transport tcp` | Match MediaMTX ingest. TCP is the project default for camera→broker. |

## Restart semantics

Per camera, FFmpeg's exit codes the supervisor cares about:

- `0` — clean exit (we sent SIGTERM). Don't restart.
- `non-zero` — crash, network drop, NVENC OpenSession failure, etc. Restart after 5 s.

The 5 s backoff is fixed, not exponential. Exponential makes sense for things you might give up on (e.g. an HTTP service that's down for an hour). A transcoder for a live camera has no point in giving up — if the camera comes back the operator wants the clean stream too.

`stop_requested` is set on `DELETE /transcoders/{id}`. The supervisor checks it after each FFmpeg exit and on the backoff sleep. So a stop takes at most `ffmpeg_restart_backoff_sec` to actually terminate the loop.

## Cross-references

- [README.md](README.md) — what this service is for + when to enable
- [DEPLOYMENT.md](DEPLOYMENT.md) — compose entry, env vars, smoke tests
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common failures + diagnostics
