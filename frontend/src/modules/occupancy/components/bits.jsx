/**
 * The visual language of /occupancy. Components only — the maths lives in
 * `occupancy-data.js` so Fast Refresh stays happy and the derivations stay
 * testable without a DOM.
 *
 * Everything here is built from design tokens. The brief named literal hues
 * (slate surfaces, amber accents, an emerald/amber/rose capacity ramp); those
 * are the ROLES `--surface`/`--line`, `--brand`, and `--success`/`--warning`/
 * `--danger` already carry, and going through the tokens is what makes the page
 * follow the theme instead of staying one palette in both modes.
 */
import { useState } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpRight, DoorOpen, Gauge, Info, Lock,
  MapPin, Search, Settings2, TriangleAlert, Users,
} from 'lucide-react';
import { Button } from '@/core/ui/button';
import { CameraEmptyState } from '@/core/components/CameraEmptyState';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { STATUS_CHIP, STATUS_LABEL, capacityBarClass, nfmt } from '../occupancy-data';
import { describeLine, inSidePolygon, lineMarkers } from '../gate-model';

export function StatusChip({ status, label }) {
  return (
    <span className={`inline-block shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[status] || STATUS_CHIP.idle}`}>
      {label || STATUS_LABEL[status] || status}
    </span>
  );
}

// ── Macro overview ──────────────────────────────────────────────────────────

const TILE_ICON = {
  live: Users, footfall: ArrowUpRight, breaches: TriangleAlert, busiest: MapPin,
};

/**
 * The four numbers that answer "is the building OK" without scrolling.
 *
 * `tone` recolours only the value, never the card. A wall of red cards reads as
 * a broken page; one red number inside an otherwise calm row reads as one thing
 * being wrong, which is what it is.
 */
