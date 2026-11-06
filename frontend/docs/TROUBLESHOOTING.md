# smart-cam-app — Troubleshooting

Symptoms → cause → fix.

## 502 Bad Gateway on `/api/ai/*` requests

**Symptom** — Axios errors all over the console, snapshot images don't load, footfall page tiles fail.

**Cause** — Either smart-cam-backend is down OR smart-cam-ai is hung. The frontend can't tell.

**Fix**:
1. Open another tab → `http://localhost:5000/api/health` should return `{ok: true}`. If not, backend is down.
2. If backend is up, `docker logs smart-cam-backend | grep "ECONNREFUSED smart-cam-ai"` indicates the AI service is hung. See `smart-cam-ai/docs/TROUBLESHOOTING.md` for the recovery (typically `docker compose restart smart-cam-ai`).
3. Hard-refresh the tab once both are healthy.

---

## 401 Unauthorized on every request

**Symptoms** — Pages flash content then redirect to `/login`, or every API call returns 401 in the network tab.

**Cause** — JWT expired or the refresh token was revoked.

**Fix** — Re-login. If it keeps happening within minutes:
- Check `JWT_SECRET` on the backend hasn't changed mid-session
- Verify the cookie is being set (`Application > Cookies` in DevTools — look for `refreshToken`)
- Ensure `withCredentials: true` is set on the axios instance ([services/api.js](../src/services/api.js))

---

## Black video on Live View

**Causes (in order of likelihood)**:
1. **MediaMTX path doesn't exist** — `?monitor=<id>` points at a deleted camera. You should see the "That camera isn't available to you" banner; if you don't, the page is on an older revision — hard-refresh.
2. **HLS muxer crash** — MediaMTX's known B-frame issue. Look at `docker logs smart-cam-mediamtx | grep "muxer instance crashed"`. The Footfall page handles this via MJPEG fallback; Live View doesn't yet.
3. **WebRTC negotiation failed** — `chrome://webrtc-internals` will show the PeerConnection state. Common causes: STUN unreachable on a restricted network, ICE candidates expired.
4. **Camera offline** — check the Camera Health page; if status is `offline`, the camera/NVR is unreachable.

---

## "Cannot read properties of null (reading 'play')" in DirectStreamPlayer

**Cause** — Unmount race: the `<video>` element was already removed from the DOM when an async `.play()` resolved.

**Fix** — The player wraps `play()` in a `try/catch` and a mount-check. If you see this in production, ensure the player isn't being remounted on every parent re-render (memoize the `monitorId` prop).

---

## Duplicate-key React warnings

**Symptom** — Console: `Encountered two children with the same key, '1'`.

**Cause** — `.map(item => <X key={item.id} />)` with non-unique `id`s, OR `key={i ?? id}` where both can be the same value.

**Fix** — Composite keys like `key={`${item.id}-${i}`}`. Search for the file/line in the error — both occurrences in `Footfall.jsx` were fixed this way.

---

## HMR not picking up file changes

**Symptoms** — Save a `.jsx` file, no `[vite] hmr update` in `docker logs smart-cam-app`.

**Cause** — chokidar's inotify doesn't propagate through Docker bind mounts on Windows hosts.

**Fix** — Verify in compose:
```yaml
environment:
  CHOKIDAR_USEPOLLING: "true"
  WATCHPACK_POLLING: "true"
```
If they're set and HMR still misses, check the host file watcher quota.

---

## "WebSocket connection failed" in console

**Cause** — Socket.IO can't reach `/socket.io/` on the backend, OR auth handshake failed.

**Fix**:
1. Network tab → look for the WebSocket upgrade request to `/socket.io/?EIO=4&transport=websocket`. Status should be 101.
2. If 401 on handshake → JWT cookie expired; re-login.
3. If `ERR_CONNECTION_REFUSED` → backend is down.

---

## Map tiles don't load

**Symptom** — Map page renders the Leaflet frame but no tiles.

