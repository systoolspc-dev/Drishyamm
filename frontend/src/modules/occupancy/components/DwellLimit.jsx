import { Hourglass } from 'lucide-react';
import { InfoTip, Toggle } from './bits';

const MAX_DWELL_MIN = 24 * 60;

/**
 * Max dwell as an on/off rule. Off means nobody is ever flagged for staying --
 * a lobby or a desk floor has no loitering limit, and a slider cannot say
 * "none". Switching it off keeps the last value, so turning it back on
 * restores what was there rather than a default.
 *
 * ONE way to say the number: the hours/minutes pair. It used to have three --
 * six preset chips, the pair, and a badge in the header repeating whatever the
 * pair said. Three controls for one value is three things to read before you
 * know what the rule is, and the chips in particular made 45 minutes look like
 * the unusual answer for having no button. The presets are gone, the echo is
 * gone, the field stays.
 *
 * It is a DURATION, not a time of day, so no clock and no timezone come into
 * it: 2h means two hours after whenever that person walked in. The zone's
 * operating hours (ScheduleRules) are the wall-clock half, and they are
 * evaluated against this browser's local clock.
 */
export default function DwellLimit({
  enabled, minutes, onChange, idPrefix = 'dwell', compact = false,
}) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const setTotal = (total) => onChange({ maxDwellMin: Math.min(MAX_DWELL_MIN, Math.max(0, Math.round(total))) });
  const num = (v) => Math.max(0, Number(v) || 0);
  const about = enabled
    ? 'Anyone who stays longer than this is flagged as loitering. Held on this browser.'
    : 'Off. People can stay as long as they like, and nobody is flagged for loitering.';

  return (
    <div className={`rounded-lg border border-line bg-surface-sunken px-3 ${compact ? 'mt-2 py-2' : 'mt-3 py-2.5'}`}>
      <div className={`flex justify-between gap-3 ${compact ? 'items-center' : 'items-start'}`}>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-body font-semibold text-fg-secondary">
            <Hourglass className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} />
            Max dwell time
            {compact ? <InfoTip label="About max dwell time">{about}</InfoTip> : null}
          </p>
          {compact ? null : <p className="mt-1 text-small leading-relaxed text-fg-subtle">{about}</p>}
        </div>
        <Toggle
          checked={enabled}
          id={`${idPrefix}-on`}
          label="Max dwell time"
          onChange={(v) => onChange(v && !minutes ? { dwellEnabled: true, maxDwellMin: 30 } : { dwellEnabled: v })}
        />
      </div>

      {enabled ? (
        <div className={`flex flex-col border-t border-line-subtle ${compact ? 'mt-2 gap-2 pt-2' : 'mt-3 gap-2.5 pt-3'}`}>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5" htmlFor={`${idPrefix}-h`}>
              <input
                className="w-16 rounded-lg border border-line bg-surface px-2 py-1.5 text-center text-body font-bold tabular-nums text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
                id={`${idPrefix}-h`}
                max={24}
                min={0}
                onChange={(e) => setTotal(Math.min(24, num(e.target.value)) * 60 + m)}
                type="number"
                value={h}
              />
              <span className="text-body font-semibold text-fg-muted">hours</span>
            </label>
            <label className="flex items-center gap-1.5" htmlFor={`${idPrefix}-m`}>
              <input
                className="w-16 rounded-lg border border-line bg-surface px-2 py-1.5 text-center text-body font-bold tabular-nums text-fg focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
                id={`${idPrefix}-m`}
                max={59}
                min={0}
                onChange={(e) => setTotal(h * 60 + Math.min(59, num(e.target.value)))}
                step={5}
                type="number"
                value={m}
              />
              <span className="text-body font-semibold text-fg-muted">minutes</span>
            </label>
          </div>

          {minutes === 0 ? (
            <p className="text-small font-semibold text-warning-ink">Set at least 1 minute, or switch the limit off.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

