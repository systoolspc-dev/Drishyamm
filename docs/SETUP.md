# Setting up Drishyam on a new machine

Everything runs in Docker on one NVIDIA GPU host. This guide takes a blank
machine to a working console with a camera on screen, then covers access from
other computers, production hardening and moving data from an existing box.

## 1. Prerequisites

| | Windows 11 | Linux (Ubuntu 22.04/24.04) |
|---|---|---|
| GPU driver | NVIDIA Game Ready / Studio / RTX Enterprise driver, CUDA 12.8 capable (R570+) | `nvidia-driver-570` or newer |
| Docker | Docker Desktop with the **WSL2** backend; Settings → Resources → WSL integration on | Docker Engine 26+ and the **NVIDIA Container Toolkit** (`nvidia-ctk runtime configure --runtime=docker`) |
| Compose | bundled (needs ≥ 2.24) | `docker compose version` ≥ 2.24 |
| Git LFS | `git lfs install` | `apt install git-lfs && git lfs install` |
| Disk | ~40 GB for images + models, plus recordings | same |

### Windows: Docker Engine inside WSL2 Ubuntu (tested, recommended)

Docker Desktop is optional. This setup was verified on WSL2 Ubuntu with Docker
Engine installed inside Ubuntu (RTX A2000). **Don't run both**: Docker Desktop's
WSL integration takes over `/var/run/docker.sock` and leaves broken CLI plugin
links. If Docker Desktop was installed, uninstall it on Windows, then run
`wsl --shutdown` in PowerShell before continuing.

In the Ubuntu shell:

```bash
# Docker Engine + compose/buildx plugins (Docker's apt repo)
sudo apt-get update && sudo apt-get install -y ca-certificates curl git git-lfs
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER          # then close and reopen the shell

# NVIDIA Container Toolkit (the Windows NVIDIA driver supplies the GPU; don't
# install a Linux driver inside WSL)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker

sudo systemctl enable --now docker     # needs systemd=true in /etc/wsl.conf (default on new installs)
sudo systemctl restart docker
docker compose version                 # must print a version (≥ 2.24), not "unknown shorthand flag"
```

Keep the repo inside the Linux filesystem (e.g. `~/github-repos/`), not on
`/mnt/c`, because bind mounts and builds on `/mnt/c` are very slow.

Check the GPU is visible to containers before anything else:

```bash
docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi
```

Also make sure the system clock is NTP-synced (Windows: `w32tm /query /status`;
Linux: `timedatectl`). Backend and AI exchange JWTs with a 30 s tolerance: a
box that drifts by more than that gets 401s on every AI call.

## 2. Get the code

```bash
git lfs install
git clone <your-repo-url> drishyam && cd drishyam
git lfs pull                       # if the clone ran before `git lfs install`
```

(Copying the folder directly works too — the weights are already inside it.)

After `git lfs pull`, `git status` may list model weights and demo videos as
modified. That's expected: some were committed as LFS pointers. Don't commit them.

## 3. Configure

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Edit at least these:

| File | Key | Set it to |
|---|---|---|
| `.env` | `SERVICE_TOKEN` | a random 64-hex string: `openssl rand -hex 32`. Compose gives the same value to the backend and to every AI service. |
| `.env` | `HOST_IP` | this machine's LAN IP (or public IP) if the console will be opened from another computer — otherwise live view connects but stays black. |
| `.env` | `PUBLIC_API_URL`, `PUBLIC_APP_URL`, `PUBLIC_HLS_URL`, `PUBLIC_WEBRTC_URL`, `CORS_ORIGINS` | the same host as the browser will use, e.g. `http://192.168.1.20:5000`. Leave as `localhost` for single-machine use. |
| `backend/.env` | `JWT_SECRET`, `JWT_REFRESH_SECRET` | two different `openssl rand -base64 48` values. |
| `backend/.env` | `CAMERA_CRED_KEY` | `openssl rand -base64 32` — encrypts camera passwords at rest. **Back it up.** |

Everything else has working defaults. `.env.example` and
`backend/.env.example` document each key; the full reference is
[07-env-variables.md](07-env-variables.md).

## 4. Start

```bash
docker compose up -d --build
docker compose ps
```

MinIO uses `bitnamilegacy/minio:2024.10.13`, Bitnami's archived build of
MinIO 2024-10-13. The official `minio/minio` images can no longer be pulled, so
this isn't optional. It's already set in `docker-compose.yml`, so no extra step
or override file is needed.

The first build pulls CUDA / PyTorch base images and installs Python wheels —
15-30 minutes depending on bandwidth. Later starts take seconds.

What happens on first boot:

* **backend** runs every MySQL migration (`backend/migrations`, 001 → 037)
  and seeds plans/pricing, then listens on :5000.
