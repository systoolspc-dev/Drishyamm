import { useEffect, useMemo, useState } from 'react';
import { Clock, LayoutGrid, TrendingUp, Video, X } from 'lucide-react';
import { buildMatrix, buildPeak, buildZones } from '../headcount-data';
import { bucketEnd, shiftAt, utilizationLevel, windowFor } from '../peak-window';
import { zonePeakPreviewSource } from '../../dashboard/cameraStreams';

// ─────────────────────────────────────────────────────────────────────────────
// Peak Occupancy drill-in — opened from the Peak KPI card.
//
// One question, one answer: in this time window, when was the floor busiest,
// and which zones carried it. So the view is three parts and nothing else:
//   1. two filters  — Time Window, Zone Type
//   2. one banner   — highest occupancy · peak time · top congested zone
//   3. one table    — every zone AT that peak moment, ranked by count, with a
//                     camera button that opens the clip at that timestamp
// The table is the peak moment, not each zone's own busiest hour, so the
// banner's top zone is always row 1 and every camera opens the same instant.
//
// Numbers come from the page's own matrix builders: "Today" reads the page's
// live scope exactly, so the banner matches the KPI card; "Yesterday" reads
// that date. The modal keeps its own filters — the zone table's Filters
// popover behind it is not applied here.
// ─────────────────────────────────────────────────────────────────────────────

const SELECT = 'h-8 appearance-none rounded-lg border border-line bg-surface pl-2.5 pr-7 text-xs font-semibold text-fg-secondary transition hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30';

const LEVEL = {
  // `pct` tints the percentage on phones, where the badge is dropped for room.
  normal:   { badge: 'border-success-line bg-success-soft text-success-ink', bar: 'bg-success', pct: 'max-sm:text-success-ink' },
  nearing:  { badge: 'border-warning-line bg-warning-soft text-warning-ink', bar: 'bg-warning', pct: 'max-sm:text-warning-ink' },
  exceeded: { badge: 'border-danger-line bg-danger-soft text-danger-ink',    bar: 'bg-danger',  pct: 'max-sm:text-danger-ink' },
};

