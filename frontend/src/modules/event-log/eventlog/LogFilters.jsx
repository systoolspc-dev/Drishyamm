import { Search, X } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';
import { SEVERITIES } from '@/modules/ai-feed/aifeed/event-model';
import { VIOLATIONS, eventTypeLabel } from './log-query';

/**
 * One row of filters over the whole log.
 *
 * All of them narrow the SAME set and compose; none of them reloads the page
 * into a different mode. The date is first because it is the only filter that
 * changes what is fetched — the rest are applied to what is already on screen,
 * which is why they feel instant and it does not.
 *
 * Under the Staff Violations view the Event Type select gives way to a
 * Violation select in the same slot: four fixed, plainly worded kinds, each
 * with the dot colour its table badge carries. Outside that view it would be
 * a second way to pick the same rows, so it is not shown.
 *
 * Status and Category have no select here: they arrive by deep link
 * (?status=UNACKNOWLEDGED&category=QUEUE from the dashboard) and are shown,
 * and cleared, as chips — see LogFilterChips.
 */

// Borderless: the pair sits inside one bordered group, and a border on each
// input as well drew a box inside a box. Same type size as the Select
// triggers beside it (text-control), so the row reads as one set of controls.
const FIELD = 'h-full min-w-0 rounded-md bg-transparent px-1.5 text-control tabular-nums text-fg transition focus:bg-surface-muted focus:outline-none';

// The four selects share their row and stretch to fill it, but never shrink
// below the width of their longest "All …" label.
const SELECT = 'h-9 min-w-38 flex-1 bg-surface';

/**
 * The options for a select, plus the current value if it is not among them.
 *
 * Camera and Event Type are populated from what the chosen DAY contains, so a
 * deep link can arrive asking for a camera or a type that today has no events
 * for. A Radix Select whose value matches no item renders an EMPTY trigger —
 * the filter was applied, the chip said so, and the control above it was a
 * blank box. Carrying the orphan value as its own option keeps the trigger
 * readable and the control honest about what it is filtering on.
 */
function withCurrent(options, value, label) {
  if (value === 'all' || options.some((o) => o.id === value)) return options;
  return [...options, { id: value, label: label(value), orphan: true }];
}

function DateField({ label, value, min, max, onChange }) {
  return (
    <input
      type="date"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(e.target.value)}
      className={cn(FIELD, 'w-35')}
    />
  );
}

export default function LogFilters({
  from, to, onFrom, onTo,
  site, onSite, sites,
  camera, onCamera, cameras,
  type, onType, types,
  view, violation, onViolation,
  severity, onSeverity,
  query, onQuery,
  dirty, onClear,
}) {
  return (
    // Three blocks that wrap as blocks: dates, search, and the four selects.
    // Search and the select group both grow, so whether everything fits on
    // one row or the selects drop to a second, each row is filled edge to
    // edge — never one orphaned dropdown on a line of its own.
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface px-1 focus-within:border-brand">
        <DateField label="From date" value={from} max={to} onChange={onFrom} />
        <span className="px-0.5 text-small text-fg-subtle" aria-hidden="true">to</span>
        <DateField label="To date" value={to} min={from} onChange={onTo} />
      </div>

      <div className="relative min-w-56 flex-1 basis-[16rem]">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" strokeWidth={2} />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search events, people, cameras…"
          aria-label="Search the log"
          className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-7 text-control text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {/* The selects wrap among themselves; Clear Filters sits beside them,
          outside that wrap, so appearing never pushes it onto a line alone. */}
      <div className="flex flex-2 basis-xl items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Select value={site} onValueChange={onSite}>
            <SelectTrigger className={SELECT} aria-label="Filter by site"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sites</SelectItem>
              {sites.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select value={camera} onValueChange={onCamera}>
            <SelectTrigger className={SELECT} aria-label="Filter by camera"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Cameras</SelectItem>
              {withCurrent(
                cameras.map((c) => ({ id: c.monitorId, label: c.name || c.monitorId })),
                camera,
                (id) => id,
              ).map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>

          {view === 'violations' ? (
            <Select value={violation} onValueChange={onViolation}>
              <SelectTrigger className={cn(SELECT, 'min-w-56')} aria-label="Filter by violation type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Violations</SelectItem>
                {VIOLATIONS.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', toneClass(v.tone, 'dot'))} aria-hidden="true" />
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            // Only the types actually present in the range are offered. A
            // dropdown listing forty detectors the estate does not run is a
            // menu of dead ends; this one can only ever return rows.
            <Select value={type} onValueChange={onType}>
              <SelectTrigger className={SELECT} aria-label="Filter by event type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Event Types</SelectItem>
                {withCurrent(types, type, eventTypeLabel).map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={severity} onValueChange={onSeverity}>
            <SelectTrigger className={SELECT} aria-label="Filter by severity"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              {SEVERITIES.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {dirty ? (
          <button
            type="button"
            onClick={onClear}
            className="h-9 shrink-0 whitespace-nowrap rounded-lg px-2.5 text-small font-semibold text-brand-ink transition hover:bg-brand-soft"
          >
            Clear Filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
