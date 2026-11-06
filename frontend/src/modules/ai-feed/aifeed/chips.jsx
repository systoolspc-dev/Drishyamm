import { cn } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';
import { SEVERITY_TONE } from './event-model';
import { EventIcon } from './icons';

const SEVERITY_LABEL = { high: 'HIGH', medium: 'MEDIUM', info: 'INFO' };

/**
 * The severity badge. Three levels, three tones, one shape — the only place
 * on the page where a colour fill says "how urgent". Categories never get
 * their own badge colour; they get an icon.
 */
export function SeverityBadge({ severity = 'info', className }) {
  return (
    <span
      data-severity={severity}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-micro font-bold tracking-[0.08em]',
        toneClass(SEVERITY_TONE[severity] || 'info', 'soft'),
        className,
      )}
    >
      {SEVERITY_LABEL[severity] || 'INFO'}
    </span>
  );
}

/**
 * Compact "what the AI saw" chip for a camera tile: tinted icon, event type,
 * and the one detail that matters (a plate, a count, a name). Neutral chip
 * body — only the icon carries the tone.
 */
export function EventChip({ event, className, truncate = true }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-surface-sunken px-2 py-1 text-caption font-semibold text-fg',
        className,
      )}
      title={event.detail ? `${event.title} · ${event.detail}` : event.title}
    >
      <EventIcon name={event.iconName} className="h-3.5 w-3.5 shrink-0 text-fg-muted" strokeWidth={2.1} />
      <span className={cn('min-w-0', truncate && 'truncate')}>{event.title}</span>
      {event.detail ? (
        <>
          <span className="shrink-0 text-fg-disabled">·</span>
          <span className={cn('min-w-0 font-medium text-fg-muted', truncate && 'truncate')}>{event.detail}</span>
        </>
      ) : null}
    </span>
  );
}

/** Counter chip used beside filter tabs and panel titles. */
export function CountPill({ value, active = false, className }) {
  return (
    <span
      className={cn(
        'inline-flex h-4.5 min-w-[18px] items-center justify-center rounded px-1 text-micro font-bold tabular-nums tracking-normal',
        active ? 'bg-brand/15 text-brand-ink' : 'bg-surface-muted text-fg-muted',
        className,
      )}
    >
      {Number(value || 0).toLocaleString('en-IN')}
    </span>
  );
}
