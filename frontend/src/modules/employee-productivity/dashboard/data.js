import { withCameraStreams } from './cameraStreams'
// ─────────────────────────────────────────────────────────────────────────────
// Activity Monitoring Dashboard — DUMMY DATA LAYER (frontend-only build).
//
// There is NO backend yet. Every constant below is a realistic stand-in for a
// future activity-monitor API response. Each block documents the backend
// fields that will eventually populate it and (where numbers are derived) the
// formula. Shapes are typed in ./dto.d.ts — annotate any new export so the
// editor checks the dummy data against the contract. The prose contract lives
// in docs/retail-activity-monitoring.md — keep the three in sync.
//
// Times are IST wall-clock strings because the dashboard (like the rest of the
// module) renders IST regardless of browser timezone. Dummy "now" is 15:00.
// ─────────────────────────────────────────────────────────────────────────────

// Header selectors ------------------------------------------------------------
// Backend: GET /stores → [{ storeId, name, city }]
/** @type {import('./dto').SiteOption[]} */
export const STORES = [
  { id: 'st-01', label: 'Phoenix Mall — Pune' },
  { id: 'st-02', label: 'MG Road — Bengaluru' },
  { id: 'st-03', label: 'Cyber Hub — Gurugram' },
]

// The dummy clock every number on this page is consistent with. One constant,
// so the header, the KPI subs and the feed timestamps cannot tell different
// stories. When the API lands this becomes the server's "as of" timestamp.
//
// Shifts are NOT here: they are operator config, read from
// moduleParams(useCase, 'employee-productivity').shifts — see ../shifts.js.
export const NOW_IST = '15:00'
export const TODAY = '2026-07-16'

// SECTION 1 — Top KPI cards (FOUR, deliberately) ------------------------------
// Backend: GET /activity/summary?store&date&shift → one object with the raw
// fields named in `fields`; the frontend (or backend) applies `formula`.
//
// The row answers four questions and nothing else: is the store healthy, is
// the team here, are customers waiting, are the tills manned. Everything that
// used to sit here moved to where it is actionable — phone incidents and
// lateness onto the employee row, alerts into Needs Attention, avg working
// hours out of realtime entirely (it belongs to the Reports export).
//
// EACH CARD CARRIES EXACTLY THREE THINGS (§16): a value, a `badge` naming the
// state in plain words, and ONE line of aggregate summary — `sub` as a
// sentence, `foot` as the same fact split into key and value for the card's
// footer. Two rules hold that line, and both exist because the earlier copy
// broke them:
//
//   1. NO NAMES, NO SINGLE INSTANCES. "1 not arrived (Divya)" and "Billing 1
//      over limit" put one person / one counter on a store-wide card: it reads
//      as finger-pointing, and it silently breaks the moment a second person
//      is absent or a second counter backs up. Cards aggregate ("1 Not Arrived
//      · 1 Late", "1 of 3 counters over limit"); the individual rows live in
//      ATTENTION below and on the drill-down page the card links to.
//   2. NO JARGON. `badge` carries the words a store manager would use —
//      "High Wait Times", not "Backed up".
/** @type {import('./dto').KpiCard[]} */
export const KPIS = [
  {
    key: 'health', label: 'Store Health', display: 'score',
    value: 87, unit: '/100',
    badge: { text: 'Healthy', tone: 'good' },
    sub: 'Counter coverage is the weakest area', tone: 'good',
    foot: { label: 'Counter coverage', value: 'Weakest area', tone: 'warn' },
    delta: '+3 vs yesterday', trend: 'up',
    purpose: 'Single number: is the store operating normally right now?',
    formula: '0.30·attendanceRate + 0.25·coverageRate + 0.20·queueScore + 0.15·(1 − phoneIncidentRate) + 0.10·breakComplianceRate, ×100',
    fields: ['attendanceRate', 'coverageRate', 'queueScore', 'phoneIncidentRate', 'breakComplianceRate'],
  },
  {
    // "2 Pending" is the aggregate; the breakdown under it stays name-free and
    // stays correct at any roster size. Divya is on the 16:00 Evening shift, so
    // she reads as NOT ARRIVED rather than absent — the wording follows the
    // data instead of accusing someone who is not due in yet.
    key: 'present', label: 'Staff Present', display: 'ratio',
    value: 11, total: 12, unit: 'Scheduled',
    badge: { text: '2 Pending', tone: 'warn' },
    sub: '1 Not Arrived · 1 Late', tone: 'good',
    foot: { label: 'Status', value: '1 Not Arrived · 1 Late', tone: 'neutral' },
    delta: null, trend: null,
    purpose: 'Headcount detected on-site vs the roster for the selected shift. The badge counts everyone not yet accounted for; open the card for the names.',
    formula: 'count(currently_inside = true) / count(roster where shift = selected); pending = count(status in {notarrived, late})',
    fields: ['employees[].currently_inside', 'employees[].status', 'roster[].employeeId', 'roster[].shift'],
  },
  {
    // The wait time is the metric; the state is a badge in plain words. The
    // counter that tripped the threshold is an ATTENTION row, not card copy.
    key: 'queue', label: 'Queue Wait', display: 'measure',
    value: 3.2, unit: 'min avg wait',
    badge: { text: 'High Wait Times', tone: 'bad' },
    sub: '1 of 3 counters over limit', tone: 'bad',
    foot: { label: 'Counter limit', value: '1 of 3 over limit', tone: 'bad' },
    delta: null, trend: null,
    purpose: 'Average customer wait estimated from queue-length detections, plus how many billing counters are past their queue limit right now.',
    formula: 'wait = avg(queueLength × serviceTimePerCustomer); overLimit = count(counters where queue_length > policy.maxQueue)',
    fields: ['counters[].queue_length', 'policy.serviceTimeSec', 'policy.maxQueue'],
  },
  {
    // "91% staffed today" never said what the percentage measured or over what
    // window. It is spelled out now, and the live breach is a count, not a
    // counter name — three unattended counters would not have fitted the old
    // copy, and naming one of them told the manager least.
    key: 'coverage', label: 'Counters', display: 'ratio',
    value: 2, total: 3, unit: 'Counters Active',
    badge: { text: '1 Unattended', tone: 'warn' },
    sub: '91% average coverage today', tone: 'warn',
    foot: { label: 'Coverage', value: '91% average today', tone: 'neutral' },
    delta: null, trend: null,
    purpose: 'Billing counters with at least one staff member detected right now, out of the counters open for this shift. The sub-line is the same ratio averaged over the hours traded today.',
    formula: 'count(counters where open and staffed_now) / count(counters where open); avgToday = sum(staffed_minutes) / (count(open) × elapsedOpenMinutes)',
    fields: ['counters[].open', 'counters[].staffed_now', 'counters[].staffed_minutes', 'elapsedOpenMinutes'],
  },
]

