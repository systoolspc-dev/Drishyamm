# Cloudflare tunnel (optional)

Publishes the console and API over HTTPS through Cloudflare, with no public
IP or port forwarding. Started with `docker compose --profile tunnel up -d`.

One-time setup on the host (needs the `cloudflared` CLI and a domain on
Cloudflare):

```bash
cloudflared tunnel login                       # writes cert.pem
cloudflared tunnel create drishyam             # writes <tunnel-uuid>.json
cloudflared tunnel route dns drishyam api.example.com
cloudflared tunnel route dns drishyam app.example.com
```

Copy `cert.pem` and `<tunnel-uuid>.json` into `deploy/cloudflared/credentials/`
(git-ignored) and create `credentials/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /etc/cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: api.example.com
    service: http://smart-cam-backend:5000
  - hostname: app.example.com
    service: http://smart-cam-app:5173
  - service: http_status:404
```

The `credentials-file` path is the **container** path (`/etc/cloudflared`).
Then set `PUBLIC_API_URL=https://api.example.com`,
`PUBLIC_APP_URL=https://app.example.com` and add both to `CORS_ORIGINS` in
the root `.env`. To add a hostname later: add an ingress line, `cloudflared
tunnel route dns …`, restart the `cloudflared` container.

`CLOUDFLARED_DIR` / `CLOUDFLARED_CONFIG` in `.env` point elsewhere if the
credentials already live on the host (e.g. `~/.cloudflared`).

Live video (WebRTC) does not traverse the tunnel well; for remote viewers
either expose 8889/8189 directly, use HLS (`/hls/` through nginx), or run a
TURN server ([../../docs/COTURN-DEPLOYMENT.md](../../docs/COTURN-DEPLOYMENT.md)).
