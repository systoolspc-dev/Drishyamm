import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, TrendingUp, TriangleAlert, EyeOff, LayoutGrid, Download, Radio, History, ArrowRight, ChevronDown,
} from 'lucide-react';
import { useActivityParams } from '../useCaseStore';
import { useActivitySite, useActivitySites } from '../siteStore';
import { StatCards } from './components/bits';
import PeakModal from './components/PeakModal';
import ZoneTable from './components/ZoneTable';
import { ZoneFilterPopover } from './components/ZoneFilters';
import HeadcountHistory from './HeadcountHistory';
import CameraPreviewModal from '../dashboard/CameraPreviewModal';
import { zonePreviewSource } from '../dashboard/cameraStreams';
import {
  buildZones, buildBuckets, buildMatrix, buildPeak, resolveZoneTypes, STATUS_GROUP,
} from './headcount-data';
import { exportHeadcount } from './headcount-export';

const ICONS = {
  live: Users, peak: TrendingUp, over: TriangleAlert, unknown: EyeOff,
};

// Live snapshot cadence. Mock data holds still, but the clock and the poll are
// real, so the "Updated Ns ago" badge behaves exactly as it will on the API.
const POLL_MS = 30_000;
const CLOCK_MS = 5_000;

// Verticals whose historical view lives in Retail Analytics. For them this page
// is live-only and links across; every other vertical has no analytics page, so
// it keeps a Live | Historical switch here.
const ANALYTICS_HOME = new Set(['retail', 'corporate']);
const HISTORY_PATH = '/activity-monitoring/analytics/headcount';

const VIEWS = [
  { id: 'live', label: 'Live', Icon: Radio },
  { id: 'history', label: 'Historical', Icon: History },
];

function todayIso() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

