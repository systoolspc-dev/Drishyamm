---
name: drishyam-deploy
description: Deploy, verify, or roll back Drishyam on the TESTING server (auto-deploy of main, Tailscale-only access), and the rules for touching any server. Use whenever the task involves deploying code, the self-hosted runner, scripts/deploy.sh, the deploy-testing workflow, the ts.net testing URL, server health after a merge, rolling back a bad deploy, or someone wanting to "just fix it on the server".
---

# Drishyam: deploying to the testing server

Full background: `docs/DEPLOYMENT.md`. Setup progress (what exists yet):
`.claude/skills/drishyam-cicd-setup/SKILL.md`. Check its status table before
assuming a workflow, script, nginx entrypoint or Tailscale serve config exists.

## Golden rules (never break these)

1. **Code reaches a server only through GitHub + the pipeline.** No editing files on
   a server, no `scp`, no hot-patching inside containers, not even "temporarily".
   If asked to, explain the rule and offer a branch + PR. A demo hotfix already made
   on a server gets committed to a branch and PR'd **the same day**.
2. **Never push to `main` or `production`.** Work on `<name>/<module>-<task>` /
   `<name>/fix-<module>-<task>` (investigation: `<name>/investigation-i<N>-<feature>`), open a PR into `main`. Releases are PR `main` → `production`.
3. **Never commit secrets**: `.env*` (except `*.env.example`), keys, certs, Tailscale
   auth keys, runner tokens.
4. **Ask before destructive or hard-to-undo actions**: `git reset --hard`, `git clean`,
   deleting files/volumes (`docker compose down -v`, `docker volume rm`), dropping DBs,
   stopping the stack for long, firewall changes, history rewrites, force-push.
5. **Production is not ours.** It deploys from the `production` branch with its own
   runner (label `production`) on another machine. Don't create, change or run
   anything that targets it.
6. If the server checkout is dirty, **stop and show the diff**. Never discard it:
   someone edited the server by hand.

## Server facts

- Fedora 45, native Docker (not WSL), RTX 5090 used by the AI containers.
- Checkout: `/home/systools-pc/Desktop/Projects/Drishyamm`; compose project `drishyamm`
  (volumes `drishyamm_*`). After deploys it sits in detached HEAD at the deployed SHA.
- User `systools-pc` (docker group). `sudo` needs a password, so the user runs root
  commands with `! sudo ...`.
- Access: **public via Tailscale Funnel** (since 2026-11-13, maintainer's choice): `<testing URL>`. No site password and open self-registration (user's explicit choice). Only the app's JWT login protects `/api`; `/ai/`, `/hls/`, `/live/` are unauthenticated. Funnel → `edge` nginx on 127.0.0.1:8080 (`deploy/testing/`).
- Dev-mode compose: `./backend`, `./frontend` bind-mounted (nodemon / Vite). A checkout
  changes running code immediately. `node_modules` live in named volumes, so after a
  lockfile change run `docker compose exec -T <svc> npm ci`; a rebuild won't do it.
- Migrations run on container start (backend `sequelize-cli db:migrate` + seeds; AI
  `alembic upgrade head`) and again explicitly in deploy.sh. Forward-only.
- Backups: deploy.sh dumps both DBs to `~/drishyam-backups/<time>-<sha>/` before migrating.

## Deploy (normal path)

Merge the PR into `main` → `deploy-testing.yml` on the self-hosted runner
(`[self-hosted, testing]`, `concurrency: deploy-testing`) → `scripts/deploy.sh <sha>`
in the server checkout. To redeploy or pick a SHA: GitHub → Actions →
*Deploy testing* → *Run workflow* → `sha`.

Running it by hand is only for debugging the pipeline itself, as `systools-pc`, with
a SHA that is on `origin/main`: `cd <checkout> && scripts/deploy.sh <sha>`.

## Verify a deploy

```bash
cd /home/systools-pc/Desktop/Projects/Drishyamm
cat .deploy/last-deployed; git rev-parse HEAD     # same SHA?
docker compose ps                                 # backend + ai (healthy)
curl -fsS localhost:5000/api/health/live
curl -fsS localhost:8001/healthz
curl -fsSI localhost:5173/ | head -1
docker compose logs --since 10m smart-cam-backend | grep -i "migrat\|error" | tail
docker compose logs --since 10m smart-cam-ai     | grep -i "alembic\|error" | tail
tailscale funnel status
```

From a tailnet device, at `https://drishyam-test.<tailnet>.ts.net`: login, API pages
load, live notifications (Socket.IO), Live View plays (WebRTC over the tailnet or HLS),
playback, an AI page (Live detections / Find a person) responds.

## Roll back

1. Fast: Actions → *Deploy testing* → *Run workflow* with the last good SHA (from
   `.deploy/history.log` or earlier successful runs).
2. Then fix `main`: **Revert** the bad PR on GitHub and merge the revert, or the next
   merge will bring the bad code back.
3. Schema isn't rolled back. Fix forward with a new migration, or restore the
   pre-deploy dump from `~/drishyam-backups/` (`docs/BACKUP_RESTORE.md`), after
   asking the user.

## Troubleshooting

| Symptom | Likely cause | Look at |
|---|---|---|
| Deploy fails "working tree dirty" | hand edit on server | `git status`, `git diff`; show the user, don't discard |
| Runner offline | service stopped / re-registration needed | `systemctl status 'actions.runner.*'`, `~/actions-runner/_diag/` |
| Backend unhealthy after deploy | failed migration, missing env var, new npm dep | `docker compose logs smart-cam-backend`; `npm ci` in container |
| AI unhealthy for minutes | first boot builds TensorRT engines (start_period 300 s) | wait, then `docker compose logs smart-cam-ai` |
| ts.net URL: "Blocked request. This host is not allowed" | Vite `server.allowedHosts` | `frontend/vite.config.js`, `.env` |
| Page loads, API/AI calls go to localhost | `PUBLIC_API_URL` / `VITE_AI_BASE_URL` / CORS | root `.env`, restart `smart-cam-app` + backend |
| ts.net URL doesn't resolve / cert error | MagicDNS / HTTPS certs off, device not on tailnet | Tailscale admin console, `tailscale status` |
| Video fails remotely, works locally | WebRTC host not advertised / H.265 transcode / NVR loss | `webrtcAdditionalHosts`, `docs/12-streaming-recording-architecture.md` |
