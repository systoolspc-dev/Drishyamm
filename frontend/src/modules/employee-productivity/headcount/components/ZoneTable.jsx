import { useMemo, useState } from 'react';
import { Camera, RefreshCw, Search, X, UserRound } from 'lucide-react';
import { ZoneIcon } from './bits';
import { STATUS_HEX, STATUS_RANK, formatDwell } from '../headcount-data';
import { cameraLabel } from '../../dashboard/cameraStreams';
import { HoverText, MetaHover } from '../../MetaHover';

// ─────────────────────────────────────────────────────────────────────────────
// Live Zone Occupancy — one row per zone, worst status first.
//
// Rows are always per zone (no "group by": for a live view the zone IS the
// unit an operator acts on). The section / type / status / dwell filters are
// owned by the page (they scope the KPIs too) and arrive as `filters` (the
// Filters popover button), already applied to `zones`; the table owns only the quick search and the sort.
//
// Time context is "now", stated rather than picked: a Live Updates indicator
// with the age of the snapshot and a Refresh. Date ranges live on the
// Historical Analytics tab.
//
// RESPONSIVE
//   md and up — a real table. The component fills its parent (`h-full`) and
//     the table body scrolls under a sticky header, so on the page's
//     viewport-locked lg layout the table takes exactly the space left.
//   below md — the same rows as stacked cards (every field stays readable,
//     nothing scrolls sideways), with a sort picker standing in for the
//     column headers.
//   Touch targets (camera, refresh, search) are 44px below lg.
//
// CELLS say one thing each; the rest is one hover away (MetaHover). Zone = the
// name, with zone id / type / area / cameras / capacity on hover; Occupancy =
// "12 / 10" and a bar, with the percentage and overflow on hover; Dwell = the
// typical stay, with the longest stay and alert rule on hover; Status = one
// badge; the action column = one camera button naming its camera.
//
// DENSITY. The card has ONE header row — title, every filter, live state,
// refresh — then the column headers, then rows. Scrolling is the native scroll of the
// table body (thin scrollbar, no arrow buttons, no pager); the column headers
// stay pinned while it moves. Headers still sort on click; the sorted column is
// marked by colour and aria-sort, not by arrow glyphs on every column.
// ─────────────────────────────────────────────────────────────────────────────

