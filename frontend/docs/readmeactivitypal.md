# Activity Monitoring — Frontend Guide (`readmeactivitypal.md`)

> **Scope:** the **Activity Monitoring** feature of the Drishyam Intelligent VMS. This is a **frontend-only** build — there is **no backend**. Every widget renders realistic **dummy data**; each data block documents the future backend endpoint + fields so the swap to live `useQuery` calls is mechanical.
>
> **One module, many verticals.** The module code is written once and rendered for four **use-cases**: **Retail**, **Corporate**, **Campus (University)**, and **School (K-12)**. You flip between them with the **"Viewing as"** switcher at the top of the dashboard.

---

## 1. Big picture / architecture

```
Route  /activity-monitoring
  → ActivityDashboard  (branches on the active use-case)
       ├── useCase === 'campus'  → CampusDashboard
       ├── useCase === 'school'  → SchoolDashboard
       └── else (retail|corporate) → RetailOfficeDashboard
```

Three pillars make this work:

| Piece | File | Job |
|---|---|---|
| **Use-case registry** | `src/use-cases/index.js` | The "product catalog". `USE_CASES = { corporate, retail, campus, school }`. Each vertical is a folder with `key`, `label`, `modules[]`, and `params{}`. |
| **Active-vertical store** | `src/modules/employee-productivity/useCaseStore.js` | Zustand store holding the current `useCase` (persisted to `localStorage['activity-use-case']`). `setUseCase()` flips it; every component re-renders. |
| **Vertical-aware data** | `src/modules/employee-productivity/useModuleData.js` | Hook that hands each shared component the retail **or** corporate dataset for the active vertical (identical shapes, different content). |

**Why this design:** adding a vertical is a folder + one registry line + (for a bespoke layout) one `if` branch. No shared component is forked.

### Directory map

```
src/use-cases/
  index.js                         registry + moduleParams()/hasModule() helpers
  employee-productivity.params.js  shared threshold defaults
  corporate/ retail/ campus/ school/   one folder per vertical (params only)

src/modules/employee-productivity/
  useCaseStore.js        active vertical + useActivityParams()
  useModuleData.js       retail⇄corporate data selector hook
  UseCaseSwitcher.jsx    the prominent "Viewing as" switch (all dashboards)
  PolicyBar.jsx          thresholds strip (the "why" behind the numbers)
  corporate-data.js      office dataset (mirror of the retail data shapes)

  dashboard/             RETAIL + CORPORATE dashboard
    ActivityDashboard.jsx  entry + branch
    KpiGrid, StoreSnapshot, NeedsAttention, EmployeeStatus,
    PerformanceCharts, ActivityFeed, data.js

  AttendanceReport, ActivityBreakdown, PhoneUsage, ZoneCoverage,
  Reports, EventLog, EmployeeDetail   retail/corporate subpages
  pages-data.js                        their dummy data

  rules/                 SHARED, data-driven rule engine (retail/corp/school)
    RuleBuilder, RuleCards, RulesTable, RulePanel, rules-data.js
  RulesPolicies.jsx      retail/corporate rules page
  report-export.js       CSV / Excel / PDF file generation (campus reports)

  campus/                CAMPUS vertical (own dashboard + 9 subpages)
  school/                SCHOOL vertical (own dashboard + 9 subpages)
```

---

## 2. How verticals are gated & switched

- **Switcher** — `UseCaseSwitcher.jsx` renders one button per `USE_CASES` entry (Corporate/Retail/Campus/School) with an icon and an obvious active state. Clicking calls `setUseCase(key)`.
- **Dashboard branch** — `ActivityDashboard` reads `useCase` and returns the matching dashboard component.
- **Sidebar gating** — `src/core/layout/Sidebar.jsx` filters the Activity Monitoring group's children:
  - `needsParam: 'campus' | 'school'` → shows **only** when that param exists (i.e. that vertical is active).
  - `hideFor: ['campus','school']` → the store/office children (Attendance, Breaks, Phone, Event Log, Reports, Rules) **hide** for campus + school, which have their own equivalents.
  - `needsParam: 'zones'` → Zone Coverage is retail-only.