// SECTION 2 — Needs Attention panel -------------------------------------------
// The dashboard's primary alert feed: coverage breaches, queue-threshold trips,
// staff-policy alerts and infrastructure warnings in one severity-ranked queue.
// It absorbed the old "Active Alerts" KPI — the count chip in the panel header
// IS that number, so the two can no longer disagree.
//
// Backend: GET /activity/alerts?store&date&acknowledged=false
// fields: alertId, type, source, severity, employeeId|null, zoneId, started_ts,
//         duration_sec, camera, acknowledged
/** @type {import('./dto').AttentionAlert[]} */
export const ATTENTION = withCameraStreams([
  { id: 'a1', type: 'counter-unattended', source: 'coverage', severity: 'high',   title: 'Counter unattended',
    employee: null,            location: 'Billing 3',      camera: 'CAM-07', duration: '6m 20s',     since: '14:32' },
  { id: 'a2', type: 'queue-exceeded',     source: 'queue',    severity: 'high',   title: 'Queue exceeded',
    employee: 'Priya Sharma',  location: 'Billing 1',      camera: 'CAM-05', duration: '7 waiting',  since: '14:35' },
  { id: 'a3', type: 'phone-detected',     source: 'staff',    severity: 'medium', title: 'Phone detected on floor',
    employee: 'Sneha Patil',   location: 'Apparel',        camera: 'CAM-02', duration: '48s',        since: '14:29' },
  { id: 'a4', type: 'camera-offline',     source: 'system',   severity: 'medium', title: 'Camera offline',
    employee: null,            location: 'Stockroom',      camera: 'CAM-08', duration: '12m',        since: '14:23' },
  { id: 'a5', type: 'long-break',         source: 'staff',    severity: 'low',    title: 'Lunch break overstayed',
    employee: 'Anjali Mehta',  location: 'Staff Room',     camera: 'CAM-04', duration: '46m of 45m', since: '14:14' },
  { id: 'a6', type: 'late-arrival',       source: 'staff',    severity: 'low',    title: 'Late arrival',
    employee: 'Meena Iyer',    location: 'Entrance',       camera: 'CAM-01', duration: '26m late',   since: '10:41' },
  { id: 'a7', type: 'coverage-low',       source: 'coverage', severity: 'low',    title: 'Low zone activity',
    employee: null,            location: 'Home & Kitchen', camera: 'CAM-09', duration: '38m',        since: '13:58' },
], TODAY)