const SORTS = {
  name:   (a, b) => a.label.localeCompare(b.label),
  status: (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (b.utilization ?? -1) - (a.utilization ?? -1),
  // Line zones have no capacity, so they sort after every region zone.
  occupancy: (a, b) => (a.utilization ?? -1) - (b.utilization ?? -1),
  dwell: (a, b) => (a.avgDwellSec ?? -1) - (b.avgDwellSec ?? -1),
  // Share of required posts filled; zones with no post sort after all others.
  staff: (a, b) => staffShare(a) - staffShare(b),
};

const staffShare = (z) => (z.staffRequired ? z.staffOnPost / z.staffRequired : 2);

// The card view's stand-in for clickable headers.
const SORT_OPTIONS = [
  { value: 'status:asc',     label: 'Status — worst first' },
  { value: 'occupancy:desc', label: 'Occupancy — fullest first' },
  { value: 'dwell:desc',     label: 'Dwell — longest first' },
  { value: 'staff:asc',      label: 'Staff — least covered first' },
  { value: 'name:asc',       label: 'Name — A to Z' },
];

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// Region zones compare a count to a capacity; the dwell rule is a queue rule
// (params.dwellAlertSec) — a long stay in a meeting room is the point of it.
const isOver = (z) => z.mode === 'region' && z.count > z.capacity;
const isDwellHot = (z, dwellAlertSec) => z.kind === 'queue' && z.avgDwellSec != null && z.avgDwellSec > dwellAlertSec;

const touchBtn = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-line text-fg-secondary transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-7 lg:w-7';

export default function ZoneTable({ title, icon: TitleIcon, filters, zones, loading, lastUpdated, now, onRefresh, onPreview, dwellAlertSec }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'status', dir: 'asc' });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q
      ? zones.filter((z) => [z.label, z.id, z.typeLabel, ...(z.cameraIds || [])].some((v) => String(v).toLowerCase().includes(q)))
      : zones;
    const cmp = SORTS[sort.key];
    return hits.slice().sort((a, b) => (sort.dir === 'asc' ? cmp(a, b) : cmp(b, a)));
  }, [zones, query, sort]);

  const toggleSort = (key) => setSort((s) => (
    s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'status' ? 'asc' : 'desc' }
  ));

  const empty = query ? <>No zone matches “{query}”.</> : 'No zones match these filters.';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — the card's ONLY control row. Left: title, then every filter
          inline (search, then the `filters` slot — the Filters popover button).
          Right: live state + refresh. One line on wide screens;
          below md the controls wrap under the title. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 lg:gap-1.5 xl:gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {TitleIcon && <TitleIcon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />}
            <h2 className="whitespace-nowrap text-sm font-semibold text-fg sm:text-base">{title}</h2>
            <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-caption font-bold tabular-nums text-fg-muted">{rows.length}</span>
          </div>
          <span className="hidden h-4 w-px bg-line lg:block" aria-hidden />

          <div className="relative w-full sm:w-44 lg:w-40 xl:w-44">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search zones…"
              title="Search by zone name, ID or camera"
              aria-label="Search zones"
              className="h-11 w-full rounded-lg border border-line bg-surface pl-8 pr-9 text-[12px] text-fg-secondary outline-none focus:border-brand lg:h-8"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-0 top-0 flex h-full w-9 items-center justify-center text-fg-subtle hover:text-fg-secondary">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {filters}

          {/* Sort — cards have no column headers to click */}
          <select
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSort({ key, dir }); }}
            aria-label="Sort zones"
            className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[12px] text-fg-secondary outline-none focus:border-brand md:hidden"
          >
            {!SORT_OPTIONS.some((o) => o.value === `${sort.key}:${sort.dir}`) && <option value={`${sort.key}:${sort.dir}`}>Custom sort</option>}
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-semibold text-success-ink"
            aria-live="polite"
            title={loading ? 'Updating…' : `Last updated ${ago(now - lastUpdated)}`}
          >
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Live updates
            <span className="hidden font-medium tabular-nums text-fg-subtle 2xl:inline">· {loading ? 'updating…' : ago(now - lastUpdated)}</span>
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh"
            title="Refresh now"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink disabled:opacity-60 lg:h-8 lg:w-8"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── Cards · below md ─────────────────────────────────────────── */}
      <ul className="divide-y divide-line-subtle md:hidden">
        {loading ? (
          [0, 1, 2, 3].map((i) => <li key={i} className="animate-pulse px-3 py-3"><div className="h-16 rounded bg-surface-muted" /></li>)
        ) : rows.length === 0 ? (
          <li className="px-4 py-10 text-center text-[12px] text-fg-subtle">{empty}</li>
        ) : rows.map((z) => (
          <ZoneCard key={z.id} zone={z} dwellAlertSec={dwellAlertSec} onPreview={onPreview} />
        ))}
      </ul>

      {/* ── Table · md and up ─────────────────────────────────────────
          The wrapper is the scroll box in both axes, which is what lets the
          header stick: `sticky top-0` pins to the nearest scrolling ancestor. */}
      <div className="scrollbar-thin hidden min-h-0 flex-1 overflow-auto md:block">
        <table className="w-full min-w-[44rem] table-fixed border-collapse text-sm">
          {/* Fixed column widths: the grid holds still as rows filter in and
              out, and every value lines up under its label. */}
          <colgroup>
            <col className="w-[32%]" />
            <col className="w-[17%]" />
            <col className="w-[19%]" />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
            <col className="w-14" />
          </colgroup>
          <thead>
            <tr className="text-left">
              <Th sortKey="name" sort={sort} onSort={toggleSort}>Zone</Th>
              <Th sortKey="staff" sort={sort} onSort={toggleSort} hint="Staff detected on post against the posts this zone needs">Staff on post</Th>
              <Th sortKey="occupancy" sort={sort} onSort={toggleSort} hint="People inside now against the zone's capacity">Occupancy</Th>
              <Th sortKey="dwell" sort={sort} onSort={toggleSort} hint="Typical stay of the people inside now; hover a value for the longest current stay">Dwell time</Th>
              <Th sortKey="status" sort={sort} onSort={toggleSort}>Status</Th>
              <th className={thCls}><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {loading ? (
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} className="animate-pulse">
                  <td colSpan={6} className="px-4 py-3"><div className="h-6 rounded bg-surface-muted" /></td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-fg-subtle">{empty}</td></tr>
            ) : rows.map((z) => (
              <ZoneRow key={z.id} zone={z} dwellAlertSec={dwellAlertSec} onPreview={onPreview} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Header band: a tinted, sticky row framed by hairlines top and bottom, so it
// reads as the table's frame rather than a line of loose words. The lines are
// inset shadows, not borders: with border-collapse a border stays on the row
// and scrolls away from a sticky cell.
const thCls = 'sticky top-0 z-10 bg-card px-3.5 py-2.5 align-middle shadow-[inset_0_-1px_0_var(--line)]';
const labelCls = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground';
const tdCls = 'px-3.5 py-2.5';

// Sortable header: the label is a quiet pill that fills on hover; the sorted
// column's pill stays filled in brand tint — a clear marker without arrows.
function Th({ sortKey, sort, onSort, hint, className = '', children }) {
  const active = sort.key === sortKey;
  const dir = sort.dir === 'asc' ? 'ascending' : 'descending';
  return (
    <th className={`${thCls} ${className}`} aria-sort={active ? dir : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={[hint, active ? `Sorted ${dir} — click to reverse` : 'Click to sort'].filter(Boolean).join('. ')}
        className={`-mx-1.5 rounded-md px-1.5 py-0.5 transition ${labelCls} ${active ? 'bg-brand-soft !text-brand-ink' : 'hover:bg-surface-muted hover:text-fg-secondary'}`}
      >
        {children}
      </button>
    </th>
  );
}

// Dwell time: the typical stay of the people inside now. Queue-type zones
// past params.dwellAlertSec turn amber; the rule and the longest stay hover.
function Dwell({ zone: z, hot, dwellAlertSec }) {
  if (z.avgDwellSec == null) return <span className="text-fg-disabled">—</span>;
  return (
    <MetaHover
      title="Dwell time"
      rows={[
        ['Typical stay', formatDwell(z.avgDwellSec)],
        ['Longest now', z.maxDwellSec != null ? formatDwell(z.maxDwellSec) : null],
        ['Alert after', z.kind === 'queue' && dwellAlertSec ? `${formatDwell(dwellAlertSec)} (queue zones)` : null],
      ]}
    >
      <HoverText className={`text-sm tabular-nums ${hot ? 'font-semibold text-warning-ink' : 'text-foreground'}`}>
        {formatDwell(z.avgDwellSec)}
      </HoverText>
    </MetaHover>
  );
}

const camerasText = (z) => (z.cameraIds?.length ? z.cameraIds.map(cameraLabel).join(', ') : null);

// The name only; everything that identifies the zone is on hover.
function ZoneName({ zone: z }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand" aria-hidden>
        <ZoneIcon kind={z.kind} />
      </span>
      <MetaHover
        title={z.label}
        rows={[
          ['Zone ID', String(z.id).toUpperCase()],
          ['Type', z.typeLabel],
          ['Area', z.area],
          [z.cameraIds?.length > 1 ? 'Cameras' : 'Camera', camerasText(z)],
          ['Capacity', z.mode === 'region' ? `${z.capacity}` : 'Doorway — counts in / out'],
          ['Minimum', z.minOccupancy ? `${z.minOccupancy} on site` : null],
        ]}
      >
        <HoverText className="block min-w-0 truncate text-sm font-semibold text-foreground">{z.label}</HoverText>
      </MetaHover>
    </div>
  );
}

// One badge per zone. Sentence case, bordered, the app's status tokens (so it
// follows light/dark with every other badge on the page).
const STATUS_BADGE = {
  ok:    { cls: 'border-success-line bg-success-soft text-success-ink', label: 'Normal' },
  busy:  { cls: 'border-warning-line bg-warning-soft text-warning-ink', label: 'Nearing Limit' },
  over:  { cls: 'border-danger-line bg-danger-soft text-danger-ink',    label: 'Over Capacity' },
  under: { cls: 'border-danger-line bg-danger-soft text-danger-ink',    label: 'Below Minimum' },
  empty: { cls: 'border-line bg-surface-muted text-muted-foreground',   label: 'Empty' },
  flow:  { cls: 'border-line bg-surface-muted text-muted-foreground',   label: 'Counting' },
};

function StatusBadge({ status }) {
  const b = STATUS_BADGE[status] || STATUS_BADGE.empty;
  return (
    <span className={`inline-flex shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${b.cls}`}>
      {b.label}
    </span>
  );
}

// "12 / 10" and a bar. The ratio already says how full; the bar says it at a
// glance; a percentage or "+2" beside them would be the same fact a third time.
// A doorway (line zone) has no capacity — it shows who is inside, with the
// in / out counts on hover.
function Occupancy({ zone: z }) {
  if (z.mode === 'line') {
    return (
      <MetaHover
        title="Doorway count"
        rows={[['Inside', z.inside.toLocaleString('en-IN')], ['In today', z.in.toLocaleString('en-IN')], ['Out today', z.out.toLocaleString('en-IN')]]}
        note="A doorway has no capacity — it counts people passing through."
      >
        <HoverText className="text-sm tabular-nums text-foreground">
          {z.inside.toLocaleString('en-IN')} <span className="text-xs text-muted-foreground">inside</span>
        </HoverText>
      </MetaHover>
    );
  }
  const over = isOver(z);
  return (
    <div className="flex items-center gap-2.5">
      <MetaHover
        title="Occupancy"
        rows={[
          ['Inside now', z.count],
          ['Capacity', z.capacity],
          ['Utilization', `${z.utilization}%`],
          ['Over by', over ? `${z.count - z.capacity}` : null],
          ['Minimum', z.minOccupancy ? `${z.minOccupancy}${z.status === 'under' ? ' — below it now' : ''}` : null],
          ['Identified', z.identified != null ? `${z.identified} of ${z.count}` : null],
        ]}
      >
        <HoverText className={`w-14 shrink-0 text-sm font-semibold tabular-nums ${over ? 'text-danger-ink' : 'text-foreground'}`}>
          {z.count}<span className="font-normal text-muted-foreground"> / {z.capacity}</span>
        </HoverText>
      </MetaHover>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, z.utilization)}%`, background: STATUS_HEX[z.status] }} />
      </div>
    </div>
  );
}

// Staff on post: filled posts against required, as a status chip. Line zones
// (doorways) and unstaffed spaces have no post, and say so quietly.
function StaffOnPost({ zone: z }) {
  if (z.mode === 'line' || !z.staffRequired) return <span className="text-small text-fg-disabled">No post</span>;
  const tone = z.staffOnPost === 0
    ? { cls: 'bg-danger-soft text-danger-ink ring-danger-line', text: 'Unattended' }
    : z.staffOnPost < z.staffRequired
      ? { cls: 'bg-warning-soft text-warning-ink ring-warning-line', text: 'Short' }
      : { cls: 'bg-success-soft text-success-ink ring-success-line', text: 'Covered' };
  return (
    <MetaHover
      title="Staff on post"
      rows={[['On post', z.staffOnPost], ['Posts needed', z.staffRequired]]}
      note="Staff detected in the zone by the staff-detection feed."
    >
      <span tabIndex={0} className={`inline-flex cursor-help items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 outline-none focus-visible:ring-2 ${tone.cls}`}>
        <UserRound className="h-3 w-3" aria-hidden />
        <span className="tabular-nums">{z.staffOnPost}/{z.staffRequired}</span> {tone.text}
      </span>
    </MetaHover>
  );
}

function PreviewButton({ zone: z, onPreview }) {
  if (!z.cameraIds?.length) return null;
  const cam = cameraLabel(z.cameraIds[0]);
  return (
    <MetaHover side="left" align="center" note={`View live feed (${cam})`}>
      <button
        type="button"
        onClick={() => onPreview(z)}
        aria-label={`View live feed — ${z.label}, ${cam}`}
        className={touchBtn}
      >
        <Camera className="h-3.5 w-3.5" />
      </button>
    </MetaHover>
  );
}

function ZoneRow({ zone: z, dwellAlertSec, onPreview }) {
  return (
    <tr className="transition hover:bg-surface-sunken">
      <td className={`${tdCls} max-w-[18rem]`}><ZoneName zone={z} /></td>
      <td className={tdCls}><StaffOnPost zone={z} /></td>
      <td className={tdCls}><Occupancy zone={z} /></td>
      <td className={tdCls}><Dwell zone={z} hot={isDwellHot(z, dwellAlertSec)} dwellAlertSec={dwellAlertSec} /></td>
      <td className={tdCls}><StatusBadge status={z.status} /></td>
      <td className={`${tdCls} text-right`}><PreviewButton zone={z} onPreview={onPreview} /></td>
    </tr>
  );
}

// Same fields as the row, re-flowed for a phone: name + status, then the
// numbers, then type — and the camera button as a full 44px target.
function ZoneCard({ zone: z, dwellAlertSec, onPreview }) {
  return (
    <li className="flex items-start gap-2 px-3 py-3">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <ZoneName zone={z} />
          <StatusBadge status={z.status} />
        </div>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-1.5 pl-[2.375rem] text-[12px]">
          <Occupancy zone={z} />
          <div>
            <p className="text-[9.5px] font-bold uppercase tracking-wide text-fg-subtle">Dwell time</p>
            <Dwell zone={z} hot={isDwellHot(z, dwellAlertSec)} dwellAlertSec={dwellAlertSec} />
          </div>
          <div>
            <p className="text-[9.5px] font-bold uppercase tracking-wide text-fg-subtle">Staff on post</p>
            <StaffOnPost zone={z} />
          </div>
        </div>
      </div>
      <PreviewButton zone={z} onPreview={onPreview} />
    </li>
  );
}
