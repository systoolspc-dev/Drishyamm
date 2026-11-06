# 09 — Troubleshooting

## Live Stream Issues

### Cameras show "Recording" but video doesn't play in browser

1. Check HLS segments exist:
   ```bash
   ls /dev/shm/streams/<SHINOBI_GROUP_KEY>/{monitorId}/
   ```
   - If empty → FFmpeg crashed. Check RTSP connectivity.
   - If has .ts files → frontend/CORS issue.

2. Check RTSP from Shinobi container:
   ```bash
   docker exec drisyam-shinobi ffprobe -v error \
     -rtsp_transport tcp 'rtsp://<user>:<password>@<nvr-ip>:554/Streaming/Channels/101'
   ```

3. Check for Mixed Content error in browser console:
   - URL must use `/shinobi/` proxy path, not direct `http://...8443/`
   - Verify `SHINOBI_PUBLIC_URL` is set in backend `.env`

---

### Camera stream freezes or lags

- **Check codec**: Run `ffprobe` on a `.ts` file to verify it's H.264, not HEVC
   ```bash
   docker exec drisyam-shinobi ffprobe -v error -select_streams v:0 \
     -show_entries stream=codec_name /dev/shm/streams/.../s0.ts
   ```
- **If HEVC**: NVR codec changed back. Fix: update NVR to H.264, or change `stream_vcodec: 'libx264'` in `shinobi.service.js` (will increase CPU load significantly)
- **Check server load**: `top` — should be under 2.0 with H.264 copy mode

---

### Only Camera 1 works, others don't

This happened before when cameras were HEVC. Check codec (see above). Also check:
```bash
# Verify all cameras are Running in Shinobi
curl -s http://localhost:8443/<SHINOBI_API_KEY>/monitor/<SHINOBI_GROUP_KEY> \
  | python3 -c 'import sys,json; [print(m["name"], m.get("status")) for m in json.load(sys.stdin)]'
```

---

### After server reboot, no cameras work

1. Run restore script: `/opt/drisyam/restore-shinobi.sh`
2. Check PM2: `pm2 status`
3. If restore script didn't reconfigure, do it manually:
   ```bash
   TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"test@systools.com","password":"Systools@123"}' \
     | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])')
   GROUP=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/groups \
     | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')
   curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/groups/$GROUP/reconfigure
   ```

---

## Recording / S3 Issues

### Recordings not uploading to S3

1. Check S3 connectivity:
   ```bash
   curl --connect-timeout 10 https://s3.10pb.com/bms-001161
   # Should return <Error>AccessDenied</Error> (means S3 is reachable)
   ```

2. Check if recordings are closing (time_limit set correctly):
   ```bash
   docker exec drisyam-shinobi bash -c "mysql -uroot ccio -e \
     'SELECT name, JSON_EXTRACT(details, \"$.time_limit\") as tl FROM Monitors LIMIT 5;'"
   # Should show 15 for all cameras
   ```
   If NULL → reconfigure cameras (see above)

3. Check sync logs:
   ```bash
   pm2 logs drisyam-backend --lines 200 | grep -i 'upload\|s3\|sync'
   ```

---

### Recordings saved to S3 but not showing in UI

- Check the S3 key format: `recordings/{userId}/{groupName}/{cameraName}/{YYYY-MM-DD}/{filename}`
- The `groupName` and `cameraName` are lowercased and spaces replaced with `-`
- Recording list is cached in Redis for 2 minutes — wait or flush Redis

---

### S3 upload fails with SSL timeout

The 10PB S3 endpoint TLS handshake takes ~7 seconds. Ensure `--max-time` in curl tests is ≥ 15s. In the Node.js AWS SDK, increase timeout in `s3.service.js` if needed.

---

## Backend Issues

### PM2 shows high restart count

```bash
pm2 logs drisyam-backend --lines 50
```

Common causes:
- DB connection failed (MySQL container not running)
- Missing `.env` variable
- Port 5000 already in use

### API returns 401 on valid requests

Token stored in localStorage as `auth_token` (not `token`). Check `authStore.js` and browser localStorage.

---

## Shinobi Issues

### Shinobi UI is blank or shows login loop

MariaDB data was reset. Run: `/opt/drisyam/restore-shinobi.sh`

### Shinobi container keeps restarting

```bash
docker logs drisyam-shinobi --tail 50
```

Check `conf.json` syntax — invalid JSON will crash Shinobi on start.

### Camera 06 missing after restore

Camera 06 must be inserted directly into MariaDB (bypasses 15-camera API limit). The restore script handles this, but if it fails:

```bash
# See 08-shinobi-guide.md for the full INSERT SQL
```

---

## High CPU Load

Normal load with 16 cameras (H.264 copy): **0.3 – 1.0**

If load is high (10+):
1. `top` → look for FFmpeg processes consuming high CPU
2. Check if cameras switched back to HEVC: `ffprobe` on `.ts` file
3. Check `cust_stream` in Shinobi DB — should be empty string
   ```bash
   docker exec drisyam-shinobi bash -c "mysql -uroot ccio -e \
     'SELECT JSON_EXTRACT(details, \"$.stream_vcodec\"), JSON_EXTRACT(details, \"$.cust_stream\") FROM Monitors LIMIT 3;'"
   ```
4. Reconfigure cameras if settings are wrong

---

## Nginx Issues

### 502 Bad Gateway on `/api/`

Backend is down. Check: `pm2 status` → restart if needed: `pm2 restart all`

### 502 on `/shinobi/`

Shinobi container is down. Check: `docker ps` → restart: `docker compose restart shinobi`

After Shinobi restart: run `/opt/drisyam/restore-shinobi.sh`
