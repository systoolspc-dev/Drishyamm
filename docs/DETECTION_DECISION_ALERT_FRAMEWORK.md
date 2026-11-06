# Drisyam Detection → Decision → Alert → Log Framework

> **Status:** Canonical · **Date:** 2026-08-07 · **Owner:** AI/Platform
> **Supersedes & unifies:** `docs/DETECTION_LOGGING_ALERTING_POLICY.md` and `docs/RESTRICTED_ZONE_DETECTION.md`
> **Grounding:** built from a code-level map of the live pipeline; the P0 claims below were verified directly against source (`internal.routes.js:104`, `alert_backend_forwarder.py:170`, `alertEngine.js:183/203`).

**The one line the whole framework reduces to:**

> **We DETECT per frame, we DECIDE per track, and we ALERT per identity-transition** — so the same person moving slightly changes no *state*, and therefore produces no new event, no new alert, and no new log row.

This is not a Drisyam invention. It is the discipline the process industries codified in **ISA-18.2 / EEMUA-191** ("a signal crossing a threshold is *not* an alarm; an alarm is a debounced, actionable, abnormal state transition") and that every mature VMS (Genetec, Milestone, Verkada, BriefCam) implements as **raw detection → track → event → rule → alarm/case**. Alarm rationalization under this discipline removes 30–60% of the events a naive system emits.

---

## 0. Why this document exists

A detector is **stateless**: SCRFD/YOLO re-fire on every frame, so a person standing still (or turning their head, or shifting weight) generates a fresh box 4–15 times a second. If any layer treats those boxes as events, you get:

- a **DB-row flood** (the historic 10k `ai_events` incident),
- an **alert flood** (the same person alerting every few seconds),
- and an **Alerts list that disagrees with the notifications** (rows deduped in one place but not the other).

The cure is to make **state**, not detection, the unit of truth. The rest of this doc defines that precisely, gives concrete parameter values, maps every use case onto it, walks three worked case studies, and lists the exact code changes needed.

---

## 1. The conceptual hierarchy (six unambiguous terms)

Every analytic in Drisyam MUST map its output onto exactly these six layers. This L1–L6 numbering is now canonical and **replaces the conflicting "L3" definitions** in the two prior docs (the old policy doc's `L3=State` and the zone doc's `L3=Zone incident` are reconciled here).

| Layer | Name | Unit of truth | Rate | Lives in | Persisted? |
|---|---|---|---|---|---|
| **L1** | **DETECTION** | a bounding box from SCRFD/YOLO | per frame, 4–15 fps | GPU only | never |
| **L2** | **TRACK** | a `track_id` — "the same real object over time" | every processed frame | `ai.live` ephemeral overlay | never |
| **L3** | **STATE** | a per-entity FSM (ABSENT→CONFIRMED→ALERTED→CLEARING) | changes only on transition | in-memory (AI worker / backend) | no |
| **L4** | **EVENT** | one confirmed L3 **transition** → one `ai_events` row + snapshot | 0–6 per entity lifetime | DB (`ai_events`) | **yes — "the log"** |
| **L5** | **ALERT** | the policy-gated subset of L4 pushed to a human | 0–2 per entity lifetime | push / email / toast | **yes — "the alarm"** |
| **L6** | **INCIDENT** | a correlated *set* of events/alerts about one real situation | 1 per situation | DB (`incidents`) | **yes** |

**The two load-bearing rules:**

1. **L1→L2 is ephemeral.** Boxes ride the `ai.live` overlay and are drawn-then-dropped. They NEVER touch `ai_events`. *(This is the split that stopped the 10k-row flood — keep it.)*
2. **You only LOG (L4) and ALERT (L5) on an L3 transition** — never on a detection, never on a per-frame track update.

### Definitions, stated precisely