// SECTION 3 — Employee status list --------------------------------------------
// Carries the two metrics that lost their KPI cards:
//   lateBy         — was "On-Time Attendance"; renders as a "Late 26m" tag.
//   phoneIncidents — was "Phone Incidents Today"; renders as a flag badge.
// Both are per-person facts, so a manager sees them next to the name they have
// to act on rather than as a store-wide number with no handle.
//
// Backend: GET /activity/employees?store&date&shift
// fields: employeeId, name, role, current_status, current_zone, shift,
//         clock_in_ts, total_inside_sec, late_by_sec, phone_incident_count,
//         avatar_url
/** @type {import('./dto').EmployeeRow[]} */
export const EMPLOYEES = [
  { id: 'e01', name: 'Priya Sharma',   role: 'Cashier',         zone: 'Billing 1',        shift: 'Full Day', status: 'onfloor',    clockIn: '09:58', worked: '4h 42m', lateBy: null,  phoneIncidents: 0 },
  { id: 'e02', name: 'Rahul Verma',    role: 'Cashier',         zone: 'Billing 2',        shift: 'Full Day', status: 'onfloor',    clockIn: '10:02', worked: '4h 35m', lateBy: null,  phoneIncidents: 1 },
  { id: 'e03', name: 'Anjali Mehta',   role: 'Sales Associate', zone: 'Off-floor',        shift: 'Morning',  status: 'break',      clockIn: '10:05', worked: '3h 51m', lateBy: null,  phoneIncidents: 0 },
  { id: 'e04', name: 'Vikram Singh',   role: 'Greeter',         zone: 'Entrance',         shift: 'Full Day', status: 'onfloor',    clockIn: '09:55', worked: '4h 48m', lateBy: null,  phoneIncidents: 0 },
  { id: 'e05', name: 'Sneha Patil',    role: 'Sales Associate', zone: 'Apparel',          shift: 'Morning',  status: 'away',       clockIn: '10:07', worked: '3h 58m', lateBy: null,  phoneIncidents: 2 },
  { id: 'e06', name: 'Arjun Nair',     role: 'Floor Staff',     zone: 'Grocery Aisles',   shift: 'Full Day', status: 'onfloor',    clockIn: '10:01', worked: '4h 30m', lateBy: null,  phoneIncidents: 0 },
  { id: 'e07', name: 'Kavita Joshi',   role: 'Service Desk',    zone: 'Customer Service', shift: 'Full Day', status: 'onfloor',    clockIn: '09:59', worked: '4h 40m', lateBy: null,  phoneIncidents: 0 },
  { id: 'e08', name: 'Rohit Kulkarni', role: 'Stock Handler',   zone: 'Stockroom',        shift: 'Morning',  status: 'onfloor',    clockIn: '10:04', worked: '4h 22m', lateBy: null,  phoneIncidents: 0 },
  { id: 'e09', name: 'Meena Iyer',     role: 'Cashier',         zone: 'Billing 3',        shift: 'Full Day', status: 'late',       clockIn: '10:41', worked: '3h 54m', lateBy: '26m', phoneIncidents: 1 },
  { id: 'e10', name: 'Suresh Yadav',   role: 'Security',        zone: 'Electronics',      shift: 'Full Day', status: 'onfloor',    clockIn: '09:47', worked: '4h 55m', lateBy: null,  phoneIncidents: 0 },
  { id: 'e11', name: 'Divya Reddy',    role: 'Sales Associate', zone: '—',                shift: 'Evening',  status: 'notarrived', clockIn: null,    worked: '—',      lateBy: null,  phoneIncidents: 0 },
  { id: 'e12', name: 'Amit Chauhan',   role: 'Floor Staff',     zone: 'Grocery Aisles',   shift: 'Full Day', status: 'onfloor',    clockIn: '10:00', worked: '4h 33m', lateBy: null,  phoneIncidents: 0 },
]

