// Page datasets extracted out of the standalone Hospitality/ page components
// (they were inline const arrays inside each .jsx). One module per source page.
// Every block keeps the source's exact numbers/labels. Backend contracts noted
// inline — each dummy block maps to one future endpoint.

// ── from Hospitality/src/GuestService.jsx ──
// Backend later: GET /hospitality/guest-service (queue, desk interactions, desks).
export const GUEST_SERVICE_DATA = {
  stats: {
    responseTime: { value: '3m 24s', deltaLabel: '-6.4% faster', trend: 'down-good' },
    waitingTime: { value: '2m 10s', deltaLabel: '-1.1% faster', trend: 'down-good' },
    interactionDuration: { value: '6m 48s', deltaLabel: '+0.8%', trend: 'up' },
    queueLength: { value: '9', deltaLabel: 'steady', trend: 'flat' },
  },
  queueTrend: [
    { time: '8am', guests: 4 }, { time: '10am', guests: 9 }, { time: '12pm', guests: 14 },
    { time: '2pm', guests: 7 }, { time: '4pm', guests: 11 }, { time: '6pm', guests: 16 }, { time: '8pm', guests: 6 },
  ],
  interactionByDesk: [
    { desk: 'Front desk', actual: 7.2 }, { desk: 'Concierge', actual: 8.6 },
    { desk: 'Bell desk', actual: 4.1 }, { desk: 'Business ctr', actual: 5.4 },
  ],
  desks: [
    { id: 'front-desk', name: 'Front desk', role: 'Check-in / check-out', status: 'staffed', queue: 5 },
    { id: 'concierge', name: 'Concierge', role: 'Guest requests', status: 'staffed', queue: 2 },
    { id: 'bell-desk', name: 'Bell desk', role: 'Luggage & transport', status: 'break', queue: 0 },
    { id: 'business-center', name: 'Business center', role: 'Printing & workspace', status: 'offline', queue: 0 },
  ],
};

// ── from Hospitality/src/Housekeeping.jsx ──
// Backend later: GET /hospitality/housekeeping (cleaning times, activity, floors).
export const HOUSEKEEPING_DATA = {
  stats: {
    cleaningTime: { value: '29 min', deltaLabel: '+2.4% slower', trend: 'up-bad' },
    turnaroundTime: { value: '47 min', deltaLabel: '-3.1% faster', trend: 'down-good' },
    activeWorking: { value: '78%', deltaLabel: '+1.6%', trend: 'up' },
    revisitCount: { value: '3', deltaLabel: 'steady', trend: 'flat' },
  },
  cleaningByType: [
    { type: 'Standard', minutes: 24 }, { type: 'Deluxe', minutes: 31 },
    { type: 'Suite', minutes: 46 }, { type: 'Presidential', minutes: 68 },
  ],
  activityTrend: [
    { time: '8am', active: 92 }, { time: '10am', active: 88 }, { time: '12pm', active: 74 },
    { time: '2pm', active: 81 }, { time: '4pm', active: 69 }, { time: '6pm', active: 58 },
  ],
  floorStatus: [
    { name: 'Floor 2 — Standard', role: '18 rooms assigned', status: 'in-progress', revisits: 1 },
    { name: 'Floor 4 — Deluxe', role: '12 rooms assigned', status: 'in-progress', revisits: 0 },
    { name: 'Floor 7 — Suite', role: '6 rooms assigned', status: 'break', revisits: 2 },
    { name: 'Floor 9 — Presidential', role: '2 rooms assigned', status: 'in-progress', revisits: 0 },
  ],
};

