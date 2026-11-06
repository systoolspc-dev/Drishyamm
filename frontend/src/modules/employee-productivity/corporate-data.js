import { withCameraStreams } from './dashboard/cameraStreams';
// ─────────────────────────────────────────────────────────────────────────────
// Activity Monitoring — CORPORATE (office) dummy data.
//
// Mirrors the exact shapes of dashboard/data.js + pages-data.js so the same
// components render either vertical. Retail = shop floor (cashiers, billing
// counters, footfall); Corporate = office (engineers/PMs, desks, meeting rooms,
// after-hours access). Selected at runtime by useModuleData() on the active
// use-case. Office hours 09:00–18:00; dummy "now" is 14:30 IST.
// ─────────────────────────────────────────────────────────────────────────────

export const STORES = [
  { id: 'hq-blr', label: 'HQ — Bengaluru' },
  { id: 'tp-pune', label: 'Tech Park — Pune' },
  { id: 'ch-ggn', label: 'Cyber Hub — Gurugram' },
];

// Dummy clock for the office dataset (see dashboard/data.js for the why).
// Shifts live in src/use-cases/corporate/index.js, not here.
export const NOW_IST = '14:30';
export const TODAY = '2026-07-16';

// KPIs — office-relevant (no billing counters, no customer queue). Same
// consolidation as retail: three cards, because the office has no queue to
// report. On-time attendance and personal-device alerts now ride on the
// employee rows (`lateBy` / `phoneIncidents`), active alerts are the Needs
// Attention count, and avg working hours belongs to the Reports export.
//
// Same three-part card as retail (§16): value + plain-language `badge` + ONE
// aggregate `sub` line. No individual named on a floor-wide card — "1 not in
// (Arjun)" became "1 Not In · 1 Late", which also survives a second absence.
// Shapes: ./dashboard/dto.d.ts
/** @type {import('./dashboard/dto').KpiCard[]} */
export const KPIS = [
  { key: 'health', label: 'Health Score', display: 'score', value: 89, unit: '/100',
    badge: { text: 'Healthy', tone: 'good' },
    sub: 'Attendance is the strongest area', tone: 'good', delta: '+2 vs yesterday', trend: 'up',
    purpose: 'Single number: is the office operating normally right now?',
    formula: '0.35·attendanceRate + 0.30·deskOccupancy + 0.20·breakComplianceRate + 0.15·(1 − afterHoursRate), ×100',
    fields: ['attendanceRate', 'deskOccupancy', 'breakComplianceRate', 'afterHoursRate'] },
  { key: 'present', label: 'Staff Present', display: 'ratio', value: 11, total: 12, unit: 'Scheduled',
    badge: { text: '2 Pending', tone: 'warn' },
    sub: '1 Not In · 1 Late', tone: 'good', delta: null, trend: null,
    purpose: 'Headcount detected on-site vs the roster for the selected shift. The badge counts everyone not yet accounted for; open the card for the names.',
    formula: 'count(currently_inside = true) / count(roster where shift = selected); pending = count(status in {notarrived, late})',
    fields: ['employees[].currently_inside', 'employees[].status', 'roster[].employeeId', 'roster[].shift'] },
  { key: 'occupancy', label: 'Desk Occupancy', display: 'ratio', value: 39, total: 50, unit: 'Desks In Use',
    badge: { text: 'Normal', tone: 'good' },
    sub: '11 desks free right now', tone: 'good', delta: '+4% vs yesterday', trend: 'up',
    purpose: 'Assigned desks with a person detected right now, out of the assigned desks on this floor.',
    formula: 'count(desks where occupied) / count(desks where assigned)',
    fields: ['desks[].occupied', 'desks[].assigned'] },
];

