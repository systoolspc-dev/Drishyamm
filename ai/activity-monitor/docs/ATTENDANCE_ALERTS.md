# Attendance & Alerts — Detection · Logging · Alerting

Recognition-driven **attendance** (who came, when, how long) and a policy-gated
**alert** layer, built on top of vms_face's persisted face recognition. This is a
separate concern from the posture/phone activity monitor in the main
[README](../README.md) — it runs in the **same service** but needs **no camera
pull of its own**: it reads vms_face's `detection_events` and writes attendance +
alerts to the local SQLite store, surfaced in the console's **Attendance Report**.

> **Design brief:** the recogniser fires ~20×/sec; almost none of it is an event.
> We never log detections — we log **debounced state transitions of a tracked
> identity**, and alert on a small, policy-gated subset. See the shareable
> case-study doc "Detection, Logging & Alerting Policy" for the full rationale.

---

## The funnel (noise → signal)

```
Detection   per frame     vms_face SCRFD+ArcFace (GPU)      ~40k/hr/person   ephemeral
   ↓ track                one track id per visit
   ↓ session   debounce   recognition_sync clusters into    1–3 visits/day   ← the fix
              (gap 1h)    visits; sub-gaps ≥15m = "away"
   ↓ event     gates      confident (≥0.5) + repeated (≥3)   2–6 events/day   STORED
              directional IN/OUT at the door camera
   ↓ alert     policy     watchlist / stranger / after-hrs   0–2 alerts/day   NOTIFIED
              cooldown    one per identity per visit
```

Measured collapse on a real day (2026-07-10): **47,298 detections → 233 events =
203:1 dedup ratio.**

---

## Architecture / components

All under `src/activity_monitor/`:

| File | Responsibility |
|------|----------------|
| **`recognition_sync.py`** | The heart. Polls `detection_events` (AI Postgres) every 20s, clusters each person's detections into **visit sessions**, applies the gates, logs directional IN/OUT crossings + per-person attendance to the store. Also computes `metrics()`. |
| **`alert_policy.py`** | Evaluates sessions + unknown-face dwell against **watchlist / after-hours / stranger** policies; records each alert once per session (UNIQUE `dedup_key` = the cooldown). |
| **`store.py`** | SQLite persistence: `attendance`, `crossings`, `alerts` (+ the older activity tables). WAL mode. |
| **`attendance.py`** | `AttendanceWatcher` — legacy face-box line-crossing (kept for non-recognition cameras) + `summary()` (reads the store). `record_crossing()` bridges body-tracker crossings. |
| **`manager.py`** | Wires everything; exposes `attendance/alerts/health_metrics/reset` to the API. |
| **`api.py`** | FastAPI routes (see below). |
| **`crossing.py`** | `LineCrosser` (feet-point vs line) — used only by the dormant body-tracker path. |

Nothing here pulls RTSP: `config/config.docker.yaml` has `streams: []`. Attendance
is 100% built from vms_face's persisted recognition.

---

## Configuration (env vars)

Set in `docker-compose.drisyam-original.yml` under the `activity-monitor` service.

### Recognition → attendance (`recognition_sync.py`)
| Var | Default | Meaning |
|-----|---------|---------|
| `RECOGNITION_PG_DSN` | `postgresql://vms:vms@drisyam-original-ai-postgres:5432/vms_face` | vms_face's Postgres (read-only). |
| `RECOGNITION_SYNC_SEC` | `20` | Poll interval. |
| `RECOGNITION_CAMERAS` | *(empty = all)* | Restrict to specific vms_face camera UUIDs. |
| `RECOGNITION_SESSION_GAP_SEC` | `3600` | **Visit debounce.** Off-camera < this = same visit; ≥ this = a real new entry. |
| `RECOGNITION_MIN_DETECTIONS` | `3` | **Robustness gate.** A visit must be seen ≥ this to log — a one-frame sighting is never an arrival. |
| `RECOGNITION_MIN_SIMILARITY` | `0.5` | **Confidence gate.** A visit's best face match must clear this cosine score. |
| `RECOGNITION_ENTRY_CAMERAS` | *(empty)* | **Directional in/out.** Camera codes that are the door/gate/reception → IN at first door sighting, OUT at last; else presence-based. |
| `RECOGNITION_BREAK_GAP_SEC` | `900` | **Stepped-out.** A mid-visit silence ≥ this = "away", excluded from time on-site. |
| `RECOGNITION_MIN_SESSION_SEC` | `0` | Drop visits with less on-site time than this (flicker). |

### Alert policy (`alert_policy.py`)
| Var | Default | Meaning |
|-----|---------|---------|
| `ALERTS_ENABLED` | `1` | Master switch. |
| `ALERT_BUSINESS_HOURS` | `07:00-21:00` | IST. Presence outside → after-hours warning. |
| `ALERT_WATCHLIST` | *(empty)* | CSV of names (case-insensitive) → **critical** when seen. |
| `ALERT_STRANGER_DWELL_SEC` | `180` | Unknown face lingering ≥ this → stranger alert. |
| `ALERT_STRANGER_AFTER_HOURS_ONLY` | `1` | Daytime open-area unknowns are visitors — skip (kills the flood). |
| `ALERT_STRANGER_ZONES` | *(empty)* | Camera codes where a **daytime** stranger IS an alert (secure areas) → fires **critical**. |
| `ALERT_STRANGER_GAP_SEC` | `60` | Gap that splits unknown-dwell clusters. |

