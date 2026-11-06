# School Activity Monitoring — Context Pack for Head-Count Model Integration

> Paste this whole file into another AI as context. It describes the **current, real state**
> of the School (K-12) vertical in the `drishyam-app` repo (branch `ASTHA_activity_monitoring`),
> what is already implemented, what head-count-shaped data already exists as mocks,
> what school use cases are still missing, and the **merge-vs-new-page decision** for
> wiring in a person/head-count detection model.
>
> Companion file: `PROJECT_CONTEXT.md` (full repo/stack/architecture primer). Read that
> first if the model needs to generate code.

---

## 0. TL;DR — the question being decided

We have a **ready person head-count model** (anonymous people counting per camera/zone).
We need to decide, for the School vertical:

1. Which head-count capabilities can be **merged into existing school pages** (extend a
   panel / add a card / add a column), and
2. Which ones justify **a brand-new page** under `/activity-monitoring/school/*`.

Short answer we currently lean toward:
- **Merge** into: dashboard KPIs, Class/Room Analytics, Transport, Dismissal, Visitors,
  Safety & Security, Reports, Rules & Policies.
- **New pages** (2): **Occupancy & Headcount** (school-wide live zone occupancy) and
  **Assembly / Evacuation Muster** (drill + emergency roll-call by count).
  Rationale in §7.

---

## 1. Repo essentials (minimum the other model needs)

| Thing | Value |
|---|---|
| Stack | React 19 + Vite 7, **plain JS/JSX (no TypeScript)**, Tailwind v4, shadcn/ui, lucide-react, recharts, zustand |
| Alias | `@/` → `src/` |
| Brand primary | `#F7983A` (school pages use it everywhere) |
| State of these screens | **FRONTEND-ONLY.** All Activity Monitoring pages render mock data from sibling `data.js` / `pages-data.js`. No fetch calls. Backend endpoints are only named in comments (`// Future backend: GET /school/...`). Any new page must follow the same pattern. |
| Fast Refresh rule | `.jsx` files export **components only**. Constants / chip maps / helpers go in `.js` modules. Enforced repeatedly in comments. |

### Three-layer architecture
```
src/
├── core/        Layer 1 — base VMS (live view, playback, cameras, players, services)
├── modules/     Layer 2 — AI capabilities, written ONCE
│   └── employee-productivity/   ← Activity Monitoring lives here, one folder per vertical
├── use-cases/   Layer 3 — product catalog: which modules + what parameters per vertical
└── ai-analytics/  separate self-contained analytics sub-app (own CSS scope)
```

**Golden rule:** module code is written once; verticals only change parameters. In practice
verticals with different domain shapes get their own subfolder of pages, but they share the
shell components, chart tokens and card language.

### Adding a page — exactly 3 touch points
1. Create the component under `src/modules/employee-productivity/school/`.
2. `lazy()` import + `<Route>` in `src/App.jsx`.
3. Child entry in `NAV_GROUPS` in `src/core/layout/Sidebar.jsx` with `needsParam: 'school'`.
4. *(4th, school-specific)* add a tile to `school/components/SchoolModules.jsx` so it is
   reachable from the dashboard launcher grid too.

### Shared building blocks — import, don't re-create
```js
import Panel from '../campus/components/Panel';               // level-2 white card w/ icon header
import SectionCard from '../campus/components/SectionCard';   // collapsible section w/ eye toggle
import { AXIS, GRID, TIP } from '../campus/components/profileConstants'; // recharts tokens
import { Tile, TimelineList, AlertCards } from '../campus/components/profileBits';
import { Chip } from './components/bits';                     // school status chip
```

---

## 2. The School vertical as it exists today

### 2.1 Preset — `src/use-cases/school/index.js`
```js
export default {
  key: 'school', label: 'School',
  modules: ['employee-productivity', 'face', 'alerts', 'ai-feed'],
  params: { 'employee-productivity': {
    ...productivityDefaults,
    businessHours: '08:00-15:00',
    lateAfter: '08:15',
    breakGapSec: 900,
    school:    { presenceWindowSec: 120, attendanceTarget: 90 },
    safety:    { restrictedZones: ['Gate','Rooftop','Pool','Lab Store'], unattendedChildSec: 120 },
    transport: { buses: 12, boardingWindowMin: 20 },
  }},
}
```
The **presence of the `school` block gates every school page** (`needsParam: 'school'` in
the sidebar). Any new head-count knobs belong here as a new sub-block (see §8).