/** @type {import('./dashboard/dto').AttentionAlert[]} */
export const ATTENTION = withCameraStreams([
  { id: 'a1', type: 'meeting-overrun', source: 'coverage', severity: 'high',   title: 'Meeting room over-run', employee: 'Divya Iyer',     location: 'Meeting Room A',  camera: 'CAM-11', duration: '18m over',   since: '14:12' },
  { id: 'a2', type: 'desk-idle',       source: 'coverage', severity: 'medium', title: 'Workstation idle',      employee: 'Karan Malhotra', location: 'Engineering Bay', camera: 'CAM-03', duration: '42m',        since: '13:48' },
  { id: 'a3', type: 'after-hours',     source: 'staff',    severity: 'medium', title: 'After-hours access',    employee: 'Vivek Menon',    location: 'Server Room',     camera: 'CAM-14', duration: 'entry 08:10', since: '08:10' },
  { id: 'a4', type: 'camera-offline',  source: 'system',   severity: 'medium', title: 'Camera offline',        employee: null,             location: 'Design Studio',   camera: 'CAM-06', duration: '9m',         since: '14:26' },
  { id: 'a5', type: 'late-arrival',    source: 'staff',    severity: 'low',    title: 'Late arrival',          employee: 'Sameer Khan',    location: 'Reception',       camera: 'CAM-01', duration: '22m late',   since: '09:52' },
  { id: 'a6', type: 'coverage-low',    source: 'coverage', severity: 'low',    title: 'Low zone activity',     employee: null,             location: 'Sales Floor',     camera: 'CAM-09', duration: '35m',        since: '13:40' },
], TODAY);

// Present vs expected + desk coverage per hour (office hours).
export const TRENDS = [
  { h: '09:00', present: 8,  expected: 12, coverage: 100 },
  { h: '10:00', present: 11, expected: 12, coverage: 100 },
  { h: '11:00', present: 12, expected: 12, coverage: 98 },
  { h: '12:00', present: 10, expected: 12, coverage: 95 },
  { h: '13:00', present: 7,  expected: 12, coverage: 88 },
  { h: '14:00', present: 11, expected: 12, coverage: 96 },
  { h: '15:00', present: 11, expected: 12, coverage: 94 },
  { h: '16:00', present: 9,  expected: 12, coverage: 90 },
];

export const FEED = [
  { id: 'f01', time: '14:12', type: 'meeting-overrun',  employee: 'Divya Iyer',     camera: 'CAM-11', zone: 'Meeting Room A',  status: 'alert', text: 'Meeting over-running booking by 18m' },
  { id: 'f02', time: '13:48', type: 'desk-idle',        employee: 'Karan Malhotra', camera: 'CAM-03', zone: 'Engineering Bay', status: 'warn',  text: 'Workstation idle for 42m' },
  { id: 'f03', time: '13:30', type: 'meeting-start',    employee: 'Rohan Das',      camera: 'CAM-12', zone: 'Meeting Room B',  status: 'info',  text: 'Sprint review started (8 attendees)' },
  { id: 'f04', time: '13:05', type: 'phone-usage',      employee: 'Sameer Khan',    camera: 'CAM-11', zone: 'Meeting Room A',  status: 'warn',  text: 'Phone in hand 22s in meeting room' },
  { id: 'f05', time: '12:20', type: 'break-start',      employee: 'Priya Nair',     camera: 'CAM-08', zone: 'Cafeteria',       status: 'info',  text: 'Lunch break started' },
  { id: 'f06', time: '11:40', type: 'low-activity',     employee: null,             camera: 'CAM-09', zone: 'Sales Floor',     status: 'warn',  text: 'No activity for 35m' },
  { id: 'f07', time: '10:15', type: 'employee-exit',    employee: 'Vivek Menon',    camera: 'CAM-14', zone: 'Server Room',     status: 'info',  text: 'Exited secure zone (entered 08:10)' },
  { id: 'f08', time: '09:52', type: 'employee-entry',   employee: 'Sameer Khan',    camera: 'CAM-01', zone: 'Reception',       status: 'warn',  text: 'Clock-in 09:52 — 22m past cutoff' },
  { id: 'f09', time: '09:05', type: 'employee-entry',   employee: 'Neha Kapoor',    camera: 'CAM-01', zone: 'Reception',       status: 'ok',    text: 'Clock-in on time' },
  { id: 'f10', time: '08:50', type: 'employee-entry',   employee: 'Divya Iyer',     camera: 'CAM-01', zone: 'Reception',       status: 'ok',    text: 'Clock-in on time' },
];

