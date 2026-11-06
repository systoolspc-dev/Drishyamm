import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EyeOff, MonitorX, CircleCheck, Radio } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';
import { PageCard, PageToolbar } from '@/core/layout/OperationsPage';
import { useActivityParams } from '../useCaseStore';
import { useModuleData } from '../useModuleData';
import { shiftIsoDate } from '../break-idle';
import { T, TH, TH_STICKY } from '../type';
import { zoneHistory, HISTORY_HOURS, dayLabel } from './zone-history';
import ExportReportMenu from '../ExportReportMenu';
import { exportReportDocument } from '../report-document';

// ─────────────────────────────────────────────────────────────────────────────
// /activity-monitoring/analytics/zones — Zone Coverage & Trends.
//
// The historical half of zone coverage. The live Zone Coverage page answers
// "who is on post right now"; this tab answers "how well were the zones
// covered over a period" — the hourly matrix, shift-level compliance and the
// full incident log, over Today / Yesterday / Last 7 days / a custom range,
// with the standard branded export (PDF / Excel / CSV).
//
// Replaces the old Traffic & Zones tab (its URL redirects here). That tab's
// hourly counter-flow table was today-only data, so it moved to Today's
// Trends rather than sit under a date-range picker it could not honour.
//
// Retail-only, like the data behind it: needs the `zones` param block.
// Corporate gets an explanation, not a 404.
// ─────────────────────────────────────────────────────────────────────────────

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: 'custom', label: 'Custom range' },
];

// Shift series colours — brand for the first crew, info for the second.
const SERIES = ['var(--brand)', 'var(--info-ink)', 'var(--text-subtle)'];

function cellCls(pct) {
  if (pct == null) return 'bg-surface-muted text-fg-disabled';
  if (pct >= 95) return 'bg-success/80 text-white';
  if (pct >= 80) return 'bg-success-line/70 text-success-ink';
  if (pct >= 50) return 'bg-warning-line/80 text-warning-ink';
  if (pct > 0)   return 'bg-danger-line/80 text-danger-ink';
  return 'bg-danger/90 text-white';
}

