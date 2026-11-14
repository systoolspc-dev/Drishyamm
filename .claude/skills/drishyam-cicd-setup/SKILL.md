---
name: drishyam-cicd-setup
description: The one-off project that sets up Drishyam's testing CI/CD (Tailscale-private testing server, GitHub Actions self-hosted runner auto-deploying main, PR CI, team guardrails). Use when continuing or checking that setup, i.e. any of Phase 0–3, branch chore/ci-cd-testing, tailscale serve, nginx single entrypoint, runner install, deploy.sh, workflows, CONTRIBUTING.md, reboot persistence, or the GitHub/Tailscale settings the user must click.
---

# Drishyam testing CI/CD setup: plan, status, decisions

The operating runbook is the `drishyam-deploy` skill. Background is in `docs/DEPLOYMENT.md`.
This file is the **project tracker**. Update the status table, findings and
decisions as work lands, in the same branch as the work.

## Goal (from the maintainer, revised 2026-11-13)

Code used to drift between a "main PC", the production server, GitHub and
laptops, because people patched servers during demos. Everything is now in
**github.com/systoolspc-dev/Drishyamm**. Target:

| Environment | Branch | Access | Deploy trigger | Who sets it up |
|---|---|---|---|---|
| TESTING (this machine) | `main` | **public via Funnel, no site password** (changed from tailnet-only on 2026-11-13 at the user's request, "option B"), `<testing URL>` | auto on every push/merge to `main` | **us (this project)** |
| PRODUCTION (other machine) | `production` | Cloudflare Tunnel + gpu-bridge (exists) | auto on push to `production`, runner label `production` | maintainer, separately |

Team flow: `feature/<name>-<task>` → PR into `main` → maintainer merges → testing
auto-deploys. Release: PR `main` → `production`.
Golden rule: code reaches a server only through GitHub + the pipeline.

## Working rules for this project

- Repo changes on branch **`chore/ci-cd-testing`**, PR into `main`. Never push `main`.
- **Confirm with the user between phases.** Stop for anything they must do
  (Tailscale login/admin console, GitHub settings, runner token, browser logins)
  and give click-by-click steps.
- Ask before destructive or hard-to-undo actions: deleting files/volumes,
  `reset --hard`, dropping DBs, stopping the stack for long, **firewall changes**
  (lock-out risk), history rewrites. `sudo` needs the user's password, so system-level
  steps (installing packages, systemd, firewalld) have to be run by the user with `! sudo ...`.
- Never commit secrets: `.env*`, keys, Tailscale auth keys, runner tokens.
- No application feature-code changes unless deploy/config forces it. Explain why.
- **Do not create or modify anything that deploys to production.**
- Finish with: what was set up, files changed, testing URL, how to check a deploy,
  rollback (redeploy previous SHA via `workflow_dispatch`), reboot-test results.

## Status

| Phase | Item | Status |
|---|---|---|
| 0 | Read docs/compose/nginx; environment; git state; services/ports/migrations; entrypoint | **done 2026-11-13**, awaiting user confirmation |
| – | Skills, `CLAUDE.md`, `docs/DEPLOYMENT.md`, `.gitignore` exception for `.claude/skills/` | written on branch, not committed |
| 1 | Install Tailscale (native Fedora, not WSL), hostname `drishyam-test`, operator `systools-pc` | **done**: 1.104.7, tailscaled enabled, IP <tailscale IP> |
| 1 | User: `tailscale up` login; admin: MagicDNS + HTTPS certs, invite team | **done** except inviting teammates; tailnet `<tailnet>.ts.net` |
| 1 | nginx single entrypoint on 127.0.0.1 + `tailscale serve` HTTPS (no Funnel) | **done**: `edge` (deploy/testing/) on 127.0.0.1:8080, `tailscale serve --bg 8080` → `<testing URL>` |
| 1 | Env: PUBLIC_*_URL, VITE_AI_BASE_URL, CORS, Vite allowedHosts, WebRTC host | **done** in server `.env` (backup `.env.bak-*`); `COMPOSE_FILE` includes the overlay |
| 1 | Verify via ts.net: login, API, Socket.IO, live + playback video, AI | curl-verified (app, /api, /ai, /ai/ws, socket.io, /hls, /live OPTIONS); **browser test by user pending** |
| 1 | Lock-down: bind ports to loopback, firewalld, SSH (ask first) | **ports done 2026-11-13**: `BIND_ADDR=127.0.0.1` in server `.env` (compose ports `${BIND_ADDR:-0.0.0.0}:…`); only RTSP 8554/tcp + WebRTC 8189/udp stay public. `mongodb`/`mongo-express` recreated on 127.0.0.1 (same `mongodb_data` volume, `mongo-net`); old ones kept stopped as `mongodb-old`/`mongo-express-old`. **firewalld + SSH/RDP: awaiting user** |
| 1 | Persistence: tailscaled, docker, stack (`restart: unless-stopped`) on boot; real reboot test | **passed 2026-11-13 13:20 IST**: docker + tailscaled active, Funnel on, all 16 stack containers + edge + mongodb/mongo-express up, backend/ai/edge healthy, public URL 200 for /, /api, /ai, socket.io; loopback bindings and qdrant nofile kept |
| 2 | Self-hosted runner `self-hosted,testing`, systemd service, user `systools-pc` | registered 2026-11-14 as `drishyam-test` (`~/actions-runner`, token fetched via `gh api`); **service install needs user sudo** (+ `chcon -t bin_t runsvc.sh`, SELinux enforcing) |
| 2 | `scripts/deploy.sh` (generic, reusable by prod) with pre-migration DB backup | written, shellcheck clean, dirty-tree refusal tested |
| 2 | `.github/workflows/deploy-testing.yml` | written, actionlint clean; repo var `DEPLOY_DIR` set |
| 2 | `.github/workflows/ci.yml` (PRs into main + production; only checks that pass) | written; suites run locally (see F10); first GitHub run on the phase-2 PR decides the final set |
| 3 | `CONTRIBUTING.md`, `.github/pull_request_template.md`, GitHub click-list | todo |

## Environment (Phase 0 facts)

- Fedora 45 Workstation, kernel 7.2, **native Linux (not WSL2)**. Docker Engine 29.9
  (docker-ce) native, `docker.service` enabled, `nvidia` runtime registered.
- GPU: RTX 5090 32 GB, visible inside `drishyam-ai` (`nvidia-smi` works; ORT providers
  TensorRT/CUDA/CPU). AI runs on the **local GPU**, no remote GPU / gpu-bridge here.
- User `systools-pc` (groups `wheel`, `docker`). `sudo` needs a password → the user
  runs root commands. `cloudflared` is installed but unused for testing. `gh` and
  `tailscale` are not installed.
- Checkout `/home/systools-pc/Desktop/Projects/Drishyamm`, compose project `drishyamm`
  (from the dir name → volumes `drishyamm_*`), file `docker-compose.yml` only, no profiles.
- LAN IP <LAN IP> on `enp130s0`, firewalld zone `FedoraWorkstation`.
- DBs are tiny (MySQL `drishyamvms` ≈1 MB, Postgres `vms_face` ≈10 MB), disk 5.4 TB free.
  A pre-migration backup on every deploy costs essentially nothing.

## Findings (act on these)

- **F1 Git state:** `main` == `origin/main` @ `f253cd0` with no tracked changes. Untracked
  before we started: `scripts/setup-fedora-host.sh`, `scripts/fix-nvidia-kernel.sh`
  (host setup, look legitimate). They block deploy.sh's dirty check → user decides
  whether to commit them (D3).
- **F2 Dev-mode compose:** `./backend`, `./frontend` bind-mounted; nodemon + Vite dev
  server; `node_modules` in named volumes (a rebuild doesn't refresh them → `npm ci` in
  container when a lockfile changes). The frontend URL is **not baked at build time**:
  Vite reads env on start, so restart `smart-cam-app` instead of rebuilding.
- **F3 Vite 7 host check:** add `server.allowedHosts` (env-driven) in
  `frontend/vite.config.js` for the ts.net name. Justified config change.
- **F4 Browser-facing URLs:** `PUBLIC_API_URL`, `PUBLIC_APP_URL`, `PUBLIC_HLS_URL`,
  `PUBLIC_WEBRTC_URL`, `CORS_ORIGINS` (root `.env`), and `VITE_AI_BASE_URL`
  (`frontend/src/core/config/endpoints.js`, defaults to `http://localhost:8001`, not
  passed by compose). Socket.IO uses the API base URL.
- **F5 No entrypoint today:** the stack exposes 5173 / 5000 / 8001 / 8898 / 8889 separately.
  `deploy/nginx/nginx.conf` (prod edge: `/api/`, `/socket.io/`, `/live/` WHEP, `/hls/`
  with auth sub-request) isn't run by any compose service and has no SPA `location /`
  and no AI route.
- **F6 Video:** Tailscale is a real network, so WebRTC UDP 8189 can reach the tailnet IP.
  MediaMTX must advertise it (`webrtcAdditionalHosts`: the 100.x IP / ts.net name).
  HLS goes through nginx `/hls/`. Separately, all cameras come from one NVR over the
  public internet (`<NVR public address>`) with heavy RTP loss, so flaky live video isn't
  necessarily a pipeline bug.
- **F7 Exposure today (all reachable from the LAN 192.168.1.0/24; internet only if
  the router forwards):** firewalld zone allows **tcp+udp 1025–65535**, and Docker-published
  ports bypass firewalld anyway. Listening on all interfaces: 5000, 5173, 8001, 8010,
  8020, 8554, 8889, 8890, 8898, 8189/udp (compose); **27017 `mongodb` and 8081
  `mongo-express`** (standalone containers, not in compose; likely no auth); 3389 (RDP);
  27500 (unknown). `sshd` is **inactive**. Fix by binding compose ports to 127.0.0.1
  (except what nginx/tailscale need) via an env-driven bind address, and tightening
  firewalld. **Ask before any firewall change.**
- **F8 Unsafe defaults even on a private tailnet:** `VMS_ENV=dev` +
  `VMS_JWT_DEV_BYPASS=true`, `RATE_LIMIT_SKIP_PRIVATE=1`, MediaMTX API creds
  `drishyam/drishyam123` committed in `media/stream-service/mediamtx.yml`. Acceptable on a
  team-only tailnet, but record them.
- **F9 Docs gaps:** `docs/SETUP.md` doesn't exist (README/deploy README linked it).
  `scripts/backup-databases.sh` is referenced by `docs/BACKUP_RESTORE.md` but missing.
  `docs/GO_LIVE.md` mentions a `ci.yml` that doesn't exist (no `.github/` at all).
- **F10 Test results (2026-11-14, run locally in the stack's containers):** backend jest 30/33 suites
  pass (failing: `streaming.engine` requires deleted `MediaMTXEngine`, `streaming.factory` expects
  `mediamtx` vs `stream-service`, `tmpDocCheck.cameraHealth.row` Date vs string); frontend `npm test`
  107/107 on Node 22 (the glob needs Node 22; Node 20 finds no files), `vite build` OK, **eslint 94
  errors**; face-service unittest 43/43; head-count pytest 103/104; activity-monitor pytest 43/44.
  Failures are excluded by name in `ci.yml`, not silently disabled.
- **F11 Qdrant fd exhaustion (fixed 2026-11-13):** default `nofile` 1024 ran out at 04:45 UTC ("Too many open files"), Qdrant hung, `smart-cam-ai` couldn't start after a recreate. Compose now sets `ulimits.nofile 65536` for qdrant.
- **F12 Redis keeps showing as "Recreate" in `docker compose up --dry-run`** with unchanged config (probably a newer local `redis:7-alpine` image). Recreate services with `--no-deps <svc>` to avoid bouncing Redis by accident; deploy.sh should be aware.

- **F13 First auto-deploy outage (2026-11-14, merge of PR #2):** the host's `valkey.service`
  (enabled at boot; used by the separate voice-cloning project via `localhost:6379`) grabbed
  127.0.0.1:6379 while `up -d` recreated the Redis container. Redis failed to bind, and its
  dependents (app, ai, ai-worker, stitch worker) stayed "Created", so the site was down. The
  recreated Redis then came up with **no network**. Recovery: user ran `sudo systemctl stop
  valkey`, then `docker compose up -d`, `--force-recreate --no-deps redis`, and a restart of the
  Redis clients. Fix: `REDIS_HOST_PORT` (server `.env` = 6380), so Drishyam and voice-cloning
  never share a Redis. After it deploys, the user re-enables valkey. The two untracked host
  scripts are in `.git/info/exclude` (local only) so deploys see a clean tree.

## Decisions

- **D1 Entrypoint: DECIDED nginx + tailscale serve (2026-11-13).** a small `nginx` service in a testing overlay
  (`deploy/testing/docker-compose.testing.yml` + `deploy/testing/nginx.conf`) on
  `127.0.0.1:8080`: `/` → Vite, `/api/` + `/socket.io/` → backend, `/ai/` → AI,
  `/hls/` → MediaMTX HLS, `/live/` → WHEP. `tailscale serve --bg --https=443
  http://127.0.0.1:8080`. One origin, no CORS, mirrors the production edge.
  Alternative: `tailscale serve --set-path` per service with no nginx. Fewer parts,
  but path rewriting is limited. **Awaiting user.**
- **D5 Public access: DECIDED Funnel, fully open (user chose option B, then removed the site password and the public sign-up block, 2026-11-13, after being told the risk).** Edge keeps: real client IP via X-Forwarded-For passthrough, `$is_public` in the access log. **Open risk:** `/ai/` (face search, detections, uploads), `/hls/`, `/live/` have no auth; anyone can self-register. Revisit before sharing the URL widely: re-add Basic auth for requests where `$is_public` = 1 (map `$is_public` → `auth_basic` realm; exempt `/api` and `/socket.io`) or fix AI auth in the app.
- **D2 Deploy location: proceeding with existing checkout (user didn't object).** deploy **in the existing checkout**. It holds
  `.env`/`backend/.env`, and the compose project name `drishyamm` (→ existing data volumes)
  comes from its directory. The runner's `_work` dir is used only for the workflow
  itself; the job `cd`s into the checkout (path from a repo/runner variable
  `DEPLOY_DIR`). Optionally move to `/opt/drishyamm` later with
  `COMPOSE_PROJECT_NAME=drishyamm` pinned in `.env`. **Awaiting user.**
- **D3** Untracked host scripts (F1): commit or remove. **Awaiting user.**
- **D4 Backups:** before migrations, deploy.sh runs `mysqldump` (drishyamvms) +
  `pg_dump -Fc` (vms_face) into `~/drishyam-backups/<UTC time>-<sha>/`, keeps the last 20.
  Cheap (≈11 MB). This also gives us the missing `scripts/backup-databases.sh`.

## Phase 2 design notes

- Runner: `~/actions-runner`; `./config.sh --url https://github.com/systoolspc-dev/Drishyamm
  --token <TOKEN> --labels testing --name drishyam-test --unattended`; then
  `sudo ./svc.sh install systools-pc && sudo ./svc.sh start` (systemd, boots with the host).
  The `self-hosted` label is automatic.
- `deploy-testing.yml`: `on: push: branches [main]` + `workflow_dispatch` (input `sha`,
  default the pushed SHA); `runs-on: [self-hosted, testing]`;
  `concurrency: { group: deploy-testing, cancel-in-progress: false }`;
  `timeout-minutes: 40`; step: `cd "$DEPLOY_DIR" && scripts/deploy.sh "$SHA"`.
- `deploy.sh <sha>` (generic: `DEPLOY_BRANCH` default `main`, `COMPOSE_FILES`, health URLs
  from env, so production can reuse it): `set -euo pipefail` → dirty check (print
  `git status`, exit 1) → `git fetch --prune origin` → SHA must be on
  `origin/$DEPLOY_BRANCH` → `git checkout --detach <sha>` → backup (D4) → `npm ci` in
  containers if lockfiles changed vs previous deployed SHA → `docker compose build` →
  `up -d --remove-orphans` → explicit `sequelize-cli db:migrate` + `alembic upgrade head`
  → health loop (app 2 min, backend 3 min, AI 10 min: TensorRT engine builds) → write
  `.deploy/last-deployed` (sha, time, actor) + append `.deploy/history.log` (gitignored).
  Optional `/version` (backend `GIT_SHA` env) is an app change, so ask.
- Server checkout sits in **detached HEAD** at the deployed SHA by design.
- `ci.yml`: `on: pull_request: branches [main, production]`, `ubuntu-latest`; jobs
  backend (node 20, `npm ci`, `npm test`), frontend (`npm ci`, lint?, `npm run build`),
  ai (python 3.11, CPU, pytest/unittest per service). Only the suites that pass today.