export const STATUS_META = {
  onfloor:    { label: 'At Desk',  cls: 'bg-success-soft text-success-ink ring-success-line', dot: '#10b981' },
  break:      { label: 'On Break', cls: 'bg-warning-soft text-warning-ink ring-warning-line',       dot: '#f59e0b' },
  away:       { label: 'Away',     cls: 'bg-brand-soft text-brand-ink ring-brand-line',    dot: '#fb923c' },
  late:       { label: 'Late',     cls: 'bg-danger-soft text-danger-ink ring-danger-line',          dot: '#f43f5e' },
  notarrived: { label: 'Not In',   cls: 'bg-surface-muted text-fg-muted ring-line',      dot: '#94a3b8' },
};

// Roster — ids c01..c12 shared across timelines / stats / breaks / report.
// `lateBy` / `phoneIncidents` carry the two metrics that lost their KPI cards.
/** @type {import('./dashboard/dto').EmployeeRow[]} */
export const EMPLOYEES = [
  { id: 'c01', name: 'Aditya Rao',     role: 'Software Engineer',   zone: 'Engineering Bay', shift: 'Full Day', status: 'onfloor',    clockIn: '09:12', worked: '5h 06m', lateBy: null,  phoneIncidents: 0 },
  { id: 'c02', name: 'Neha Kapoor',    role: 'Senior Engineer',     zone: 'Engineering Bay', shift: 'Full Day', status: 'onfloor',    clockIn: '09:05', worked: '5h 18m', lateBy: null,  phoneIncidents: 0 },
  { id: 'c03', name: 'Rohan Das',      role: 'Product Manager',     zone: 'Meeting Room B',  shift: 'Full Day', status: 'onfloor',    clockIn: '09:20', worked: '4h 58m', lateBy: null,  phoneIncidents: 0 },
  { id: 'c04', name: 'Ishita Sen',     role: 'UX Designer',         zone: 'Design Studio',   shift: 'Flexi',    status: 'onfloor',    clockIn: '09:02', worked: '5h 20m', lateBy: null,  phoneIncidents: 0 },
  { id: 'c05', name: 'Karan Malhotra', role: 'QA Engineer',         zone: 'Engineering Bay', shift: 'Full Day', status: 'break',      clockIn: '09:08', worked: '4h 40m', lateBy: null,  phoneIncidents: 1 },
  { id: 'c06', name: 'Priya Nair',     role: 'Data Analyst',        zone: 'Analytics Bay',   shift: 'Full Day', status: 'away',       clockIn: '09:15', worked: '4h 32m', lateBy: null,  phoneIncidents: 0 },
  { id: 'c07', name: 'Ananya Gupta',   role: 'HR Manager',          zone: 'HR Wing',         shift: 'Full Day', status: 'onfloor',    clockIn: '09:00', worked: '5h 22m', lateBy: null,  phoneIncidents: 0 },
  { id: 'c08', name: 'Vivek Menon',    role: 'DevOps Engineer',     zone: 'Server Room',     shift: 'Early',    status: 'onfloor',    clockIn: '08:10', worked: '6h 05m', lateBy: null,  phoneIncidents: 0 },
  { id: 'c09', name: 'Sameer Khan',    role: 'Sales Executive',     zone: 'Sales Floor',     shift: 'Full Day', status: 'late',       clockIn: '09:52', worked: '4h 30m', lateBy: '22m', phoneIncidents: 1 },
  { id: 'c10', name: 'Divya Iyer',     role: 'Engineering Manager', zone: 'Meeting Room A',  shift: 'Full Day', status: 'onfloor',    clockIn: '08:50', worked: '5h 34m', lateBy: null,  phoneIncidents: 0 },
  { id: 'c11', name: 'Arjun Bhat',     role: 'Accountant',          zone: '—',               shift: 'Flexi',    status: 'notarrived', clockIn: null,    worked: '—',      lateBy: null,  phoneIncidents: 0 },
  { id: 'c12', name: 'Meera Joshi',    role: 'IT Support',          zone: 'IT Helpdesk',     shift: 'Full Day', status: 'onfloor',    clockIn: '09:10', worked: '5h 08m', lateBy: null,  phoneIncidents: 0 },
];

