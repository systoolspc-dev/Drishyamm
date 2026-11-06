# Retail — Activity Monitoring Dashboard (Frontend-only build)

> **Scope of this build:** FRONTEND ONLY. There is **no backend**, **no API code**, and
> **no backend logic**. Every widget renders realistic dummy data. This document records
> (1) what was changed and where, and (2) for every widget: purpose, displayed fields,
> dummy data, future backend fields, calculation formula, empty state, loading state,
> responsive behaviour, and interaction behaviour.

**Route:** `/activity-monitoring` · **Sidebar:** AI Intelligence → *Activity Monitoring* → **Dashboard**
(siblings: Zone Headcount · Breaks & Idle · Phone Usage · Zone Coverage · Retail Analytics · Reports · Rules & Policies)
**Persona:** Retail store manager. Within 5 seconds they should know: is the store healthy,
is staff working, which counters need attention, which employees require action, and
whether customer service is affected.

---

## 1. What changed, and where

| # | File | Change |
|---|------|--------|
| 1 | `src/modules/employee-productivity/dashboard/dto.d.ts` | **NEW** (§13) — the DTO / wire-schema contract. Ambient TS interfaces for every shape the data layer produces and the API must produce; the data modules annotate their exports against it. |
| 2 | `src/modules/employee-productivity/dashboard/data.js` | Dummy-data layer (retail). Every constant documents the future backend endpoint + field names next to the dummy values. §13 reshaped `KPIS`, added `EmployeeRow.lateBy` / `.phoneIncidents` and `AttentionAlert.source`, and deleted the `FLOOR_*` arrays. |
| 3 | `src/modules/employee-productivity/corporate-data.js` | The office dataset, same shapes (see `useModuleData()`). Reshaped identically in §13. |
| 4 | `src/modules/employee-productivity/dashboard/ActivityDashboard.jsx` | The page: two-line header (scope + live context + export/refresh) and the composition of all sections. Simulated 700 ms refresh drives real skeleton states. Four bands since §13; filters dropped in §14. |
| 4a | `src/modules/employee-productivity/shifts.js` | **NEW** (§14) — resolves which roster shift(s) are running at a given IST clock, overnight-safe, umbrella spans dropped. |
| 4b | `src/modules/employee-productivity/policy-items.js` | **NEW** (§14) — the threshold list, shared by `PolicyBar` and `PolicyTip` so they cannot drift. |
| 4c | `src/modules/employee-productivity/PolicyTip.jsx` | **NEW** (§14) — the policy strip folded into one ⓘ for the dashboard header. |
| 5 | `src/modules/employee-productivity/dashboard/KpiGrid.jsx` | Section 1 — **four** KPI cards with icon, tooltip (purpose + formula + backend-field chips), value, trend delta. Renders by `display` kind, not by key. §16 rebuilt the card to value + status badge + one summary line, on the fixed type scale. |
| 6 | `src/modules/employee-productivity/dashboard/NeedsAttention.jsx` | Section 2 (left, ~60 %) — the primary alert feed: severity-ranked cards, severity breakdown header, source filter, Ack action (local state). |
| 7 | `src/modules/employee-productivity/dashboard/EmployeeStatus.jsx` | Section 2 (right, ~40 %) — scrollable roster with avatar, status badge carrying lateness, phone-incident flag, zone, shift, worked hours; in-card search + status filter. |
| 8 | `src/modules/employee-productivity/analytics/AnalyticsPage.jsx` | **NEW** (§15) — the Analytics shell. Route-driven tabs, defaults to Today's Trends. Moved to `/activity-monitoring/analytics` and titled *Retail Analytics* in §16.1. |
| 8a | `…/analytics/TrendsTab.jsx` · `StaffTab.jsx` · `TrafficTab.jsx` | **NEW** (§15) — the three Analytics views. |
| 9 | `src/modules/employee-productivity/dashboard/PerformanceCharts.jsx` | The chart grid itself (attendance, traffic, coverage, queue wait), headless of page chrome — mounted by `TrendsTab` since §15. |
| 10 | ~~`…/dashboard/ActivityFeed.jsx`~~ | **DELETED** in §15 — the stream moved to `/event-logs`; see §15.2. |
| 11 | ~~`…/dashboard/AnalyticsSection.jsx`~~ | **DELETED** in §15 — the collapsible band became the Analytics page; see §15.3 and §16.1. |
| 12 | ~~`…/dashboard/StoreSnapshot.jsx`~~ | **DELETED** in §13 — see §8. Recover from git history if the spatial view is wanted back. |
| 13 | `src/App.jsx` | **EDIT** — routes for `/activity-monitoring`, `/event-logs` (+ `/event-log` redirect) and `/activity-monitoring/analytics/:tab` (+ its bare-path redirect), all lazy and protected. `LegacyAnalyticsRedirect` keeps the old top-level `/analytics/:tab` bookmarks working, tab included (§16.1). |
| 14 | `src/core/layout/Sidebar.jsx` | **EDIT** — Activity Monitoring nav group; `/event-logs` rename; the entitlement fix in §15.4; and §16.1, which moved Analytics **into** the Activity Monitoring group (deleting the top-level one) and added the `matchPrefix` + `labelFor` child options it needed. |
| 15 | `src/index.css` | **EDIT** (§16.3) — two new steps on the type scale, `--text-metric-lg` (28/32, 700) and `--text-label` (14/20, 600), so the KPI hierarchy is spelled in design-system tokens rather than ad-hoc sizes. |