// [ ⏱ Time Window: Today ▾ ] — the label is part of the control, not a
// caption above it, so the filter row stays one line.
function Select({ label, icon: Icon, value, onChange, children, className = '' }) {
  return (
    <label className={`relative flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface pl-2.5 pr-7 text-xs transition hover:border-line-strong focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30 ${className}`}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      <span className="shrink-0 text-fg-subtle">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 appearance-none bg-transparent font-semibold text-fg-secondary focus:outline-none"
      >
        {children}
      </select>
      <svg className="pointer-events-none absolute right-2.5 h-3 w-3 text-fg-subtle" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </label>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-lg font-semibold leading-tight text-foreground tabular-nums">{value}</p>
      {sub ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function dayBefore(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
}

export default function PeakModal({ open, onClose, cfg, scope, buckets, zoneTypes, shifts, words, onPreview }) {
  const [windowId, setWindowId] = useState('today');
  const [custom, setCustom] = useState({ from: 0, to: Math.max(0, buckets.length - 1) });
  const [zoneType, setZoneType] = useState('all');

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Only types with a counted (region) zone: a line zone — an entrance gate —
  // counts flow, not occupancy, so choosing it would always show nothing.
  const regionTypes = useMemo(
    () => zoneTypes.filter((t) => (cfg?.zones || []).some((z) => z.type === t.id && z.mode === 'region')),
    [zoneTypes, cfg],
  );

  const yesterday = windowId === 'yesterday';
  const date = yesterday ? dayBefore(scope.date) : scope.date;

  const data = useMemo(() => {
    if (!open || !cfg) return null;
    // Today = the page's live scope, so these figures are the KPI card's.
    const dayScope = yesterday ? { site: scope.site, range: 'date', date, granularity: 'hour' } : scope;
    const zones = buildZones(cfg, dayScope)
      .filter((z) => z.mode === 'region' && (zoneType === 'all' || z.type === zoneType));
    const matrix = buildMatrix(zones, buckets, dayScope);
    const siteBasis = { ...cfg, peakBasis: 'site' };
    const dayPeak = buildPeak(matrix, siteBasis);
    // "Now" is the matrix's own now-bucket, so This Shift agrees with the data.
    const shift = yesterday ? null : shiftAt(shifts, buckets[matrix.nowIdx]);
    return { zones, matrix, dayPeak, shift, siteBasis };
  }, [open, cfg, scope, buckets, zoneType, shifts, yesterday, date]);

  if (!open || !data) return null;

  const { zones, matrix, dayPeak, shift, siteBasis } = data;
  const peakIdx = dayPeak?.site.atIdx ?? 0;
  const win = windowFor(windowId, { buckets, shift, peakIdx, custom });
  const peak = buildPeak(matrix, siteBasis, win || undefined);
  const site = peak?.site;
  const rows = site ? site.contributors : [];
  const top = rows[0] && rows[0].count > 0 ? rows[0] : null;
  const people = words?.people || 'people';
  const limit = cfg.breachPct || 100;
  const byId = new Map(zones.map((z) => [z.id, z]));
  const windowNote = win
    ? `${buckets[win.from]}–${bucketEnd(buckets, win.to)}${yesterday ? ' yesterday' : ''}`
    : (yesterday ? 'yesterday' : 'today');

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="peak-title"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(var(--app-vh)*0.85)] w-[760px] max-w-[calc(var(--app-vw)*0.94)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        {/* Header + the two filters */}
        <div className="shrink-0 border-b border-line p-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-brand" strokeWidth={2.5} />
            <h2 id="peak-title" className="flex-1 text-sm font-semibold text-foreground">Peak Occupancy</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="-mr-1 rounded-md p-1 text-fg-subtle hover:bg-surface-muted hover:text-fg-secondary">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select label="Time Window" icon={Clock} value={windowId} onChange={setWindowId} className="w-full sm:w-auto sm:min-w-[17rem]">
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="shift" disabled={!shift}>
                {shift ? `This Shift (${shift.start} – ${shift.end})` : 'This Shift (none running)'}
              </option>
              <option value="peak">
                {dayPeak ? `Peak Hour (${buckets[peakIdx]} – ${bucketEnd(buckets, peakIdx)})` : 'Peak Hour'}
              </option>
              <option value="custom">Custom…</option>
            </Select>
            {windowId === 'custom' && (
              <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
                <select aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ from: Number(e.target.value), to: Math.max(c.to, Number(e.target.value)) }))} className={`${SELECT} pr-2`}>
                  {buckets.map((b, i) => <option key={b} value={i}>{b}</option>)}
                </select>
                to
                <select aria-label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ from: Math.min(c.from, Number(e.target.value)), to: Number(e.target.value) }))} className={`${SELECT} pr-2`}>
                  {buckets.map((b, i) => <option key={b} value={i}>{bucketEnd(buckets, i)}</option>)}
                </select>
              </span>
            )}
            <Select label="Zone Type" icon={LayoutGrid} value={zoneType} onChange={setZoneType} className="w-full sm:ml-auto sm:w-auto sm:min-w-[14rem]">
              <option value="all">All Zones</option>
              {regionTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Select>
          </div>
        </div>

        {/* The answer */}
        <div className="shrink-0 border-b border-line bg-surface-sunken/60 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              label="Highest Occupancy"
              value={site ? `${site.value.toLocaleString('en-IN')} ${people}` : '—'}
              sub={site ? `${site.utilization}% of ${site.capacity.toLocaleString('en-IN')} capacity` : null}
            />
            <Stat label="Peak Time Recorded" value={site ? `${site.at} IST` : '—'} sub={windowNote} />
            <Stat
              label="Top Congested Zone"
              value={top ? top.label : '—'}
              sub={top ? `${top.count} ${people} · ${top.utilization}% of capacity` : 'no occupancy'}
            />
          </div>
        </div>

        {/* Ranked zones at the peak moment — the only scrolling region */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!rows.length ? (
            <p className="p-6 text-center text-xs text-muted-foreground">No counted zones match this filter.</p>
          ) : (
            // Phones: capacity folds under the count and the bar drops, so all
            // five columns fit without a sideways scroll.
            <table className="w-full border-separate border-spacing-0 text-left">
              <thead>
                <tr>
                  <th className={th}>Zone</th>
                  <th className={`${th} text-right`}>Peak Count</th>
                  <th className={`${th} hidden text-right sm:table-cell`}>Capacity</th>
                  <th className={th}>Utilization</th>
                  <th className={`${th} w-12`}><span className="sr-only">Preview</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const level = utilizationLevel(r.utilization, limit);
                  const tone = LEVEL[level.id];
                  const zone = byId.get(r.id);
                  const source = zone ? zonePeakPreviewSource(zone, date, site.at) : null;
                  return (
                    <tr key={r.id} className="transition-colors hover:bg-surface-sunken">
                      <td className={td}>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="w-5 shrink-0 text-right text-xs font-semibold tabular-nums text-fg-subtle">{i + 1}</span>
                          {/* Capped on phones: a table cell grows to its content, so
                              truncate only bites once the width is bounded. */}
                          <div className="min-w-0 max-w-[7.5rem] leading-tight sm:max-w-none">
                            <p className="truncate text-sm font-semibold text-foreground">{r.label}</p>
                            <p className="truncate text-xs text-muted-foreground">{String(r.id).toUpperCase()}{r.area ? ` · ${r.area}` : ''}</p>
                          </div>
                        </div>
                      </td>
                      <td className={`${td} text-right`}>
                        <span className="text-sm font-semibold tabular-nums text-foreground">{r.count}</span>
                        <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">{people}</span>
                        <p className="text-xs tabular-nums text-muted-foreground sm:hidden">of {r.capacity}</p>
                      </td>
                      <td className={`${td} hidden text-right text-xs tabular-nums text-muted-foreground sm:table-cell`}>{r.capacity} max</td>
                      <td className={td}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <div className="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-muted sm:block">
                            <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(2, Math.min(100, r.utilization))}%` }} />
                          </div>
                          <span title={level.label} className={`w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-fg-secondary ${tone.pct}`}>{r.utilization}%</span>
                          <span className={`hidden whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold sm:inline-flex ${tone.badge}`}>{level.label}</span>
                        </div>
                      </td>
                      <td className={`${td} text-right`}>
                        {source ? (
                          <button
                            type="button"
                            onClick={() => onPreview(source)}
                            title={`View ${source.cameraId} at ${site.at} IST`}
                            aria-label={`View ${r.label} camera at ${site.at}`}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-secondary transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                          >
                            <Video className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

const th = 'sticky top-0 z-10 border-b border-line bg-surface px-2 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-fg-muted sm:px-3.5';
const td = 'border-b border-line-subtle px-2 py-2.5 sm:px-3.5';
