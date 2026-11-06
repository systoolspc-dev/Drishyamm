# smart-cam-backend — Troubleshooting

Common symptoms → likely cause → proven fix.

## 502 Bad Gateway on every `/api/ai/*` call

**Cause** — smart-cam-ai is unreachable or hanging.

**Fix order**:
1. `docker ps --filter "name=smart-cam-ai"` — is the container alive?
2. `docker exec smart-cam-backend node -e "require('http').get('http://smart-cam-ai:8001/status', r => console.log(r.statusCode))"` — does the network path work from inside the backend?
3. If smart-cam-ai is alive but unresponsive, restart it: `docker compose restart smart-cam-ai`. See `smart-cam-ai/docs/TROUBLESHOOTING.md` for the underlying hang patterns.
4. After ~30s the proxy should recover. If not, check `docker logs smart-cam-backend | grep "ECONNREFUSED\|ECONNRESET\|timeout"`.

---

## 401 Unauthorized on every endpoint

**Causes (in order)**
1. **JWT_SECRET changed** — every existing token is invalid. Users need to re-login. The cookie will redirect to /login automatically; if it doesn't, clear cookies.
2. **JWT_SECRET unset** — the service exits at boot. Check `docker logs smart-cam-backend | head -20` for `JWT_SECRET is required`.
3. **Clock skew between client and server** — JWT iat/exp check fails. Sync the host clock.

---

## 502 from `/api/ai/enhance` (CodeFormer)

**Cause** — `face-reconstruct` service is restarting or down.

**Fix**:
1. `docker ps --filter "name=face-reconstruct"` — running?
2. `docker logs --tail 50 face-reconstruct` — common failures:
   - `wget ERROR 404` on weight download → check entrypoint URLs (Real-ESRGAN x2plus is at v0.2.1, NOT v0.2.5.0)
   - `ModuleNotFoundError: basicsr.data.prefetch_dataloader` → the `pipeline.py` mock list is incomplete; add the missing module
   - `ModuleNotFoundError: basicsr.version` → the Dockerfile's `version.py` stub didn't get written; rebuild
3. Test directly: `docker exec smart-cam-backend node -e "require('http').get('http://face-reconstruct:8002/health', r => console.log(r.statusCode))"` should print 200.

---

## S3 upload timeouts

**Symptoms** — recording upload retries up to 3 times then fails with `ECONNRESET` or `ETIMEDOUT`.

**Likely causes**
1. **S3 endpoint unreachable** — `S3_ENDPOINT` typo or NetForChoice maintenance. Probe with `curl https://s3.10pb.com`.
2. **Wrong bucket name** — `S3_BUCKET` must exist and be writable by `S3_ACCESS_KEY`.
3. **Clock skew** — AWS-style signatures reject requests where the client clock differs by >15 min.
4. **Large file** — files >5 MB use multipart; if a part fails, the multipart abort runs. Look for `Multipart upload aborted` in logs.

**Fix** — `docker exec smart-cam-backend node -e "const s3=require('./src/services/s3.service'); s3.exists('test').then(console.log)"` to verify connectivity inline.

---

## "Could not GET any video-encoder endpoint" (Boost button)

**Symptom** — `POST /api/groups/:groupId/cameras/:monitorId/encoder` returns 502 with `error: 'could not GET any video-encoder endpoint (paths tried: …)'`.

**Cause** — The camera's HTTP API doesn't expose any of the three Hikvision paths we try:
- `/ISAPI/Streaming/channels/{N01}`
- `/ISAPI/ContentMgmt/StreamingProxy/channels/{N01}`
- `/ISAPI/ContentMgmt/InputProxy/channels/{N}/video`

This happens on:
1. Non-Hikvision cameras misregistered as `deviceType=hikvision`
2. Hikvision firmwares that gate HTTP behind a different vhost or port
3. Camera offline / wrong HTTP port (most groups use 80, some firmwares use 8000)

**Fix** — Use `GET /api/groups/:groupId/cameras/:monitorId/encoder-debug` to inspect the raw XML the camera returns at each path. If none returns 200, the device isn't Hikvision (try `deviceType=onvif`) or the HTTP credentials are wrong.

---

## "Invalid XML Content" returned by Hikvision Boost

**Symptom** — Encoder write reports `statusCode 6 / statusString "Invalid XML Content"`.