---

## API

Served by the activity-monitor (`:8000`, host `:8010`); proxied by the backend at
`/api/ai/activity/*` (JWT-authed). All times IST.

| Endpoint | Returns |
|----------|---------|
| `GET /activity/attendance` | Per-person today: name, first entry, in/out counts, on-site time, currently inside. |
| `GET /activity/crossings?limit&date` | The full in/out feed (each tagged with its camera + on-site duration). |
| `GET /activity/alerts?limit&date&tier` | Policy alerts + today's tier counts. |
| `POST /activity/alerts/:id/ack` · `/alerts/clear` | Acknowledge / clear. |
| `GET /activity/metrics?date` | Funnel health: dedup ratio, recognition rate per camera, session sanity, alert counts. |
| `POST /activity/attendance/reset` | Clear attendance + crossings **and** the sync's feed dedup (so it rebuilds). |

Frontend: `smart-cam-app/src/pages/AttendanceReport.jsx` (route `/attendance-report`,
nav under AI Intelligence). Shows the alerts panel, filters (name/date/direction/camera),
per-person table (on-site + away), the in/out feed, and the Funnel-health strip.

---

## Data model (`store.py`)

- **`attendance`** `(date, name)` — camera, first_entry_ts, last_event_ts, in_count,
  out_count, total_inside_sec *(on-site, breaks excluded)*, currently_inside, current_entered_at.
- **`crossings`** — person_key, name, `stream` *(camera code)*, direction, ts, date,
  duration_sec *(on-site time on an OUT)*.
- **`alerts`** — tier, type, subject, camera, detail, `dedup_key` *(UNIQUE → the cooldown)*, acknowledged.

---

## Operations

```bash
# Rebuild after a CODE change (src is baked into the image):
docker compose -p drisyam-original -f docker-compose.drisyam-original.yml build activity-monitor
docker compose -p drisyam-original -f docker-compose.drisyam-original.yml up -d --no-deps --force-recreate activity-monitor

# Config/env change only → just recreate (config is bind-mounted).
# Clear + rebuild the day's attendance/feed from detection_events:
curl -X POST http://localhost:8010/activity/attendance/reset
# Clear alerts:
curl -X POST http://localhost:8010/activity/alerts/clear
```
> **Gotcha:** clear alerts/attendance only when the container is up and healthy — a
> reset during a crash-loop leaves stale rows. The reset now also clears the sync's
> in-memory feed dedup, so crossings actually rebuild.

**Tuning a new camera:** classify it (eye-level entry = recognition-grade, continuous;
overhead = count-only; quiet = motion-gated) → enrol faces from its angle → set the
visit gap to the traffic → watch `/activity/metrics` for a day → enable alerts last.

---

## Measured results (2026-07-10, live)

- **Dedup ratio 203:1** (47,298 detections → 233 events).
- **Confidence gate** dropped 1/31 low-confidence misrecognitions (kept 30).
- **Robustness gate** filtered 2 flimsy 1–2-frame phantom arrivals (of 44 people).
- **Per-camera recognition** (placement is policy): Gate2 70%, CP IP Cam 60%,
  Recp 39%, "12 - Camera 02" **5%** (overhead → count-only).
- **Break tracking**: a live visit read **on-site 187m / away 62m**, not one flat "inside all day".
- **Alert cooldown**: a watchlisted person seen in 2 visits → exactly 2 critical alerts.

---

## Changelog

- **Attendance pivot** — abandoned line-crossing over a body tracker (choppy H.265 →
  track fragmentation → phantom "Unknown" entries). Attendance now reads vms_face's
  persisted recognition sessions.
- **Per-camera in/out** — each crossing tagged with its camera; report filters by camera.
- **Alert layer** — watchlist / stranger / after-hours, 3 tiers, one-per-visit cooldown;
  secure-zone scoping.
- **Health metrics** — dedup ratio, recognition rate, session sanity; date-parameterised.
- **When-to-log gates** — min-detections (robustness), min-similarity (confidence),
  directional door in/out, break/stepped-out (on-site vs away).
- **Removed the redundant camera pull** — the service no longer touches any NVR
  (attendance is DB-driven), reducing reconnect load.

## Known limitations / remaining

- **Recognition quality depends on camera angle** — overhead cameras recognise poorly
  (name from an eye-level entry camera; use overhead ones for counting). Enrol faces
  from the mounted angle to lift confidence.
- **Historical session-sanity** reflects the gap active when a past day was synced
  (only today is rebuilt); dedup/recognition are detection-based so accurate historically.
- **Blocked / not done:** critical-alert → phone push (needs the paused mobile build);
  a K-of-N temporal identity vote (lives in the core vms_face engine).