// ── from Hospitality/src/Productivity.jsx ──
// Backend later: GET /hospitality/productivity (active/idle by dept, staff level).
export const PRODUCTIVITY_DATA = {
  stats: {
    activeTime: { value: '76%', deltaLabel: '+1.8%', trend: 'up' },
    idleTime: { value: '14%', deltaLabel: '-0.6% less', trend: 'down-good' },
    breakDuration: { value: '22 min', deltaLabel: 'steady', trend: 'flat' },
    phoneUsage: { value: '6 min', deltaLabel: '+1.2% more', trend: 'up-bad' },
  },
  timeBreakdown: [
    { dept: 'Front desk', active: 340, idle: 60 }, { dept: 'Housekeeping', active: 298, idle: 82 },
    { dept: 'F&B', active: 265, idle: 95 }, { dept: 'Security', active: 351, idle: 49 },
  ],
  activeTrend: [
    { time: '8am', active: 91 }, { time: '10am', active: 86 }, { time: '12pm', active: 72 },
    { time: '2pm', active: 79 }, { time: '4pm', active: 68 }, { time: '6pm', active: 61 },
  ],
  staffDetail: [
    { name: 'Priya Nandakumar', role: 'Front Desk Lead', status: 'active', load: 88 },
    { name: 'Daniel Osei', role: 'Housekeeping Supervisor', status: 'active', load: 74 },
    { name: 'Lucia Ferreira', role: 'Housekeeping Staff', status: 'break', load: 12 },
    { name: 'Marcus Chen', role: 'Security', status: 'active', load: 91 },
  ],
};

// ── from Hospitality/src/Movement.jsx ──
// Backend later: GET /hospitality/movement (live zone occupancy, restricted events).
export const MOVEMENT_DATA = {
  stats: {
    transitions: { value: '1,284', deltaLabel: '+4.1%', trend: 'up' },
    zoneCompliance: { value: '94%', deltaLabel: '+0.9%', trend: 'up' },
    restrictedEntries: { value: '1', deltaLabel: 'steady', trend: 'flat' },
    areaCoverage: { value: '97%', deltaLabel: 'steady', trend: 'flat' },
  },
  zones: [
    { name: 'Lobby', assigned: 'Front desk staff', count: 6, capacity: 8, level: 'low' },
    { name: 'Floor 2 corridor', assigned: 'Housekeeping', count: 9, capacity: 10, level: 'medium' },
    { name: 'Kitchen', assigned: 'F&B staff', count: 11, capacity: 12, level: 'high' },
    { name: 'Loading dock', assigned: 'Deliveries only', count: 2, capacity: 4, level: 'low' },
    { name: 'Staff corridor B', assigned: 'All staff', count: 4, capacity: 15, level: 'low' },
    { name: 'Pool deck', assigned: 'Recreation staff', count: 3, capacity: 6, level: 'low' },
    { name: 'Server room', assigned: 'IT / security only', count: 1, capacity: 2, level: 'medium' },
    { name: 'Rooftop bar', assigned: 'F&B staff', count: 7, capacity: 10, level: 'medium' },
  ],
  events: [
    { type: 'Unbadged entry — Server room', detail: 'Detected by corridor camera 4', level: 'high', time: '6 min ago' },
    { type: 'Congestion — Kitchen', detail: '11 of 12 capacity, sustained 8+ min', level: 'medium', time: '14 min ago' },
    { type: 'Off-zone staff — Rooftop bar', detail: 'Housekeeping staff detected outside assigned zone', level: 'medium', time: '41 min ago' },
  ],
};

// ── from Hospitality/src/Safety.jsx ──
// Backend later: GET /hospitality/safety (exit/equipment status, incidents).
export const SAFETY_DATA = {
  stats: {
    ppeCompliance: { value: '91%', deltaLabel: '+0.4%', trend: 'up' },
    openIncidents: { value: '3', deltaLabel: '-1 vs. yesterday', trend: 'down-good' },
    exitClearance: { value: '3 / 4', deltaLabel: 'steady', trend: 'flat' },
    hazardEntries: { value: '1', deltaLabel: 'steady', trend: 'flat' },
  },
  points: [
    { name: 'Exit A — Lobby', detail: 'Primary evacuation route', status: 'clear' },
    { name: 'Exit B — Kitchen', detail: 'Secondary evacuation route', status: 'clear' },
    { name: 'Exit C — Loading dock', detail: 'Staff-only evacuation route', status: 'attention' },
    { name: 'Extinguisher station 3', detail: 'Floor 2 corridor', status: 'clear' },
    { name: 'Chemical storage', detail: 'Hazard zone, restricted access', status: 'clear' },
    { name: 'Extinguisher station 7', detail: 'Kitchen, near loading dock', status: 'blocked' },
    { name: 'Sprinkler zone — Server room', detail: 'Fire suppression, IT wing', status: 'clear' },
    { name: 'Exit D — Rooftop', detail: 'Bar & pool deck evacuation route', status: 'clear' },
  ],
  incidents: [
    { type: 'PPE violation — Kitchen', detail: 'Staff detected without required hairnet, 2 occurrences', level: 'medium', time: '22 min ago' },
    { type: 'Exit C partially obstructed', detail: 'Storage cart detected blocking evacuation route', level: 'high', time: '38 min ago' },
    { type: 'Extinguisher station 7 blocked', detail: 'Delivery pallet detected in front of station', level: 'high', time: '1 hr ago' },
    { type: 'Hazard zone entry — Chemical storage', detail: 'Authorized staff badge match, logged for audit', level: 'low', time: '2 hr ago' },
  ],
};