- **Params** live in `src/use-cases/<vertical>/index.js` under `params['employee-productivity']`. Presence of a param block (`campus`, `school`, `zones`, `library`) is what flips layouts and gates pages. Read with `moduleParams(useCase, 'employee-productivity')` / `useActivityParams()`.

---

## 3. Shared building blocks (used across verticals)

| Component | Purpose |
|---|---|
| `campus/components/Panel.jsx` | The standard white **card**: bordered, `rounded-xl`, header (bare accent icon + bold title + optional count badge + right slot), scrollable body. |
| `campus/components/SectionCard.jsx` | A **collapsible section** wrapper — "one eye toggle controls the whole section"; hidden sections collapse to just their header. |
| `campus/components/EyeToggle.jsx` | The single show/hide control reused by every section header and chart card (same shape/position everywhere). |
| `campus/components/profileConstants.js` | Chart tokens (`AXIS`, `GRID`, `TIP`) + tone maps — one look for all charts. |
| `campus/components/profileBits.jsx` | Generic profile pieces: `Tile` (stat tile), `BarRow` (labelled progress bar), `TimelineList` (vertical timeline), `AlertCards`. |
| `rules/*` | The **rule engine** (see §7) — data-driven, so retail, corporate and school all render the same UI with different vocabularies. |
| `report-export.js` | Turns a report request into a **real downloaded file** (CSV, Excel `.xls`, or a hand-built valid PDF) filled with the page's data. |

**Design system:** light theme only, white surfaces, **`#F7983A`** orange accent, `rounded-2xl` sections / `rounded-xl` cards, `shadow-sm`, slate typography, **uniform accent icon tiles** (colour signal lives only in trend deltas & status chips). It is an **AI analytics dashboard, NOT a CCTV page**.

---

## 4. Retail & Corporate (the shared store/office dashboard)

`dashboard/ActivityDashboard.jsx` renders `RetailOfficeDashboard`, which is **vertical-aware**: retail-only widgets are gated behind `useCase === 'retail'`, so **Corporate** shows a clean office view.

| Component | What it shows |
|---|---|
| `KpiGrid` | The KPI cards. Corporate drops the retail-only *Counter Coverage* + *Queue Health* and the "Store" label prefix. |
| `StoreSnapshot` | Interactive store **floor plan** (zones, staff/customer dots, coverage states). **Retail only** — hidden for corporate. |
| `NeedsAttention` | Severity-ranked action queue (unattended counter, queue exceeded, phone, long break, late, low activity). |
| `EmployeeStatus` | Roster: who's where, status (On Floor/Break/Away/Late/Not Arrived), clock-in, hours. |
| `ActivityFeed` | Recent detections stream. |
| `PerformanceCharts` | Hourly charts. Retail = 4 (attendance, footfall, coverage, queue-wait); corporate = 2 (attendance, workspace coverage). |

**Data source:** `useModuleData()` returns the **retail** (`dashboard/data.js`, `pages-data.js`) or **corporate** (`corporate-data.js`) dataset. Both have identical shapes.

### Retail/Corporate KPIs

| KPI | Meaning | Formula (documented in data) |
|---|---|---|
| Store/Health Score | Single "is it operating normally?" number | weighted blend of attendance, coverage, queue, phone, breaks |
| Staff Present | On-site vs rostered for the shift | `count(inside) / count(roster where shift)` |
| On-Time Attendance | Share clocked in before the late cutoff | `count(clockIn ≤ lateAfter) / expected × 100` |
| Avg Working Hours | Mean on-site time so far (breaks excluded) | `Σ total_inside_sec / presentStaff` |
| Counter Coverage *(retail)* | % of open-minutes each counter was staffed | `Σ staffedMin / (openCounters × elapsedMin)` |
| Queue Health *(retail)* | Est. avg wait from queue detections | `avg(queueLen × serviceTime)` |
| Desk Occupancy *(corporate)* | Assigned desks occupied now | `count(desks occupied)/count(assigned)` |
| Phone / Device Alerts | Phone-in-hand detections past policy | `count(type=phone-use ∧ hold ≥ policy)` |
| Active Alerts | Unacknowledged alerts (== Needs Attention count) | `count(alerts where acknowledged=false)` |

