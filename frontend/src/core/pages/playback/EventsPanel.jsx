import { memo, useEffect, useState } from 'react';
import {
  AlertTriangle, Bookmark, EllipsisVertical, ListFilter, Loader2, Pencil, Play, Scissors, Search, Trash2, Video, X,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { PageCard } from '@/core/layout/OperationsPage';
import { toneClass } from '@/core/ui/tone';
import { aiService } from '@/core/services/ai';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { EVENT_CATEGORIES, fmtDate, fmtTimeLong, layerOf } from './model';

const PAGE = 20;

/**
 * Right-hand panel: the range's AI events (click to play from just before
 * one) and this browser's bookmarks for the camera.
 *
 * `listKey` names the list being shown (camera + range); "Load more" starts
 * over when it changes.
 */
function EventsPanel({
  className, cameraName, listKey, events, total, loading, error, unavailable, onRetry,
  canFetchMore, fetchingMore, onFetchMore, hidden, onToggleCategory, onShowAll,
  activeId, onPlay, onExportAround, onBookmarkEvent,
  bookmarks, onJumpBookmark, onDeleteBookmark, onRenameBookmark,
}) {
  const [tab, setTab] = useState('events');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState({ key: listKey, shown: PAGE });
  const shown = page.key === listKey ? page.shown : PAGE;

  const needle = query.trim().toLowerCase();
  const byCategory = events.filter((e) => !hidden.has(e.category));
  const visible = needle
    ? byCategory.filter((e) => `${e.title} ${e.who || ''} ${layerOf(e.category).label}`.toLowerCase().includes(needle))
    : byCategory;
  const rows = visible.slice(0, shown);
  const hasMore = shown < visible.length || canFetchMore;
  const capped = !canFetchMore && total > events.length;
  const hiddenCount = EVENT_CATEGORIES.filter((c) => hidden.has(c)).length;
  const counts = {};
  for (const e of events) counts[e.category] = (counts[e.category] || 0) + 1;
  const countLabel = hiddenCount || needle
    ? `${visible.length}${canFetchMore ? '+' : ''}`
    : String(Math.max(total, events.length));

  const loadMore = () => {
    const next = shown + PAGE;
    setPage({ key: listKey, shown: next });
    if (next > visible.length && canFetchMore) onFetchMore();
  };

  return (
    <PageCard className={cn('flex min-h-0 flex-col overflow-hidden', className)}>
      <div role="tablist" aria-label="Events and bookmarks" className="flex shrink-0 border-b border-line px-2">
        <TabButton id="events" tab={tab} onSelect={setTab}>Events</TabButton>
        <TabButton id="bookmarks" tab={tab} onSelect={setTab} count={bookmarks.length}>Bookmarks</TabButton>
      </div>

      {tab === 'events' ? (
        <>
          <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 transition focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
              <Search className="h-4 w-4 shrink-0 text-fg-subtle" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
                placeholder="Search events…"
                aria-label="Search events"
                className="min-w-0 flex-1 bg-transparent text-small text-fg outline-none placeholder:text-fg-subtle [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="text-fg-subtle transition hover:text-fg">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-small font-semibold transition',
                    hiddenCount
                      ? 'border-brand/50 bg-brand-soft text-brand-ink'
                      : 'border-line bg-surface text-fg-secondary hover:bg-surface-sunken',
                  )}
                >
                  <ListFilter className="h-3.5 w-3.5" />
                  Filter{hiddenCount ? ` · ${EVENT_CATEGORIES.length - hiddenCount}` : ''}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 border-line bg-surface">
                <DropdownMenuLabel className="text-caption font-semibold uppercase tracking-wide text-fg-muted">
                  Show events
                </DropdownMenuLabel>
                {EVENT_CATEGORIES.map((id) => {
                  const layer = layerOf(id);
                  const Icon = layer.Icon;
                  return (
                    <DropdownMenuCheckboxItem
                      key={id}
                      checked={!hidden.has(id)}
                      onCheckedChange={() => onToggleCategory(id)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      <Icon className={cn('h-3.5 w-3.5', toneClass(layer.tone, 'icon'))} />
                      <span className="text-small">{layer.label}</span>
                      <span className="ml-auto text-caption tabular-nums text-fg-muted">{counts[id] || 0}</span>
                    </DropdownMenuCheckboxItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!hiddenCount} onSelect={onShowAll}>
                  <span className="text-small">Show all</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <h2 className="shrink-0 px-4 pb-1.5 pt-3 text-small font-semibold text-fg">
            Events <span className="font-medium tabular-nums text-fg-muted">({loading ? '…' : countLabel})</span>
          </h2>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {unavailable ? (
              <Placed><Empty icon={Video} title="AI events aren't available" body={unavailable} /></Placed>
            ) : loading ? (
              <RowSkeletons />
            ) : error ? (
              <Placed>
                <Empty
                  icon={AlertTriangle}
                  title="Couldn't load events"
                  body={error}
                  action={<TextButton onClick={() => onRetry()}>Try again</TextButton>}
                />
              </Placed>
            ) : events.length === 0 ? (
              <Placed>
                <Empty icon={Video} title="No events in this time range" body="Try selecting a different date, camera, or time range." />
              </Placed>
            ) : byCategory.length === 0 ? (
              <Placed><Empty icon={ListFilter} title="Every event type is hidden" action={<TextButton onClick={onShowAll}>Show all</TextButton>} /></Placed>
            ) : visible.length === 0 ? (
              <Placed>
                <Empty
                  icon={Search}
                  title="No matching events"
                  body={`Nothing loaded in this range matches "${query.trim()}".`}
                  action={<TextButton onClick={() => setQuery('')}>Clear search</TextButton>}
                />
              </Placed>
            ) : (
              <ul className="space-y-0.5">
                {rows.map((e) => (
                  <EventRow
                    key={e.id}
                    event={e}
                    active={e.id === activeId}
                    cameraName={cameraName}
                    onPlay={onPlay}
                    onExportAround={onExportAround}
                    onBookmarkEvent={onBookmarkEvent}
                  />
                ))}
              </ul>
            )}

            {!loading && !error && visible.length > 0 && hasMore ? (
              <button
                type="button"
                onClick={loadMore}
                disabled={fetchingMore}
                className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-60"
              >
                {fetchingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Load more
              </button>
            ) : null}
            {!loading && !error && capped && !hasMore ? (
              <p className="px-3 pt-2 text-center text-caption text-fg-subtle">
                Showing the first {events.length} of {total} events. Narrow the time range to see the rest.
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <BookmarkList
          bookmarks={bookmarks}
          onJump={onJumpBookmark}
          onDelete={onDeleteBookmark}
          onRename={onRenameBookmark}
        />
      )}
    </PageCard>
  );
}

export default memo(EventsPanel);

function TabButton({ id, tab, onSelect, count, children }) {
  const selected = id === tab;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => onSelect(id)}
      className={cn(
        '-mb-px flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2.5 text-small font-semibold transition',
        selected ? 'border-brand text-fg' : 'border-transparent text-fg-muted hover:text-fg',
      )}
    >
      {children}
      {count ? <span className="rounded-full bg-surface-muted px-1.5 text-caption tabular-nums text-fg-muted">{count}</span> : null}
    </button>
  );
}

function EventRow({ event, active, cameraName, onPlay, onExportAround, onBookmarkEvent }) {
  const layer = layerOf(event.category);
  const Icon = layer.Icon;
  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-1 rounded-lg px-1.5 py-1 transition',
          active ? 'bg-brand-soft ring-1 ring-brand-line' : 'hover:bg-surface-sunken',
        )}
      >
        <button
          type="button"
          onClick={() => onPlay(event)}
          title={`Play from ${fmtTimeLong(event.t)}`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          <EventThumb event={event.raw} layer={layer} />
          <span className="min-w-0 flex-1">
            <span className="block text-small font-semibold tabular-nums text-fg">{fmtTimeLong(event.t)}</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-small text-fg-secondary">
              <Icon className={cn('h-3.5 w-3.5 shrink-0', toneClass(layer.tone, 'icon'))} strokeWidth={2.25} />
              <span className="truncate">{event.title}</span>
            </span>
            <span className="mt-0.5 block truncate text-caption text-fg-muted">
              {event.who ? `${event.who} · ${cameraName}` : cameraName}
            </span>
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Event actions"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-muted hover:text-fg"
            >
              <EllipsisVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 border-line bg-surface">
            <DropdownMenuItem onSelect={() => onPlay(event)}>
              <Play className="text-fg-muted" /> <span className="text-small">Play from here</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onExportAround(event)}>
              <Scissors className="text-fg-muted" /> <span className="text-small">Export clip around this</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onBookmarkEvent(event)}>
              <Bookmark className="text-fg-muted" /> <span className="text-small">Bookmark this moment</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

/**
 * The event's snapshot. Face events carry an s3:// crop that streams through
 * the byte relay; our own ai_events rows need a signed URL first. Anything
 * without a snapshot shows its layer icon.
 */
function EventThumb({ event, layer }) {
  const direct = aiService.snapshotSrc(event?.snapshot_uri || event?.snapshotUri);
  const needsSigned = !direct && Boolean(event?.snapshotKey) && event?.id != null;
  const [signed, setSigned] = useState(null);   // url, or false when there is none
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!needsSigned) return undefined;
    let live = true;
    aiService.getSnapshotUrl(event.id)
      .then((r) => { if (live) setSigned(r?.url || false); })
      .catch(() => { if (live) setSigned(false); });
    return () => { live = false; };
  }, [needsSigned, event?.id]);

  const src = direct || signed || null;
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-12 w-18 shrink-0 rounded-md bg-surface-muted object-cover"
      />
    );
  }
  if (needsSigned && signed === null) return <span className="h-12 w-18 shrink-0 animate-pulse rounded-md bg-surface-muted" />;
  const Icon = layer.Icon;
  return (
    <span className={cn('grid h-12 w-18 shrink-0 place-items-center rounded-md', toneClass(layer.tone, 'soft'))}>
      <Icon className={cn('h-5 w-5', toneClass(layer.tone, 'icon'))} />
    </span>
  );
}