// SECTION 4 — Recent activity feed --------------------------------------------
// Backend: GET /activity/events?store&date&limit — same stream the Event Log
// page consumes, trimmed to the latest N. Fields: eventId, ts, type,
// employeeId|null, camera, zoneId, meta (per-type details).
/** @type {import('./dto').FeedEvent[]} */
export const FEED = [
  { id: 'f01', time: '14:35', type: 'queue-alert',        employee: null,             camera: 'CAM-05', zone: 'Billing 1',      status: 'alert',  text: 'Queue length reached 7 (limit 5)' },
  { id: 'f02', time: '14:32', type: 'counter-unattended', employee: 'Meena Iyer',     camera: 'CAM-07', zone: 'Billing 3',      status: 'alert',  text: 'Cashier left counter — no staff detected' },
  { id: 'f03', time: '14:29', type: 'phone-usage',        employee: 'Sneha Patil',    camera: 'CAM-02', zone: 'Apparel',        status: 'warn',   text: 'Phone in hand for 48s on floor' },
  { id: 'f04', time: '14:14', type: 'break-start',        employee: 'Anjali Mehta',   camera: 'CAM-04', zone: 'Staff Room',     status: 'info',   text: 'Lunch break started (limit 45m)' },
  { id: 'f05', time: '13:58', type: 'low-activity',       employee: null,             camera: 'CAM-09', zone: 'Home & Kitchen', status: 'warn',   text: 'No staff activity for 38m' },
  { id: 'f06', time: '13:42', type: 'employee-exit',      employee: 'Rohit Kulkarni', camera: 'CAM-01', zone: 'Entrance',       status: 'info',   text: 'Stepped out (returned 13:51)' },
  { id: 'f07', time: '12:37', type: 'break-end',          employee: 'Arjun Nair',     camera: 'CAM-04', zone: 'Staff Room',     status: 'info',   text: 'Break ended — 9m (within policy)' },
  { id: 'f08', time: '10:41', type: 'employee-entry',     employee: 'Meena Iyer',     camera: 'CAM-01', zone: 'Entrance',       status: 'warn',   text: 'Clock-in 10:41 — 26m past cutoff' },
  { id: 'f09', time: '10:05', type: 'employee-entry',     employee: 'Anjali Mehta',   camera: 'CAM-01', zone: 'Entrance',       status: 'ok',     text: 'Clock-in on time' },
  { id: 'f10', time: '09:55', type: 'employee-entry',     employee: 'Vikram Singh',   camera: 'CAM-01', zone: 'Entrance',       status: 'ok',     text: 'Clock-in on time' },
]

// SECTION 5 — Analytics charts (collapsed by default) -------------------------
// Backend: GET /activity/trends?store&date → hourly buckets. Fields per bucket:
//   hour, present_staff, expected_staff, customer_entries (footfall line-cross
//   count), coverage_pct, avg_queue_wait_min
// Only rendered once the manager opens the Analytics section, so the first
// paint of the dashboard carries no chart-library work at all.
/** @type {import('./dto').TrendBucket[]} */
export const TRENDS = [
  { h: '10:00', present: 9,  expected: 11, traffic: 42,  coverage: 100, wait: 1.2 },
  { h: '11:00', present: 11, expected: 12, traffic: 78,  coverage: 100, wait: 2.1 },
  { h: '12:00', present: 11, expected: 12, traffic: 116, coverage: 96,  wait: 3.4 },
  { h: '13:00', present: 10, expected: 12, traffic: 134, coverage: 92,  wait: 4.8 },
  { h: '14:00', present: 10, expected: 12, traffic: 121, coverage: 84,  wait: 5.6 },
  { h: '15:00', present: 10, expected: 12, traffic: 98,  coverage: 91,  wait: 3.2 },
]

// Shared status → badge styling (single source so list and feed agree).
/** @type {import('./dto').StatusMetaMap} */
export const STATUS_META = {
  onfloor:    { label: 'On Floor',    cls: 'bg-success-soft text-success-ink ring-success-line', dot: '#10b981' },
  break:      { label: 'Break',       cls: 'bg-warning-soft text-warning-ink ring-warning-line', dot: '#f59e0b' },
  away:       { label: 'Away',        cls: 'bg-brand-soft text-brand-ink ring-brand-line',       dot: '#fb923c' },
  late:       { label: 'Late',        cls: 'bg-danger-soft text-danger-ink ring-danger-line',    dot: '#f43f5e' },
  notarrived: { label: 'Not Arrived', cls: 'bg-surface-muted text-fg-muted ring-line',           dot: '#94a3b8' },
}