### 2.2 Files — `src/modules/employee-productivity/school/`
```
SchoolDashboard.jsx          landing page (UseCaseSwitcher + header + module tiles + filter bar + 4 sections)
AttendanceIntelligence.jsx   /activity-monitoring/school/attendance
SafetySecurity.jsx           /activity-monitoring/school/safety
Transport.jsx                /activity-monitoring/school/transport
Dismissal.jsx                /activity-monitoring/school/dismissal
GuardianRegistry.jsx         /activity-monitoring/school/guardians   (largest page, 373 lines, full CRUD)
VisitorManagement.jsx        /activity-monitoring/school/visitors
StudentActivity.jsx          /activity-monitoring/school/student      (single-student profile, 5 tabs)
ClassRoomAnalytics.jsx       /activity-monitoring/school/rooms
Reports.jsx                  /activity-monitoring/school/reports
RulesPolicies.jsx            /activity-monitoring/school/rules
data.js                      dashboard mock data (hierarchy, KPIs, feeds, charts)
pages-data.js                per-subpage mock data (ATT_*, SAF_*, TR_*, DIS_*, VIS_*, STUDENT*, CLASS_*, SCH_*, GUARDIANS, TEMP_PASSES, PASS_AUDIT, UNKNOWN_PICKUPS, STATUS_CHIP)
rules-data.js                SCHOOL_RULES for the shared rules engine
components/                  SchoolHeader, SchoolFilterBar, SchoolModules, KeyMetrics,
                             ActivityInsights, LiveOverview, SafetyAnalytics,
                             QuickActionsFooter, bits.jsx
```
Total ≈ 2,600 lines. All 10 subpages are routed in `src/App.jsx` (lines ~236–245) and listed
in `Sidebar.jsx` (lines ~101–110).

### 2.3 Filter hierarchy (already built, reuse it)
`School → Wing → Grade → Section → Room` + time range
(`live / today / 24h / 7d / 30d / term`), defined in `school/data.js` as `HIERARCHY` and
`TIME_RANGES`, rendered by `components/SchoolFilterBar.jsx`.
Wings: Primary / Middle / Senior / Sports Complex / Admin Block.
Rooms exist for a handful of wing:section keys (`primary:a`, `senior:b`, `sports:ground`, …).

### 2.4 Page-by-page widget inventory

**Dashboard (`SchoolDashboard.jsx`)**
- `KeyMetrics` — 8 KPI cards, each with hover tooltip showing *purpose / formula / backend fields*:
  Students Present 1,486 · Staff Present 112 · Attendance 91.7% · Active Classes 54 ·
  Safety Alerts 3 · Visitors On-Campus 14 · Buses 9/12 · Absentees Flagged 134.
  "Students Present" is interactive → popover with `PRESENT_BY_CATEGORY` (students/teachers/
  support/visitors) and `PRESENT_BY_GRADE` (Primary/Middle/Senior).
- `ActivityInsights` — donut `ACTIVITY_DISTRIBUTION` (In Class 1180, Assembly 90, Labs 96,
  Playground/PE 148, Cafeteria 84, Transit/Corridors 60) + line `ACTIVITY_TREND` by hour.
- `LiveOverview` — `LIVE_FEED` events, `ACTIVE_CLASSES` table (with per-class student count),
  `SAFETY_ALERTS` cards.
- `SafetyAnalytics` — `HOURLY_ACTIVITY` bars, `ATTENDANCE_BY_GRADE` (G1–G12), `GATE_FLOW`
  (in/out per half-hour).
- `QuickActionsFooter` — focus student search, "notify absentee parents" (fake toast).

**Attendance Intelligence** — 6 cards (present/absent/late/leave/%/parents-notified),
Attendance Trend, Late Analysis histogram, Section-wise table, Absentees + notification table.

**Safety & Security** — 6 cards (alerts, restricted-zone entries, unattended-child,
perimeter breaches, visitors flagged, drill compliance), incidents by type, incidents by hour,
active alerts, restricted-zone log.

**Transport** — 6 cards (on-site, en route, students on buses 128, on-time %, delayed,
boarding alerts), arrivals chart, fleet table with `onboard / capacity` per bus.

**Dismissal & Pickup** — 6 cards (dismissed, awaiting pickup, guardians verified,
unauthorized attempts, avg wait, buses boarded), pickup review queue with acknowledge/escalate
actions, pickup flow chart, pickup-mode donut (Bus/Parent/Walk/Carpool), verification log.

