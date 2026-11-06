// Dummy data for the Activity Monitoring SUBPAGES (frontend-only build).
// Same contract style as dashboard/data.js: each block names the future
// backend endpoint + fields beside the dummy values.
// Full spec: docs/retail-activity-monitoring.md.

// ── Employee day timelines (Employee Detail) ─────────────────────────────────
// Backend: GET /activity/employees/:id/day?date → ordered presence segments
// derived from sightings + breakGapSec policy.
// fields: segments[]{ from, to, kind: floor|break|away }, clock_in_ts
// Store hours 10:00–22:00; dummy "now" is 15:00.
export const DAY_TIMELINES = {
  e01: [{ s: '09:58', e: '12:10', k: 'floor' }, { s: '12:10', e: '12:22', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '12:22', e: '15:00', k: 'floor' }],
  e02: [{ s: '10:02', e: '11:45', k: 'floor' }, { s: '11:45', e: '11:54', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '11:54', e: '15:00', k: 'floor' }],
  e03: [{ s: '10:05', e: '12:30', k: 'floor' }, { s: '12:30', e: '12:41', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '12:41', e: '14:14', k: 'floor' }, { s: '14:14', e: '15:00', k: 'break', bt: 'lunch', at: 'Staff Room · CAM-04', note: 'Scheduled break' }],
  e04: [{ s: '09:55', e: '13:02', k: 'floor' }, { s: '13:02', e: '13:11', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '13:11', e: '15:00', k: 'floor' }],
  e05: [{ s: '10:07', e: '12:55', k: 'floor' }, { s: '12:55', e: '13:04', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '13:04', e: '14:20', k: 'floor' }, { s: '14:20', e: '15:00', k: 'away', at: 'Apparel · CAM-02', note: 'Left floor — not seen on any camera' }],
  e06: [{ s: '10:01', e: '12:28', k: 'floor' }, { s: '12:28', e: '12:37', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '12:37', e: '15:00', k: 'floor' }],
  e07: [{ s: '09:59', e: '12:05', k: 'floor' }, { s: '12:05', e: '12:16', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '12:16', e: '15:00', k: 'floor' }],
  e08: [{ s: '10:04', e: '13:42', k: 'floor' }, { s: '13:42', e: '13:51', k: 'away', at: 'Entrance · CAM-01', note: 'Stepped out of the store' }, { s: '13:51', e: '15:00', k: 'floor' }],
  e09: [{ s: '10:41', e: '13:20', k: 'floor' }, { s: '13:20', e: '13:31', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '13:31', e: '14:32', k: 'floor' }, { s: '14:32', e: '15:00', k: 'away', at: 'Billing 3 · CAM-07', note: 'Left counter — no staff detected' }],
  e10: [{ s: '09:47', e: '12:50', k: 'floor' }, { s: '12:50', e: '12:58', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '12:58', e: '15:00', k: 'floor' }],
  e11: [], // not arrived
  e12: [{ s: '10:00', e: '12:44', k: 'floor' }, { s: '12:44', e: '12:53', k: 'break', bt: 'tea', at: 'Staff Room · CAM-04', note: 'Scheduled break' }, { s: '12:53', e: '15:00', k: 'floor' }],
}