**Subpages:** Attendance Report (backend-driven), Event Log, Breaks & Idle, Phone Usage, Zone Coverage *(retail)*, Reports (weekly scorecards), Employee Detail (drill-down), and **Rules & Policies** (`RulesPolicies.jsx`, retail+corporate).

---

## 5. Campus (University) vertical

`campus/CampusDashboard.jsx` — hierarchy **University → Building/School → Department → Floor → Room**. Modelled on Sharda University's real schools & courses (`campus/data.js` `HIERARCHY`).

**Dashboard sections**

| Section | Component | Contents |
|---|---|---|
| Key Metrics | `KeyMetrics` | 6 cards; **People Present** opens a popover (By Category / By School). |
| Activity Insights | `ActivityInsights` | Distribution donut + Trend area, each with its own eye-toggle. |
| Live Overview | `LiveOverview` | Live Activity Feed · Active Activities · Recent Alerts, with feed-vs-active ⓘ tooltips. |
| Activity Analytics | `ActivityAnalytics` | Hourly Activity + Activity Status (eye-off by default). |

**Campus KPIs:** People Present, Active Activities, Students in Class, Faculty on Campus, Library Occupancy (vs capacity), Average Attendance.

**Campus subpages** (`needsParam: 'campus'`):

| Page | File | What it's for |
|---|---|---|
| Live Activity Intelligence | `LiveActivityIntelligence` | What the AI *understands* is happening now: live timeline, active sessions, **AI Decision Panel** (signals → decision → action), right **person drawer**. |
| Student Activity | `StudentActivity` | One student's full profile: search/face-search, 5 cards, 9 tabs (Overview…Reports). |
| Faculty Activity | `FacultyActivity` | Faculty profile: lecture timeline, teaching/office hours, room utilization, student interaction, attendance. |
| Group Activity | `GroupActivity` | Collaboration detection: duration/size histograms, formation timeline, location×time heatmap, groups table. |
| Room Analytics | `RoomAnalytics` | Per-room: occupancy timeline + activity/lecture/teacher "gantt" bands + current/previous/history tables. |
| Attendance Intelligence | `AttendanceIntelligence` | Present/absent/late/away/early/overrides, trend, department & semester comparison, session/exception tables. |
| Productivity | `ProductivityAnalytics` | Focus, discussion, library usage, department productivity. |
| Reports | `Reports.jsx` (campus) | Report library + period + **real PDF/Excel/CSV export** + recent + scheduled reports. |
| Rules & Policies | `campus/RulesPolicies` | The rule engine with a campus vocabulary. |
| Active Activities | `ActiveActivities` | Drill-down from the dashboard's Active Activities panel; date/time/status filters. |

---

## 6. School (K-12) vertical

