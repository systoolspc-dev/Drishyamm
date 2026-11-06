# Restricted Zone — Detection & Alert Logic (industry-grounded spec)

> Loop research, iteration 1 · 2026-07-25
> Problem owner: Anil · Target: Sharda POC + product-wide feature
>
> **The question being answered:** *"Every time you detect, if a person slightly moves
> and you detect again, that's not right. On what level do we detect, when to detect,
> when to log, when to alert — like a real industry system?"*

---

## 1. The problem, stated precisely

A naive detector runs person-detection **per frame** and fires an event whenever a box
overlaps the zone. At 12–15 fps a single person standing near the boundary generates
**hundreds of "detections" per minute**, and every micro-movement (a step, a sway, the
box jittering by 3px) looks like a "new" detection. That produces:

- **Alert spam** — the operator gets 200 notifications for one intruder and stops trusting the system.
- **No incident model** — there is no notion of *"one person entered once and stayed 4 minutes."*
- **No audit truth** — you cannot answer *"who was in the server room last night and for how long."*

Real industry systems (Axis Object Analytics, Avigilon Appearance Search / Unusual Activity,
Hikvision AcuSense line-crossing/intrusion, BriefCam, Verkada) **never alert on raw detections.**
They alert on **tracked objects that satisfy a temporal + spatial + identity policy**, and they
emit **exactly one alert per intrusion incident.**

The rule of thumb the whole design rests on:

> **Detect every frame. Decide on tracks. Alert on incidents.**

---

## 2. The three levels (this is the "on what level do we detect" answer)

| Level | Runs at | Unit | Purpose | Our module |
|------|---------|------|---------|-----------|
| **L1 Detection** | every frame (12–15 fps) | bounding box | "there is a person at (x,y) this frame" | `infra/person_detector.py` |
| **L2 Tracking** | every frame, stateful | **track_id** (one per real person) | "box in frame N = box in frame N-1 = *the same person*" | `services/face_tracker.py` (+ IoU/Kalman for body) |
| **L3 Zone incident** | per (track_id × zone), stateful | **incident** | "track T was inside zone Z, unauthorized, for ≥ dwell → one alert" | **NEW: `services/zone_intrusion.py`** |

The bug the user described lives entirely at the missing **L3**. Today the pipeline has L1 + L2
+ zone **geometry** (`detection_zones.py`) but **no per-track incident state machine** — so it
re-reports. L3 is what we build.

---

## 3. The detection ladder (what happens to one frame)

```
frame ─▶ L1 person_detector ─▶ boxes[]
                 │
                 ▼
        L2 tracker.update(boxes) ─▶ tracks[] each with {track_id, box, feet_point, age}
                 │
                 ▼
   for each armed zone Z on this camera:
        for each track T:
            inside = detection_zones.is_point_inside_zone(T.feet_point, Z)   # feet, not centroid
            L3 zone_intrusion.step(T, Z, inside, now, identity(T))
                 │
                 ▼
        L3 emits AT MOST state-transition events, never per-frame events
```

Two spatial details that already matter and must be kept:

- **Use the feet point, not the centroid.** A person is "in" a floor zone when their feet are
  in it. `detection_zones.py` already computes the feet-point (bottom-centre of the person box).
  Centroid-in-polygon makes tall people trigger from outside the line.
- **Normalized coordinates (0..1).** Zones are stored normalized so the same zone works across
  main/sub stream resolutions. The frontend already saves normalized polygons/rects.

---

## 4. L3 — the per-(track × zone) state machine  ← the core of the fix

Each (track_id, zone_id) pair owns one small state machine. This is the single mechanism that
converts a stream of noisy per-frame "inside/outside" booleans into clean incidents.