export default function ZonesTab() {
  const { label, params } = useActivityParams();
  const { TODAY, NOW_IST } = useModuleData();

  const [range, setRange] = useState('today');
  const [custom, setCustom] = useState({ from: shiftIsoDate(TODAY, -13), to: TODAY });

  const [from, to] = useMemo(() => {
    if (range === 'yesterday') { const y = shiftIsoDate(TODAY, -1); return [y, y]; }
    if (range === '7d') return [shiftIsoDate(TODAY, -6), TODAY];
    if (range === 'custom') return custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from];
    return [TODAY, TODAY];
  }, [range, custom, TODAY]);

  const targetPct = params.zones?.coverageTargetPct ?? 80;
  const data = useMemo(
    () => (params.zones ? zoneHistory({ from, to, today: TODAY, now: NOW_IST, shifts: params.shifts, targetPct }) : null),
    [from, to, TODAY, NOW_IST, params.shifts, params.zones, targetPct],
  );

  if (!params.zones) {
    return (
      <div className="rounded-xl border border-line bg-surface p-10 text-center shadow-sm">
        <EyeOff className="mx-auto mb-2 h-8 w-8 text-fg-disabled" />
        <p className="text-body font-semibold text-fg-secondary">
          Zone coverage is not enabled for the {label} use case
        </p>
        <p className="mx-auto mt-1 max-w-md text-small text-fg-subtle">
          This view needs the <code className="rounded bg-surface-muted px-1 font-mono text-caption">zones</code> parameter
          block (counter-unattended thresholds), which only floor-based verticals like Retail configure.
        </p>
        <Link to="/activity-monitoring/analytics/trends" className="mt-3 inline-block text-small font-semibold text-brand-ink hover:underline">
          ← Back to Today&apos;s Trends
        </Link>
      </div>
    );
  }

  const { days, matrix, shifts, compliance, incidents } = data;
  const multiDay = days.length > 1;
  const periodLabel = multiDay ? `${dayLabel(days[0])} – ${dayLabel(days[days.length - 1])} (${days.length} days)` : dayLabel(days[0]);
  const truncated = range === 'custom' && days[days.length - 1] !== to;

  const pct = (v) => (v == null ? '' : `${v}%`);
  const onExport = (format) => exportReportDocument({
    title: 'Zone Coverage & Trends Report',
    code: 'ZCV',
    subtitle: 'Drishyam Activity Monitoring  -  Analytics: zone coverage',
    details: [['Vertical', label], ['Period', periodLabel]],
    policy: [['Coverage target', `${targetPct}% of each hour staffed`], ['Matrix values', multiDay ? 'Mean staffed % per hour' : 'Staffed % per hour']],
    kpis: [
      { label: 'Zones', value: matrix.length, note: 'Tracked in the period' },
      { label: 'Incidents', value: incidents.length, note: 'Unattended-zone events' },
      { label: 'Still active', value: incidents.filter((i) => i.active).length, note: 'Not yet resolved' },
    ],
    tables: [
      {
        title: 'Hourly staffed coverage',
        sheet: 'Coverage',
        heat: { good: targetPct, warn: 50 },
        columns: ['Zone', 'Type', ...HISTORY_HOURS],
        rows: matrix.map((z) => [z.zone, z.kind, ...z.hours.map(pct)]),
      },
      {
        title: `Shift compliance (zone-hours at or above ${targetPct}% staffed)`,
        sheet: 'Shift compliance',
        heat: { good: targetPct, warn: 50 },
        columns: ['Day', ...shifts.map((s) => s.label)],
        rows: compliance.map((c) => [c.day, ...shifts.map((s) => pct(c[s.label]))]),
      },
      {
        title: 'Incidents',
        columns: ['Date', 'From (IST)', 'Zone', 'Type', 'Duration', 'Status'],
        rows: incidents.map((i) => [i.date, i.from, i.zone, i.type, i.duration, i.active ? 'Active' : 'Resolved']),
      },
    ],
    countLine: `${matrix.length} zones - ${incidents.length} incidents`,
    filename: `zone-coverage-${from}_${to}`,
  }, format);

  return (
    <div className="space-y-4 pb-5">
      {/* Range + exports — screen-only; the printed copy states its period below */}
      <PageToolbar
        className="print:hidden"
        actions={(
          <ExportReportMenu label="Export" reportName="Zone coverage" align="end" onSelect={onExport} />
        )}
      >
        <div className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface-sunken p-1" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className={`h-11 rounded-md border px-2.5 text-caption transition lg:h-7 ${
                range === r.key ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink' : 'border-transparent font-medium text-fg-muted hover:text-fg'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="flex items-center gap-1.5 text-caption text-fg-muted">
            <input
              type="date"
              value={custom.from}
              max={TODAY}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))}
              aria-label="From date"
              className="h-11 rounded-lg border border-line bg-surface px-2 text-caption text-fg-secondary outline-none focus:border-brand lg:h-8"
            />
            <span>to</span>
            <input
              type="date"
              value={custom.to}
              max={TODAY}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))}
              aria-label="To date"
              className="h-11 rounded-lg border border-line bg-surface px-2 text-caption text-fg-secondary outline-none focus:border-brand lg:h-8"
            />
          </div>
        )}
      </PageToolbar>

      <p className={T.itemMeta}>
        <span className="font-semibold text-fg-secondary">{periodLabel}</span>
        {truncated && ' · custom ranges are capped at 31 days'}
        {' · '}
        <Link to="/activity-monitoring/zones" className="inline-flex items-center gap-1 font-semibold text-brand-ink hover:underline print:hidden">
          <Radio className="h-3 w-3" /> Live zone status
        </Link>
      </p>

      {/* ── Zone × hour coverage matrix ─────────────────────────────────── */}
      <PageCard className="p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-lg font-semibold text-fg">Hourly coverage matrix</h2>
          <span className={T.itemMeta}>
            {multiDay ? `mean % of each hour with staff detected, across ${days.length} days` : '% of each hour with staff detected'}
          </span>
        </div>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[48rem] border-separate border-spacing-[3px]">
            <thead>
              <tr>
                <th className={`rounded-md border-b border-line bg-surface-sunken px-4 py-3 text-left ${T.th}`}>Zone</th>
                {HISTORY_HOURS.map((h) => (
                  <th key={h} className={`rounded-md border-b border-line bg-surface-sunken px-1 py-3 text-center tabular-nums ${T.th}`}>{h.slice(0, 2)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((z) => (
                <tr key={z.zone}>
                  <td className={`whitespace-nowrap px-4 ${T.tdPrimary}`}>
                    {z.zone}
                    {z.kind === 'counter' && <span className="ml-1 rounded bg-surface-muted px-1 py-px text-caption font-bold uppercase text-fg-subtle">counter</span>}
                  </td>
                  {z.hours.map((pct, i) => (
                    <td
                      key={HISTORY_HOURS[i]}
                      title={pct == null ? `${z.zone} ${HISTORY_HOURS[i]} — not yet` : `${z.zone} ${HISTORY_HOURS[i]} — ${pct}% staffed`}
                      className={`h-7 min-w-10 rounded-md text-center text-micro font-bold tabular-nums ${cellCls(pct)}`}
                    >
                      {pct == null ? '—' : pct}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-caption text-fg-muted">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-success/80" /> ≥95%</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-success-line/70" /> 80–94%</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-warning-line/80" /> 50–79%</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-danger/80" /> &lt;50%</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-surface-muted" /> not yet</span>
        </div>
      </PageCard>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        {/* ── Shift-level compliance ────────────────────────────────────── */}
        <PageCard className="p-4 xl:col-span-2">
          <h2 className="text-lg font-semibold text-fg">Shift compliance</h2>
          <p className={`mb-2 ${T.itemMeta}`}>% of zone-hours at or above {targetPct}% staffed, per shift</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={compliance} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="day" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={AXIS} axisLine={false} tickLine={false} unit="%" />
                <Tooltip {...TIP} formatter={(v) => (v == null ? 'not yet' : `${v}%`)} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                {shifts.map((s, i) => (
                  <Bar key={s.id} dataKey={s.label} name={`${s.label} (${s.start}–${s.end})`} fill={SERIES[i % SERIES.length]} radius={[3, 3, 0, 0]} maxBarSize={20} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </PageCard>

        {/* ── Full incident history ─────────────────────────────────────── */}
        <PageCard className="flex flex-col overflow-hidden xl:col-span-3">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <MonitorX className="h-4 w-4 text-brand" />
            <h2 className="text-lg font-semibold text-fg">Zone incidents</h2>
            <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-caption font-bold tabular-nums text-fg-muted">{incidents.length}</span>
          </div>
          {incidents.length === 0 ? (
            <div className="py-8 text-center">
              <CircleCheck className="mx-auto mb-1.5 h-6 w-6 text-success" />
              <p className="text-small text-fg-subtle">No coverage incidents in this period.</p>
            </div>
          ) : (
            <div className="scrollbar-thin max-h-72 overflow-auto print:max-h-none">
              <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                <thead>
                  <tr>
                    {multiDay && <th className={thCls}>Date</th>}
                    <th className={thCls}>From</th>
                    <th className={thCls}>Zone</th>
                    <th className={thCls}>Type</th>
                    <th className={thCls}>Duration</th>
                    <th className={thCls}>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-subtle">
                  {incidents.map((i) => (
                    <tr key={i.id} className="hover:bg-surface-sunken">
                      {multiDay && <td className={`whitespace-nowrap px-4 py-2 tabular-nums ${T.tdSub}`}>{dayLabel(i.date)}</td>}
                      <td className={`whitespace-nowrap px-4 py-2 tabular-nums ${T.tdSub}`}>{i.from}</td>
                      <td className={`px-4 py-2 ${T.tdPrimary}`}>{i.zone}</td>
                      <td className="px-4 py-2 text-fg-secondary">{i.type}</td>
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-fg-secondary">{i.active ? 'ongoing' : i.duration}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex ${T.stateBadge} ring-1 ${
                          i.active ? 'bg-danger-soft text-danger-ink ring-danger-line' : 'bg-surface-muted text-fg-muted ring-line'
                        }`}>
                          {i.active ? 'Active' : 'Resolved'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PageCard>
      </div>
    </div>
  );
}

// The module's sticky header band (type.js TH), over px-4 cells.
const thCls = `${TH_STICKY} ${TH.left}`;
