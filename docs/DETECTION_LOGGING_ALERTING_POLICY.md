# Detection, Logging & Alerting Policy

*Drishyam VMS — the canonical doctrine for **when to detect, when to log, and when
to alert.** Applies to every analytic in the platform: face recognition
(watchlist / unknown), restricted-zone intrusion, crowd / stampede, occupancy /
headcount, and attendance / activity. Read this before adding any new detector or
tuning any alert threshold.*

> **One sentence:** A camera *detects* ~20–40 times per second per person; almost
> none of that is an **event**, and only a tiny, policy-gated subset is an
> **alert**. We never alert on detections — **we alert on debounced state
> transitions of a tracked entity.**

---

## 1. Why this document exists (the problem, from the field)

The recurring failure — the one that made this doc necessary — is the **flood**:

- A watchlisted person stands in view. The recogniser confirms them 20×/sec.
  Naïvely, that is 20 alerts/sec.
- A person shifts their weight, turns their head, or is briefly occluded by a
  pillar. The tracker drops the old `track_id` and starts a **new** one. Keyed on
  `track_id`, dedup thinks it's a *new person* → **re-alert.** This is the exact
  "person slightly moved and we detected again" bug.
- An unknown face at a busy daytime gate is *normal traffic*, not a threat, but a
  detector that treats every unknown as an incident sends hundreds of mails an hour.
- Boundary jitter: a hand or a shoulder crosses a zone line for two frames →
  intrusion alert → the box flickers back out → the incident closes and reopens →
  **double alert.**

Every one of these is the same root cause: **treating a raw detection as if it
were an event.** The industry converged on the same fix a decade ago — a
*persistence / dwell* requirement plus *temporal confirmation* cuts false alarms
by **80–95%** versus single-frame detectors ([Pelco][pelco], [Lumana][lumana],
[Actuate][actuate]). Our own measured number on a live day (2026-07-10) was a
**203:1** collapse: **47,298 detections → 233 stored events → ~2 alerts.**

This document turns that fix into a *rule every detector must obey*, not a trick
one detector happened to get right.

---

## 2. The five layers (the funnel)

Every analytic, no matter the modality, is the same pipeline. Each layer has a
different **unit of truth**, a different **rate**, and a different **destination**.

```
 LAYER          RATE            UNIT OF TRUTH        DESTINATION        PERSISTED?
 ─────────────────────────────────────────────────────────────────────────────────
 L1 Signal      ~8–30 fps       a detection box     GPU only            no (ephemeral)
    ↓ associate
 L2 Track       every frame     a track_id          overlay socket      no (display only)
    ↓ confirm  (K-of-N)         "same real person"
 L3 State       per entity      a state machine     —                   in-memory
    ↓ transition (dwell/hyst.)  (OUT→IN, seen→gone)
 L4 Event       0–6 / entity    a state TRANSITION   ai_events (DB)      YES  ← "the log"
    ↓ policy   (cooldown+cap)
 L5 Alert       0–2 / entity    a notified incident  push / email        YES  ← "the alarm"
```

**The two lines that matter:**

- **L1→L2 is ephemeral.** Bounding boxes on the live video ride the
  `ai.live` overlay channel (`/ai/overlay`) and are **never written to
  `ai_events`.** Routine face boxes must *not* touch the events table. (We learned
  this the hard way — the first face-detection wiring persisted every box and put
  10 000 rows into alerts in one session. See
  [`feature_ai_overlay_bridge`](../.claude/…/feature_ai_overlay_bridge.md).)
- **You only ever LOG (L4) and ALERT (L5) on a *state transition* (L3).** Not on a
  detection. Not on a frame. On a *change of state of a tracked entity.*

---

## 3. The four canonical mechanisms (every detector implements all four)

These are non-negotiable. A new detector that skips any of them will flood.

| # | Mechanism | What it does | Concrete default | Why |
|---|-----------|--------------|------------------|-----|
| **M1** | **Entry confirm — K of N** | An entity's state flips to ACTIVE only after it is present in **K of the last N frames** (not 1). | face: `min_hits = 3`; zone: **5 of 8**; occupancy: 3 consecutive polls | Kills single-frame phantoms, box flicker, a hand crossing a line. Axis/Avigilon require an object be *classified and stable* before it counts; K-of-N is the cheap, robust version. |
| **M2** | **Exit debounce — hysteresis** | ACTIVE→INACTIVE only after the entity is **absent for M consecutive frames / ~1.5 s**, not on the first missing frame. | zone exit: **~1.5 s**; recognition visit gap: **1 h**; break gap: **15 min** | A person straddling a line or briefly occluded must not toggle the state — a toggle *closes and reopens the incident → double alert.* Confirm-in must be harder than confirm-out (asymmetric thresholds = hysteresis). |
| **M3** | **Per-*identity* cooldown** | After an alert fires for an entity, suppress further alerts **for that same entity** for a cooldown window. **Keyed on stable identity, never on `track_id`.** | push **90 s**, email **600 s**, zone re-alert **60 s**, face backend **120 s** | This is the fix for "person slightly moved → new track_id → re-alert." A moving person re-tracks under a new `track_id`; keying dedup on `track_id` made it useless. Known people key on `personId`/name; **every unknown on a camera collapses to a single `unknown` token.** (`alertEngine.subjectFor()`.) |
| **M4** | **Rate cap (burst budget)** | A hard backstop: at most **X alerts per user per window**, regardless of how many *distinct* entities appear. Over budget → suppress + log the suppression. | email **8 / 10 min** per user | "Many different people at once" (a crowd walking past a watchlist camera) must still not flood. Cooldown handles *one* entity; the cap handles the *aggregate*. |

