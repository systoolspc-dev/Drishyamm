# Cloudflare Tunnel setup — exposing the backend at `api.<domain>`

How to get smart-cam-backend reachable from the public internet through Cloudflare Tunnel, without opening a port on your router.

This is a **standalone** tunnel dedicated to drisyam. It doesn't share state with any other tunnel you already run on this host — each tunnel has its own identity via its own token.

## Why Cloudflare Tunnel (and not nginx + Let's Encrypt)

- **No port forwarding.** The tunnel makes an outbound connection FROM your host TO Cloudflare. Anyone behind a CG-NAT, residential router, or firewall can expose a service.
- **No public IP needed.**
- **Free TLS.** Cloudflare terminates HTTPS; the backend keeps talking HTTP internally.
- **WebSocket-compatible.** Socket.IO + the WS upgrade path passes through.
- **Free tier covers this use case.** Tunnels are unmetered for HTTP.

## Prerequisites

- A domain on Cloudflare (any DNS plan, including Free).
- Repo running locally with `docker compose up`.

## Step 1 — Create the tunnel in the Cloudflare dashboard

1. Go to `https://one.dash.cloudflare.com/` → Zero Trust.
2. Left nav: **Networks → Tunnels**.
3. **Create a tunnel** → choose **Cloudflared** → next.
4. **Name** it `drisyam-api` (anything is fine; this only shows in the dashboard).
5. The install screen shows command snippets for Linux / Windows / macOS. **Ignore those** — we run cloudflared inside docker, not on the host.
6. Copy the **TOKEN** string. It's the long `eyJhIjoi...` blob after `--token`. Treat it like a password.

## Step 2 — Paste the token into `.env`

The compose service reads `CLOUDFLARE_TUNNEL_TOKEN` from the project-root `.env` file.

```sh
# C:\Users\systo\Desktop\anil\drisyam\.env
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...the-whole-blob...
```

If `.env` doesn't exist yet at the repo root, create it.

## Step 3 — Start the tunnel

```sh
docker compose up -d cloudflared
docker logs -f drisyam-cloudflared
```

A healthy tunnel logs:

```
INF Starting tunnel tunnelID=<uuid>
INF Connection <uuid> registered connIndex=0 ip=… location=…
INF Connection <uuid> registered connIndex=1 ip=… location=…
```

If you see `Failed to fetch tunnel credentials: unauthenticated`, the token is wrong. Re-copy it from the dashboard.

## Step 4 — Map a public hostname to the backend

Still in the Cloudflare dashboard, on your tunnel's detail page, **Public Hostnames** tab → **Add a public hostname**:

| Field | Value |
|---|---|
| Subdomain | `api` |
| Domain | `<your-domain>` (pick from dropdown — must be on Cloudflare) |
| Path | (leave empty) |
| Type | **HTTP** |
| URL | `smart-cam-backend:5000` |

Save. Cloudflare automatically:
- Creates a DNS CNAME `api.<your-domain>` → `<tunnel-id>.cfargotunnel.com`
- Routes inbound HTTPS traffic for that hostname through your tunnel
- Terminates TLS at the edge

Test:

```sh
curl -i https://api.<your-domain>/api/health
# → HTTP/2 200
# → {"ok": true}
```

## Step 5 — Add the new origin to `CORS_ORIGINS`

The backend's CORS allow-list lives in `smart-cam-backend/.env`. Add the public origin:

```sh
# smart-cam-backend/.env
CORS_ORIGINS=http://localhost:5173,https://api.your-domain.com,https://app.your-domain.com
```

Restart the backend so the new env value is picked up:

```sh
docker compose restart smart-cam-backend
```

