# Occupancy / Head-Count — Product Logic

> **Status:** **P0 + P1 BUILT & verified on local** (rooms, fusion, capacity FSM, incidents) · **Date:** 2026-08-10
> **Grounded in:** the actual code path (verified), commercial occupancy products
> (Density, VergeSense, Xovis, Verkada, Axis, Milesight), and our own
> [detection→alert doctrine](DETECTION_DECISION_ALERT_FRAMEWORK.md) §6 row (g).

---

## 0. What we sell — the four use cases that pay

| # | Use case | The question it answers | Output | Who buys |
|---|---|---|---|---|
| **A1** | **Capacity compliance (safety)** | "Are we over the safe/legal headcount right now — and can I *prove* we weren't last month?" | live number + red/amber state, **real-time alert**, compliance report ("42 min over capacity across 6 breaches in July") | fire-code spaces, banquet halls, gyms, factories, hostels, places of worship |
| **A2** | **Space utilization** | "Which rooms are underused? Should I sublease a floor?" | **reports, not alerts** — utilization %, peak vs average, hour-of-week heatmap, "never used" list | corporate real estate, facilities |
| **A3** | **Peak / staffing** | "When is the cafeteria slammed — staff at 11:30 or 12:15?" | daily/weekly peak curve, busiest hour, day-over-day | canteens, clinics, bank branches |
| **A4** | **Cleaning triggers** | "Which washrooms actually need servicing now?" | work-order trigger on person-minutes since last clean | facilities (15–25% janitorial hour reduction reported) |

A2, A3 and A4 are **the same time series, presented differently**. Build the log once.

---

## 1. What exists today (verified) vs what's missing

| | Today | Needed |
|---|---|---|
| Live count | Redis gauge, **30-second TTL** | keep |
| **History** | ❌ **nothing persisted** — "how many were in the cafeteria at 2pm yesterday?" is unanswerable | minute series + rollups |
| **Room concept** | ❌ none. `camera_groups` is an **NVR device** (`host`, `port`, `username`, `total_channels`); `restricted_zones` is a polygon on **one** camera; `sites` is a building | new `spaces` + `space_cameras` |
| Multi-camera rooms | ❌ per-camera only → **double-counts** a room with 2 cameras | overlap-group fusion |
| Camera offline | ⚠️ silently absent → risk of logging "empty" | explicit `unknown` |
| Breach *clear* | ⚠️ computed then **thrown away** (`=== 'breach'` only) | paired clear + incident |
| Alert paths | ⚠️ **two engines** fire the same `occupancy.threshold`: `internal.routes.js` and `zoneIntrusion.service.js` | reconcile |

---

## 2. The two decisions that make the numbers trustworthy

### 2.1 Fusion — never sum overlapping cameras

```
space_count = Σ over overlap groups g of  max( camera_count × weight  for cameras in g )
```

Cameras that **see the same people** share an `overlap_group` → **MAX**.
Cameras covering **disjoint** parts leave it `NULL` → each is its own group → **SUM**.
Never inferred — always declared in the Space editor.

| Room | Cameras | Groups | Result |
|---|---|---|---|
| Cafeteria (both cover whole hall) | A=12, B=14 | `hall`, `hall` | **max = 14** ✔ (naïve sum 26 ✘) |
| Auditorium (left/right halves) | C=30, D=25 | `NULL`, `NULL` | **sum = 55** ✔ |
| Lobby (2 on door + 1 on seating) | E=8, F=9, G=4 | `door`, `door`, `NULL` | **max(8,9)+4 = 13** ✔ |

### 2.2 Honesty — a dead camera is **not** an empty room

**The rule: `count IS NULL ⟺ quality = 'unknown'`. `0` means the model *looked* and saw nobody.**
No code path may `COALESCE(count, 0)` — not in SQL, not in the fuser, not in the chart.

