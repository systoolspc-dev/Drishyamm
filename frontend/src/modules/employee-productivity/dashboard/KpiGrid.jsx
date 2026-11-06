import {
  Gauge, Users, LayoutGrid, Timer,
} from 'lucide-react';
import KpiBand from '../kpi-card';
import { useActivityParams } from '../useCaseStore';
import { useModuleData } from '../useModuleData';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — KPI cards. FOUR on retail, three on corporate (no billing queue
// in an office). The row answers only the questions a manager acts on in the
// first five seconds:
//
//   Store Health        87 /100          → is the store OK?
//   Staff Present       11 / 12          → is the team here?
//   Queue Wait          3.2 min avg wait → are customers waiting?
//   Counters            2 / 3            → are the tills manned?
//
// Everything else that used to own a card now lives where it is actionable —
// phone incidents and lateness on the Employee Status row, active alerts as
// the Needs Attention count, average working hours in the Reports export.
// Card shapes: ./dto.d.ts (ScoreKpi | RatioKpi | MeasureKpi).
//
// The card itself — anatomy, colours, grid, height — is the module-wide
// KpiCard in ../kpi-card.jsx, the same card every subpage and vertical uses.
// This file only chooses WHICH cards the dashboard shows and where each one
// links. Its one line of aggregate context is `sub` in ./data.js; no names,
// no single named counter — see the rules written over KPIS there.
// ─────────────────────────────────────────────────────────────────────────────

// Counter coverage + billing queue are retail-only concepts; desk occupancy is
// the office stand-in for coverage and only exists in corporate-data.js.
const RETAIL_ONLY_KPIS = new Set(['coverage', 'queue']);

// The consolidated four, in reading order. Anything not listed here is not a
// dashboard KPI — it belongs to a subpage.
const KPI_ORDER = ['health', 'present', 'queue', 'coverage', 'occupancy'];

// Icon per KPI key — semantic, mirrors the sidebar's icon philosophy.
const ICONS = {
  health: Gauge, present: Users, queue: Timer,
  coverage: LayoutGrid, occupancy: LayoutGrid,
};

// Every KPI is a doorway: the card IS the shortcut button to the module that
// can resolve what it is reporting. Each target is the page a manager would
// have navigated to anyway after reading the number.
//
//   health    → Staff Performance (the scorecard the composite comes from)
//   present   → Attendance Report(the names behind "2 Pending", and the actions)
//   queue     → Zone Headcount   (live queue lengths per counter)
//   coverage  → Zone Coverage    (which counter is unattended, and for how long)
//   occupancy → Zone Headcount   (the office analogue of coverage)
const LINKS = {
  health:    '/activity-monitoring/performance',
  present:   '/attendance-report',
  queue:     '/activity-monitoring/headcount',
  coverage:  '/activity-monitoring/zones',
  occupancy: '/activity-monitoring/headcount',
};

// Where each card says it goes. Spoken by the hover affordance and by the
// card's aria-label, so the destination is knowable before the click and is
// announced rather than merely implied by a cursor change.
const LINK_LABELS = {
  health:    'Staff Performance',
  present:   'Attendance Report',
  queue:     'Zone Headcount',
  coverage:  'Zone Coverage',
  occupancy: 'Zone Headcount',
};

export default function KpiGrid({ loading }) {
  const { useCase } = useActivityParams();
  const { KPIS } = useModuleData();
  const isRetail = useCase === 'retail';

  // Corporate drops the retail-only KPIs and the "Store " label prefix.
  const kpis = KPIS
    .filter((k) => KPI_ORDER.includes(k.key))
    .filter((k) => isRetail || !RETAIL_ONLY_KPIS.has(k.key))
    .sort((a, b) => KPI_ORDER.indexOf(a.key) - KPI_ORDER.indexOf(b.key))
    .map((k) => (isRetail ? k : { ...k, label: k.label.replace(/^Store /, '') }));

  return (
    <KpiBand
      cards={kpis}
      fallbackLink="/activity-monitoring"
      icons={ICONS}
      linkLabels={LINK_LABELS}
      links={LINKS}
      loading={loading}
    />
  );
}
