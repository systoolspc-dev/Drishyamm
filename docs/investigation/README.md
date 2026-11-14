# Investigation module: context for AI assistants and engineers

**Read this first** before writing any code for the investigation module. It says what we are building, why, in what order, how it plugs into the existing Drishyam system, and which rules you must not break.

- **Repo:** `systoolspc-dev/Drishyamm` (this repo, the full end-to-end system). All investigation code lives here.
- **Full product plan** (the long version, with impact, pricing and risks): `RG1208/Drishyam` → [`competitor-analysis/INVESTIGATION-TOOLKIT.md`](https://github.com/RG1208/Drishyam/blob/main/competitor-analysis/INVESTIGATION-TOOLKIT.md). That plan was written before this repo was mapped, so **where its file paths differ from this doc, this doc wins.**
- **Status:** Phase 0 measurement in progress on `rachit/investigation-i1-search-index` (2026-11-14). Runbook: [`PHASE0_MEASUREMENT.md`](PHASE0_MEASUREMENT.md).
- **Product decisions (2026-11-14):** (1) built **inside Drishyam** and integrated with it directly; a standalone module is a later, separate project. (2) The toolkit must be **forensic-grade**: rules 12–18 in §6 are mandatory.

---

## 1. What we are building, in one paragraph

Drishyam already **detects** things live (face, watchlists, zones, head count, ANPR…) and already does a **forensic person journey from a face photo** (face + body fusion → cross-camera sightings → map, timeline, stitched MP4, PDF). What it can't do is help an investigator who **doesn't have a photo**: "a man in a red top with a backpack, gate 3, between 1 and 4 pm." The investigation module adds that. It builds a **search index of every person and vehicle track** while the AI is already watching, then puts tools on top: describe-and-search, click-to-track, cases, evidence-grade export, smart skim, file import, a grounded "Ask Drishyam" assistant, summaries and vehicle journeys.

**Positioning:** *"Monitor, record and investigate in one system."* Competitors (VogicAI, Project Sanjay, CerebVision, Kautilya) sell investigation as a layer on top of someone else's NVR. We own the cameras, recordings and ReID, so the index is the missing piece.

## 2. What we want to achieve

| Goal | Target | How it's measured |
|---|---|---|
| First relevant sighting from a description | < 2 min (today: hours of scrubbing) | Pilot time study |
| Full multi-camera reconstruction + evidence pack | < 15 min | Pilot time study |
| Search recall@20, daytime person colour + bag | ≥ 80 % | Offline eval set (§9) |
| Search recall@20, daytime vehicle type + colour | ≥ 70 % | Offline eval set |
| Search p95 latency, 30 days × 100 cameras | < 2 s | Load test |
| Extra GPU load from indexing | < 10 % of detection load | Lab measurement |
| Ask Drishyam: correct and cited | ≥ 80 %, zero uncited claims | 100-question eval |

Business outcomes: close the competitor gap on "forensic / natural-language / attribute search", win police / safe-city / campus / retail pilots with one demo, sell an "Investigate" add-on per camera, and make Drishyam the system of record for incidents (cases, evidence), which makes it hard to replace.

## 3. Features and build order

Build strictly in this order: each step reuses the one before it.

| Phase | # | Feature | One line | Effort |
|---|---|---|---|---|
| **1 · Find** (weeks 0–6) | **I-1** | Search index | One record per person / vehicle track: best crop, image embedding, attributes, 1 pt/s positions, per-minute activity counts | M |
| | **I-2** | Attribute + plain-language search | Filters (class, colours, bag, helmet, cameras, time) or a sentence in English / Hindi / Hinglish → ranked results grouped by person | M |
| | **I-5** | Evidence-grade export | ZIP: PDF + original and H.264 clips + `manifest.json` with SHA-256 + signature + export log + verify page | S |
| **2 · Follow** (weeks 6–12) | **I-3** | Click to track | Click anyone in playback or a result → the existing journey, seeded by their body / face vector, no photo needed | S–M |
| | **I-4** | Cases | One workspace per incident: items, members, merged timeline, legal hold, audit | M |
| | **I-6** | Activity timeline + smart skim | Density bar on the playback timeline, "play only activity", jump to next person / vehicle, key-frame strip | S–M |
| **3 · Ask** (weeks 12–22) | **I-7** | Recorded-file import | Upload phone / USB / NVR exports into a case; indexed like a camera | M |
| | **I-8** | Ask Drishyam | Chat + voice agent that calls our search APIs; every answer cites tracks or clips | L |
| | **I-9** | AI summaries | Time-range summaries, daily digest, key frames per alert, built from structured data | M |
| | **I-10** | Vehicle journey | Plate + type + colour + vehicle ReID → route across cameras | M |
| **4 · Later** | — | Associations, video synopsis, audio search, "watch for this" live rule | — | M–L |

Branches and pull requests: **one per feature**, named `<yourname>/investigation-i<N>-<feature>` (`rachit/investigation-i1-search-index`, `rachit/investigation-i3-click-to-track`, `rachit/investigation-i4-cases`, …), all to `main`, reviewed and merged by the manager. Never commit straight to `main`. Full list and rules: [`docs/GIT_WORKFLOW.md` → Branch naming](../GIT_WORKFLOW.md#branch-naming).

## 4. The existing system you are building on

Verified in this repo on 2026-11-10. Check again before relying on a detail; code moves.

### 4.1 Services (`docker-compose.yml`)

| Service | Code | Role for this module |
|---|---|---|
| `smart-cam-ai` (FastAPI `:8001`) | `ai/face-service/vms_face/` (`uvicorn vms_face.api.main:app`, runs `alembic upgrade head` on start) | Owns detection, tracking, ReID, journey. **The index, search, click-to-track and file analysis go here.** |
| `smart-cam-ai-worker` | `vms_face.workers.match_worker` | Face matching worker |
| `journey-stitch-worker` | `vms_face.workers.stitch_worker` (RQ queue `vms.stitch`) | Stitched MP4 / PDF for journeys. Reuse its pattern for evidence and backfill jobs. |
| `smart-cam-backend` (Express `:5000`) | `backend/src/` | API gateway: auth, tenancy, entitlements, proxies to AI. **Investigation routes, cases, evidence log go here.** |
| `smart-cam-app` (Vite `:5173`) | `frontend/src/` | React UI. **New `modules/investigation/` goes here.** |
| `postgres` (`pgvector/pgvector:pg16`, DB `vms_face`) | Alembic in `ai/face-service/vms_face/alembic/` | AI-side relational data. **`tracks`, `track_points`, `activity_buckets` go here.** |
| `qdrant` (v1.12.4) | `vms_face/infra/qdrant.py` (`QdrantStore`, tenant-filtered) | Vectors. Existing collection `vms_appearance`. **New collection for track embeddings.** |
| `mysql` (DB `drishyamvms`, Sequelize) | `backend/src/models/`, `backend/migrations/` | App data. **`cases`, `case_items`, `case_members`, `case_audit`, `evidence_exports` go here.** |
| `minio` | `vms_face/infra/minio_store.py` | Snapshots, journey artifacts. **Track crops and case footage go here.** |
| `redis`, `kafka` | `vms_face/infra/redis_bus.py`; Kafka topic `journey.events` | Jobs, cache, event spine |
| `stream-service`, `smart-cam-transcoder` | — | Live and playback video. Don't change for this module except through existing APIs. |

**No new infrastructure is needed.** Postgres, Qdrant, MinIO, Redis and the RQ / BullMQ workers already exist.

### 4.2 Journey and forensics code that already exists (reuse, don't rewrite)

| What | Where | Note for this module |
|---|---|---|
| Journey package | `ai/face-service/vms_face/journey/` (`search.py`, `embed.py`, `body.py`, `fusion.py`, `cluster.py`, `video.py`, `pdf.py`, `geo.py`, `persistence.py`, `stitch_jobs.py`, `contracts.py`) | The core of I-3, and the PDF / stitch code for I-5 |
| Appearance ANN search | `journey/search.py` → `query_appearance(appearance, tenant_id, embedding, window_start, window_end, min_similarity, camera_ids, top_k)` | **Already takes any embedding**, not a photo. I-3 can seed it with a stored vector. |
| Journey API | `vms_face/api/routes/journey.py`: `POST /journey/search` (**face photo upload only**, via `jembed.embed_query_face`), `/cluster`, `/stitch`, `/stitch/{id}/video`, `/report.pdf`, `/map.json`, `/snapshot`, `GET /map` | I-3 adds a seed-by-track / seed-by-vector entry point beside the photo one |
| Other AI routes | `api/routes/search.py` (`/by-image`, `/appearances`), `api/routes/reid.py` (`/track/{camera_id}/{track_id}`, `/links/recent`, `/ground/{event_id}`) | `/reid/track/...` is a likely starting point for "find the track under the click" |
| Appearance index | Qdrant `vms_appearance`; payload `camera_id, event_id, occurred_at, occurred_at_ts (indexed), person_id?, track_id?, snapshot_uri?` | **Face-triggered**: candidates always have a face score; body is fused only when available. People seen only from behind, and all vehicles, are **not** in it. This is why I-1 needs a person- and vehicle-detector-driven track index. |
| Clothing colour | `journey/body.py` → `extract_clothing()` → `BodyAttributes(upper_color, lower_color, …)`, nearest-colour anchors | Ready-made colour baseline for I-1 / I-2. Live logging sits behind `journey_body_logging` (**off by default**, settings.py). |
| Body ReID | `journey/body.py` → `BodyEmbedder` (OSNet x1.0 MSMT17 ONNX, 512-d; `body_model_path`) | Use for grouping results by person (I-2) and for I-3 seeds |
| Person detector | `vms_face/infra/person_detector.py` (YOLOv8 ONNX, optional, `pipeline_person_detection_enabled`) | Track source for faceless people in I-1 |
| Per-track voting pattern | `vms_face/services/track_attributes.py` (quality-weighted votes, O(1) per track) | **Copy this pattern** for I-1 attributes: aggregate over the track, assert only when settled |
| Track embedding pool | `vms_face/services/track_embedding_pool.py` | Relevant to choosing the best crop / vector per track |
| Pipeline | `vms_face/pipeline/orchestrator.py`, `ingest*.py`, `deepstream_bridge.py` | Where the "track ended" hook for I-1 must be added |
| Retention | `vms_face/workers/retention_worker.py` | Extend so index data expires with video, and case items are held |
| Audit | `vms_face/services/audit.py`; backend `models/AdminAuditLog.js` | Log every search, journey, case view and export |

### 4.3 Backend and frontend touch points

| Layer | Existing pattern to follow | Where new code goes |
|---|---|---|
| Backend routes | `backend/src/routes/index.js` mounts `router.use('/person-tracker', personTrackerRoutes)`, which proxies to the AI service with `X-Service-Token` (`controllers/personTracker.controller.js`) | `routes/investigate.routes.js` + `controllers/investigate.controller.js`, mounted at `/investigate` |
| Feature gating | `backend/src/utils/featureCatalog.js` (keys such as `person_search`, `journey_map`); `middleware/requireFeature.js`, `requireCapability.js`, `requireAiCapability.js`, `authorize.js` | New keys, e.g. `investigate_search`, `investigate_cases`, `evidence_export`; every route behind `requireFeature` |
| Backend DB | Numbered Sequelize migrations in `backend/migrations/` (latest seen: `037-create-sync-only-tables.js`) | `038-create-cases.js`, `039-create-evidence-exports.js`, … **Migrations, never `sync()`** |
| Backend jobs | `backend/src/queues/` (BullMQ) | Case footage preservation, evidence export, file-import orchestration |
| AI DB | Alembic in `vms_face/alembic/versions/` (latest seen: `0006_journey.py`) | `0007_investigation_tracks.py`, … |
| Frontend | `frontend/src/modules/<feature>/` (e.g. `person-tracking/JourneyMap.jsx`, `PersonTracker.jsx`, `LiveTracker.jsx`, `face/PersonnelSearch.jsx`, `vehicle/VehicleHub.jsx`); playback in `core/pages/Playback.jsx`, `NvrPlayback.jsx`, `CloudPlayback.jsx`, `core/pages/playback/ClipExport.jsx` | `frontend/src/modules/investigation/` (Search, Case, Evidence pages); timeline density bar and click-to-track as additions to the playback pages |

## 5. Architecture of the module

```
 camera ─► smart-cam-ai pipeline (orchestrator) ─► detect ─► track ─► face / body ReID   (exists)
                                     │
                                     │  NEW  vms_face/investigate/summariser.py
                                     │  on track end (+ 30 s heartbeat for long tracks):
                                     │    best crop · image embedding · attributes (voted per track)
                                     │    · 1 pt/s bbox · per-minute counts
                                     ▼
     Postgres vms_face: tracks, track_points, activity_buckets      (Alembic 0007+)
     Qdrant: vms_tracks (image embedding + filter payload)           (new collection)
     MinIO:  <tenant>/tracks/<date>/<track_id>.jpg
                                     │
         smart-cam-ai  /investigate/*  (search, track-at, seed journey, activity, analyse-file)
                                     ▲
         smart-cam-backend  /api/investigate/*  (JWT, tenant, requireFeature, audit, rate limit)
                        + MySQL cases / evidence_exports, BullMQ jobs
                                     ▲
         smart-cam-app  modules/investigation/*  + playback additions
```

**Design decisions (already made; ask before changing):**

1. **Index at detection time, per track, not per frame.** One result per person-pass is readable and roughly 100–1000× smaller.
2. **Two signals:** an open-vocabulary image embedding (SigLIP / OpenCLIP class; check the commercial licence) **plus** structured attribute heads (top / bottom colour, top type, bag, helmet, cap; vehicle type and colour, including Indian classes such as auto-rickshaw and tempo). Start colour from `journey/body.py`; train attribute heads on our own labelled crops (public pedestrian-attribute datasets are mostly research-only).
3. **Keep `vms_appearance` as it is.** The new `vms_tracks` index sits beside it. Link the two through `track_id`, `event_id`, and the face / body vector ids. Don't break existing journey behaviour; the photo-based journey must keep working unchanged.
4. **Query parsing:** an LLM with structured output for cloud tenants; a local LLM **plus a rule-based parser** (English + Hindi colour / object / date words, fuzzy camera names) for on-prem / air-gapped. Always show parsed filters as editable chips.
5. **Ranking:** hard filters in Qdrant → vector similarity + attribute match + crop quality → group by body ReID ("seen on 4 cameras").
6. **Ask Drishyam is a tool-using agent over our APIs**, never a model watching raw video at query time. Every factual claim cites a tool result.
7. **Evidence:** hash while writing, keep the `original` stream-copy and an H.264 copy, sign the manifest with a per-tenant Ed25519 key, require a free-text reason on export.

### 5.1 Data model (starting point)

Postgres (`vms_face`), Alembic:

```sql
tracks(id uuid pk, tenant_id uuid, camera_id uuid, source text ('live'|'backfill'|'file'), case_id uuid null,
       tracker_id text, object_class text, first_seen timestamptz, last_seen timestamptz,
       best_crop_key text, best_crop_ts timestamptz, attributes jsonb, zones text[],
       appearance_id uuid null, body_vector_id text null, plate text null, quality real, ir boolean)
  -- indexes: (tenant_id, camera_id, first_seen), (tenant_id, object_class, first_seen), GIN(attributes)
  -- partitioned by day; dropped with video retention unless held by a case
track_points(track_id uuid, ts timestamptz, bbox smallint[4] /* 0–1000 grid */, pk(track_id, ts))
activity_buckets(tenant_id uuid, camera_id uuid, minute timestamptz, object_class text, count int,
                 pk(camera_id, minute, object_class))
```

Qdrant `vms_tracks`: int8-quantised image vector; payload `tenant_id` (**mandatory filter**), `camera_id`, `site_id`, `object_class`, `first_seen_ts`, `attr_*`, `source`, `case_id`.

MySQL (`drishyamvms`), Sequelize migrations:

```
cases(id, tenant_id, number, title, status, priority, tags json, created_by, closed_at, timestamps)
case_members(case_id, user_id, role enum('owner','editor','viewer'))
case_items(id, case_id, type enum('track','clip','snapshot','search','journey','file','note'),
           camera_id, ts_from, ts_to, ref json, note text, preserved_key, sha256, added_by, added_at)
case_audit(id, case_id, user_id, action, detail json, at)
evidence_exports(id, tenant_id, case_id null, user_id, reason, files json /* path, sha256, size */,
                 manifest_sha256, signature, ip, created_at)
```

## 6. Rules you must not break

1. **NVR safety (from the media pipeline):** never retry NVR credentials in a loop; respect the per-NVR session cap; release sessions. **Never backfill automatically from an NVR.** NVR replay is real time and uses sessions. Backfill reads **cloud / local recording segments** only; NVR-only footage is analysed only after an explicit, capped user action ("analyse this hour") using one session and stopping on the first error.
2. **Tenancy:** every Qdrant and Postgres query is filtered by `tenant_id` server-side, taken from the JWT via the backend (`current_tenant_id` dependency in the AI service). The browser never chooses the tenant. Add a test that fails if a search path runs without the filter.
3. **Audit everything:** search (query + filters + result count), journey, case view, item open, export.
4. **Feature-flag everything:** new `featureCatalog` keys, off by default, so partial work can merge safely.
5. **Migrations only:** Sequelize migrations for MySQL, Alembic for Postgres. No `sync({ alter })`.
6. **Don't regress existing features:** the photo journey, person tracker, face watchlist, alerts and the live pipeline's latency. Put new pipeline work behind a setting (like `journey_body_logging`) and measure its GPU / latency cost before turning it on by default.
7. **Honesty at night:** IR / greyscale tracks get `ir = true` and **no colour attributes**. The UI says "colour not available (night)" instead of silently missing results.
8. **Sensitive attributes** (gender, age) stay **off by default** and per-tenant opt-in. No emotion or "suspicious-looking" scoring.
9. **Retention:** index data lives exactly as long as the video it points at, except items pinned to a case (legal hold).
10. **Licences:** check the commercial licence of every model weight and dataset before shipping. Large weights go through Git LFS (see `.gitattributes`).
11. **Git:** one branch per feature (`<yourname>/investigation-i<N>-<feature>`) → PR to `main` → manager merges. Small PRs, one feature each. Pull `main` often.

**Forensic-grade rules (added 2026-11-14):**

12. **Hash at the source:** recording segments and imported files get a SHA-256 when written or uploaded, stored with the segment. Evidence export re-checks those hashes, so integrity is provable from recording onward, not only from export.
13. **Time integrity:** record each camera's / NVR's clock offset and NTP status with its footage. Evidence reports state the offset for every clip.
14. **Tamper-evident audit:** investigation and evidence audit entries are hash-chained (each entry stores the hash of the previous one). A verify routine detects a missing or edited entry.
15. **Lead, not identification:** every AI match shows its confidence and is labelled as an investigative lead. Confirm / reject records **who** confirmed and when, and reports show it.
16. **Reproducibility:** every derived result (track, attribute, match, summary) stores the model name + version and key settings that produced it. Evidence packs include them.
17. **Legal certificate:** evidence packs include a pre-filled certificate for electronic records under **Section 63, Bharatiya Sakshya Adhiniyam 2023** (replaces Evidence Act §65B), to be reviewed and signed by the responsible officer. Template to be checked once by a lawyer.
18. **Redaction and access:** exports can blur faces of bystanders (I-5b). An optional per-tenant setting requires a second person to approve each export. Published accuracy and known-limits sheet from the §9 eval set (night, rain, crowds).

## 7. Definition of done per feature

| # | Done when |
|---|---|
| I-1 | Phase 0 numbers recorded in `PHASE0_MEASUREMENT.md`; lab cameras write tracks (crop, embedding, colour, model version) under the tenant filter; retention deletes them with video; a short report gives measured tracks / camera / day, GPU overhead and storage per camera per day; backfill indexes 1 h of recorded segments in < 15 min on one GPU |
| I-2 | Eval targets in §2 met; works air-gapped with the rule-based parser; every search audited; filters shareable via URL; existing photo search available as an input on the same page |
| I-3 | Clicking a person in lab playback returns their journey across ≥ 3 cameras with the stitched video, no photo; confirm / reject refines results; works on a camera without live AI (on-demand detect + ReID on the frame) |
| I-4 | Case audit is hash-chained and verifies; create a case from an alert, add sightings / journey / notes / files, invite a member, one merged timeline; case footage survives a retention run |
| I-5 | Case exports to a ZIP whose manifest verifies on the verify page; one changed byte fails verification; every export logged with a reason; pack includes source-segment hashes, clock offsets, model versions, who confirmed each match, and the BSA §63 certificate draft |
| I-6 | Density bar on lab playback (cloud and NVR); skim jumps empty stretches correctly on cloud recordings |
| I-7 | 1 h phone video and 1 h Hikvision export upload (resumable), index and become searchable in < 30 min on one GPU; the original's SHA-256 is stored at upload |
| I-8 | ≥ 80 % correct and cited on 100 questions; zero uncited claims; reduced mode works air-gapped |
| I-9 | Morning digest generated for a lab site; every sentence links to the events behind it |
| I-10 | A lab vehicle followed across ≥ 3 cameras where only one camera reads the plate |

## 8. First tasks (start here)

1. **Measure before building:** tracks per camera per day (person + vehicle) on the lab cameras and, if possible, on the large production site; GPU headroom on the AI host.
2. **Read** `journey/search.py`, `journey/body.py`, `api/routes/journey.py`, `services/track_attributes.py`, `pipeline/orchestrator.py` and `docs/JOURNEY_CENTRALIZATION.md` to find the "track ended" hook.
3. **Spike:** run `extract_clothing()` + an OpenCLIP / SigLIP embedding on 500 lab person crops; check text-to-image retrieval quality by hand.
4. **Propose** the Alembic migration and `vms_tracks` collection in a small PR before the summariser itself.

## 9. Evaluation set

Build it from lab cameras and consenting pilot sites, and keep it growing: **≥ 200 search queries** with ground-truth tracks (day and night, crowded and empty, person and vehicle), **≥ 50 cross-camera journeys**, **≥ 100 Ask questions**. Store it under `ai/face-service/vms_face/eval/` next to the existing eval code. Publish the numbers we actually reach, including night.

## 10. Open questions

| Question | Status |
|---|---|
| Can the journey search be seeded by a vector instead of a photo? | **Mostly yes:** `query_appearance()` takes any embedding; only the `/journey/search` route is photo-only. Needs a new entry point, and the body-vector path must be checked in `fusion.py`. |
| Is `systoolspc-dev/Drishyamm` `main` the manager's merge target, or is production elsewhere? | Ask the manager |
| Which image-embedding weights can we ship commercially and on-prem? | Open |
| Labelling budget for 10–20 k attribute crops (in-house or vendor)? | Open |
| Local LLM and hardware for air-gapped installs? | Open (ties to the edge-box spec gap) |
| Case storage quota per plan? | Open |
| Pricing: per-camera add-on vs tier? | Open |

## 11. Related documents

**Product and competitor context** (repo `RG1208/Drishyam`, folder `competitor-analysis/`)

| Document | Why read it |
|---|---|
| `INVESTIGATION-TOOLKIT.md` | Full plan: thesis, every feature spec, impact, pricing ideas, roadmap, risks |
| `COMPARISON.md` | Drishyam vs all competitors; the combined P0 / P1 / P2 list (I-items map to P0-1, P0-5, P1-1, P1-2, P1-3, P2-3) |
| `FEATURES-TO-BUILD.md` | Detailed specs for every P0 / P1 / P2 item |
| `drishyam/capabilities.md`, `drishyam/strengths-and-gaps.md` | What Drishyam has today and its known gaps |
| `cerebralzip-cerebvision/features.md` | The investigation-first competitor (cases, file upload, colour search, AI reports) |
| `IntpixelLabs-vogic-ai/features.md`, `karma-ai-project-sanjay/features.md`, `calyirex-kautilya/features.md` | Natural-language search, trace and track, associations, case workflow |

**System docs in this repo** (`docs/`)

| Document | Why read it |
|---|---|
| `docs/JOURNEY_CENTRALIZATION.md` | How journey / forensics was merged into smart-cam-ai; face + body fusion; the infra map |
| `docs/FACE_SYSTEM_DESIGN.md`, `docs/FACE_ACCURACY_BENCHMARK.md` | Face pipeline and its measured limits |
| `docs/DETECTION_DECISION_ALERT_FRAMEWORK.md`, `docs/DETECTION_LOGGING_ALERTING_POLICY.md` | How detections become events and alerts; logging policy the index must respect |
| `docs/AI_ACCURACY_AND_TUNING.md`, `docs/CAMERA_PLACEMENT_DETECTION_SPECS.md` | Accuracy limits by lens and placement (affects attribute quality) |
| `docs/SYSTEM_DESIGN.md`, `docs/04-architecture.md`, `docs/TECH-ARCHITECTURE.md`, `docs/HOW_IT_WORKS.md` | Overall architecture |
| `docs/05-codebase-guide.md`, `docs/06-api-reference.md`, `docs/07-env-variables.md` | Where code lives, existing APIs, env vars |
| `docs/12-streaming-recording-architecture.md`, `docs/STREAMING_PIPELINE.md` | Recordings, playback, segments (backfill and clip sources) |
| `docs/AI_LICENCE_ENFORCEMENT_PLAN.md` | How AI features are licensed per camera (the add-on must fit this) |
| `docs/SECURITY.md`, `docs/STREAM_SECURITY.md` | Security rules for new endpoints and signed URLs |
| `docs/SETUP.md` | Running the full stack locally (WSL2 + Docker Engine) |
| `ai/face-service/docs/ARCHITECTURE.md`, `FEATURES.md`, `ONBOARDING.md` | AI service internals |
| `ai/face-service/vms_face/SERVICES.md`, `DETECTION_STRATEGY.md` | Service map and detection strategy inside `vms_face` |