**Why this folder:** module code lives once in `src/modules/employee-productivity/`;
verticals only change parameters via `src/use-cases/` (`retail/index.js` already overrides
`businessHours: 10:00–22:00`, `lateAfter: 10:15`, `breakGapSec: 600`, `phone.holdSec: 2.5`).
When the backend lands, the dashboard reads thresholds from
`moduleParams(activeUseCase, 'employee-productivity')` — nothing retail-specific is
hard-coded in module logic.

**Theme compliance:** primary `#F7983A`, dark sidebar (existing `#0b0b0d`/`#0F172A` family),
light page background, white `rounded-xl` cards, `shadow-sm` only, slate typography —
identical vocabulary to the existing Attendance Report page, so the dashboard drops into
the VMS without a style fork.

---

## 2. Section 0 — Header

Two lines, no filters (see §14 for what was removed and why).

| Aspect | Detail |
|---|---|
| Purpose | State the page's **scope** (which site) and its **context** (what time, which shift, under which thresholds). A realtime page has one job — *now* — so nothing here narrows the widgets below. |
| Line 1 | Title · **vertical switcher** · **Export** (CSV of the employee-status snapshot) · **Refresh** (spins, simulates a 700 ms fetch → skeletons everywhere). |
| Line 2 | **Store selector** (inline, reads as part of the sentence) · ● **Live · HH:MM IST** · **current shift**, resolved not chosen · **ⓘ Policy** tooltip. |
| Dummy data | `STORES`, `NOW_IST`, `TODAY` in `data.js` / `corporate-data.js`. Shifts come from `params.shifts`, **not** from the data layer. |
| Future backend | `GET /stores` → `storeId, name, city`. `NOW_IST` becomes the payload's "as of" timestamp; `params.shifts` becomes `store.shifts[]` from roster config. Changing the store becomes a query-key change (TanStack Query refetch). |
| Interaction | Export downloads `activity-monitoring-<TODAY>.csv` — since §13 it carries **Late by** and **Phone incidents** columns, because that is where the analytical read of those two metrics now lives. |
| Responsive | The action cluster wraps under the title on narrow screens; the context line wraps item by item. Whole page is a single column under `lg`. |

### Where shifts are configured

Shifts are an **operator setting, not a viewer filter**. They live with every
other threshold, in the vertical's params:

| Layer | File | Holds |
|---|---|---|
| Defaults | `src/use-cases/employee-productivity.params.js` | `shifts: [{ id, label, start, end }]` — 09:00–18:00 / Early / Late |
| Retail | `src/use-cases/retail/index.js` | Full Day 10:00–22:00 · Morning 10:00–16:00 · Evening 16:00–22:00 |
| Corporate | `src/use-cases/corporate/index.js` | Full Day 09:00–18:00 · Early 08:00–16:00 · Flexi 11:00–20:00 |
| Resolution | `src/modules/employee-productivity/shifts.js` | `runningShifts()` / `shiftSummary()` — which are on at a given IST clock |

`start`/`end` are IST 24h `"HH:MM"`; an end **before** its start means the shift
crosses midnight, and the resolver handles that. Where a wide window fully
covers a narrower running one it is treated as an umbrella and dropped, so
retail at 15:00 reports *Morning shift · 10:00–16:00* rather than *Full Day*.
Genuinely overlapping crews both survive and the header says so
(*"3 shifts running · Full Day, Early, Flexi"*). Nothing running →
*"Outside shift hours"*.

---

## 3. Section 1 — KPI cards (`KpiGrid.jsx`)

**Four cards on retail, three on corporate** (an office has no billing queue).
Grid: `grid-cols-1 md:grid-cols-4`, fixed tracks and fixed-height cards — see
§15.1 for the rigidity rules.

**A card carries four things and no fifth** (§16.2). In reading order:

| Slot | Token | Content |
|---|---|---|
| Label | `text-label` · 14 / 600 | What is being measured. |
| Value | `text-metric-lg` · 28 / 700 | The number, with its unit one step down. |
| Summary | `text-small` · 12 / 400, `text-fg-muted` | **One** line, **aggregate**. |
| Badge | `text-caption` · 11 / 600, top-right | The state, in plain words. |

Plus the icon tile (card tone), the optional trend delta, a hover arrow marking
the card as a shortcut, and the ⓘ tooltip showing **purpose, formula, field
chips and the destination** (the tooltip doubles as the dev contract).

The row answers four questions and nothing else — is the store healthy, is the
team here, are customers waiting, are the tills manned:

| KPI | Display | Dummy | Badge | Summary | Opens |
|---|---|---|---|---|---|
| Store Health Score | `score` | **87** /100, ▲ +3 vs yesterday | Healthy | Counter coverage is the weakest area | Reports |
| Staff Present | `ratio` | **11 / 12** Scheduled | 2 Pending | 1 Not Arrived · 1 Late | Attendance Report |
| Queue Health *(retail)* | `measure` | **3.2** min avg wait | High Wait Times | 1 of 3 counters over limit | Zone Headcount |
| Counter Coverage *(retail)* | `ratio` | **2 / 3** Counters Active | 1 Unattended | 91% average coverage today | Zone Coverage |
| Desk Occupancy *(corporate)* | `ratio` | **39 / 50** Desks In Use, ▲ +4% | Normal | 11 desks free right now | Zone Headcount |