**The alert gate, in full.** An L5 alert fires **iff**:

```
state == ACTIVE                     (M1 confirmed it)
  ∧ transition just happened        (L3 edge, not a level)
  ∧ dwell/severity threshold met    (per-detector, §5)
  ∧ armed now                       (schedule / after-hours / zone active)
  ∧ identity NOT in cooldown        (M3)
  ∧ user under burst budget         (M4)
```

Everything else is logged-only (L4) or dropped (L1/L2).

---

## 4. What to LOG vs what to ALERT (the three tiers)

| Tier | Example | Channel | Retention | Rule |
|------|---------|---------|-----------|------|
| **Ephemeral** | live bounding boxes, name tags, per-frame density | `ai.live` socket overlay | none (dropped) | Display only. **Never** hits `ai_events`. |
| **Event (logged)** | "Anil entered at Gate-2 09:14", "zone incident: track T dwelled 5.3 s", "occupancy crossed 50" | `ai_events` row (+ snapshot in MinIO) | 30 d default (per retention policy) | Written on **every confirmed state transition**, authorized or not. This is the audit trail / the Reports page / the forensic timeline. |
| **Alert (notified)** | watchlist match, unknown after-hours in a secure zone, CRITICAL stampede, zone intrusion | push + email (+ live toast) | same row, `severity ∈ {warning, critical}` | The gated subset of §3. A human is interrupted — spend that interruption carefully. |

> **Design consequence:** the events table is a *complete* record; the alert stream
> is a *curated* one. You can always mine events after the fact (Reports, journey,
> attendance). You cannot un-send an alert. So bias logging toward completeness and
> alerting toward silence.

---

## 5. Per-detector application (the doctrine, made concrete)

Each detector maps onto the same five layers; only the *entity*, the *confirm
gate*, the *dwell*, and the *severity* differ.

### 5.1 Face — watchlist match
- **Entity key:** `personId` / enrolled name (stable across re-tracks).
- **Confirm (M1):** track survives `track_min_hits_to_match = 3` frames *and* cosine
  match ≥ threshold on a confirmed track.
- **Transition (L3):** `unseen → confirmed-present` for this identity on this camera.
- **Cooldown (M3):** 120 s at the AI forwarder (`backend_alert_cooldown_sec`) +
  90 s push / 600 s email at `alertEngine`.
- **Severity:** `critical` (watchlist). **Log** every confirmed visit; **alert**
  once per visit.

### 5.2 Face — unknown person
- **Entity key:** collapses to a single `unknown` token **per camera** (never per
  face, never per track).
- **Gate:** *dwell*, not mere presence — an unknown must **linger ≥ 180 s** to
  matter, and by default **only after business hours** (daytime unknowns at open
  areas are visitors → the single biggest historic flood source, so
  `ALERT_STRANGER_AFTER_HOURS_ONLY = 1`). Daytime unknowns *are* alertable in
  explicitly-named **secure zones** only.
- **Severity:** `warning` (after-hours) / `critical` (secure zone).

### 5.3 Restricted zone — intrusion
- **Entity key:** `(track_id × zone_id)` state machine (`services/zone_intrusion.py`,
  spec in [`RESTRICTED_ZONE_DETECTION.md`](RESTRICTED_ZONE_DETECTION.md)).
- **Confirm (M1):** inside **5 of last 8** frames. **Exit (M2):** outside ~1.5 s.
- **Gate:** `dwell_met ∧ unauthorized ∧ armed`. Authorized = matches a known
  identity whose group ∈ zone's allow-list (`vms.cam.state`).
- **Cooldown (M3):** 60 s per track; plus a per-zone rate cap.
- **Severity:** `critical`. Canonical example of "L3 emits at-most state-transition
  events, never per-frame events."

### 5.4 Crowd — stampede / crush
- **Entity key:** the **camera** (crowd is a scene property, not a person).
- **Confirm (M1) + hysteresis (M2):** **rising-edge into `min_level` (HIGH)** with a
  fusion score (CSRNet density + optical-flow speed/accel/divergence/KE). A single
  spiking frame does not fire — the level must *rise into and hold* the band.
- **Cooldown (M3):** 30 s per camera (rising-edge only; a sustained CRITICAL does
  **not** re-fire every frame).
- **Severity:** `HIGH → warning`, `CRITICAL → critical`. **Log** every level change;
  **alert** on rising edge into HIGH+.

