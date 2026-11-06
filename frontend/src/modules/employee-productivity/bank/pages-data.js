// Page datasets migrated from the standalone Bank/ app: its data modules
// (staffData.js, reportsData.js, sectionReportsData.js, staffDetailUtils.js) plus
// the inline const arrays that lived inside each page. One block per source page,
// exact numbers/labels preserved. Backend contracts noted inline.

// ── from Bank/src/staffData.js (STAFF_ON_DUTY) ──
// Shared roster: dashboard live list, StaffRoster table, StaffDetail page.
// Backend later: GET /bank/staff and /bank/staff/:id. metricLabel/metricValue are
// role-conditional (customers handled / cash transactions / zone checks / escalations).
export const STAFF_DATA = [
  {
    id: 'b-kapoor', name: 'Aditi Kapoor', role: 'Branch Manager', dept: 'Management',
    status: 'active', load: 58, employeeId: 'BP-1001', scheduledShift: '9:00 AM – 6:00 PM', actualClockIn: '8:57 AM',
    complianceScore: 98, teamAvgLoad: 60, metricLabel: 'Escalations resolved', metricValue: 6, teamAvgMetric: 4,
  },
  {
    id: 'b-sharma', name: 'Rohan Sharma', role: 'Teller', dept: 'Customer Operations',
    status: 'active', load: 84, employeeId: 'BP-2114', scheduledShift: '9:00 AM – 5:00 PM', actualClockIn: '9:02 AM',
    complianceScore: 95, teamAvgLoad: 72, metricLabel: 'Customers handled', metricValue: 31, teamAvgMetric: 26,
  },
  {
    id: 'b-fernandes', name: 'Maria Fernandes', role: 'Customer Service Executive', dept: 'Customer Operations',
    status: 'break', load: 12, employeeId: 'BP-2231', scheduledShift: '10:00 AM – 6:00 PM', actualClockIn: '10:05 AM',
    complianceScore: 91, teamAvgLoad: 72, metricLabel: 'Customers handled', metricValue: 22, teamAvgMetric: 26,
  },
  {
    id: 'b-verma', name: 'Karan Verma', role: 'Cash Officer', dept: 'Cash Operations',
    status: 'active', load: 71, employeeId: 'BP-3042', scheduledShift: '9:00 AM – 5:00 PM', actualClockIn: '8:59 AM',
    complianceScore: 97, teamAvgLoad: 68, metricLabel: 'Cash transactions', metricValue: 47, teamAvgMetric: 40,
  },
  {
    id: 'b-iyer', name: 'Sanjana Iyer', role: 'Relationship Manager', dept: 'Customer Operations',
    status: 'active', load: 63, employeeId: 'BP-2078', scheduledShift: '9:30 AM – 6:30 PM', actualClockIn: '9:28 AM',
    complianceScore: 94, teamAvgLoad: 72, metricLabel: 'Customers handled', metricValue: 18, teamAvgMetric: 26,
  },
  {
    id: 'b-khan', name: 'Imran Khan', role: 'Security Guard', dept: 'Security',
    status: 'active', load: 46, employeeId: 'BP-4009', scheduledShift: '8:00 AM – 4:00 PM', actualClockIn: '7:56 AM',
    complianceScore: 99, teamAvgLoad: 50, metricLabel: 'Zone checks completed', metricValue: 14, teamAvgMetric: 12,
  },
];

// ── from Bank/src/notifications.js (NOTIFICATIONS) ──
// Cross-page alert feed — powers the dashboard Live Overview, Security incidents,
// and the Alerts page. `kind` maps to an icon in the component (the source stored
// a lucide component here; we keep the data pure). Backend later: GET /bank/alerts.
export const ALERTS_DATA = [
  { id: 'n1', type: 'Restricted vault access without dual authorization', detail: 'Single-badge entry detected, vault door 2 — camera 4', time: '14 min ago', level: 'high', kind: 'vault' },
  { id: 'n2', type: 'Queue length exceeded threshold', detail: '14 customers waiting, avg. wait 11 min — lobby camera', time: '22 min ago', level: 'medium', kind: 'queue' },
  { id: 'n3', type: 'Counter left unattended', detail: 'Counter 5 empty for 12+ min during peak hours', time: '38 min ago', level: 'medium', kind: 'counter' },
  { id: 'n4', type: 'Emergency response delayed', detail: 'Panic alarm zone 2, staff arrival at 4m 40s (target 3m)', time: '51 min ago', level: 'high', kind: 'emergency' },
  { id: 'n5', type: 'Maintenance ticket overdue', detail: 'ATM 2 offline 40+ min, no technician dispatched', time: '1 hr ago', level: 'low', kind: 'maintenance' },
];