function BookmarkList({ bookmarks, onJump, onDelete, onRename }) {
  const [editing, setEditing] = useState(null);   // { id, note }
  const newestFirst = [...bookmarks].sort((a, b) => b.t - a.t);

  if (!newestFirst.length) {
    return (
      <Empty
        icon={Bookmark}
        title="No bookmarks yet"
        body="Press B, or the bookmark button on the player, to mark a moment. Bookmarks are kept in this browser."
      />
    );
  }

  const save = () => {
    if (editing) onRename(editing.id, editing.note.trim());
    setEditing(null);
  };

  return (
    <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
      {newestFirst.map((b) => (
        <li key={b.id} className="flex items-center gap-2 rounded-lg p-2 transition hover:bg-surface-sunken">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning">
            <Bookmark className="h-4 w-4" fill="currentColor" />
          </span>
          {editing?.id === b.id ? (
            <input
              autoFocus
              value={editing.note}
              maxLength={80}
              placeholder="Add a note"
              onChange={(e) => setEditing({ ...editing, note: e.target.value })}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setEditing(null);
              }}
              className="h-9 min-w-0 flex-1 rounded-md border border-brand bg-surface px-2 text-small text-fg outline-none"
            />
          ) : (
            <button type="button" onClick={() => onJump(b)} title="Play from this bookmark" className="min-w-0 flex-1 text-left">
              <span className="block text-small font-semibold tabular-nums text-fg">{fmtTimeLong(b.t)}</span>
              <span className="block truncate text-caption text-fg-muted">{b.note || 'Bookmark'} · {fmtDate(b.t)}</span>
            </button>
          )}
          <IconButton label="Rename bookmark" onClick={() => setEditing({ id: b.id, note: b.note || '' })}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Delete bookmark" onClick={() => onDelete(b.id)} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

function IconButton({ label, onClick, danger, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-muted transition hover:bg-surface-muted',
        danger ? 'hover:text-danger-ink' : 'hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function TextButton({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} className="text-small font-semibold text-brand-ink hover:underline">
      {children}
    </button>
  );
}

/**
 * Sits an empty state about a quarter of the way down the list area, rather
 * than centred in the whole panel.
 */
function Placed({ children }) {
  return (
    <div className="flex min-h-full flex-col">
      <span aria-hidden className="min-h-4 flex-1" />
      {children}
      <span aria-hidden className="flex-[2.5]" />
    </div>
  );
}

function Empty({ icon, title, body, action }) {
  const Icon = icon;
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-6 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-muted text-fg-subtle">
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-body font-semibold text-fg">{title}</p>
      {body ? <p className="text-small text-fg-muted">{body}</p> : null}
      {action}
    </div>
  );
}

function RowSkeletons() {
  return (
    <div className="space-y-1">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 px-1.5 py-1">
          <span className="h-12 w-18 shrink-0 animate-pulse rounded-md bg-surface-muted" />
          <span className="flex-1 space-y-1.5">
            <span className="block h-3 w-2/5 animate-pulse rounded bg-surface-muted" />
            <span className="block h-3 w-3/5 animate-pulse rounded bg-surface-muted" />
            <span className="block h-2.5 w-1/3 animate-pulse rounded bg-surface-muted" />
          </span>
        </div>
      ))}
    </div>
  );
}
