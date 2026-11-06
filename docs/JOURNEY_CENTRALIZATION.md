# Journey Centralization Plan

**Goal:** Collapse the journey/forensic capability into the **three** core services
(`smart-cam-ai`, `smart-cam-backend`, `smart-cam-app`) and **retire two standalone stacks**:
the greenfield `journey-platform/` *and* the existing `person-tracker` service. One product.

- **Scope (now):** the full **forensic** slice — upload a target image → embed (face + body)
  → ANN search → fuse → cross-camera journey → map/timeline/heatmap → stitched MP4 + PDF.
- **Out of scope (later):** live ingestion + <2s alerts (journey-platform Phases 3–5).
- **Decided by:** anil@thecodestory.ai (2026-05-30).

> What we *port* is journey-platform's **better brain** (face+body fusion, dual vector
> collections, multiplicative time/space gates, Global Person ID). What we *absorb* is the
> already-working forensic engine (`person-tracker`: upload→find→stitched MP4). Both land
> inside `smart-cam-ai`; the standalone services are deleted after parity.

---

## 0. The actual starting point (what already runs)

From the root `docker-compose.yml` — this is a **merge**, not a build:

| Already running | Owner | Role |
|---|---|---|
| **Postgres** `vms_face` (postgres:16-alpine, Alembic) | smart-cam-ai | face/relational data |
| **Qdrant** v1.12.4 | smart-cam-ai, person-tracker | ANN vectors |
| **MinIO** | smart-cam-ai, person-tracker | snapshots + journey artifacts |
| **Redis** | backend, ai, person-tracker | jobs/cache/RQ |
| **MySQL** `drishyamvms` (Sequelize) | smart-cam-backend | app data: users, cameras, billing |
| **person-tracker** + RQ worker (`:8003`) | standalone | forensic upload→ANN→stitched MP4+PDF+map; **delegates embedding to smart-cam-ai**; backend proxies `/api/person-tracker/*` → it |
| **smart-cam-ai** (`:8001`, GPU, `vms_face` pkg) | standalone | face pipeline; serves `/journey/map` |
| **smart-cam-backend** (`:5000`) | standalone | API gateway, Socket.io, proxies to ai + person-tracker |
| **smart-cam-app** (`:5173`) | standalone | `JourneyMap.jsx`, `PersonTracker.jsx` |

So Postgres/Qdrant/MinIO are **not** new infra. The only net-new infra is **Kafka**.

---

## 1. Infra decisions (corrected to reality)

| Concern | Choice | Action |
|---|---|---|
| App/VMS relational | **MySQL** (keep) | backend, unchanged |
| Journey relational + vectors | **smart-cam-ai's Postgres + pgvector** | flip image → `pgvector/pgvector:pg16` (drop-in, same data dir), `CREATE EXTENSION vector`, add journey tables via **Alembic** |
| ANN hot path | **Qdrant** (keep) | add `body_reid` collection alongside the face one |
| Object storage | **MinIO** (keep — already the artifact store) | journey MP4/PDF/map.json here |
| Job state / RQ | **Redis** (keep) | journey job + progress |
| Event spine | **Kafka** (add now, KRaft mode) | ai emits `journey.events`; spine for deferred live phases |
| Live push to browser | **Socket.io** (keep) | backend relays journey progress + (later) alerts |
| API gateway | **Express** (keep) | backend fronts everything |

Net-new infra: **Kafka only.** Postgres just gains the pgvector extension.

---

## 2. Where the work lands (3 services, 2 retirements)

| Source | Lands in | Disposition |
|---|---|---|
| `person-tracker` API + RQ worker (forensic flow, stitch) | **smart-cam-ai** (`vms_face/journey/`) | **fold in & retire service** |
| journey-platform `search` / `reid` / `journey-builder` (fusion brain) | **smart-cam-ai** | port logic |
| journey-platform `body-reid` (OSNet embed) | **smart-cam-ai** | in-proc module |
| journey-platform `detection-embedding` | **smart-cam-ai** | face exists (InsightFace buffalo_l); add body |
| journey-platform `gateway` / `ws-gateway` | **retire** | backend Express + Socket.io already exist |
| journey-platform `camera-ingestion` / `tracking` / `alert` (live) | **defer** | not forensic |
| backend `/api/person-tracker/*` proxy | **smart-cam-backend** | repoint to `/api/journey/*` → smart-cam-ai |
| `JourneyMap.jsx` + `PersonTracker.jsx` | **smart-cam-app** | merge into one unified Journey UI |