- **DETECTION (L1)** — a stateless per-frame observation `{bbox, score, class, frame_ts}`. No memory; a stationary person produces one *per frame*. Detections are data, never events.
- **TRACK (L2)** — a persistent identity from the tracker (Kalman predict + Hungarian associate + IoU/appearance cost). A slightly-moving or briefly-occluded person keeps the **same `track_id`**. The track *is* the dedup primitive: **one presence = one track.**
- **STATE (L3)** — a finite state machine per entity. Transitions are the only thing that matter downstream.
- **EVENT (L4)** — a durable record of a *meaningful episode boundary* (confirmed birth, violation crossing, death). Written once per transition. *Bias logging toward completeness.*
- **ALERT (L5)** — a human-facing notification on the abnormal, actionable subset of events, subject to cooldown and burst cap. *Bias alerting toward silence.*
- **INCIDENT (L6)** — the correlation container. When the *same condition* re-fires at the *same location/identity*, the new event is **appended to the open incident** rather than opening a new one. A "person loiters 4 min → escalates → leaves" is **one incident with three events**, not three incidents. The key that ties them is the **resolved identity key** (§2), never `track_id`.

---

## 2. The identity-resolution ladder (the missing piece)

The prior doctrine's headline rule — *"cooldown keyed on stable identity, never `track_id`"* — was **unsatisfiable for its own flagship detector**: a body-only zone intruder has no face, so the only key available was `track_id`, which churns on exactly the "slight movement / occlusion / ID-switch" the doctrine exists to prevent.

Fix: the dedup / incident key is always the **highest available rung** of this ladder:

| Rung | Key source | Stability | Use when |
|---|---|---|---|
| **R1 Stable identity** | `personId` (face match), plate string (ANPR) | survives everything | recognition succeeded |
| **R2 Appearance** | body-ReID embedding (OSNet / BoT), cosine-matched to a per-track feature bank | survives occlusion & short gaps | face absent, body visible |
| **R3 Spatial** | quantized foot-point cell + IoU-overlap within a time window | survives ID-switch in place | no identity, no ReID |
| **R4 Track** | raw `track_id` | volatile — churns on re-track | last resort only |

**Rule:** `resolved_key = R1 ?? R2 ?? R3 ?? R4`. The zone `incident_id`, the alert `subject`, and the `ai_events` dedup key are ALL built from this resolved key — so a re-track *in place* resolves to the same R3 cell and does **not** mint a new incident. This single change makes the doctrine correct in the faceless case.

---

## 3. The canonical state machine (one template, all detectors specialize)

```
                 M1: present K-of-N within window W          alert gate passes
   ABSENT ───────────────────────────────▶ CONFIRMED ──────────────────────▶ ALERTED
     ▲                                          │  ▲                              │
     │                                          │  │ (still present, in cooldown) │
     │        M2: absent ≥ T_clear (hysteresis) │  └──────────────────────────────┘
     └────────────── CLEARING ◀─────────────────┘        heartbeat re-alert only
                (absent, counting down T_clear)           every T_realert while held
```

- **ABSENT → CONFIRMED** = birth debounce (**M1, K-of-N / on-delay**). Never emit on first detection.
- **CONFIRMED → ALERTED** = the alert gate fires **once** (the NORMAL→ABNORMAL edge). While held in ALERTED, emit nothing except an optional throttled heartbeat.
- **ALERTED/CONFIRMED → CLEARING → ABSENT** = exit debounce (**M2, off-delay/hysteresis**). Must stay clear for `T_clear` before re-arming. Prevents flicker re-fire.

`SUPPRESSED` (authorized identity, shelved, quiet-hours) is an **orthogonal flag**, not a state. The zone detector's existing `OUTSIDE/INSIDE/ALERTED/SUPPRESSED` machine ([zoneIntrusion.service.js](../backend/src/services/zoneIntrusion.service.js)) is this template already; face / headcount / PPE / loiter must be rebuilt onto it.

---

## 4. The six mechanisms (M1–M6) with concrete values

M1–M4 are the existing canon (kept). **M5** (spatial/appearance continuity) and **M6** (rate governor) are new.

### M1 — Entry confirm (K-of-N / on-delay)
Flip CONFIRMED only after present in **K of the last N frames**, expressed as a **wall-clock window** (fixes fps drift — "5 of 8 frames" is 0.5s @15fps but 2.0s @4fps).
- **Confirm-in window `W_confirm = 0.6–1.0 s`; K/N ≈ 3/5 to 5/8** evaluated within that window regardless of fps.
- Tracker equivalent: `min_hits = 3` (range 2–5). Single most effective anti-false-track knob.