(Or wait for nodemon to pick up an env-file change — sometimes it doesn't, so the explicit restart is safest.)

## Step 6 — Point the frontend at the public API

For local-dev (browser on your machine talking to local backend), nothing changes.

For "operator-on-the-internet talking to your home rig", build the frontend with the public origin baked in:

```sh
# smart-cam-app/.env  (or .env.production)
VITE_API_BASE_URL=https://api.your-domain.com
```

```sh
docker compose restart smart-cam-app
```

Vite picks up `.env*` changes on restart. If you've also exposed the frontend behind `app.<domain>`, that's where operators open the UI.

## Verifying end-to-end

```sh
# 1. Health
curl -i https://api.your-domain.com/api/health

# 2. Auth (should issue a JWT)
curl -i -X POST https://api.your-domain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}'

# 3. Authed call (replace <token>)
curl -i https://api.your-domain.com/api/groups \
  -H "Authorization: Bearer <token>"
```

WebSocket / Socket.IO works automatically — no extra config. Verify:

```js
// In a browser console pointed at https://api.your-domain.com
const s = io('https://api.your-domain.com', { withCredentials: false });
s.on('connect', () => console.log('socket up:', s.id));
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `502 Bad Gateway` from Cloudflare on every call | tunnel reached your host but the backend wasn't on the named hostname | confirm `URL: smart-cam-backend:5000` (not `localhost:5000`) and that the cloudflared container is on the same docker network as smart-cam-backend (default compose network is fine) |
| `Origin … not allowed by CORS` | the public origin isn't in `CORS_ORIGINS` | add `https://api.your-domain.com` to the comma-separated list + restart smart-cam-backend |
| `404 Not Found` from Cloudflare | the public hostname isn't mapped, OR the DNS record didn't propagate | check the Public Hostnames tab; wait ~30 s after creating |
| `unauthenticated` in cloudflared logs | wrong / expired token | re-copy from the tunnel install screen; the token is one-time-shown but you can refresh it under tunnel detail → Configure → Token |
| Socket.IO fails handshake (`xhr poll error`) | CORS again, or the Socket.IO origin list | Socket.IO reuses `CORS_ORIGINS` (see [services/ws.service.js](../src/services/ws.service.js)) — same fix applies |
| Backend doesn't see the real client IP | `trust proxy` not honoured | already set in [src/app.js](../src/app.js) (`app.set('trust proxy', 1)`); confirm by hitting `/api/whoami` (if you have it) or by logging `req.ip` in a temporary middleware |
| Tunnel is up but slow | Cloudflare's free tier routes through the nearest edge — typically a `~20-40ms` overhead | OK for API traffic; for live video consider exposing MediaMTX separately with a paid Argo upgrade |

## Securing the API surface

The tunnel makes the API world-reachable. You probably want more than "anyone with the URL can hit /api/auth/login":

- **Rate limiting** at the Cloudflare edge: Zero Trust → Access → Rate Limiting Rules. Recommended: 100 req/min/IP on `/api/auth/login` to slow credential-stuffing.
- **Cloudflare Access** (Zero Trust SSO): Zero Trust → Access → Applications → Add an application. Restrict who can hit `api.<domain>` by email domain, GitHub login, etc. Useful for the admin panel at `https://api.<domain>/api/admin/*` if you mount it.
- **Bot Fight Mode**: Security → Bots → Bot Fight Mode On. Free tier.

## What this tunnel does NOT do

- **Doesn't expose smart-cam-ai (port 8001).** That's intentional — the AI service has weaker auth (dev-bypass mode in dev). All AI access goes through the backend proxy at `/api/ai/*`, which IS authenticated.
- **Doesn't expose MediaMTX.** Live video stays LAN-only until you explicitly add a `stream.<domain>` mapping (HTTP for HLS on `mediamtx:8888`, separate for WHEP on `mediamtx:8889`). HLS works fine over Cloudflare; WebRTC has caveats — see below.
- **Doesn't expose Postgres / MySQL / Redis / MinIO.** All internal. Cloudflare Tunnel is for HTTP(S) only.

## Running this alongside your other tunnels

Each tunnel is independent. Token = identity. Two tunnels on the same host share zero state.

If you already have a docker-based cloudflared running for another project, the container name `drisyam-cloudflared` won't collide. If you renamed yours to also use that name (unusual), rename the new one in `docker-compose.yml`.

## Updating cloudflared

The image pin is `cloudflare/cloudflared:2025.5.0`. Bump to a newer tag when the project line releases a security fix; cloudflared is generally backward-compatible. After the bump:

```sh
docker compose pull cloudflared
docker compose up -d cloudflared
```