// ── from Bank/src/Teller.jsx ──
// Backend later: GET /bank/teller (wait-time trend, queue by counter, counter status).
export const TELLER_DATA = {
  stats: {
    waitingTime: { value: '4m 12s', deltaLabel: '-6.4% faster', trend: 'down-good' },
    queueLength: { value: '13', deltaLabel: '+3 vs. 10am', trend: 'up-bad' },
    serviceTime: { value: '7m 48s', deltaLabel: '+0.6m vs. target', trend: 'up-bad' },
    counterAvailability: { value: '4 / 6', deltaLabel: 'open now', trend: 'flat' },
  },
  waitTimeTrend: [
    { time: '9am', seconds: 128 }, { time: '10am', seconds: 210 }, { time: '11am', seconds: 285 },
    { time: '12pm', seconds: 340 }, { time: '1pm', seconds: 312 }, { time: '2pm', seconds: 246 },
    { time: '3pm', seconds: 198 }, { time: '4pm', seconds: 150 },
  ],
  queueByCounter: [
    { counter: 'Counter 1', waiting: 4 }, { counter: 'Counter 2', waiting: 2 }, { counter: 'Counter 3', waiting: 0 },
    { counter: 'Counter 4', waiting: 6 }, { counter: 'Counter 5', waiting: 1 }, { counter: 'Counter 6', waiting: 0 },
  ],
  counters: [
    { id: 'c1', counter: 'Counter 1', teller: 'Rohan Sharma', status: 'open', waiting: 4, avgInteraction: '5m 40s' },
    { id: 'c2', counter: 'Counter 2', teller: 'Sanjana Iyer', status: 'open', waiting: 2, avgInteraction: '4m 12s' },
    { id: 'c3', counter: 'Counter 3', teller: '—', status: 'closed', waiting: 0, avgInteraction: '—' },
    { id: 'c4', counter: 'Counter 4', teller: 'Maria Fernandes', status: 'open', waiting: 6, avgInteraction: '6m 05s' },
    { id: 'c5', counter: 'Counter 5', teller: 'Karan Verma', status: 'break', waiting: 1, avgInteraction: '3m 50s' },
    { id: 'c6', counter: 'Counter 6', teller: '—', status: 'closed', waiting: 0, avgInteraction: '—' },
  ],
};

// ── from Bank/src/Cashops.jsx ──
// Backend later: GET /bank/cash-ops (handling trend, utilization, vault log).
export const CASHOPS_DATA = {
  stats: {
    handlingDuration: { value: '2m 52s', deltaLabel: '-0.3m faster', trend: 'down-good' },
    utilization: { value: '74%', deltaLabel: '+2.1pt', trend: 'up' },
    vaultVisits: { value: '4', deltaLabel: 'steady', trend: 'flat' },
    idleTime: { value: '16%', deltaLabel: '-1.4pt less', trend: 'down-good' },
  },
  handlingTrend: [
    { time: '9am', seconds: 145 }, { time: '10am', seconds: 168 }, { time: '11am', seconds: 190 },
    { time: '12pm', seconds: 210 }, { time: '1pm', seconds: 198 }, { time: '2pm', seconds: 172 },
    { time: '3pm', seconds: 155 }, { time: '4pm', seconds: 138 },
  ],
  utilizationByCounter: [
    { counter: 'Cash 1', active: 260, idle: 60 }, { counter: 'Cash 2', active: 210, idle: 110 }, { counter: 'Cash 3', active: 288, idle: 32 },
  ],
  vaultLog: [
    { id: 'v1', time: '9:14 AM', staff: 'Karan Verma', purpose: 'Morning cash top-up', dualAuth: true, duration: '6m 20s' },
    { id: 'v2', time: '11:02 AM', staff: 'Aditi Kapoor', purpose: 'Mid-day reconciliation', dualAuth: true, duration: '9m 45s' },
    { id: 'v3', time: '1:40 PM', staff: 'Karan Verma', purpose: 'Cash replenishment', dualAuth: true, duration: '4m 10s' },
    { id: 'v4', time: '3:55 PM', staff: 'Karan Verma', purpose: 'End-of-day count prep', dualAuth: false, duration: '3m 05s' },
  ],
};

// ── from Bank/src/Productivity.jsx ──
// Backend later: GET /bank/productivity (active/idle by dept, hourly, staff level).
export const PRODUCTIVITY_DATA = {
  stats: {
    activeTime: { value: '81%', deltaLabel: '+1.1%', trend: 'up' },
    idleTime: { value: '12%', deltaLabel: '-0.4% less', trend: 'down-good' },
    breakDuration: { value: '17 min', deltaLabel: 'steady', trend: 'flat' },
    phoneUsage: { value: '4 min', deltaLabel: '-0.6% less', trend: 'down-good' },
  },
  timeBreakdown: [
    { dept: 'Customer Ops', active: 312, idle: 68 }, { dept: 'Cash Ops', active: 288, idle: 52 },
    { dept: 'Security', active: 330, idle: 30 }, { dept: 'Facility', active: 296, idle: 64 },
  ],
  activeTrend: [
    { time: '9am', active: 90 }, { time: '10am', active: 85 }, { time: '11am', active: 78 }, { time: '12pm', active: 72 },
    { time: '1pm', active: 76 }, { time: '2pm', active: 81 }, { time: '3pm', active: 84 }, { time: '4pm', active: 88 },
  ],
};