| quality | Meaning | count | In averages? | Can breach? | Can clear? |
|---|---|---|---|---|---|
| `measured` | every group had a fresh, verified camera | number | ✅ | ✅ | ✅ |
| `partial` | some groups blind → value is a **lower bound** | number (floor) | ❌ | ✅ (a floor ≥ N is proof) | ❌ |
| `stale` | verification older than the budget | number | ❌ | ❌ | ❌ |
| `unknown` | no usable camera / `count_reliable=false` | **NULL** | ❌ | ❌ | ❌ |

This is exactly why the head-count service already publishes `count_reliable`,
`count_age_s` and `gate_saturated` — the log consumes them.

---

## 3. Data model

### 3.1 Rooms

| Table | Row = | Key columns |
|---|---|---|
| `spaces` | a room/hall/floor/entrance | `userId, siteId, name, slug, type, capacity, areaSqm, operatingHours, settings, purpose, enabled` |
| `space_cameras` | which cameras measure it, and how they combine | `spaceId, cameraId, monitorId, role, overlapGroup, weight, maskZoneId` |

`Site.timezone` supplies the business-day boundary. `capacity = 0/NULL` ⇒ capacity alerts off.

### 3.2 The log (tiered — cadence drops as age rises)

| Tier | Store | Row = | Cadence | Retention |
|---|---|---|---|---|
| T0 | Redis gauge + minute accumulator | one 5 s tick | 5 s | 30 s / 3 min |
| T1 | `occupancy_camera_minute` | camera × minute | 1 min | 7 d (debug + **recompute** when an overlap group is fixed) |
| T2 | `occupancy_space_minute` | space × minute | 1 min | 90 d (the chart) |
| T3 | `occupancy_space_rollup` | space × bucket | 15 m / 1 h / 1 d | 13 mo / 25 mo / **forever** |
| T4 | `occupancy_sessions` | "space was in use" interval | derived | 2 y |
| T5 | `occupancy_incidents` | one over-capacity episode | derived | forever |

15-minute buckets are the industry default (Axis, Xovis, Verkada all use them).
Counts carry **no** `trackId`, `bbox`, `snapshot` or `personId` — aggregate
occupancy is not personal data, which is what makes indefinite retention lawful.

---

## 4. Reports (all from T3)

| KPI | Definition |
|---|---|
| Current occupancy | live fused count + quality |
| Peak today / this week | `MAX(count_peak)` over the window |
| Average occupancy | `SUM(person_seconds) / measured_seconds` — **measured only** |
| Utilization % | `occupied_seconds / operating_seconds` |
| Time over capacity | `SUM(over_cap_seconds)` + breach count |
| Busiest hour | `argmax` hourly rollup |
| Hour-of-week heatmap | 7 × 24 grid of average occupancy |
| Never-used rooms | spaces with `peak = 0` across the period |
| Person-minutes since clean | running integral, reset on ack (A4) |

---

## 5. Alerts

| Alert | Rule |
|---|---|
| **Over capacity** | count ≥ capacity for `confirmSec`, armed hours only, quality allows breach → `occupancy.threshold` |
| **Warning tier** | ≥ `warnPct` (default 85%) of capacity — the actionable one (act *before* the breach) |
| **Cleared** | count ≤ capacity − margin for `clearSec` → `occupancy.cleared` (pairs the incident) |
| **Coverage lost** | a space's cameras go blind while occupied → operational alert, **not** a count of 0 |

All routed through the existing `alertEngine` dedup (stable subject, per-identity
cooldown, burst cap) — the doctrine's M3/M4. One room over capacity = **one**
alert, not one per camera.

---

## 6. Build order

**P0 — honest samples + logs (no rooms yet).** ✅ **DONE (local)**
migration `030` (4 tables) · `services/occupancy/quality.js` (+14 tests) · widened
forwarder payload (`reliable`/`ageSec`/`degraded`/`tracked`) · ingest rewrite with
quality derivation + Redis minute accumulator · `occupancyAggregator.service`
(flush → minute rows, rollup → 15m/1h/1d, retention) · `GET /api/occupancy/history`
+ `/summary`.
→ *Ships: real history, honest gaps, no more 30-second amnesia.*