// ── from Hospitality/src/Reports.jsx ──
// Backend later: GET /hospitality/reports (types, weekly trend, comparison, history).
export const REPORTS_DATA = {
  reportTypes: [
    { key: 'operations', title: 'Weekly operations summary', desc: 'All departments, key metrics for the week', lastGenerated: 'Jul 14, 2026' },
    { key: 'safety', title: 'Safety & compliance audit', desc: 'PPE compliance, incidents, exit clearance', lastGenerated: 'Jul 10, 2026' },
    { key: 'incidents', title: 'Incident log', desc: 'All flagged incidents across zones', lastGenerated: 'Jul 16, 2026' },
    { key: 'productivity', title: 'Staff productivity report', desc: 'Active time, idle time, by department', lastGenerated: 'Jul 12, 2026' },
  ],
  weeklyTrend: [
    { week: 'May 25', incidents: 9, compliance: 87 }, { week: 'Jun 1', incidents: 7, compliance: 88 },
    { week: 'Jun 8', incidents: 11, compliance: 85 }, { week: 'Jun 15', incidents: 6, compliance: 90 },
    { week: 'Jun 22', incidents: 8, compliance: 89 }, { week: 'Jun 29', incidents: 5, compliance: 91 },
    { week: 'Jul 6', incidents: 4, compliance: 91 }, { week: 'Jul 13', incidents: 3, compliance: 91 },
  ],
  thisVsLast: [
    { metric: 'Response time', thisWeek: 3.4, lastWeek: 3.9 },
    { metric: 'Compliance', thisWeek: 91, lastWeek: 89 },
    { metric: 'Incidents', thisWeek: 3, lastWeek: 5 },
    { metric: 'Active time %', thisWeek: 76, lastWeek: 74 },
  ],
  reportHistory: [
    { name: 'Weekly operations summary', range: 'Jul 7 – Jul 13, 2026', generated: 'Jul 14, 2026', format: 'PDF' },
    { name: 'Incident log', range: 'Jul 15, 2026', generated: 'Jul 16, 2026', format: 'CSV' },
    { name: 'Safety & compliance audit', range: 'Jun 1 – Jun 30, 2026', generated: 'Jul 10, 2026', format: 'PDF' },
    { name: 'Staff productivity report', range: 'Jul 5 – Jul 11, 2026', generated: 'Jul 12, 2026', format: 'CSV' },
    { name: 'Weekly operations summary', range: 'Jun 30 – Jul 6, 2026', generated: 'Jul 7, 2026', format: 'PDF' },
  ],
};