### M2 — Exit debounce (hysteresis / off-delay)
CONFIRMED→ABSENT only after absent **≥ T_clear**. **Confirm-in must be harder than confirm-out is fast** (asymmetric).
- Presence/zone: `T_clear = 5–15 s` (zone default **8 s**). Track-lost grace `max_age → 0.5–2 s`, converted by actual fps.
- **Count thresholds: deadband** — alert at N, clear at **N − margin** (e.g. 50/45). Closes the headcount-flap gap.

### M3 — Per-identity cooldown
After an alert, suppress the **same resolved-identity key** (§2) for a window. **Never key on `track_id`.**
- Push **90 s**, email **600 s**, in-app toast **120 s** (current `alertEngine.js` values — keep). Watchlist visit cooldown **≥ 1 h** (session boundary). ANPR **60–120 s** per plate.

### M4 — Burst cap (aggregate backstop)
Hard ceiling for "many different people at once" that M3 can't catch.
- **8 alerts / 600 s per user** (rolling). This is the EEMUA "flood = >10/10min" line, set conservatively. Fail-open if Redis is down.

### M5 — Spatial / appearance continuity (NEW)
Makes R2/R3 first-class so identity degrades gracefully instead of collapsing to `track_id`.
- **Appearance (R2):** per-track feature bank of the last ~100 L2-normalized embeddings; cosine gate `max_cosine_distance ≈ 0.2`; a returning person matches the bank → old identity restored, no new event.
- **Spatial (R3):** quantize foot-point to a grid cell (~**32 px**) + require IoU-overlap ≥ 0.3 with the pre-gap position within `T_spatial = 3 s`. Add a **max center-movement tolerance** (~**1.5× bbox width**) so pacing/crouching does NOT reset dwell — the exact "moving slightly" case.
- New config: `positional_dedup_cell_px`, `positional_dedup_window_s` (absent from `ZONE_DEFAULTS` today).

### M6 — Rate governor / chatter guard (NEW — SLO enforcement)
Adopt EEMUA rates as system SLOs, not just per-rule caps.
- **Target ≤ 6 alerts / operator / hour** steady-state; **flood = >10 / 10 min → auto-throttle/aggregate.**
- **Chatter red-line:** any (detector × entity) producing **≥ 3 ALERTED↔CLEARED transitions / minute** is auto-flagged misconfigured and its hysteresis auto-widened. Automated regression guard against future flood incidents.
- **Priority mix target ≈ 80/15/5** (low/med/high) so watchlist/weapon-class stays rare and credible.

---

## 5. The alert gate (fires iff — all must hold)

```
state == CONFIRMED
  ∧ transition_just_happened           (edge, not level)
  ∧ dwell_or_severity_met              (per use-case threshold)
  ∧ armed_now                          (schedule / quiet-hours / zone armed)
  ∧ resolved_identity ∉ cooldown       (M3, keyed via §2 ladder)
  ∧ under_burst_budget                 (M4)
  ∧ not SUPPRESSED                     (authorized / shelved)
```

Everything failing the gate is **L4 log-only** (still recorded) or dropped. *Bias logging toward completeness, alerting toward silence.*

---

## 6. Per-use-case cadence matrix (all 8)

