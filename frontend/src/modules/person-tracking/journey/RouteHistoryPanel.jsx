/**
 * RouteHistoryPanel — the audit feed.
 *
 * The player answers "where did they go"; this answers "what is the record" —
 * read top to bottom, so an investigator can scan the whole journey without
 * panning and copy a sequence of times into a report.
 *
 * It defaults to NEWEST FIRST, because the question asked of a route is almost
 * always "where are they now". That is a reading order and nothing more: the
 * `nodes` array stays ascending for the time axis and the player, and only
 * this list is flipped (see `orderNodes`). The scrubber below keeps earliest
 * on the left either way — a reversed time axis would be a lie about time.
 *
 * It derives its highlight from the page's `cursorMs`, never from state of its
 * own, which is what keeps it and the player agreeing about "this one".
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  AlertTriangle, ArrowDownWideNarrow, ArrowUpNarrowWide, Clock3, Flag, Hourglass,
  ListFilter, LogIn, MapPin, ShieldAlert,
} from 'lucide-react';
import Panel from '@/core/ui/panel';
import {
  HISTORY_FILTERS, LONG_DWELL_MS, NODE, ORDER, filterHistory, fmtClockSec,
  fmtDuration, nodeStateAt, orderNodes,
} from './journey-model';

const KIND_META = {
  [NODE.START]: { Icon: LogIn, badge: 'Start / Entry', tone: 'text-success-ink', chip: 'bg-success-soft text-success-ink ring-success-line' },
  [NODE.END]: { Icon: Flag, badge: 'Last seen / Exit', tone: 'text-success-ink', chip: 'bg-success-soft text-success-ink ring-success-line' },
  [NODE.ALERT]: { Icon: ShieldAlert, badge: 'Violation', tone: 'text-danger-ink', chip: 'bg-danger-soft text-danger-ink ring-danger-line' },
  [NODE.CLUSTER]: { Icon: MapPin, badge: null, tone: 'text-brand-ink', chip: 'bg-brand-soft text-brand-ink ring-brand-line' },
  [NODE.SIGHTING]: { Icon: MapPin, badge: null, tone: 'text-fg-secondary', chip: '' },
};

export default function RouteHistoryPanel({
  nodes, cursorMs, selectedNodeId, activeNodeId, playing, filter, onFilter, onSelect, onCursor,
  order = ORDER.NEWEST_FIRST, onOrder,
}) {
  const isDesc = order === ORDER.NEWEST_FIRST;
  // Filter, then order. Both are view concerns applied here and nowhere else;
  // `nodes` stays ascending so the axis and the playlist are unaffected.
  const rows = useMemo(() => orderNodes(filterHistory(nodes, filter), order), [nodes, filter, order]);
  // The step on screen in the player is THE step. Without a player (or before
  // it reports), the explicit selection stands in for it.
  const currentId = activeNodeId ?? selectedNodeId;
  const listRef = useRef(null);
  const rowRefs = useRef(new Map());

  // Keep the current step visible as playback moves through the route.
  // "Nearest" semantics, but applied to this list only: `scrollIntoView` would
  // also scroll the page's own scroll container, and on a narrow screen that
  // yanks the viewer away from the video on every clip change.
  useEffect(() => {
    const list = listRef.current;
    const row = currentId ? rowRefs.current.get(currentId) : null;
    if (!list || !row) return;
    // The list is `relative`, so it is the rows' offsetParent.
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTo({ top, behavior: 'smooth' });
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: bottom - list.clientHeight, behavior: 'smooth' });
    }
  }, [currentId, rows]);

  const counts = useMemo(() => ({
    all: nodes.length,
    restricted: nodes.filter((n) => n.hasAlert).length,
    longDwell: nodes.filter((n) => n.dwellMs > LONG_DWELL_MS).length,
  }), [nodes]);

  return (
    // Fills its column: the filters stay put and only the list scrolls, so
    // the card's bottom edge lines up with the video card beside it.
    <Panel
      bodyClass="flex flex-col p-0"
      className="min-h-0 flex-1"
      count={rows.length}
      fill={false}
      icon={ListFilter}
      title="Route history"
    >
      {/* Filters carry their own counts, so an operator can see there are
          three restricted stops without switching to find out. */}
      <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-line-subtle px-3 py-2.5">
        {HISTORY_FILTERS.map((f) => {
          const on = f.id === filter;
          const n = counts[f.id] ?? 0;
          return (
            <button
              aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                on ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-muted hover:border-brand/40 hover:text-fg'
              } ${!n && !on ? 'opacity-50' : ''}`}
              disabled={!n && !on}
              key={f.id}
              onClick={() => onFilter(f.id)}
              type="button"
            >
              {f.label}
              <span className="rounded-full bg-surface-muted px-1 text-[9.5px] font-bold tabular-nums text-fg-muted">
                {n}
              </span>
            </button>
          );
        })}

        {/* Reading order. Labelled with the order it is CURRENTLY in, so the
            control answers "which way is this sorted" without being opened —
            the title says what activating it will do instead. */}
        {onOrder ? (
          <button
            aria-label={`Sorted ${isDesc ? 'newest first' : 'oldest first'}. Activate to sort ${isDesc ? 'oldest first' : 'newest first'}.`}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] font-semibold text-fg-muted transition hover:border-brand/40 hover:text-fg"
            onClick={() => onOrder(isDesc ? ORDER.OLDEST_FIRST : ORDER.NEWEST_FIRST)}
            title={isDesc ? 'Newest first — switch to oldest first' : 'Oldest first — switch to newest first'}
            type="button"
          >
            {isDesc
              ? <ArrowDownWideNarrow className="h-3 w-3 shrink-0" strokeWidth={2.5} />
              : <ArrowUpNarrowWide className="h-3 w-3 shrink-0" strokeWidth={2.5} />}
            {isDesc ? 'Newest first' : 'Oldest first'}
          </button>
        ) : null}
      </div>

      {rows.length ? (
        // `reversed` so assistive tech numbers the list the way it reads. The
        // rows are reordered in the array, never with `column-reverse`, which
        // would leave DOM order (and tab order) disagreeing with the screen.
        <ol
          aria-label={isDesc ? 'Route history, newest sighting first' : 'Route history, oldest sighting first'}
          className="relative min-h-0 flex-1 space-y-2 overflow-y-auto p-3 pr-2"
          ref={listRef}
          reversed={isDesc}
        >
          {rows.map((node) => {
            const meta = KIND_META[node.kind] || KIND_META[NODE.SIGHTING];
            const state = nodeStateAt(node, cursorMs);
            const current = node.id === currentId;
            // Current wins the left edge (amber); a violation keeps its red
            // outline on the other three sides either way, so CAM 12 still
            // reads as restricted while it plays.
            const tone = current
              ? `border-l-4 border-l-amber-500 bg-amber-500/10 shadow-[0_0_12px_-2px_rgba(245,158,11,0.45)] ${
                node.hasAlert ? 'border-red-500/70' : 'border-amber-500/40'
              }`
              : node.hasAlert
                ? 'border-red-500/60 bg-red-500/5 hover:bg-red-500/10'
                : 'border-line hover:border-brand/40 hover:bg-surface-sunken';
            return (
              <li
                key={node.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(node.id, el);
                  else rowRefs.current.delete(node.id);
                }}
              >
                <button
                  aria-current={current ? 'step' : undefined}
                  className={`flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-all duration-200 ${tone} ${
                    state === 'future' && !current ? 'opacity-[0.5]' : ''
                  }`}
                  onClick={() => { onSelect(node.id); onCursor(node.firstSeenMs); }}
                  type="button"
                >
                  {/* The spine: a rail plus a dot, so the list reads as one
                      sequence rather than as a stack of separate cards. */}
                  <span className="relative flex w-3 shrink-0 justify-center self-stretch">
                    <span className="absolute inset-y-0 w-px bg-line" />
                    <span className={`relative mt-1 h-2 w-2 rounded-full ring-2 ring-surface ${
                      node.kind === NODE.ALERT ? 'bg-danger'
                        : node.kind === NODE.CLUSTER ? 'bg-brand'
                          : node.kind === NODE.SIGHTING ? 'bg-line-strong' : 'bg-success'
                    }`}
                    />
                  </span>

                  {/* Identity on top, every pill in one footer row: the pills
                      used to sit above the title on some rows and below it on
                      others, so cards of the same journey came out at
                      different heights with their titles at different offsets. */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold text-fg">{node.label}</span>
                      {current && activeNodeId != null ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.08em] text-amber-600 ring-1 ring-amber-500/40 dark:text-amber-400">
                          <span className="relative flex h-1.5 w-1.5">
                            {playing ? <span className="absolute inset-0 animate-ping rounded-full bg-amber-400 opacity-75" /> : null}
                            <span className="relative h-1.5 w-1.5 rounded-full bg-amber-500" />
                          </span>
                          {playing ? 'Playing' : 'Paused'}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] tabular-nums text-fg-subtle">
                      <Clock3 className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
                      <span className="truncate">
                        {fmtClockSec(node.firstSeenMs)}
                        {node.count > 1 ? ` – ${fmtClockSec(node.lastSeenMs)}` : ''}
                      </span>
                    </span>

                    {node.hasAlert ? (
                      <span className="mt-1 flex items-start gap-1 text-[10px] font-semibold leading-snug text-danger-ink">
                        <AlertTriangle className="mt-px h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
                        <span className="line-clamp-2">{node.alert.message}</span>
                      </span>
                    ) : null}

                    {/* Tags wrap on the left; dwell is pinned to the first line
                        on the right, so it never drops onto a row of its own. */}
                    <span className="mt-2 flex items-start gap-1.5 border-t border-line-subtle pt-2">
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        {meta.badge ? (
                          <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.08em] ring-1 ${meta.chip}`}>
                            <meta.Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
                            {meta.badge}
                          </span>
                        ) : null}
                        {/* A cluster's label already IS its zone. */}
                        {node.zone && node.kind !== NODE.CLUSTER ? (
                          <span className={`inline-flex max-w-[9rem] items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 ${
                            node.hasAlert ? 'bg-danger-soft text-danger-ink ring-danger-line' : 'bg-surface-muted text-fg-muted ring-line'
                          }`}
                          >
                            <MapPin className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
                            <span className="truncate">{node.zone}</span>
                          </span>
                        ) : null}
                        {node.kind === NODE.CLUSTER ? (
                          <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.08em] text-brand-ink ring-1 ring-brand-line">
                            {node.count} sightings
                          </span>
                        ) : null}
                        {node.dwellMs > LONG_DWELL_MS ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.08em] text-warning-ink ring-1 ring-warning-line">
                            <Hourglass className="h-2.5 w-2.5" strokeWidth={2.5} />
                            long dwell
                          </span>
                        ) : null}
                        {/* The gap is a fact about THIS stop — the unmonitored
                            time leading into it. It stays on the row whichever
                            way the list is read, so the copy says "before this
                            stop" rather than relying on the row above it. */}
                        {node.gapBeforeMs != null ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-info-soft px-1.5 py-0.5 text-[9px] font-bold text-info-ink ring-1 ring-info-line">
                            {fmtDuration(node.gapBeforeMs)} unmonitored before this stop
                          </span>
                        ) : null}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-muted px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-fg-secondary ring-1 ring-line">
                        <Hourglass className="h-2.5 w-2.5" strokeWidth={2.5} />
                        {fmtDuration(node.dwellMs)} dwell
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="px-5 py-10 text-center text-[11px] leading-relaxed text-fg-subtle">
          No stop matches this filter.
        </p>
      )}
    </Panel>
  );
}