// ── Subpage datasets ─────────────────────────────────────────────────────────
export const DAY_TIMELINES = {
  c01: [{ s: '09:12', e: '12:20', k: 'floor' }, { s: '12:20', e: '12:38', k: 'break', bt: 'tea', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '12:38', e: '14:30', k: 'floor' }],
  c02: [{ s: '09:05', e: '11:50', k: 'floor' }, { s: '11:50', e: '12:02', k: 'break', bt: 'tea', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '12:02', e: '14:30', k: 'floor' }],
  c03: [{ s: '09:20', e: '13:30', k: 'floor' }, { s: '13:30', e: '14:30', k: 'floor' }],
  c04: [{ s: '09:02', e: '12:40', k: 'floor' }, { s: '12:40', e: '13:05', k: 'break', bt: 'lunch', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '13:05', e: '14:30', k: 'floor' }],
  c05: [{ s: '09:08', e: '12:30', k: 'floor' }, { s: '12:30', e: '13:10', k: 'break', bt: 'lunch', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '13:10', e: '13:48', k: 'floor' }, { s: '13:48', e: '14:30', k: 'break', bt: 'lunch', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }],
  c06: [{ s: '09:15', e: '12:15', k: 'floor' }, { s: '12:15', e: '12:34', k: 'break', bt: 'tea', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '12:34', e: '13:55', k: 'floor' }, { s: '13:55', e: '14:30', k: 'away', at: 'Analytics Bay · CAM-09', note: 'Away from desk — not seen on any camera' }],
  c07: [{ s: '09:00', e: '12:10', k: 'floor' }, { s: '12:10', e: '12:26', k: 'break', bt: 'tea', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '12:26', e: '14:30', k: 'floor' }],
  c08: [{ s: '08:10', e: '10:15', k: 'floor' }, { s: '10:15', e: '10:24', k: 'away', at: 'Server Room · CAM-14', note: 'Stepped out of the floor' }, { s: '10:24', e: '14:30', k: 'floor' }],
  c09: [{ s: '09:52', e: '13:20', k: 'floor' }, { s: '13:20', e: '13:33', k: 'break', bt: 'tea', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '13:33', e: '14:30', k: 'floor' }],
  c10: [{ s: '08:50', e: '11:30', k: 'floor' }, { s: '11:30', e: '11:42', k: 'break', bt: 'tea', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '11:42', e: '14:30', k: 'floor' }],
  c11: [],
  c12: [{ s: '09:10', e: '12:44', k: 'floor' }, { s: '12:44', e: '12:57', k: 'break', bt: 'tea', at: 'Cafeteria · CAM-05', note: 'Scheduled break' }, { s: '12:57', e: '14:30', k: 'floor' }],
};

export const PROFILE_STATS = {
  c01: { punctuality: 95, avgHours: '8h 24m', breaksPerDay: '2 · 18m', phonePerWeek: 0, daysPresent: 25 },
  c02: { punctuality: 97, avgHours: '8h 40m', breaksPerDay: '2 · 14m', phonePerWeek: 0, daysPresent: 26 },
  c03: { punctuality: 90, avgHours: '8h 10m', breaksPerDay: '3 · 30m', phonePerWeek: 1, daysPresent: 24 },
  c04: { punctuality: 98, avgHours: '8h 22m', breaksPerDay: '2 · 20m', phonePerWeek: 0, daysPresent: 26 },
  c05: { punctuality: 88, avgHours: '7h 58m', breaksPerDay: '3 · 34m', phonePerWeek: 1, daysPresent: 24 },
  c06: { punctuality: 92, avgHours: '8h 05m', breaksPerDay: '2 · 22m', phonePerWeek: 0, daysPresent: 25 },
  c07: { punctuality: 100, avgHours: '8h 30m', breaksPerDay: '2 · 16m', phonePerWeek: 0, daysPresent: 26 },
  c08: { punctuality: 96, avgHours: '8h 55m', breaksPerDay: '2 · 12m', phonePerWeek: 0, daysPresent: 26 },
  c09: { punctuality: 74, avgHours: '7h 40m', breaksPerDay: '2 · 24m', phonePerWeek: 2, daysPresent: 23 },
  c10: { punctuality: 99, avgHours: '8h 46m', breaksPerDay: '2 · 15m', phonePerWeek: 0, daysPresent: 26 },
  c11: { punctuality: 80, avgHours: '7h 30m', breaksPerDay: '2 · 20m', phonePerWeek: 1, daysPresent: 22 },
  c12: { punctuality: 94, avgHours: '8h 12m', breaksPerDay: '2 · 17m', phonePerWeek: 0, daysPresent: 25 },
};

