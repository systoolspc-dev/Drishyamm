# coturn — TURN server deployment for drisyam (Phase 1.4)

This doc walks an operator through deploying coturn on `103.109.7.37` so WebRTC works behind corporate firewalls, restrictive home routers, and CG-NAT'd mobile networks. **The backend + frontend code is already shipped** (Phase 1.4 a/b/c) — when the env vars below are set, the SPA picks up TURN automatically.

Estimated time: **45 minutes** end-to-end, most of it waiting for DNS to propagate.

---

## What's already in code (no changes needed)

| File | Role |
|---|---|
| [smart-cam-backend/src/controllers/turn.controller.js](../backend/src/controllers/turn.controller.js) | Mints HMAC-SHA1 REST creds matching coturn's `use-auth-secret` scheme. Returns `{ available: false }` when TURN_URI + TURN_SHARED_SECRET unset. |
| [smart-cam-backend/src/routes/turn.routes.js](../backend/src/routes/turn.routes.js) | `GET /api/turn/credentials`, JWT-gated. Mounted at `/api/turn/*`. |
| [smart-cam-backend/src/config/env.js](../backend/src/config/env.js) | Schema for `TURN_URI`, `TURN_URI_TLS`, `TURN_SHARED_SECRET`, `TURN_TTL_SEC`. |
| [smart-cam-app/src/services/turnCredentials.js](../smart-cam-app/src/services/turnCredentials.js) | Frontend fetcher + in-flight de-dupe + cache-until-near-expiry. |
| [smart-cam-app/src/services/streamRegistry.js](../smart-cam-app/src/services/streamRegistry.js) | Every WebRTC `negotiate()` awaits `getIceServers()` so TURN flows in transparently. |

You don't touch any of these. The only moves are: install coturn, set env, restart backend.

---

## Step 1 — Server prep

SSH to the prod server.

```sh
ssh root@103.109.7.37 -p 35610
```

Generate a strong shared secret (used by both coturn and the backend). 32 bytes base64 is plenty.

```sh
openssl rand -base64 32
# example output:
# qS3vJ8a/Z9R4xV7hP1nKmYwL2gU6yT0iC5oE+M3dHfA=
```

**Save this value.** You'll paste it into two places: coturn's config + the backend's `.env`.

---

## Step 2 — DNS

Add an A record:
```
turn.indyatools.com   A   103.109.7.37   (TTL 300)
```

Verify before continuing:
```sh
dig +short turn.indyatools.com
# expected: 103.109.7.37
```

Don't proceed until DNS resolves — coturn's TLS cert provisioning depends on it.

---

## Step 3 — Open firewall ports

coturn needs:

| Port | Protocol | Purpose |
|---|---|---|
| 3478 | UDP + TCP | STUN/TURN (primary) |
| 5349 | TCP | TURN over TLS (corporate-firewall fallback) |
| 49152-65535 | UDP | Relay range — the actual media bytes |

If using `ufw`:

```sh
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/tcp
ufw allow 49152:65535/udp
ufw reload
```

The relay range is intentionally wide — coturn picks an ephemeral port per session. Narrow it only if you have a downstream cost concern; even at 1k concurrent sessions you'd only use ~1k ports.

---

## Step 4 — Install coturn

Two options. Docker is simpler + matches the rest of the stack; native install is what most coturn docs assume.

### Option A — Docker (recommended)

Append to `/opt/turn/docker-compose.yml`:

```yaml
services:
  coturn:
    image: coturn/coturn:4.6.3
    container_name: drisyam-coturn
    restart: unless-stopped
    network_mode: host    # coturn binds many UDP ports; host net is the simplest path
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
    command: ["-c", "/etc/coturn/turnserver.conf"]
```

`turnserver.conf` (next to the compose file):