// ══════════════════════════════════════════════════════════════════════════
//  LIVE ZONE HEADCOUNT — /activity-monitoring/headcount, every vertical.
//
//  Live operations only: who is in each zone right now. No date range, no
//  trend charts — the history is a separate view (HeadcountHistory.jsx):
//    retail / corporate → the Zone Headcount tab of Retail Analytics, linked
//      from this header, carrying the store (?store=).
//    other verticals    → a Live | Historical switch on this page.
//
//  The page reads nothing but params.headcount, so switching use-case swaps
//  the preset; the component never forks.
//
//  Layout, top to bottom:
//    header   title · live marker · history link/switch · store · export
//    KPIs     Total Live Headcount · Peak Today · Active Capacity Breaches ·
//             Unidentified Count
//    table    Real-Time Zone Occupancy — zone, occupants / capacity with a
//             bar, dwell, staff on post, status, camera preview
//  On lg+ the live page is one viewport tall and the table scrolls inside
//  itself; below lg (and on the Historical view) the page scrolls naturally.
// ══════════════════════════════════════════════════════════════════════════
export default function Headcount() {
  const { useCase, params, label: verticalLabel } = useActivityParams();
  const cfg = params.headcount;
  const liveOnly = ANALYTICS_HOME.has(useCase);
  const [viewState, setView] = useState('live');
  const view = liveOnly ? 'live' : viewState;
  const live = view === 'live';

  // Store scope — the module-wide site (siteStore.js), so the history link and
  // every other Activity Monitoring page stay on the store you were watching.
  // Zone counts are per store: an "All" preference shows the first one here.
  // ?store= deep links (the key Retail Analytics uses) are still honoured.
  const sites = useActivitySites();
  const { siteId, site, setSiteId: setSite } = useActivitySite({
    sites, allowAll: false, fallbackToFirst: true, urlParam: 'store',
  });
  const siteLabel = site?.label || '';

  // ── live filters (all inside the table's Filters popover) ──
  const [area, setArea] = useState('');
  const [types, setTypes] = useState([]);       // [] = all zone types
  const [status, setStatus] = useState('all');  // all | normal | warning | exceeded
  const [dwell, setDwell] = useState('all');    // all | '5' | '10' — avg dwell > N mins

  // ── live snapshot ──
  const today = useMemo(() => todayIso(), []);
  const [loading, setLoading] = useState(false);
  const [clock, setClock] = useState(() => { const t = Date.now(); return { updated: t, now: t }; });
  const [peakOpen, setPeakOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const closePreview = useCallback(() => setPreview(null), []);

  // Tick the "updated Ns ago" clock and poll for a fresh snapshot — only while
  // the live view is showing.
  useEffect(() => {
    if (!live) return undefined;
    const tick = setInterval(() => setClock((c) => ({ ...c, now: Date.now() })), CLOCK_MS);
    const poll = setInterval(() => { const t = Date.now(); setClock({ updated: t, now: t }); }, POLL_MS);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [live]);

  const zoneTypes = useMemo(() => {
    if (!cfg) return [];
    const used = new Set((cfg.zones || []).map((z) => z.type));
    return resolveZoneTypes(cfg).filter((t) => used.has(t.id));
  }, [cfg]);
  const typeIds = useMemo(() => types.filter((id) => zoneTypes.some((t) => t.id === id)), [types, zoneTypes]);

  const scope = useMemo(() => ({ site: siteId, range: 'live', date: today, granularity: 'hour' }), [siteId, today]);
  const buckets = useMemo(() => buildBuckets(params.businessHours, scope), [params.businessHours, scope]);

  const model = useMemo(() => {
    if (!cfg) return null;
    const areaTyped = buildZones(cfg, scope).filter((z) => (!area || z.area === area) && (!typeIds.length || typeIds.includes(z.type)));
    // Dwell > N keeps region zones whose people have stayed longer than N mins
    // on average; line zones have no dwell, so an active dwell filter drops them.
    const dwellMin = dwell !== 'all' ? Number(dwell) : null;
    const scoped = dwellMin == null ? areaTyped : areaTyped.filter((z) => z.avgDwellSec != null && z.avgDwellSec > dwellMin * 60);
    // Counted BEFORE the status filter, so each option shows what it would reveal.
    const statusCounts = scoped.reduce(
      (acc, z) => ({ ...acc, [STATUS_GROUP[z.status]]: (acc[STATUS_GROUP[z.status]] || 0) + 1 }),
      { all: scoped.length },
    );
    const zones = status !== 'all' ? scoped.filter((z) => STATUS_GROUP[z.status] === status) : scoped;
    const matrix = buildMatrix(zones, buckets, scope);
    return { zones, regions: zones.filter((z) => z.mode === 'region'), statusCounts, peak: buildPeak(matrix, cfg) };
  }, [cfg, scope, buckets, area, typeIds, status, dwell]);

  // A vertical without the block simply doesn't run this page.
  if (!cfg || !model) {
    return (
      <div className="min-h-[calc(var(--app-vh)-var(--topbar-h))] bg-surface-sunken/60">
        <div className="w-full page-inset">
          <div className="mt-4 rounded-xl border border-dashed border-line-strong bg-surface p-8 text-center">
            <p className="text-[13px] font-bold text-fg-secondary">Headcount is not licensed for {verticalLabel}</p>
            <p className="mt-1 text-[12px] text-fg-muted">
              Add a <code className="font-mono text-[11px] text-brand-ink">headcount</code> block to
              <code className="ml-1 font-mono text-[11px] text-brand-ink">src/use-cases/{String(verticalLabel).toLowerCase()}/index.js</code> to enable it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const { zones, regions, statusCounts, peak } = model;
  const words = cfg.label;

  // ── KPI row — four live counts ─────────────────────────────────────────
  const headcount = regions.reduce((a, z) => a + z.count, 0);
  const identified = regions.reduce((a, z) => a + z.identified, 0);
  const overCount = regions.filter((z) => z.status === 'over' || z.status === 'under').length;
  const headline = peak ? peak.headline : null;
  const cards = [
    {
      key: 'live', label: 'Total Live Headcount', value: headcount.toLocaleString('en-IN'),
      sub: `${regions.length} counted zone${regions.length === 1 ? '' : 's'}`,
      tip: { purpose: `total ${words.people} on ${words.site.toLowerCase()} right now.`, formula: 'Σ count(zone) where mode = region', fields: 'zone.count' },
    },
    {
      key: 'peak',
      label: 'Peak Today',
      value: (headline ? headline.value : headcount).toLocaleString('en-IN'),
      sub: headline ? `${headline.at} · ${headline.where}` : 'highest simultaneous count',
      tone: headline && headline.utilization >= cfg.breachPct ? 'crit' : '',
      onClick: peak ? () => setPeakOpen(true) : undefined,
      title: peak ? 'Peak detail — when, where and parameters' : undefined,
      tip: {
        purpose: `busiest moment so far today, and the ${words.area.toLowerCase()} it happened in.`,
        formula: cfg.peakBasis === 'zone' ? 'argmax(count / capacity) over zone × hour' : 'argmax_t(Σ_zone count) → rank zones at that t',
        fields: 'occupancy_bucket.max_count · bucket_start · zone_id',
      },
    },
    {
      key: 'over', label: 'Active Capacity Breaches', value: String(overCount),
      sub: `limit ${cfg.breachPct}% of capacity`, tone: overCount ? 'crit' : '',
      tip: { purpose: 'zones over capacity or below their minimum right now.', formula: 'util ≥ breachPct  OR  count < minOccupancy', fields: 'zone.capacity · params.breachPct' },
    },
    {
      key: 'unknown', label: 'Unidentified Count', value: (headcount - identified).toLocaleString('en-IN'),
      sub: 'counted but not recognised', tone: headcount - identified > 0 ? 'warn' : '',
      tip: { purpose: `${words.people} the face pipeline cannot name.`, formula: 'headcount − identified', fields: 'zone.count · face.identified' },
    },
  ];

  const applyLiveFilters = (f) => { setArea(f.area); setTypes(f.types); setStatus(f.status); setDwell(f.dwell); };

  const refresh = () => {
    setLoading(true);
    setTimeout(() => { setLoading(false); const t = Date.now(); setClock({ updated: t, now: t }); }, 700);
  };

  const onExport = (format) => exportHeadcount(format, {
    zones, peak, cards, words, siteId, siteLabel, date: today,
  });

  const storeQs = siteId ? `?store=${encodeURIComponent(siteId)}` : '';

  return (
    <div className={`min-h-[calc(var(--app-vh)-var(--topbar-h))] bg-surface-sunken/60 ${live ? 'lg:flex lg:h-[calc(var(--app-vh)-var(--topbar-h))] lg:min-h-0 lg:flex-col lg:overflow-hidden' : ''}`}>
      <div className={`flex w-full flex-col gap-3 page-inset ${live ? 'lg:min-h-0 lg:flex-1' : ''}`}>
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Users className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">{live ? 'Live Zone Headcount' : 'Zone Headcount'}</h1>
              {live && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-micro font-semibold text-success-ink ring-1 ring-success-line">
                  <span className="relative flex h-1.5 w-1.5" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                  </span>
                  Live
                </span>
              )}
            </div>
            <p className="mt-1 text-small text-fg-muted">
              Anonymous person count per zone across the {words.site.toLowerCase()}. No identity required. Times IST.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {liveOnly ? (
              <Link to={`${HISTORY_PATH}${storeQs}`} className={btnSecondary}>
                <History className="h-3.5 w-3.5" /> Historical analytics <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <div role="tablist" aria-label="View" className="inline-flex items-center rounded-lg border border-line bg-surface-muted p-0.5">
                {VIEWS.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={view === id}
                    onClick={() => setView(id)}
                    className={`inline-flex min-h-10 items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] transition lg:min-h-0 ${view === id ? 'bg-surface font-semibold text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
                  >
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                ))}
              </div>
            )}
            {/* Branch scope — every number on the page */}
            {sites.length > 0 && (
              <select
                value={siteId}
                onChange={(e) => setSite(e.target.value)}
                aria-label={words.site}
                title={words.site}
                className="h-11 max-w-[12rem] rounded-lg border border-line bg-surface px-2.5 text-[12.5px] font-semibold text-fg-secondary outline-none focus:border-brand lg:h-9"
              >
                {sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            )}
            {live && (
              <ExportMenu onSelect={onExport} />
            )}
          </div>
        </div>

        {live ? (
          <>
            <StatCards cards={cards} icons={ICONS} />

            {/* ── Real-Time Zone Occupancy ─────────────────────────────── */}
            <section className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:min-h-[18rem] lg:flex-1">
              <ZoneTable
                title="Real-Time Zone Occupancy"
                icon={LayoutGrid}
                filters={(
                  <ZoneFilterPopover
                    value={{ area, types: typeIds, status, dwell }}
                    onApply={applyLiveFilters}
                    zoneTypes={zoneTypes}
                    areas={cfg.areas || []}
                    areaLabel={words.area}
                    statusCounts={statusCounts}
                  />
                )}
                zones={zones}
                loading={loading}
                lastUpdated={clock.updated}
                now={clock.now}
                onRefresh={refresh}
                onPreview={(z) => setPreview(zonePreviewSource(z, new Date()))}
                dwellAlertSec={cfg.dwellAlertSec}
              />
            </section>
          </>
        ) : (
          <HeadcountHistory siteId={siteId} siteLabel={siteLabel} />
        )}
      </div>

      {/* Peak drill-in — its own Time Window / Zone Type filters over the
          same matrix builders; "Today" reads this page's live scope. */}
      <PeakModal
        open={peakOpen}
        onClose={() => setPeakOpen(false)}
        cfg={cfg}
        scope={scope}
        buckets={buckets}
        zoneTypes={zoneTypes}
        shifts={params.shifts || []}
        words={words}
        onPreview={setPreview}
      />
      {preview && <CameraPreviewModal source={preview} onClose={closePreview} />}
    </div>
  );
}

const EXPORT_FORMATS = [
  { id: 'csv', emoji: '📊', label: 'Export as CSV (.csv)', hint: 'Header block + full zone table' },
  { id: 'pdf', emoji: '📄', label: 'Export as PDF Report (.pdf)', hint: 'Official zone occupancy report with logo' },
  { id: 'xlsx', emoji: '📈', label: 'Export as Excel (.xlsx)', hint: 'Full analytics spreadsheet' },
];

// Header Export button — a dropdown of formats; closes on pick, outside click
// or Escape.
function ExportMenu({ onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white font-medium rounded-lg px-3.5 py-2 text-sm shadow-sm flex items-center gap-2 transition-colors"
      >
        <Download className="h-4 w-4" /> Export <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-52 bg-white rounded-xl shadow-xl border border-gray-100 py-1.5 z-50 text-sm text-gray-700 animate-in fade-in slide-in-from-top-1">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onSelect(f.id); }}
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-amber-50 hover:text-amber-900 transition-colors"
            >
              <span aria-hidden className="leading-5">{f.emoji}</span>
              <span className="min-w-0">
                <span className="block font-medium leading-5">{f.label}</span>
                <span className="block text-xs text-gray-500">{f.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const btnSecondary ='inline-flex h-11 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink lg:h-9';