**Guardian Registry** — guardian CRUD, "who can pick up" per student, temporary passes with
OTP + window, pass audit trail, unauthorized-pickup list. The richest interaction on the vertical.

**Visitor Management** — 6 cards, purpose donut, check-ins by hour, visitor log.

**Student Activity** — single-student search (+ face-search stub), identity card, 5 metric
cards, tabs: Overview / Attendance / Movement / Timeline / Alerts.

**Class/Room Analytics** — **single-room selector** (only 4 mock rooms), 4 cards
(occupancy / capacity / attendance % / utilization %), occupancy timeline with a capacity
`ReferenceLine`, today's schedule table.

**Reports** — 6 report types (attendance, safety, transport, visitor, dismissal, student),
period selector, recent reports list. All export actions are fake toasts.

**Rules & Policies** — 8 rules over fields `zone / activity / verification / duration /
person type / time` with actions (alert, notify security/principal/teacher/parent, lock gate,
PA announcement, log event).

---

## 3. What the head-count model is (and is not)

**Gives us:** anonymous person count per camera / per zone / per line-crossing, in real time,
plus in-out direction if a line/region is configured. No identity, no name.

**Cannot give us:** who is present, absentee names, guardian verification, per-student
attendance. Those stay on the face/ID pipeline.

**The key product insight:** head count and identity count are two independent measurements
of the same room. Their **delta is itself a safety signal**:

```
headcount(zone)  −  identified_persons(zone)  =  unidentified persons
```
- delta > 0 → someone in the room is not enrolled/recognized (intruder, unbadged visitor,
  camera-angle miss) → escalate.
- delta ≈ 0 → attendance figure is trustworthy.
This "count vs identified reconciliation" widget does not exist anywhere in the app today and
is the single highest-value thing the head-count model unlocks for a school.

---

## 4. Head-count-shaped data that ALREADY exists (as mock) in the school vertical

These are the places where a number is already rendered that a head-count model can *directly*
fill — i.e. **merge candidates, no new page needed**.

| Existing mock export | File | Renders on | What head count would feed |
|---|---|---|---|
| `KPIS.students` / `.staff` / `.visitors` | `data.js` | Dashboard KeyMetrics | live on-campus count (+ reconciliation delta) |
| `PRESENT_BY_CATEGORY`, `PRESENT_BY_GRADE` | `data.js` | KPI popover | count per wing/grade zone |
| `ACTIVITY_DISTRIBUTION` | `data.js` | Activity Insights donut | count per zone type (class/lab/playground/cafeteria/corridor) |
| `ACTIVITY_TREND` | `data.js` | Activity Insights line | count per zone over time |
| `ACTIVE_CLASSES[].students` | `data.js` | Live Overview table | per-room live occupancy |
| `HOURLY_ACTIVITY` | `data.js` | Safety Analytics bars | detections per hour |
| `GATE_FLOW` (`in` / `out`) | `data.js` | Safety Analytics | **pure line-crossing counter — 1:1 fit** |
| `CLASS_ROOMS[].occupancy/.capacity/.utilization` | `pages-data.js` | Room Analytics cards | **pure occupancy — 1:1 fit** |
| `CLASS_OCCUPANCY` | `pages-data.js` | Room Analytics timeline | occupancy timeseries vs capacity line |
| `CLASS_SCHEDULE[].present` | `pages-data.js` | Room Analytics table | count per period |
| `TR_CARDS.students` ("Students on Buses" 128) | `pages-data.js` | Transport | door counter per bus |
| `TR_BUSES[].onboard` | `pages-data.js` | Transport fleet table | boarding/alighting count per bus |
| `DIS_CARDS.dismissed / .awaiting` | `pages-data.js` | Dismissal | count leaving gate / count in holding area |
| `DIS_FLOW` | `pages-data.js` | Dismissal | egress rate per 10 min |
| `VIS_CARDS.oncampus` | `pages-data.js` | Visitors | visitor zone count |
| `SAF_CARDS.drill` ("Drill Compliance 100%") | `pages-data.js` | Safety | **static stat with no page behind it** — see §6 |

Identity-only (head count does **not** replace these): `ATT_*` (present/absent/late by name),
`ATT_ABSENTEES`, `GUARDIANS`, `TEMP_PASSES`, `UNKNOWN_PICKUPS`, `STUDENTS`, `STUDENT_PROFILE`.

---

## 5. Counting infrastructure that already exists elsewhere in the repo

Important — do not rebuild these.