```ini
# coturn configuration for drisyam — Phase 1.4

# REST-API auth (use-auth-secret scheme). Matches what the backend mints.
use-auth-secret
static-auth-secret=PASTE_TURN_SHARED_SECRET_HERE

# Ports
listening-port=3478
tls-listening-port=5349

# External-IP — what coturn advertises in relay candidates. Without this
# coturn returns its container/private IP and clients can't reach the relay.
external-ip=103.109.7.37
relay-ip=103.109.7.37

# Realm — appears in coturn logs + telemetry; any string works.
realm=drisyam

# TLS (recommended — gets us turns:5349 for clients behind aggressive firewalls)
cert=/etc/coturn/cert.pem
pkey=/etc/coturn/key.pem
# cipher-list=...  # leave default; openssl picks sane suites

# Relay port range — must match the firewall rules above.
min-port=49152
max-port=65535

# Lock down
no-multicast-peers
no-tlsv1
no-tlsv1_1
fingerprint
no-loopback-peers
no-cli                 # disable telnet admin port

# Bandwidth cap — protect us from a runaway client. 5 Mbps per session
# is generous for live video; 0 = unlimited.
user-quota=5000

# Total relay bandwidth ceiling, kbps. 200 Mbps total — adjust for your
# uplink. Without this, a single client storm can saturate the uplink.
total-quota=200000

# Logging
log-file=/var/log/coturn/coturn.log
verbose
```

Bring it up:

```sh
cd /opt/turn
docker compose up -d coturn
docker compose logs -f coturn
```

You should see `RFC 5780 response on UDP 0.0.0.0:3478` and `IPv4. Relay port range: 49152 to 65535`.

### Option B — apt

```sh
apt update && apt install coturn -y
# edit /etc/turnserver.conf with the same config as above
systemctl enable --now coturn
systemctl status coturn
```

Difference vs Docker: cert paths typically live in `/etc/letsencrypt/...`; firewall and netplan rules apply directly.

---

## Step 5 — TLS cert (for `turns:5349/tcp`)

Without TLS, only `turn:3478` works — corporate firewalls that block UDP entirely will still fail. The TLS endpoint over TCP 5349 gets you those clients back.

Quickest path: certbot standalone.

```sh
apt install certbot -y
certbot certonly --standalone -d turn.indyatools.com
# cert ends up at /etc/letsencrypt/live/turn.indyatools.com/{fullchain,privkey}.pem
```

Symlink them into the coturn volume (Docker option):

```sh
ln -s /etc/letsencrypt/live/turn.indyatools.com/fullchain.pem /opt/turn/cert.pem
ln -s /etc/letsencrypt/live/turn.indyatools.com/privkey.pem  /opt/turn/key.pem
docker compose restart coturn
```

Auto-renewal is on by default via systemd timer; coturn picks up the new cert on next read.

---

## Step 6 — Verify TURN itself

There's a public Trickle ICE test page from Google that probes any iceServer entry: <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>

Fill in:
- STUN/TURN URI: `turn:turn.indyatools.com:3478?transport=udp`
- TURN username + credential: leave empty (the test page mints its own static creds, which our coturn will reject — that's fine, we're verifying connectivity)

Click *Add Server* → *Gather candidates*. You're looking for at least one `relay` candidate type. A `relay` row = TURN is working. If you only see `host` and `srflx`, the relay path is broken (firewall, NAT, coturn misconfigured).

Better: use coturn's own `turnutils_uclient` against your server with real REST creds. Coming in Step 8.

---

## Step 7 — Backend env

On YOUR machine (where the backend container runs), edit `smart-cam-backend/.env`:

```sh
# ── TURN / coturn ────────────────────────────────────────────────────────
TURN_URI=turn:turn.indyatools.com:3478?transport=udp
TURN_URI_TLS=turns:turn.indyatools.com:5349?transport=tcp
TURN_SHARED_SECRET=qS3vJ8a/Z9R4xV7hP1nKmYwL2gU6yT0iC5oE+M3dHfA=
TURN_TTL_SEC=3600
```

Restart the backend so the new env loads:

```sh
docker restart smart-cam-backend
```

---

## Step 8 — End-to-end verify

From a logged-in operator browser:

```js
// In the browser console (any drisyam page after login):
fetch('/api/turn/credentials').then(r => r.json()).then(console.log);
// Expected:
// {
//   available: true,
//   iceServers: [
//     { urls: 'stun:stun.l.google.com:19302' },
//     { urls: ['turn:turn.indyatools.com:3478?transport=udp',
//              'turns:turn.indyatools.com:5349?transport=tcp'],
//       username: '1716950400:user-uuid',
//       credential: '...' }
//   ],
//   username: '1716950400:user-uuid',
//   expiresAt: '2026-05-29T07:00:00.000Z'
// }
```

If `available: false` — the env didn't pick up. Check `docker exec smart-cam-backend printenv | grep TURN`.

Then open Live View. In another tab, watch coturn logs:

```sh
docker logs -f drisyam-coturn   # or: tail -f /var/log/coturn/coturn.log
```

You should see lines like:
```
session 12345: new, username <expiry>:<userid>, lifetime 3600
session 12345: peer 198.51.100.42:51234 allocated, relay 103.109.7.37:54312
```

If you see "session 401" or auth failures, the shared-secret in coturn doesn't match `TURN_SHARED_SECRET` in the backend.

---

## Step 9 — Behaviour expectations

After deployment:

- Clients on **healthy networks**: WebRTC still negotiates direct or via STUN. TURN is *available* but not used. No latency added.
- Clients **behind NAT but with UDP allowed**: same — STUN-srflx works.
- Clients **behind a firewall blocking UDP** (corporate, hotel, some carrier WiFi): WebRTC falls back to `turns:5349/tcp`. Adds ~50-200 ms one-way; functional vs broken.
- Clients **with all outbound blocked except 80/443**: still fail. They'd need TURN listening on 443/TCP itself, which requires standing coturn up with `tls-listening-port=443` (and giving up the port for everything else). Defer to Phase 4 if needed.

---

## Monitoring

coturn exposes Prometheus metrics if compiled with `--enable-prometheus` (the Docker image we pin has it).

Add to `observability/prometheus/prometheus.yml`:

```yaml
  - job_name: coturn
    static_configs:
      - targets: ['turn.indyatools.com:9641']    # default Prometheus port
        labels: { service: turn }
```

Useful metrics:
- `coturn_allocations_total{result="success"}` — successful TURN allocations
- `coturn_traffic_rcvp_bytes_total` — relay bandwidth
- `coturn_sessions_total` — concurrent active sessions

A Grafana panel that ratios `allocations{result="success"} / allocations` shows you the auth success rate. Falling = shared secret drift or expired creds being reused.

---

## Bandwidth cost model

For each TURN-relayed viewer at 2 Mbps WebRTC: 2 Mbps in + 2 Mbps out = **4 Mbps total on the coturn server**.

| Scenario | Cost |
|---|---|
| 1 operator behind a firewall | 4 Mbps per camera tile |
| 9-camera grid view, 1 firewalled operator | 36 Mbps |
| 10 firewalled operators, 9 cameras each | 360 Mbps |

The total-quota=200000 (200 Mbps) cap above will throttle before the server's uplink does. Raise the cap when you have more bandwidth headroom or you want to support more concurrent firewalled operators.

---

## Rollback

```sh
# In smart-cam-backend/.env, comment out:
# TURN_URI=...
# TURN_URI_TLS=...
# TURN_SHARED_SECRET=...
docker restart smart-cam-backend
```

The backend's `/api/turn/credentials` immediately returns `{ available: false }` again, the frontend's `turnCredentials.js` re-fetches and caches that response, every subsequent WebRTC negotiation goes back to STUN-only. coturn keeps running but receives zero traffic. Stop the container at your leisure.

---

## Why these choices

- **`use-auth-secret` (REST) vs long-term username/password**: long-term creds in the SPA bundle are bad — anyone who views the page source can extract them. REST-auth issues per-session creds that expire in 1 hour and are HMAC-bound to the user-id; even leaked, they're useless an hour later.
- **`external-ip=103.109.7.37`**: without it coturn advertises its host's private IP in relay candidates; clients try to connect there and time out.
- **TLS port 5349 + UDP 3478 both exposed**: aggressive corporate firewalls block UDP entirely; without the TLS-over-TCP fallback those clients can't TURN at all.
- **Not using `turn:443/udp`**: 443 is reserved for nginx + the SPA. Carving it out for TURN would mean changing the entire HTTPS surface. Phase 4 can revisit.
- **No `lt-cred-mech` / long-term users**: would require a coturn database; REST-auth has no per-user state to manage.

---

## Cross-references

- [STREAMING-IMPROVEMENT-PLAN.md](STREAMING-IMPROVEMENT-PLAN.md) — Phase 1.4 placement in the full roadmap
- [STREAMING-WORLD-CLASS-MAP.md](STREAMING-WORLD-CLASS-MAP.md) — why TURN matters in the broader streaming stack (Part 3, "Transport / network layer")
- [smart-cam-backend/docs/CLOUDFLARE_TUNNEL.md](../backend/docs/CLOUDFLARE_TUNNEL.md) — pattern for the *other* server-side traffic, complements TURN
