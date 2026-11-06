import { useMemo, useState } from 'react';
import {
  AlertTriangle, BarChart3, CalendarRange, CheckCircle2, Coffee, Flag, Hourglass, UtensilsCrossed, XCircle,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/core/ui/popover';
import { useActivityParams } from './useCaseStore';
import { useModuleData } from './useModuleData';
import { formatMin, shiftIsoDate } from './break-idle';
import {
  INSIGHT_RANGES, insightTargets, resolveInsightRange, targetStatus, useStaffInsights,
} from './staff-insights';

// Staff Quality & Performance Scorecard — the [Insights] popover in the
// Employee Scorecard header. Expected (policy benchmark) vs actual (event
// logs) for the chosen range, then what the time went on and who overstayed.
// Numbers come from ./staff-insights.js, which projects the Breaks & Idle log,
// so every count here is a row there. [View Flagged Logs Only] hands the
// flagged employee ids back to the table as a filter.

// Status = colour + icon + word, never colour alone.
const STATUS = {
  meets:  { label: 'Meets target',     icon: CheckCircle2,  bar: 'bg-success', chip: 'border-success-line bg-success-soft text-success-ink' },
  minor:  { label: 'Minor delta',      icon: AlertTriangle, bar: 'bg-warning', chip: 'border-warning-line bg-warning-soft text-warning-ink' },
  severe: { label: 'Severe violation', icon: XCircle,       bar: 'bg-danger',  chip: 'border-danger-line bg-danger-soft text-danger-ink' },
};

const KINDS = {
  lunch: { label: 'Lunch Break', icon: UtensilsCrossed },
  tea:   { label: 'Tea Break', icon: Coffee },
  idle:  { label: 'Idle / Unattended Station', icon: Hourglass },
};

const SECTION = 'mb-2 text-micro font-semibold uppercase tracking-wider text-fg-muted';
const DATE = 'h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-small text-fg-secondary focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30';

function StatusChip({ status }) {
  if (!status) return <span className="text-micro text-fg-subtle">No data</span>;
  const s = STATUS[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-micro font-semibold ${s.chip}`}>
      <s.icon className="h-3 w-3" /> {s.label}
    </span>
  );
}

// One metric as two horizontal bars on a shared scale: the benchmark (neutral)
// over the actual (status-coloured). Percent metrics run 0–100; idle minutes
// run to twice the benchmark, or further when the actual goes past that.
function MetricBars({ t, actual }) {
  const status = targetStatus(t, actual);
  const max = t.max ?? Math.max(t.target * 2, Math.ceil((actual ?? 0) * 1.1));
  const width = (v) => `${Math.max(2, Math.min(100, (v / max) * 100))}%`;
  const fmt = (v) => (t.unit === '%' ? `${v}%` : `${v} min`);
  const op = t.target === t.max ? '' : t.better === 'higher' ? '≥ ' : '≤ ';
  const gap = actual == null ? null : Math.round(Math.abs(actual - t.target) * 10) / 10;
  const tip = actual == null
    ? `${t.label}: no events in this range`
    : `${t.label} — target ${op}${fmt(t.target)}, actual ${fmt(actual)}${status === 'meets' ? '' : ` (${t.unit === '%' ? `${gap} pts` : `${gap} min`} off target)`}`;

  return (
    <li title={tip}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-caption font-semibold text-fg">{t.label}</p>
        <StatusChip status={status} />
      </div>
      <div className="grid grid-cols-[3rem_1fr_4rem] items-center gap-x-2 gap-y-1">
        <span className="text-micro text-fg-muted">Target</span>
        <span className="h-2 overflow-hidden rounded-full bg-surface-muted">
          <span className="block h-full rounded-full bg-line-strong" style={{ width: width(t.target) }} />
        </span>
        <span className="text-right text-micro tabular-nums text-fg-secondary">{op}{fmt(t.target)}</span>

        <span className="text-micro text-fg-muted">Actual</span>
        <span className="h-2 overflow-hidden rounded-full bg-surface-muted">
          {actual != null && <span className={`block h-full rounded-full ${STATUS[status].bar}`} style={{ width: width(actual) }} />}
        </span>
        <span className="text-right text-micro font-semibold tabular-nums text-fg">{actual == null ? '—' : fmt(actual)}</span>
      </div>
    </li>
  );
}

// One activity type: volume, average against its limit, and a within /
// minor / critical split bar (2px surface gaps between the parts).
function KindRow({ k, graceMin }) {
  const meta = KINDS[k.type];
  const ok = k.count - k.minor - k.critical;
  const parts = [
    { n: ok, cls: 'bg-success', label: 'within limit' },
    { n: k.minor, cls: 'bg-warning', label: `minor (≤${graceMin}m over)` },
    { n: k.critical, cls: 'bg-danger', label: `critical (>${graceMin}m over)` },
  ].filter((p) => p.n > 0);

  return (
    <li className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-muted text-fg-muted">
        <meta.icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-caption font-semibold text-fg">{meta.label}</p>
          <p className="shrink-0 text-micro tabular-nums text-fg-muted">
            {k.count} {k.count === 1 ? 'event' : 'events'}
          </p>
        </div>
        <p className="mt-0.5 text-micro tabular-nums text-fg-muted">
          {k.count ? <>Avg {formatMin(k.avgMin)} · limit {formatMin(k.limit)} · {formatMin(k.totalMin)} total</> : 'None logged in this range'}
        </p>
        {k.count > 0 && (
          <div className="mt-1.5 flex h-1.5 gap-0.5" role="img" aria-label={parts.map((p) => `${p.n} ${p.label}`).join(', ')}>
            {parts.map((p) => (
              <span key={p.cls} title={`${p.n} ${p.label}`} className={`h-full rounded-full ${p.cls}`} style={{ flexGrow: p.n }} />
            ))}
          </div>
        )}
        {(k.critical > 0 || k.minor > 0) && (
          <p className="mt-1 flex flex-wrap gap-x-2.5 text-micro font-semibold tabular-nums">
            {k.critical > 0 && <span className="text-danger-ink">{k.critical} critical</span>}
            {k.minor > 0 && <span className="text-warning-ink">{k.minor} minor</span>}
          </p>
        )}
      </div>
    </li>
  );
}

function OverstayCallout({ o, graceMin, flaggedCount, onViewFlagged }) {
  const tone = o.critical ? 'danger' : o.minor ? 'warning' : 'success';
  const [box, ink] = {
    danger: ['border-danger-line bg-danger-soft', 'text-danger-ink'],
    warning: ['border-warning-line bg-warning-soft', 'text-warning-ink'],
    success: ['border-success-line bg-success-soft', 'text-success-ink'],
  }[tone];
  const Icon = tone === 'success' ? CheckCircle2 : AlertTriangle;

  return (
    <div className={`rounded-lg border p-3 ${box}`}>
      <p className={`flex items-center gap-1.5 text-caption font-semibold ${ink}`}>
        <Icon className="h-3.5 w-3.5" /> Policy Overstay Summary
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded-md bg-surface/70 px-2.5 py-2">
          <p className="text-heading font-bold leading-none tabular-nums text-danger-ink">{o.critical}</p>
          <p className="mt-1 text-micro font-semibold text-fg">Critical Overstays</p>
          <p className="text-micro text-fg-muted">&gt;{graceMin}m past limit · alert fired</p>
        </div>
        <div className="rounded-md bg-surface/70 px-2.5 py-2">
          <p className="text-heading font-bold leading-none tabular-nums text-warning-ink">{o.minor}</p>
          <p className="mt-1 text-micro font-semibold text-fg">Minor Overstays</p>
          <p className="text-micro text-fg-muted">Within the {graceMin}m grace</p>
        </div>
      </div>
      <p className="mt-2 text-micro text-fg-secondary">
        {o.critical + o.minor
          ? <>{formatMin(o.overMin)} over limit in total{o.late ? <> · {o.late} late clock-in{o.late === 1 ? '' : 's'}</> : null}.</>
          : o.late ? <>No overstays · {o.late} late clock-in{o.late === 1 ? '' : 's'}.</> : 'Every break and idle stretch stayed within policy.'}
      </p>
      {o.top.length > 0 && (
        <p className="mt-1 text-micro text-fg-secondary">
          <span className="font-semibold text-fg">Follow up: </span>
          {o.top.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}{p.name} <span className="tabular-nums text-fg-muted">(+{formatMin(p.overMin)})</span>
            </span>
          ))}
        </p>
      )}
      <button
        type="button"
        onClick={onViewFlagged}
        disabled={!flaggedCount}
        className="mt-2.5 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Flag className="h-3.5 w-3.5" /> View Flagged Logs Only
        <span className="tabular-nums text-fg-muted">({flaggedCount} staff)</span>
      </button>
    </div>
  );
}

const TRIGGER = {
  // Toolbar: icon + label (label hidden on phones).
  full: 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-caption font-semibold text-fg-secondary',
  // Table header (Action column): icon only, sized to the header band.
  compact: 'grid h-6 w-6 place-items-center rounded-md normal-case text-fg-muted hover:bg-surface-muted',
};

/**
 * @param {{ onViewFlagged: (f: { ids: string[], label: string }) => void, compact?: boolean }} props
 */
export default function StaffInsights({ onViewFlagged, compact = false }) {
  const { TODAY } = useModuleData();
  const { params } = useActivityParams();
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState(() => ({ key: '7d', from: shiftIsoDate(TODAY, -6), to: TODAY }));

  const resolved = useMemo(() => resolveInsightRange(range, TODAY, params.retentionDays), [range, TODAY, params.retentionDays]);
  const data = useStaffInsights(resolved.dates);
  const targets = useMemo(() => insightTargets(params), [params]);
  const { graceMin } = data.limits;

  function viewFlagged() {
    onViewFlagged({ ids: data.flaggedIds, label: resolved.label });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Insights — expected vs. actual staff quality & performance"
          aria-label="Insights: expected vs. actual staff quality and performance"
          className={`${compact ? TRIGGER.compact : TRIGGER.full} transition hover:border-brand/40 hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=open]:border-brand/40 data-[state=open]:text-brand-ink`}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          {!compact && <span className="max-sm:sr-only">Insights</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={16} className="w-[min(30rem,calc(100vw-2rem))] border-line bg-surface p-0">
        {/* Header — title + the range every number below follows */}
        <div className="border-b border-line px-3.5 py-3">
          <p className="text-sm font-semibold text-fg">Staff Quality &amp; Performance</p>
          <p className="text-micro text-fg-muted">
            Expected vs. actual · {resolved.label} · {data.staff} staff · {data.shiftDays} shifts · {data.eventCount} events
          </p>
          <div role="radiogroup" aria-label="Date range" className="mt-2.5 grid grid-cols-4 gap-0.5 rounded-lg border border-line bg-surface-sunken p-0.5">
            {INSIGHT_RANGES.map((r) => {
              const on = range.key === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setRange((cur) => ({ ...cur, key: r.key }))}
                  className={`h-7 truncate rounded-md px-1.5 text-micro font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                    on ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
          {range.key === 'custom' && (
            <div className="mt-2 flex items-center gap-1.5">
              <CalendarRange className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
              <input
                type="date" aria-label="From" className={DATE}
                value={range.from} min={resolved.cutoff} max={range.to}
                onChange={(e) => e.target.value && setRange((c) => ({ ...c, from: e.target.value }))}
              />
              <span className="text-micro text-fg-subtle">to</span>
              <input
                type="date" aria-label="To" className={DATE}
                value={range.to} min={range.from} max={TODAY}
                onChange={(e) => e.target.value && setRange((c) => ({ ...c, to: e.target.value }))}
              />
            </div>
          )}
        </div>

        <div className="scrollbar-thin max-h-[min(70vh,40rem)] space-y-4 overflow-y-auto px-3.5 py-3">
          {data.shiftDays === 0 ? (
            <p className="rounded-lg bg-surface-sunken px-3 py-6 text-center text-small text-fg-muted">No shifts logged in this range.</p>
          ) : (
            <>
              <section aria-label="Expected vs. actual">
                <p className={SECTION}>Expected vs. Actual</p>
                <ul className="space-y-3.5">
                  {targets.map((t) => <MetricBars key={t.key} t={t} actual={data.actual[t.key]} />)}
                </ul>
              </section>

              <section aria-label="Activity and violations">
                <p className={SECTION}>Activity &amp; Violations</p>
                <ul className="divide-y divide-line-subtle">
                  {data.breakdown.map((k) => <KindRow key={k.type} k={k} graceMin={graceMin} />)}
                </ul>
              </section>

              <OverstayCallout o={data.overstays} graceMin={graceMin} flaggedCount={data.flaggedIds.length} onViewFlagged={viewFlagged} />
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