**Verified end-to-end on local:**
| Check | Result |
|---|---|
| Live camera tick | `heads:4, quality:"measured"` |
| **Dead camera tick** | **`heads:null, quality:"unknown"` — never 0** ✅ |
| Minute rows | measured → `count_avg=4`; blind → `NULL/unknown` |
| Rollup math | 12 samples × 5s = **60 measured_sec**, 4 avg → **240 person_sec** ✓ |
| History API | 2 bucket points, `knownPct:100`; raw minutes `knownPct:33` with **4 explicit gaps** |
| Summary API | `peak:6, averageOccupancy:4, utilizationPct:100, busiestHour:19` |

**Three bugs found by running it (not by reading it):**
1. Tenant id was stamped only on *usable* samples → a camera blind for a whole
   minute produced an orphan accumulator that the flush **dropped**, silently
   erasing exactly the blind minutes we must record. Now always stamped.
2. Rollup `GROUP BY` didn't match the bucket expression in `SELECT` →
   `only_full_group_by` rejected every rollup.
3. The leader lock was held for the whole interval and never released, so every
   scheduled tick raced its own expiry and manual runs were silently skipped.
   Now acquire → work → `release()` in `finally`.

**P1 — rooms, room alerts, incidents.** ✅ **DONE (local)**
migration `031` + `Space`/`SpaceCamera` models · `services/occupancy/fuse.js` (+14 tests)
· `occupancyEvaluator.service.js` (10s leader-elected FSM: overlap-group fusion, warn
tier, confirm/clear hysteresis, operating-hours arming, **paired breach→clear**,
incidents as durable state) · `space.controller.js` + `/api/spaces` CRUD + `/api/spaces/live`.
Remaining for P1: report endpoints + CSV, 3-tab frontend, weekly email.

**Acceptance run (Cafeteria, cap 10, two cameras on the SAME hall):**
| Scenario | Result |
|---|---|
| Both cameras see the hall (12 and 14) | **count 14** — MAX, not 26 ✅ |
| Over capacity | `state: over`, **1** `occupancy.threshold` (critical) for the ROOM, not per camera ✅ |
| **One camera dies** while busy | count **12** (lower bound), `coverage 50%`, still `over` — **no false clear** ✅ |
| **Both cameras die** | **`count: null`, `quality: unknown`** — incident stays **open** ✅ |
| Room genuinely empties (both live, 0) | `count 0, measured` → **cleared**, incident paired ✅ |
| Compliance record | `Cafeteria · cap 10 · peak 14 · cleared` — the provable artefact for A1 ✅ |

**Bug caught by running it:** the CLEAR was emitted as a *critical* `occupancy.threshold`
reading "0 people — over capacity" — i.e. emptying a room would have paged the operator.
Now three distinct kinds: `occupancy.threshold` (critical) / `occupancy.warning` (warning)
/ `occupancy.cleared` (**info**, "back under capacity").

**P2 — accuracy + scale.** Count masks (polygon per camera so a corridor doesn't inflate
a room), tenant-sharded head-count service, weight calibration, queue mode.

**P3 — line crossing.** Virtual line + in/out events → footfall/entries. Does not block P1.

---

## 7. Acceptance tests ("done" means these pass)

1. Room at cap 50 oscillating 48↔51 for 10 min → exactly **1** breach + **1** clear + **1** incident.
2. Kill one of two cameras in a room holding 12 → chart shows a **gap**, `coverage_pct < 100`,
   **no `0` row**, **no clear**, `SUM(occupied_sec)` unchanged, incident stays `open`.
3. Restart the backend mid-breach → no re-alert, incident still `open`, clear still pairs.
4. Two cameras on one hall in the same overlap group → **max**, not sum; a 3-camera room
   over capacity → **1** alert, not 3.
5. `grep -rn "COALESCE(count" src/` returns **nothing**.
