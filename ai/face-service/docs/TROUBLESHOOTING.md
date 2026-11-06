# smart-cam-ai — Troubleshooting

Symptoms → likely cause → fix. Most of these are scars from real bugs we hit; the fix line is the proven recovery, not a guess.

## AI service hangs (502 from the Node proxy)

**Symptom** — Every `/api/ai/*` call returns 502, occasionally recovers, occasionally doesn't.

**Likely cause** — uvicorn was launched with `--reload` and its child process crashed; the supervisor stays alive holding port 8001 but the worker is dead so requests time out.

**Fix** — Confirm `docker-compose.yml`'s `smart-cam-ai` command does NOT contain `--reload`. The PID 1 inside the container should be `uvicorn vms_face.api.main:app …` (no reload). If you need hot-reload for dev, do it outside the container.

**Verify** — `docker exec smart-cam-ai sh -lc 'cat /proc/1/cmdline | tr "\0" " "'`. No `--reload` in the output.

---

## Detection boxes don't appear on AiFeed

**Symptom** — Cameras are streaming (MediaMTX shows traffic), but the live feed has no orange/green bbox overlays.

**Likely causes (in order)**
1. SCRFD threshold too high → no faces detected. `INSIGHTFACE_DET_THRESHOLD=0.7` is our default; if a low-light camera sees nothing, drop to 0.5 just for that test.
2. Orchestrator never started for that camera. Check `GET /status` — `cameras.<monitor_id>.running` should be true.
3. Stream open failed (RTSP 404 from MediaMTX). Logs say `stream open failed err='…Server returned 404 Not Found…'`. MediaMTX's source-on-demand hasn't fired yet — give it 10 s, or restart that camera via the backend.

---

## "Camera 05" always shows up regardless of which person is clicked

**Symptom** — Personnel Search → Live always lands on the same camera.

**Cause** — Old bug, both sides. (a) The frontend used `people[0].monitorId` for the side-panel Live button (no selection state). (b) LiveView silently fell back to "first online camera" when the deep-link monitor wasn't in `useGroups()`.

**Fix** — Already shipped: PersonnelSearch click-to-select + LiveView's "That camera isn't available to you" banner. If a deep link lands on the banner, the personnel API is returning a `last_camera_code` that's not in the user's MySQL `cameras.monitor_id` — that's a cross-DB mapping issue, fix on the backend.

---

## Footfall counts stuck at zero

**Symptoms** — Camera is enabled (toggle on), the orchestrator is healthy, but `today.in / today.out` stays 0.

**Most common cause** — the person/face tracker never sees the counting line crossed. The line is at `line_y_frac` (default 0.6 = 60% from top). If your camera is mounted high and faces show up only in the top half of the frame, faces never cross 60% Y.

**Fix** — Open the Footfall page → click the camera → drag the line slider until it sits where people actually walk through the frame.

**Other causes**
- `PIPELINE_PERSON_DETECTION_ENABLED=false` AND no faces visible (back-of-head walkers). The fallback feeds face boxes to the counter, but if SCRFD doesn't see them either, nothing crosses. Fix: enable YOLOv8 person detection.
- The `last_update_age_sec` field on `/footfall/cameras` is `null` → registry hasn't been called for that camera. Likely the orchestrator for that camera isn't running.

---

## Postgres deadlock on track_links

**Symptom** — match worker logs `asyncpg.exceptions.DeadlockDetectedError` on `INSERT INTO track_links`. Worker keeps retrying.

**Cause** — Multiple ReID worker replicas trying to insert overlapping (a_track, b_track) tuples in opposite order, conflicting on the unique index.

**Fix** — Reduce ReID concurrency, or order the pair so the inserter always uses `min(a, b)` first. Currently lives with retries since the workload is sparse; revisit when alerts pile up.

---

## Empty match results despite enrolled faces

**Symptom** — operator says "I'm in the gallery but I show as Unknown". Logs say `match_worker_processed{outcome="ok"}` is incrementing.

**Diagnostic checklist**
1. `MATCH_MIN_FACE_PX` — if your face is small in frame, raise SCRFD's input size (`INSIGHTFACE_DET_SIZE` 960 → 1280) or drop `MATCH_MIN_FACE_PX` 40 → 20.
2. `MATCH_MIN_QUALITY` — if your face is blurry, drop 0.45 → 0.35.
3. `INSIGHTFACE_REC_THRESHOLD` — ArcFace cosines sit around 0.55-0.70 for same-identity; if yours is 0.50 you'd be filtered out. Drop 0.45 → 0.40.
4. Re-enrollment — if you re-trained or changed recognizer backend, the existing Qdrant vectors are from the old encoder. Delete the collection + re-bootstrap.
5. `TRACK_MIN_HITS_TO_MATCH=4` requires 4 frames of the same track before publishing. At 8 fps that's 0.5 s of sustained visibility — if you walked by quickly you may not have had 4 quality-passing observations.

---

## "frame read timed out" then RTSP 404 loop

**Symptom** — Orchestrator logs `stream consume error; reopening` then `Server returned 404 Not Found: 'rtsp://mediamtx:8554/cam_…'`.

