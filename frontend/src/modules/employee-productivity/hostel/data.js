// Central mock data source, keyed by hostel ("boys" | "girls").
// Swap this for real API data later — every widget reads from here.

export const HOSTEL_DATA = {
  boys: {
    label: "Boys Hostel",
    staffOnDuty: { value: 42, of: 51, deltaLabel: "+2 vs. yesterday" },
    studentsPresent: { value: 612, of: 680, deltaLabel: "90% occupancy" },
    visitorCount: { value: 18, deltaLabel: "3 currently on premises" },
    hostelOccupancy: { value: 90, deltaLabel: "+1.2% vs. last week" },
    safetyAlerts: { value: 3, deltaLabel: "1 high priority" },
    complianceScore: { value: 91.4, deltaLabel: "+0.6pt rolling 7d" },
    entryExitTrend: [
      { time: "6am", entries: 8, exits: 2 },
      { time: "8am", entries: 34, exits: 12 },
      { time: "10am", entries: 12, exits: 40 },
      { time: "12pm", entries: 28, exits: 30 },
      { time: "2pm", entries: 10, exits: 8 },
      { time: "4pm", entries: 22, exits: 14 },
      { time: "6pm", entries: 46, exits: 10 },
      { time: "8pm", entries: 18, exits: 6 },
      { time: "10pm", entries: 4, exits: 3 },
    ],
    cleaningStatus: [
      { zone: "Block A — Floors 1-4", status: "done", updated: "7:40 AM" },
      { zone: "Block B — Floors 1-4", status: "in-progress", updated: "9:10 AM" },
      { zone: "Common washrooms", status: "done", updated: "8:05 AM" },
      { zone: "Mess hall", status: "pending", updated: "—" },
      { zone: "Recreation room", status: "done", updated: "7:55 AM" },
    ],
    maintenanceStatus: [
      { task: "Leaking tap — Block A, Room 214", status: "in-progress", updated: "10:22 AM" },
      { task: "Fan repair — Block B, Room 108", status: "pending", updated: "—" },
      { task: "Corridor light — Block A, Floor 3", status: "done", updated: "9:15 AM" },
      { task: "Door lock — Block C, Room 302", status: "pending", updated: "—" },
    ],
  },
  girls: {
    label: "Girls Hostel",
    staffOnDuty: { value: 36, of: 44, deltaLabel: "+1 vs. yesterday" },
    studentsPresent: { value: 548, of: 590, deltaLabel: "93% occupancy" },
    visitorCount: { value: 9, deltaLabel: "1 currently on premises" },
    hostelOccupancy: { value: 93, deltaLabel: "+0.4% vs. last week" },
    safetyAlerts: { value: 1, deltaLabel: "0 high priority" },
    complianceScore: { value: 95.2, deltaLabel: "+0.9pt rolling 7d" },
    entryExitTrend: [
      { time: "6am", entries: 5, exits: 1 },
      { time: "8am", entries: 28, exits: 9 },
      { time: "10am", entries: 8, exits: 32 },
      { time: "12pm", entries: 20, exits: 24 },
      { time: "2pm", entries: 6, exits: 5 },
      { time: "4pm", entries: 16, exits: 10 },
      { time: "6pm", entries: 38, exits: 8 },
      { time: "8pm", entries: 12, exits: 4 },
      { time: "10pm", entries: 2, exits: 2 },
    ],
    cleaningStatus: [
      { zone: "Block A — Floors 1-3", status: "done", updated: "7:30 AM" },
      { zone: "Block B — Floors 1-3", status: "done", updated: "8:15 AM" },
      { zone: "Common washrooms", status: "in-progress", updated: "9:40 AM" },
      { zone: "Mess hall", status: "done", updated: "8:00 AM" },
      { zone: "Reading room", status: "pending", updated: "—" },
    ],
    maintenanceStatus: [
      { task: "AC servicing — Block A, Room 112", status: "in-progress", updated: "10:05 AM" },
      { task: "Window latch — Block B, Room 204", status: "done", updated: "9:20 AM" },
      { task: "Water cooler — Ground floor", status: "pending", updated: "—" },
    ],
  },
};
// ── Filter hierarchy: Hostel → Block → Floor → Wing → Room ────────────────────
// Future backend: GET /hostel/hierarchy → nested {id,label,children[]}.
const FLOORS_STD = [
  { id: 'g', label: 'Ground Floor' }, { id: 'f1', label: '1st Floor' },
  { id: 'f2', label: '2nd Floor' }, { id: 'f3', label: '3rd Floor' },
];
export const HOSTEL_HIERARCHY = {
  // top level mirrors the boys/girls store selection
  blocks: {
    boys: [{ id: 'a', label: 'Block A' }, { id: 'b', label: 'Block B' }, { id: 'c', label: 'Block C' }, { id: 'd', label: 'Block D' }],
    girls: [{ id: 'a', label: 'Block A' }, { id: 'b', label: 'Block B' }, { id: 'c', label: 'Block C' }],
  },
  floors: { a: FLOORS_STD, b: FLOORS_STD, c: FLOORS_STD, d: FLOORS_STD },
  wings: {
    a: [{ id: 'e', label: 'East Wing' }, { id: 'w', label: 'West Wing' }],
    b: [{ id: 'e', label: 'East Wing' }, { id: 'w', label: 'West Wing' }],
    c: [{ id: 'n', label: 'North Wing' }], d: [{ id: 's', label: 'South Wing' }],
  },
  rooms: {
    'a:e': [{ id: 'r101', label: 'Room 101' }, { id: 'r102', label: 'Room 102' }],
    'a:w': [{ id: 'r110', label: 'Room 110' }, { id: 'r111', label: 'Room 111' }],
    'b:e': [{ id: 'r201', label: 'Room 201' }, { id: 'r202', label: 'Room 202' }],
  },
};

export const TIME_RANGES = [
  { id: 'live', label: 'Live (now)' }, { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24 hours' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' },
];

// Shared status + severity chip classes (Tailwind ring style, consistent with
// the other verticals). Colour is the ONLY signal on an otherwise neutral card.
export const STATUS_CHIP = {
  done: 'bg-success-soft text-success-ink ring-success-line',
  'in-progress': 'bg-warning-soft text-warning-ink ring-warning-line',
  pending: 'bg-surface-muted text-fg-muted ring-line',
  open: 'bg-success-soft text-success-ink ring-success-line',
  closed: 'bg-surface-muted text-fg-muted ring-line',
  active: 'bg-success-soft text-success-ink ring-success-line',
  break: 'bg-warning-soft text-warning-ink ring-warning-line',
  offline: 'bg-surface-muted text-fg-muted ring-line',
};
export const LEVEL_CHIP = {
  high: 'bg-danger-soft text-danger-ink ring-danger-line',
  medium: 'bg-warning-soft text-warning-ink ring-warning-line',
  low: 'bg-surface-muted text-fg-muted ring-line',
};

// A metric object ({ value, of?, deltaLabel }) → a StatCards card.
export function metricCard(key, label, m) {
  if (!m) return { key, label, value: '—', sub: '' };
  return { key, label, value: m.of != null ? `${m.value} / ${m.of}` : `${m.value}`, sub: m.deltaLabel };
}