| # | Use case | Detect LEVEL | Confirm (M1) | Alert condition (transition) | Dedup key + cooldown (M3) | Re-trigger = NEW event when… | Log (L4) | Retention |
|---|---|---|---|---|---|---|---|---|
| **a** | **Zone intrusion / line-cross** | `(resolved-key × zone)` FSM, **foot-point in polygon** | inside 5/8 within ~1s; line = feet cross armed dir | INSIDE → dwell_met ∧ unauthorized ∧ armed (dwell 0s hard / 30s open) | per (key×zone) **60s**; per-zone cap 1/10s | left zone (outside ≥1.5s + lost>grace) then re-enters | 1 row/incident: enter/leave, dwell, authorized, snapshot | 90d |
| **b** | **Loitering / dwell** | `(resolved-key × area)` FSM | inside 5/8 | dwell ≥ **30–60s** (open) / **300s** (parking) → once; escalate 2×,4× | per key **300s** | exits+lost then re-enters & re-accrues | crossing + escalations; total dwell on exit | 30–90d |
| **c** | **Watchlist face-match** | per **`personId`** (R1) | `min_hits=3` ∧ cosine ≥ thr | unseen → confirmed-present for this identity/camera | personId+camera: 120s fwd / 90s push / 600s email; **visit gap ≥1h = new visit** | same identity after ≥1h gap | 1 row/visit; severity critical | 90d–1yr; embeddings by consent |
| **d** | **Unknown-face / tailgating** | all unknowns → **one `unknown` token/camera** | unknown track 3 hits; tailgate = 2 bodies/1 grant ~3s | dwell ≥ **180s** ∧ (after-hours ∨ secure-zone); tailgate = N-in-per-grant | per-camera `unknown`/spatial, gap 60s | new cluster after ≥1h; or crosses into secure zone | 1 row/unknown-dwell or tailgate; short crop | **7–30d** |
| **e** | **PPE violation** | `(resolved-key × ppe_class)` | violating 6/10 (~1s) on stable track | compliant → violating sustained ≥ **3–5s** in armed zone | per key **300s**; per-zone cap | leaves then re-enters non-compliant; shift/zone change | 1 row/violation/worker: class, zone, dwell, snapshot | 30–90d |
| **f** | **Phone-usage / productivity** | per **identity**, session ledger — **NOT alert-shaped** | phone-near-hand ≥ 3–5s continuous | none by default; threshold only if shift policy set | per identity/session; merge if gap <60s | new phone session after gap ≥60s; new work session after break ≥15min | aggregate time-in-state + session count/shift | daily rollup, purge frame-level |
| **g** | **Headcount / occupancy** | per **camera/zone COUNT** (no identity) | count ≥ threshold for K=3 polls | crosses UP through N with **hysteresis** (alert N, clear N−margin) | per zone; no re-alert while held | drops below clear-level then rises above N | 1 row/level-crossing + coarse trend samples | counts non-personal (free) |
| **h** | **ANPR / plate** | per **plate string** (R1 via OCR) | same plate ≥3 frames, **char-voting** (0/O, 1/I) | plate confirmed at gate → hotlist / entry-exit | per plate-string, gap **60–120s** | same plate after pass-through window | 1 row/pass: plate, dir, lane, ts, best crop, hotlist | 30–90d; hotlist separate |

**Cross-cutting (India DPDP):** purpose limitation (never reuse a security gallery for productivity), data minimization (crop not full frame; aggregate not per-frame), storage limitation (honor the per-camera retention feature; auto-purge non-matches), documented lawful basis per analytic. Retention = the minimum that satisfies evidentiary need.

---

## 7. Worked case studies (frame-by-frame: naive vs correct)

Assume `target_fps = 4` unless noted.

### Case study 1 — Watchlist person turns their head (the canonical bug)

**Scenario:** "Ravi" (watchlisted) stands at the lobby camera 40 s, turns his head twice (each turn loses the face ~4 frames), shifts weight once.

| Time | Detector (L1) | Tracker (L2) | State (L3) |
|---|---|---|---|
| 0.0s | face 3× | T1 born, TENTATIVE (hits 1→3) | ABSENT |
| 0.75s | face, cosine match "Ravi" | T1 CONFIRMED (min_hits=3) | ABSENT→**CONFIRMED**, personId=Ravi → **1 ALERT** |
| 8s | pool saturates → embed skipped | T1 alive, candidate gate quiets | ALERTED (held) |
| 10s | **head turn: face lost 4 frames** | T1 coasts (Kalman, miss<max_age) → **same T1** | ALERTED (held) — no clear, no re-alert |
| 25s | weight shift, box +40px | IoU gate absorbs → same T1 | ALERTED (held) |
| 40s | face gone | T1 miss climbs | absent ≥ T_clear → CLEARING→ABSENT, close incident |

- **Naive:** ~160 detections; each turn/shift mints a fresh `track_id` → **5–10 watchlist alerts**, ~160 `ai_events` rows.
- **Correct:** **1 alert, 1 incident, 1 L4 "visit" row** (first-seen 0.75s, last-seen 40s, dwell 39.25s). Head turns absorbed by Kalman coast; key is `personId=Ravi` (R1) so even a die/re-birth is suppressed by M3's 90s stable-identity cooldown.
- **Today:** Drisyam gets the *push/email* right but still writes ~N `ai_events` rows (Gap P0-1).

