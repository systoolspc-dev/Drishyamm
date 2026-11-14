---
name: drishyam-investigation
description: Hub for building the Drishyam Investigation Toolkit (features I-1 search index, I-2 attribute/plain-language search, I-3 click to track, I-4 cases, I-5 evidence export, I-6 activity timeline/smart skim, I-7 file import, I-8 Ask Drishyam, I-9 summaries, I-10 vehicle journey) in the Drishyamm repo. Load FIRST for any investigation-module work, planning, PR or review; it gives the end-to-end flow, the existing journey code path, the rules, definition of done, the docs-vs-code corrections, and which drishyam-* sibling skill to use next.
---

# Drishyam Investigation Toolkit — hub

Repo: `/home/rachitgarg1208/github-repos/Drishyamm`. Primary context: `docs/investigation/README.md`
(wins over `docs/investigation/INVESTIGATION-TOOLKIT.md` on paths). Line refs below verified 2026-11-10;
re-check before relying on one (`sed -n`), code moves.

## How the tool is built, end to end

```
camera → smart-cam-ai pipeline (detect → track → face/body)          exists
           │ NEW vms_face/investigate/summariser.py   (I-1, skill: drishyam-pipeline-hook)
           │   on track end (+30 s heartbeat): best crop, image embedding, voted attributes,
           │   1 pt/s bbox, per-minute counts
           ▼
 Postgres vms_face: tracks, track_points, activity_buckets  (Alembic 0007+)   skill: drishyam-ai-schema
 Qdrant vms_tracks (new; vms_appearance untouched) · MinIO <tenant>/tracks/<date>/<track_id>.jpg
           ▲
 smart-cam-ai /investigate/* (search, track-at, seed journey, activity, analyse-file)  skill: drishyam-ai-endpoint
           ▲
 backend /api/investigate/* (JWT, tenant, requireFeature, audit, rate limit)
   + MySQL cases/case_items/case_members/case_audit/evidence_exports, BullMQ   skill: drishyam-backend-gateway
           ▲
 frontend modules/investigation/* + playback additions        skill: drishyam-frontend-investigation
```

Investigation flow for the user: **find** (I-1/I-2) → **follow** (I-3, the existing journey) →
**review** (I-6) → **case** (I-4) → **evidence** (I-5) → **ask** (I-8). The toolkit WRAPS the journey.

Build order (strict): I-1 → I-2 → I-5 → I-3 → I-4 → I-6 → I-7 → I-8 → I-9 → I-10.
Branches: one per feature (`feature/investigation-index`, `feature/investigation-search`,
`feature/evidence-export`, …), small PRs to `main`, the manager merges. **Never commit to main.**

## Existing journey (reuse, don't rewrite) — `ai/face-service/vms_face/`

Photo journey:
1. `api/routes/journey.py:605` `POST /journey/search` (multipart photo; 422 if no face).
2. `journey/embed.py:34` `embed_query_face` → face vector.
3. `journey/search.py:22` `query_appearance(appearance, *, tenant_id, embedding, window_start, window_end, min_similarity, camera_ids, top_k)`
   — cosine ANN on Qdrant `vms_appearance`, tenant + `occurred_at_ts` + `camera_id` filters. **Takes any vector.**
4. `journey.py:703` `_fuse_body` → re-scores face hits with OSNet + clothing colour (`journey/fusion.py:21 FusionWeights`, `:39 body_term`).
   **No body-only ANN path exists**; body only re-ranks face candidates.
5. `journey.py:767` `/cluster` → `journey/cluster.py:21 collapse` → sightings.
6. `journey.py:813` `/stitch` → `journey/stitch_jobs.py:51 create_job` (Redis state + RQ `vms.stitch`)
   → `workers/stitch_worker.py:32 process_job` (`journey/video.py` extract/overlay/concat, `journey/pdf.py:29`,
   `persistence.persist_journey_sync`, Kafka `journey.stitched`). Served at `journey.py:854/885/913`; map from `journey/geo.py:25`.
7. Audit: `journey.py:662` `audit_log.record(action="journey_search", …)`.

Track-seeded journey (already exists, no photo): `journey.py:67` `GET /journey/map?camera_id=&track_id=`
→ `services/reid.py:157 expand_global_identity` BFS over `track_links` (written by `workers/reid_worker.py:66`,
**face-similarity links only**) → `DetectionEvent` timeline. Also `api/routes/reid.py:36 GET /reid/track/{camera_id}/{track_id}`.
So **I-3 is S**: click → track_id via I-1 `track_points` → existing track journey; extend to faceless tracks
with a vector seed (`query_appearance` on `vms_tracks`) + stitch.

## Docs vs code (code is right)