| KPI | Formula | Backend fields |
|---|---|---|
| Store Health Score | `0.30·attendanceRate + 0.25·coverageRate + 0.20·queueScore + 0.15·(1−phoneIncidentRate) + 0.10·breakComplianceRate, ×100` | `attendanceRate, coverageRate, queueScore, phoneIncidentRate, breakComplianceRate` |
| Staff Present | `count(currently_inside) / count(roster where shift = selected)`; `pending = count(status ∈ {notarrived, late})` | `employees[].currently_inside, employees[].status, roster[].employeeId, roster[].shift` |
| Queue Health | `wait = avg(queueLength × serviceTimePerCustomer)`; `overLimit = count(counters where queue_length > policy.maxQueue)` | `counters[].queue_length, policy.serviceTimeSec, policy.maxQueue` |
| Counter Coverage | `count(counters where open ∧ staffed_now) / count(counters where open)`; `avgToday = Σ staffed_minutes / (count(open) × elapsedOpenMinutes)` | `counters[].open, counters[].staffed_now, counters[].staffed_minutes, elapsedOpenMinutes` |
| Desk Occupancy | `count(desks where occupied) / count(desks where assigned)` | `desks[].occupied, desks[].assigned` |

`display` is the DTO field that picks the markup branch (`ScoreKpi | RatioKpi |
MeasureKpi` in `dto.d.ts`) — the data decides how it renders, the component does
not special-case keys. `trend` is an explicit `'up' | 'down' | null`; the arrow is
never inferred from the sign in the `delta` string. The `'status'` kind is gone:
see §16.2 for why the state became a badge instead of the headline.

**Where the other four KPIs went** (see §13):

| Was a card | Now lives | Why |
|---|---|---|
| Phone Incidents Today | `EmployeeRow.phoneIncidents` → flag badge on the roster row | A store-wide count gives a manager nothing to act on; a name does. |
| On-Time Attendance | `EmployeeRow.lateBy` → the status badge reads "Late 26m" | Same reason; the badge already said *Late*, it just never said how late. |
| Active Alerts | Needs Attention header count + severity chips | Two renderings of one array that could drift apart. Now they cannot. |
| Avg Working Hours | Reports subpage / CSV export only | Not a realtime number — it only means something over a closed period. |

States: **loading** — one pulse skeleton per visible card. **Empty** — n/a (KPIs
always render; a `—` value with "no data for this date" once the API exists).
**Interaction** — the whole card is the link (§16.2): hover lifts the shadow and
warms the arrow, focus draws a brand ring, and the `aria-label` names the
destination ("Queue Health — open Zone Headcount"). ⓘ hover opens the spec
tooltip and does **not** navigate.

> The per-card **eye/hide toggle** and its `localStorage('dashboard-hidden-kpis')`
> restore strip were removed with this pass. It existed to cope with eight cards;
> with four curated ones, a grid full of holes reads as broken, not as tidy.

---

## 4. Section 2 — Needs Attention (`NeedsAttention.jsx`)

**The page's primary alert feed**, left column at ~60% (`lg:col-span-3` of 5).

| Aspect | Detail |
|---|---|
| Purpose | The manager's action queue — every open issue across every subsystem, ranked by severity. |
| Displayed per card | severity bar + chip (high/medium/low), **source chip** (coverage/queue/staff/system), type icon, title, employee (when attributable), location, duration, camera, since-time, **Ack** button. |
| Header | Title · live open count · severity breakdown chips (`2 High · 3 Medium · 2 Low`) — this **is** the retired *Active Alerts* KPI, computed from the same array the rows render. |
| Source filter | Chips for All / Coverage / Queue / Staff / System, each with its own live count; only sources with an open alert get a chip, and the row hides entirely below three chips. |
| Dummy data (7) | Counter unattended — Billing 3, 6m 20s, HIGH/coverage · Queue exceeded — Billing 1, 7 waiting, HIGH/queue · Phone detected — Sneha Patil, Apparel, 48s, MED/staff · **Camera offline — Stockroom CAM-08, 12m, MED/system** · Break over policy — Anjali Mehta, 24m of 10m, MED/staff · Late arrival — Meena Iyer, 26m late, LOW/staff · Low zone activity — Home & Kitchen, 38m, LOW/coverage. |
| Future backend | `GET /activity/alerts?store&date&acknowledged=false` → `alertId, type, source, severity, employeeId, zoneId, started_ts, duration_sec, camera, acknowledged`; Ack = `POST /activity/alerts/:id/ack` (the contract Attendance Report already uses via `aiService.activityAckAlert`). |
| Formulas | counter-unattended: `staffedCount = 0` ≥ threshold · queue-exceeded: `queue_length > policy.maxQueue` · long-break: `break_duration > policy.breakGapSec` (600s retail) · late: `clock_in > lateAfter` (10:15) · phone: `hold_sec ≥ 2.5 ∧ requireHand` · camera-offline: no frame for `policy.stream.offlineSec`. |
| Empty state | Green check — "All clear. No active issues need action right now." A filter that matches nothing gets its own copy ("No system alerts") so an empty subsystem never reads as an empty store. |
| Loading | Five pulse skeleton rows. |
| Responsive | 3 of 5 grid columns on `lg+`, full width below; internal scroll past ~460px. |
| Interaction | **Ack** removes the card (local state); the count, severity chips and source counts all update from it. Future: "View clip" opening event playback. |

---

## 5. Section 2 — Employee Status (`EmployeeStatus.jsx`)

Right column at ~40% (`lg:col-span-2` of 5) — the slot the floor plan used to hold.

