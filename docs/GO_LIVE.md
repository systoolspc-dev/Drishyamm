# Go-Live Runbook — from hardened branch to verified production

> All the 2026-07-05 hardening lives on branch **`harden/critical-fixes`** (43+
> commits; baseline preserved on `master`). It is verified as far as source
> allows (74 unit tests green, syntax/load checks) but **not yet run against a
> real stack**. This runbook is the ordered, low-risk path to make it live.
> Do the steps in order — each one gates the next.

Legend: 🤖 = I can do it in-repo · 🧑 = needs you (a remote, a console, a running host).

---

## 0. Prereqs
- The **runtime copy** of the repo (this working copy has an incomplete
  `npm install` — `prom-client` and the frontend `node_modules` are missing).
- Docker + Docker Compose on the target host.
- Access to the provider consoles for key rotation (LiveKit, S3/10pb, Shinobi).

---

## 1. 🧑 Put the branch on a private remote (so CI runs)
There is **no git remote configured** — nothing has been pushed anywhere. Create
a **private** repo, then:
```bash
cd <runtime-copy>
git remote add origin <your-private-repo-url>
git push -u origin master
git push -u origin harden/critical-fixes
```
Open a PR `harden/critical-fixes → master`. GitHub Actions (`.github/workflows/ci.yml`)
runs the **backend test gate** (must be green) + the **frontend build/lint**
(informational). This is the first real signal on whether the frontend builds.

## 2. 🧑 Rotate the exposed secrets (BEFORE deploying)
The literal keys were on disk / in circulated copies — treat them as
compromised. Rotate at the source, then put the new values in the git-ignored
`.env` files (never commit). Checklist (also in `audit.md`):
- [ ] LiveKit API key/secret → `.env` + `smart-cam-backend/.env`
- [ ] S3 (10pb) access/secret → `smart-cam-backend/.env` (scope IAM to the bucket)
- [ ] Shinobi keys, `SERVICE_TOKEN` (must match backend ↔ AI), JWT_SECRET/refresh
- [ ] MediaMTX API `drishyam/drishyam123` → `.env` + `mediamtx.yml`
- [ ] Strong DB passwords: set in root `.env`, then `ALTER USER`/re-init volumes
- [ ] **Back up** `CAMERA_CRED_KEY` (backend) + `VMS_CAMERA_CRED_KEY` (AI) —
      lost key = unrecoverable encrypted rows.

## 3. 🧑 Bring the stack up + smoke-test
```bash
docker compose up -d --build
docker compose ps            # all healthy? (backend + AI now have healthchecks)
```
Smoke checks:
- [ ] `curl -f http://localhost:5000/api/health/live` → 200
- [ ] `curl -f http://localhost:8001/healthz` → 200
- [ ] Log in on the SPA; open **/live** (WebRTC) and **/live-hls** (HLS) — both play.
- [ ] Create a camera group, view the grid, then **delete** it → confirm the
      stream stops and does **not** reappear (the transcoder-teardown fix).
- [ ] Datastore ports are loopback-only: `curl telnet://<host>:3307` from another
      box should fail (bound to 127.0.0.1).

## 4. 🧑 Verify the migrations applied
The backend runs `sequelize-cli db:migrate` on boot. Confirm the new ones landed:
- [ ] `022` ai_events alert indexes · `023` widened `password` columns.
- [ ] New camera adds now store an encrypted password (`enc:v1:` prefix in the
      DB `cameras.password`). Existing rows re-encrypt when next saved — run the
      backfill (below) to convert them all at once, or leave them (they still read).

## 5. 🤖/🧑 Turn ON live-stream protection (H9)
Built + gated off. To activate (see `docs/STREAM_SECURITY.md`), use the helper:
```bash
./scripts/enable-stream-auth.sh          # sets STREAM_URL_SECRET, flips nginx, verifies
docker compose restart smart-cam-backend
nginx -t && nginx -s reload              # (or restart the nginx container)
```
Then verify: a logged-in user still plays streams, but a stream URL opened in a
**fresh incognito window (no cookie) returns 401**. If playback breaks, revert
(unset `STREAM_URL_SECRET`, re-comment the nginx `auth_request` lines).

## 6. 🧑 Wire nightly backups
```bash
crontab -e
# 0 2 * * *  /opt/drisyam/scripts/backup-databases.sh >> /var/log/drisyam-backup.log 2>&1
```
Ship the dumps off-box (S3/rsync). Test one **restore** (see `docs/BACKUP_RESTORE.md`).

## 7. 🧑 Merge + tag
Once CI is green and smoke-tests pass:
```bash
git checkout master && git merge --no-ff harden/critical-fixes
git tag -a v1.1.0-hardened -m "Critical+High+Medium hardening" && git push --tags
```

---

## What is deliberately still OFF (safe defaults — enable when ready)
| Feature | Flag / step | Why off |
|---|---|---|
| Live-stream auth (H9) | `STREAM_URL_SECRET` + nginx uncomment | Needs playback smoke-test |
| Container memory limits (H7) | add `deploy.resources.limits` per host | Needs host sizing (too-low OOM-kills) |
| Camera-limit enforcement (H5) | `ENFORCE_CAMERA_LIMITS` (default ON) | Set `=false` in dev if a low-plan user blocks adds |
| Camera cred encryption | `CAMERA_CRED_KEY` (already set in .env) | Back up the key first |

## Still needing a runtime to build safely (deferred)
- **M3** httpOnly-cookie auth · **M11** distributed supervisor flap state.
  Both were left as designs (see `audit.md`) because they can only be verified
  against a running stack.