```
                 inside K of last N frames
   ┌────────┐  ───────────────────────────▶ ┌──────────┐  dwell_met & !authorized & armed  ┌─────────┐
   │ OUTSIDE│                                │ INSIDE   │ ────────────────────────────────▶ │ ALERTED │
   │        │ ◀───────────────────────────── │(dwelling)│                                    │         │
   └────────┘   outside M consecutive frames └──────────┘ ◀──────────────┐                   └─────────┘
        ▲            (exit debounce)              │  authorized identity   │  still inside          │
        │                                         │  confirmed → SUPPRESS  │  (no re-alert:         │
        │                                         ▼                        │   cooldown holds)      │
        └───────────────── track lost > T_lost ──┴────────────────────────┴────────────────────────┘
```

**States**

- `OUTSIDE` — track exists but feet not in zone (or not yet confirmed inside).
- `INSIDE` — confirmed inside, dwell timer running, **not yet alerted**.
- `ALERTED` — one alert already emitted for this incident; **will not alert again** until the
  track leaves and re-enters (or cooldown + re-entry).
- `SUPPRESSED` — track matched an **authorized identity** for this zone → no alert, but still logged.

**Transitions & the temporal filters (each one kills a class of false alert):**

| Filter | Default | Kills | Rationale (industry) |
|--------|---------|-------|----------------------|
| **Entry confirm — K of N** | inside **5 of last 8** frames | boundary jitter, box flicker, a hand crossing the line | Axis/Avigilon require the object be *classified and stable* before counting. K-of-N is the cheap, robust version. |
| **Dwell (loiter) time** | **≥ 3–5 s inside** before alert | someone walking *through* / glancing in; a corridor pass-by | Hikvision "region entrance" vs "loitering": most campus zones want loiter, not touch. Tunable per zone (0 = instant for hard zones like an armory). |
| **Exit debounce (hysteresis)** | leave only after **outside ~1.5 s (M consec frames)** | a person straddling the line toggling in/out, occlusion blips | Prevents the incident from closing+reopening → which would double-alert. |
| **Track-lost grace** | keep incident **open 2–3 s** after track disappears | brief occlusion (pillar, another person) re-acquires as *same* incident | Tracker gap-fill; avoids "left + re-entered" false re-alert. |
| **Per-track cooldown** | **60 s** after an alert on a track | the same confirmed intruder re-alerting while still loitering | "One alert per object per cooldown." |
| **Per-zone rate cap** | **max 1 alert / 10 s / zone** (crowd guard) | a group of 8 people entering at once → 8 simultaneous alerts | Verkada/BriefCam cap zone alert rate and instead raise **one "N people entered"** event. |

> **This table is the whole answer to "when to detect vs when to alert."**
> Detection is continuous (L1/L2). An **alert** only fires when: `state INSIDE → dwell_met →
> unauthorized → armed-now → not-in-cooldown → under zone-rate-cap`. Everything else is either
> ignored or written to the audit log only.

---

## 5. Authorized-identity exception (face fusion)

The zone policy carries `allowed: [Staff, Security, ...]`. When the tracker's face embedding
matches a known identity (`vms.cam.state` / `track_attributes`) whose group ∈ allowed:

- transition to **SUPPRESSED** (no alert),
- **still write an audit-log entry** (`entry, authorized=true, identity=…`) — because "who went
  into the server room and when" is exactly what a campus wants, even for authorized staff.

Identity match is **best-effort and late-binding**: a person may enter before their face is
resolved. Policy: hold the alert for a short **grace (≤ 2 s)** to let identity resolve; if it
resolves to allowed → cancel; else → alert. This avoids flashing an alert on the CISO walking
into their own server room.

---

## 6. Arming / schedule gate

`armed` is evaluated **before** any alert (never suppress logging, only alerting):

- `always` → always armed.
- `after_hours` (21:00–06:00), `work_hours` (09:00–18:00), `custom {from,to}` — wall-clock in the
  site's timezone, with **overnight window** handling (`from > to` means it wraps midnight).
- A disarmed zone still **detects and logs** (so you get the audit trail) but raises **no alert**.

---

## 7. LOG vs ALERT — the distinction (explicit)