**Causes**:
1. Leaflet CSS not imported — should be in `main.jsx` or the Map page top
2. Network blocking the tile provider (`tile.openstreetmap.org` by default)
3. Tile provider URL typo

**Fix** — Verify `import 'leaflet/dist/leaflet.css'` is present somewhere ancestor of `<MapContainer>`. Check for the tile provider URL in [pages/Map.jsx](../src/pages/Map.jsx).

---

## WebRTC OPTIONS 204 but POST 5xx

**Symptom** — Network tab shows `OPTIONS /cam_<id>/whep → 204` followed by `POST /cam_<id>/whep → 500 / 503`.

**Cause** — MediaMTX's source-on-demand needs ~3-6 s to spin up the underlying RTSP source. Your POST hit before the source was ready.

**Fix** — `WebRTCStream` retries every 4 s on offline state; it usually catches the next window. If it never recovers, the upstream RTSP source is genuinely down.

---

## "snapshot is null" — Alerts thumbnails show placeholder

**Cause** — `AIEvent.snapshotKey` is null on that row. Happens when:
1. Event came from vms_face (not the legacy pipeline) — vms_face doesn't write `snapshotKey`
2. The base64 in `POST /api/internal/ai/events` was missing
3. S3 upload failed silently (caught + logged as `snapshot upload failed (non-fatal)`)

**Fix** — There's an open task to add a backend proxy that streams the JPEG bytes from `payload.snapshot_uri` (vms_face MinIO URI) as a fallback. Until then, the placeholder is correct.

---

## Footfall tile shows "OFFLINE" forever

**Cause** — WebRTC negotiation failed AND MJPEG fallback also failing.

**Fix**:
1. Confirm the camera is enabled for footfall (toggle on)
2. `docker exec smart-cam-backend node -e "require('http').get('http://smart-cam-ai:8001/api/cameras/<monitorId>/snapshot.jpg', r => console.log(r.statusCode))"` — if this 404s, the snapshot cache is empty (orchestrator not running)
3. Check `WebRTCStream` console output for the WHEP error code

---

## EnhanceFaceDialog shows "Enhance failed" with status 502

**Cause** — Either the Node proxy can't reach `face-reconstruct` on port 8002, or the service is crashloop.

**Fix**:
1. `docker ps --filter "name=face-reconstruct"` — running?
2. `docker logs --tail 30 face-reconstruct` — startup errors at the top
3. See `smart-cam-ai/docs/TROUBLESHOOTING.md` for the CodeFormer-specific failures (weight 404s, basicsr ModuleNotFoundError, etc.)

---

## "Stale closure" bugs in useEffect

**Symptom** — A state value inside an effect is from an earlier render.

**Cause** — Missing dependency in the `useEffect` dependency array, OR a function defined in the parent without `useCallback`.

**Fix** — Add the missing dep. If ESLint warns and you genuinely need to skip a dep, leave `// eslint-disable-next-line react-hooks/exhaustive-deps` with a one-line explanation.

---

## Build errors after pulling main

**Symptom** — `npm run build` complains about new shadcn primitives.

**Fix** — `npm install` again. Shadcn primitives may have added new `radix-ui` deps. The lockfile in the repo should be the source of truth.

---

## "Cannot find module '@/…'" in editor

**Cause** — IDE missing the path alias. Vite knows about `@` via [vite.config.js](../vite.config.js); editors need [jsconfig.json](../jsconfig.json) (or `tsconfig.json` if you add TS).

**Fix** — `jsconfig.json` should have:
```json
{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }
```

---

## Where to look first

When something's wrong, in order:
1. Browser DevTools Console — JS errors
2. Browser DevTools Network — failed requests; check status code + response body
3. `docker logs --tail 80 smart-cam-app` — Vite + HMR errors
4. `docker logs --tail 80 smart-cam-backend` — proxy errors
5. The page's components — each one has heavy inline `// why` comments
