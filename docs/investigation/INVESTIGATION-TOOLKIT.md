# Investigation toolkit: what to build, how, and what it changes

This is the product and engineering plan for Drishyam's **investigation tools**: the features that let a customer answer *"what happened, who did it, where did they go"* in minutes instead of days.

It builds on the competitor work in [COMPARISON.md](COMPARISON.md) and [FEATURES-TO-BUILD.md](FEATURES-TO-BUILD.md). Item IDs here (**I-1 … I-10**) map to the IDs used there (P0-1, P1-2…) where they overlap.

**Labels used in this file**
- **[fact]**: checked in our code, docs or the competitor reports.
- **[proposal]**: a starting design for engineering to challenge, not a decision.
- **[estimate]**: a number we have not measured. Every estimate names how we would measure it.
- **Effort:** S = up to ~2 engineer-weeks · M = ~2–6 weeks · L = 6+ weeks.

---

## Contents

1. [Summary](#1-summary)
2. [Is the investigation gap real?](#2-is-the-investigation-gap-real)
3. [What we already have](#3-what-we-already-have)
4. [Who investigates, and how they lose time](#4-who-investigates-and-how-they-lose-time)
5. [The toolkit at a glance](#5-the-toolkit-at-a-glance)
6. [Architecture: one index under every tool](#6-architecture-one-index-under-every-tool)
7. [Feature specs (I-1 … I-10)](#7-feature-specs)
8. [Impact](#8-impact)
9. [Roadmap](#9-roadmap)
10. [How we measure success](#10-how-we-measure-success)
11. [Risks and mitigations](#11-risks-and-mitigations)
12. [What we are not building](#12-what-we-are-not-building)
13. [Open questions](#13-open-questions)

---

## 1. Summary

**The thesis:** Drishyam is strong at *detecting* things live (12 models, alert quality, a full VMS), but weak at *investigating* afterwards. A customer who buys detection still spends hours scrubbing footage when something happens that no alert caught. Competitors pitch exactly this: "search hours of video in plain language".

**The verdict:** the thesis is **right, with one correction**. We already stitch video for one person (person journey, from a photo). What is missing is:

| Missing | What it means for the customer |
|---|---|
| **Flexible starting points** | They can't search "man in red jacket with a backpack, gate 3, 2–4 pm". They need a photo or a plate. |
| **A workspace** | No case to collect clips, sightings and notes. Every investigation lives in someone's downloads folder. |
| **Evidence-grade output** | Clip export has no hash, no manifest, no export log. Weak in court. |
| **Outside footage** | Can't analyse video we didn't record (phone, a neighbour's NVR, USB). |
| **Fast review** | Playback has no detection tracks, no "play only the busy parts". Reviewers watch dead footage. |

**The plan:** build one **search index** at detection time (I-1), and put every investigation tool on top of it. In order:

1. **I-1 Search index** → **I-2 Attribute + plain-language search** → **I-5 Evidence export** (≈ weeks 0–6)
2. **I-3 Click to track** → **I-4 Cases** → **I-6 Activity timeline + smart skim** (≈ weeks 6–12)
3. **I-7 File import** → **I-8 Ask Drishyam** → **I-9 Summaries** → **I-10 Vehicle journey** (≈ weeks 12–22)

**The pitch it unlocks:** *"Monitor, record **and investigate** in one system."* None of the four competitors is a VMS. They all ask the customer to bring footage from somewhere else. We already have the footage, the cameras and the ReID. The index is the missing layer.

---

## 2. Is the investigation gap real?

### 2.1 Evidence from the competitor reports [fact]

| Competitor | What they sell on investigation | Source |
|---|---|---|
| **VogicAI** | Natural-language search ("person in a blue jacket near gate 3, last Tuesday afternoon"), attribute retrieval, multi-camera timeline reconstruction, evidence clip generation | [features.md](IntpixelLabs-vogic-ai/features.md) |
| **Project Sanjay** | "Talk to CCTV", trace and track from a photo, **associations** (who met whom) | [features.md](karma-ai-project-sanjay/features.md) |
| **CerebVision** | The whole product is investigation: upload footage into a **case** → object + colour search → chat/voice Q&A → AI report | [features.md](cerebralzip-cerebvision/features.md) |
| **Kautilya** | Case workflow (evidence, witnesses, charge sheet), private CCTV registry | [features.md](calyirex-kautilya/features.md) |

The cross-competitor finding in [COMPARISON.md](COMPARISON.md) is blunt: *"All four lead with GenAI… This is now table stakes in government demos, not a differentiator."* Row **B4 (forensic / natural-language / attribute search)** is ✅ for three of four competitors and ⚠️ "photo only" for us.

Our own baseline ([strengths-and-gaps.md](drishyam/strengths-and-gaps.md)) already lists **"Investigation tooling"** and **"No attribute search"** as product gaps.

### 2.2 Why it matters beyond demos [assessment]

- **Detection only covers what you predicted.** Alerts fire for rules someone set up in advance. Most real incidents (a theft, a fight that started off-camera, a missing child, a dispute about who left a door open) were not predicted. The customer's question afterwards is always a search question.
- **Investigation is where the hours go.** A detection alert takes seconds to verify. An investigation without tools means watching hours of footage across several cameras, at 2–4× speed, often by the most expensive person on the team (a police officer, a security manager).
- **It makes the product sticky.** Alerts can be replaced by any AI layer. Cases, evidence and history make Drishyam the place where incidents are *closed*, which is much harder to rip out.
- **It's the entry ticket for police and smart city.** Every competitor targets police. In those tenders the demo is almost always "find this person / vehicle in yesterday's footage".

### 2.3 Where the thesis needs care

- **Not every customer will pay for it.** Police, safe city, campuses, hospitals, large retail, warehouses and logistics yards investigate weekly. A small shop with 4 cameras mostly wants alerts. Price it as an add-on, not in the base plan (§8.3).
- **Detection quality still matters.** Search is only as good as the detections and attributes underneath. Our "measured honesty" strength (published accuracy, ranges by lens) must carry over: publish search recall, including at night.

---

## 3. What we already have

| Capability | State | Where |
|---|---|---|
| **Person journey**: face + body ReID across cameras; stitched video, map, timeline, report | ✅ shipped | [capabilities.md](drishyam/capabilities.md); `journey_map`, `person_tracker` features in `media-pipeline/backend/src/utils/featureCatalog.js` |
| **Search by photo** (recorded and live) | ✅ | `person_search` feature ("Find a person") |
| **Plate history / vehicle search** | ✅ (ANPR, needs 12 mm lens) | ANPR feature |
| **Detection events** with `trackId`, `bbox`, `confidence`, `payload`, snapshot in S3 | ✅ | `media-pipeline/backend/src/models/AIEvent.js` |
| **AI service** (smart-cam-ai, FastAPI) with **Postgres + Qdrant** vector store | ✅ | `media-pipeline/docs/reference/STREAMING_PIPELINE.md` |
| **Recordings**: continuous / event, 10-min MP4 segments, local → S3 / MinIO | ✅ | `media-pipeline/docs/recordings/` |
| **NVR playback + clip export** (MP4, H.264 re-encode or original) | ✅, but not evidence-grade | `media-pipeline/backend/src/controllers/playback.controller.js` |
| **Job queue** (BullMQ on Redis) | ✅ | `media-pipeline/backend/src/queues/` |
| Attribute / object / text search | ❌ | — |
| Cases | ❌ | — |
| Evidence hash, manifest, export log | ❌ | — |
| File import | ❌ | — |
| Detection tracks on the playback timeline | ❌ (AI events are timeline markers only) | `docs/recordings/08-DATA-MODEL.md` §3.7 |

**The important point:** we have the hard parts already (cameras, recordings, detection, tracking, ReID, a vector database). The investigation toolkit is mostly **indexing what we already compute, and building workflow on top of it.**

---

## 4. Who investigates, and how they lose time

### 4.1 Buyers and their questions

| Buyer | Typical question | How often |
|---|---|---|
| **Police / safe city** | "Where did the suspect in this phone video go?" "Find the white Bolero that left the scene after 10 pm." | Daily |
| **Campus / hospital security** | "A laptop went missing from Lab 2 between 1 and 3 pm. Who went in?" | Weekly |
| **Retail / malls** | "Customer says they slipped near aisle 4. Show me." "Who was at the cash counter when the shortfall happened?" | Weekly |
| **Warehouses / logistics** | "Which truck took pallet 17?" "Who left the dock door open overnight?" | Weekly |
| **Residential societies** | "Which delivery person scratched the car?" "When did this person enter and leave?" | Weekly |
| **Factories (EHS)** | "Reconstruct the 30 minutes before the accident for the inspector." | Monthly, high stakes |

### 4.2 The investigation workflow today (without tools)

```
 1. Hear about incident     →  vague description, rough time ("afternoon"), rough place
 2. Pick cameras            →  guess which 3–10 cameras might have seen it
 3. Scrub footage           →  watch hours at 2–4×, per camera, one at a time      ◄── most of the time goes here
 4. Find the subject        →  screenshot, note the time
 5. Follow across cameras   →  repeat step 3 for neighbouring cameras with a new time window
 6. Export clips            →  one by one, rename by hand
 7. Write it up             →  Word document with screenshots; no hash; no chain of custody
```

**[estimate]** Steps 3 and 5 take most of the effort. A 4-hour window across 6 cameras is 24 hours of footage; at 4× that is still 6 hours of watching. We should measure this with 3–5 pilot customers before and after (§10).

### 4.3 The same investigation with the toolkit

```
 1. Type what you know            "man, red top, backpack, gate 3 or lobby, 1–4 pm"           I-2
 2. Get ranked sightings          thumbnails across all cameras, grouped by person             I-1 / I-2
 3. Click the right one           → journey across every camera, stitched video, map         I-3 (existing journey)
 4. Skim around key moments       detection tracks on the timeline; play only the busy parts  I-6
 5. Pin to a case                 sightings, clips, notes, imported phone video               I-4 / I-7
 6. Export evidence               PDF + clips + SHA-256 manifest + export log                 I-5
 7. (later) Ask follow-ups        "did he meet anyone?" "when did he arrive first?"          I-8
```

**Target [estimate]:** first relevant sighting in **under 2 minutes**; a complete multi-camera reconstruction with an evidence pack in **under 15 minutes**.

---

## 5. The toolkit at a glance

| # | Feature | What the customer gets | Maps to | Effort | Depends on | Phase |
|---|---|---|---|---|---|---|
| **I-1** | **Search index** (track summaries + embeddings + attributes) | Nothing visible on its own; powers everything below | P0-1 (core) | M | — | 1 |
| **I-2** | **Attribute + plain-language search** | Filter by person / vehicle / object, colours, bag, helmet; or type a sentence in English or Hindi | P0-1, part of P1-1 | M | I-1 | 1 |
| **I-3** | **Click to track** | Click anyone in playback or a search result → their journey across cameras. No photo needed. | extends person journey | S–M | I-1 | 2 |
| **I-4** | **Investigation cases** | One workspace per incident: sightings, clips, notes, files, members, a merged timeline; footage kept past retention | P1-2 (part) | M | — | 2 |
| **I-5** | **Evidence-grade export** | PDF report + clips + SHA-256 manifest + export log + a verify page | P0-5 | S | — (better with I-4) | 1 |
| **I-6** | **Activity timeline + smart skim** | Detection tracks on the playback bar; "play only activity"; jump to next person / vehicle | CerebVision key frames | S–M | I-1 | 2 |
| **I-7** | **Recorded-file import** | Upload NVR exports, phone or USB video into a case; it becomes searchable like our own cameras | P1-2 | M | I-1, I-4 | 3 |
| **I-8** | **Ask Drishyam** (chat + voice, Hindi + English) | Ask questions in plain language; answers cite clips and sightings | P1-1 | L | I-1, I-2, I-4 | 3 |
| **I-9** | **AI summaries** | "What happened at gate 3 last night?"; daily digest; key-frame strip per incident | P1-3 | M | I-1, I-8 | 3 |
| **I-10** | **Vehicle journey** | Plate + type + colour + vehicle ReID → route across cameras | extends plate history | M | I-1 | 3 |
| *later* | Associations, video synopsis, audio transcription | "Who did he meet", "8 hours in 3 minutes", speech search | P2-3, P2-6 | M–L each | I-1, I-3 | 4 |

---

## 6. Architecture: one index under every tool

### 6.1 The big design decision: index at detection time [proposal]

Every tool above needs to answer *"which objects, with what look, were where and when?"*. We should compute that answer **once, while the AI is already looking at the frames**, and store it. Not compute it again from video when someone searches.

Why this matters for Drishyam specifically:

1. **NVR footage is expensive to re-read.** NVR playback replays in real time [fact: `playback.controller.js`, `MAX_EXPORT_MS`: "the NVR replays in real time"]. Searching 4 hours of NVR footage after the fact would take 4 hours and hold NVR sessions, against our own rule to respect NVR session limits ([media-pipeline/CLAUDE.md](../media-pipeline/CLAUDE.md), rules 2–3).
2. **The GPU already did the work.** Detection, tracking and ReID already run on AI-enabled cameras. The extra cost is one crop, one embedding and a few attribute heads **per track**, not per frame.
3. **Search becomes a database query.** Milliseconds to seconds instead of minutes to hours.

The consequence: **the index only covers cameras where AI runs.** For the rest we offer a backfill job over **cloud recordings** (S3 segments can be read faster than real time), and an explicit, capped "analyse this window" action for NVR-only footage (§7, I-1 *Coverage*).

### 6.2 Data flow

```
                        smart-cam-ai (FastAPI, GPU)  — already running
 camera ─RTSP─►  detect ─► track ─► ReID (body) / face  ─────────────►  existing: ai_events, journey, face match
                                │
                                │  NEW: when a track ends (or every 30 s for long tracks)
                                ▼
                     ┌───────────────────────────┐
                     │  Track summariser          │
                     │  • pick best crop          │   sharpest, largest, most frontal frame
                     │  • image embedding (CLIP)  │   open vocabulary: "yellow umbrella"
                     │  • attribute heads         │   reliable filters: top / bottom colour, bag, helmet…
                     │  • vehicle type + colour   │
                     │  • track path (1 pt / s)   │   bbox samples for timeline + click-to-track
                     └─────────────┬─────────────┘
                                   │
          ┌────────────────────────┼─────────────────────────┐
          ▼                        ▼                         ▼
   Qdrant: track_embeddings   Postgres: tracks,         S3: best-crop JPEG
   (vector + filter payload)  track_points, buckets     (thumbnail for results)
          │                        │
          └──────────┬─────────────┘
                     ▼
         Search API (smart-cam-ai /search/*)  ◄── Express backend /api/investigate/* (auth, tenancy, audit)
                     ▲                                         ▲
                     │                                         │
          Query parser (LLM → JSON filters)            React: Search, Case, Playback timeline
```

### 6.3 Storage model [proposal]

**One record per track, not per frame.** A person walking through a camera's view for 20 seconds is one track = one search result. This cuts storage by 100–1000× compared to per-frame indexing and makes results readable.

**Postgres (in smart-cam-ai's existing database)**

```sql
-- One row per tracked object per camera (person, vehicle, bag…)
CREATE TABLE tracks (
  id              UUID PRIMARY KEY,
  tenant_id       UUID        NOT NULL,          -- users.id of the owning organisation
  camera_id       UUID        NOT NULL,
  source          TEXT        NOT NULL DEFAULT 'live',   -- 'live' | 'backfill' | 'file'
  case_id         UUID,                           -- set for imported files (I-7)
  tracker_id      TEXT        NOT NULL,           -- same opaque id as ai_events.track_id
  object_class    TEXT        NOT NULL,           -- 'person' | 'car' | 'motorcycle' | 'truck' | 'bag' …
  first_seen      TIMESTAMPTZ NOT NULL,
  last_seen       TIMESTAMPTZ NOT NULL,
  best_crop_key   TEXT,                           -- S3 key of the thumbnail
  best_crop_ts    TIMESTAMPTZ,
  attributes      JSONB       NOT NULL DEFAULT '{}',  -- {"top_color":["red",0.91], "bag":["backpack",0.8], …}
  zones           TEXT[]      NOT NULL DEFAULT '{}',  -- zone ids the track entered
  reid_vector_id  TEXT,                           -- link to the existing ReID embedding, if any
  face_vector_id  TEXT,
  plate           TEXT,                           -- for vehicles with an ANPR read
  quality         REAL                            -- crop quality score, used in ranking
);
CREATE INDEX ON tracks (tenant_id, camera_id, first_seen);
CREATE INDEX ON tracks (tenant_id, object_class, first_seen);
CREATE INDEX ON tracks USING GIN (attributes jsonb_path_ops);

-- Sampled positions, 1 per second: powers click-to-track and timeline tracks
CREATE TABLE track_points (
  track_id  UUID        NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  ts        TIMESTAMPTZ NOT NULL,
  bbox      SMALLINT[4] NOT NULL,                 -- x1,y1,x2,y2 on a normalised 0–1000 grid
  PRIMARY KEY (track_id, ts)
);

-- Per-minute activity counts: powers the timeline density bar and summaries
CREATE TABLE activity_buckets (
  tenant_id    UUID        NOT NULL,
  camera_id    UUID        NOT NULL,
  minute       TIMESTAMPTZ NOT NULL,
  object_class TEXT        NOT NULL,
  count        INT         NOT NULL,
  PRIMARY KEY (camera_id, minute, object_class)
);
```

Partition `tracks` and `track_points` by day (native Postgres partitioning) so retention is `DROP PARTITION`, matching the video retention of the camera.

**Qdrant collection `track_embeddings`**

| Field | Value |
|---|---|
| vector | image embedding of the best crop (e.g. 768-d SigLIP / OpenCLIP), int8 scalar-quantised |
| payload | `tenant_id`, `camera_id`, `site_id`, `object_class`, `first_seen` (epoch), `attr_*` keywords, `source`, `case_id` |
| payload indexes | `tenant_id` (keyword, **mandatory filter on every query**), `camera_id`, `object_class`, `first_seen` (range) |

**Size [estimate, measure in the lab]:** if a busy camera produces ~2,000 person/vehicle tracks a day, 1,000 cameras × 2,000 × 30 days = 60 M vectors. At ~1 KB each (int8 vector + payload) that's ~60 GB in Qdrant, which fits on one well-provisioned node or a small cluster. Postgres rows are smaller. **First task in I-1: measure real tracks/camera/day on the lab and the 2,600-camera site.**

### 6.4 Models [proposal]

Two complementary signals. Using both gives reliable filters *and* open-vocabulary search.

| Signal | What it answers | Candidate models | Notes |
|---|---|---|---|
| **Image embedding** (open vocabulary) | "yellow umbrella", "person in a saree", "pushing a trolley", "white tempo" | SigLIP / OpenCLIP (ViT-B), ONNX / TensorRT on the existing GPU | One forward pass per track best-crop, batched. **Check licence for commercial use** (OpenCLIP weights vary by training set). |
| **Person attribute heads** (structured) | top colour, bottom colour, top type (shirt / jacket / saree / kurta), bag type, helmet, cap, mask, gender-presentation (**optional, off by default**), age band (**off by default**) | A pedestrian-attribute model fine-tuned on our own labelled crops | Public datasets (PA-100K, PETA, RAP) are mostly **research-only licences**. Plan to label 10–20 k of our own crops. Indian clothing (saree, kurta, dupatta) needs our own labels anyway. |
| **Colour from pixels** (baseline) | top / bottom dominant colour | HSV histogram on the upper / lower crop halves, mapped to 11 colour names | Ships in week 1 as a fallback while the attribute model is trained. Weak at night / IR: mark as "colour unreliable" when the frame is IR. |
| **Vehicle heads** | type (car, SUV, bike, scooter, auto, tempo, truck, bus, tractor), colour | A small classifier on the vehicle crop | India-specific classes matter (auto-rickshaw, tempo, e-rickshaw). |
| **Existing ReID / face** | "same person as this one" | Already in smart-cam-ai | Re-used as-is by I-3. |

**Night / IR rule:** when the camera is in IR mode (greyscale frame), store `attributes.ir = true` and don't emit colour attributes. Search results then say "colour not available (night)" instead of silently missing. This is our "measured honesty" strength.

### 6.5 Multi-tenancy, privacy and audit [proposal]

- **Tenancy:** every Qdrant and Postgres query is filtered by `tenant_id` server-side. The backend passes the tenant from the JWT; the browser never sends it. Add a test that fails if any search path runs without the filter.
- **Permissions:** a new role permission `investigate` (search, journey, cases) and `evidence_export`. Face search and click-to-track on faces stay behind the existing face permissions.
- **Audit:** every search, journey, case view and export writes to `admin_audit_log` (or a new `investigation_audit` table): who, when, query text, filters, result count, items opened, items exported. The reference doc already calls for this for face matches [fact: `STREAMING_PIPELINE.md`].
- **Retention:** the index lives exactly as long as the video it points at, except for items pinned to a case (I-4 legal hold).
- **Sensitive attributes:** gender and age estimates are **off by default** and per-tenant opt-in, with a note in the Responsible AI page (P0-3). India's DPDP Act 2023 treats this data seriously, and government buyers will ask.

---

## 7. Feature specs

Each spec has: **What**, **Why**, **How to build**, **Impact**, **Done when**, **Risks**.

---

### I-1 · Search index

**What.** For every track on an AI-enabled camera, store a summary: best crop, image embedding, attributes, zones, 1-per-second positions and per-minute activity counts (§6.3). No UI on its own.

**Why.** Every other tool needs it. Building it once, at detection time, is the difference between a 200 ms search and a 4-hour NVR replay.

**How to build [proposal]**

1. **Track summariser in smart-cam-ai.** Hook into the tracker's "track ended" event (and a 30-second heartbeat for tracks that last long, e.g. a parked car).
   - Keep the top-3 crops by quality score (box area × sharpness × detector confidence × frontalness) while the track is alive. Store the best one.
   - Batch crops across cameras every ~500 ms → one GPU call for embeddings, one for attribute heads.
   - Write `tracks`, `track_points`, `activity_buckets` to Postgres; vector to Qdrant; crop JPEG to S3 (`<tenant>/tracks/<date>/<track_id>.jpg`, ~10–20 KB).
2. **Skip junk.** Drop tracks shorter than ~1 s or with tiny boxes (configurable), so the index isn't flooded by flicker.
3. **Link to what exists.** Store `tracker_id` (same as `ai_events.track_id`), and the ReID / face vector ids, so alerts, journeys and search results all point at the same track.
4. **Per-camera switch.** Reuse the existing AI config pattern: `ai.searchIndex` next to `ai.journeyMapping` in `ai.controller.js` (on by default for cameras with person or vehicle detection).
5. **Coverage for cameras without live AI.**
   - **Cloud backfill:** a BullMQ job reads S3 recording segments for a chosen camera and time range, decodes at 2–5 fps, runs the same pipeline with `source='backfill'`. Runs on spare GPU at low priority. Faster than real time because it reads files, not the NVR.
   - **NVR window (explicit, capped):** "Analyse this hour" from the playback page. Uses one NVR session, respects `maxSessionsPerNvr`, stops on the first error, runs in real time, shows progress. Never automatic. This keeps us inside the NVR-safety rules.
6. **Capacity.** Measure the extra GPU load on the lab. Today's sizing is ~80–100 cameras per GPU at 10 fps detection [fact: `STREAMING_PIPELINE.md`]. The summariser should add well under 10% because it runs per track, not per frame **[estimate, measure]**.

**Impact.** Unlocks I-2 to I-10. Also gives us real per-camera activity data (useful for heatmaps and footfall later).

**Done when.**
- Lab cameras write tracks with crops, embeddings and colour attributes, under the tenant filter.
- Retention deletes index data with the video.
- Measured: tracks/camera/day, GPU overhead, storage per camera per day, in a short report.
- A backfill job indexes 1 hour of S3 recording in under 15 minutes on one GPU **[target]**.

**Risks.** GPU overhead higher than expected → lower embedding resolution or index only person + vehicle classes first. Storage growth → int8 quantisation, drop `track_points` older than 7 days but keep `tracks`.

---

### I-2 · Attribute + plain-language search

**What.** A **Search** page (and a search box on Playback) where the user either:
- picks **filters**: object (person / vehicle / bag…), colours (top, bottom, vehicle), accessories (backpack, helmet, cap), cameras / sites / zones, time range; or
- **types a sentence**, in English or Hindi / Hinglish: *"laal shirt wala aadmi with backpack, gate 3, kal 2 se 4 baje"*.

Results: thumbnails ranked by match, **grouped by person** (same person across cameras collapsed into one card using ReID), each with camera, time, a 10-second preview and actions: *Play*, *Track this person* (I-3), *Add to case* (I-4).

**Why.** This is the starting point most investigations need ("I know roughly what they looked like"), and three competitors have it. It's also the headline demo.

**How to build [proposal]**

1. **Query parser.** Text → structured query:
   ```json
   {
     "object_class": "person",
     "attributes": { "top_color": ["red"], "bag": ["backpack"] },
     "cameras": ["<gate-3 camera id>"],
     "time": { "from": "2026-11-08T14:00:00+05:30", "to": "2026-11-08T16:00:00+05:30" },
     "free_text": "man with red shirt and backpack"
   }
   ```
   - **Cloud tenants:** an LLM with structured output (e.g. Claude Haiku) gets the tenant's camera / zone names and the current time as context, and returns this JSON. Cheap, handles Hinglish and relative dates ("kal", "last Tuesday afternoon").
   - **On-prem / air-gapped tenants:** a small local LLM (served with vLLM or llama.cpp on the AI box) with the same prompt, plus a **rule-based fallback** (colour words, object words, camera-name fuzzy match, date patterns in English and Hindi) so search works with no LLM at all.
   - Always **show the parsed filters as editable chips** under the search box. The user sees what we understood and can fix it. This also makes mistakes visible instead of silent.
2. **Retrieval.**
   - Hard filters (tenant, time, cameras, class) go to Qdrant as payload filters.
   - `free_text` → text embedding (same CLIP model) → vector search, top ~500.
   - Re-rank: `score = w1·vector_similarity + w2·attribute_match + w3·crop_quality`. Attribute matches use the structured heads where we have them; the embedding covers everything else.
   - **Group** results whose ReID vectors are close (same person seen on several cameras) into one card with "seen on 4 cameras".
3. **API.** `POST /api/investigate/search` in the Express backend (auth, tenant, audit, rate limit) → `POST /search/tracks` in smart-cam-ai. Return paged results with signed thumbnail URLs.
4. **UI.** A results grid with time on the side; clicking opens the existing playback at `best_crop_ts − 5 s` on that camera. Filters persist in the URL so a search can be shared with a colleague or saved into a case.
5. **Image search becomes one of the inputs.** The existing "search by photo" moves into the same page as a third input (upload a photo → ReID / face vector → same results grid).

**Impact.**
- Closes competitor row **B4** from ⚠️ to ✅.
- **[estimate]** Turns "scrub 6 hours" into "scan 50 thumbnails" for any incident where someone can describe the subject.
- Strongest single sales demo for police, campus and retail.

**Done when.**
- On a labelled lab set of **≥ 200 queries** (§10.2): **recall@20 ≥ 80 %** for daytime person top-colour + bag queries, **≥ 70 %** for vehicle type + colour. Night reported separately, not hidden.
- p95 search latency **< 2 s** for a 30-day range on a 100-camera tenant.
- Works on an air-gapped install with the rule-based parser.
- Every search is in the audit log.

**Risks.** Colour naming is subjective ("maroon" vs "red") → map to 11 basic colours plus nearest neighbours, and accept multi-colour matches. LLM parse errors → editable chips plus the rule-based fallback. Bias concerns with gender / age → off by default (§6.5).

---

### I-3 · Click to track

**What.** In **any** playback or search result, the user clicks a person (or vehicle) on the video → Drishyam finds that track and runs the existing **person journey** from it: every camera they appeared on, a stitched video, a map and a timeline.

Today, journey starts from a photo or a known face. Click to track lets it start from *anyone visible on screen*, including people with no usable face.

**Why.** It turns our existing ReID and stitched video, which competitors can't match because they don't own the cameras, into the centre of the investigation flow. Small build, very strong demo moment.

**How to build [proposal]**

1. **Find the track under the click.** `GET /api/investigate/track-at?camera=&ts=&x=&y=` → query `track_points` for that camera within ±1 s of `ts` where the bbox contains (x, y). Return the track id (or the nearest few if they overlap).
2. **No track stored?** (camera has no live AI, or the frame is from an import). Grab the frame (the existing snapshot path), run detection + ReID on that one frame on demand, and use that embedding. A few hundred ms on GPU.
3. **Seed the journey.** Extend smart-cam-ai's journey search so it accepts a **track id or a ReID vector** as the seed, not only a face / photo. *(Check the current journey API: it may already accept a vector internally.)*
4. **Bidirectional.** Search both forward and backward in time from the clicked moment: *where did they come from*, *where did they go*.
5. **Human in the loop.** Show candidate sightings with a confidence score; the investigator confirms or rejects each one. Confirmed sightings refine the query (average the confirmed ReID vectors and search again). This is also our answer to "AI made a wrong match" (same idea as P0-9, the review queue).
6. **Multi-camera synced view.** From the journey, open a 2×2 / 3×3 grid of the cameras involved, all on one shared clock (the Monitor Wall player in playback mode), so the investigator can watch the hand-off between cameras.

**Impact.**
- **[estimate]** Following a person across cameras goes from "repeat the scrub per camera" to one click plus confirmations.
- Unique among the four competitors: they need you to upload each camera's video first.

**Done when.**
- Clicking a person in lab playback returns their journey across ≥ 3 lab cameras with the stitched video, without any photo.
- Confirm / reject updates the results.
- Works on a camera without live AI via the on-demand path.

**Risks.** Body ReID across very different cameras (angle, lighting) is weaker than face → show confidence, require confirmation, and use the camera topology (which cameras are adjacent, typical walking time) to re-rank. Crowded scenes → return several candidates under the click.

---

### I-4 · Investigation cases

**What.** A **Case** is one incident's workspace:
- title, case number, status (open / under review / closed), priority, tags;
- **members** (who can see and edit it), with roles;
- **items**: sightings (tracks), clips (camera + time range), snapshots, saved searches, journeys, uploaded files (I-7), notes;
- a **merged timeline** of every item across cameras;
- a **legal hold**: footage referenced by the case is kept past normal retention until the case is closed and released;
- an **activity log** of every change.

**Why.** Investigations take days and involve several people. Without cases, the work lives in screenshots and WhatsApp. With cases, Drishyam becomes the system of record. That's what CerebVision and Kautilya build their products around, and it makes us much harder to replace.

**How to build [proposal]**

1. **Tables (MySQL, Express backend, Sequelize like the rest):**
   ```
   cases          (id, tenant_id, number, title, status, priority, tags JSON, created_by, closed_at, …)
   case_members   (case_id, user_id, role ENUM('owner','editor','viewer'))
   case_items     (id, case_id, type ENUM('track','clip','snapshot','search','journey','file','note'),
                   camera_id, ts_from, ts_to, ref JSON, note TEXT, added_by, added_at)
   case_audit     (id, case_id, user_id, action, detail JSON, at)
   ```
2. **Legal hold.** When a clip or track is added, copy the footage for that range into a case bucket (`<tenant>/cases/<case_id>/…`) with a BullMQ job:
   - from S3 / local recordings: a server-side copy of the relevant segments;
   - from NVR-only footage: the existing export path (real time, capped, one session). This matters because NVRs overwrite footage after days or weeks.
   - mark the item `preserved` with its SHA-256 (feeds I-5).
3. **Entry points everywhere.** An *Add to case* button on search results, journey, playback, alerts and incident history. Converting an alert into a case pulls its snapshot and a ±2-minute clip automatically.
4. **Case timeline UI.** A horizontal timeline with one lane per camera, item markers, and a player that jumps between items.
5. **Assignment and notifications.** Reuse the existing notification integrations (36+) to notify members when they're added or when status changes.

**Impact.**
- Stickiness: closed cases are history the customer won't want to lose.
- Evidence safety: footage is kept before the NVR overwrites it, which is a real pain point for police.
- Prepares the ground for I-7 (file import) and I-8 (Ask over a case).

**Done when.** A user can create a case from an alert, add sightings from search and a journey, add notes, invite a colleague, and see everything on one timeline; footage in the case survives a retention run.

**Risks.** Storage cost of preserved footage → count case storage against a per-plan quota and show it. Scope creep into a full police case-management system (charge sheets, witnesses) → **don't**; partner for that (Kautilya, CCTNS; P2-9) and provide an export / API instead.

---

### I-5 · Evidence-grade export

**What.** Export a clip, a journey or a whole case as an **evidence pack**:

```
CASE-2026-0142_evidence.zip
├── report.pdf            cover page, summary, timeline, key frames with camera/time, notes, exporter, hashes
├── clips/
│   ├── gate3_2026-11-08_14-02-10_original.mp4   bit-exact from the recorder where possible
│   └── gate3_2026-11-08_14-02-10_h264.mp4       re-encoded for easy playback
├── snapshots/…
├── manifest.json         every file with SHA-256, size, camera, time range, source (NVR / S3 / file)
└── manifest.sig          signature of manifest.json with the tenant's key
```

Plus a public **verify page** where anyone (a court, the other side's lawyer) can drop a file and check its hash against our export log.

**Why.** "Court-ready evidence" is already in our marketing [fact: capabilities.md], but the export has no hash or log. Police buyers ask for chain of custody. This is cheap to build and closes a credibility gap.

**How to build [proposal]**

1. Reuse `exportNvrClip` / recording reads for the media. Keep **both** the `original` (stream copy, closest to the recorder) and the H.264 version. The existing code already supports `format=original` [fact].
2. Hash every file while it's written (streaming SHA-256, no second pass).
3. Generate the PDF on the server (e.g. a headless-Chromium HTML → PDF template, or a PDF library) with the case / journey data.
4. Sign `manifest.json` with a per-tenant Ed25519 key held by the backend (KMS / file secret on-prem).
5. Write an `evidence_exports` row: who, when, what, hashes, IP, reason (a required free-text field: "requested by SHO Kotwali, FIR 123/26").
6. Big exports run as a BullMQ job; the user gets a notification and a signed download URL.

**Impact.** Makes "court-ready" true. Needed in every police and enterprise-security deal. Also an audit answer for procurement security questionnaires (P0-3 trust pages).

**Done when.** A case exports to a ZIP whose manifest verifies on the verify page; changing one byte in a clip fails verification; every export is in the log with a reason.

**Risks.** "Original" from some NVRs still needs remuxing → document exactly what was done to each file in the manifest (`"processing": "remux, no re-encode"`).

---

### I-6 · Activity timeline + smart skim

**What.**
- On the playback timeline, a **density bar** per object class (people, vehicles) from `activity_buckets`, plus markers for alerts. You can see at a glance where something happened.
- **Smart skim:** "Play only activity". Playback jumps over empty stretches and plays busy stretches at normal speed (or a chosen speed).
- **Jump to next / previous** person or vehicle. Keyboard shortcuts for investigators.
- **Key-frame strip**: one thumbnail per track along the timeline. Hover to preview, click to play.

**Why.** Even with search, investigators still watch footage to understand context. Most CCTV footage is empty. Skipping it is the cheapest time saving in the whole toolkit.

**How to build [proposal]**

1. `GET /api/investigate/activity?camera=&from=&to=&bucket=1m` → buckets from Postgres (cached in Redis for past days).
2. Playback component: render the density bar under the existing timeline; for skim, compute "active ranges" (buckets with count > 0, merged with a few seconds of padding) and seek between them.
   - **Cloud recordings:** seek inside the segment (fast).
   - **NVR playback:** seek by restarting replay at the next active range. Slower, so pre-fetch the next range.
3. Key-frame strip: `tracks.best_crop_key` for the visible window, lazily loaded.

**Impact [estimate]:** in typical retail / campus footage with 10–30 % activity, review time for a window drops 3–10×. Measure on pilot footage.

**Done when.** Density bar renders on lab playback; skim plays a 1-hour lab window with a measured activity ratio and correct skips; works for both cloud and NVR sources.

**Risks.** NVR seek latency makes skim choppy → apply skim only to cloud recordings first, show the density bar for both.

---

### I-7 · Recorded-file import

**What.** Upload video into a case: NVR / DVR exports (`.mp4`, `.avi`, `.dav`, `.h264`…), phone video, body-worn camera, USB dumps. Each file gets a **virtual camera** (name, location, start time) and is indexed exactly like a live camera, so search, click to track, skim and export all work on it.

**Why.** Police and command centres often investigate footage they didn't record: a shop's NVR next to the crime scene, a citizen's phone video. CerebVision's whole product is this. With it, we serve the investigation even where we don't own the cameras, and the result sits next to our own cameras' footage in the same case.

**How to build [proposal]**

1. **Upload:** resumable, chunked upload (tus protocol) straight to S3 / MinIO, so a 10 GB NVR dump survives a bad connection.
2. **Probe and normalise (BullMQ job):** `ffprobe` → if needed, remux or transcode to MP4 (H.264 / H.265). Proprietary formats (Dahua `.dav`, Hikvision exports) need specific demuxers; start with the ones our customers use (Hikvision, Dahua, CP Plus, the brands we already support).
3. **Time:** read the embedded timestamp when there is one; otherwise ask the user for the start time; allow a manual offset fix after seeing the video (NVR clocks are often wrong).
4. **Analyse offline:** run the same smart-cam-ai pipeline in file mode at 2–5 fps, faster than real time, as a low-priority GPU job. Write tracks with `source='file'` and `case_id`.
5. **Search scope:** imported tracks are visible only inside their case (`case_id` filter), unless the user chooses to add them to the tenant's index.
6. **Hash on arrival:** SHA-256 the original upload before any processing; store it in the case (chain of custody starts at upload).

**Impact.** Opens the pure-investigation market (police stations, forensic labs, insurance investigators) where the buyer doesn't own a VMS. Also a land-and-expand route: a police station that imports footage today is a safe-city VMS prospect tomorrow.

**Done when.** A 1-hour phone video and a 1-hour Hikvision export upload, index and become searchable in under 30 minutes on one GPU **[target]**; the original's hash is in the case.

**Risks.** Format variety → publish a supported-formats list and add formats on demand. GPU contention with live AI → separate low-priority queue with a per-tenant cap.

---

### I-8 · Ask Drishyam (chat + voice, Hindi + English)

**What.** A chat panel (global, and inside a case) where the user asks questions in plain language, typed or spoken:
- *"Did anyone enter the server room after 9 pm yesterday?"*
- *"Show me the red-shirt man from this case. When did he first arrive?"*
- *"How many trucks left gate 2 this morning?"*
- *"Did he meet anyone near the parking?"* (needs associations, later)

Answers are short, **cite their evidence** (thumbnails and clips you can click), and offer actions (*add to case*, *export*) that need the user's approval.

**Why.** This is every competitor's headline [fact: COMPARISON.md]. But it only works well **on top of** I-1 to I-4: without the index, an assistant can only read alert logs and will give weak answers in a demo with real questions.

**How to build [proposal]**

1. **An agent with tools, not a model looking at video.** The LLM calls our APIs:
   `search_tracks(filters, text)`, `count_tracks(filters, group_by)`, `get_events(filters)`, `track_journey(track_id)`, `get_activity(camera, range)`, `get_case(case_id)`, `add_to_case(…)` (needs approval).
2. **Grounding rule:** every factual sentence in an answer must point at a tool result (track, event, clip). If tools return nothing, the answer says so. No guessing. This is the "Drishyam surfaces, people decide" line from the Responsible AI page (P0-3).
3. **Models:** Claude for cloud tenants (strong tool use, Hindi); a local model for on-prem / air-gapped installs, with a smaller tool set. Voice: speech-to-text (e.g. Whisper-class, Hindi + English; on-prem capable) → same agent; optional text-to-speech for answers.
4. **Optional visual check:** for a handful of top results, send the crops to a vision-language model to verify fine details the index can't hold ("is he carrying a laptop bag or a backpack?"). Bounded by a per-query cap to control cost.
5. **Context:** the tenant's camera names, sites, zones, timezone and the current case are injected so "gate 3" and "kal raat" resolve correctly.
6. **Audit:** each question, tool call and answer is logged.

**Impact.** Matches the competitors' headline, but backed by a real VMS and index rather than a demo. Makes the toolkit usable by non-technical staff (guards, constables, managers), in Hindi.

**Done when.** On a set of 100 realistic questions over lab data, ≥ 80 % answered correctly with valid citations **[target]**; zero answers with claims not backed by a tool result; works on an air-gapped install in reduced mode.

**Risks.** Hallucination → strict grounding and citations; LLM cost → cache, use small models for parsing and a larger one only for multi-step questions; on-prem quality gap → be explicit about the reduced mode.

---

### I-9 · AI summaries

**What.**
- **Time-range summary:** "Summarise gate 3, 10 pm–6 am" → a short narrative plus key frames ("2 people entered at 23:14 and left at 23:40; one vehicle at 02:05; no activity 03:00–05:30").
- **Daily digest** per site: notable events, unusual activity versus the usual pattern, open cases. Delivered over existing notification integrations.
- **Incident key-frame strip:** for every alert, 4–6 key frames from before to after, so you can see what happened without opening the video.

**Why.** Managers don't watch video; they read summaries. It's also a recurring touchpoint, a reason to open Drishyam every morning.

**How to build [proposal].** Built from `activity_buckets`, `tracks` and `ai_events` (structured data → LLM → text), **not** by sending hours of video to a model. "Unusual" = compare to the same weekday / hour over the last 4 weeks. Key frames = best crops of tracks near the alert time.

**Impact.** Daily engagement; managers see value without watching; upsell from alerts to investigation.

**Done when.** Digest generated for a lab site every morning; every sentence links to the events behind it.

---

### I-10 · Vehicle journey

**What.** Same as person journey, for vehicles: start from a plate, a search result, or a click on a vehicle → route across cameras, with time at each camera, a map and stitched video. Works even when the plate isn't readable on some cameras, by matching type + colour + vehicle ReID.

**Why.** "Find the vehicle" is the most common police request after "find the person". Today we have plate history only where ANPR reads the plate (needs a 12 mm lens [fact]); most cameras can't read plates but can see a white SUV.

**How to build [proposal].** Add a vehicle ReID model (vehicle re-identification is a well-studied task; check commercial licences of pretrained weights). Track summaries for vehicles store the vehicle embedding; the journey search works like I-3, with plate reads as high-confidence anchors.

**Done when.** A lab vehicle is followed across ≥ 3 cameras where only one camera reads the plate.

---

### Later (phase 4)

| Feature | What | Why later |
|---|---|---|
| **Associations** (P2-3) | "Who did this person meet / walk with?": tracks that stay close together for N seconds | Needs I-1 + I-3 first; privacy-sensitive; police-specific |
| **Video synopsis** | Overlay objects from different times into one short video ("8 hours in 3 minutes") | Strong demo but complex video composition; I-6 skim gets most of the value first |
| **Audio transcription** (P2-6) | Search speech in imported files and audio-capable cameras | Most NVR audio is poor; legal questions about recording audio |
| **Watch for this** | Turn a search into a live alert ("tell me if a red-shirt man with a backpack appears again") | Easy once I-2 exists (run the query on new tracks); good bridge between detection and investigation. Could move to phase 2 if sales asks. |

---

## 8. Impact

### 8.1 For the customer

| Task | Today [estimate] | With toolkit [target] | How we'll measure |
|---|---|---|---|
| Find the first sighting from a description | 1–6 h of scrubbing | < 2 min | Timed pilot tasks, before vs after (§10.1) |
| Follow a person across 5 cameras | 1–3 h | < 5 min | Same |
| Review a 1-hour window for context | 15–30 min at 2–4× | 3–10 min with skim | Same |
| Build an evidence pack | 1–2 h (export, rename, Word doc) | < 5 min, hashed | Same |
| Investigate a phone video from outside | Not possible in Drishyam | < 30 min to searchable | Same |

These are estimates until we have pilot numbers. The pilot measurement in §10.1 is part of the plan, not optional: it is what sales will quote.

### 8.2 For sales and positioning

- **Competitive matrix:** row **B4** moves from ⚠️ (photo only) to ✅; "investigation workflow / file import" gaps in [COMPARISON.md](COMPARISON.md) §3 close.
- **New message:** *"Monitor, record and investigate in one system"* (P0-8). Every competitor needs another system for at least one of the three.
- **The demo:** type a description → results across cameras → click → journey with stitched video → export a hashed evidence pack. About 3 minutes end to end, on the customer's own cameras during a pilot (P0-10).
- **New segments:** police stations and investigators without a VMS (via I-7); insurance and legal investigators.

### 8.3 For revenue [proposal]

Today: ₹100 / camera / month VMS + ₹50–200 per AI model [fact: strengths-and-gaps.md].

| Option | Price idea | Notes |
|---|---|---|
| **Investigate add-on** (I-1, I-2, I-3, I-6, I-10) | e.g. ₹50–100 / camera / month | Per indexed camera; consistent with the per-model pricing customers already understand |
| **Cases + evidence** (I-4, I-5) | included in the add-on, with a case-storage quota per plan | Storage above quota billed per GB |
| **File import** (I-7) | per GB or per hour of footage analysed | Standalone for investigators without a VMS |
| **Ask Drishyam + summaries** (I-8, I-9) | per seat or bundled in an "Investigate Pro" tier | Covers LLM cost; on-prem priced into the appliance |

The pricing team should validate these numbers; they're starting points.

### 8.4 For the product

- **Stickiness:** cases and evidence history make Drishyam the system of record.
- **Data:** the index gives activity data per camera for heatmaps, footfall and "unusual activity" (supports P1-4 crowd flow).
- **Bridge to detection:** "Watch for this" turns any search into a live rule, which feeds the SOP rule builder (P0-6).

---

## 9. Roadmap

Assumes **2 backend / AI engineers + 1 frontend engineer**, plus part-time design. Adjust if staffing differs.

```
Weeks:        0    2    4    6    8    10   12   14   16   18   20   22
I-1 index     ████████████                                              (lab measurement in week 1–2)
I-2 search         ██████████████                                        (filters first, text parser week 4+)
I-5 evidence  ██████                                                     (independent; quick credibility win)
I-6 timeline                 ████████                                   
I-3 click-track                   ██████████                            
I-4 cases                    ██████████████                             
I-7 file import                             ██████████████              
I-8 ask                                          ████████████████████    
I-9 summaries                                              ████████     
I-10 vehicle                                          ██████████        
Eval set      ████ (built in parallel, grows each phase)
```

| Phase | Weeks | Ships | Sales can say |
|---|---|---|---|
| **1 · Find** | 0–6 | I-1, I-2 (filters + text), I-5 | "Search your cameras by description. Court-ready, hashed exports." |
| **2 · Follow** | 6–12 | I-3, I-4, I-6 | "Click anyone, follow them across every camera, build the case in one place." |
| **3 · Ask** | 12–22 | I-7, I-8, I-9, I-10 | "Bring any footage. Ask in Hindi or English. Get a summary every morning." |
| **4 · Later** | 22+ | associations, synopsis, audio, watch-for-this | — |

**Milestone gates:** each phase ends with a pilot demo on a real customer site and the eval numbers in §10.2. A phase isn't done if its eval targets aren't met. We publish the numbers we reach, not the ones we wanted.

---

## 10. How we measure success

### 10.1 Pilot time study (the number sales will quote)

With 3–5 pilot customers (mix of police, campus, retail):
1. Pick 5 real past incidents per customer where the answer is known.
2. Time an investigator solving each **without** the toolkit (or use their recorded past effort), then **with** it.
3. Report median time saved per task type (§8.1 table), with the customer's permission to quote.

### 10.2 Offline eval set (the number engineering optimises)

Build and keep growing a labelled set from the lab cameras and consenting pilot sites:
- **≥ 200 search queries** with ground-truth tracks (day and night, crowded and empty, person and vehicle).
- **≥ 50 cross-camera journeys** with ground truth.
- **≥ 100 Ask questions** with expected answers.

| Metric | Target (phase gate) |
|---|---|
| Search recall@20, day, person colour + bag | ≥ 80 % |
| Search recall@20, day, vehicle type + colour | ≥ 70 % |
| Search recall@20, night | measured and published, no target yet |
| Journey: correct next camera in top-3 | ≥ 85 % |
| Ask: correct + cited | ≥ 80 %; 0 uncited claims |
| Search p95 latency (30 days, 100 cameras) | < 2 s |
| GPU overhead of the index | < 10 % of detection load |

### 10.3 Product usage (after launch)

- Searches per active tenant per week; % of searches where a result is opened (search quality proxy).
- Cases created per week; % of alerts converted into cases.
- Evidence exports per month.
- Add-on attach rate on new deals; pilot → paid conversion for pilots that used the toolkit vs those that didn't.

---

## 11. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Attribute accuracy poor on Indian clothing / CCTV angles | Medium | High | Label our own 10–20 k crops; HSV colour baseline from day 1; publish measured recall |
| Night / IR breaks colour search | High | Medium | Mark IR tracks; say "colour not available (night)"; rely on embedding + ReID at night |
| GPU overhead too high | Low–medium | Medium | Per-track (not per-frame) design; measure in week 1; index person + vehicle only at first |
| Index storage cost at scale | Medium | Medium | int8 vectors, day partitions, prune `track_points` after 7 days, tie to video retention |
| NVR overload / bans from backfill | Low (if rules followed) | Very high | Never auto-backfill from NVR; explicit, capped, one-session jobs; stop on first error |
| Cross-tenant data leak through search | Low | Very high | Server-side tenant filter on every query; automated test; audit log |
| Privacy / DPDP / misuse concerns (profiling) | Medium | High | Gender / age off by default; purpose field on exports; full audit; Responsible AI page (P0-3) |
| LLM hallucination in Ask | Medium | High | Tool-grounded answers with citations; refuse when tools return nothing |
| Air-gapped customers can't use cloud LLMs | Certain | Medium | Rule-based parser + local LLM; Ask in reduced mode |
| Licence problems with pretrained weights / datasets | Medium | High | Legal check before shipping each model; prefer permissive weights; own labelled data |
| Scope creep into police case management | Medium | Medium | Stop at cases + evidence; partner and integrate for the rest (P2-9) |

---

## 12. What we are not building

- **A full police case-management system** (charge sheets, witnesses, court dates, rosters). Kautilya and CCTNS own that; we integrate and export (P2-9).
- **A general "chat with any video" model** that watches raw footage at query time. Too slow and expensive at CCTV scale; the index + tools approach is faster and verifiable.
- **Automatic NVR backfill.** Against our NVR-safety rules.
- **Emotion or "suspicious behaviour" scoring from appearance.** Unreliable and a reputational risk.
- **Generic digital forensics** (phone extraction, OSINT). Adjacent product lines; partner instead ([COMPARISON.md](COMPARISON.md) "not building").

---

## 13. Open questions

1. **Journey API:** does smart-cam-ai's journey search already accept a ReID vector or track id as a seed, or only a face / photo? This decides whether I-3 is S or M.
2. **Track volume:** how many tracks per camera per day on the lab and the 2,600-camera site? This sizes Qdrant and Postgres (§6.3).
3. **Embedding model licence:** which CLIP / SigLIP weights can we ship commercially and on-prem?
4. **Labelling budget:** in-house or a vendor for 10–20 k attribute crops?
5. **Pricing:** add-on per camera vs tier; does it apply to the perpetual-licence customers?
6. **Pilot partners:** which 3–5 customers will run the time study (§10.1)? At least one police / safe-city customer is needed for credibility.
7. **On-prem LLM:** which local model and hardware do we standardise on for air-gapped installs (affects the edge box spec, already a known gap)?
8. **Case storage quotas:** how much preserved footage per plan before we charge?
