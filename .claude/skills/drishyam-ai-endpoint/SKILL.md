---
name: drishyam-ai-endpoint
description: Add FastAPI endpoints and background jobs to the Drishyam AI service (smart-cam-ai, ai/face-service/vms_face) for the investigation toolkit — /investigate/search, track-at, seed-journey by track or vector, activity, analyse-file, evidence/backfill RQ jobs — with JWT tenant scoping, audit logging, settings flags and unittest tests. Use for any new or changed route under vms_face/api/routes in the Drishyamm repo.
---

# AI endpoint: FastAPI route + tenant + audit + flag + test

Root: `ai/face-service/vms_face/`. Rules and flow: hub skill `drishyam-investigation`.

## Route
- New file `api/routes/investigate.py`: `router = APIRouter(prefix="/investigate", tags=["investigate"])`
  (pattern `journey.py:55`, `reid.py:33`). Import it in `api/main.py:16` and add `app.include_router(investigate.router)`
  beside the others (`:347-362`).
- Dependencies from `api/deps.py`: `tenant_id: uuid.UUID = Depends(current_tenant_id)` (`:155`, from JWT `tid`),
  `actor: str = Depends(operator_id)` (`:168`), `session = Depends(db_session)` (`:35`), `objects` (`:59`),
  `qdrant_appearance` (`:44`). Never accept tenant from query/body. Ownership checks return 404 for other tenants
  (pattern `journey.py:801 _get_owned_job`, `reid.py:53-55`).
- Auth reality: the AI accepts only the Bearer JWT the backend mints (`backend/src/utils/aiTenant.js`); `X-Service-Token`
  is not checked inbound. Dev bypass exists only with `VMS_ENV=dev` + `VMS_JWT_DEV_BYPASS=true`.
- Flag gate: `from vms_face.config import settings`; if `not settings.investigate_index_enabled` → 404/503. Env var = field name
  upper-cased, no prefix. Add the field to `config/settings.py` with a comment block, default False; cross-checks in
  `Settings.assert_consistent()` (`:832`). Add the env line to `docker-compose.yml` x-ai-env only as `${VAR:-false}`.

## Reuse, don't fork
- Vector search: `journey/search.py:22 query_appearance` (any embedding; kw-only args). For `vms_tracks` write a sibling
  `query_tracks(store, *, tenant_id, vector, filters, top_k)` that builds `extra_must` and calls `QdrantStore.search` (tenant forced).
- Seed journey by track (I-3): existing `GET /journey/map?camera_id&track_id` → `services/reid.py:157 expand_global_identity`.
  Add `POST /investigate/journey` that accepts `{track_uuid}` or `{vector}` and reuses `query_appearance` / `query_tracks`
  + `journey/cluster.py:21 collapse` + `/journey/stitch` flow. Do not change `POST /journey/search` (photo path).
- Body vectors: `journey/body.py:183 BodyEmbedder.shared().embed(img, person_bbox=…)`; colour `journey/body.py:107 extract_clothing`.

## Audit (every search, journey, export)
`from vms_face.services import audit as audit_log` then
`await audit_log.record(actor=f"user:{actor}", actor_kind="user", action="investigate_search", tenant_id=tenant_id,
target_type="tracks", target_id=None, reason=…, metadata={"filters": …, "count": len(results)}, session=session)`
(`services/audit.py:58`; never raises). Pattern: `journey.py:662-677`.

## Background jobs (backfill, analyse-file, evidence render)
Copy `journey/stitch_jobs.py`: job JSON in Redis `vms:<feature>:job:{id}`, `Queue(name).enqueue("vms_face.workers.<x>.process_job",
job_id, job_timeout=…)`; put `tenant_id` + `created_by` in the payload; worker refuses jobs without tenant (`stitch_worker.py:124`),
never raises, records errors in job state. New queue/worker → new compose service like `journey-stitch-worker` (`docker-compose.yml:437`).
**NVR rule:** backfill reads recording segments only (`/recordings` mount); an NVR "analyse this hour" job uses one session,
honours the per-NVR cap, stops on first error, and is only ever user-triggered.

## Tests (unittest, in container)
- Add `vms_face/tests/test_investigate_*.py` (`unittest.TestCase`; header docstring with the run command like `test_footfall_line.py`).
- Required: a tenant test — call the search helper with a fake `QdrantStore` and assert every `search()` call carries
  `tenant_id`, and that the route has `current_tenant_id` in its dependencies (`app.routes` introspection) so a route without it fails.
- Route tests: `fastapi.testclient.TestClient` with `app.dependency_overrides[current_tenant_id] = lambda: TENANT` and fake stores;
  or mint a token with `core/security.py:76 issue_token`.
- Run: `docker compose run --rm --no-deps smart-cam-ai sh -c 'cd /srv/app/face_detection && python -m unittest discover -s vms_face/tests -t .'`
  (smart-cam-ai is usually not running locally; `run --rm` is enough for pure tests; source is bind-mounted so no rebuild).
- Smoke after deploy: `curl -s localhost:8001/healthz`, then call through the backend (`/api/investigate/...`), not directly.