// 30-day rollup per employee (Employee Detail header stats).
// Backend: GET /activity/employees/:id/stats?days=30
// fields: punctuality_pct, avg_inside_sec, avg_break_min_per_day,
//         phone_incidents_per_week, days_present
export const PROFILE_STATS = {
  e01: { punctuality: 97, avgHours: '8h 10m', breaksPerDay: '2 · 16m', phonePerWeek: 0, daysPresent: 26 },
  e02: { punctuality: 93, avgHours: '8h 02m', breaksPerDay: '2 · 14m', phonePerWeek: 1, daysPresent: 25 },
  e03: { punctuality: 90, avgHours: '7h 41m', breaksPerDay: '3 · 28m', phonePerWeek: 1, daysPresent: 24 },
  e04: { punctuality: 100, avgHours: '8h 21m', breaksPerDay: '2 · 15m', phonePerWeek: 0, daysPresent: 26 },
  e05: { punctuality: 88, avgHours: '7h 34m', breaksPerDay: '3 · 24m', phonePerWeek: 4, daysPresent: 25 },
  e06: { punctuality: 95, avgHours: '8h 05m', breaksPerDay: '2 · 17m', phonePerWeek: 0, daysPresent: 26 },
  e07: { punctuality: 98, avgHours: '8h 12m', breaksPerDay: '2 · 18m', phonePerWeek: 0, daysPresent: 26 },
  e08: { punctuality: 92, avgHours: '7h 55m', breaksPerDay: '2 · 13m', phonePerWeek: 1, daysPresent: 24 },
  e09: { punctuality: 71, avgHours: '7h 18m', breaksPerDay: '3 · 26m', phonePerWeek: 3, daysPresent: 23 },
  e10: { punctuality: 100, avgHours: '8h 30m', breaksPerDay: '2 · 12m', phonePerWeek: 0, daysPresent: 26 },
  e11: { punctuality: 82, avgHours: '7h 26m', breaksPerDay: '2 · 20m', phonePerWeek: 2, daysPresent: 22 },
  e12: { punctuality: 94, avgHours: '8h 00m', breaksPerDay: '2 · 15m', phonePerWeek: 1, daysPresent: 25 },
}

// ── Breaks & idle (Activity Breakdown) ──────────────────────────────────────
// Backend: GET /activity/breaks?store&date → per-employee break/away rollup.
// fields: employeeId, break_count, break_total_min, longest_away_min,
//         last_seen_camera, floor_pct, break_pct, away_pct
export const BREAKS = [
  { id: 'e01', name: 'Priya Sharma',   count: 1, totalMin: 12, longestAwayMin: 0,  lastSeen: 'CAM-05', floor: 93, brk: 4,  away: 3 },
  { id: 'e02', name: 'Rahul Verma',    count: 1, totalMin: 9,  longestAwayMin: 0,  lastSeen: 'CAM-06', floor: 94, brk: 3,  away: 3 },
  { id: 'e03', name: 'Anjali Mehta',   count: 2, totalMin: 57, longestAwayMin: 46, lastSeen: 'CAM-04', floor: 77, brk: 19, away: 4 },
  { id: 'e04', name: 'Vikram Singh',   count: 1, totalMin: 9,  longestAwayMin: 0,  lastSeen: 'CAM-01', floor: 95, brk: 3,  away: 2 },
  { id: 'e05', name: 'Sneha Patil',    count: 1, totalMin: 9,  longestAwayMin: 40, lastSeen: 'CAM-02', floor: 82, brk: 3,  away: 15 },
  { id: 'e06', name: 'Arjun Nair',     count: 1, totalMin: 9,  longestAwayMin: 0,  lastSeen: 'CAM-03', floor: 94, brk: 3,  away: 3 },
  { id: 'e07', name: 'Kavita Joshi',   count: 1, totalMin: 11, longestAwayMin: 0,  lastSeen: 'CAM-08', floor: 93, brk: 4,  away: 3 },
  { id: 'e08', name: 'Rohit Kulkarni', count: 0, totalMin: 0,  longestAwayMin: 9,  lastSeen: 'CAM-01', floor: 94, brk: 0,  away: 6 },
  { id: 'e09', name: 'Meena Iyer',     count: 1, totalMin: 11, longestAwayMin: 28, lastSeen: 'CAM-07', floor: 79, brk: 4,  away: 17 },
  { id: 'e10', name: 'Suresh Yadav',   count: 1, totalMin: 8,  longestAwayMin: 0,  lastSeen: 'CAM-03', floor: 95, brk: 3,  away: 2 },
  { id: 'e12', name: 'Amit Chauhan',   count: 1, totalMin: 9,  longestAwayMin: 0,  lastSeen: 'CAM-03', floor: 94, brk: 3,  away: 3 },
]

