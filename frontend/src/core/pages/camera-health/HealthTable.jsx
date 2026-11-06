import { Fragment, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Columns3,
  Copy,
  Download,
  ArrowDown,
  ArrowUp,
  MonitorPlay,
  MoreVertical,
  PanelRightOpen,
  RefreshCw,
  Search,
  VideoOff,
  Zap,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { Button } from '@/core/ui/button';
import { Input } from '@/core/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { StatusBadge } from '@/core/ui/status-badge';
import CameraDetailDialog from './CameraDetailDialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/core/ui/table';
import { useSnapshot } from '@/core/hooks/useSnapshot';
import { BELOW_MD, BELOW_SM, BELOW_XL, useMediaQuery } from '@/core/hooks/useMediaQuery';
import {
  bucketMeta,
  bucketOf,
  DASH,
  engineState,
  fmtBps,
  fmtDuration,
  fmtTimestamp,
  fmtTimestampFull,
  gradeDelay,
  isStreaming,
} from './health-vocabulary';
import { COLUMNS, DEFAULT_COLUMNS, PAGE_SIZES } from './health-columns';

/**
 * The row's still.
 *
 * Only online cameras are asked for one: a grab against a camera we already
 * know is down costs an ffmpeg slot and a recorder session to produce a
 * failure we could have predicted. The shared cache behind `useSnapshot`
 * holds one still per camera for the whole session and never runs more than
 * three grabs at once, and the server allows only one per recorder — the
 * ceiling that keeps a page of thumbnails from doing to an NVR what a wall of
 * live tiles once did.
 */
function Thumb({ camera, enabled }) {
  const online = bucketOf(camera) === 'online';
  const snap = useSnapshot(enabled && online ? camera.monitorId : null);

  return (
    <span className="grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-muted">
      {snap?.url ? (
        <img
          src={snap.url}
          alt=""
          className={cn('h-full w-full object-cover', snap.stale && 'opacity-60')}
          title={snap.stale ? 'Last still available — the camera has not answered since' : undefined}
        />
      ) : (
        <VideoOff className="h-3.5 w-3.5 text-fg-disabled" aria-hidden />
      )}
    </span>
  );
}

function SortHeader({ column, sort, onSort, className }) {
  const active = sort.id === column.id;
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;

  return (
    <TableHead className={cn('px-3', className)}>
      <button
        type="button"
        onClick={() => onSort(column.id)}
        aria-label={`Sort by ${column.label}`}
        className={cn(
          'inline-flex items-center gap-1 rounded transition-colors hover:text-fg',
          active ? 'font-bold text-fg' : 'font-semibold text-fg-muted',
        )}
      >
        {column.label}
        <Icon className={cn('h-3.5 w-3.5', active ? 'text-brand' : 'text-fg-disabled')} />
      </button>
    </TableHead>
  );
}

function Cell({ camera, columnId, thumbnails, onOpen }) {
  switch (columnId) {
    case 'camera':
      return (
        <div className="flex min-w-0 items-center gap-3">
          <Thumb camera={camera} enabled={thumbnails} />
          <div className="min-w-0">
            {/* The name is the row's handle: clicking it opens the camera in
                full. A button, not the whole row — the row carries a
                checkbox and a menu, and a row-wide click target would fire
                every time someone reached for either. */}
            <button
              type="button"
              onClick={() => onOpen?.(camera)}
              className="block max-w-full truncate rounded text-left text-body font-semibold text-fg transition-colors hover:text-brand-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              {camera.name}
            </button>
            <p className="truncate text-caption font-medium uppercase tracking-wide text-fg-muted">
              {camera.monitorId}
            </p>
          </div>
        </div>
      );

    case 'location':
      return (
        <div className="min-w-0">
          <p className="truncate text-body text-fg-secondary">{camera.groupName || DASH}</p>
          <p className="truncate text-caption text-fg-muted">{camera.siteName || 'Unassigned site'}</p>
        </div>
      );

    case 'status': {
      const state = engineState(camera.status);
      const meta = bucketMeta(state.bucket);
      return (
        <StatusBadge
          status={meta.status}
          label={meta.label}
          size="sm"
          title={`${state.headline} — ${camera.reason || state.action}`}
        />
      );
    }

    case 'delay': {
      const grade = gradeDelay(camera.jitterMs, { hasStream: isStreaming(camera) });
      return (
        <span
          className={cn('text-body tabular-nums', grade.tone === 'danger' ? 'font-semibold text-danger-ink' : 'text-fg-secondary')}
          title={grade.label}
        >
          {grade.text}
        </span>
      );
    }

    case 'bitrate':
      return (
        <span className="text-body tabular-nums text-fg-secondary">
          {fmtBps(camera.bpsIn || camera.meanBps)}
        </span>
      );

    case 'lastUpdate':
      return (
        <span className="text-body tabular-nums text-fg-secondary" title={fmtTimestampFull(camera.lastUpdate)}>
          {fmtTimestamp(camera.lastUpdate)}
        </span>
      );

    case 'viewers':
      return <span className="text-body tabular-nums text-fg-secondary">{Number(camera.readers) || 0}</span>;

    case 'errors': {
      const rate = Number(camera.fieRate) || 0;
      return (
        <span className={cn('text-body tabular-nums', rate > 0 ? 'font-semibold text-danger-ink' : 'text-fg-secondary')}>
          {rate > 0 ? `${rate}/s` : DASH}
        </span>
      );
    }

    case 'drops': {
      const drops = Number(camera.flapCount) || 0;
      return (
        <span className={cn('text-body tabular-nums', drops > 0 ? 'font-semibold text-warning-ink' : 'text-fg-secondary')}>
          {drops || DASH}
        </span>
      );
    }

    case 'codec':
      return <span className="text-body text-fg-secondary">{camera.codec || DASH}</span>;

    case 'resolution':
      return <span className="text-body tabular-nums text-fg-secondary">{camera.resolution || DASH}</span>;

    case 'uptime':
      return (
        <span className="text-body tabular-nums text-fg-secondary">
          {camera.readSinceSec != null ? fmtDuration(camera.readSinceSec) : DASH}
        </span>
      );

    default:
      return null;
  }
}

/**
 * The columns this viewport has no room for, as a label/value grid under the
 * row the operator opened.
 *
 * Nothing is lost on a narrow screen — bitrate, errors, drops, codec and
 * resolution are still here, one tap away, instead of adding 600px of
 * horizontal scroll to a table nobody can scroll sideways on a tablet while
 * holding it.
 */
function RowDetails({ camera, columns, thumbnails, span }) {
  return (
    <TableRow className="bg-surface-sunken hover:bg-surface-sunken">
      <TableCell colSpan={span} className="px-4 py-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
          {columns.map((column) => (
            <div key={column.id} className="min-w-0">
              <dt className="truncate text-caption font-semibold uppercase tracking-wide text-fg-muted">
                {column.label}
              </dt>
              <dd className="mt-0.5 min-w-0">
                <Cell camera={camera} columnId={column.id} thumbnails={thumbnails} />
              </dd>
            </div>
          ))}
        </dl>
      </TableCell>
    </TableRow>
  );
}

function RowActions({ camera, onAction, onOpen, busy }) {
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${camera.name}`}
          className="text-fg-muted"
        >
          {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => onOpen(camera)}>
          <PanelRightOpen className="h-4 w-4" />
          View details
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate(`/live?monitor=${encodeURIComponent(camera.monitorId)}`)}>
          <MonitorPlay className="h-4 w-4" />
          Open in Live View
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAction(camera, 'heal')}>
          <RefreshCw className="h-4 w-4" />
          Reconnect
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction(camera, 'keyframe')}>
          <Zap className="h-4 w-4" />
          Clear freeze
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigator.clipboard?.writeText(camera.monitorId)}>
          <Copy className="h-4 w-4" />
          Copy camera ID
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Pagination({ page, pageCount, onPage }) {
  // At most seven page buttons, always including the first, the last and the
  // current one. A 2600-camera estate is 260 pages; rendering them all would
  // put a scrollbar in the footer.
  const pages = useMemo(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
    const out = new Set([1, pageCount, page, page - 1, page + 1]);
    if (page <= 3) [2, 3, 4].forEach((p) => out.add(p));
    if (page >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach((p) => out.add(p));
    return [...out].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  }, [page, pageCount]);

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-1">
          {i > 0 && p - pages[i - 1] > 1 ? (
            <span className="px-1 text-small text-fg-disabled">…</span>
          ) : null}
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

      <Button
        variant="outline"
        size="icon-sm"
        onClick={() => onPage(page + 1)}
        disabled={page >= pageCount}
        aria-label="Next page"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function HealthTable({
  rows,
  total,
  loading,
  columns,
  onColumnsChange,
  sort,
  onSortChange,
  selected,
  onSelectedChange,
  thumbnails,
  onThumbnailsChange,
  pageSize,
  onPageSizeChange,
  onExport,
  onAction,
  busyCamera,
  bulk,
  emptyState,
}) {
  const [requestedPage, setRequestedPage] = useState(1);
  const [expanded, setExpanded] = useState(() => new Set());
  const [columnQuery, setColumnQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const scrollRef = useRef(null);
  const searchRef = useRef(null);

  // How many column tiers this viewport can carry: identity and status always,
  // the operational read from `md`, the diagnostics from `xl`. See health-columns.js.
  const belowSm = useMediaQuery(BELOW_SM);
  const belowMd = useMediaQuery(BELOW_MD);
  const belowXl = useMediaQuery(BELOW_XL);
  const maxTier = belowMd ? 1 : belowXl ? 2 : 3;

  // No stills on a phone. The thumbnail is 56px of the ~144px the content
  // columns get once the checkbox, chevron and actions have taken theirs, and
  // it was spending that on a picture too small to read — while fetching a
  // snapshot per row over mobile data. The name and the badge get it instead.
  const showThumbnails = thumbnails && !belowSm;

  // The column chooser's own search. Twelve entries is past the point where
  // scanning beats typing, and it is the same list the PDF and CSV exports draw on.
  const matchingColumns = useMemo(() => {
    const needle = columnQuery.trim().toLowerCase();
    if (!needle) return COLUMNS;
    return COLUMNS.filter((c) => c.label.toLowerCase().includes(needle));
  }, [columnQuery]);

  const chosen = COLUMNS.filter((c) => columns.includes(c.id));
  const visibleColumns = chosen.filter((c) => c.tier <= maxTier);
  const collapsedColumns = chosen.filter((c) => c.tier > maxTier);
  const expandable = collapsedColumns.length > 0;

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  // Filtering can strip the current page out from under the operator. Clamp
  // while rendering rather than correcting it in an effect afterwards: the
  // effect version paints one empty page first, then jumps.
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  const goToPage = (next) => {
    setRequestedPage(Math.min(Math.max(1, next), pageCount));
    scrollRef.current?.scrollTo({ top: 0 });
  };

  // Select-all applies to THIS PAGE, which is the set the operator can see.
  // A checkbox that silently selects 2600 rows, of which eight are on screen,
  // is how people bulk-reconnect an entire estate by accident.
  const pageIds = pageRows.map((c) => c.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleAllOnPage = () => {
    const next = new Set(selected);
    if (allOnPage) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    onSelectedChange(next);
  };

  const toggleRow = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  const toggleExpanded = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSort = (id) => {
    if (sort.id === id) onSortChange({ id, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    else onSortChange({ id, dir: 'asc' });
  };

  // The dialog follows the 10s poll: look its camera up again each render so
  // a Reconnect shows its result in place. If the row has since been filtered
  // out from under it, fall back to the object it was opened with rather than
  // closing on the operator mid-read.
  const detailCamera = detail ? rows.find((c) => c.id === detail.id) || detail : null;

  const firstShown = rows.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, rows.length);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      {/* Card header. One line: the title, then the table's own controls
          immediately above the column headers they act on. The "problems
          first" note that used to sit under the title is in the guide dialog —
          it was a sentence of standing height to explain a sort order the
          first row already demonstrates. */}
      <div className="shrink-0 border-b border-line px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="min-w-0 text-heading font-bold text-fg">
            Camera list ({rows.length}
            {rows.length !== total ? ` of ${total}` : ''})
          </h2>

          <div className="flex shrink-0 items-center gap-2">
            {/* Clearing the search on close, so the menu never reopens
                already filtered by something typed minutes ago. */}
            <DropdownMenu onOpenChange={(isOpen) => { if (!isOpen) setColumnQuery(''); }}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns3 className="h-4 w-4" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              {/* Centred on the trigger: the panel's midline matches the
                  button's, so it hovers directly beneath it and drifts to
                  neither side. `collisionPadding` is the only thing that will
                  move it, and only to keep it on screen — on a phone, where a
                  240px panel under a button near the right edge has nowhere
                  else to go. */}
              <DropdownMenuContent
                align="center"
                sideOffset={8}
                collisionPadding={12}
                className="w-60"
                // Radix focuses the first menu item on open, which would leave
                // typing to its own typeahead. The search field is the point of
                // this menu, so it takes the focus instead.
                onOpenAutoFocus={(e) => { e.preventDefault(); searchRef.current?.focus(); }}
              >
                <div className="relative p-1.5">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
                  <Input
                    ref={searchRef}
                    value={columnQuery}
                    onChange={(e) => setColumnQuery(e.target.value)}
                    placeholder="Find a column…"
                    aria-label="Find a column"
                    className="h-8 pl-8 text-small"
                    // Every key stays in the field. Without this the menu's
                    // typeahead eats the letters and jumps the highlight, and
                    // Space toggles whichever row it landed on.
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </div>
                <DropdownMenuSeparator />

                <div className="max-h-64 overflow-y-auto">
                  {matchingColumns.length === 0 ? (
                    <p className="px-2 py-3 text-center text-small text-fg-muted">
                      No column matches “{columnQuery}”
                    </p>
                  ) : (
                    matchingColumns.map((column) => (
                      <DropdownMenuCheckboxItem
                        key={column.id}
                        checked={columns.includes(column.id)}
                        disabled={column.locked}
                        onCheckedChange={(checked) => {
                          onColumnsChange(
                            checked
                              ? COLUMNS.filter((c) => c.id === column.id || columns.includes(c.id)).map((c) => c.id)
                              : columns.filter((id) => id !== column.id),
                          );
                        }}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {column.label}
                      </DropdownMenuCheckboxItem>
                    ))
                  )}
                </div>

                {/* Without this, enabling Codec on a tablet looks like a
                    broken checkbox: the column is on, and the table does not
                    change, because it has moved into the row details. */}
                {collapsedColumns.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <p className="px-2 py-1.5 text-caption leading-relaxed text-fg-muted">
                      Too narrow for {collapsedColumns.map((c) => c.label).join(', ')} — open a
                      row&apos;s details to see them.
                    </p>
                  </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onColumnsChange(DEFAULT_COLUMNS)}>
                  Reset to default
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* The toolbar's primary call to action, in the brand orange the
                dashboard uses for its own CTAs — exporting the list is what
                an operator comes to this row to DO, and it used to read as
                the quietest control on it. It opens the format and delivery
                dialog rather than dropping a CSV on the spot. */}
            <Button
              size="sm"
              onClick={() => onExport(rows)}
              disabled={rows.length === 0}
              aria-haspopup="dialog"
            >
              <Download className="h-4 w-4" />
              Export
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Table options" className="text-fg-muted">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              {/* `align="end"` here, not centred: this is the last control
                  at the card's right edge, so a centred panel would be half
                  off the page. It still hangs beneath its own button. */}
              <DropdownMenuContent
                side="bottom"
                align="end"
                sideOffset={8}
                collisionPadding={12}
                className="w-52"
              >
                <DropdownMenuLabel>Rows per page</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={String(pageSize)}
                  onValueChange={(v) => { onPageSizeChange(Number(v)); setRequestedPage(1); }}
                >
                  {PAGE_SIZES.map((size) => (
                    <DropdownMenuRadioItem key={size} value={String(size)}>{size}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={thumbnails}
                  onCheckedChange={onThumbnailsChange}
                  onSelect={(e) => e.preventDefault()}
                >
                  Show thumbnails
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Bulk bar — only present when there is a selection to act on. */}
        {selected.size > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-line bg-brand-soft px-3 py-2">
            <span className="text-small font-semibold text-brand-ink">
              {selected.size} selected
            </span>
            <span className="text-small text-brand-ink/70">{bulk.status}</span>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={bulk.onReconnect} disabled={bulk.busy}>
                <RefreshCw className={cn('h-4 w-4', bulk.busy && 'animate-spin')} />
                Reconnect
              </Button>
              <Button variant="outline" size="sm" onClick={bulk.onExport} disabled={bulk.busy} aria-haspopup="dialog">
                <Download className="h-4 w-4" />
                Export
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onSelectedChange(new Set())} disabled={bulk.busy}>
                Clear
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Table */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-muted" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          emptyState
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-10 pl-4">
                  <input
                    type="checkbox"
                    checked={allOnPage}
                    onChange={toggleAllOnPage}
                    aria-label="Select all cameras on this page"
                    className="h-4 w-4 cursor-pointer rounded border-line accent-brand"
                  />
                </TableHead>
                {visibleColumns.map((column) => (
                  <SortHeader key={column.id} column={column} sort={sort} onSort={toggleSort} />
                ))}
                {expandable ? (
                  <TableHead className="w-10">
                    <span className="sr-only">Details</span>
                  </TableHead>
                ) : null}
                <TableHead className="w-16 pr-4 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {pageRows.map((camera) => {
                const open = expandable && expanded.has(camera.id);
                return (
                  <Fragment key={camera.id}>
                    <TableRow
                      data-state={selected.has(camera.id) ? 'selected' : undefined}
                      className="[&>td]:py-2.5"
                    >
                      <TableCell className="pl-4">
                        <input
                          type="checkbox"
                          checked={selected.has(camera.id)}
                          onChange={() => toggleRow(camera.id)}
                          aria-label={`Select ${camera.name}`}
                          className="h-4 w-4 cursor-pointer rounded border-line accent-brand"
                        />
                      </TableCell>
                      {visibleColumns.map((column) => (
                        <TableCell key={column.id} className="max-w-[260px] px-3">
                          <Cell
                            camera={camera}
                            columnId={column.id}
                            thumbnails={showThumbnails}
                            onOpen={setDetail}
                          />
                        </TableCell>
                      ))}
                      {expandable ? (
                        <TableCell className="px-0">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => toggleExpanded(camera.id)}
                            aria-expanded={open}
                            aria-label={`${open ? 'Hide' : 'Show'} details for ${camera.name}`}
                            className="text-fg-muted"
                          >
                            <ChevronDown
                              className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
                            />
                          </Button>
                        </TableCell>
                      ) : null}
                      <TableCell className="pr-4 text-right">
                        <RowActions
                          camera={camera}
                          onAction={onAction}
                          onOpen={setDetail}
                          busy={busyCamera === camera.monitorId}
                        />
                      </TableCell>
                    </TableRow>

                    {open ? (
                      <RowDetails
                        camera={camera}
                        columns={collapsedColumns}
                        thumbnails={showThumbnails}
                        span={visibleColumns.length + 3}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Footer */}
      {rows.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="text-small text-fg-muted">
            Showing <span className="font-semibold tabular-nums text-fg-secondary">{firstShown} - {lastShown}</span> of{' '}
            <span className="font-semibold tabular-nums text-fg-secondary">{rows.length}</span> cameras
          </p>
          {pageCount > 1 ? <Pagination page={page} pageCount={pageCount} onPage={goToPage} /> : null}
        </div>
      ) : null}

      <CameraDetailDialog
        camera={detailCamera}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        onAction={onAction}
        busy={Boolean(detailCamera) && busyCamera === detailCamera.monitorId}
      />
    </section>
  );
}

export default HealthTable;
