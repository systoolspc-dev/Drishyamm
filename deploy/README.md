# Deployment tooling

Everything needed around the core stack (`../docker-compose.yml`) for real
sites. How code gets onto a server (GitHub → pipeline → testing server →
production) is in [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

| Folder | Use it when |
|---|---|
| [`edge-relay/`](#edge-relay) | Cameras sit on a private site LAN the server can't reach (almost every customer site). |
| [`nginx/`](#nginx) | Putting the stack behind one HTTPS origin. |
| [`cloudflared/`](cloudflared/README.md) | Public HTTPS without a public IP or port forwarding. |
| [`gpu-bridge/`](gpu-bridge/README.md) | The server has no GPU and AI should run on a GPU box elsewhere (WireGuard). |
| [`observability/`](#observability) | Prometheus + Grafana + exporters. |
| `.env.production.example` | Template of production secrets (strong datastore passwords etc.); merge into the root `.env`. |

## edge-relay

A PC at the customer site (Windows: `windows/`, macOS: `mac/`) pulls each
NVR channel over the LAN and pushes it **outbound** to this server over
RTSP/TLS. No static IP, port forwarding or router changes at the site; one
installer, self-healing, survives reboots and power cuts. It can also
backfill footage missed during an outage from the NVR's own recordings
(Hikvision / Prama).

**Before handing the package to a site, point it at your server** — the
scripts ship with the old production endpoints:

| File | Variable | Set to |
|---|---|---|
| `windows/drishyam-site-relay.ps1` | `$Cloud` | `<your-server>:8555` |
| `windows/drishyam-site-relay.ps1` | `$Api` | your public console/API URL (missed-footage uploads) |
| `mac/drishyam-mac-relay.sh`, `mac/COPY-PASTE-INTO-MAC-TERMINAL.txt` | `CLOUD` | `<your-server>:8555` |

**Server side:** the Stream Service must accept RTSPS on :8555. Add to
`media/stream-service/mediamtx.yml`:

```yaml
rtspEncryption: "optional"      # plain RTSP for local pulls, TLS for relays
rtspsAddress: :8555
rtspServerKey: /certs/server.key
rtspServerCert: /certs/server.crt
```

then mount a key/cert into `stream-service` (`- ./deploy/certs:/certs:ro`) and
publish `"8555:8555"`. A self-signed certificate is fine — the relays run
ffmpeg with `-tls_verify 0`:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=drishyam" \
  -keyout deploy/certs/server.key -out deploy/certs/server.crt
```

Relayed cameras arrive as paths `edge_<site>_<token>_ch<N>`; the installer
writes `C:\ProgramData\DrishyamRelay\drishyam-cameras.txt` with the exact
names to register in Camera Setup. Operator instructions for the site PC:
`windows/READ ME FIRST.txt`. Pending backend work for the backfill uploads:
[../docs/specs/RELAY_BACKFILL_BACKEND_SPEC.md](../docs/specs/RELAY_BACKFILL_BACKEND_SPEC.md).

## nginx

`nginx/nginx.conf` is the production edge: `/api/` + Socket.IO → backend,
`/live/` → WebRTC (WHEP), `/hls/` → HLS with an auth sub-request to
`/api/stream/verify`, rate limits, JSON logs, metrics endpoints restricted.
Edit `server_name`, the allowed CORS origins map, and the TLS block for your
domain. With nginx in front, set the `PUBLIC_*_URL` values in `.env` to the
nginx origin.

## observability

```bash
docker compose -f docker-compose.yml -f deploy/observability/docker-compose.observability.yml up -d
```

Prometheus :9090, Grafana :3001 (dashboards provisioned from
`observability/grafana/dashboards`), cAdvisor :8080, node / Redis / MySQL /
Postgres exporters. Scrape targets: `observability/prometheus/prometheus.yml`;
alert rules: `observability/prometheus/alerts.yml`.
