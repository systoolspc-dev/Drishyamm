import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Eraser, Pause, Play, Radio, SearchX } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';
import { EmptyState } from '@/core/ui/states';
import TargetThumb from './TargetThumb';
import { CountPill, SeverityBadge } from './chips';
import { SEVERITIES, countBySeverity, fmtClock, fmtRelative, locationLabel } from './event-model';
import { EventIcon } from './icons';

/**
 * One event in the stream. Target thumbnail on the left — the face, the
 * plate, the person at the fence — then the event, where, when, how urgent.
 * Reused inside the camera drawer for that camera's own list.
 */
export function EventRow({ event, selected = false, fresh = false, now, onSelect, dense = false }) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(event)}
      data-event-id={event.id}
      className={cn(
        'relative flex w-full items-start gap-2.5 rounded-lg border px-2 py-2 text-left transition',
        selected
          ? 'border-brand/60 bg-brand-soft/60'
          : 'border-transparent hover:border-line hover:bg-surface-sunken',
        // A hairline of severity on the left edge, so HIGH rows can be found
        // while scrolling without reading every badge. Info rows get none.
        event.severity === 'high' && 'before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-danger',
        event.severity === 'medium' && 'before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-warning',
        fresh && 'animate-in fade-in-0 slide-in-from-top-1 duration-300',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
      )}
    >
      <TargetThumb event={event} size={dense ? 36 : 44} />
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <EventIcon name={event.iconName} className="h-3.5 w-3.5 shrink-0 text-fg-muted" strokeWidth={2.1} />
            <span className="truncate text-small font-semibold text-fg">{event.title}</span>
          </span>
          <SeverityBadge severity={event.severity} />
        </span>
        <span className="mt-0.5 block truncate text-caption font-medium text-fg-muted">
          {event.cameraName}
          {locationLabel(event.cameraName, event.location) ? <span className="text-fg-subtle"> · {event.location}</span> : null}
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className={cn('truncate text-caption', event.detail ? 'font-medium text-fg-secondary' : 'text-fg-subtle')}>
            {event.detail || event.model}
          </span>
          <span
            className="shrink-0 font-mono text-micro font-medium normal-case tracking-normal text-fg-subtle"
            title={event.ts.toLocaleString()}
          >
            {dense ? fmtRelative(event.ts, now) : fmtClock(event.ts)}
          </span>
        </span>
      </span>
    </button>
  );
}

function SeverityTab({ id, label, count, active, onClick }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption font-semibold transition',
        active ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-fg-muted hover:text-fg',
      )}
    >
      {id !== 'all' ? <span className={cn('h-1.5 w-1.5 rounded-full', toneClass(SEVERITIES.find((s) => s.id === id)?.tone, 'dot'))} /> : null}
      {label}
      <CountPill value={count} active={active} />
    </button>
  );
}

function IconButton({ icon, label, onClick, active = false, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md border transition disabled:opacity-40',
        active ? 'border-brand/50 bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-muted hover:text-fg',
      )}
    >
      {createElement(icon, { className: "h-3.5 w-3.5", strokeWidth: 2.1 })}
    </button>
  );
}

/**
 * "Latest AI Events" — the persistent right-hand column.
 *
 * New events never shove the list out from under the operator. While the
 * stream is paused, or the operator has scrolled down into history, incoming
 * events are HELD and a "N new events" pill appears; the list only moves when
 * they ask for it. At the top of the list, live, rows simply appear.
 */