### Case study 2 — Body-only intruder loiters behind a pillar (the faceless case the old doctrine failed)

**Scenario:** unidentified person (no resolvable face) enters an armed zone, stands 3 min, is occluded by a pillar ~6 s mid-way (tracker ID-switches T7→T9).

| Time | Event | Old doctrine (`track_id` key) | Framework (§2 ladder) |
|---|---|---|---|
| 0s | enters | T7 born | T7 born |
| 0.8s | dwell-confirmed, unauthorized | ALERT (subject `zone×T7`) | no face/ReID → **R3 spatial cell C** → ALERT (`zone×C`) |
| 90s | 6s occlusion, re-emerges **T9** | new subject `zone×T9` → **2nd ALERT (flood!)** | R3 → same cell C → **no new alert** |
| 180s | still dwelling | per-track cooldown expired → possible re-alert | ALERTED held; only `T_realert`=5min heartbeat |
| 188s | leaves | — | empty ≥ 8s → CLEARING→ABSENT, close incident |

- **Old:** ID-switch on occlusion → duplicate alert (the doctrine's own flagship contradiction).
- **Framework:** **1 incident, 1 alert + optional heartbeat**, because the key is the spatial cell (R3) / body-ReID (R2), not `track_id`.

### Case study 3 — Occupancy hovering at the threshold

**Scenario:** capacity alert at N=50. Real count oscillates 48↔51 for 10 minutes at lunch.

- **Naive (no hysteresis):** every 50→51 crossing fires; ~20 crossings → **~20 alerts** (ISA chatter red-line ≥3/min).
- **Framework (M2 deadband + M1 K-poll):** alert when count ≥50 held for **3 consecutive polls**; do not clear until count ≤ **45** (N−margin). The 48↔51 oscillation never touches 45 → **1 alert at first breach**, 1 clear when it finally empties below 45. Trend chart still gets coarse per-minute samples.

---

## 8. Gap analysis + prioritized implementation plan

Mapped to actual files. Effort: S ≤ 0.5d, M ≈ 1–2d, L ≈ 3–5d. **P0 claims verified against source.**

> **Implementation status (2026-08-07, branch `harden/critical-fixes`):** all three **P0** items are DONE — P0-1 persist-path dedup (`alertEngine.claimEventRow`/`markOpenRow` + `internal.routes.js` `/ai/events`), P0-2 spatial-cell key for unknowns (`alert_backend_forwarder.py`), P0-3 occupancy hysteresis (`occupancyHysteresis.js` + zone capacity mode + migration `029` + `RestrictedZone.maxOccupancy`; unit-tested 6/6). Not yet deployed to prod. P0-3 needs migration 029 to run and a UI field to set `maxOccupancy`. P1/P2/P3 remain.

| P | Gap | File(s) | Change | Effort | Impact |
|---|---|---|---|---|---|
| **P0** | **Persisted `ai_events` never deduped** — every forwarded event = a row; `alertEngine` only throttles push/email (it runs *after* `AIEvent.create`) | `smart-cam-backend/src/routes/internal.routes.js:104` (+ `services/alertEngine.js`) | Before `AIEvent.create`, apply the SAME stable-subject + cooldown (`subjectFor` + `claimCooldown`) `alertEngine` already computes; on cooldown hit, **update the open incident row's last_seen/count in place** instead of inserting | M | **Highest** — kills the DB-row flood; makes the Alerts list match the notifications |
| **P0** | **Unknown-person dedup keys on volatile `track_id`** | `smart-cam-ai/.../infra/alert_backend_forwarder.py:170` | `subject = person_id or track_id or "any"` → `person_id or spatial_cell(bbox) or "unknown"`; collapse unknowns to the stable token to match `alertEngine.js:186` | S | High — stops unknown re-track flood at the source |
| **P0** | **No occupancy hysteresis** — count flaps at threshold | headcount/occupancy service + `settings.py` | Add M1 (K=3 polls) + M2 deadband (alert N, clear N−margin). New params `occupancy_confirm_polls`, `occupancy_clear_margin` | S | High — removes a whole class of chatter (case study 3) |
| **P1** | **Match worker has no transition/cooldown concept** — 1 `vms.alerts` + 1 `DetectionEvent` per candidate | `smart-cam-ai/.../workers/match_worker.py:212-235,307-331` | Per-`resolved-key` FSM so a candidate only publishes on the unseen→confirmed edge; hold + `T_realert` heartbeat otherwise | L | High — moves dedup upstream, relieves every downstream layer |
| **P1** | **Identity ladder / M5 not implemented** — faceless case collapses to `track_id` | `services/face_tracker.py`, new `identity_resolver.py`, `zoneIntrusion.service.js` | Implement `resolve_key = R1 ?? R2 ?? R3 ?? R4`; per-track appearance bank + spatial-cell dedup; rebuild `incident_id` off resolved key | L | High — the correctness fix for the faceless/occlusion case |
| **P1** | **Anti-flood thresholds duplicated in 3 places** | `alert_backend_forwarder.py`, `alertEngine.js`, `AIToastHost.jsx` | Extract ONE shared policy module (subject derivation + cooldown/burst values); test asserting subject is identity-only, never `track_id` | M | Medium-high — single source of truth, regression guard |
| **P2** | **FSM exists only for zones** — face/PPE/loiter/headcount have cooldowns but no ENTER/STAY/CLEAR machine | new shared `presence_fsm`; apply in match_worker, activity-monitor `alert_policy.py` | Generalize the zone 4-state FSM (§3) into a reusable template; specialize per §6 matrix | L | Medium — closes the missing PPE/loiter/tailgate FSMs |
| **P2** | **K-of-N & exit-debounce are frame-counted, drift with fps** | `settings.py` (`tracker_max_age`, `min_hits`), zone `CONFIRM_MS` | Express all confirm/clear/max_age windows in **wall-clock seconds**, convert by the stream's actual fps at runtime | M | Medium — confirm strength stable across fps 4/12/30 |
| **P2** | **Confirm gate is count-only, not quality/motion-aware** | `orchestrator.py:764-979`, zone FSM | Add track-age + motion-consistency + quality to the CONFIRMED gate so a static false box (poster/reflection) does not confirm | M | Medium — cuts false positives at source |
| **P3** | **No cross-camera dedup** — one person across 5 cameras = up to 5 tokens | live-tracker / journey fusion | Global-ID layer: pool per-camera tracklet embeddings, Hungarian-match under a gate + movement-graph timing; one journey = one incident | L | Medium — matters for journey/tracker product |
| **P3** | **M6 rate governor / chatter guard absent** | new observability hook + `alertEngine.js` | Instrument alerts/operator/hour SLO (≤6); auto-flag any entity ≥3 transitions/min and auto-widen hysteresis | M | Medium — automated guard against future floods |

**Sequencing:** ship **P0** first (three small–medium changes that stop the actual row/alert floods with the least code), then **P1** (upstream FSM + identity ladder — the structural correctness), then **P2/P3** (generalization, fps-normalization, cross-camera, governance).

---

## 9. What to keep unchanged (already industry-correct)

- **Two-channel split** — ephemeral `ai.live` overlay vs persisted alert path ([backend_forwarder.py](../ai/face-service/vms_face/infra/backend_forwarder.py), [internal.routes.js:132+](../backend/src/routes/internal.routes.js#L132)). Prevented the 10k-row flood. Keep.
- **Tracker identity persistence** (`face_tracker.py`, `max_age=30`) — the primary presence-vs-detection mechanism. Keep (express in seconds — P2).
- **Quality-pool candidate gating** (`orchestrator.py:823-878`) — genuine source-level dedup; a still person's emission rate decays to zero on its own. Keep.
- **`alertEngine.js`** stable-subject + per-identity cooldown (90s/600s) + burst cap (8/600s), fail-open — the canonical M3/M4. Keep; make it the shared module (P1).
- **Zone occupancy FSM** (`zoneIntrusion.service.js`) — the template everything else generalizes from. Keep; extend key to the §2 ladder (P1).
- **`AIToastHost.jsx`** client-side mirror + offline-transition debounce. Keep; feed from the shared policy (P1).

---

*Detect continuously, decide on tracks, alert on debounced state transitions keyed to the highest available identity rung — so the same person moving slightly changes no state and therefore produces no new event.*
