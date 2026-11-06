import { useEffect, useMemo, useRef } from 'react';
import {
  ArrowDown, ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, Copy,
  MonitorPlay, MoreVertical, PlaySquare,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { Button } from '@/core/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/core/ui/table';
import { StatusBadge } from '@/core/ui/status-badge';
import { LoadingState } from '@/core/ui/states';
import TargetThumb from '@/modules/ai-feed/aifeed/TargetThumb';
import { SeverityBadge } from '@/modules/ai-feed/aifeed/chips';
import { locationLabel } from '@/modules/ai-feed/aifeed/event-model';
import {
  CONTINUOUS, PAGE_SIZES, SOURCE_META, STATUS_META, fmtTime, sourceOf, statusOf,
} from './log-model';
import { T, TH } from '@/modules/employee-productivity/type';
import { violationOf } from './log-query';

/**
 * The record itself: one row per event, newest first, with the evidence
 * thumbnail in the row so an operator can dismiss a false positive without
 * opening anything.
 *
 * Colour in this table means "go look now", and only two things carry it:
 * severity, and a staff violation badge beside the event name (amber for
 * phone use, over-breaks and gatherings; red for an unattended station — the
 * same split the detectors grade as medium and high). The Type and Status
 * columns stay deliberately neutral chips: tinting four sources and five
 * states as well would leave the eye with nine competing colours.
 *
 * Two ways through a long log: numbered pages (the default — an auditor can
 * say "page 3") or Continuous, which keeps appending rows as the table scrolls
 * to its end. Rows that can be acknowledged carry a checkbox for bulk action.
 */

function Check({ checked, indeterminate = false, disabled = false, onChange, label, title }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      title={title}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 cursor-pointer rounded border-line-strong accent-[var(--color-brand)] disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

// Calls onReach when the sentinel scrolls into its scroll container.
function useReachEnd(onReach, enabled) {
  const sentinel = useRef(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!enabled || !el) return undefined;
    const io = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) onReach(); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onReach, enabled]);
  return sentinel;
}