export default function EventStream({
  events,
  rangeLabel,
  selectedId,
  onSelect,
  paused,
  onTogglePause,
  onClear,
  emptyReason = 'none',
  onClearFilters,
  onPreviewSample,
  now,
  className,
}) {
  const [severity, setSeverity] = useState('all');
  const listRef = useRef(null);
  const [atTop, setAtTop] = useState(true);
  const [held, setHeld] = useState(null);          // snapshot of ids while holding
  const eventsRef = useRef(events);
  useEffect(() => { eventsRef.current = events; }, [events]);

  const holding = paused || !atTop;

  // Start/stop holding from the handlers that cause it, so no state is set
  // inside an effect and the snapshot is taken at the exact moment.
  const beginHold = useCallback(() => {
    setHeld((prev) => prev ?? new Set(eventsRef.current.map((e) => e.id)));
  }, []);
  const endHold = useCallback(() => setHeld(null), []);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop < 24;
    if (top !== atTop) {
      setAtTop(top);
      if (!top) beginHold();
      else if (!paused) endHold();
    }
  };

  const togglePause = () => {
    if (!paused) beginHold();
    else if (atTop) endHold();
    onTogglePause?.();
  };

  const flush = () => {
    endHold();
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    setAtTop(true);
    if (paused) onTogglePause?.();
  };

  const clear = () => {
    endHold();
    setAtTop(true);
    onClear?.();
  };

  const counts = useMemo(() => countBySeverity(events), [events]);
  const filtered = useMemo(
    () => (severity === 'all' ? events : events.filter((e) => e.severity === severity)),
    [events, severity],
  );
  const displayed = useMemo(
    () => (holding && held ? filtered.filter((e) => held.has(e.id)) : filtered),
    [filtered, holding, held],
  );
  const pending = holding && held ? filtered.filter((e) => !held.has(e.id)).length : 0;
  const freshIds = useMemo(() => {
    const cutoff = now - 4000;
    return new Set(filtered.filter((e) => e.ts.getTime() >= cutoff).map((e) => e.id));
  }, [filtered, now]);

  const filterEmpty = events.length > 0 && filtered.length === 0;

  return (
    <section className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm', className)}>
      <header className="shrink-0 border-b border-line-subtle px-3 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Radio className={cn('h-4 w-4 shrink-0', paused ? 'text-fg-subtle' : 'text-brand')} strokeWidth={2.1} />
            <h2 className="truncate text-body font-semibold text-fg">Latest AI Events</h2>
            <CountPill value={filtered.length} />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton icon={paused ? Play : Pause} label={paused ? 'Resume stream' : 'Pause stream'} onClick={togglePause} active={paused} />
            <IconButton icon={Eraser} label="Clear stream" onClick={clear} disabled={!events.length} />
          </div>
        </div>
        <div className="mt-2 flex items-center gap-0.5 rounded-lg bg-surface-sunken p-0.5">
          <SeverityTab id="all" label="All" count={events.length} active={severity === 'all'} onClick={() => setSeverity('all')} />
          {SEVERITIES.map((s) => (
            <SeverityTab key={s.id} id={s.id} label={s.label} count={counts[s.id] || 0} active={severity === s.id} onClick={() => setSeverity(s.id)} />
          ))}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {pending > 0 ? (
          <button
            type="button"
            onClick={flush}
            className="absolute left-1/2 top-2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand px-3 text-caption font-semibold text-white shadow-md transition hover:bg-brand-hover"
          >
            <ArrowUp className="h-3 w-3" strokeWidth={2.4} />
            {pending} new event{pending === 1 ? '' : 's'}
          </button>
        ) : null}

        <div ref={listRef} onScroll={handleScroll} className="h-full overflow-y-auto px-1.5 py-1.5">
          {displayed.length ? (
            <ol className="space-y-0.5">
              {displayed.map((e) => (
                <li key={e.id}>
                  <EventRow event={e} selected={e.id === selectedId} fresh={freshIds.has(e.id) && !holding} now={now} onSelect={onSelect} />
                </li>
              ))}
            </ol>
          ) : filterEmpty ? (
            <EmptyState
              icon={SearchX}
              title="No events at this level"
              description={`Nothing ${severity === 'info' ? 'informational' : severity} in the ${rangeLabel.toLowerCase()}. Other levels still have events.`}
              action={(
                <button type="button" onClick={() => setSeverity('all')} className="text-small font-semibold text-brand-ink hover:text-brand">
                  Show all levels
                </button>
              )}
              className="py-8"
            />
          ) : emptyReason === 'filter' ? (
            <EmptyState
              icon={SearchX}
              title="No events match this filter"
              description={`No detections of this kind in the ${rangeLabel.toLowerCase()}.`}
              action={(
                <button type="button" onClick={onClearFilters} className="text-small font-semibold text-brand-ink hover:text-brand">
                  Clear filters
                </button>
              )}
              className="py-8"
            />
          ) : emptyReason === 'nocams' ? (
            <EmptyState
              icon={Radio}
              title="No cameras online"
              description="Events appear here as soon as a camera with an AI model comes online."
              action={onPreviewSample ? (
                <button type="button" onClick={onPreviewSample} className="text-small font-semibold text-brand-ink hover:text-brand">
                  Preview with sample data
                </button>
              ) : null}
              className="py-8"
            />
          ) : (
            <EmptyState
              icon={Radio}
              title="No AI events yet"
              description={`Nothing detected in the ${rangeLabel.toLowerCase()}. Detections from every AI model land here as they happen.`}
              action={onPreviewSample ? (
                <button type="button" onClick={onPreviewSample} className="text-small font-semibold text-brand-ink hover:text-brand">
                  Preview with sample data
                </button>
              ) : null}
              className="py-8"
            />
          )}
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between border-t border-line-subtle px-3 py-1.5 text-micro font-medium normal-case tracking-normal text-fg-subtle">
        <span>{paused ? 'Paused — new events are held' : 'Live'}</span>
        <span>{rangeLabel}</span>
      </footer>
    </section>
  );
}
