import { TriangleAlert } from 'lucide-react';
import { InfoTip, Slider, Toggle } from './bits';
import { BUSY_PCT, FULL_PCT } from '../occupancy-data';

const MIN_PCT = 50;
const MAX_PCT = 95;

/**
 * The early-warning line, as an on/off rule with a percentage.
 *
 * Built to the same anatomy as DwellLimit so the drawer and Zone Setup carry
 * one kind of optional rule, not two. Off keeps the last percentage, so turning
 * it back on restores what was there. The count it translates to is shown
 * beside the slider: "warn at 80%" is abstract until it reads "at 64 people".
 */
export default function WarnThreshold({
  enabled, pct, capacity, onChange, idPrefix = 'warn', compact = false,
}) {
  const value = Math.min(MAX_PCT, Math.max(MIN_PCT, Number(pct) || FULL_PCT));
  const heads = capacity > 0 ? Math.ceil((capacity * value) / 100) : null;
  const about = enabled
    ? `Raises a congestion alert before the limit is reached${heads != null ? ` — at ${heads} ${heads === 1 ? 'person' : 'people'}` : ''}.`
    : 'Off. The zone only alerts once it is over its limit.';

  return (
    <div className={`rounded-lg border border-line bg-surface-sunken px-3 ${compact ? 'mt-2 py-2' : 'mt-3 py-2.5'}`}>
      <div className={`flex justify-between gap-3 ${compact ? 'items-center' : 'items-start'}`}>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-body font-semibold text-fg-secondary">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
            Near-capacity warning
            {compact ? <InfoTip label="About the near-capacity warning">{about}</InfoTip> : null}
            {compact && enabled && heads != null ? (
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-small font-bold tabular-nums text-brand-ink">at {heads}</span>
            ) : null}
          </p>
          {compact ? null : <p className="mt-1 text-small leading-relaxed text-fg-subtle">{about}</p>}
        </div>
        <Toggle
          checked={enabled}
          id={`${idPrefix}-on`}
          label="Near-capacity warning"
          onChange={(v) => onChange({ warnEnabled: v, warnPct: value })}
        />
      </div>

      {enabled ? (
        <div className="mt-2 border-t border-line-subtle pt-2">
          <label className="sr-only" htmlFor={`${idPrefix}-pct`}>Warn at percent of capacity</label>
          <Slider
            format={(v) => `${v}%`}
            id={`${idPrefix}-pct`}
            max={MAX_PCT}
            min={MIN_PCT}
            onChange={(v) => onChange({ warnPct: v })}
            step={5}
            value={value}
          />
          {value < BUSY_PCT && !compact ? (
            <p className="mt-1.5 text-small text-fg-subtle">
              Below {BUSY_PCT}%, a busy but normal day will raise alerts.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