export const BREAKS = [
  { id: 'c01', name: 'Aditya Rao',     count: 1, totalMin: 18, longestAwayMin: 0,  lastSeen: 'CAM-03', floor: 90, brk: 6,  away: 4 },
  { id: 'c02', name: 'Neha Kapoor',    count: 1, totalMin: 12, longestAwayMin: 0,  lastSeen: 'CAM-03', floor: 93, brk: 4,  away: 3 },
  { id: 'c03', name: 'Rohan Das',      count: 0, totalMin: 0,  longestAwayMin: 0,  lastSeen: 'CAM-12', floor: 96, brk: 0,  away: 4 },
  { id: 'c04', name: 'Ishita Sen',     count: 1, totalMin: 25, longestAwayMin: 0,  lastSeen: 'CAM-10', floor: 88, brk: 9,  away: 3 },
  { id: 'c05', name: 'Karan Malhotra', count: 2, totalMin: 82, longestAwayMin: 0,  lastSeen: 'CAM-03', floor: 70, brk: 26, away: 4 },
  { id: 'c06', name: 'Priya Nair',     count: 1, totalMin: 19, longestAwayMin: 35, lastSeen: 'CAM-07', floor: 82, brk: 7,  away: 11 },
  { id: 'c07', name: 'Ananya Gupta',   count: 1, totalMin: 16, longestAwayMin: 0,  lastSeen: 'CAM-13', floor: 93, brk: 5,  away: 2 },
  { id: 'c08', name: 'Vivek Menon',    count: 0, totalMin: 0,  longestAwayMin: 9,  lastSeen: 'CAM-14', floor: 95, brk: 0,  away: 5 },
  { id: 'c09', name: 'Sameer Khan',    count: 1, totalMin: 13, longestAwayMin: 0,  lastSeen: 'CAM-11', floor: 86, brk: 5,  away: 9 },
  { id: 'c10', name: 'Divya Iyer',     count: 1, totalMin: 12, longestAwayMin: 0,  lastSeen: 'CAM-11', floor: 94, brk: 4,  away: 2 },
  { id: 'c12', name: 'Meera Joshi',    count: 1, totalMin: 13, longestAwayMin: 0,  lastSeen: 'CAM-15', floor: 92, brk: 5,  away: 3 },
];

// area: desk | meeting | restricted (the Phone Usage page's area filter)
export const PHONE_EVENTS = [
  { id: 'p1', date: '2026-07-16', ts: '13:05:21', time: '13:05', employee: 'Sameer Khan',    camera: 'CAM-11', zone: 'Meeting Room A', location: 'Meeting Room A', area: 'meeting',    holdSec: 22, confidence: 0.9 },
  { id: 'p2', date: '2026-07-16', ts: '10:48:07', time: '10:48', employee: 'Karan Malhotra', camera: 'CAM-14', zone: 'Server Room',    location: 'Server Room',    area: 'restricted', holdSec: 44, confidence: 0.87 },
  { id: 'y1', date: '2026-07-15', ts: '16:20:45', time: '16:20', employee: 'Sameer Khan',    camera: 'CAM-23', zone: 'Meeting Room B', location: 'Meeting Room B', area: 'meeting',    holdSec: 52, confidence: 0.88 },
];

