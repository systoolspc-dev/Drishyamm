// Central mock data source for the Hospitality (hotel) vertical.
// Migrated from the standalone Hospitality/ app: the inline datasets that lived
// inside each page component are extracted here (and in pages-data.js) so every
// widget reads from one place. Swap for real API data later.
//
// Unlike Hostel (boys/girls), Hospitality is a single property — data is a flat
// object, not keyed by a segment. Backend later: GET /hospitality/overview.

export const HOSPITALITY_DATA = {
  property: 'Grand Aurelia Hotel',
  // ── Dashboard key metrics (from Hospitality/src/Dashboard.jsx STAT_CARDS) ──
  activeStaff: { value: 142, of: 160, deltaLabel: '+3.2% · on duty now' },
  guestResponseTime: { value: '3m 24s', deltaLabel: '-6.4% faster today' },
  roomCleaningTime: { value: '29 min', deltaLabel: '+2.4% slower today' },
  complianceScore: { value: 91, deltaLabel: 'steady · last 30 days' },
  occupancy: { value: 88, deltaLabel: '282 of 320 rooms sold' },
  openIncidents: { value: 3, deltaLabel: '1 high priority' },

  // Rooms cleaned vs. scheduled, this week (Dashboard "Rooms cleaned per day").
  weeklyVolume: [
    { day: 'Mon', completed: 142, pending: 160 },
    { day: 'Tue', completed: 138, pending: 151 },
    { day: 'Wed', completed: 161, pending: 170 },
    { day: 'Thu', completed: 147, pending: 155 },
    { day: 'Fri', completed: 172, pending: 178 },
    { day: 'Sat', completed: 189, pending: 190 },
    { day: 'Sun', completed: 121, pending: 130 },
  ],
  // Minutes for staff to reach a guest, hour by hour (Dashboard response trend).
  responseTrend: [
    { time: '00:00', minutes: 2.8 },
    { time: '04:00', minutes: 2.1 },
    { time: '08:00', minutes: 3.9 },
    { time: '12:00', minutes: 4.8 },
    { time: '16:00', minutes: 5.2 },
    { time: '20:00', minutes: 3.4 },
  ],
  // Current shift roster shown on the dashboard ("Who's working right now").
  staffStatus: [
    { id: 'priya-nandakumar', name: 'Priya Nandakumar', role: 'Front Desk Lead', status: 'active', load: 82 },
    { id: 'daniel-osei', name: 'Daniel Osei', role: 'Housekeeping Supervisor', status: 'active', load: 76 },
    { id: 'lucia-ferreira', name: 'Lucia Ferreira', role: 'Housekeeping Staff', status: 'break', load: 12 },
    { id: 'marcus-chen', name: 'Marcus Chen', role: 'Security', status: 'active', load: 71 },
    { id: 'ines-dubois', name: 'Ines Dubois', role: 'F&B Staff', status: 'offline', load: 0 },
  ],
  // Live housekeeping status feeding the dashboard's Active Tasks panel.
  cleaningStatus: [
    { zone: 'Floor 2 — Standard rooms', status: 'in-progress', updated: '9:10 AM' },
    { zone: 'Floor 4 — Deluxe rooms', status: 'done', updated: '8:40 AM' },
    { zone: 'Floor 7 — Suites', status: 'in-progress', updated: '9:25 AM' },
    { zone: 'Lobby & public areas', status: 'done', updated: '7:55 AM' },
    { zone: 'Pool deck & spa', status: 'pending', updated: '—' },
  ],
};

// ── Filter hierarchy: Property → Area → Zone + Time-range ─────────────────────
// Cosmetic (mirrors the Hostel filter bar); future backend: GET /hospitality/hierarchy.
export const HOSPITALITY_HIERARCHY = {
  areas: [
    { id: 'foh', label: 'Front of House' },
    { id: 'hk', label: 'Housekeeping' },
    { id: 'fnb', label: 'Food & Beverage' },
    { id: 'boh', label: 'Back of House' },
  ],
  zones: {
    foh: [{ id: 'lobby', label: 'Lobby' }, { id: 'concierge', label: 'Concierge' }, { id: 'bell', label: 'Bell desk' }],
    hk: [{ id: 'f2', label: 'Floor 2' }, { id: 'f4', label: 'Floor 4' }, { id: 'f7', label: 'Floor 7' }],
    fnb: [{ id: 'kitchen', label: 'Kitchen' }, { id: 'rooftop', label: 'Rooftop bar' }],
    boh: [{ id: 'dock', label: 'Loading dock' }, { id: 'server', label: 'Server room' }],
  },
};

export const TIME_RANGES = [
  { id: 'live', label: 'Live (now)' }, { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24 hours' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' },
];

// Shared status + severity chip classes (Tailwind ring style, consistent with
// the other verticals). Colour is the ONLY strong signal on a neutral card.
export const STATUS_CHIP = {
  done: 'bg-success-soft text-success-ink ring-success-line',
  'in-progress': 'bg-warning-soft text-warning-ink ring-warning-line',
  pending: 'bg-surface-muted text-fg-muted ring-line',
  clear: 'bg-success-soft text-success-ink ring-success-line',
  attention: 'bg-warning-soft text-warning-ink ring-warning-line',
  blocked: 'bg-danger-soft text-danger-ink ring-danger-line',
  open: 'bg-success-soft text-success-ink ring-success-line',
  staffed: 'bg-success-soft text-success-ink ring-success-line',
  active: 'bg-success-soft text-success-ink ring-success-line',
  break: 'bg-warning-soft text-warning-ink ring-warning-line',
  offline: 'bg-surface-muted text-fg-muted ring-line',
};
export const LEVEL_CHIP = {
  high: 'bg-danger-soft text-danger-ink ring-danger-line',
  medium: 'bg-warning-soft text-warning-ink ring-warning-line',
  low: 'bg-surface-muted text-fg-muted ring-line',
};

// A metric object ({ value, of?, deltaLabel }) → a StatCards card. Kept in this
// .js module (not bits.jsx) so Fast Refresh only sees components in the .jsx file.
export function metricCard(key, label, m) {
  if (!m) return { key, label, value: '—', sub: '' };
  return { key, label, value: m.of != null ? `${m.value} / ${m.of}` : `${m.value}`, sub: m.deltaLabel };
}