---

## 3. Compute split (most-scalable flow)

- **smart-cam-ai = brain + forensic engine + its own data.** Face embed (InsightFace
  ArcFace) + body embed (OSNet); Qdrant ANN (`vms_appearance` face + new `body_reid`);
  fusion scoring; cross-camera link → Global Person ID; journey-graph build; **stitch worker**
  (absorbs person-tracker-worker, FFmpeg → MinIO); persistence in Postgres+pgvector; Kafka
  emit. Exposes `POST /api/journey/search`, `GET /api/journey/{id}`, keeps `/journey/map`.
- **smart-cam-backend = gateway + orchestration.** Auth/RBAC, kicks off the journey job,
  proxies to ai (replacing the person-tracker proxy), relays progress to the browser over
  Socket.io, owns camera metadata in MySQL (synced to ai's `cameras` for the adjacency graph).
- **smart-cam-app = UI** via backend only.

Camera identity bridges MySQL (backend, source of truth) ↔ ai Postgres `cameras` via the
camera **code / monitor_id** join key.

---

## 4. Forensic flow, end-to-end

```
app: unified Journey page → upload image + filters (time window, cameras, threshold)
   └─ POST  smart-cam-backend  /api/journey/search   (auth/RBAC, audit)
backend:
   1. proxy → smart-cam-ai  POST /api/journey/search   (X-Service-Token, as person-tracker did)
   2. return {job_id}; subscribe to ai progress (Redis) → relay over Socket.io
smart-cam-ai:
   3. embed face (InsightFace) + body (OSNet)
   4. ANN Qdrant: vms_appearance (face) + body_reid (body), time/camera-filtered
   5. fuse:  score = (w_f·face + w_b·body) · time_gate · space_gate   (gates = veto)
   6. cluster per camera → cross-camera link → Global Person ID (persons row, is_unknown)
   7. build journey graph (stops, timeline, route, heatmap) → Postgres+pgvector
   8. stitch worker: cut MediaMTX recordings → concat MP4 + PDF + map.json → MinIO
   9. emit journey.events → Kafka; publish progress → Redis
app:
   10. render timeline + coverage map + heatmap + stitched-MP4 player + PDF download
```

---

## 5. Execution order (we check in between phases)

- **P0 — Infra & contracts.** Flip Postgres image → `pgvector/pgvector:pg16` + `CREATE
  EXTENSION vector`; add **Kafka** (KRaft) to compose; add an Alembic migration for the
  journey schema (persons, cameras, camera_edges, tracks, detections, embeddings(vector),
  journeys, journey_stops, audit_log); move `journey-platform/libs/contracts/events.py`
  into `smart-cam-ai/app/.../journey/contracts.py`.
- **P1 — smart-cam-ai journey module.** Port person-tracker forensic flow + journey-platform
  fusion (search/reid/journey-builder/body-reid). OSNet body embedder. Dual Qdrant. Stitch
  worker absorbed. Expose `/api/journey/*`. Kafka emit + Redis progress.
- **P2 — smart-cam-backend.** Repoint proxy `/api/person-tracker/*` → `/api/journey/*` (ai);
  Socket.io progress relay; auth/RBAC + audit; camera topology sync to ai.
- **P3 — smart-cam-app.** Merge `JourneyMap.jsx` + `PersonTracker.jsx` into one Journey UI,
  all via backend.
- **P4 — Retire.** Remove `person-tracker` + `person-tracker-worker` from compose and delete
  the dir; delete `journey-platform/` once forensic parity is verified. Keep this doc + the
  journey-platform `docs/ARCHITECTURE.md` as design history.

---

## 5a. P1 sub-plan — smart-cam-ai journey module (after reading person-tracker)

person-tracker is a clean FastAPI engine that **already delegates embedding to
smart-cam-ai**. Folding it in makes embedding in-process and adds body fusion. The
target package is `vms_face/journey/`, and it reuses what `vms_face` already exposes:
in-process embed (`deps.runtime`/`recognizer`, same path as `/api/embed/face`), the
`vms_appearance` Qdrant store (`deps.qdrant_appearance`, has an `occurred_at_ts` index →
real range filter, no Python post-filter), `ObjectStore` (MinIO), `RedisBus`,
`services.reid.expand_global_identity` (cross-camera identity via `track_links`), and
`services.audit.record` (DPDP).

Build as vertical slices, each compile-checked:

- **P1a — forensic search slice (face-only, in-process).** `journey/` package:
  `contracts.py` (Pydantic REST shapes, ported from person-tracker `schemas.py` +
  journey-platform `Journey`), `window.py` (duration/ISO parse), `cluster.py` (per-camera
  time clustering → sightings), `embed.py` (in-process face embed adapter), `search.py`
  (Qdrant `vms_appearance` range+camera filter → candidates). Add `POST /journey/search`
  + `POST /journey/cluster` to the existing journey router (thin; delegates to the package).
- **P1b — body fusion.** OSNet body embedder (ONNX via onnxruntime-gpu, **graceful
  fallback to face-only when the model file is absent**), a `body_reid` Qdrant collection
  (`get_qdrant_body()` + settings), and fusion scoring
  `score = (w_f·face + w_b·body)·time_gate·space_gate` using `camera_edges`.
- **P1c — persist + emit.** Write `persons`(Global Person ID, role=UNKNOWN)/`journeys`/
  `journey_stops`/`embeddings`(pgvector) to Postgres; emit `journey.events` to Kafka
  (`aiokafka`); publish progress to Redis.
- **P1d — stitch + artifacts.** Port `video.py`/`recordings.py`/`pdf.py`/`geo.py` +
  `stitch_worker` (RQ) into the package, run as a new smart-cam-ai worker container
  (replaces `person-tracker-worker`); add `POST /journey/stitch`, `GET /journey/stitch/{id}`,
  `/video`, `/report.pdf`, `/map.json`. Add `rq`,`reportlab`,`folium`,`python-dateutil` deps.

New deps land in one rebuild; body OSNet model is optional so the slice runs without it.

### P1 progress (live-verified)

- **P0** ✅ applied & verified on the running stack: pgvector image (data preserved),
  Kafka healthy, `0006_journey` migration applied (vector ext, journey tables, HNSW).
- **P1a** ✅ live: in-process embed + Qdrant appearance search + cluster;
  `POST /journey/search` returns 200 with a real `det_score`, `/journey/cluster` works.
- **P1b** ✅ forensic side live: `body.py` (clothing upper/lower colour via OpenCV — no
  model — plus an **optional** OSNet ONNX embedder that engages when
  `settings.body_model_path` points at a model), `fusion.py`
  (`appearance = w_f·face + w_b·body`, with time/space gates for linking). `/journey/search`
  extracts the query photo's clothing colour and blends colour agreement into candidate
  scores; `body_used` reports when the body term contributed. Graceful face-only when
  candidates carry no clothing attributes.
  - **Follow-up to fully close the loop:** the live detection pipeline must *log* clothing
    attributes into the `vms_appearance` payload (and, with a model, a `body_reid` Qdrant
    vector). The storage path is ready (`face_matcher.append_appearance(extra=…)` already
    merges into the payload; `BodyAttributes.to_payload()` produces the fields; search reads
    them). Population belongs where the **full frame + person box** exist (StreamOrchestrator),
    is **flag-gated OFF** for the 2k-camera CPU budget, and is a deliberate live-pipeline change
    — not bolted onto this forensic-centralization pass.
- **P1c+P1d** ✅ live-verified (end-to-end): ported the stitch pipeline
  (`recordings`/`video`/`pdf`/`geo`/`stitch_jobs`/`events`/`persistence`) into `vms_face/journey/`
  + a new `vms_face/workers/stitch_worker.py` (RQ) + `journey-stitch-worker` compose service
  (no GPU, recordings RO mount). `POST /journey/stitch` → RQ worker locates the real recording
  (`cam_<Camera.code>`, `HH-MM-SS` segments), FFmpeg clip+overlay+concat → MP4, ReportLab PDF,
  `map.json`; persists `journeys`/`journey_stops` + a synthesised Unknown `persons` row (Global
  Person ID); emits `journey.events` to Kafka. Verified: 202→done renders a 2.6 MB MP4 + PDF in
  MinIO, Journey row `status=ready`, event emitted. The port-spec + impl-review workflows caught
  5 blockers (recordings path/regex, RQ 2.x `Connection` removal, output-bucket create, font) and
  a **cross-tenant IDOR** on the stitch read routes — all fixed before ship.
- **smart-cam-ai is now the complete journey brain + forensic engine.** person-tracker is
  functionally absorbed (retire in P4 after the frontend repoints).

- **P2** ✅ live-verified end-to-end **through the backend**: `smart-cam-backend`'s
  `/api/person-tracker/*` proxy (controller `personTracker.controller.js`) now forwards to
  smart-cam-ai `/journey/*` (BASE_URL → AI_SERVICE_URL, paths remapped, operator headers added);
  added `/journey/snapshot` on ai. Verified with a minted admin JWT: search (multipart) → 200,
  stitch → rendered MP4. Also fixed a real shared-infra bug: `QdrantStore.search` now self-heals
  a closed async client (was intermittently 500-ing all appearance searches).
- **P4** ✅ (service retirement): `person-tracker` + `person-tracker-worker` removed from
  `docker-compose.yml` (replaced with a retirement note) and their containers deleted. A stitch
  through the backend **still renders with person-tracker gone** — the product no longer depends
  on it. The `./person-tracker` source dir is kept for reference (delete on confirmation).

### Status: centralization functionally COMPLETE
ONE product. Forensic journey = smart-cam-ai `/journey/*` (brain+engine+stitch worker) ←
smart-cam-backend gateway ← smart-cam-app (works unchanged via the repoint). person-tracker retired.

### Polish — completed 2026-05-31
- **Camera topology sync** ✅ — 17 cameras' `building/floor/zone` synced from backend MySQL
  (`settings.mapping`) → ai Postgres `cameras`. (No GPS lat/lng exists anywhere; the SPA map uses
  floor-plan x/y, so lat/lng stays null — that's a data-entry task, not a code gap.)
- **Live body-attribute logging** ✅ — `StreamOrchestrator` now extracts clothing upper/lower
  colour per detection and logs it into the `vms_appearance` payload, **gated on
  `JOURNEY_BODY_LOGGING` (default false)**. Flip it + restart smart-cam-ai to make forensic body
  fusion engage on new detections. Verified compile + import (inert while off).
- **P4b** ✅ — `./person-tracker` and `./journey-platform` moved to `./_retired_20260531/`
  (reversible — this repo has no git; `mv` back to restore or `rm -rf` to delete permanently).

### Remaining (genuinely optional)
- **Frontend visual merge** — `JourneyMap.jsx` (movement-path view) + `PersonTracker.jsx`
  (forensic search→stitch) are two *distinct* pages that both already run on the centralized
  engine via the repoint. Combining them into one page is a UI/UX task best done with browser
  verification — deliberately NOT done blind to avoid breaking working pages.
- **Socket.io live progress** — the SPA polls `GET /journey/stitch/{id}` (works); push is optional.

## 6. Forks — resolved (2026-05-30)

1. End state: **fold in & retire** journey-platform.
2. Scope: **full forensic slice** (live deferred).
3. Infra: **reuse running stack + add pgvector (on ai's Postgres) + Kafka.** MinIO stays as
   artifact store (it was already). Net-new = Kafka only.
4. Compute: **smart-cam-ai owns brain + forensic engine + journey persistence**; backend =
   gateway/orchestration; app = UI.
5. **person-tracker: fold into smart-cam-ai and retire** the standalone service.
6. pgvector: **on ai's existing Postgres `vms_face`**, journey tables via Alembic.