export const PHONE_WEEKLY = [
  { name: 'Sameer Khan', total: 4, trend: 'flat' },
  { name: 'Karan Malhotra', total: 2, trend: 'down' },
  { name: 'Rohan Das', total: 1, trend: 'flat' },
];

export const PHONE_TREND = [
  { d: 'Thu', n: 1 }, { d: 'Fri', n: 2 }, { d: 'Sat', n: 0 }, { d: 'Sun', n: 0 },
  { d: 'Mon', n: 1 }, { d: 'Tue', n: 3 }, { d: 'Wed', n: 2 },
];

export const WEEKLY_REPORT = [
  { id: 'c07', name: 'Ananya Gupta',   role: 'HR Manager',          days: 6, onTime: 100, avgH: '8h 30m', breakMin: 96,  phone: 0, score: 96, peakPct: 97, velocity: 1.6, unit: 'tasks', serviceMin: 30, idleMin: 14 },
  { id: 'c10', name: 'Divya Iyer',     role: 'Engineering Manager', days: 6, onTime: 99,  avgH: '8h 46m', breakMin: 90,  phone: 0, score: 96, peakPct: 98, velocity: 1.7, unit: 'tasks', serviceMin: 31, idleMin: 12 },
  { id: 'c02', name: 'Neha Kapoor',    role: 'Senior Engineer',     days: 6, onTime: 97,  avgH: '8h 40m', breakMin: 84,  phone: 0, score: 95, peakPct: 95, velocity: 1.9, unit: 'tasks', serviceMin: 29, idleMin: 10 },
  { id: 'c08', name: 'Vivek Menon',    role: 'DevOps Engineer',     days: 6, onTime: 96,  avgH: '8h 55m', breakMin: 72,  phone: 0, score: 94, peakPct: 96, velocity: 1.5, unit: 'tasks', serviceMin: 34, idleMin: 16 },
  { id: 'c04', name: 'Ishita Sen',     role: 'UX Designer',         days: 6, onTime: 98,  avgH: '8h 22m', breakMin: 120, phone: 0, score: 93, peakPct: 93, velocity: 1.4, unit: 'tasks', serviceMin: 36, idleMin: 22 },
  { id: 'c01', name: 'Aditya Rao',     role: 'Software Engineer',   days: 6, onTime: 95,  avgH: '8h 24m', breakMin: 108, phone: 0, score: 92, peakPct: 92, velocity: 1.6, unit: 'tasks', serviceMin: 33, idleMin: 18 },
  { id: 'c06', name: 'Priya Nair',     role: 'Data Analyst',        days: 5, onTime: 92,  avgH: '8h 05m', breakMin: 132, phone: 0, score: 89, peakPct: 86, velocity: 1.5, unit: 'tasks', serviceMin: 40, idleMin: 28 },
  { id: 'c12', name: 'Meera Joshi',    role: 'IT Support',          days: 6, onTime: 94,  avgH: '8h 12m', breakMin: 102, phone: 0, score: 90, peakPct: 94, velocity: 2.4, unit: 'tasks', serviceMin: 26, idleMin: 15 },
  { id: 'c03', name: 'Rohan Das',      role: 'Product Manager',     days: 6, onTime: 90,  avgH: '8h 10m', breakMin: 150, phone: 1, score: 86, peakPct: 84, velocity: 1.3, unit: 'tasks', serviceMin: 42, idleMin: 35 },
  { id: 'c05', name: 'Karan Malhotra', role: 'QA Engineer',         days: 5, onTime: 88,  avgH: '7h 58m', breakMin: 168, phone: 1, score: 82, peakPct: 78, velocity: 1.2, unit: 'tasks', serviceMin: 45, idleMin: 44 },
  { id: 'c11', name: 'Arjun Bhat',     role: 'Accountant',          days: 4, onTime: 80,  avgH: '7h 30m', breakMin: 120, phone: 1, score: 78, peakPct: 70, velocity: 1.1, unit: 'tasks', serviceMin: 49, idleMin: 52 },
  { id: 'c09', name: 'Sameer Khan',    role: 'Sales Executive',     days: 6, onTime: 74,  avgH: '7h 40m', breakMin: 126, phone: 2, score: 71, peakPct: 72, velocity: 1.0, unit: 'tasks', serviceMin: 52, idleMin: 66 },
];