**Known cause** — NVR-attached channels reject `<maxFrameRate>0 → N` overwrites. The writer now skips that field when current value is 0 (see `setHikvisionEncoder()` in `services/deviceProbe.service.js`).

**If you see it again on a new firmware** — log the GET response body BEFORE the mutation, find the element your XML changed, and add a vendor-specific guard. Don't blindly mutate every encoder element — Hikvision firmware validates internal consistency.

---

## MediaMTX path returns 404

**Symptom** — Recording or live preview fails with `404 Not Found: 'rtsp://mediamtx:8554/cam_<monitorId>'`.

**Cause** — MediaMTX was restarted; source-on-demand paths only exist while a subscriber is connected.

**Fix order**:
1. `docker exec smart-cam-mediamtx wget -qO- http://localhost:9997/v3/paths/list` — does the path exist?
2. If no, MediaMTX dropped it. The backend's `streamSupervisor` should recreate it within ~10 s.
3. If it still 404s after 30 s, manually recreate: `POST http://localhost:9997/v3/config/paths/add/cam_<monitorId>` with the right source URL. See `services/mediamtx.service.js` for the exact body.
4. As a last resort, restart smart-cam-backend so the supervisor re-registers all cameras.

---

## nodemon not reloading on file changes

**Symptom** — Edit a `.js` file under `src/`, no `[nodemon] restarting` log.

**Cause** — chokidar inotify doesn't always work through Docker bind mounts on Windows hosts.

**Fix** — Confirm the env vars are set in the compose service:
```yaml
environment:
  CHOKIDAR_USEPOLLING: "true"
```
(They are by default. If you removed them, that's the bug.)

---

## bcrypt build errors on `npm install`

**Symptom** — `npm install` fails with `Cannot find module 'bcrypt'` or native build errors.

**Fix** — We use `bcryptjs` (pure JS), NOT `bcrypt` (native). Search the codebase: every import should be `require('bcryptjs')`. If you find a `require('bcrypt')`, switch it.

---

## Foreign key constraint violation on Camera delete

**Symptom** — `DELETE /api/cameras/:id` returns 500 with a Sequelize FK error.

**Cause** — Related rows in `ai_events` or `face_enrollments` etc. don't cascade. Sequelize migrations need explicit `onDelete: 'CASCADE'`.

**Fix** — Either (a) delete the dependent rows first in the controller, or (b) write a migration that adds the cascade to the existing FK. We've punted on this — cleanest fix is a new migration; quickest fix is to soft-delete cameras (`is_deleted` flag) and filter at read time.

---

## Refresh token rotation breaks login

**Symptom** — Operator logs in, then within 30 days the access token expires and refresh hits 401.

**Cause** — The refresh token in MySQL was revoked OR the cookie was cleared.

**Fix** — Operator re-logs in. If this happens to many users at once, check:
1. MySQL crashed / lost the `refresh_tokens` table — Sequelize would have logged a sync error at boot.
2. `JWT_SECRET` changed — invalidates everything; expected behavior.

---

## Service-token-authed routes return 401

**Symptom** — smart-cam-ai trying to POST to `/api/internal/ai/events` gets 401.

**Cause** — `X-Service-Token` mismatch.

**Fix** — Both services read `SERVICE_TOKEN` from env. Compare:
- `docker exec smart-cam-backend env | grep SERVICE_TOKEN`
- `docker exec smart-cam-ai env | grep SERVICE_TOKEN`

They must match. We use a long random string set in `.env` at the repo root.

---

## Stream supervisor pegs CPU at 100%

**Symptom** — `top` shows `node` at 100% on the backend host, supervisor logs filling at >1 line/sec.

**Cause** — Network round-trip to MediaMTX taking >2 s, the supervisor loop overlaps itself.

**Fix** — Increase the supervisor interval (`STREAM_SUPERVISOR_INTERVAL_MS` env, default 2000) or check why MediaMTX's `/v3/paths/list` is slow (likely too many paths; consider pagination or a smaller MAX_PATHS).

---

## Logs to read first

```sh
docker logs --tail 100 smart-cam-backend                              # boot + recent
docker exec smart-cam-backend tail -f /app/logs/combined.log          # Winston combined
docker exec smart-cam-backend tail -f /app/logs/error.log             # errors only
```

Winston rotates daily. The compose volume mounts `./smart-cam-backend/logs` so you can read them from the host too.