**Cause** — MediaMTX's source-on-demand handler timed out connecting to the upstream camera, dropped the path. Our PyAV reader saw the disconnect and reopened, but the path was already gone.

**Fix** — Patience. Source-on-demand re-instantiates the path on next subscribe; the orchestrator's reopen-with-backoff (`PIPELINE_RTSP_REOPEN_*`) handles it. If it never recovers, the upstream camera is genuinely down — check the camera ARP/ping.

**Knobs** — `PIPELINE_FRAME_TIMEOUT_SEC` (15 by default) controls how long we wait for a frame before declaring the stream stalled. Increase only if you have known long-GOP cameras.

---

## NumPy import warning at startup

```
UserWarning: Failed to initialize NumPy: _ARRAY_API not found
```

**Cause** — Torch in the pytorch/pytorch conda image was built against NumPy 1.x; the conda env ships NumPy 2.x. Harmless — runtime tensor ops still work.

**Fix** — Ignore, OR pin `numpy<2` in the affected requirements file. We leave it because fixing it requires reshuffling deps and no measured impact.

---

## "Invalid XML Content" on Hikvision Boost (camera encoder)

This is in `smart-cam-backend`, not here, but operators bring it up. See `smart-cam-backend/docs/TROUBLESHOOTING.md`. Short version: NVR-attached channels reject `<maxFrameRate>0 → N` overwrites. The writer now skips that field when current value is 0.

---

## CodeFormer / Real-ESRGAN service won't start

**Symptom** — `face-reconstruct` container in `Restarting` loop.

**Likely causes**
1. **Weight download 404** — `RealESRGAN_x2plus.pth` was missing in v0.2.5.0 release; the entrypoint now points at v0.2.1 + marks Real-ESRGAN weights as optional (pipeline degrades gracefully without bg upsampling).
2. **`ModuleNotFoundError: basicsr.data.prefetch_dataloader`** — CodeFormer's vendored basicsr fork is missing pieces. Patched in two places:
   - `backend/app/pipeline.py` — `sys.modules['basicsr.data.prefetch_dataloader'] = MagicMock()` before the basicsr import.
   - `Dockerfile` — writes a `basicsr/version.py` stub at image-build time (`__version__='1.4.2'; __gitsha__='0'*40; version_info=(1,4,2)`).
3. **Container OOM** — `docker stats face-reconstruct`; if memory near 100% at startup, the conda image needs more RAM. We've seen ~8 GB peak.

**Logs to look at** — `docker logs face-reconstruct 2>&1 | head -100` — startup errors are at the top, weight URLs in the middle, FastAPI Uvicorn at the bottom.

---

## Snapshot endpoint returns 404 for a camera

**Symptom** — `GET /api/cameras/<monitor_id>/snapshot.jpg` returns 404.

**Cause** — `SnapshotCache` is per-orchestrator-process and only populates when the orchestrator processes a frame. If the camera was never enabled OR the orchestrator just started OR the camera was removed (entrypoint calls `cache.forget(camera_code)` on shutdown), there's no cached frame.

**Fix** — Wait for the orchestrator to process the first frame (~1 s after RTSP opens). If it never lands, check that the camera is in MediaMTX (`GET http://localhost:9997/v3/paths/list`) AND the orchestrator's `running:true` in `/status`.

---

## Recurring 502 on /api/ai/footfall/cameras even though AI is up

**Symptom** — Node logs `socket hang up` or `read ECONNRESET` for `/footfall/cameras`. AI's `/status` returns 200 in <50 ms direct.

**Cause** — Brief asyncio loop stalls inside the API process while heavy work runs (YOLOv8 inference, Qdrant flush, alembic startup migration). Requests during the stall window time out.

**Fix** — Verify nothing CPU-bound runs on the event loop thread:
- All `cv2.imencode` calls go through `loop.run_in_executor(get_io_pool(), …)`.
- All Qdrant calls are awaited (the client is async).
- The startup `alembic upgrade head` runs to completion before uvicorn binds.

If you write a new endpoint, never put a `time.sleep` or a blocking `requests.get` in it.

---

## Drainage / DLQ inspection

```sh
# All pending entries in the match worker's consumer group
docker exec smart-cam-redis redis-cli XPENDING vms.detections match-workers

# Inspect the DLQ
docker exec smart-cam-redis redis-cli XRANGE vms.detections.dlq - +

# Drop one bad entry (note the ack happens automatically when XADD replays elsewhere)
docker exec smart-cam-redis redis-cli XACK vms.detections match-workers <entry-id>
```

---

## Where to look first

When something's wrong, in order:

1. `docker ps --filter "name=smart-cam-ai"` — is the container alive?
2. `docker logs --tail 80 smart-cam-ai` — startup errors + recent warnings
3. `GET http://localhost:8001/healthz` — auth posture + Redis + active streams
4. `GET http://localhost:8001/status` — per-camera running + fps + error string
5. `GET http://localhost:8001/streams/debug` — per-orchestrator stats (frames decoded, observation total, last seen)
6. Prometheus at `:8001/metrics` — `queue_depth`, `match_worker_processed_total`, `detections_total`