// ── from Hospitality/src/StaffDetail.jsx STAFF map (expanded to a roster) ──
// Backend later: GET /hospitality/staff and /hospitality/staff/:id.
export const STAFF_DATA = [
  {
    id: 'priya-nandakumar', name: 'Priya Nandakumar', role: 'Front Desk Lead', dept: 'Guest Service',
    status: 'active', activePct: 82, employeeId: 'HP-1042', scheduledShift: '7:00 AM – 3:00 PM', actualClockIn: '7:04 AM',
    avgResponse: 3.4, taskTarget: 40, complianceScore: 94, teamAvgLoad: 74, teamAvgResponse: 4.1,
  },
  {
    id: 'daniel-osei', name: 'Daniel Osei', role: 'Housekeeping Supervisor', dept: 'Housekeeping',
    status: 'active', activePct: 76, employeeId: 'HP-2210', scheduledShift: '6:30 AM – 2:30 PM', actualClockIn: '6:29 AM',
    avgResponse: 5.1, taskTarget: 34, complianceScore: 88, teamAvgLoad: 70, teamAvgResponse: 5.6,
  },
  {
    id: 'lucia-ferreira', name: 'Lucia Ferreira', role: 'Housekeeping Staff', dept: 'Housekeeping',
    status: 'break', activePct: 12, employeeId: 'HP-2287', scheduledShift: '8:00 AM – 4:00 PM', actualClockIn: '8:21 AM',
    avgResponse: 6.8, taskTarget: 28, complianceScore: 71, teamAvgLoad: 70, teamAvgResponse: 5.6,
  },
  {
    id: 'marcus-chen', name: 'Marcus Chen', role: 'Security', dept: 'Safety & Compliance',
    status: 'active', activePct: 71, employeeId: 'HP-3041', scheduledShift: '9:00 AM – 5:00 PM', actualClockIn: '8:58 AM',
    avgResponse: 2.9, taskTarget: 20, complianceScore: 97, teamAvgLoad: 68, teamAvgResponse: 3.5,
  },
  {
    id: 'ines-dubois', name: 'Ines Dubois', role: 'F&B Staff', dept: 'Food & Beverage',
    status: 'offline', activePct: 0, employeeId: 'HP-1178', scheduledShift: '10:00 AM – 6:00 PM', actualClockIn: '—',
    avgResponse: 4.7, taskTarget: 30, complianceScore: 80, teamAvgLoad: 74, teamAvgResponse: 4.1,
  },
];

// Deterministic seeded RNG (mulberry32) so each staff member's mock history is
// stable across renders — no Math.random()/Date at call time (lint- & refresh-safe).
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return h;
}

// 14 days of active%/response trend around a staff member's baseline. Labels are
// index-based (d1…d14) so the series is fully deterministic — no wall-clock dates.
export function generateTrend(emp) {
  const rand = mulberry32(hashSeed(emp.id));
  const days = [];
  for (let i = 1; i <= 14; i++) {
    const wobble = (rand() - 0.5) * 20;
    const activePct = Math.max(0, Math.min(100, Math.round(emp.activePct + wobble)));
    const responseMin = Math.max(1, +(emp.avgResponse + (rand() - 0.5) * 2).toFixed(1));
    const tasksCompleted = Math.max(0, Math.round(emp.taskTarget * ((activePct + 20) / 120)));
    days.push({ label: `d${i}`, activePct, responseMin, tasksCompleted, tasksTarget: emp.taskTarget });
  }
  return days;
}

const INCIDENT_POOL = [
  { type: 'Away from station', level: 'medium', detail: '22 min unaccounted, front desk camera' },
  { type: 'PPE violation', level: 'high', detail: 'No gloves detected, housekeeping cart 3' },
  { type: 'Restricted zone entry', level: 'high', detail: 'Server room, no badge scan logged' },
  { type: 'Late clock-in', level: 'medium', detail: '18 minutes after scheduled start' },
  { type: 'Break overrun', level: 'medium', detail: 'Break ran 14 min past allotted 30' },
];

export function generateIncidents(emp) {
  const rand = mulberry32(hashSeed(emp.id) + 99);
  const count = 2 + Math.floor(rand() * 3);
  const incidents = [];
  for (let i = 0; i < count; i++) {
    const item = INCIDENT_POOL[Math.floor(rand() * INCIDENT_POOL.length)];
    const hoursAgo = 1 + Math.floor(rand() * 72);
    incidents.push({
      ...item,
      timeLabel: hoursAgo < 24 ? `${hoursAgo} hr ago` : `${Math.floor(hoursAgo / 24)} day ago`,
    });
  }
  return incidents;
}