function Pagination({ page, pageCount, onPage }) {
  // At most seven buttons, always including the first, the last and the
  // current — the same rule the Health table uses, so paging feels identical.
  const pages = useMemo(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
    const out = new Set([1, pageCount, page, page - 1, page + 1]);
    if (page <= 3) [2, 3, 4].forEach((p) => out.add(p));
    if (page >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach((p) => out.add(p));
    return [...out].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  }, [page, pageCount]);

  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="icon-sm" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-1">
          {i > 0 && p - pages[i - 1] > 1 ? <span className="px-1 text-small text-fg-disabled">…</span> : null}
          <Button
            variant={p === page ? 'default' : 'outline'}
            size="icon-sm"
            onClick={() => onPage(p)}
            aria-current={p === page ? 'page' : undefined}
            className="tabular-nums"
          >
            {p}
          </Button>
        </span>
      ))}
      <Button variant="outline" size="icon-sm" onClick={() => onPage(page + 1)} disabled={page >= pageCount} aria-label="Next page">
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function RowMenu({ event, onLive, onPlayback, onAcknowledge }) {
  const acked = statusOf(event) === 'acknowledged';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${event.title}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onLive(event)}>
          <MonitorPlay className="h-4 w-4" /> View live
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPlayback(event)}>
          <PlaySquare className="h-4 w-4" /> View playback
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={acked} onSelect={() => onAcknowledge(event)}>
          <CheckCircle2 className="h-4 w-4" /> {acked ? 'Already acknowledged' : 'Mark as acknowledged'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigator.clipboard?.writeText(String(event.id))}>
          <Copy className="h-4 w-4" /> Copy event ID
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function LogTable({
  rows, totalRows, loading, empty,
  page, pageCount, pageSize, onPage, onPageSize,
  onLoadMore,
  sortDesc, onToggleSort,
  selectedId, onSelect,
  onLive, onPlayback, onAcknowledge,
  checked, onCheck, onCheckAll, canAck,
}) {
  const continuous = pageSize === CONTINUOUS;
  const first = totalRows === 0 ? 0 : continuous ? 1 : (page - 1) * pageSize + 1;
  const last = continuous ? rows.length : Math.min(page * pageSize, totalRows);
  const SortIcon = sortDesc ? ArrowDown : ArrowUp;
  const hasMore = continuous && rows.length < totalRows;
  const sentinel = useReachEnd(onLoadMore, hasMore);

  // Header checkbox: every ackable row in view.
  const ackable = rows.filter(canAck);
  const allOn = ackable.length > 0 && ackable.every((e) => checked.has(e.id));
  const someOn = ackable.some((e) => checked.has(e.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !rows.length ? (
          <LoadingState message="Loading events…" className="py-16" />
        ) : rows.length === 0 ? (
          // Centred in the card rather than pinned to its top, which left the
          // message floating over a tall blank panel.
          <div className="grid min-h-full place-items-center">{empty}</div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 [&_tr]:border-b-0">
              <TableRow>
                <TableHead className={cn(TH.left, 'w-[2.5rem] px-2')}>
                  <Check
                    label="Select all acknowledgeable events in view"
                    checked={allOn}
                    indeterminate={someOn && !allOn}
                    disabled={!ackable.length}
                    onChange={() => onCheckAll(ackable.map((e) => e.id), !allOn)}
                  />
                </TableHead>
                <TableHead className={cn(TH.left, 'w-[9.5rem]')}>
                  <button
                    type="button"
                    onClick={onToggleSort}
                    className="inline-flex items-center gap-1 font-semibold text-fg-secondary transition hover:text-fg"
                  >
                    Time <SortIcon className="h-3 w-3" strokeWidth={2.4} />
                  </button>
                </TableHead>
                <TableHead className={TH.left}>Event</TableHead>
                <TableHead className={cn(TH.left, 'w-[5.5rem]')}>Type</TableHead>
                <TableHead className={cn(TH.left, 'w-[11rem]')}>Source</TableHead>
                <TableHead className={cn(TH.left, 'w-[10rem]')}>Location</TableHead>
                <TableHead className={cn(TH.left, 'w-[6.5rem]')}>Severity</TableHead>
                <TableHead className={cn(TH.left, 'w-[8.5rem]')}>Status</TableHead>
                <TableHead className={cn(TH.left, 'w-[3rem] px-2')} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((event) => {
                const status = STATUS_META[statusOf(event)];
                const violation = violationOf(event);
                const selected = event.id === selectedId;
                return (
                  <TableRow
                    key={event.id}
                    onClick={() => onSelect(event.id)}
                    aria-selected={selected}
                    className={cn(
                      'cursor-pointer',
                      selected && 'bg-brand-soft/60 hover:bg-brand-soft/60',
                    )}
                  >
                    <TableCell>
                      <Check
                        label={`Select ${event.title}`}
                        checked={checked.has(event.id)}
                        disabled={!canAck(event)}
                        title={canAck(event) ? undefined : statusOf(event) === 'acknowledged'
                          ? 'Already acknowledged'
                          : 'Activity-service events cannot be acknowledged from the log'}
                        onChange={() => onCheck(event.id)}
                      />
                    </TableCell>

                    <TableCell className={cn('whitespace-nowrap px-4 tabular-nums', T.tdSub)}>
                      {fmtTime(event.ts)}
                    </TableCell>

                    <TableCell className="px-4">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <TargetThumb event={event} size={34} />
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <p className={cn('truncate', T.tdPrimary)}>{event.title}</p>
                            {violation ? (
                              <StatusBadge tone={violation.tone} size="sm" dot={false} title={violation.label}>
                                {violation.badge}
                              </StatusBadge>
                            ) : null}
                          </div>
                          {event.detail ? (
                            <p className={cn('truncate', T.tdSub)}>{event.detail}</p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className="px-4">
                      <span className="inline-flex items-center rounded border border-line bg-surface-sunken px-1.5 py-0.5 text-micro font-bold uppercase tracking-[0.06em] text-fg-muted">
                        {SOURCE_META[sourceOf(event)]?.label || 'AI'}
                      </span>
                    </TableCell>

                    <TableCell className="truncate px-4 text-fg-secondary" title={event.cameraName}>
                      {event.cameraName || event.monitorId || '—'}
                    </TableCell>

                    <TableCell className="truncate px-4 text-fg-muted">
                      {locationLabel(event.cameraName, event.location) || event.location || '—'}
                    </TableCell>

                    <TableCell className="px-4"><SeverityBadge severity={event.severity} className={T.severityBadge} /></TableCell>

                    <TableCell className="px-4">
                      <StatusBadge tone={status.tone} size="sm" dot={false} className={T.stateBadge}>{status.label}</StatusBadge>
                    </TableCell>

                    <TableCell>
                      <RowMenu event={event} onLive={onLive} onPlayback={onPlayback} onAcknowledge={onAcknowledge} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {hasMore ? (
          <div ref={sentinel} className="py-3 text-center text-caption text-fg-subtle">Loading more…</div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
        {totalRows ? (
          <p className="text-small text-fg-muted">
            Showing{' '}
            <span className="font-semibold tabular-nums text-fg-secondary">{first}–{last}</span>
            {' '}of{' '}
            <span className="font-semibold tabular-nums text-fg-secondary">{totalRows.toLocaleString()}</span>
            {' '}events
          </p>
        ) : (
          <p className="text-small text-fg-muted">No events to show</p>
        )}
        <div className="flex items-center gap-2">
          {!continuous && pageCount > 1 ? <Pagination page={page} pageCount={pageCount} onPage={onPage} /> : null}
          <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
            <SelectTrigger size="sm" className="w-32" aria-label="Rows per page"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>
              ))}
              <SelectItem value={String(CONTINUOUS)}>Continuous</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