// ── from Bank/src/Movement.jsx ──
// Backend later: GET /bank/movement (transitions trend, area coverage).
export const MOVEMENT_DATA = {
  stats: {
    transitions: { value: '18', deltaLabel: '+2 vs. yesterday', trend: 'flat' },
    zoneCompliance: { value: '96.4%', deltaLabel: '+0.5pt', trend: 'up' },
    restrictedEntries: { value: '3', deltaLabel: '-2 vs. last week', trend: 'down-good' },
    congestionFlags: { value: '1', deltaLabel: 'steady', trend: 'flat' },
  },
  transitionsTrend: [
    { time: '9am', transitions: 8 }, { time: '10am', transitions: 14 }, { time: '11am', transitions: 19 }, { time: '12pm', transitions: 24 },
    { time: '1pm', transitions: 21 }, { time: '2pm', transitions: 16 }, { time: '3pm', transitions: 12 }, { time: '4pm', transitions: 9 },
  ],
  areaCoverage: [
    { zone: 'Lobby', minutes: 210 }, { zone: 'Teller row', minutes: 340 }, { zone: 'Cash counters', minutes: 288 },
    { zone: 'Vault corridor', minutes: 60 }, { zone: 'Back office', minutes: 150 },
  ],
};

// ── from Bank/src/Security.jsx (stats; incidents reuse ALERTS_DATA) ──
// Backend later: GET /bank/security (compliance stats, incident feed).
export const SECURITY_DATA = {
  stats: {
    uniformCompliance: { value: '98.2%', deltaLabel: '+0.3pt', trend: 'up' },
    idCompliance: { value: '97.6%', deltaLabel: '-0.2pt', trend: 'up-bad' },
    emergencyResponse: { value: '2m 54s', deltaLabel: 'steady', trend: 'flat' },
    violations: { value: '2', deltaLabel: '-1 vs. yesterday', trend: 'down-good' },
  },
};

// ── from Bank/src/Facility.jsx ──
// Backend later: GET /bank/facility (active trend, cleaning by zone, tickets).
export const FACILITY_DATA = {
  stats: {
    cleaningDuration: { value: '19 min', deltaLabel: 'steady', trend: 'flat' },
    maintenanceResponse: { value: '24 min', deltaLabel: '-4 min faster', trend: 'down-good' },
    equipmentDowntime: { value: '1.4%', deltaLabel: '+0.3pt', trend: 'up-bad' },
    activeWorking: { value: '79%', deltaLabel: '+1.1pt', trend: 'up' },
  },
  activeTrend: [
    { time: '9am', active: 88 }, { time: '10am', active: 80 }, { time: '11am', active: 76 }, { time: '12pm', active: 70 },
    { time: '1pm', active: 74 }, { time: '2pm', active: 79 }, { time: '3pm', active: 82 }, { time: '4pm', active: 85 },
  ],
  cleaningByZone: [
    { zone: 'Lobby', minutes: 22 }, { zone: 'Restrooms', minutes: 18 }, { zone: 'Teller row', minutes: 15 }, { zone: 'Back office', minutes: 20 },
  ],
  tickets: [
    { id: 't1', equipment: 'ATM 2', issue: 'Card reader jam', status: 'in-progress', label: 'In progress', responseTime: '18 min' },
    { id: 't2', equipment: 'Air conditioning — Lobby', issue: 'Temperature fluctuation', status: 'resolved', label: 'Resolved', responseTime: '26 min' },
    { id: 't3', equipment: 'Printer — Counter 4', issue: 'Paper feed error', status: 'overdue', label: 'Overdue', responseTime: '40+ min' },
    { id: 't4', equipment: 'Main entrance door sensor', issue: 'Intermittent trigger', status: 'resolved', label: 'Resolved', responseTime: '12 min' },
  ],
};