// ── Phone usage ──────────────────────────────────────────────────────────────
// Backend: GET /activity/phone-events?store&from&to — detections past
// policy.phone.holdSec with requireHand satisfied.
// fields: eventId, ts, employeeId, camera, zoneId, hold_sec, confidence,
//         snapshot_url, clip_url
// `area` buckets the location for the page's Store Area filter
// (billing | floor | stockroom). `time` / `zone` are the short forms the
// Analytics staff tab still reads.
export const PHONE_EVENTS = [
  { id: 'p1', date: '2026-07-16', ts: '14:29:12', time: '14:29', employee: 'Sneha Patil',  camera: 'CAM-02', zone: 'Apparel',     location: 'Aisle 5 - Apparel',     area: 'floor',     holdSec: 48,  confidence: 0.94 },
  { id: 'p2', date: '2026-07-16', ts: '14:22:05', time: '14:22', employee: 'Meena Iyer',   camera: 'CAM-07', zone: 'Billing 3',   location: 'Billing Counter 3',     area: 'billing',   holdSec: 75,  confidence: 0.91 },
  { id: 'p3', date: '2026-07-16', ts: '13:12:40', time: '13:12', employee: 'Rahul Verma',  camera: 'CAM-12', zone: 'Electronics', location: 'Aisle 3 - Electronics', area: 'floor',     holdSec: 18,  confidence: 0.89 },
  { id: 'p4', date: '2026-07-16', ts: '12:03:18', time: '12:03', employee: 'Sneha Patil',  camera: 'CAM-02', zone: 'Apparel',     location: 'Aisle 5 - Apparel',     area: 'floor',     holdSec: 65,  confidence: 0.97 },
  { id: 'p5', date: '2026-07-16', ts: '11:47:02', time: '11:47', employee: 'Anjali Mehta', camera: 'CAM-09', zone: 'Stockroom',   location: 'Stockroom',             area: 'stockroom', holdSec: 140, confidence: 0.86 },
  { id: 'p6', date: '2026-07-16', ts: '11:21:55', time: '11:21', employee: 'Rahul Verma',  camera: 'CAM-06', zone: 'Billing 2',   location: 'Billing Counter 2',     area: 'billing',   holdSec: 12,  confidence: 0.88 },
  { id: 'p7', date: '2026-07-16', ts: '10:36:09', time: '10:36', employee: 'Meena Iyer',   camera: 'CAM-05', zone: 'Billing 1',   location: 'Billing Counter 1',     area: 'billing',   holdSec: 22,  confidence: 0.92 },
  { id: 'y1', date: '2026-07-15', ts: '20:14:33', time: '20:14', employee: 'Sneha Patil',  camera: 'CAM-02', zone: 'Apparel',     location: 'Aisle 5 - Apparel',     area: 'floor',     holdSec: 95,  confidence: 0.95 },
  { id: 'y2', date: '2026-07-15', ts: '18:02:11', time: '18:02', employee: 'Anjali Mehta', camera: 'CAM-09', zone: 'Stockroom',   location: 'Stockroom',             area: 'stockroom', holdSec: 34,  confidence: 0.84 },
  { id: 'y3', date: '2026-07-15', ts: '16:40:27', time: '16:40', employee: 'Rahul Verma',  camera: 'CAM-05', zone: 'Billing 1',   location: 'Billing Counter 1',     area: 'billing',   holdSec: 9,   confidence: 0.87 },
  { id: 'y4', date: '2026-07-15', ts: '12:55:48', time: '12:55', employee: 'Meena Iyer',   camera: 'CAM-12', zone: 'Electronics', location: 'Aisle 3 - Electronics', area: 'floor',     holdSec: 41,  confidence: 0.9 },
]

// Backend: GET /activity/phone-summary?store&days=7 → per-employee weekly count
export const PHONE_WEEKLY = [
  { name: 'Sneha Patil', total: 9, trend: 'up' },
  { name: 'Meena Iyer',  total: 5, trend: 'flat' },
  { name: 'Rahul Verma', total: 2, trend: 'down' },
  { name: 'Anjali Mehta', total: 1, trend: 'flat' },
]

// Daily counts, last 7 days (chart)
export const PHONE_TREND = [
  { d: 'Thu', n: 2 }, { d: 'Fri', n: 4 }, { d: 'Sat', n: 6 }, { d: 'Sun', n: 5 },
  { d: 'Mon', n: 1 }, { d: 'Tue', n: 3 }, { d: 'Wed', n: 4 },
]

