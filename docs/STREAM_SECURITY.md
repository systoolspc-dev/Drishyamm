# Live Stream Security (audit H9)

## The problem

The **URL discovery** step is authenticated — `GET /api/stream/start/:monitorId`
checks `Camera.userId === req.user.id`, so a user can only get URLs for cameras
they own (per-account isolation at the API layer). **But the media plane is
not:**

- `mediamtx.yml` allows `user: any` `action: read` → MediaMTX serves any stream anonymously.
- nginx `/hls/` and `/live/` just proxy to MediaMTX — no auth, no token, no expiry.

So once a `cam_<monitorId>` URL leaks (shared link, log, browser history, a
former employee), **anyone who can reach the host can watch that camera's live
feed forever, unauthenticated** — and the API-layer ownership check is bypassed.

## The fix (implemented, gated OFF by default)

A short-lived **per-camera signed token**, minted only for the owner, carried as
a same-origin cookie the browser sends on every segment/WHEP request, and
validated at the edge by nginx `auth_request` → backend `/api/stream/verify`.

```
Owner opens camera ─► GET /api/stream/start/:id   (JWT; owner-only)
                        └─ mints token = HMAC(secret, "monitorId:expires")
                        └─ Set-Cookie: st_<id>=<token>.<expires>  (httpOnly, short TTL)
Browser fetches media ─► /hls/cam_<id>/seg.ts   (cookie rides along, same-origin)
   nginx auth_request ─► /api/stream/verify   (reads X-Original-URI + cookie)
        backend verify ─► 204 allow / 401 deny   (HMAC check + expiry)
```

- **Protects** the media plane: no valid unexpired token → 401 (H9 closed).
- **Per-camera isolation**: token is bound to `monitorId` — a token for one
  camera can't play another.
- **Per-account isolation**: the token is only ever minted for the camera's
  owner (issuance is `userId`-scoped), so a non-owner can never obtain one. (The
  token util also supports binding to `userId` for defense-in-depth.)

### Why a cookie (not a query token)

HLS segment URLs are relative — a token on the playlist URL does **not**
propagate to `.ts` segment requests. A path-`/` same-origin cookie is sent
automatically on every segment + WHEP request, which is the clean way to gate
HLS. (Cross-origin media would need `SameSite=None; Secure` + `withCredentials`.)

## Enabling it (needs a runtime — verify playback survives)

1. **Set a strong secret** in the backend (git-ignored `.env`):
   ```
   STREAM_URL_SECRET=<openssl rand -base64 32>
   STREAM_URL_TTL_SEC=3600     # token lifetime; refreshed on each stream-start
   ```
   Until this is set, `/api/stream/verify` returns 204 (allow) and no cookie is
   minted — current behavior is unchanged.

2. **Enable the nginx gate**: in `nginx.conf`, uncomment `auth_request /_stream_auth;`
   in **both** `location /hls/` and `location /live/`, then:
   ```
   nginx -t && nginx -s reload
   ```

3. **Smoke-test** (this is the runtime step I can't do from source):
   - Log in, open a camera — HLS + WebRTC must still play.
   - Grab the `/hls/cam_<id>/index.m3u8` URL, open it in a **fresh
     incognito window with no cookie** → must now 401 (was 200).
   - Wait past `STREAM_URL_TTL_SEC` without re-starting the stream → segments
     should 401 until the player re-calls `/api/stream/start` (which re-mints).

## Notes / trade-offs

- **Scale:** `auth_request` adds one backend subrequest per media request. At
  large fan-out prefer nginx-local **`secure_link`** (no backend call) — the
  token util can be adapted to nginx's md5 format; documented as a follow-up.
- **Same-origin assumption:** the cookie works because nginx serves `/api`,
  `/hls`, `/live` on one host. If media moves to a different origin, switch the
  cookie to `SameSite=None; Secure` and set `withCredentials` in hls.js.
- **TTL vs long views:** the player re-hits `/api/stream/start` on
  (re)connect, which re-mints the cookie; for multi-hour unattended views,
  raise `STREAM_URL_TTL_SEC` or add a periodic silent re-mint.
- **Defense in depth:** also set `MediaMTX` read auth away from `any` in
  `mediamtx.yml` (e.g., an internal reader user) once the edge gate is proven,
  so a direct hit to `:8888/:8889` (bypassing nginx) isn't anonymous either.