| Aspect | Detail |
|---|---|
| Purpose | Roster truth: who is where, doing what, since when — and who needs a word. |
| Displayed per row | initials avatar (deterministic hue), name, **phone-incident flag**, role · zone · shift, **status badge carrying lateness** (*On Floor* green / *Break* amber / *Away* orange / *Late 26m* rose / *Not Arrived* slate), clock-in time, worked hours; header shows `11/12 present`. |
| Relocated metrics | `phoneIncidents` → a flag badge (📱 n) that escalates amber → rose at 2+ in a day, titled "n phone incidents today". `lateBy` → appended to the status badge, so it reads **Late 26m** rather than just *Late*. |
| Dummy data | 12 employees (`EMPLOYEES` in `data.js`) — one late (Meena, 26m, 1 phone incident), one on break (Anjali), one away (Sneha, 2 phone incidents), one not arrived (Divya). |
| Future backend | `GET /activity/employees?store&date&shift` → `employeeId, name, role, current_status, current_zone, shift, clock_in_ts, total_inside_sec, late_by_sec, phone_incident_count, avatar_url`. |
| Formulas | status: *On Floor* = inside ∧ in a floor zone · *Break* = mid-visit gap ≥ `breakGapSec` · *Away* = last seen off-camera < `sessionGapSec` · *Late* = `clock_in > lateAfter`, `lateBy = clock_in − lateAfter` · *Not Arrived* = no sighting. `phoneIncidents = count(phone events where hold_sec ≥ policy.phone.holdSec)`. |
| Empty state | "No employees match — adjust the status filter or search." |
| Loading | Six pulse skeleton rows. |
| Responsive | 2 of 5 grid columns on `lg+`, full width below; internal scroll past ~460px (matched to Needs Attention so the two columns bottom out together). |
| Interaction | In-card search (name/zone) + status select — they only affect this list, so they live in it. Unfiltered shows the first 7 rows + "+N more"; filtering shows every match. Row → `/activity-monitoring/employee/:id`. |

---

## 6. Section 3 — Recent Activity — **MOVED OFF THIS PAGE (§15.2)**

> The inline stream was deleted in §15. The dashboard header now carries an
> **Event Logs [n]** CTA to `/event-logs`, which is the existing Event Log page
> with real date/source filters, search and CSV export. The table below records
> what the inline band used to be; it no longer describes anything on screen.

Full-width band directly under the Needs Attention / Employee Status row.

| Aspect | Detail |
|---|---|
| Purpose | Trust anchor: the raw detections behind every number above. |
| Orientation | **Horizontal** — newest left, older right along one timeline rail, scrolling sideways with scroll-snap. The stream is context, not a work queue, so it earns a band rather than a column; the vertical spine it used to render as competed with the alert list for "list to work through". |
| Displayed per card | icon tile (colour carries severity), time (IST), employee when known, two-line description, camera · zone. |
| Dummy data (10, 8 shown) | queue alert 14:35 · counter unattended 14:32 · phone usage 14:29 · break start 14:14 · low activity 13:58 · exit/return 13:42 · break end 12:37 · late entry 10:41 · on-time entries 10:05 / 09:55. |
| Future backend | `GET /activity/events?store&date&limit` — the same stream the Event Log consumes: `eventId, ts, type, employeeId, camera, zoneId, meta`. |
| Empty state | Inbox icon — "No activity yet. Events appear here as cameras detect them." |
| Loading | A row of five pulse skeleton cards. |
| Responsive | Identical at every width — the rail scrolls instead of reflowing. |
| Interaction | Card hover highlight; "View all →" and the trailing "+N earlier →" card both open the Event Log. |

---

## 7. Section 4 — Analytics — **MOVED TO `/activity-monitoring/analytics` (§15.3, §16.1)**

> `AnalyticsSection.jsx` and its collapse toggle were deleted in §15; the
> charts now live on the Analytics page, which opens on Today's Trends.
> `PerformanceCharts.jsx` itself is unchanged and is mounted by `TrendsTab`.
> The chart table below is still accurate; the toggle/collapse rows are not.

### (historical) `AnalyticsSection.jsx` + `PerformanceCharts.jsx`

**Collapsed by default.** `AnalyticsSection` owns the heading and the toggle;
`PerformanceCharts` is now headless of page chrome and renders only the grid.

| Aspect | Detail |
|---|---|
| Toggle | One button — **Show Analytics ▼** / **Hide Analytics ▲** — with `aria-expanded` + `aria-controls="dashboard-analytics"`. |
| State | `useState(loadPref)` over `localStorage('dashboard-analytics-open')`. Default (and every private window, and any browser that throws on storage) is **collapsed**; an explicit open is remembered so the one manager who lives in the charts is not made to re-open them each morning. |
| Mount, not CSS | Collapsed renders **nothing** — no chart DOM, no `ResponsiveContainer` resize observers, no Recharts render work. `lazy()` + `Suspense` also give the charts their own chunk (`PerformanceCharts-*.js`), with a four-card skeleton as the fallback. |
| Known limit | Recharts is still in the dashboard's initial chunk, because `ActivityDashboard` statically imports the campus / school / hostel / hospitality / bank dashboards and those use it. Lazifying those five imports is the remaining step for a real first-paint bundle win. |

Four cards on retail, two on corporate, hourly buckets 10:00→now (`TRENDS`).
Future backend: `GET /activity/trends?store&date` → per bucket
`hour, present_staff, expected_staff, customer_entries, coverage_pct, avg_queue_wait_min`.

| Chart | Type | Dummy shape | Formula / source |
|---|---|---|---|
| Attendance Trend | Area (present, orange) over dashed expected | 9→11→11→10→10→10 vs 11–12 | presence sessions bucketed hourly vs roster |
| Customer Traffic *(retail)* | Bars (navy `#0F172A`) | 42→78→116→134→121→98 | footfall line-cross counts per hour |
| Coverage Trend | Line (green) | 100→100→96→92→84→91 % | `staffed counter-minutes / open counter-minutes` per hour |
| Queue Wait Time *(retail)* | Line (rose) | 1.2→2.1→3.4→4.8→5.6→3.2 min | `avg(queue_length × serviceTimeSec)/60` per hour |