// ── Zone coverage (retail-only) ──────────────────────────────────────────────
// Backend: GET /activity/zone-coverage?store&date → per-zone hourly staffed %.
// fields: zoneId, kind, hourly[]{ hour, staffed_pct, staff_minutes }
// Hours shown: store open 10:00 → dummy "now" 15:00.
export const ZONE_HOURS_LABELS = ['10:00', '11:00', '12:00', '13:00', '14:00']
export const ZONE_COVERAGE = [
  { zone: 'Billing 1',        kind: 'counter', hours: [100, 100, 100, 95, 88] },
  { zone: 'Billing 2',        kind: 'counter', hours: [100, 100, 92, 90, 100] },
  { zone: 'Billing 3',        kind: 'counter', hours: [100, 96, 100, 74, 47] },
  { zone: 'Entrance',         kind: 'zone',    hours: [100, 100, 100, 100, 100] },
  { zone: 'Customer Service', kind: 'zone',    hours: [100, 100, 91, 100, 100] },
  { zone: 'Apparel',          kind: 'zone',    hours: [88, 95, 100, 82, 64] },
  { zone: 'Electronics',      kind: 'zone',    hours: [92, 100, 96, 100, 100] },
  { zone: 'Grocery Aisles',   kind: 'zone',    hours: [100, 100, 100, 96, 100] },
  { zone: 'Home & Kitchen',   kind: 'zone',    hours: [76, 81, 64, 22, 8] },
]

// Live zone state for the Zone Coverage page — who is on post in each zone
// right now, how busy it is, and how the last hour went.
// Backend: GET /activity/zone-status?store (polled / pushed) →
// fields: zoneId, kind, staff_on_post[], staff_required, occupancy, capacity,
//         camera, unattended_since|null, last_hour_staffed_pct
// Names match EMPLOYEES in dashboard/data.js; lastHourPct is the matrix's
// latest column.
export const ZONE_LIVE = [
  { zone: 'Billing 1',        kind: 'counter', camera: 'CAM-05', staff: ['Priya Sharma'],                required: 1, occupancy: 7,  capacity: 15, unattendedSince: null,    lastHourPct: 88 },
  { zone: 'Billing 2',        kind: 'counter', camera: 'CAM-06', staff: ['Rahul Verma'],                 required: 1, occupancy: 4,  capacity: 15, unattendedSince: null,    lastHourPct: 100 },
  { zone: 'Billing 3',        kind: 'counter', camera: 'CAM-07', staff: [],                              required: 1, occupancy: 3,  capacity: 15, unattendedSince: '14:32', lastHourPct: 47 },
  { zone: 'Entrance',         kind: 'zone',    camera: 'CAM-01', staff: ['Vikram Singh'],                required: 1, occupancy: 12, capacity: 40, unattendedSince: null,    lastHourPct: 100 },
  { zone: 'Customer Service', kind: 'zone',    camera: 'CAM-08', staff: ['Kavita Joshi'],                required: 1, occupancy: 2,  capacity: 10, unattendedSince: null,    lastHourPct: 100 },
  { zone: 'Apparel',          kind: 'zone',    camera: 'CAM-02', staff: [],                              required: 1, occupancy: 9,  capacity: 60, unattendedSince: '14:44', lastHourPct: 64 },
  { zone: 'Electronics',      kind: 'zone',    camera: 'CAM-12', staff: ['Suresh Yadav'],                required: 1, occupancy: 6,  capacity: 40, unattendedSince: null,    lastHourPct: 100 },
  { zone: 'Grocery Aisles',   kind: 'zone',    camera: 'CAM-13', staff: ['Arjun Nair', 'Amit Chauhan'],  required: 2, occupancy: 18, capacity: 90, unattendedSince: null,    lastHourPct: 100 },
  { zone: 'Home & Kitchen',   kind: 'zone',    camera: 'CAM-09', staff: [],                              required: 1, occupancy: 5,  capacity: 30, unattendedSince: '13:58', lastHourPct: 8 },
]

