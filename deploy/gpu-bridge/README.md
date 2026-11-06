# gpu-bridge

A small Docker image (alpine + WireGuard + socat, ~21 MB) that joins two Docker
stacks over one encrypted WireGuard tunnel so the office GPU box can run AI for
the prod VMS server.

- The **same image** runs on both ends. Each container joins its own side's
  Docker network. Neither host's network config changes (no host routes, no
  host WireGuard).
- The **office dials out** to prod (prod listens on udp/51820; office sends a
  keepalive every 25 s), so the office needs no inbound port or static IP.
- Tunnel subnet `10.8.0.0/24`: prod `10.8.0.1`, office `10.8.0.2`.
- Only plain **TCP port forwards** cross the tunnel. Nothing is routed.

```
 prod docker network                                         office docker network
 stream-service:8554  <--+                               +--> smart-cam-ai:8001
 smart-cam-backend:5000 <-+-- [gpu-bridge 10.8.0.1] ==wg== [gpu-bridge 10.8.0.2] --+--> head-count:8000
 backend uses gpu-bridge:8001 / :8020  --->              <--- AI uses gpu-bridge:8554 / :5000
```

## Configuration (env)

| Variable | Meaning |
|---|---|
| `WG_ADDRESS` | this end's tunnel address, e.g. `10.8.0.1/24` |
| `WG_PRIVATE_KEY` | this end's private key |
| `WG_PEER_PUBLIC_KEY` | the other end's public key |
| `WG_PEER_ALLOWED_IPS` | the other end's tunnel address, e.g. `10.8.0.2/32` |
| `WG_LISTEN_PORT` | optional; prod sets `51820` |
| `WG_PEER_ENDPOINT` | optional; office sets `103.109.7.36:51820` (hostnames allowed; re-resolved while the handshake is stale) |
| `WG_KEEPALIVE` | seconds, default `25` (only used with an endpoint) |
| `WG_MTU` | default `1380` |
| `EXPOSE` | `"port=host:port ..."`: listen on the **tunnel IP**, forward to a service on this side. This is what the peer may reach. |
| `REACH` | `"port=host:port ..."`: listen on this container's **Docker-network addresses** (never wg0), forward across the tunnel. This is what local services use. |

Prod: `EXPOSE="8554=stream-service:8554 5000=smart-cam-backend:5000"`,
`REACH="8001=10.8.0.2:8001 8020=10.8.0.2:8000"`.
Office: `REACH="8554=10.8.0.1:8554 5000=10.8.0.1:5000"`,
`EXPOSE="8001=smart-cam-ai:8001 8000=head-count:8000"`.

Target hostnames resolve on every new connection, so a recreated service with a
new IP keeps working, and the bridge starts even if a target is down.

## Security

- On `wg0`, iptables INPUT accepts only ESTABLISHED/RELATED, ICMP and the
  `EXPOSE` ports, then DROPs. If any firewall rule fails to apply, the container
  exits (fail closed). Ports such as MySQL 3306 are unreachable from the peer
  even if something inside the bridge listened on them.
- FORWARD is dropped in both directions on `wg0`, so the peer cannot use the
  bridge as a router into this side's Docker network (Docker containers have
  `ip_forward=1`, so this rule matters; tested).
- `REACH` listeners never bind the tunnel IP.
- WireGuard only accepts the one configured public key. A peer with any other
  key gets no handshake.
- The private key is written to a 0600 temp file for `wg set` and deleted
  immediately. It is still visible to anyone who can run `docker inspect` on the
  host, as with any env var: keep the env file `chmod 600`, owned by root.
- Keys live in `*.env` files that are git-ignored. Never commit them.

## Health and restarts

- Healthcheck: healthy only while the latest handshake is younger than 180 s
  (`docker inspect --format '{{.State.Health.Status}}' gpu-bridge`).
- If any forwarder dies the container exits non-zero and `restart: unless-stopped`
  brings it back (a fresh wg0 and fresh forwarders, ~2 s).

## Deploy

1. Build the image on each host (from this directory):
   `docker build -t drishyam/gpu-bridge:latest .`
2. Generate keys once, on any machine with Docker, into a directory **outside
   the repo**:
   `sh genkeys.sh /secure/dir 103.109.7.36:51820`
   This writes `prod.env` and `office.env`. Copy each file to its own host only
   (e.g. next to the compose file), `chmod 600` it, and delete the other copies.
3. Find the stack's Docker network and service names on each host:
   `docker inspect <a stack container> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.Aliases}}{{end}}'`
   Locally the backend's names are `smart-cam-backend` / `drisyam-original-backend`
   (there is no `backend` alias). Override with `PROD_STREAM_HOST`,
   `PROD_BACKEND_HOST`, `OFFICE_AI_HOST`, `OFFICE_HEADCOUNT_HOST` if prod differs.
4. **Prod** (open udp/51820 in the server/cloud firewall):
   `GPU_BRIDGE_NETWORK=<prod network> docker compose -f docker-compose.prod.yml -p gpu-bridge up -d`
5. **Office**:
   `GPU_BRIDGE_NETWORK=<office network> docker compose -f docker-compose.office.yml -p gpu-bridge up -d`
6. Point services at the bridge: prod backend uses `http://gpu-bridge:8001`
   (AI) and `http://gpu-bridge:8020` (head-count); office AI uses
   `rtsp://gpu-bridge:8554/<path>` and `http://gpu-bridge:5000`.

`GPU_BRIDGE_ENV_FILE=/path/to/prod.env` overrides the env-file location.

## Verify

```sh
docker exec gpu-bridge wg show wg0              # "latest handshake: N seconds ago"
docker inspect --format '{{.State.Health.Status}}' gpu-bridge   # healthy
docker exec gpu-bridge ping -c3 10.8.0.1        # from office (10.8.0.2 from prod)
# office side: backend health through the tunnel
docker run --rm --network <office network> curlimages/curl -s http://gpu-bridge:5000/api/health
# prod side: office AI through the tunnel
docker run --rm --network <prod network> curlimages/curl -s http://gpu-bridge:8001/
docker exec gpu-bridge iptables -L GPUB_IN -v -n   # per-port ACCEPT / DROP counters
docker logs gpu-bridge                           # forwards + socat connect errors
```

When testing RTSP, pull a safe test path only. Pulling `cam_*` paths makes the
stream service pull from real customer NVRs.

## Revoke or rotate a key

- **Cut the tunnel now:** `docker compose -f docker-compose.prod.yml -p gpu-bridge down`
  on prod (or block udp/51820). Nothing else depends on the bridge being up.
- **Revoke a leaked office key:** generate a new pair
  (`sh genkeys.sh /new/secure/dir`), deploy the new `prod.env` on prod and the new
  `office.env` on the office, and recreate both containers
  (`up -d --force-recreate`). Prod only accepts the public key in its env file, so
  the old office key stops working the moment prod is recreated. Delete the old
  env files.
- **Revoke on the running prod bridge without a redeploy** (temporary, lost on
  restart): `docker exec gpu-bridge wg set wg0 peer <office public key> remove`.
