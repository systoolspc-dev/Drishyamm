import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Coffee, Hourglass, ListOrdered, Timer, Trophy, UsersRound } from 'lucide-react';
import { useModuleData } from '../useModuleData';
import { useActivityParams } from '../useCaseStore';
import { BREAK_WARN_MIN } from '../scorecard';
import { T, TH } from '../type';
import KpiBand from '../kpi-card';

// ─────────────────────────────────────────────────────────────────────────────
// /activity-monitoring/analytics/staff — Staff Performance in plain store terms.
//
// This tab answers "who keeps the store moving at rush hour?", not "who was
// late?". Attendance flags, clock-ins and phone incidents live on the
// Attendance and Employee Profile pages.
//
// Two blocks: a row of plain team numbers for the period, then one row per
// employee with four columns a store manager reads at a glance — bills per
// hour, checkout time and rush-hour presence — plus a Fast / Normal /
// Needs Support tag.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS = {
  fast:    { label: 'Fast',          cls: 'bg-success-soft text-success-ink', rank: 0 },
  normal:  { label: 'Normal',        cls: 'bg-info-soft text-info-ink',       rank: 1 },
  support: { label: 'Needs Support', cls: 'bg-warning-soft text-warning-ink', rank: 2 },
};

// Status comes from checkout speed and idle time only (thresholds in
// REPORT_META.statusRules). Staff without a till are judged on idle time alone.
function statusOf(r, rules) {
  const slow = r.serviceMin != null && r.serviceMin > rules.slowMin;
  if (slow || r.idleMin > rules.idleWarnMin) return 'support';
  const quick = r.serviceMin == null || r.serviceMin <= rules.fastMin;
  if (quick && r.idleMin <= rules.busyIdleMin) return 'fast';
  return 'normal';
}

const overBreakOf = (r) => Math.max(0, r.breakMin - BREAK_WARN_MIN);

const SORTS = [
  { key: 'status',   label: 'Status' },
  { key: 'checkout', label: 'Checkout Speed' },
  { key: 'rush',     label: 'Rush Hour Presence' },
  { key: 'name',     label: 'Name' },
];

// Rows without a checkout time sink to the bottom of the checkout sort.
const byCheckout = (a, b) => (a.serviceMin ?? Infinity) - (b.serviceMin ?? Infinity);

const SORTERS = {
  status:   (a, b) => STATUS[a.status].rank - STATUS[b.status].rank || byCheckout(a, b) || a.idleMin - b.idleMin,
  checkout: byCheckout,
  rush:     (a, b) => b.peakPct - a.peakPct,
  name:     (a, b) => a.name.localeCompare(b.name),
};

// Wording per use case — retail tills vs office tickets.
const COPY = {
  retail: {
    presence: 'Present During Rush Hours (%)',
    speed: 'Avg Checkout Speed (Mins/Customer)',
    speedHint: 'At the tills',
    rate: 'Bills per Hour',
    time: 'Avg Checkout Time',
    presenceCol: 'Rush Hour Presence',
    place: 'store',
  },
  corporate: {
    presence: 'Present During Core Hours (%)',
    speed: 'Avg Ticket Time (Mins/Ticket)',
    speedHint: 'Per ticket closed',
    rate: 'Tasks per Hour',
    time: 'Avg Ticket Time',
    presenceCol: 'Core Hour Presence',
    place: 'office',
  },
};

const RATE_UNIT = { bills: 'bills', interactions: 'customers', tasks: 'tasks' };

const fmtMin = (n) => `${n} ${n === 1 ? 'min' : 'mins'}`;

const TILE_ICONS = {
  presence: UsersRound, speed: Timer, idle: Hourglass, overBreak: Coffee,
  queue: ListOrdered, best: Trophy,
};