1. **`src/modules/footfall/Footfall.jsx`** — the only **real, backend-wired** counter in the
   app. Per-camera enable/disable, live counters, trend, CSV export, WebRTC live preview with
   MJPEG fallback. Route `/ai-event/footfall`.
   Service surface in `src/core/services/ai.js`:
   ```js
   aiService.footfallCameras()                  // GET  /ai/footfall/cameras
   aiService.footfallTimeseries(params)         // GET  /ai/footfall/timeseries
   aiService.footfallGetConfig(cameraId)        // GET  /ai/footfall/cameras/:id/config
   aiService.footfallPutConfig(cameraId, body)  // PUT  /ai/footfall/cameras/:id/config
   aiService.footfallExportCsvUrl(params)       // CSV export URL
   ```
   Counter state + persistence (`footfall_minute_buckets` in Postgres) lives in the `vms_face`
   AI service; the Node backend proxies at `/api/ai/footfall/*`.
   **This is the most likely place the head-count model already plugs in.** If so, school
   occupancy widgets can become real by mapping `camera → room/zone` and calling
   `footfallTimeseries`, instead of inventing a new API.

2. **`src/ai-analytics/components/CrowdMonitoring/`** + `src/ai-analytics/data/crowdMonitoringData.js`
   — crowd density / `crowdCount` per zone, hourly counts, mock only, in the separate
   ai-analytics sub-app (own CSS scope). Useful as a **visual reference for a density/heatmap
   UI**, but it is not part of Activity Monitoring and shares no components.

3. **`campus/GroupActivity.jsx` + `campus/group-data.js`** — group/cluster detection for the
   University vertical: current groups, average size, largest crowd, duration & size
   histograms, formation timeline, **zone × time heatmap**. The school vertical has **no
   equivalent**. This heatmap component pattern is the closest existing precedent for a
   school-wide occupancy view.

4. `campus/room-data.js`, `campus/live-data.js` — richer room/live models than the school's;
   worth copying shapes from.

---

## 6. Gap analysis — school use cases NOT covered today

Grouped by whether head count alone is enough.

### A. Head-count-only gaps (model is sufficient — highest priority)
1. **School-wide live occupancy** — Room Analytics handles **one room at a time** with 4 mock
   rooms. There is no grid/heatmap of every classroom, lab, hall and corridor at once, no
   "over capacity" flagging, no wing rollup.
2. **Assembly / Evacuation muster** — `SAF_CARDS.drill = 100%` is a dead static number. No
   drill mode, no "expected vs counted per assembly point", no missing-count, no time-to-muster,
   no per-zone sweep-clear status. This is a legally significant K-12 workflow (fire drills).
3. **Cafeteria / canteen occupancy & queue** — `ACTIVITY_DISTRIBUTION` says 84 students in
   cafeteria; nothing else. No capacity, no serving-queue length, no peak-lunch analysis.
4. **Corridor congestion during transitions** — `Transit / Corridors 60` on the donut only.
   No density/crush risk analysis at bell times, no stairwell counts.
5. **Playground / PE zone counts + supervisor presence** — no adult-present check, no
   student-per-supervisor ratio.
6. **Adult-to-child ratio compliance** — nowhere in the app. Head count of adults vs children
   per zone is a direct compliance metric (especially Primary Wing).
7. **Lab / pool / gym max-occupancy safety limits** — `safety.restrictedZones` gates *entry*,
   but there is no *capacity* concept for these zones.
8. **Gate crowd / crush risk at dismissal** — `DIS_FLOW` shows egress rate but no density or
   threshold alerting at the gate.
9. **Bus boarding reconciliation** — `TR_BUSES[].onboard` is static. No boarded-count vs
   manifest check, no "bus departed with wrong count" alert.
10. **Library / study-space occupancy** — campus has it, school does not (school library
    appears only as a row in `ACTIVE_CLASSES`).
11. **After-school / club activity attendance by count** — not modelled at all.
12. **Exam hall occupancy & invigilator presence** — not modelled at all.

### B. Structural gaps that block head-count features
13. **Rules engine has no occupancy field.** `rules-data.js → SCHOOL_RULES.fields` = zone,
    activity, verification, duration, person type, time. There is **no numeric `occupancy` /
    `headcount` / `ratio` field**, so "alert when Lab > 30 people" cannot be expressed. Must
    be added for any capacity-breach alerting to be configurable rather than hard-coded.
