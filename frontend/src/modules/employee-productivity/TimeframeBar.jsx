import { Link } from 'react-router-dom';
import { CalendarDays, Info } from 'lucide-react';
import { TIMEFRAMES, formatIsoDate } from './break-idle';

// Staff profile · global timeframe. [ Today | 7D | 30D | Custom ] over a
// "Plan Limit: N Days" caption. Custom's pickers stop at the retention cutoff
// (the native `min`), and a range that still reaches past it — typed in, or a
// preset longer than the plan — gets an inline banner rather than silently
// showing fewer days. The page owns the value and resolves it with
// resolveTimeframe(); this only renders it.

const DATE_CLS = 'h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-small text-fg-secondary outline-none focus:border-brand sm:flex-none lg:h-8';

/** Timeframe selector + retention caption. `resolved` = resolveTimeframe(value, …). */
export function TimeframeBar({ value, onChange, today, retentionDays, resolved }) {
  const pick = (key) => onChange(key === 'custom'
    ? { key, from: value.from || resolved.from, to: value.to || resolved.to }
    : { key });

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <div role="group" aria-label="Timeframe" className="flex items-center gap-1 rounded-lg bg-surface-muted p-0.5">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={value.key === t.key}
              onClick={() => pick(t.key)}
              className={`inline-flex h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2.5 text-small font-semibold transition lg:h-7 ${
                value.key === t.key ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'
              }`}
            >
              {t.key === 'custom' && <CalendarDays className="h-3.5 w-3.5" />}
              {t.label}
            </button>
          ))}
        </div>
        {value.key === 'custom' && (
          <div className="flex w-full items-center gap-1.5 text-caption text-fg-subtle sm:w-auto">
            <input
              type="date" aria-label="From" className={DATE_CLS}
              value={value.from || ''} min={resolved.cutoff} max={value.to || today}
              onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })}
            />
            <span className="shrink-0">to</span>
            <input
              type="date" aria-label="To" className={DATE_CLS}
              value={value.to || ''} min={value.from || resolved.cutoff} max={today}
              onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })}
            />
          </div>
        )}
      </div>
      <p className="text-caption text-fg-subtle">
        Plan Limit: <span className="font-semibold tabular-nums text-fg-muted">{retentionDays} Days</span>
        <span className="hidden sm:inline"> · data from {formatIsoDate(resolved.cutoff)}</span>
      </p>
    </div>
  );
}

/** Inline banner for a range that reaches before the retention cutoff. */
export function RetentionBanner({ cutoff, retentionDays }) {
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-xl border border-info-line bg-info-soft px-4 py-3 text-small text-info-ink">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1">
        Data prior to <span className="font-semibold">{formatIsoDate(cutoff)}</span> is unavailable under your {retentionDays}-day retention plan.
        {' '}
        <Link to="/pricing" className="whitespace-nowrap font-semibold underline underline-offset-2 hover:no-underline">Upgrade Plan</Link>
      </p>
    </div>
  );
}