* **smart-cam-ai** runs the Postgres migrations (`alembic upgrade head`), then
  builds **TensorRT engines** for the face models for *this* GPU. That takes a
  few minutes once; the engines are cached afterwards. Until then
  `/healthz` is not ready — the healthcheck allows 5 minutes.
* **head-count / zone-guard** load their YOLO weights from `models/` (no
  download).

Health checks:

```bash
curl http://127.0.0.1:5000/api/health/live      # backend
curl http://127.0.0.1:8001/healthz              # face service
curl http://127.0.0.1:8020/                     # head-count dashboard
docker compose logs -f smart-cam-ai             # watch the AI boot
```

> Use `127.0.0.1`, not `localhost`, in curl/browsers on Windows if requests
> hang: `localhost` can resolve to IPv6 first and hit a stale WSL relay.

### Optional profiles

| Command | Adds |
|---|---|
| `docker compose --profile demo up -d` | `local-demo-cam` loops `demo/videos/crowd.mp4` at `rtsp://<host>:8554/demo_src`; `footfall-demo` registers a footfall camera with a line-crossing clip. |
| `docker compose --profile enhance up -d` | `face-reconstruct` (CodeFormer forensic enhance, :8002). |
| `docker compose --profile media up -d` | per-camera NVENC transcoder (:8004) and LiveKit SFU bridge (:8005, needs `LIVEKIT_*`). |
| `docker compose --profile tunnel up -d` | Cloudflare tunnel — see [../deploy/cloudflared/README.md](../deploy/cloudflared/README.md). |

### Large camera counts (face recognition on 40+ cameras)

```bash
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d
```

Adds four inference servers and four camera shards (5 shards total). One
process tops out at roughly 10-20 cameras; the shard layout reached 290
frames/s across 43 cameras on one RTX PRO 5000. Details and measurements:
[FACE_SYSTEM_DESIGN.md](FACE_SYSTEM_DESIGN.md).

## 5. First login

Create the platform operator account (sets the `is_platform_admin` flag the
`/admin` console needs):

```bash
docker compose exec -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='choose-a-strong-one' \
  smart-cam-backend node scripts/create-admin.js
```

Open `http://<host>:5173/login`. Customers sign up at `/register`; the
operator console is `http://<host>:5173/admin`.

## 6. Add a camera

* **Direct RTSP camera / NVR on a reachable network:** Camera Setup → add the
  RTSP URL or the NVR (brand, IP, port 554, credentials). The backend
  registers a `cam_<id>` path on the Stream Service, which pulls on demand.