// ── from Bank/src/reportsData.js + sectionReportsData.js ──
// Backend later: GET /bank/reports (department rollup, weekly trend, highlights, sections).
export const REPORTS_DATA = {
  departmentSummary: [
    { dept: 'Customer Operations', staffCount: 14, avgActiveTime: '82%', tasksCompleted: 226, complianceScore: 94 },
    { dept: 'Cash Operations', staffCount: 6, avgActiveTime: '88%', tasksCompleted: 164, complianceScore: 97 },
    { dept: 'Security', staffCount: 5, avgActiveTime: '91%', tasksCompleted: 58, complianceScore: 99 },
    { dept: 'Management', staffCount: 3, avgActiveTime: '74%', tasksCompleted: 31, complianceScore: 98 },
  ],
  weeklyTrend: [
    { day: 'Mon', compliance: 93, customers: 210 }, { day: 'Tue', compliance: 94, customers: 232 },
    { day: 'Wed', compliance: 92, customers: 198 }, { day: 'Thu', compliance: 95, customers: 245 },
    { day: 'Fri', compliance: 96, customers: 260 }, { day: 'Sat', compliance: 94, customers: 180 }, { day: 'Sun', compliance: 97, customers: 120 },
  ],
  highlights: [
    { type: 'Compliance', detail: 'Security dept. hit 99% compliance, best this month', level: 'good', time: 'Today' },
    { type: 'Productivity', detail: 'Customer Ops handled 31 more customers than last week', level: 'good', time: 'This week' },
    { type: 'Attention needed', detail: 'Management active time dipped to 74%, below target', level: 'warn', time: 'This week' },
    { type: 'Incident', detail: '1 vault-access policy exception logged, Cash Ops', level: 'warn', time: 'Wed' },
  ],
  sectionReports: [
    { key: 'teller', label: 'Teller operations', generatedFor: 'This week', metrics: [{ label: 'Customers served', value: '1,842' }, { label: 'Avg. transaction time', value: '3m 20s' }, { label: 'Avg. waiting time', value: '4m 12s' }, { label: 'Counter utilization', value: '86%' }] },
    { key: 'cash-ops', label: 'Cash operations', generatedFor: 'This week', metrics: [{ label: 'Cash transactions processed', value: '612' }, { label: 'Vault access events', value: '38' }, { label: 'Reconciliation accuracy', value: '99.4%' }, { label: 'Avg. processing time', value: '2m 05s' }] },
    { key: 'productivity', label: 'Workforce productivity', generatedFor: 'This week', metrics: [{ label: 'Avg. active time', value: '81%' }, { label: 'Avg. idle time', value: '13%' }, { label: 'Tasks completed', value: '479' }, { label: 'Phone usage (avg.)', value: '5 min' }] },
    { key: 'movement', label: 'Workforce movement', generatedFor: 'This week', metrics: [{ label: 'Zone transitions', value: '2,104' }, { label: 'Restricted area entries', value: '1' }, { label: 'Congestion events', value: '3' }, { label: 'Area coverage', value: '92%' }] },
    { key: 'security', label: 'Security & compliance', generatedFor: 'This week', metrics: [{ label: 'Unauthorized entries', value: '0' }, { label: 'Vault-access exceptions', value: '1' }, { label: 'ID badge compliance', value: '97%' }, { label: 'Emergency response time (avg.)', value: '2m 02s' }] },
    { key: 'facility', label: 'Facility & support', generatedFor: 'This week', metrics: [{ label: 'Maintenance tickets resolved', value: '22' }, { label: 'Avg. resolution time', value: '3h 40m' }, { label: 'Facility cleanliness score', value: '94%' }, { label: 'Open tickets', value: '4' }] },
  ],
};

// ── from Bank/src/staffDetailUtils.js ──
// Deterministic seeded RNG (mulberry32) so each staff member's history is stable
// across renders — no Math.random()/Date at call time (lint- & refresh-safe).
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// 7 days of active% history around the person's current load.
export function generateTrend(id, baseLoad) {
  const rand = mulberry32(seedFromString(id));
  return DAY_LABELS.map((label) => {
    const wobble = Math.round((rand() - 0.5) * 24);
    return { label, activePct: Math.max(10, Math.min(100, baseLoad + wobble)) };
  });
}

const INCIDENT_TYPES = [
  { type: 'Late clock-in', level: 'low', detail: 'Clocked in after scheduled start' },
  { type: 'Extended break', level: 'low', detail: 'Break exceeded 20 min target' },
  { type: 'Zone deviation', level: 'medium', detail: 'Detected outside assigned zone briefly' },
];

export function generateIncidents(id) {
  const rand = mulberry32(seedFromString(id) + 7);
  const count = Math.floor(rand() * 3); // 0-2 incidents
  const incidents = [];
  for (let i = 0; i < count; i++) {
    const t = INCIDENT_TYPES[Math.floor(rand() * INCIDENT_TYPES.length)];
    const hoursAgo = Math.floor(rand() * 48) + 1;
    incidents.push({ ...t, timeLabel: hoursAgo < 24 ? `${hoursAgo} hr ago` : `${Math.floor(hoursAgo / 24)}d ago` });
  }
  return incidents;
}
