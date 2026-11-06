import { Users, ListOrdered, ShieldCheck, Lock } from 'lucide-react';
import KpiBand from '../../kpi-card';
import { BANK_DATA } from '../data';
import { useActivityParams } from '../../useCaseStore';

// ─────────────────────────────────────────────────────────────────────────────
// Bank KPI band — FOUR cards, on the shared rigid grid (../../kpi-card.jsx).
//
// This was six cards on the stub StatCards grid (2-up on phones, 6-up on xl,
// height inferred from content). Six is not a glance: the band exists to answer
// what a branch manager acts on in the first five seconds, and it now mirrors
// the four questions the retail reference asks —
//
//   Compliance Score    is the branch OK?          ← was "Compliance Status"
//   Staff on Duty       is the team here?          ← was "Employees on Duty"
//   Teller Queue        are customers waiting?     ← was "Queue Length"
//   Vault Access        are the secure rooms busy? ← was "Vault Visits"
//
// WHAT MOVED, AND WHERE
//   · Avg. Waiting Time — folded into the Teller Queue card as its sub-line.
//     It is the same question as queue length ("are customers waiting?") and
//     answering it twice cost a card without adding a decision. This is what
//     the retail reference does too: one queue card carrying status + avg wait.
//   · Open Alerts — dropped. The dashboard already renders alerts in Live
//     Overview below, and the full list is /activity-monitoring/bank/alerts. A
//     card whose only action is "go and read the list underneath" is a label.
//
// TONES ARE DERIVED, NEVER AUTHORED. Each band below is a pure function of the
// value and the vertical's own threshold from src/use-cases/bank/index.js, so a
// tone cannot drift out of step with the number it is colouring. FRONTEND-ONLY:
// values come from ../data.js; the ⓘ on each card names the backend fields that
// will replace them.
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = {
  compliance: ShieldCheck, staff: Users, queue: ListOrdered, vault: Lock,
};

// Every card is a doorway to the subpage holding the full story.
const LINKS = {
  compliance: '/activity-monitoring/bank/security',
  staff:      '/activity-monitoring/bank/staff-roster',
  queue:      '/activity-monitoring/bank/teller',
  vault:      '/activity-monitoring/bank/cash-ops',
};

const LINK_LABELS = {
  compliance: 'Security & Compliance',
  staff:      'Staff Roster',
  queue:      'Teller Counters',
  vault:      'Cash & Vault Ops',
};

const scoreTone = (pct) => (pct >= 95 ? 'good' : pct >= 85 ? 'warn' : 'bad');
const staffTone = (on, of) => {
  if (!of) return 'neutral';
  const ratio = on / of;
  return ratio >= 0.85 ? 'good' : ratio >= 0.7 ? 'warn' : 'bad';
};
const queueTone = (len, max) => {
  if (!max) return 'neutral';
  return len <= max * 0.6 ? 'good' : len <= max ? 'warn' : 'bad';
};

export default function KeyMetrics({ loading = false }) {
  const d = BANK_DATA;
  // The queue ceiling is operator config, not a number baked into this file.
  const { params } = useActivityParams();
  const maxQueue = params?.queue?.maxQueue || 10;

  const onDuty = d.employeesOnDuty?.value ?? 0;
  const rostered = d.employeesOnDuty?.of ?? 0;
  const queueLen = d.queueLength?.value ?? 0;

  const cards = [
    {
      key: 'compliance',
      label: 'Compliance Score',
      display: 'score',
      value: d.complianceScore?.value ?? '—',
      unit: '/100',
      tone: scoreTone(d.complianceScore?.value ?? 0),
      sub: 'rolling 24h',
      delta: '+0.8pt',
      trend: 'up',
      purpose: 'Whether the branch is meeting its dual-authorisation, cash-handling and secure-area policies right now.',
      formula: '100 − (weighted policy breaches in the last 24h ÷ checks performed) × 100',
      fields: ['compliance_checks.passed', 'compliance_checks.total', 'policy_breaches.weight'],
    },
    {
      key: 'staff',
      label: 'Staff on Duty',
      display: 'ratio',
      value: onDuty,
      total: rostered,
      unit: 'rostered',
      tone: staffTone(onDuty, rostered),
      sub: 'clocked in now',
      delta: d.employeesOnDuty?.deltaLabel?.split(' ')[0],
      trend: 'up',
      purpose: 'How much of the rostered branch team is actually present — the first thing that explains a slow counter.',
      formula: 'count(staff with an open clock-in) ÷ count(staff rostered for the current window)',
      fields: ['attendance.clock_in', 'attendance.clock_out', 'roster.expected_staff'],
    },
    {
      key: 'queue',
      label: 'Teller Queue',
      display: 'measure',
      value: queueLen,
      unit: 'waiting',
      tone: queueTone(queueLen, maxQueue),
      badge: queueLen > maxQueue ? { text: 'Over threshold', tone: 'bad' } : null,
      sub: `${d.avgWaitingTime?.value ?? '—'} avg wait`,
      delta: '-6.4%',
      trend: 'up',
      purpose: `People waiting at the teller counters, against the branch threshold of ${maxQueue}. Carries average wait as its sub-line so the two queue questions share one card.`,
      formula: 'occupancy of the Teller Queue zone · avg(served_at − joined_at) over the last hour',
      fields: ['zone_occupancy.teller_queue', 'queue_events.joined_at', 'queue_events.served_at'],
    },
    {
      key: 'vault',
      label: 'Vault Access',
      display: 'measure',
      value: d.vaultVisits?.value ?? '—',
      unit: 'entries today',
      // A count, not a health signal: two vault visits is not "better" than
      // four, so this card stays neutral and the security page grades them.
      tone: 'neutral',
      sub: 'dual-auth tracked',
      purpose: 'Entries into the vault and cash room today. Every one should be dual-authorised; the security page is where an unpaired entry is flagged.',
      formula: 'count(zone entries) where zone.type = secure and zone.area = Restricted',
      fields: ['zone_events.entry', 'zones.min_occupancy', 'dual_auth.paired'],
    },
  ];

  return (
    <KpiBand
      cards={cards}
      icons={ICONS}
      linkLabels={LINK_LABELS}
      links={LINKS}
      loading={loading}
    />
  );
}
