// Central mock data source for the Bank (branch) vertical.
// Migrated from the standalone Bank/ ("BankPulse") app: its data modules
// (staffData.js, reportsData.js, sectionReportsData.js) plus the inline consts
// that lived inside each page component are consolidated here (and in
// pages-data.js) so every widget reads from one place. Swap for real API later.
//
// Single branch (not segment-keyed), so this is a flat object — no store.
// Backend later: GET /bank/overview.

export const BANK_DATA = {
  branch: 'MG Road Branch',
  // ── Dashboard key metrics (from Bank/src/Dashboard.jsx STAT_CARDS) ──
  employeesOnDuty: { value: 34, of: 38, deltaLabel: '+2 vs. yesterday' },
  avgWaitingTime: { value: '4m 12s', deltaLabel: '-6.4% faster today' },
  queueLength: { value: 7, deltaLabel: 'steady · waiting now' },
  complianceScore: { value: 96, deltaLabel: '+0.8pt rolling 24h' },
  vaultVisits: { value: 4, deltaLabel: 'today · dual-auth tracked' },
  openAlerts: { value: 5, deltaLabel: '2 high priority' },

  // Customers served, hour by hour (Dashboard "Customers served through the day").
  customerTrend: [
    { time: '9am', customers: 12 }, { time: '10am', customers: 28 }, { time: '11am', customers: 41 },
    { time: '12pm', customers: 53 }, { time: '1pm', customers: 47 }, { time: '2pm', customers: 36 },
    { time: '3pm', customers: 30 }, { time: '4pm', customers: 19 },
  ],
  // Staff utilization (active vs idle minutes) by department (Dashboard).
  utilizationByDept: [
    { dept: 'Customer Ops', active: 312, idle: 68 },
    { dept: 'Cash Ops', active: 288, idle: 52 },
    { dept: 'Loans', active: 240, idle: 80 },
    { dept: 'Security', active: 330, idle: 30 },
  ],
};

// ── Filter hierarchy: Branch → Area → Zone + Time-range ───────────────────────
// Cosmetic (mirrors the Hospitality filter bar); future backend: GET /bank/hierarchy.
export const BANK_HIERARCHY = {
  areas: [
    { id: 'foh', label: 'Customer Floor' },
    { id: 'cash', label: 'Cash & Vault' },
    { id: 'boh', label: 'Back Office' },
    { id: 'ext', label: 'Facility / ATM' },
  ],
  zones: {
    foh: [{ id: 'lobby', label: 'Lobby' }, { id: 'teller', label: 'Teller row' }, { id: 'relations', label: 'Relationship desks' }],
    cash: [{ id: 'counters', label: 'Cash counters' }, { id: 'vault', label: 'Vault corridor' }],
    boh: [{ id: 'backoffice', label: 'Back office' }, { id: 'server', label: 'Server room' }],
    ext: [{ id: 'atm', label: 'ATM lobby' }, { id: 'entrance', label: 'Main entrance' }],
  },
};

export const TIME_RANGES = [
  { id: 'live', label: 'Live (now)' }, { id: 'today', label: 'Today' },
  { id: '24h', label: 'Last 24 hours' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' },
];

// Shared status + severity chip classes (Tailwind ring style, consistent with
// the other verticals). Colour is the ONLY strong signal on a neutral card.
export const STATUS_CHIP = {
  open: 'bg-success-soft text-success-ink ring-success-line',
  active: 'bg-success-soft text-success-ink ring-success-line',
  resolved: 'bg-success-soft text-success-ink ring-success-line',
  confirmed: 'bg-success-soft text-success-ink ring-success-line',
  good: 'bg-success-soft text-success-ink ring-success-line',
  break: 'bg-warning-soft text-warning-ink ring-warning-line',
  'in-progress': 'bg-warning-soft text-warning-ink ring-warning-line',
  warn: 'bg-warning-soft text-warning-ink ring-warning-line',
  pending: 'bg-surface-muted text-fg-muted ring-line',
  closed: 'bg-surface-muted text-fg-muted ring-line',
  offline: 'bg-surface-muted text-fg-muted ring-line',
  overdue: 'bg-danger-soft text-danger-ink ring-danger-line',
  single: 'bg-danger-soft text-danger-ink ring-danger-line',
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