* **Cameras on a private site LAN** (most real sites): install the edge relay
  on any PC at the site — it pushes the streams *out* to this server, no port
  forwarding. See [../deploy/README.md](../deploy/README.md#edge-relay).
* **No camera handy:** `--profile demo`, then add a camera with RTSP URL
  `rtsp://stream-service:8554/demo_src`.

Turn AI features on per camera in the console (face recognition, head count,
zones, footfall, activity). Nothing runs on a camera until it is enabled.

NVR limits matter: weak NVRs stop answering after ~6-9 concurrent RTSP
sessions. The console budgets live pulls per NVR and prefers sub-streams;
don't enable 24/7 recording on every camera of one NVR. See
[CAMERA_CONNECTIVITY.md](CAMERA_CONNECTIVITY.md) and
[09-troubleshooting.md](09-troubleshooting.md).

## 7. Production hardening

Before exposing the box to a network you don't control:

1. **Datastore passwords** — set `MYSQL_ROOT_PASSWORD` +
   `MYSQL_ALLOW_EMPTY_PASSWORD=no`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
   `QDRANT_API_KEY`, `MINIO_ROOT_*` in `.env` **before the first start** (they
   only apply to a fresh volume). With `REDIS_PASSWORD`, also update
   `redis_url` in `ai/activity-monitor/config/config.docker.yaml`.
2. **AI auth** — `VMS_ENV=prod` (turns the dev auth bypass off) and a
   `LEGACY_API_KEY`.
3. **Backend** — `NODE_ENV=production` in `backend/.env`. The backend then
   refuses to boot (`src/config/prodSecretGuard.js`) while any of these hold:
   a sample/`change-me` JWT secret, identical access and refresh secrets, an
   empty DB password (so step 1's `MYSQL_ROOT_PASSWORD` is mandatory), the
   sample stream API password `drishyam123`, or a placeholder Stripe key.
   Note the guard reads the legacy name `MEDIAMTX_API_PASS` (default
   `drishyam123`): set it to the same new value as `STREAM_SERVICE_API_PASS`
   or production refuses to start.
4. **Stream service** — change the control-API user in
   `media/stream-service/mediamtx.yml` + `STREAM_API_*` / `STREAM_SERVICE_API_*`,
   and lock down readers with `scripts/enable-stream-auth.sh`
   ([STREAM_SECURITY.md](STREAM_SECURITY.md)).
5. **Edge** — put [../deploy/nginx/nginx.conf](../deploy/nginx/nginx.conf) (or
   the Cloudflare tunnel) in front for TLS; datastore ports are already bound
   to 127.0.0.1 only.
6. **Backups** — cron `db/scripts/backup-databases.sh` ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
7. **Licences** — see [../models/README.md](../models/README.md#licences)
   before selling face recognition or anything YOLO-based.

[SECURITY.md](SECURITY.md) and [GO_LIVE.md](GO_LIVE.md) have the full lists.

## 8. Moving data from an existing installation (optional)

A fresh install starts empty. To carry users, cameras, galleries and history
over from another box:

1. On the old box: `./db/scripts/backup-databases.sh` (MySQL + Postgres dumps).
2. Copy the Qdrant and MinIO volumes (face vectors and snapshots):
   ```bash
   docker run --rm -v <old_qdrant_volume>:/v -v "$PWD":/b alpine tar czf /b/qdrant.tgz -C /v .
   docker run --rm -v <old_minio_volume>:/v -v "$PWD":/b alpine tar czf /b/minio.tgz -C /v .
   ```
3. On the new box, before starting the AI: restore the dumps (see
   [BACKUP_RESTORE.md](BACKUP_RESTORE.md)) and untar into
   `drishyam_qdrant-data` / `drishyam_minio-data`.
4. Use the **same** `CAMERA_CRED_KEY` and `VMS_CAMERA_CRED_KEY` as the old box,
   or stored camera passwords can't be decrypted.
5. Recordings: copy the old recordings folder to `RECORDINGS_DIR`.

Staff enrolment photos are not in this repository (biometric data). Enrol
through the console, or drop `Name_1.jpg`, `Name_2.jpg`… into
`data/known-faces/` and restart `smart-cam-ai`.

## 9. Day-to-day development

Source folders are bind-mounted, so most edits need only a restart:

| Change | Then |
|---|---|
| `backend/src/**` | nothing — nodemon restarts it |
| `frontend/src/**` | nothing — Vite hot-reloads |
| `ai/face-service/vms_face/**` | `docker compose restart smart-cam-ai smart-cam-ai-worker` |
| `ai/head-count/config/*` | `docker compose restart head-count` |
| `requirements.txt`, `package.json`, a Dockerfile | `docker compose up -d --build <service>` |
| new MySQL migration | add `backend/migrations/0NN-*.js`; runs on next backend start |
| new Postgres migration | `vms_face/alembic/versions/`; runs on next `smart-cam-ai` start |

Tests: `cd backend && npm test` (Jest); face service:
`docker compose exec smart-cam-ai sh -c 'cd /srv/app/face_detection && python -m unittest discover -s vms_face/tests -t .'`.

Deep developer guides: [dev/README.md](dev/README.md).

## 10. When something is wrong

| Symptom | Usual cause |
|---|---|
| AI containers start but GPU is idle / `CUDAExecutionProvider` missing | GPU not passed through: check the `nvidia-smi` test in §1. |
| Face service crashes with CUDA errors past ~40 cameras on Windows | Docker Desktop's WSL2 GPU layer limits CUDA contexts — keep `RTSP_INGEST_BACKEND=pyav`; use `ffmpeg` only on native Linux. |
| Live view black from another PC, fine on the server | `HOST_IP` / `PUBLIC_*_URL` still `localhost`. |
| Every journey/face call returns 401 | backend and AI disagree on the token (both come from `SERVICE_TOKEN` here) or the clock drifted > 30 s. |
| Cameras flap online/offline behind one NVR | too many concurrent pulls on a weak NVR — sub-stream, fewer tiles, no record-all. |
| `docker compose up -d` → `unknown shorthand flag: 'd'` | compose plugin missing, usually dangling links left by Docker Desktop. `sudo apt-get install docker-compose-plugin docker-buildx-plugin`, then `wsl --shutdown` (or `sudo find /usr/local/lib/docker/cli-plugins -type l -lname '/mnt/wsl/docker-desktop/*' -delete`). |
| `pull access denied` / `manifest unknown` for `minio/minio` | an old compose file. Use `bitnamilegacy/minio:2024.10.13` as in the current `docker-compose.yml`. |
| `localhost refused to connect` on :5173, or DNS errors during build | Docker Desktop still owns the socket. Uninstall it, then `wsl --shutdown` and `sudo systemctl restart docker.socket docker`. |
| Some cameras only load slowly, one at a time behind one NVR | normal: opens are paced per NVR (`NVR_OPEN_GAP_MS`, default 300 ms) so a weak NVR isn't flooded. |
| Backend exits at boot with a Joi error | an optional key in `backend/.env` was left as `KEY=` — comment it out. |

More: [09-troubleshooting.md](09-troubleshooting.md),
[dev/06-debugging-runbook.md](dev/06-debugging-runbook.md),
[dev/07-error-case-studies.md](dev/07-error-case-studies.md).
