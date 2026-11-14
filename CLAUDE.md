# Drishyam: notes for Claude

Video management + smart-camera platform. Backend = Express (`backend/`),
frontend = React/Vite (`frontend/`), AI = FastAPI (`ai/face-service`, plus
`ai/head-count`, `ai/activity-monitor`, `ai/zone-guard`), media = MediaMTX
(`media/stream-service`). Everything runs with `docker compose`. Start with
`README.md` and `docs/dev/00-getting-started.md`.

## Deployment rules (always apply)

- **This machine is the TESTING server**, public at `<testing URL>`
  via Tailscale Funnel (no site password, by the maintainer's choice). Its checkout
  (`/home/systools-pc/Desktop/Projects/Drishyamm`) is auto-deployed from `main`.
  Production deploys from the `production` branch on another machine; we don't touch it.
- **Code reaches a server only through GitHub + the pipeline.** No hand edits on
  servers, no direct pushes to `main`/`production`. Branch → PR → merge → auto-deploy.
- Never commit secrets (`.env*` except examples, `deploy/cloudflared/credentials/*`, tokens, keys).
- Ask before destructive actions (reset --hard, deleting volumes/files, dropping DBs,
  stopping the stack, force-push). Don't touch production.
- Deploy / verify / rollback runbook: skill `drishyam-deploy`.
  CI/CD setup status and open decisions: skill `drishyam-cicd-setup`.
  Human docs: `docs/DEPLOYMENT.md`.
- Never rename compose **service** names; code and env depend on them.