// Backend: GET /activity/zone-incidents?store&from&to
// fields: incidentId, zoneId, type, started_ts, duration_sec, resolved
export const ZONE_INCIDENTS = [
  { id: 'z5', zone: 'Apparel',        type: 'Zone unattended',    from: '14:44', duration: '16m',    active: true },
  { id: 'z1', zone: 'Billing 3',      type: 'Counter unattended', from: '14:32', duration: '6m 20s', active: true },
  { id: 'z2', zone: 'Home & Kitchen', type: 'Low staff activity', from: '13:58', duration: '38m',    active: true },
  { id: 'z3', zone: 'Billing 3',      type: 'Counter unattended', from: '13:05', duration: '4m 10s', active: false },
  { id: 'z4', zone: 'Apparel',        type: 'Low staff activity', from: '11:20', duration: '12m',    active: false },
]

// ── Event Log demo fallback ──────────────────────────────────────────────────
// The Event Log page talks to the real backend (GET /activity/events). With no
// backend in this frontend-only build, a demo session falls back to these —
// the SAME shape the API will emit: { ts, kind, type, subject, camera, detail,
// severity }. Breaks appear as out/in pairs, exactly how a camera-based system
// would record them. Times are wall-clock IST applied to the selected day.
const EVENT_TEMPLATE = [
  { t: '09:47', kind: 'attendance', type: 'in',  subject: 'Suresh Yadav',   camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '09:55', kind: 'attendance', type: 'in',  subject: 'Vikram Singh',   camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '09:58', kind: 'attendance', type: 'in',  subject: 'Priya Sharma',   camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '09:59', kind: 'attendance', type: 'in',  subject: 'Kavita Joshi',   camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '10:00', kind: 'attendance', type: 'in',  subject: 'Amit Chauhan',   camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '10:01', kind: 'attendance', type: 'in',  subject: 'Arjun Nair',     camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '10:02', kind: 'attendance', type: 'in',  subject: 'Rahul Verma',    camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '10:04', kind: 'attendance', type: 'in',  subject: 'Rohit Kulkarni', camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '10:05', kind: 'attendance', type: 'in',  subject: 'Anjali Mehta',   camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '10:07', kind: 'attendance', type: 'in',  subject: 'Sneha Patil',    camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '10:41', kind: 'attendance', type: 'in',  subject: 'Meena Iyer',     camera: 'CAM-01', detail: 'Clock-in 10:41 — 26m past the 10:15 cutoff' },
  { t: '10:41', kind: 'alert', type: 'late_arrival',       subject: 'Meena Iyer',   camera: 'CAM-01', detail: 'Late arrival — 26m past cutoff', severity: 'warning' },
  { t: '11:20', kind: 'alert', type: 'low_activity',       subject: null,           camera: 'CAM-02', detail: 'Apparel — no staff activity 12m (resolved)', severity: 'warning' },
  { t: '11:21', kind: 'alert', type: 'phone_use',          subject: 'Rahul Verma',  camera: 'CAM-06', detail: 'Phone in hand 12s at Billing 2', severity: 'warning' },
  { t: '12:03', kind: 'alert', type: 'phone_use',          subject: 'Sneha Patil',  camera: 'CAM-02', detail: 'Phone in hand 65s — Apparel', severity: 'warning' },
  { t: '12:30', kind: 'attendance', type: 'out', subject: 'Anjali Mehta',   camera: 'CAM-04', detail: 'Left floor — break' },
  { t: '12:41', kind: 'attendance', type: 'in',  subject: 'Anjali Mehta',   camera: 'CAM-04', detail: 'Returned — break 11m (within policy)' },
  { t: '13:05', kind: 'alert', type: 'counter_unattended', subject: null,           camera: 'CAM-07', detail: 'Billing 3 unattended 4m 10s (resolved)', severity: 'warning' },
  { t: '13:12', kind: 'alert', type: 'phone_use',          subject: 'Meena Iyer',   camera: 'CAM-07', detail: 'Phone in hand 26s at Billing 3', severity: 'warning' },
  { t: '13:42', kind: 'attendance', type: 'out', subject: 'Rohit Kulkarni', camera: 'CAM-01', detail: 'Stepped out' },
  { t: '13:51', kind: 'attendance', type: 'in',  subject: 'Rohit Kulkarni', camera: 'CAM-01', detail: 'Returned after 9m' },
  { t: '13:58', kind: 'alert', type: 'low_activity',       subject: null,           camera: 'CAM-09', detail: 'Home & Kitchen — no staff activity 38m', severity: 'warning' },
  { t: '14:14', kind: 'attendance', type: 'out', subject: 'Anjali Mehta',   camera: 'CAM-04', detail: 'Left floor — lunch break (limit 45m)' },
  { t: '14:29', kind: 'alert', type: 'phone_use',          subject: 'Sneha Patil',  camera: 'CAM-02', detail: 'Phone in hand 48s — Apparel', severity: 'warning' },
  { t: '14:32', kind: 'alert', type: 'counter_unattended', subject: null,           camera: 'CAM-07', detail: 'Billing 3 unattended — no staff detected', severity: 'critical' },
  { t: '14:35', kind: 'alert', type: 'queue_exceeded',     subject: null,           camera: 'CAM-05', detail: 'Billing 1 queue reached 7 (limit 5)', severity: 'critical' },
]