### 5.5 Occupancy / headcount
- **Entity key:** the **camera / zone** count.
- **Confirm (M1):** count must hold **≥ threshold for K consecutive polls** (not one
  noisy frame). **Hysteresis (M2):** clear only when it drops a margin *below*
  threshold (e.g. alert at 50, clear at 45) — never alert on the boundary
  oscillating 49↔50.
- **Severity:** `warning`. Log the crossing; alert once per sustained breach.

### 5.6 Attendance / activity
- **Entity key:** the recognised identity.
- **Confirm (M1):** visit must have **≥ 3 detections** (`RECOGNITION_MIN_DETECTIONS`)
  and best match **≥ 0.5** (`RECOGNITION_MIN_SIMILARITY`).
- **Session debounce (M2):** off-camera **< 1 h = same visit**; a mid-visit silence
  **≥ 15 min = "stepped out"** (excluded from on-site time). This is the layer that
  produced the 203:1 collapse.
- **Alert:** one per identity per visit (UNIQUE `dedup_key`).

---

## 6. Gap analysis — where the code still violates the doctrine

*Prioritised. These are the remaining flood-risk / correctness gaps as of
2026-07-28. Fix in order.*

| # | Gap | Where | Symptom | Fix |
|---|-----|-------|---------|-----|
| **G1** | Cooldown lives at **two** layers with different keys (AI forwarder keys on `(user,cam,kind,subject)`; `alertEngine` re-derives `subjectFor`). If the AI forwarder ever sends `track_id` as subject, the 120 s dedup breaks even though `alertEngine` is safe. | `alert_backend_forwarder.py` ↔ `alertEngine.subjectFor` | duplicate rows within 120 s if AI subject is volatile | Make the AI forwarder's subject **identity-only** (never `track_id`); assert it in a test. `alertEngine` is already correct. |
| **G2** | Occupancy/headcount alerts have **no hysteresis** — a count oscillating on the threshold re-alerts. | headcount path | flapping alerts at exactly the threshold | Add alert-at-N / clear-at-(N−margin) + K-consecutive-poll confirm (M1/M2). |
| **G3** | Stampede webhook has a per-camera **30 s cooldown in the detector**, but the backend endpoint doesn't *also* enforce M3/M4 — a misconfigured detector could still burst. | `internal.routes.js /stampede-alert` → `alertEngine.maybeAlert` | detector bug → flood | Already routed through `alertEngine.maybeAlert` (inherits M3/M4). ✅ Verify `categoryOf('crowd.stampede') = 'crowd'` shares the crowd cooldown bucket. |
| **G4** | `titleFor`/`categoryOf` don't special-case `crowd.stampede` → shows generic "Crowd threshold". | `alertEngine.titleFor` | vague alert text | Add `if (t.includes('stampede')) return '🔴 Stampede risk'`. Cosmetic, do with G3. |
| **G5** | No **global per-user alert digest / quiet-hours** for `warning` (only `critical` should ever wake someone at 3am). | `alertEngine.maybeAlert` (hook exists, unused) | night-time warning noise | Wire the `afterHours` hook to gate `warning` (never `critical`) per user schedule. |

---

## 7. Tuning checklist for a new camera (operational)

1. **Classify the camera:** eye-level entry (recognition-grade, run continuous) /
   overhead (count-only) / quiet corridor (motion-gated).
2. **Set the entity gate** to the camera's traffic: busy gate → higher `min_hits`
   and longer visit gap; quiet secure door → lower dwell, secure-zone alerting on.
3. **Watch `/activity/metrics` (or Reports) for a day** *before* enabling alerts —
   confirm the dedup ratio is > ~50:1 and recognition rate is sane.
4. **Enable alerts last**, warning-tier first, escalate to critical only for
   watchlist / secure zones.
5. **Never** enable "record-all" or continuous AI on more than ~6 cameras against a
   single NVR (hard rule — the NVR-flood incident, 2026-07-06).

---

## 8. The one rule to remember

> **Detect continuously. Log transitions. Alert on the gated subset — keyed on
> identity, debounced on both edges, capped in aggregate.** If a person barely
> moves, nothing changed state, so nothing is logged and nobody is alerted.

---

*Sources — industry practice on temporal confirmation / dwell / false-alarm
reduction:*
- [Pelco — False Alarm Filtering (2026)][pelco]
- [Lumana — How AI video analytics cut false alarms up to 90%][lumana]
- [Actuate — reduce false positives 95%+][actuate]
- [Fora Soft — Tuning Analytics: false alarms, accuracy & the operator][fora]

[pelco]: https://www.pelco.com/blog/false-alarm-filtering
[lumana]: https://www.lumana.ai/blog/how-ai-powered-video-analytics-cut-false-alarms-by-up-to-90
[actuate]: https://actuate.ai/
[fora]: https://www.forasoft.com/learn/video-surveillance/articles-vms/tuning-analytics-false-alarms-accuracy

*Internal cross-refs: [`RESTRICTED_ZONE_DETECTION.md`](RESTRICTED_ZONE_DETECTION.md),
`activity-monitor/docs/ATTENDANCE_ALERTS.md`, `smart-cam-backend/src/services/alertEngine.js`.*
</content>
</invoke>