States: **loading** — 4 skeleton cards. **Empty** — (future) "No data for this date yet."
**Responsive** — 1 col → 2 (`sm`) → 4 (`xl`). **Interaction** — hover tooltips; the
lunch-hour dip (13:00–14:00 coverage 84 %, wait 5.6 m) is deliberately visible so
the story reads.

---

## 8. Removed — Interactive Store Snapshot (`StoreSnapshot.jsx`)

**Deleted** in the layout pass, along with `FLOOR_ZONES` / `FLOOR_EMPLOYEES` /
`FLOOR_CUSTOMERS` in `data.js`. It was the single largest consumer of vertical
space on the page — an SVG floor plan with 10 zones, 8 staff dots and 24 customer
dots — and it answered *"which counter needs attention?"* more slowly than the
alert that says so in words. Its zone/coverage story lives on the **Zone Coverage**
subpage (`/activity-monitoring/zones`), which every coverage and queue alert links
to. Recover the component from git history if the spatial view is ever wanted back
(e.g. as a subpage rather than a dashboard band).

---
## 9. Subpages (second build pass)

All module pages share a **tab bar** (`ModuleTabs.jsx`) rendered at the top:
*Dashboard · Attendance · Event Log · Breaks & Idle · Phone Usage · Zone Coverage · Reports*,
plus a **use-case switcher** (Retail ⇄ Corporate). Switching vertical swaps parameters only —
the same module code renders both; tabs/pages gate themselves on the params they need.

| Page | Route | Contents | Dummy data | Future backend |
|---|---|---|---|---|
| Employee Detail | `/activity-monitoring/employee/:id` | header (avatar, role, status, clock-in) · 4 stat tiles (30-day punctuality, avg on-site, breaks/day, phone/week) · today's timeline strip (floor/break/away segments, now-marker) · 30-day presence heatmap · today's events. Reached by clicking any Employee Status row. | `DAY_TIMELINES`, `PROFILE_STATS` | `/activity/employees/:id/day`, `/activity/employees/:id/stats` |
| Breaks & Idle | `/activity-monitoring/breaks` | summary tiles (breaks today, avg vs policy, over-policy names, longest away) · per-employee table with policy bars · stacked floor/break/away distribution chart | `BREAKS` | `/activity/breaks?store&date` |
| Phone Usage | `/activity-monitoring/phone` | policy-aware header (holdSec/requireHand from active vertical) · detection cards with snapshot placeholder, hold time, confidence bar · weekly per-employee counts · 7-day trend | `PHONE_EVENTS`, `PHONE_WEEKLY`, `PHONE_TREND` | `/activity/phone-events`, `/activity/phone-summary` |
| Zone Coverage | `/activity-monitoring/zones` | **retail-only** — hourly zone×coverage matrix (color-scaled cells) · incident list (counter unattended, low activity) with active/resolved chips. On Corporate, page + tab hide (`params.zones` absent) with an explanatory notice instead of a 404. | `ZONE_COVERAGE`, `ZONE_INCIDENTS` | `/activity/zone-coverage`, `/activity/zone-incidents` |
| Reports | `/activity-monitoring/reports` | week selector · summary tiles (team avg score, top performer, needs coaching) · full scorecard table with score bars · CSV export. Score formula: `0.4·onTime + 0.3·hoursVsShift + 0.2·breakCompliance + 0.1·(1−phoneRate), ×100`. | `WEEKLY_REPORT` | `/activity/report?store&from&to` |

New shared plumbing:

- `useCaseStore.js` — persisted vertical selection + `useActivityParams()` (reads
  `moduleParams(useCase, 'employee-productivity')` from the registry — no thresholds
  hardcoded in pages).