// Materialise the template onto a calendar day ("YYYY-MM-DD", IST), newest first.
export function demoEvents(dateStr) {
  const base = Date.parse(`${dateStr}T00:00:00+05:30`) / 1000
  if (Number.isNaN(base)) return []
  const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return base + h * 3600 + m * 60 }
  return EVENT_TEMPLATE.map(({ t, ...e }) => ({ ...e, ts: at(t) })).sort((a, b) => b.ts - a.ts)
}

// ── Weekly report (Reports) ──────────────────────────────────────────────────
// Backend: GET /activity/report?store&from&to → per-employee scorecard.
// fields: employeeId, days_present, on_time_pct, avg_inside_sec,
//         break_min_total, phone_incidents, score,
//         impact.counter_unattended_min (minutes a counter this person was
//         assigned to sat empty past params.zones.counterUnattendedSec),
//         impact.queue_breaches (queue > params.queue.maxQueue on their till),
//         peak_presence_pct (share of the store's peak-traffic hours this person
//         was detected on the floor), velocity (bills per hour for tills,
//         customer interactions per hour otherwise), velocity_unit,
//         service_min (avg checkout minutes per customer; null for roles
//         with no till), idle_min (minutes idle on shift over the period)
// score = 0.4·onTime + 0.3·hoursVsShift + 0.2·breakCompliance + 0.1·(1−phoneRate), ×100
export const WEEKLY_REPORT = [
  { id: 'e10', name: 'Suresh Yadav',   role: 'Security',        days: 6, onTime: 100, avgH: '8h 30m', breakMin: 71,  phone: 0, score: 97, impact: { counterMin: 0, queueBreaches: 0 }, peakPct: 99, velocity: 4.1, unit: 'interactions', serviceMin: null, idleMin: 12 },
  { id: 'e04', name: 'Vikram Singh',   role: 'Greeter',         days: 6, onTime: 100, avgH: '8h 21m', breakMin: 88,  phone: 0, score: 96, impact: { counterMin: 0, queueBreaches: 0 }, peakPct: 98, velocity: 22.5, unit: 'interactions', serviceMin: null, idleMin: 8 },
  { id: 'e07', name: 'Kavita Joshi',   role: 'Service Desk',    days: 6, onTime: 100, avgH: '8h 12m', breakMin: 102, phone: 0, score: 94, impact: { counterMin: 0, queueBreaches: 1 }, peakPct: 95, velocity: 8.8, unit: 'interactions', serviceMin: 2.4, idleMin: 15 },
  { id: 'e01', name: 'Priya Sharma',   role: 'Cashier',         days: 6, onTime: 83,  avgH: '8h 10m', breakMin: 95,  phone: 0, score: 91, impact: { counterMin: 4, queueBreaches: 1 }, peakPct: 96, velocity: 14.2, unit: 'bills', serviceMin: 1.6, idleMin: 10 },
  { id: 'e06', name: 'Arjun Nair',     role: 'Floor Staff',     days: 6, onTime: 100, avgH: '8h 05m', breakMin: 99,  phone: 0, score: 93, impact: { counterMin: 0, queueBreaches: 0 }, peakPct: 93, velocity: 9.6, unit: 'interactions', serviceMin: 2.2, idleMin: 14 },
  { id: 'e02', name: 'Rahul Verma',    role: 'Cashier',         days: 6, onTime: 83,  avgH: '8h 02m', breakMin: 84,  phone: 2, score: 87, impact: { counterMin: 9, queueBreaches: 2 }, peakPct: 88, velocity: 12.6, unit: 'bills', serviceMin: 2.3, idleMin: 22 },
  { id: 'e12', name: 'Amit Chauhan',   role: 'Floor Staff',     days: 5, onTime: 100, avgH: '8h 00m', breakMin: 90,  phone: 1, score: 89, impact: { counterMin: 0, queueBreaches: 0 }, peakPct: 90, velocity: 8.9, unit: 'interactions', serviceMin: 2.6, idleMin: 18 },
  { id: 'e08', name: 'Rohit Kulkarni', role: 'Stock Handler',   days: 5, onTime: 80,  avgH: '7h 55m', breakMin: 66,  phone: 1, score: 85, impact: { counterMin: 0, queueBreaches: 0 }, peakPct: 84, velocity: 3.4, unit: 'interactions', serviceMin: null, idleMin: 26 },
  { id: 'e03', name: 'Anjali Mehta',   role: 'Sales Associate', days: 6, onTime: 83,  avgH: '7h 41m', breakMin: 168, phone: 1, score: 78, impact: { counterMin: 0, queueBreaches: 0 }, peakPct: 79, velocity: 7.4, unit: 'interactions', serviceMin: 3.1, idleMin: 34 },
  { id: 'e05', name: 'Sneha Patil',    role: 'Sales Associate', days: 6, onTime: 67,  avgH: '7h 34m', breakMin: 141, phone: 9, score: 64, impact: { counterMin: 6, queueBreaches: 0 }, peakPct: 64, velocity: 5.2, unit: 'interactions', serviceMin: 4.2, idleMin: 58 },
  { id: 'e11', name: 'Divya Reddy',    role: 'Sales Associate', days: 4, onTime: 75,  avgH: '7h 26m', breakMin: 120, phone: 2, score: 71, impact: { counterMin: 0, queueBreaches: 1 }, peakPct: 72, velocity: 6.1, unit: 'interactions', serviceMin: 3.4, idleMin: 41 },
  { id: 'e09', name: 'Meena Iyer',     role: 'Cashier',         days: 6, onTime: 50,  avgH: '7h 18m', breakMin: 156, phone: 5, score: 62, impact: { counterMin: 22, queueBreaches: 4 }, peakPct: 68, velocity: 9.1, unit: 'bills', serviceMin: 3.9, idleMin: 52 },
]

// Report-level figures the scorecard rows can't produce on their own.
// Backend: same GET /activity/report response → { store_health_pct, store_code }.
// store_health_pct = weighted shift compliance × floor coverage for the period.
// staffImpact (Analytics › Staff summary bar): peak_floor_coverage_pct over
// peak_window, avg_service_min (billing time per customer at the tills),
// top_shift by mean velocity (topShiftLift = % above store mean). statusRules =
// the thresholds (minutes) behind the Staff tab's Fast / Normal / Needs Support tags.
export const REPORT_META = {
  healthScore: 88,
  storeCodes: { 'st-01': '804', 'st-02': '612', 'st-03': '731' },
  staffImpact: { peakCoverage: 91, peakWindow: '12:00–15:00', serviceMin: 2.8, topShift: 'Morning', topShiftLift: 12 },
  // Staff tab status tags: Fast = quick checkout and little idle time;
  // Needs Support = slow checkout or a lot of idle time; otherwise Normal.
  statusRules: { fastMin: 2, slowMin: 3.5, busyIdleMin: 15, idleWarnMin: 45 },
}
