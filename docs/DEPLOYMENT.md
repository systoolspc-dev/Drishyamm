# Deployment: GitHub → testing → production

How code gets from a teammate's branch onto a running server. Read this before
touching any server.

> **Golden rule: code reaches a server only through GitHub and the pipeline.**
> No hand edits on servers, no `scp`, no "quick fix during the demo". If a demo
> forced a hotfix on a server, commit it to a branch and open a PR **the same day**.

- Setup progress and open decisions: [`.claude/skills/drishyam-cicd-setup/SKILL.md`](../.claude/skills/drishyam-cicd-setup/SKILL.md)
- Day-to-day runbook (deploy, verify, roll back): [`.claude/skills/drishyam-deploy/SKILL.md`](../.claude/skills/drishyam-deploy/SKILL.md)
- Team workflow with exact git commands: `CONTRIBUTING.md` (Phase 3)

---

## 1. Environments and flow

| Environment | Branch | Access | Deploys when |
|---|---|---|---|
| Local dev | any | teammate laptop | `docker compose up -d` |
| **Testing** | `main` | `<testing URL>`: **public via Tailscale Funnel, no site password** (only the app's own login) | automatically on every push/merge to `main` |
| Production | `production` | Cloudflare Tunnel + gpu-bridge | automatically on push to `production` (own runner, label `production`; set up separately) |

```
 feature/<name>-<task> ──PR──▶ main ──push──▶ runner [self-hosted, testing] on the testing server
        ▲                     │ ci.yml         scripts/deploy.sh <sha>
        │                     │ 1 approval       dirty check → checkout SHA → DB backup
   git merge origin/main      │                  → build → migrate → up -d → health → record SHA
   before opening the PR      │
                              └──PR (maintainer)──▶ production ──push──▶ production runner (separate)
```

---

## 2. The testing server

| Fact | Value |
|---|---|
| OS | Fedora 45 Workstation, native Linux (not WSL2) |
| Docker | Docker Engine 29 (docker-ce), `nvidia` runtime, starts on boot |
| GPU | RTX 5090 32 GB, used directly by the AI containers (no remote GPU) |
| Checkout | `/home/systools-pc/Desktop/Projects/Drishyamm` (compose project `drishyamm`) |
| Compose file | `docker-compose.yml` (+ testing overlay for the nginx entrypoint, Phase 1) |
| Secrets | `.env`, `backend/.env`: gitignored, only on the server |
| URL | `<testing URL>`, Tailscale **Funnel** → `127.0.0.1:8080` (`edge` nginx) |
| Public access | open to anyone with the URL. The app's JWT login protects `/api`; **`/ai/`, `/hls/`, `/live/` have no auth** (AI runs with dev bypass) and self-registration is open. Maintainer's explicit choice, 2026-11-13. |
| Deployed version | `.deploy/last-deployed`, history in `.deploy/history.log` |
| Pre-deploy DB dumps | `~/drishyam-backups/<time>-<sha>/` (last 20 kept) |

**The compose file runs in development mode.** `./backend` and `./frontend` are
bind-mounted (backend under `nodemon`, frontend on the Vite dev server):

- A `git checkout` changes running code immediately.
- `node_modules` live in named volumes and mask the image's copy, so a new npm
  dependency needs `npm ci` inside the container (deploy.sh does this when a
  lockfile changes).
- The frontend's URLs come from env at dev-server start, not from a build, so
  changing them means restarting `smart-cam-app`. No rebuild is needed.

Production (`deploy/production/docker-compose.prod.yml`) differs: prebuilt images,
no bind mounts, SPA on :80.

### Services and ports

| Service (compose name) | Host port | Health |
|---|---|---|
| `smart-cam-app` (React / Vite) | 5173 | `GET /` |
| `smart-cam-backend` (Express, Socket.IO) | 5000 | `GET /api/health/live` |
| `smart-cam-ai` (FastAPI vms_face) | 8001 | `GET /healthz` |
| `smart-cam-ai-worker`, `journey-stitch-worker`, `zone-guard` | – | |
| `head-count` / `activity-monitor` | 8020 / 8010 | |
| `stream-service` (MediaMTX) | 8554 RTSP, 8898 HLS, 8889 WHEP, 8189/udp WebRTC, 8890 SRT | |
| mysql, redis, postgres, qdrant, minio, kafka | 127.0.0.1 only | compose healthchecks |

Never rename compose **service** names; code and env depend on them.

### The single entrypoint

Everything goes through one nginx entrypoint (`deploy/testing/`) bound to
`127.0.0.1:8080`, published over HTTPS by `tailscale funnel --bg 8080` (public)
— switch back to tailnet-only with `tailscale funnel --https=443 off && tailscale serve --bg 8080`:

| Path | Goes to |
|---|---|
| `/` | `smart-cam-app:5173` (Vite) |
| `/api/`, `/socket.io/` | `smart-cam-backend:5000` |
| `/ai/` | `smart-cam-ai:8001` |
| `/hls/` | `stream-service:8888` |
| `/live/` | `stream-service:8889` (WHEP signalling) |

WebRTC media (UDP 8189) flows directly over the tailnet; MediaMTX advertises
the machine's Tailscale address.

### Migrations

| Database | Tool | Runs | By hand |
|---|---|---|---|
| MySQL `drishyamvms` | Sequelize CLI (`backend/migrations/`) | on `smart-cam-backend` start, and in deploy.sh | `docker compose exec -T smart-cam-backend npx sequelize-cli db:migrate` |
| Postgres `vms_face` | Alembic (`ai/face-service/vms_face/alembic/`) | on `smart-cam-ai` start, and in deploy.sh | `docker compose exec -T smart-cam-ai alembic upgrade head` |

Migrations are forward-only. A rollback of code does **not** roll back the
schema. A PR with a migration must say so; destructive changes (drop/rename)
need a two-step rollout.

---

## 3. Auto-deploy

| File | Runs on | Trigger |
|---|---|---|
| `.github/workflows/ci.yml` | GitHub-hosted `ubuntu-latest` | PRs into `main` and `production` |
| `.github/workflows/deploy-testing.yml` | `[self-hosted, testing]` | push to `main`, `workflow_dispatch` (`sha`) |
| `scripts/deploy.sh <sha>` | the server checkout | called by the workflow; generic, so production can reuse it |

The runner is a systemd service under `systools-pc` (non-root, docker group) and
starts on boot. The workflow `cd`s into the server checkout and deploys there,
so the live `.env` files and data volumes stay as they are.

---

## 4. Rolling back

1. GitHub → Actions → **Deploy testing** → **Run workflow** → enter the last good
   SHA (`.deploy/history.log` on the server, or an earlier green run).
2. Then **Revert** the bad PR on GitHub and merge the revert, or the next merge
   brings it back.
3. Schema changes aren't undone. Fix forward, or restore the pre-deploy dump from
   `~/drishyam-backups/` (`docs/BACKUP_RESTORE.md`).

Never `git reset --hard` or hand-edit the server to roll back.

---

## 5. Rules

- Branches: `feature/<name>-<task>`, `fix/<name>-<task>`, `chore/<task>`. Short-lived.
- `main`: PR + 1 approval + CI green, no force-push. `production`: maintainers only,
  PRs from `main` only.
- Never commit `.env*` (except `*.env.example`), keys, certs, Tailscale auth keys,
  runner tokens.
- New env vars: add to the matching `.env.example`, list them in the PR, and the
  maintainer sets them on the server **before** merging.