Two separate sinks. This is what makes it "real industry."

| | **Audit log** (`zone_events`) | **Alert** (notification) |
|---|---|---|
| Written when | every **confirmed** incident transition (enter / leave), authorized or not | only unauthorized + dwell-met + armed + not-cooling-down |
| Volume | one row per incident (not per frame) | ≪ audit; the exceptions only |
| Consumer | timeline, "who was where," compliance export | operator toast, mobile push, bell |
| Retention | long (compliance) | short / ack-able |

So a night with 40 staff entries + 1 intruder = **41 audit rows, 1 alert.** That is the shape a
security team trusts.

---

## 8. Event schema (on the bus + persisted)

Emit on `redis_bus` topic `vms.zone` (backend forwarder → `/ai/events` → alertEngine, same path
as `vms.alerts` today):

```jsonc
{
  "type": "zone.incident",
  "event": "enter" | "leave" | "alert",      // 'alert' is the escalation of an 'enter'
  "camera": "524",
  "zone_id": "rz_1737...",
  "zone_name": "Server Room",
  "track_id": 8813,
  "incident_id": "inc_524_rz_..._8813_1737",  // stable across the incident → dedupe key
  "ts_enter": 1737969000.12,
  "ts": 1737969005.44,
  "dwell_s": 5.3,
  "authorized": false,
  "identity": { "person_id": null, "name": null, "group": null },
  "priority": "high",
  "snapshot_key": "s3://.../inc_...jpg",       // one crop at alert time
  "bbox": [x,y,w,h]                            // normalized
}
```

`incident_id` is the **idempotency key**: the backend/alertEngine dedupes on it, so even if the
AI re-sends, one incident = one alert row. (We already learned this lesson with the ai_events
flood — ephemeral overlay vs persisted; here the persisted sink is incident-level, not frame-level.)

---

## 9. Tunable parameters — defaults + where they live

Per-zone (stored in the zone policy the frontend already collects), with system fallbacks:

```python
ZONE_DEFAULTS = {
    "confirm_k": 5, "confirm_n": 8,     # entry stability
    "dwell_s": 4.0,                      # 0 for instant/hard zones
    "exit_debounce_s": 1.5,
    "track_lost_grace_s": 2.5,
    "alert_cooldown_s": 60,
    "zone_rate_cap_s": 10,              # crowd guard
    "identity_grace_s": 2.0,
}
```

The frontend currently exposes **dwell** (Instant/3/5/10/30 s) and **priority/schedule/allowed** —
that's the right operator-facing subset. The rest are engineering defaults (advanced panel later).

---

## 10. Real campus case studies (param presets → this is the "case study" deliverable)

Each is a real Sharda-type scenario with the preset that makes it behave correctly:

1. **Exam Hall — no unauthorized entry during exam**
   `armed: custom (exam window)`, `dwell_s: 0` (instant — any entry matters), `allowed: [Faculty, Invigilators]`,
   `priority: high`. Use case: catch a phone-runner or an outsider the moment they step in.

2. **Server / Network Room — 24×7, staff-only**
   `armed: always`, `dwell_s: 3`, `allowed: [IT Staff, Security]`, identity-fusion ON, `priority: critical`.
   Audit every authorized entry (compliance); alert on anyone else.

3. **Chemistry / Research Lab — after-hours only**
   `armed: after_hours`, `dwell_s: 5`, `allowed: [Faculty]`, `priority: high`. Daytime = detect+log only,
   night = alert. Kills the "alerts all day while class is on" problem.

4. **Girls' Hostel perimeter / entrance — directional**
   line-crossing variant (`detection_zones` line + direction), `dwell_s: 0`, `armed: after_hours`,
   `priority: critical`. Alert on inbound crossing after curfew; log outbound.

5. **Store / Armory / Cash room — hard zone**
   `armed: always`, `dwell_s: 0`, `allowed: []` (nobody), `zone_rate_cap` low, `priority: critical`.
   Any human presence = immediate alert.