14. **No occupancy report type.** `SCH_REPORT_TYPES` has attendance/safety/transport/visitor/
    dismissal/student — no occupancy/utilization/muster report.
15. **No camera→zone mapping model** anywhere in the school data layer. Head count arrives
    per camera; every school widget is per room/zone. A `ZONES` export (id, label, wing,
    capacity, cameraIds[], type) is the missing join table.
16. **No live video on any school page.** Every other head-count product surfaces the stream
    next to the count; `Footfall.jsx` already has the player pattern (`WebRTCStream`).
17. **No school `params.headcount` block** in `use-cases/school/index.js` to gate new pages.

### C. Identity-dependent gaps (mentioned for completeness, not head-count work)
- Bullying / aggression detection, uniform compliance, canteen cashless linkage, health/
  temperature screening, staff attendance & payroll, parent-app notifications beyond the mock.

---

## 7. The decision: merge vs new page

### 7.1 Merge into existing pages (no new route)

| Capability | Target file | Concrete change |
|---|---|---|
| Live on-campus head count + **reconciliation delta** | `components/KeyMetrics.jsx` + `data.js KPIS` | add 1–2 KPI cards: "Live Headcount (AI)" and "Unidentified" (`headcount − identified`), reuse the existing purpose/formula/fields tooltip shape |
| Per-room live occupancy | `LiveOverview.jsx` `ACTIVE_CLASSES` table | the `students` column becomes a live count + over/under-capacity chip |
| Gate in/out counter | `SafetyAnalytics.jsx` `GATE_FLOW` | already the right chart — swap mock for counter data, add live "currently inside" figure |
| Room occupancy vs capacity | `ClassRoomAnalytics.jsx` | keep the single-room deep dive; add an "all rooms" summary strip above the selector |
| Bus boarding count | `Transport.jsx` `TR_BUSES` | add `boarded / manifest` column + mismatch chip |
| Dismissal egress & holding-area count | `Dismissal.jsx` | add live "in holding area" tile + gate density chip on `DIS_FLOW` |
| Visitors on site | `VisitorManagement.jsx` | count-verified visitor total vs badge count |
| Capacity-breach alerts | `SafetySecurity.jsx` | new incident type "Occupancy breach" in `SAF_BY_TYPE` + alert rows |
| Occupancy rule field | `rules-data.js` | add `{ id: 'occupancy', label: 'Occupancy', type: 'number', operators: ['>','<','≥','≤','='] }` and `{ id: 'ratio', label: 'Adult:Child Ratio' }`; add 2–3 seeded rules |
| Occupancy report | `pages-data.js SCH_REPORT_TYPES` | add "Occupancy & Utilization" and "Muster / Drill" report types |

All of the above are **card/column/field additions to existing layouts** — they fit the
current information architecture and do not warrant new navigation entries.

### 7.2 New pages — recommended: exactly 2

