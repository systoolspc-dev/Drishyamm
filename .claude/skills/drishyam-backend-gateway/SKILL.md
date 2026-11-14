---
name: drishyam-backend-gateway
description: Add the Express backend side of the Drishyam investigation toolkit — /api/investigate routes that proxy to smart-cam-ai, opt-in featureCatalog keys, requireFeature/requireAiCapability gating, audit logging, Sequelize migrations for cases/case_items/case_members/case_audit/evidence_exports, BullMQ jobs and jest tests. Use for any backend/src or backend/migrations change for investigation, cases or evidence export in the Drishyamm repo.
---

# Backend gateway: routes, gating, MySQL, jobs, tests

Root: `backend/`. Rules: hub skill `drishyam-investigation`.

## Route + proxy
- Mount in `src/routes/index.js` like `router.use('/person-tracker', personTrackerRoutes)` (`:52`; app mounts `/api` at `src/app.js:64`).
- `src/routes/investigate.routes.js`: `router.use(authenticate)`, `router.use(requireAiCapability)`, then
  `requireFeature('investigate_search')` etc. per route (pattern `src/routes/personTracker.routes.js:13-16`; `requireFeature`
  passes if ANY listed key is on). Add rate limiting consistent with `src/middleware/rateLimiter.js`.
- `src/controllers/investigate.controller.js`: copy `src/controllers/personTracker.controller.js:24-45` — axios instance on
  `AI_SERVICE_URL` (default `http://smart-cam-ai:8001`), per-request headers `{...aiAuthHeader(req.user), 'X-User-Id', 'X-Operator-Id'}`.
  The tenant travels in the JWT `tid` (`src/utils/aiTenant.js:32 aiTenantId`, `:43 mintAiToken`); never send a tenant from the browser.
  If the AI secret is < 32 chars no token is minted → AI falls back to dev tenant; treat that as misconfig.
- Restrict camera ids to the caller's own cameras (pattern `journeyEnabledCodes`, controller `:52-67`), enrich names from MySQL
  (`attachCameraNames` `:73-90`), map errors with `mapUpstreamError` (`:262`).

## Feature keys (must be OFF by default)
- `src/utils/featureCatalog.js`: groups at `:52`; `isFeatureOn` `:204`. A plain key is ON for full accounts (NULL/[] features);
  only `demo: true` keys are off-until-listed. Add an explicit opt-in flag (e.g. `optIn: true`, treated like `demo` in `isFeatureOn`
  but labelled differently in the admin UI) — or, minimum, `demo: true` — for `investigate_search`, `investigate_cases`, `evidence_export`.
- Mirror in `frontend/src/core/nav/entitlements.js` (`AI_KEYS` `:86`, `DEMO_KEYS`/`featureOn`, `ROUTE_FEATURES` `:100`).
  Add a jest test that a new key is off for `features = null`.
- AI tier: `src/services/entitlements.service.js:106 allowsAny`.

## MySQL (Sequelize migrations only)
- Latest is `migrations/037-create-sync-only-tables.js`; next `038-create-cases.js`, `039-create-evidence-exports.js`.
  Style of 035/036: `'use strict'`, header comment, `async up(queryInterface, Sequelize)` / `down`, idempotent
  (`showAllTables()` before `createTable`, `SHOW INDEX` before index). Do NOT copy 037's `model.sync()`.
- Config `.sequelizerc` → `src/config/database.js` (`underscored: true`, timestamps). Models in `src/models/`, registered in its index.
- Runs on container start (`docker-compose.yml:298`). Manual: `docker compose exec smart-cam-backend npm run db:migrate`, test
  `db:migrate:undo` then migrate again.
- Tables (README §5.1): `cases`, `case_members`, `case_items`, `case_audit`, `evidence_exports` — all with `tenant_id`.

## Audit
- File log: `src/utils/audit.js:65 audit(action, { req, targetType, targetId, outcome, meta })` (never throws).
- DB: `AdminAuditLog` (`src/models/AdminAuditLog.js`) via a local helper like `recordChange` (`src/controllers/accountControl.controller.js:65`).
  Cases get their own `case_audit` rows. Log every search (query, filters, count), case view, item open, export (with reason).

## Jobs (BullMQ)
`src/queues/index.js`: add a name to `QUEUE_NAMES` (`:47`, `drishyam-*`, no `:`), `getQueue(name)`, `registerWorker(name, fn, {concurrency})`
in `src/queues/workers.js` (copy the `TRANSCODE` worker `:136`). Callers check `isEnabled()` and fall back in-process.
Use for case footage preservation, evidence ZIP build (hash while writing, Ed25519 per-tenant signature), file-import orchestration.

## Tests
- `cd backend && npm test` (jest, `test/**/*.test.js`, `test/jest.setup.env.js`). Known stale failures: `streaming.engine`,
  `streaming.factory`, `tmpDocCheck.cameraHealth.row` — anything else failing is yours.
- No existing AI-mock pattern: `jest.mock('axios', () => { const inst = { post: jest.fn(), get: jest.fn() }; return { create: () => inst, ... } })`
  and assert the Authorization header is set and no tenant comes from `req.body`. Mock models with `jest.mock('../src/models', …)`
  and logger like `test/liveRelayStallWatchdog.test.js`.
- Smoke: `curl -s -H "Authorization: Bearer $TOKEN" localhost:5000/api/investigate/...` (backend container `drishyam-backend`, nodemon reloads).