export default function StaffTab() {
  const { WEEKLY_REPORT, REPORT_META } = useModuleData();
  const { useCase } = useActivityParams();
  const [sort, setSort] = useState('status');

  const isRetail = useCase !== 'corporate';
  const copy = isRetail ? COPY.retail : COPY.corporate;
  const impact = REPORT_META?.staffImpact;

  const rows = useMemo(() => {
    const rules = REPORT_META?.statusRules;
    const withStatus = (WEEKLY_REPORT || []).map((r) => ({
      ...r,
      overBreakMin: overBreakOf(r),
      status: rules ? statusOf(r, rules) : 'normal',
    }));
    return withStatus.sort(SORTERS[sort]);
  }, [WEEKLY_REPORT, REPORT_META, sort]);

  // Team totals for the period — plain sums, no weighting.
  const totals = useMemo(() => ({
    idle: rows.reduce((n, r) => n + (r.idleMin ?? 0), 0),
    overBreak: rows.reduce((n, r) => n + r.overBreakMin, 0),
    overBreakPeople: rows.filter((r) => r.overBreakMin > 0).length,
    queueAlerts: rows.reduce((n, r) => n + (r.impact?.queueBreaches ?? 0), 0),
    hasQueues: rows.some((r) => r.impact),
  }), [rows]);

  // The module-wide KPI card (../kpi-card.jsx). A count that is non-zero
  // is something to look at (warn); zero is the good state.
  const countTone = (n) => (n ? 'warn' : 'good');
  const tiles = impact ? [
    { key: 'presence', label: copy.presence, value: `${impact.peakCoverage}%`, sub: `${isRetail ? 'Rush' : 'Core'} hours: ${impact.peakWindow}` },
    { key: 'speed', label: copy.speed, value: fmtMin(impact.serviceMin), sub: copy.speedHint },
    { key: 'idle', label: 'Idle Time (Mins)', value: totals.idle, sub: 'Whole team, last 7 days', tone: 'neutral' },
    {
      key: 'overBreak', label: 'Over-break Time (Mins)', value: totals.overBreak, tone: countTone(totals.overBreak),
      sub: `${totals.overBreakPeople} ${totals.overBreakPeople === 1 ? 'person' : 'people'} over the ${BREAK_WARN_MIN}-min break limit`,
    },
    ...(totals.hasQueues
      ? [{ key: 'queue', label: 'Queue Alerts', value: totals.queueAlerts, sub: 'Times a till queue got too long', tone: countTone(totals.queueAlerts) }]
      : []),
    { key: 'best', label: 'Best Shift', value: impact.topShift, sub: `${impact.topShiftLift}% more ${isRetail ? 'bills' : 'tasks'}/hr than the ${copy.place} average` },
  ] : [];

  return (
    <div className="space-y-4 pb-5">
      {/* ── Team numbers ─────────────────────────────────────────────────── */}
      {impact && <KpiBand cards={tiles} icons={TILE_ICONS} />}

      {/* ── Staff table ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <UsersRound className="h-4 w-4 text-brand" />
          <h2 className="text-lg font-semibold text-fg">Staff performance — last 7 days</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-caption font-medium text-fg-muted">Sort by</span>
            <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface-sunken p-1" role="group" aria-label="Sort by">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={sort === s.key}
                  onClick={() => setSort(s.key)}
                  className={`h-11 rounded-md border px-2.5 text-caption transition lg:h-7 ${
                    sort === s.key ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink' : 'border-transparent font-medium text-fg-muted hover:text-fg'
                  }`}
                >
                  {s.key === 'checkout' && !isRetail ? 'Ticket Speed' : s.key === 'rush' ? copy.presenceCol : s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="py-6 text-center text-caption text-fg-subtle">No performance data for this period.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto">
            {/* Bleeds to the card edges so the header band spans it; px-4
                cells put the text back on the card's content line. */}
            <table className="w-full min-w-[36rem] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={TH.left}>Employee</th>
                  <th className={TH.right}>{copy.rate}</th>
                  <th className={TH.right}>{copy.time}</th>
                  <th className={TH.right}>{copy.presenceCol}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const status = STATUS[r.status];
                  const why = [
                    r.serviceMin != null && `${isRetail ? 'Checkout' : 'Ticket'} ${fmtMin(r.serviceMin)}`,
                    `Idle ${fmtMin(r.idleMin ?? 0)}`,
                    r.overBreakMin > 0 && `Over-break ${fmtMin(r.overBreakMin)}`,
                    r.impact?.queueBreaches > 0 && `${r.impact.queueBreaches} queue alert${r.impact.queueBreaches === 1 ? '' : 's'}`,
                  ].filter(Boolean).join(' · ');
                  return (
                    <tr key={r.id} className="border-b border-line-subtle last:border-0 hover:bg-surface-sunken">
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <Link
                            to={`/activity-monitoring/employee/${r.id}`}
                            className={`${T.tdPrimary} hover:text-brand-ink hover:underline`}
                          >
                            {r.name}
                          </Link>
                          <span title={why} className={`inline-flex ${T.stateBadge} ${status.cls}`}>
                            {status.label}
                          </span>
                        </div>
                        <p className={T.tdSub}>{r.role}</p>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="font-semibold tabular-nums text-fg">{Math.round(r.velocity)}/hr</span>
                        {r.unit !== 'bills' && <p className={T.tdSub}>{RATE_UNIT[r.unit]}</p>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {r.serviceMin != null ? (
                          <span className="font-semibold text-fg">{fmtMin(r.serviceMin)}</span>
                        ) : (
                          <span title="Not on a till" className="text-fg-subtle">—</span>
                        )}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${r.peakPct < 75 ? 'text-danger-ink' : 'text-fg'}`}>
                        {r.peakPct}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