// peakPct = presence across core hours; velocity = tasks/tickets closed per hour;
// serviceMin = avg minutes per ticket; idleMin = minutes idle over the period.
// Office has no counters or queues, so rows carry no `impact`; the Reports
// table hides that column when params.zones is absent.
export const REPORT_META = {
  healthScore: 92,
  storeCodes: { 'hq-blr': '101', 'tp-pune': '214', 'ch-ggn': '305' },
  // Office read of the Staff tab's impact bar: core hours stand in for peak
  // traffic, ticket resolution for billing speed.
  staffImpact: { peakCoverage: 94, peakWindow: '11:00–16:00', serviceMin: 38, topShift: 'Full Day', topShiftLift: 9 },
  statusRules: { fastMin: 32, slowMin: 48, busyIdleMin: 20, idleWarnMin: 60 },
};

// Event Log template (office). Same shape as retail; demoEvents materialises it.
const EVENT_TEMPLATE = [
  { t: '08:10', kind: 'attendance', type: 'in',  subject: 'Vivek Menon',    camera: 'CAM-14', detail: 'Clock-in — early (secure zone access)' },
  { t: '08:50', kind: 'attendance', type: 'in',  subject: 'Divya Iyer',     camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '09:00', kind: 'attendance', type: 'in',  subject: 'Ananya Gupta',   camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '09:02', kind: 'attendance', type: 'in',  subject: 'Ishita Sen',     camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '09:05', kind: 'attendance', type: 'in',  subject: 'Neha Kapoor',    camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '09:12', kind: 'attendance', type: 'in',  subject: 'Aditya Rao',     camera: 'CAM-01', detail: 'Clock-in — on time' },
  { t: '09:52', kind: 'attendance', type: 'in',  subject: 'Sameer Khan',    camera: 'CAM-01', detail: 'Clock-in 09:52 — 22m past the 09:30 cutoff' },
  { t: '09:52', kind: 'alert', type: 'late_arrival',    subject: 'Sameer Khan',   camera: 'CAM-01', detail: 'Late arrival — 22m past cutoff', severity: 'warning' },
  { t: '10:48', kind: 'alert', type: 'phone_use',       subject: 'Karan Malhotra', camera: 'CAM-14', detail: 'Phone in hand 14s — Server Room (restricted)', severity: 'warning' },
  { t: '11:40', kind: 'alert', type: 'low_activity',    subject: null,            camera: 'CAM-09', detail: 'Sales Floor — no activity 35m', severity: 'warning' },
  { t: '12:20', kind: 'attendance', type: 'out', subject: 'Priya Nair',     camera: 'CAM-08', detail: 'Left desk — lunch' },
  { t: '13:05', kind: 'alert', type: 'phone_use',       subject: 'Sameer Khan',   camera: 'CAM-11', detail: 'Phone in hand 22s — Meeting Room A', severity: 'warning' },
  { t: '13:30', kind: 'meeting', type: 'meeting_start', subject: 'Rohan Das',     camera: 'CAM-12', detail: 'Sprint review started (8 attendees)' },
  { t: '13:48', kind: 'alert', type: 'desk_idle',       subject: 'Karan Malhotra', camera: 'CAM-03', detail: 'Workstation idle 42m', severity: 'warning' },
  { t: '14:12', kind: 'alert', type: 'meeting_overrun', subject: 'Divya Iyer',    camera: 'CAM-11', detail: 'Meeting Room A over-running booking by 18m', severity: 'critical' },
];

export function demoEvents(dateStr) {
  const base = Date.parse(`${dateStr}T00:00:00+05:30`) / 1000;
  if (Number.isNaN(base)) return [];
  const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return base + h * 3600 + m * 60; };
  return EVENT_TEMPLATE.map(({ t, ...e }) => ({ ...e, ts: at(t) })).sort((a, b) => b.ts - a.ts);
}