**(1) `Occupancy & Headcount` — `/activity-monitoring/school/occupancy`**
Justification: nothing in the vertical shows the whole school at once. Room Analytics is
deliberately a single-room drill-down; forcing a school-wide grid + heatmap + capacity
breach list into it would break that page. This is a distinct operator task ("where is the
school crowded right now?") with its own filters and its own report.
Suggested content:
- Cards: Live Headcount · Peak Today · Zones Over Capacity · Avg Utilization ·
  Unidentified (reconciliation delta) · Busiest Zone.
- Zone grid: every classroom/lab/hall/corridor as a tile with `count / capacity`, colour by
  utilization band, click → drills into `ClassRoomAnalytics` for that room.
- Zone × time heatmap (copy the pattern from `campus/group-data.js HEATMAP`).
- Occupancy timeline with capacity `ReferenceLine` (pattern already in `ClassRoomAnalytics`).
- Capacity-breach log table.
- Optional live preview tile per camera (pattern from `Footfall.jsx`).

**(2) `Assembly & Evacuation` — `/activity-monitoring/school/muster`**
Justification: a **mode**, not a dashboard — it has its own state machine (drill started →
counting → all-clear), its own success metric (time-to-muster, missing count), and it is the
one screen a principal opens under emergency. It cannot live inside Safety & Security without
distorting that page. Also gives the dead `SAF_CARDS.drill` stat a real home.
Suggested content:
- Big status banner + timer; Start Drill / End Drill actions (mock, like Dismissal's
  acknowledge/escalate).
- Cards: Expected on Campus · Counted at Assembly Points · Missing · Time to Muster ·
  Zones Cleared · Last Drill Compliance.
- Assembly-point table: point, expected, counted, delta, status chip.
- Zone sweep list: each building zone with residual head count → "clear" only when count = 0.
  **This is the killer head-count use case — identity systems cannot confirm an empty room.**
- Drill history table + export.

**Not recommended as separate pages** (fold them in instead): cafeteria, corridors,
playground, library — these are all just *zones* and belong as zone-type filters/tiles on the
Occupancy page. Creating a page per zone would bloat the sidebar (already 10 school entries).

---

## 8. Implementation contract for whoever builds this

### New param block — `src/use-cases/school/index.js`
```js
headcount: {
  reconcile: true,            // show headcount vs identified delta
  breachPct: 100,             // % of capacity that triggers a breach alert
  crowdDensityPerM2: 1.5,     // corridor / gate crush threshold
  adultChildRatio: { primary: 15, middle: 25, senior: 30 },
  musterTimeoutSec: 300,      // target time-to-muster for a drill
  assemblyPoints: ['Main Ground', 'Sports Field', 'Front Courtyard'],
},
```
Gate the two new pages with `needsParam: 'headcount'` in `Sidebar.jsx` so they only appear
where the model is licensed.

### New data exports needed (mock first, per repo convention)
Put in a new `school/occupancy-data.js` and `school/muster-data.js` (keep `pages-data.js` from
growing past its current 254 lines):
```js
// occupancy-data.js
export const ZONES = [{ id, label, wing, wingLabel, type: 'classroom|lab|hall|corridor|
  cafeteria|playground|library|gate', capacity, cameraIds: [], count, utilization, status }]
export const OCC_CARDS, OCC_TIMELINE, OCC_HEATMAP, OCC_BREACH_LOG, OCC_RECONCILE
// muster-data.js
export const MUSTER_CARDS, ASSEMBLY_POINTS, ZONE_SWEEP, DRILL_HISTORY
```
Each export gets a `// Future backend: GET /school/occupancy/...` comment, matching the
existing style.

### Suggested backend endpoint names (comments only for now)
```
GET /school/occupancy/summary?wing&grade&section&room&range
GET /school/occupancy/zones            → live count per zone
GET /school/occupancy/timeseries?zone&range
GET /school/occupancy/heatmap
GET /school/occupancy/breaches
GET /school/occupancy/reconcile        → { zone, headcount, identified, delta }
POST /school/muster/start · POST /school/muster/end
GET /school/muster/points · GET /school/muster/sweep · GET /school/muster/history
```
If the head-count model is the same engine behind `vms_face` footfall, these should be thin
aggregations over `/ai/footfall/timeseries` + a `camera → zone` map, not a new pipeline.

### Style requirements (non-negotiable in this repo)
- Brand `#F7983A`; cards `rounded-xl border border-slate-200 bg-white p-4 shadow-sm`;
  text sizes in the `[10.5px]`–`[20px]` bracket style used everywhere.
- Page shell: `min-h-[calc(100vh-4rem)] bg-slate-50/60` → `mx-auto max-w-[1500px] px-4 py-5`
  → icon-badge + `<h1>` + subtitle, then `SchoolFilterBar`.
- Use `Panel` for every chart/table block; `SectionCard` only on the dashboard.
- No TypeScript, no fetch, no new dependencies, lucide icons only, recharts only.

---

## 9. Open questions to resolve before coding

1. **Where does the head-count model already run?** Is it the same `vms_face` service behind
   `/ai/footfall/*`? If yes, the school pages should consume `aiService.footfall*` rather than
   defining a new API surface.
2. **Zone or line?** Region-of-interest occupancy (how many *in* a zone) and line-crossing
   (how many *crossed*) are different configurations. Room Analytics/Occupancy need the former;
   Gate Flow, Bus Boarding and Dismissal need the latter. Confirm both are supported.
3. **Camera→room mapping** — does it exist in the backend (MySQL camera groups) or must the UI
   own a mapping table? This determines whether §8's `ZONES.cameraIds` is real or mock.
4. **Does the model distinguish adult vs child?** If yes, ratio-compliance and unattended-child
   features get much stronger; if not, adult/child must come from the face pipeline.
5. **Reconciliation feasibility** — can head count and identified count be sampled on the same
   time window per zone? That determines whether the "Unidentified" KPI is real or aspirational.
6. **Sidebar budget** — school already shows 10 children under Activity Monitoring. Adding 2
   makes 12. Acceptable, or should Occupancy absorb Room Analytics as a tab?