export function MetricBar({ tiles }) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {tiles.map((t) => {
        const Icon = TILE_ICON[t.key] || Users;
        const tone = t.tone === 'crit' ? 'text-danger-ink' : t.tone === 'warn' ? 'text-warning-ink' : 'text-fg';
        const badge = t.tone === 'crit' ? 'bg-danger-soft text-danger-ink'
          : t.tone === 'warn' ? 'bg-warning-soft text-warning-ink'
            : 'bg-brand-soft text-brand';
        const card = (
          <div className="relative h-full overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-sm">
            {/* Icon and title share the top row, aligned to the top: a title
                that wraps to two lines on a narrow tile grows downward and the
                icon stays level with its first line. */}
            <div className="flex items-start gap-2">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${badge}`}>
                <Icon className="h-4 w-4" strokeWidth={2} />
              </span>
              <p className="min-w-0 flex-1 pt-[5px] text-[11.5px] font-medium leading-[1.3] text-fg-muted line-clamp-2">{t.label}</p>
              {t.pill ? (
                <span className="mt-0.5 shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-micro font-bold text-fg-muted">{t.pill}</span>
              ) : null}
            </div>
            <p className={`mt-3 truncate text-[20px] font-extrabold leading-none tracking-tight tabular-nums ${tone}`}>{t.value}</p>
            {t.sub ? <p className="mt-1.5 truncate text-[10.5px] text-fg-subtle">{t.sub}</p> : null}
            {/* Along the bottom edge rather than under the text, so a tile
                with a gauge is the same height as the tiles without one. */}
            {t.bar != null ? (
              <div className="absolute inset-x-0 bottom-0 h-1 bg-surface-muted">
                <div className="h-full transition-[width]" style={{ width: `${Math.min(100, t.bar)}%`, background: t.barColor || 'var(--brand)' }} />
              </div>
            ) : null}
          </div>
        );
        if (!t.tip) return <div className="h-full" key={t.key}>{card}</div>;
        return (
          <Tooltip key={t.key}>
            <TooltipTrigger asChild><div className="h-full">{card}</div></TooltipTrigger>
            <TooltipContent className="max-w-[20rem] text-[10.5px] leading-relaxed" side="top" variant="card">
              {t.tip}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── Congestion ────────────────────────────────────────────────
// CongestionBanner used to live here: one stacked alert on the live wall,
// listing the spaces needing attention with the worst severity setting its
// tone. It was removed rather than restyled. The `congestion` array it read
// is the same array `buildMacro` counts into the Overcrowded Zones and
// Congestion alerts tiles, and every space it named already appears as a row
// in the zone table with its own status chip -- so it was the third telling
// of one reading, taking a banner's height on quiet days as well as busy
// ones. What went with it was the RANKING (worst first) and the click that
// jumped to a space; if either is missed, sort the zone table by utilisation
// rather than bringing the banner back.

// ── Zone cards ──────────────────────────────────────────────────────────────

/**
 * Every gate as one row. IN, OUT and the net still inside read down a column,
 * so the gate doing all the work — or counting one direction only — stands out
 * without comparing numbers across separate cards. No capacity bar: a doorway
 * has no capacity, and a bar against an invented denominator would be the most
 * confident-looking wrong number on the page. The share bar is each gate's
 * slice of today's traffic, which is a denominator that actually exists.
 */
export function GateActivityMatrix({ zones, onConfigure }) {
  const total = zones.reduce((n, z) => n + z.in + z.out, 0);
  const sum = zones.reduce((acc, z) => ({ in: acc.in + z.in, out: acc.out + z.out, inside: acc.inside + z.inside }), { in: 0, out: 0, inside: 0 });
  const th = 'px-3 py-2 text-[9.5px] font-bold uppercase tracking-wide text-fg-subtle';
  const num = 'px-3 py-2 text-right text-[13px] font-bold tabular-nums';
  return (
    <div className="overflow-x-auto rounded-xl border border-line xl:min-h-0 xl:flex-1 xl:overflow-auto">
      <table className="w-full min-w-[440px] border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-surface-sunken">
          <tr>
            <th className={th} scope="col">Gate</th>
            <th className={`${th} text-right`} scope="col">
              <span className="inline-flex items-center gap-1"><ArrowUp className="h-3 w-3 text-success-ink" strokeWidth={2.75} />In</span>
            </th>
            <th className={`${th} text-right`} scope="col">
              <span className="inline-flex items-center gap-1"><ArrowDown className="h-3 w-3 text-fg-secondary" strokeWidth={2.75} />Out</span>
            </th>
            <th className={`${th} text-right`} scope="col">Net inside</th>
            <th className={`${th} w-[22%]`} scope="col">Share of traffic</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line bg-surface">
          {zones.map((z) => {
            const share = total > 0 ? Math.round(((z.in + z.out) / total) * 100) : 0;
            return (
              <tr key={z.id} className="transition hover:bg-surface-sunken/60">
                {/* Names wrap: camera names tend to differ only at the end, so
                    an ellipsis hides the part that tells two gates apart. */}
                <td className="min-w-[14rem] px-3 py-2">
                  <p className="flex items-start gap-1.5 text-[12px] font-bold leading-snug text-fg">
                    <DoorOpen className="mt-px h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2} />
                    <span className="min-w-0 break-words">{z.label}</span>
                    {onConfigure && z.monitorId ? (
                      <button
                        aria-label={`Set up gate ${z.label}`}
                        className="ml-auto shrink-0 rounded-md border border-line p-1 text-fg-subtle transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        onClick={() => onConfigure(z.monitorId)}
                        title="Move the line or change direction in Zone Setup"
                        type="button"
                      >
                        <Settings2 className="h-3 w-3" strokeWidth={2.25} />
                      </button>
                    ) : null}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 break-words pl-5 text-[10px] text-fg-subtle">
                    <GateGlyph className="h-[11px] w-5 shrink-0 text-fg-subtle" direction={z.direction} line={z.line} />
                    <span className="min-w-0">{z.area} · {describeLine(z.line)} · arrow side is IN</span>
                  </p>
                </td>
                <td className={`${num} text-success-ink`}>
                  <span className="inline-flex items-center gap-1"><ArrowUp className="h-3 w-3" strokeWidth={2.75} />{nfmt(z.in)}</span>
                </td>
                <td className={`${num} text-fg-secondary`}>
                  <span className="inline-flex items-center gap-1"><ArrowDown className="h-3 w-3" strokeWidth={2.75} />{nfmt(z.out)}</span>
                </td>
                <td className={`${num} text-brand-ink`}>{nfmt(z.inside)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted">
                      <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${share}%` }} />
                    </div>
                    <span className="w-8 shrink-0 text-right text-[10.5px] font-semibold tabular-nums text-fg-muted">{share}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
        {zones.length > 1 ? (
          <tfoot className="border-t border-line-strong bg-surface-sunken">
            <tr>
              <td className="px-3 py-2 text-[11px] font-bold text-fg-secondary">All gates</td>
              <td className={`${num} text-success-ink`}>{nfmt(sum.in)}</td>
              <td className={`${num} text-fg-secondary`}>{nfmt(sum.out)}</td>
              <td className={`${num} text-brand-ink`}>{nfmt(sum.inside)}</td>
              <td />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/**
 * A gate's line in miniature: the 16:9 picture, the line where it sits, its
 * IN side faintly shaded and an arrow into it. Lets a row say which way a
 * gate counts at a glance, where "line at 35°" alone would not.
 */
export function GateGlyph({ line, direction, className = '' }) {
  const W = 32;
  const H = 18;
  const { mid, angle } = lineMarkers(line, direction);
  const rad = (angle * Math.PI) / 180;
  const [mx, my] = [mid[0] * W, mid[1] * H];
  const [tx, ty] = [mx + Math.cos(rad) * 6, my + Math.sin(rad) * 6];
  // Arrowhead: two short strokes back from the tip, 30 degrees either side.
  const head = [rad + Math.PI * (5 / 6), rad - Math.PI * (5 / 6)]
    .map((r) => `${tx + Math.cos(r) * 2.6},${ty + Math.sin(r) * 2.6}`);
  return (
    <svg aria-hidden className={className} fill="none" viewBox={`0 0 ${W} ${H}`}>
      <rect height={H - 1} rx="2" stroke="currentColor" strokeOpacity="0.35" width={W - 1} x="0.5" y="0.5" />
      <polygon fill="currentColor" fillOpacity="0.14" points={inSidePolygon(line, direction).map(([x, y]) => `${x * W},${y * H}`).join(' ')} />
      <line stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" x1={line.a[0] * W} x2={line.b[0] * W} y1={line.a[1] * H} y2={line.b[1] * H} />
      <path
        className="text-brand"
        d={`M${mx},${my} L${tx},${ty} M${head[0]} L${tx},${ty} L${head[1]}`}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/**
 * Setup call-to-action for a panel with nothing to show yet.
 *
 * It used to draw its own card: a 16px camera glyph in a tile, two sizes of
 * grey type and one brand button. It is now the product's standard empty state
 * (`CameraEmptyState`) with this panel's words in it, so the camera
 * illustration, the type scale and the button pair are the same here as on
 * every other page that has nothing to show yet.
 *
 * Two ways forward, in the order they are needed: the nearer step this panel
 * is actually asking for (draw the zone, draw the gate line) as the primary,
 * and Camera Setup beside it -- because the other reason a panel is empty is
 * that the camera was never added, and no amount of zone drawing fixes that.
 */
export function SetupCard({ ready, title, hint, onSetup, cta = 'Configure Cameras & Zones' }) {
  if (!ready) {
    return <p className="px-6 py-10 text-center text-small font-semibold text-fg-secondary">Loading…</p>;
  }
  return (
    <CameraEmptyState
      action={(
        <Button onClick={onSetup} size="sm" type="button">
          <Settings2 strokeWidth={2.25} />
          {cta}
        </Button>
      )}
      description={hint}
      size="sm"
      title={title}
    />
  );
}

// Worst first: the rows that need someone are the rows at the top.
const STATUS_RANK = { breach: 0, full: 1, busy: 2, under: 3, ok: 4, idle: 5 };

const SORTS = {
  status: (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || b.utilization - a.utilization,
  zone: (a, b) => a.label.localeCompare(b.label),
  count: (a, b) => b.count - a.count,
  utilization: (a, b) => (b.capacity > 0 ? b.utilization : -1) - (a.capacity > 0 ? a.utilization : -1),
};

/**
 * Every counted space as one row. Replaces a card per zone: with many
 * cameras the cards became a wall to scroll, while a table keeps every zone
 * on one screen, lets counts be read down a column, and sorts the ones in
 * trouble to the top.
 *
 * Sorted by status (worst first) unless a column header says otherwise; a
 * search box appears once there are enough rows to need one. Clicking a row
 * selects it, as the card did; the gear opens the quick-edit drawer.
 */
export function ZoneHeadcountTable({ zones, selectedId, onSelect, onConfigure }) {
  const [sort, setSort] = useState('status');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = zones
    .filter((z) => !q || `${z.label} ${z.floor || ''} ${z.cameras.join(' ')}`.toLowerCase().includes(q))
    .sort(SORTS[sort]);

  const th = 'px-3 py-2 text-[9.5px] font-bold uppercase tracking-wide text-fg-subtle';
  const head = (id, label, align = '') => (
    <th aria-sort={sort === id ? (id === 'zone' ? 'ascending' : 'descending') : undefined} className={`${th} ${align}`} scope="col">
      <button
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition hover:text-fg ${sort === id ? 'text-fg-secondary' : ''}`}
        onClick={() => setSort(id)}
        type="button"
      >
        {label}
        {sort === id ? <ArrowDown className="h-2.5 w-2.5" strokeWidth={3} /> : null}
      </button>
    </th>
  );

  return (
    <div className="flex flex-col gap-2 xl:min-h-0 xl:flex-1">
      {zones.length > 6 ? (
        <label className="relative flex max-w-xs shrink-0 items-center">
          <span className="sr-only">Search zones</span>
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" strokeWidth={2.25} />
          <input
            className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-2 text-[11.5px] text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search zone, floor or camera…"
            type="search"
            value={query}
          />
        </label>
      ) : null}

      <div className="max-h-[32rem] overflow-auto rounded-xl border border-line xl:max-h-none xl:min-h-0 xl:flex-1">
        <table className="w-full min-w-[520px] border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr>
              {head('zone', 'Zone')}
              {head('status', 'Status')}
              {head('count', 'Count / max', 'text-right')}
              {head('utilization', 'Occupancy', 'w-[26%]')}
              <th className={`${th} text-right`} scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line bg-surface">
            {rows.map((z) => {
              const on = z.id === selectedId;
              const hasCap = z.capacity > 0;
              const needsCapacity = !hasCap && !z.locked;
              return (
                <tr
                  aria-selected={on}
                  className={`cursor-pointer transition ${on ? 'bg-brand-soft/60' : 'hover:bg-surface-sunken/60'}`}
                  key={z.id}
                  onClick={() => onSelect?.(z)}
                >
                  {/* Names wrap: camera names tend to differ only at the end. */}
                  <td className="min-w-[14rem] px-3 py-2">
                    <p className="flex items-start gap-1.5 text-[12px] font-bold leading-snug text-fg">
                      {z.locked
                        ? <Lock className="mt-px h-3.5 w-3.5 shrink-0 text-danger" strokeWidth={2.25} />
                        : <MapPin className="mt-px h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2} />}
                      <span className="min-w-0 break-words">{z.label}</span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1 break-words pl-5 text-[10px] leading-snug text-fg-subtle">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${z.offline ? 'bg-danger' : 'bg-success'}`} title={z.offline ? 'Camera offline' : 'Camera live'} />
                      {z.floor || 'Unassigned'}
                      {z.cameras.length && z.cameras.join(', ') !== z.label ? ` · ${z.cameras.join(', ')}` : ''}
                      {z.profile ? ` · ${z.profile}` : ''}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <StatusChip status={z.status} />
                    {z.locked ? <p className="mt-0.5 text-[10px] font-semibold text-danger-ink">Off-hours lock</p> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className="text-[14px] font-extrabold text-fg">{nfmt(z.count)}</span>
                    <span className="ml-0.5 text-[11px] font-semibold text-fg-subtle">/ {hasCap ? nfmt(z.capacity) : '—'}</span>
                  </td>
                  <td className="px-3 py-2">
                    {needsCapacity ? (
                      <button
                        className="inline-flex items-center gap-1 rounded-md border border-dashed border-brand/40 bg-brand-soft/60 px-2 py-0.5 text-[10.5px] font-semibold text-brand-ink transition hover:border-brand hover:bg-brand-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        onClick={(e) => { e.stopPropagation(); onConfigure?.(z); }}
                        type="button"
                      >
                        <Gauge className="h-3 w-3" strokeWidth={2.25} />
                        Set capacity
                      </button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div
                          aria-label={`${z.label} occupancy`}
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={hasCap ? Math.min(100, z.utilization) : 0}
                          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted"
                          role="meter"
                        >
                          {hasCap ? (
                            <div
                              className={`h-full rounded-full transition-[width] ${capacityBarClass(z.utilization)}`}
                              style={{ width: `${Math.min(100, z.utilization)}%` }}
                            />
                          ) : null}
                        </div>
                        <span className="w-9 shrink-0 text-right text-[10.5px] font-semibold tabular-nums text-fg-muted">
                          {hasCap ? `${z.utilization}%` : '—'}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      aria-label={`Configure ${z.label}`}
                      className="rounded-md border border-line p-1 text-fg-subtle transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                      onClick={(e) => { e.stopPropagation(); onConfigure?.(z); }}
                      title={`Configure ${z.label}`}
                      type="button"
                    >
                      <Settings2 className="h-3 w-3" strokeWidth={2.25} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {!rows.length ? (
              <tr>
                <td className="px-3 py-6 text-center text-[11px] text-fg-subtle" colSpan={5}>No zone matches.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Form controls ───────────────────────────────────────────────────────────
// The app has no Switch or Slider primitive yet. These two are built to the
// same anatomy as the auto-refresh switch every dashboard header already uses,
// so the settings panel does not introduce a third kind of toggle.

/** An ⓘ that holds a field's explanation, for layouts too tight for a paragraph. */
export function InfoTip({ children, label = 'More about this' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className="inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-fg-subtle transition hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          type="button"
        >
          <Info className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[18rem] text-small font-normal normal-case leading-relaxed tracking-normal" side="top" variant="card">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Label, control, and an optional hint -- under the control by default, or
 * behind an ⓘ beside the label with `hintAs="tooltip"` where height is short.
 */
export function Field({ label, hint, htmlFor, children, className = '', hintAs = 'text' }) {
  const tip = hint && hintAs === 'tooltip';
  return (
    <div className={className}>
      <span className="flex items-center gap-1">
        <label className="block text-body font-semibold text-fg-secondary" htmlFor={htmlFor}>{label}</label>
        {tip ? <InfoTip label={`About ${label}`}>{hint}</InfoTip> : null}
      </span>
      {children}
      {hint && !tip ? <p className="mt-1 text-small leading-relaxed text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

export function Toggle({ checked, onChange, label, id }) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${checked ? 'bg-brand' : 'bg-line-strong'}`}
    >
      <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}

/**
 * Range input with the value shown as a number, because "how many minutes" is a
 * question a slider alone answers vaguely. Track and thumb are tokenised
 * through `.app-range` in index.css — a native range input cannot be
 * styled from utility classes alone.
 */
export function Slider({ id, value, min, max, step = 1, onChange, format }) {
  return (
    <div className="mt-1.5 flex items-center gap-3">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="app-range h-1.5 min-w-0 flex-1"
      />
      <span className="w-20 shrink-0 rounded-md border border-line bg-surface-sunken px-2 py-1 text-center text-body font-bold tabular-nums text-fg">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

/**
 * Segmented picker for the short, mutually exclusive choices (privacy mode).
 * `compact` lays the options side by side and moves each blurb into the
 * option's tooltip.
 */
export function Segmented({ options, value, onChange, name, compact = false }) {
  if (compact) {
    return (
      <div aria-label={name} className="mt-1.5 flex gap-0.5 rounded-lg bg-surface-sunken p-0.5" role="radiogroup">
        {options.map((o) => {
          const on = o.id === value;
          return (
            <Tooltip key={o.id}>
              <TooltipTrigger asChild>
                <button
                  aria-checked={on}
                  className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-body font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                    on ? 'bg-surface text-brand-ink shadow-sm ring-1 ring-brand/40' : 'text-fg-muted hover:text-fg'
                  }`}
                  onClick={() => onChange(o.id)}
                  role="radio"
                  type="button"
                >
                  {o.label}
                </button>
              </TooltipTrigger>
              {o.blurb ? (
                <TooltipContent className="max-w-[18rem] text-small leading-relaxed" side="top" variant="card">{o.blurb}</TooltipContent>
              ) : null}
            </Tooltip>
          );
        })}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-col gap-1.5" role="radiogroup" aria-label={name}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={`rounded-lg border px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
              on ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:border-brand/40 hover:bg-surface-sunken'
            }`}
          >
            <span className={`block text-body font-bold ${on ? 'text-brand-ink' : 'text-fg-secondary'}`}>{o.label}</span>
            <span className="mt-0.5 block text-small leading-relaxed text-fg-subtle">{o.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}