6. **Parking / loading bay after-hours — loiter detection**
   `armed: after_hours`, `dwell_s: 30` (loitering, not passing through), `priority: medium`.
   Someone walking to their car ≠ alert; someone hanging around a car for 30 s = alert.

The **dwell knob is the single most important operator control** — it's the dial between
"any touch matters" (0 s, hard zones) and "only loitering matters" (30 s, open areas).

---

## 11. Edge cases & how the state machine survives them

- **Occlusion / ID switch** — track-lost grace + incident held open; if the tracker assigns a new
  id to the same person, the K-of-N re-confirm + cooldown-by-position (fallback dedupe on
  overlapping bbox within cooldown) prevents a double alert.
- **Crowd rush** — zone-rate-cap collapses N simultaneous entries into one "N entered" alert +
  N audit rows.
- **Camera shake / lighting** — K-of-N entry confirm + feet-point + exit debounce absorb the jitter.
- **Person standing exactly on the line** — hysteresis (enter needs K-of-N inside, leave needs M
  consecutive outside) stops the toggle.
- **Reflections / posters of people** — L1 confidence floor + the tracker's motion requirement
  (a static false box never accrues the movement a real track does).

---

## 12. Mapping to our stack (implementation plan)

| Piece | File | Change |
|------|------|--------|
| Person boxes | `infra/person_detector.py` | already emits boxes — ensure person class enabled per-camera when a zone exists |
| Track ids | `services/face_tracker.py` | reuse; add body-IoU fallback track id when no face (a body in a zone may have no visible face) |
| Zone geometry | `services/detection_zones.py` | reuse `is_point_inside_zone`, feet-point; add **line + direction** for tripwire zones |
| **L3 state machine** | **`services/zone_intrusion.py` (NEW)** | the section-4 FSM + section-9 params; pure/testable |
| State store | `infra/detection_state.py` | hold per-(track,zone) FSM state |
| Emit | `infra/redis_bus.py` | publish `vms.zone` incidents (section-8 schema) |
| Forward | backend `aiEvents` forwarder + `alertEngine.js` | consume `vms.zone`, dedupe on `incident_id`, route to notify/push (reuse the alert→mobile push pipeline already live) |
| Config source | zone policy JSON from frontend | move zones from localStorage → backend `PUT /ai/cameras/:id/zones`, AI reads them per camera |

**Order of build:** (a) `zone_intrusion.py` + unit tests with synthetic inside/outside sequences
(prove one incident = one alert, dwell honored, cooldown honored) → (b) wire into orchestrator →
(c) `vms.zone` → alertEngine dedupe → (d) persist zones backend-side + AI fetch → (e) frontend
Alerts tab consumes real incidents.

---

## 13. Acceptance metrics (how we know it's "real")

- **≤ 1 alert per real intrusion incident** (not per frame / per micro-move) — the headline fix.
- **False-alert rate < 1 / camera / day** on a normally-occupied campus (industry-acceptable band).
- **Audit completeness:** every confirmed entry (authorized or not) has exactly one row with a
  correct dwell time.
- **Latency:** alert within `dwell_s + ~1 s` of the dwell threshold being met.
- **No missed intrusion** at `dwell_s=0` hard zones within 1 s of a confirmed entry.

---

## 14. Open questions for next loop iterations

- Body tracker choice when face is absent (ByteTrack/OC-SORT vs simple IoU+Kalman) — cost vs accuracy on Blackwell/L4.
- Directional tripwire semantics (in vs out) UI in the Define tab.
- "N people entered" aggregate alert copy + how it renders in the Alerts tab.
- Backend zone persistence endpoint + schema (replace localStorage).
- Do we run L3 on the full-fps stream or a decimated 5 fps analytics tap? (dwell math is fps-independent if we use wall-clock, so a 5 fps tap likely suffices → big GPU saving at 2k cameras).
```