- `ModuleTabs.jsx` — tab nav + use-case switcher + `PolicyBanner` (shows the active
  vertical's thresholds on every subpage, so the numbers are explainable).
- `pages-data.js` — dummy data for all subpages, endpoint/field contracts inline.
- `src/use-cases/retail/index.js` — added the retail-only param blocks:
  `zones: { counterUnattendedSec: 300 }`, `queue: { maxQueue: 5, serviceTimeSec: 90 }`.

## 10. UX refinement pass (redundancy + consistency audit)

Reviewed as a store manager would read it; changes applied consistently:

| Change | Why |
|---|---|
| **KPI cards 9 → 8**: *Present Staff* + *Expected Staff* merged into **Staff Present 11 / 12** | Two cards carried one fact; grid is now an even 2×4 (`grid-cols-2 md:grid-cols-4`) |
| Present corrected **10 → 11** | Roster shows 11 arrived (only Divya absent) — the KPI contradicted the list below it |
| Avg Working Hours **6h 12m → 4h 26m** ("so far") | 6h was impossible at the 15:00 dummy "now"; a manager who catches one wrong number distrusts all of them |
| Active Alerts **3 → 6** (2 high · 2 medium · 2 low) | Must always equal the Needs Attention panel count — same data source |
| Global **Filters button/row removed** from the dashboard header | It silently filtered only the Employee Status list; search + status select now live **inside that card**, where they act |
| Feed **status chips removed** | Severity is already carried by each event's icon-tile color; camera·zone moved up beside the name — one line less per row |
| Navigation redundancy (earlier pass) | In-page tab bar deleted; sidebar group is the single nav surface, PolicyBar (thresholds + vertical switcher) is the only in-page chrome |

## 11. Density pass — eye toggles + preview→subpage pattern

The dashboard is a **preview layer**: every widget shows the top of its data and clicks
through to the subpage holding the whole of it.

| Widget | Preview shows | Click-through |
|---|---|---|
| KPI cards | all four | each card links to its detail page (Health→Reports, Present→Attendance, Coverage/Queue→Zones) |
| Needs Attention | all open alerts, severity-ranked, scrolling past ~460 px | "View all N in Event Log →" |
| Employee Status | first 7 rows (searching/filtering shows every match) | "+N more — full Attendance Report →" |
| Recent Activity | latest 8 events along the rail | "View all →" + the trailing "+N earlier →" card → Event Log |
| Analytics charts | nothing until opened; then 4 hourly charts | per-chart "Details →" (Attendance→Report, Traffic→Footfall, Coverage/Queue→Zones) |

> The KPI eye/hide toggle listed here in the original density pass was removed in
> §13 along with the KPI consolidation; `localStorage('dashboard-hidden-kpis')` is
> now an orphan key and safe to drop from any browser that still holds it.

## 12. Backend integration checklist (when the API lands)

1. Replace `data.js` imports with `useQuery` calls per section — endpoints and field
   names are already documented inline in `data.js` (summary, alerts, employees,
   trends, events) and typed in `dto.d.ts`.
2. Read thresholds from `moduleParams(activeUseCase, 'employee-productivity')`; add the
   proposed retail-only params to `src/use-cases/retail/index.js`:
   `zones: { counterUnattendedSec: 300 }`, `queue: { maxQueue: 5, serviceTimeSec: 90 }`.
3. Wire Ack to `aiService.activityAckAlert` + query invalidation (pattern already in
   `AttendanceReport.jsx`).
4. Swap the simulated refresh for `queryClient.invalidateQueries` + a socket-driven
   alert feed.
5. Compute Store Health server-side (weights are policy, not UI).
6. Fetch `TRENDS` **inside** `AnalyticsSection` (or behind its `open` flag) so the
   collapsed default costs no request, not just no render.

## 13. Consolidation pass — 8 KPIs → 4, layout rebuild, collapsible analytics

The page had grown into a wall: nine, then eight KPI cards above a floor plan,
with the alert queue — the only part that asks for a decision — squeezed into a
third of a row. This pass re-ranks the page by what a manager acts on.

| # | Change | Why |
|---|---|---|
| 1 | **KPI cards 8 → 4** (health · present · queue · coverage; corporate gets 3) | Four questions, four numbers. The other four were either not actionable at store level, not realtime, or a second rendering of data already on the page — see the relocation table in §3. |
| 2 | KPI DTO reshaped: `display: 'score' \| 'ratio' \| 'status'`, explicit `trend` | "11 / 12 Scheduled" and "Backed up · 3.2 min" are not the same shape as "87 /100". The data now says how it renders instead of the component sniffing `+` off a string. |
| 3 | **Store Snapshot deleted** (component + `FLOOR_*` data) | Largest consumer of vertical space on the page, slower to read than the alert that names the counter. See §8. |
| 4 | **Needs Attention promoted** to the left ~60 % column, absorbing *Active Alerts* | It is the page's only work queue; it now also carries system/infrastructure warnings and filters by source. One array, one count — the KPI card that could contradict it is gone. |
| 5 | **Employee Status** moved to the right ~40 % column, into the snapshot's slot | Roster is reference material beside the queue, not a peer of it. Gains the `lateBy` tag and `phoneIncidents` flag. |
| 6 | **Recent Activity** moved below the middle row, re-laid out **horizontally** | Context, not a queue. A sideways rail reads as "what just happened" and costs one band instead of a column. |
| 7 | **Analytics collapsed by default**, lazy-mounted behind a Show/Hide toggle | Charts are the least-used part of a realtime page and the most expensive. Collapsed = not mounted (see §7, including the honest note on what this does *not* yet save). |
| 8 | KPI eye/hide toggle removed | A coping mechanism for eight cards; with four curated ones a grid with holes reads as broken. |

**Cross-vertical note:** retail and corporate share these components via
`useModuleData()`, so `corporate-data.js` was reshaped in lockstep. The campus,
school, hostel, hospitality and bank verticals have their own dashboards and are
untouched by this pass.

## 14. Header declutter pass — filters out, context in

The header had grown three dropdowns and a full-width policy strip above the
KPI cards, so the first number on a realtime page sat four bands down. Two of
the three controls were also **inert**: `store` and `shift` were local state
wired to nothing, and `date` reached only the export filename. They looked like
filters and filtered nothing.

| # | Change | Why |
|---|---|---|
| 1 | **Date picker removed** | A realtime page is always *now*. Any other day is a report — Attendance Report and Reports own the date range, and both are one click away. Keeping a date input here promised history the page cannot show. |
| 2 | **Shift dropdown removed**, replaced by the resolved current shift | A shift is roster config, not a viewer's choice. The page reads `params.shifts` and states which crew is on (see §2). Configuring it belongs in `src/use-cases/`, where every other threshold already lives. |
| 3 | **PolicyBar → `PolicyTip`** (one ⓘ on the context line) | Thresholds are read once a month, the numbers every ten minutes. Same list, same source (`policy-items.js`), no full-width band. `PolicyBar` itself is unchanged and still used by the subpages and the Campus dashboard. |
| 4 | **Store selector kept, demoted to scope** | It is the only thing that says *which store these numbers are about*, and a chain manager does switch sites. Restyled as an inline part of the context sentence rather than a third filter-looking dropdown. |
| 5 | **`SHIFTS` deleted from the data layer**; `NOW_IST` + `TODAY` added | Shifts were dummy data pretending to be config. The two new constants are the single dummy clock every widget agrees with, and become the payload's "as of" timestamp later. |

Net effect: the header is two lines instead of four bands, and the KPI cards
move up by roughly 90 px on desktop — the first thing on the page is now the
first thing a manager needs.

**Follow-ups this pass did not take:**

- The seven other dashboards still render hand-rolled `group/info` tooltips
  (`campus`/`school` `KeyMetrics.jsx`, and `LiveOverview.jsx` in bank, campus,
  hospitality, hostel, school). They have the same clipping bug the KPI cards
  had before §13's tooltip fix, and the same `PolicyTip` swap is available to
  them.
- `Refresh` still simulates; wiring it to `queryClient.invalidateQueries` is
  step 4 of §12.

## 15. Layout hardening + Event Logs / Analytics migration

Two jobs in one pass: stop the grid warping, and move the two bottom bands out
to pages that can do them justice.

### 15.1 Grid rigidity

| Area | Rule now | Why |
|---|---|---|
| KPI grid | `grid grid-cols-1 gap-4 md:grid-cols-4` — a fixed track count, never an auto-fit | The row could re-flow to 3+1 or 2+2 as the sidebar collapsed or a band above changed height. Fixed tracks cannot. Corporate keeps a 3-up grid: a fourth empty cell reads as a missing card, not as spacing. |
| KPI card | `flex h-[7.75rem] flex-col`, value block pinned with `mt-auto`, delta row `h-4` | Height is **set**, not inferred. A longer sub-line, a missing trend delta or a two-word status can no longer make one card taller than its neighbours, and nothing added above or below the grid can stretch or collapse the row. `mt-auto` aligns the four cards on a shared baseline rather than merely matching their sizes. |
| Toolbar | `sticky top-[var(--topbar-h)] z-10`, full-bleed band with its own `page-inset-x` | Anything that grows in the toolbar (a filter row, a breach banner) pushes the grid down as one block and scrolls away cleanly, instead of shoving the KPI cards mid-scroll. `z-10` sits **under** the app topbar's `z-20`, so it tucks beneath rather than fighting it. |
| Dual panel | `grid lg:h-[34rem] lg:grid-cols-5`; each panel `min-h-0`, each list `min-h-0 flex-1 overflow-y-auto` | Both panels are locked to the **same** height and scroll internally, so neither list's length can stretch the row or leave the other short. `min-h-0` is what actually lets a flex child shrink to its box — without it the list wins and the panel grows. Single column below `lg`, where a locked height would only waste screen. |

### 15.2 Recent Activity → `/event-logs`

The inline stream is gone; the header carries **Event Logs [n]** with the live
count instead. The destination is the **existing** Event Log page
(`src/modules/event-log/EventLog.jsx`) — it already has the date range,
source filters, search and CSV export that an event stream actually needs, and
an eight-card rail on the dashboard could offer none of them. No second page
was built.

Routing: `/event-logs` is now canonical and `/event-log` redirects to it, so
existing bookmarks keep working. In-app links (`DashboardQuickActions`,
`NeedsAttention`, the sidebar) were repointed at the plural.

### 15.3 Analytics → its own page

`AnalyticsSection.jsx` (the collapsible band from §13) and
`ActivityFeed.jsx` are **deleted**. `PerformanceCharts.jsx` survives unchanged
and is now mounted by the Analytics page, so there is still exactly one chart
definition.

Routes below are as they stand **after §16.1** moved the page under
`/activity-monitoring`; the old top-level paths redirect.

| Route | Tab | Contents |
|---|---|---|
| `/activity-monitoring/analytics` | — | Redirects to `…/analytics/trends`. |
| `…/analytics/trends` | **Today's Trends** (default) | Benchmark tiles — peak occupancy, queue peak, avg coverage, peak staff — each against a 30-day norm, all derived from `TRENDS` so they cannot disagree with the charts below them. Then the four hourly charts. |
| `…/analytics/staff` | Staff | Weekly scorecard (`WEEKLY_REPORT`), today's attendance flags (`EmployeeRow.lateBy` / not-arrived) and the incident log (`PHONE_EVENTS` + staff-source alerts). The analytical read of the two metrics §13 moved onto the roster rows. |
| `…/analytics/traffic` | Traffic & Zones | Hourly counter flow (entries vs wait vs coverage), the zone × hour coverage matrix, and zone incidents. **Retail-only** — gated on `params.zones`, with an explanation rather than a 404, matching the Zone Coverage page. |

Tabs are routes, not local state: each view is linkable, bookmarkable and
back-button-able. The sidebar listed all three as children of an *Analytics*
group here; §16.1 replaced that with a single row, because a sidebar listing
the tabs of one page is just a worse copy of that page's tab strip.

### 15.4 Sidebar bug found on the way

`Sidebar.jsx` filtered every children-group's rows with `allowed(c, true)` —
judging them as AI rows regardless of the group they were in. Every
children-group happened to sit in an AI group, so the hardcoded `true` was
invisible. Analytics lives in *Live & Records*, and on a **curated account**
(one with a `features` list) an untagged row judged as AI is dropped — which
would have silently deleted the entire Analytics group for those accounts.
Now passes the group's real `isAiGroup`; AI groups behave exactly as before.

---

## 16. Clarity pass — navigation, card copy, one type scale

Three complaints, all from watching a store manager read the page: the charts
could not be found, the cards said things a manager would not say out loud, and
the four cards did not agree on what a heading was.

### 16.1 Retail Analytics moves into Activity Monitoring

| | Before | After |
|---|---|---|
| Sidebar | *Live & Records* → **Analytics** group → three children (Today's Trends, Staff, Traffic & Zones) | *AI Intelligence* → **Activity Monitoring** → **Retail Analytics**, one row, between Zone Coverage and Reports |
| Route | `/analytics/:tab` | `/activity-monitoring/analytics/:tab` |
| Page title | "Analytics" | "Retail Analytics" (retail) · "Analytics" (corporate) |

**Why.** *Analytics* is a product-wide word and this page reports on exactly one
module. A manager who wanted their trend charts opened Activity Monitoring —
where Zone Coverage, Breaks & Idle and Zone Headcount already live — did not
find them there, and had no reason to look several groups further down under a
generic heading. The page now sits with the pages it talks about.

The three children went with it. One page with a tab strip does not need three
sidebar rows; that was the sidebar restating a control the page already has,
one click further from the data.

**Nothing 404s.** `/analytics` redirects to the new default view, and
`/analytics/:tab` goes through `LegacyAnalyticsRedirect` in `App.jsx` — a
component rather than a `<Navigate to>`, because `to` takes a literal and
cannot interpolate the matched param, which would have dumped every old
Staff/Traffic bookmark back on Today's Trends.

**Two new child options in `Sidebar.jsx`**, both needed by this one row:

- `matchPrefix` — `childMatches()` compares pathnames exactly, which is right
  for a group whose rows are separate pages. This row points at a bare path
  that only ever redirects, so without a prefix match it would be lit on none
  of its three tabs.
- `labelFor: { corporate: 'Analytics' }` — the page serves the office vertical
  too, and "Retail Analytics" is the wrong row in an office. Resolved in the
  same per-vertical pass that applies `hideFor` / `needsParam`. The alternative
  — two near-identical rows pointing at one route — is worse.

### 16.2 KPI cards: aggregate, plain-language, and clickable

**No names on a top-level card.** *"1 not arrived (Divya)"* singled out one
person on a store-wide summary. It reads as finger-pointing, and it breaks the
moment two people are out: the line has nowhere to grow. The card now shows the
aggregate — badge **2 Pending**, summary **1 Not Arrived · 1 Late** — and the
card itself is the link to Attendance Report, where the names sit next to the
actions a manager can take on them.

> The wording is *Not Arrived*, not *Absent*, because Divya is on the 16:00
> Evening shift and the dummy clock is 15:00. She is not late; she is not due.

**No single named counter, either.** *"Billing 1 over limit — 7 waiting
(max 5)"* and *"Billing 3 unattended 6m"* have the same defect one level up:
they report one instance of a thing there can be several of. Both became
counts — **1 of 3 counters over limit**, **1 Unattended** — and both named
incidents already existed as `ATTENTION` rows, which is where a manager can see
the camera, the duration and the Ack button.

**No jargon.** *"Backed up"* is how the queue subsystem describes itself, not
how a store manager describes a problem. The state is now **High Wait Times**,
and it moved off the headline: the `'status'` display kind made the *state* the
big type and pushed the actual measurement into a footnote. Queue Health now
renders like its neighbours — **3.2** min avg wait as the metric, the state as a
badge — so all four cards share one value baseline.

**Say what the percentage means.** *"91% staffed today"* never said staffed by
what measure, over what window. It is now **91% average coverage today**, with
the live state carried by the value (**2 / 3 Counters Active** — the unit names
the thing counted, where a bare "Open" made the reader guess) and the breach by
the badge (**1 Unattended**).

**Every card is a shortcut button.** They were already `<Link>`s, but the only
affordance was a cursor and a `title="Open details"` that did not say where.
Each card now carries a hover arrow, a focus ring, and an `aria-label` naming
the destination; the ⓘ tooltip states it too. Targets:

| Card | Opens | Because |
|---|---|---|
| Store Health Score | Reports | the scorecard the composite is computed from |
| Staff Present | Attendance Report | the names behind "2 Pending", and the actions |
| Queue Health | Zone Headcount | live queue length per counter *(was Zone Coverage)* |
| Counter Coverage | Zone Coverage | which counter is unattended, and for how long |
| Desk Occupancy | Zone Headcount | the office analogue of coverage |

**DTO changes** (`dto.d.ts`): `KpiDisplay` drops `'status'` and gains
`'measure'`; `StatusKpi` becomes `MeasureKpi`; every card gains
`badge: { text, tone } | null`. The badge carries its **own** tone because a
healthy card can still owe the manager a flag — Staff Present is `tone: 'good'`
at 11/12 and still badges an amber "2 Pending". The `sub` field's doc comment
now states the aggregate-only contract; it is enforced by review, since no type
can spell "do not put a person's name here".

### 16.3 One type scale on the card

The card was mixing roles: an 11px `text-caption` label, a 20px value, and a
10px `text-micro` sub-line — a token whose 0.08em tracking exists for uppercase
eyebrow labels, used here for a sentence. Three sizes, none of them the size
their role called for.

| Role | Token | Value |
|---|---|---|
| Primary metric value | `text-metric-lg` | 28 / 32, 700 |
| Card label | `text-label` | 14 / 20, 600 |
| Subtext, helper | `text-small` + `text-fg-muted` | 12 / 16, 400 |
| Status badge | `text-caption` | 11 / 14, 600 |

`--text-metric-lg` and `--text-label` are **new steps on the product-wide scale**
in `src/index.css`, not local overrides — the rule that a page picks a semantic
level and never a measurement still holds, so the missing levels had to be
added to the scale rather than worked around with `text-[28px]`. The two panel
headings below the grid ("Needs Attention", "Employee Status") moved from
`text-body font-bold` (13/700, off-scale for a heading) to `text-heading`, the
system's card/panel heading.

Card height went **7.75rem → 9.25rem** to hold the taller value and label. It is
still *set*, not inferred, for the §15.1 reasons: content may not decide how
tall a card in that row is.

