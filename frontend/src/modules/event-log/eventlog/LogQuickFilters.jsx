import { LayoutList, Settings2, TriangleAlert, UsersRound } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { VIEWS } from './log-query';

/**
 * The quick views over the log: All Activity, Staff Violations, Queue Alerts,
 * System Events. One is always on; picking another narrows on top of every
 * filter below, so each pill's number is exactly what the table will show.
 *
 * Staff Violations carries its count as a solid badge rather than a muted
 * number, and counts only UNACKNOWLEDGED ones: it is the pill a manager opens
 * to act on something, and a lapse somebody has already dealt with is not
 * waiting for them.
 */

const ICONS = {
  all: LayoutList,
  violations: TriangleAlert,
  queue: UsersRound,
  system: Settings2,
};

export default function LogQuickFilters({ view, onView, counts, activeViolations }) {
  return (
    <div className="flex max-w-full flex-wrap items-center gap-1.5" role="group" aria-label="Quick filters">
      {VIEWS.map(({ id, label }) => {
        const Icon = ICONS[id];
        const selected = view === id;
        const alert = id === 'violations' && activeViolations > 0;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => onView(id)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-small transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
              selected
                ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink'
                : 'border-line bg-surface font-medium text-fg-muted hover:border-line-strong hover:text-fg',
            )}
          >
            <Icon
              className={cn('h-3.5 w-3.5', id === 'violations' ? 'text-warning' : selected && 'text-brand')}
              strokeWidth={selected ? 2.25 : 1.85}
            />
            {label}
            {alert ? (
              <span
                className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-danger px-1 text-micro font-bold tabular-nums text-white"
                aria-label={`${activeViolations} unacknowledged`}
              >
                {activeViolations > 99 ? '99+' : activeViolations}
              </span>
            ) : id !== 'violations' && counts[id] ? (
              <span className="text-caption tabular-nums text-fg-subtle">{counts[id].toLocaleString()}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