`school/SchoolDashboard.jsx` — hierarchy **School → Wing → Grade → Section → Room** (`school/data.js`). Focus is **child-safety, attendance, transport, dismissal, visitors, parent notifications** (vs the university's faculty/library depth). Personas: Principal, Admin, Safety officer, Teachers, Parents.

**Dashboard pieces**

| Component | Purpose |
|---|---|
| `UseCaseSwitcher` | Vertical switch (top of page). |
| `SchoolModules` | **On-dashboard launcher** — 9 tiles linking straight to every school subpage (so they're reachable without the sidebar). |
| `SchoolHeader` | Title + search + last-updated + auto-refresh. |
| `SchoolFilterBar` | Cascading School → Wing → Grade → Section → Room + Time Range. |
| `KeyMetrics` | 8 cards (see below); **Students Present** popover (By Category / By Grade Band). |
| `ActivityInsights` | Distribution donut + Trend area (per-chart eye-toggles). |
| `LiveOverview` | Live Activity Feed · Active Classes · Safety & Recent Alerts (feed-vs-active tooltips). |
| `SafetyAnalytics` | Hourly Activity + Attendance by Grade + Gate Entry/Exit flow (eye-off by default). |
| `QuickActionsFooter` | Sticky: Search · Generate Report · **Notify Parents** · View Heatmap. |

**School KPIs (Key Metrics)**

| KPI | Meaning |
|---|---|
| Students Present | Distinct students on-campus (dedup across cameras). Clickable → grade/category popover. |
| Staff Present | Teaching + support staff on-site. |
| Attendance | Mean attendance across sections vs the 90% target. |
| Active Classes | Classes detected in-session now. |
| **Safety Alerts** | Open child-safety / security alerts needing action. |
| **Visitors On-Campus** | Checked-in visitors currently inside. |
| **Buses** | Fleet status — on-site vs en route. |
| Absentees Flagged | Enrolled but not detected → parents auto-notified. |

**School subpages** (`needsParam: 'school'`, routes under `/activity-monitoring/school/*`)

| Page | File | Cards / Charts / Tables |
|---|---|---|
| Attendance Intelligence | `AttendanceIntelligence` | Present/Absent/Late/Leave/%/Notified · trend + late analysis · section table · **absentee → parent-notify** list. |
| Safety & Security | `SafetySecurity` | Alerts/Restricted/Unattended-child/Perimeter/Flagged/Drill · incidents-by-type + hourly · active alerts + restricted-zone log. |
| Transport & Bus | `Transport` | On-site/En-route/Students/On-time/Delayed/Alerts · arrivals chart · fleet table (route, driver, ETA, occupancy, status). |
| Dismissal & Pickup | `Dismissal` | Dismissed/Awaiting/Verified/Unauthorized/Wait/Boarded · pickup flow + mode donut · **guardian-verification log** (blocked unauthorized attempt). |
| Visitor Management | `VisitorManagement` | On-campus/Today/Pending/Pre-approved/Flagged/Duration · purpose donut + hourly · visitor log (badge, in/out, status). |
| Student Activity | `StudentActivity` | Search + Face Search · identity + 5 cards · tabs (Overview/Attendance/Movement/Timeline/Alerts). |
| Class / Room Analytics | `ClassRoomAnalytics` | Room selector · occupancy/capacity/attendance/utilization cards · occupancy timeline · schedule. |
| Reports | `Reports.jsx` (school) | Report library (Attendance/Safety/Transport/Visitor/Dismissal/Student) + period + **real CSV export** + recent. |
| Rules & Policies | `school/RulesPolicies` | Shared rule engine with a **safety vocabulary** (unattended-child, tailgating, fight, perimeter). |

**School params** (`src/use-cases/school/index.js`): `businessHours 08:00–15:00`, `lateAfter 08:15`, `school.attendanceTarget 90`, `safety.restrictedZones/unattendedChildSec`, `transport.buses/boardingWindowMin`.

---

## 7. The Rules Engine (shared, data-driven)

`rules/` is a **vertical-agnostic** IF-conditions → THEN-actions engine. The UI is one component set; the **vocabulary is data**.

| Part | Role |
|---|---|
| `rules-data.js` | `RETAIL` / `CORPORATE` bundles + `rulesFor(useCase)`; plus `SEVERITIES`, `RULE_STATUS`, `SEVERITY_TEXT`. School has its own `school/rules-data.js`. |
| `RuleCards` | Total / Active / Disabled / Pending. |
| `RuleBuilder` | Interactive builder: **IF** field→operator→value rows (input type driven by the field: select / number+unit / time), **AND** to add, **THEN** actions with severity, a live **preview console**, Save & Reset. Adding a field/action = a one-line data change. |
| `RulesTable` | Existing + saved rules with severity colour, trigger count, status chip, inline **enable/disable toggle**. |

Saving a rule prepends it as **Pending**; toggling flips active⇄disabled. Everything is local state (frontend-only).

---

## 8. Metrics glossary (what the numbers mean)

Every dummy metric is a stand-in for a future API value. In the data files each block carries:
- **`purpose`** — the plain-English "what is this?".
- **`formula`** — how it's derived from raw detections.
- **`fields`** — the backend fields that will populate it (shown as chips in the ⓘ tooltip on KPI cards).

Colour rules used consistently:
- **Trend delta**: green = up/good, red = down/bad, grey = flat — the *only* colour on an otherwise neutral KPI card.
- **Status chips**: emerald = ok/verified/on-site, sky = scheduled/in-transit, amber = warn/delayed/flagged-low, rose = high/blocked/critical, slate = idle/off/neutral.
- **Threshold bars** flip **amber** when below target (e.g. attendance < 90%, utilization < 40%).

---

## 9. Background processes (what happens under the hood)

| Process | How it works |
|---|---|
| **Vertical switch** | `setUseCase()` writes zustand + `localStorage`; dashboards branch, `useModuleData()` swaps data, sidebar re-filters — all reactive, no reload. |
| **Auto-refresh** | Each dashboard runs a 30 s `setInterval` that updates the "Last updated" stamp while the toggle is on (simulates a live refetch). Manual **Refresh** shows a 700 ms spinner (stand-in for `queryClient.invalidateQueries`). |
| **Section visibility** | Section eye-toggles persist to `localStorage` (`campus-activity-sections`, `school-activity-sections`, `dashboard-hidden-kpis`). Analytics sections default to **eye-off**. |
| **Cascading filters** | Choosing a level (Wing/Grade/Section…) resets the levels beneath it so the selection can never be invalid. |
| **People/Students Present popover** | Click the card → click-away backdrop + popover with By-Category / By-Grade breakdowns (count · % · trend). |
| **Report export** | CSV is built + downloaded for real; Excel is an HTML-table `.xls`; PDF is a hand-assembled, valid single-page document (accent header band, metadata block, drawn table). Content is pulled from the same page datasets so exports match the UI. |
| **Rules save/toggle** | Local React state; Save → pending, toggle → active/disabled. |
| **Sidebar auto-expand** | The Activity Monitoring group auto-opens when its route is active; a manual collapse is remembered in `localStorage['sidebar-groups']`. |

### Dummy → backend swap plan (when the API lands)
1. Replace the `data.js` / `pages-data.js` imports with `useQuery` calls — endpoints + fields are already documented beside every constant.
2. Read thresholds from `moduleParams(useCase, 'employee-productivity')` instead of hard-coded copy.
3. Swap the simulated refresh for `queryClient.invalidateQueries` + a socket channel for live feeds.
4. Wire rule Save/Ack/Toggle and report generation to their endpoints.

---

## 10. Running & verifying

```bash
npm install        # required — restores node_modules
npm run dev        # start Vite; open the app, go to Activity Monitoring
```

Use the **"Viewing as"** switch (Corporate · Retail · Campus · School) to change vertical. School subpages are reachable from the **sidebar** (Activity Monitoring group) **or** the **on-dashboard module launcher**.

> **Note:** `npm run build` currently fails on a few **pre-existing** missing media assets in `src/ai-analytics/` (`.mp4`/`.webm` files with spaces in their names) — unrelated to Activity Monitoring. `npm run dev` serves everything fine.

---

*Frontend-only build. All data is illustrative dummy data with inline backend contracts; no real students, staff or footage are represented.*