| Docs say | Code says |
|---|---|
| Backend proxies with `X-Service-Token` | AI ignores it. Tenant = JWT `tid` → `api/deps.py:155 current_tenant_id`; minted by `backend/src/utils/aiTenant.js:43 mintAiToken`/`aiAuthHeader` |
| New featureCatalog keys are off by default | A plain key is **ON** for full accounts (NULL features): `backend/src/utils/featureCatalog.js:204 isFeatureOn`. Need an opt-in flag (or `demo: true`) mirrored in `frontend/src/core/nav/entitlements.js` |
| `journey_body_logging` off by default | Code default False (`config/settings.py:107`) but `docker-compose.yml:81` sets `JOURNEY_BODY_LOGGING: "true"` (prod compose too) |
| `vms_appearance` payload has `snapshot_uri` | Not written (`services/face_matcher.py:170 log_appearance`, `workers/match_worker.py:297`); only `tenant_id, person_id, camera_id, role, occurred_at_ts` are indexed |
| Body ReID collection `body_reid` (JOURNEY_CENTRALIZATION.md) | Never built |
| Track ids are global | Per-process counters `face_tracker.py:263` (`t%08d`); unique only with `camera_id` + time window |
| Person detector gives faceless tracks | YOLO boxes in face-service are **untracked** (footfall only, `orchestrator.py:575-642`); `ai/zone-guard/zone_sim.py:263` does `model.track(persist=True)` |
| Vehicles / ANPR | No vehicle detection in any AI service; `anpr` is a `demo: true` feature key |
| JourneyMap goes through the backend | `frontend/src/modules/person-tracking/JourneyMap.jsx:177` fetches AI `/journey/map` directly, no auth header — don't copy |
| Migrations never sync() | `backend/migrations/037-create-sync-only-tables.js` calls `model.sync()` — don't copy |
| — | `frontend/src/core/store/investigationStore.js` already exists (dashboard recents) — name clash |

## Rules (README §6) — check every PR
1. NVR safety: no automatic NVR backfill; respect per-NVR session cap; release sessions; never retry credentials in a loop. Backfill reads recording segments only.
2. Tenant filter server-side on every Qdrant/Postgres query (from JWT); a test must fail if a search path omits it.
3. Audit every search (query+filters+count), journey, case view, item open, export.
4. Feature flags: new opt-in featureCatalog keys + AI settings flags, **off by default**.
5. Migrations only (Sequelize / Alembic). No `sync()`.
6. No regressions: photo journey, person tracker, face watchlist, alerts, live-pipeline latency. Measure GPU/latency before default-on.
7. IR/night tracks: `ir=true`, no colour attributes; UI says "colour not available (night)".
8. Sensitive attributes (gender, age) off by default, per-tenant opt-in. No emotion / "suspicious" scoring.
9. Retention: index data lives as long as its video, except case-held items.
10. Licences checked for every weight/dataset; big weights via Git LFS (`.gitattributes`: onnx, pt, safetensors, …).
11. Git: feature branch → PR → manager merges.

## Definition of done (README §7, short)
I-1 lab tracks with crop/embedding/colour under tenant filter, retention deletes them, report of tracks/camera/day + GPU + storage, 1 h backfill < 15 min ·
I-2 recall@20 ≥ 80 % person / ≥ 70 % vehicle, air-gapped rule parser, audited, URL filters, photo input on same page ·
I-3 click → journey across ≥ 3 cameras + stitched video, confirm/reject, works without live AI ·
I-4 case from alert, items, member, merged timeline, survives retention ·
I-5 ZIP manifest verifies, 1 changed byte fails, export logged with reason · I-6 density bar + skim ·
I-7 1 h phone + Hikvision import indexed < 30 min, SHA-256 at upload · I-8 ≥ 80 % correct+cited ·
I-9 digest with linked sentences · I-10 vehicle across ≥ 3 cameras with one plate read.

## Per-PR checklist
- Branch from fresh `main`; one feature; flag off by default.
- Tests: AI `unittest` in container, backend `npm test` (3 known stale failures: streaming.engine, streaming.factory, tmpDocCheck), frontend `npm test` + `npm run build`.
- Tenant test + audit call present; no change to `vms_appearance` or photo-journey behaviour.
- Commit/PR only when the user says so.

## Sibling skills
- `drishyam-ai-schema` — Alembic migrations, ORM, `vms_tracks` collection, MinIO keys, retention.
- `drishyam-ai-endpoint` — FastAPI `/investigate/*` routes, tenant/audit/flag, RQ jobs, AI tests.
- `drishyam-pipeline-hook` — I-1 summariser in the live pipeline, measurement spike, NVR safety.
- `drishyam-backend-gateway` — Express `/api/investigate`, feature keys, MySQL cases/evidence, BullMQ, jest.
- `drishyam-frontend-investigation` — React pages, routing, nav, gating, playback additions.
