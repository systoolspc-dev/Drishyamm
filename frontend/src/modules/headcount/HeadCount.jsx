/**
 * Head Count — live occupancy wall.
 *
 * It answers exactly two questions, and deliberately not a third:
 *   1. What is EACH camera counting right now, on its own picture?
 *   2. Which cameras should be counted at all, and at what detail?
 *
 * Question 1 is the wall, and the wall IS the page — it starts at the top of
 * the content area and is on screen the moment the page opens. It used to
 * start about 500px down, under six KPI cards, a per-camera occupancy grid, a
 * session sparkline and a diagnostics row. A page whose subject is a live
 * picture cannot open on a summary of the picture.
 *
 * The question it does NOT answer is the site-wide one — how many people are
 * in the building, how many spaces are over their limit. That belongs to
 * Footfall & Occupancy, whose metric tiles are computed from the same
 * readings, and answering it here as well is what made the cards redundant.
 * Shrinking them to header pills would only have made the duplicate smaller,
 * so there is no summary on this page in any form. Per camera is the whole
 * remit.
 *
 * Question 2 is one dialog (CameraPicker), opened from the header. It is
 * configuration — done occasionally, then left alone — so it does not get
 * page real estate.
 *
 * Engine diagnostics (device, uptime, reachable) are present but deliberately
 * quiet — one pill, detail on hover. An operator needs them only when
 * something looks wrong.
 *
 * The frame is the shared one (OperationsPage / PageHeader / PageContent), so
 * the content edge, the title, the action buttons and the viewport height all
 * match every other Operations page. This file used to hand-roll all four,
 * with a `p-5 sm:p-7 max-w-[1500px] mx-auto` wrapper whose centred cap had
 * been deleted from every other page — see the frame file's docblock.
 *
 * Data comes from the head-count service:
 *   GET {HC}/health   → { device, uptime_seconds, streams_online, streams_total }
 *   GET {HC}/streams  → [{ id, name, counts:{heads}, zone_counts, fps, status, … }]
 *   GET {HC}/video/id → MJPEG with detection boxes burned in
 * plus the VMS camera registry for per-camera settings.
 *
 * Zones are READ here, never drawn. Zone Setup is the one place a zone's shape
 * and capacity are set; both pages used to write the same camera field, so
 * whichever saved last silently replaced the other's zone. This page keeps only
 * what belongs to the camera itself: whether it counts, and its detail level.
 * On prod nginx proxies /headcount/*; in local dev the service is on :8020.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, Cpu, Clock, Video, Settings, Search, AlertTriangle,
  Crop, RefreshCw, Check, X, Download,
} from 'lucide-react';
import { aiService } from '@/core/services/ai';
import {
  OperationsPage, PageAction, PageContent, PageHeader,
} from '@/core/layout/OperationsPage';
import { Button } from '@/core/ui/button';
import { CameraEmptyState } from '@/core/components/CameraEmptyState';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import { pointsToSvg } from './zone-geometry';

const PAGE_DESCRIPTION =
  'Live people count per camera. Choose which cameras count here; zones and their capacity are set in Zone Setup. A camera with no zone counts its whole view. Counts come from the head-count detector; a camera turns amber as it approaches its limit and red once it reaches it.';

/** Zone Setup, opened on this camera. */
const zoneSetupHref = (monitorId) => `/occupancy/zone-setup?zone=${encodeURIComponent(monitorId)}`;

const HC = import.meta.env.VITE_HEADCOUNT_BASE
  || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'http://localhost:8020' : '/headcount');

const nfmt = (n) => new Intl.NumberFormat().format(Math.round(Number(n) || 0));
const fmtUptime = (s) => {
  if (s == null) return '—';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
};

const FILTERS = [
  { id: 'all',      label: 'All' },
  { id: 'people',   label: 'With people' },
  { id: 'over',     label: 'Over limit' },
  { id: 'area',     label: 'Zones set' },
  { id: 'problem',  label: 'Needs attention' },
];

export default function HeadCount() {
  const [health, setHealth] = useState(null);
  const [streams, setStreams] = useState([]);
  const [err, setErr] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [camList, setCamList] = useState([]);
  const [savingId, setSavingId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const poll = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([
        fetch(`${HC}/health`).then((r) => r.json()),
        fetch(`${HC}/streams`).then((r) => r.json()),
      ]);
      setHealth(h);
      setStreams(Array.isArray(s?.streams) ? s.streams : []);
      setErr(false);
    } catch { setErr(true); } finally { setLoaded(true); }
  }, []);

  const loadCams = useCallback(async () => {
    try {
      const r = await aiService.listCameraAiSettings();
      setCamList(Array.isArray(r?.data) ? r.data : []);
    } catch { /* keep last known */ }
  }, []);

  useEffect(() => {
    poll(); loadCams();
    const a = setInterval(poll, 1500);
    const b = setInterval(loadCams, 10000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [poll, loadCams]);

  // Tiles are keyed by monitorId; the registry holds each camera's limit and
  // counting area, so join them once rather than per render of every tile.
  const camByMonitor = useMemo(
    () => Object.fromEntries(camList.filter((c) => c.monitorId).map((c) => [c.monitorId, c])),
    [camList],
  );

  const enriched = useMemo(() => streams.map((s) => {
    const cam = camByMonitor[s.id];
    const limit = Number(cam?.headcount?.threshold) || 0;
    const heads = Number(s?.counts?.heads) || 0;
    return {
      ...s,
      cam,
      limit,
      heads,
      zones: cam?.headcount?.zones || [],
      over: limit > 0 && heads >= limit,
      unhappy: s.status !== 'online' || s.count_reliable === false,
    };
  }), [streams, camByMonitor]);

  // Kept for the "Over limit" filter chip, which is a way to narrow the wall
  // rather than a site-wide readout.
  const overCount = enriched.filter((s) => s.over).length;

  const exportCsv = useCallback(() => {
    const head = ['camera', 'monitor_id', 'people', 'limit', 'utilization_pct', 'status'];
    const rows = enriched.map((s) => [
      JSON.stringify(s.name || s.id), s.id, s.heads, s.limit || '',
      s.limit > 0 ? Math.round((s.heads / s.limit) * 100) : '',
      s.over ? 'over limit' : s.unhappy ? 'needs attention' : 'normal',
    ].join(','));
    const blob = new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `headcount-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [enriched]);

  const visible = useMemo(() => enriched.filter((s) => {
    if (filter === 'people' && s.heads <= 0) return false;
    if (filter === 'over' && !s.over) return false;
    if (filter === 'area' && !s.zones.length) return false;
    if (filter === 'problem' && !s.unhappy) return false;
    return true;
  }), [enriched, filter]);

  const toggleHeadcount = useCallback(async (cam, next) => {
    setSavingId(cam.id);
    setCamList((list) => list.map((c) => (c.id === cam.id
      ? { ...c, headcount: { ...(c.headcount || {}), enabled: next } } : c)));
    try {
      await aiService.setHeadcount(cam.id, { enabled: next, threshold: cam.headcount?.threshold || 0 });
    } catch {
      setCamList((list) => list.map((c) => (c.id === cam.id
        ? { ...c, headcount: { ...(c.headcount || {}), enabled: !next } } : c)));
    } finally { setSavingId(null); }
  }, []);

  // Detail level = how much of the picture the detector examines. Measured on
  // identical footage: 640 -> 1280 found 71% more people, all of them distant.
  // It costs roughly 2x the processing per frame, so it is a per-camera choice —
  // spend it on the rooms that are actually deep.
  const saveDetail = useCallback(async (cam, imgsz) => {
    setCamList((list) => list.map((c) => (c.id === cam.id
      ? { ...c, headcount: { ...(c.headcount || {}), imgsz } } : c)));
    try {
      await aiService.setHeadcount(cam.id, {
        enabled: cam.headcount?.enabled === true,
        threshold: cam.headcount?.threshold || 0,
        imgsz,
      });
    } catch { /* next poll corrects */ }
  }, []);

  const enabledCount = camList.filter((c) => c.headcount?.enabled === true).length;
  const runningIds = useMemo(() => new Set(streams.map((x) => x.id)), [streams]);

  return (
    <>
      <OperationsPage>
        <PageHeader
          actions={
            <>
              {/* No site-wide totals here, in any form. "People now" and
                  "cameras over limit" are answered on Footfall & Occupancy --
                  the metric tiles above its Head Count & Flow tab are computed
                  from the same readings -- so a second copy on this page was
                  the redundancy the cards were removed for, and shrinking them
                  to pills would only have made the duplicate smaller. This
                  page answers a narrower question: what is EACH camera
                  counting, right now, on its own picture. */}

              {/* Engine diagnostics. They used to sit between the cards and the
                  wall as their own row; they are quieter as one pill whose
                  detail is a hover away, and the page keeps the height. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-small font-semibold ${
                      err ? 'border-danger-line bg-danger-soft text-danger-ink' : 'border-line bg-surface text-fg-muted'
                    }`}
                    role="status"
                    tabIndex={0}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${err ? 'bg-danger' : 'animate-pulse bg-success'}`} />
                    <span className="hidden sm:inline">{err ? 'Detector unreachable' : 'Detector'}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[18rem] text-caption leading-relaxed" side="bottom" variant="card">
                  {err
                    ? 'The head-count service is not responding. Counts shown are the last good reading; polling retries automatically.'
                    : 'The head-count detector is responding.'}
                  <span className="mt-1 flex items-center gap-3 text-fg-muted">
                    <span className="inline-flex items-center gap-1"><Cpu size={11} /> {health?.device || '—'}</span>
                    <span className="inline-flex items-center gap-1"><Clock size={11} /> up {fmtUptime(health?.uptime_seconds)}</span>
                  </span>
                </TooltipContent>
              </Tooltip>

              <PageAction onClick={() => setPickerOpen(true)} title="Choose which cameras count" type="button">
                <Settings className="h-3.5 w-3.5 text-brand" strokeWidth={2} />
                <span className="hidden sm:inline">Cameras</span>
                <span className="tabular-nums text-fg-muted">{enabledCount}/{camList.length}</span>
              </PageAction>
              <PageAction
                className="disabled:opacity-40"
                disabled={!enriched.length}
                onClick={exportCsv}
                title="Export CSV"
                type="button"
              >
                <Download className="h-3.5 w-3.5" strokeWidth={2} />
                <span className="hidden sm:inline">Export CSV</span>
              </PageAction>
              <PageAction onClick={() => { poll(); loadCams(); }} title="Refresh" type="button">
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
                <span className="hidden sm:inline">Refresh</span>
              </PageAction>
            </>
          }
          description={PAGE_DESCRIPTION}
          descriptionAs="tooltip"
          icon={Users}
          tagline="Live people count per camera. Zones and capacity come from Zone Setup."
          title="Head Count"
        />

        {/* From xl up the page fits the viewport: the filter chips keep their
            height and the wall scrolls inside itself, so the first row of
            tiles is on screen the moment the page opens. Smaller screens
            scroll as a whole. */}
        <PageContent className="gap-2 xl:overflow-hidden" scroll>
          {!loaded ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="aspect-video animate-pulse rounded-xl border border-line bg-surface-muted/40" />
              ))}
            </div>
          ) : enriched.length === 0 ? (
            <EmptyState err={err} hasCameras={camList.length > 0} onChoose={() => setPickerOpen(true)} />
          ) : (
            <>
              {enriched.length > 3 && (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {FILTERS.map((f) => {
                    const n = f.id === 'all' ? enriched.length
                      : f.id === 'people' ? enriched.filter((s) => s.heads > 0).length
                      : f.id === 'over' ? overCount
                      : f.id === 'area' ? enriched.filter((s) => s.zones.length).length
                      : enriched.filter((s) => s.unhappy).length;
                    const active = filter === f.id;
                    if (n === 0 && f.id !== 'all') return null;
                    return (
                      <button
                        aria-pressed={active}
                        className={`cursor-pointer rounded-full px-3 py-1 text-small font-medium transition duration-200 ${
                          active ? 'bg-foreground text-background' : 'bg-surface-muted text-fg-muted hover:text-fg'
                        }`}
                        key={f.id}
                        onClick={() => setFilter(f.id)}
                        type="button"
                      >
                        {f.label} <span className="tabular-nums opacity-70">{n}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {visible.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-line bg-surface/50 py-12 text-center">
                  <p className="text-body font-medium text-fg">
                    Nothing matches &ldquo;{FILTERS.find((f) => f.id === filter)?.label}&rdquo;
                  </p>
                  <button
                    className="mt-2 cursor-pointer text-small font-semibold text-brand hover:underline"
                    onClick={() => setFilter('all')}
                    type="button"
                  >
                    Show all cameras
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:min-h-0 xl:flex-1 xl:grid-cols-3 xl:overflow-y-auto">
                  {visible.map((s) => (
                    <Tile key={s.id} s={s} />
                  ))}
                </div>
              )}
            </>
          )}
        </PageContent>
      </OperationsPage>

      {pickerOpen && (
        <CameraPicker
          camList={camList} query={query} setQuery={setQuery}
          savingId={savingId} onToggle={toggleHeadcount}
          onDetail={saveDetail}
          runningIds={runningIds} enabledCount={enabledCount}
          onClose={() => setPickerOpen(false)}
        />
      )}

    </>
  );
}

/* ── pieces ────────────────────────────────────────────────── */

// Four summary components used to live here -- Metric (already dead: zero call
// sites), Kpi (the six-card strip), OccupancyTile (a per-camera count + bar)
// and Sparkline (the session trend). They were removed rather than restyled.
//
// Between them they stacked roughly 500px above the first camera tile, which
// put the wall -- the reason anyone opens this page -- below the fold on a
// 1080p screen. Nothing they showed was unique to them: the per-camera count,
// limit, percentage and zone chips are all on the tile itself, and the two
// facts that were NOT per-camera (people now, cameras over limit) moved into
// the header as pills, where they cost no height.
//
// What genuinely went: the session occupancy trend. It was sampled in-page at
// 3s intervals and lived only as long as the tab was open -- a shape, not
// history. Real history needs a backend rollup, and the Occupancy page's Usage
// Trends tab is where it belongs.

/**
 * Nothing on the wall.
 *
 * THREE different facts behind one blank page, so three states — each naming
 * its own cause and offering only the step that fixes it:
 *
 *   detector unreachable  a FAULT. Nothing to configure, and offering Camera
 *                         Setup would send them to re-add cameras they have.
 *   no cameras at all     the account is empty. Camera Setup is the only move;
 *                         "choose which cameras count" would open an empty
 *                         picker.
 *   none counting yet     a step not taken. The nearer step (choose cameras)
 *                         leads, with Camera Setup behind it.
 *
 * `hasCameras` is read from `camList` (every camera's AI settings), which the
 * page already polls — so the distinction costs no extra request.
 */
function EmptyState({ onChoose, err, hasCameras }) {
  if (err) {
    return (
      <CameraEmptyState
        description="The head-count service is not responding. Counting resumes automatically once it is back."
        showSetup={false}
        title="Cannot reach the detector"
      />
    );
  }
  // No camera on the account at all. This used to fall through to "choose
  // which cameras count", whose button opens an empty picker and whose
  // sentence ended "...if there is nothing to pick from, the account has no
  // cameras yet" — leaving the viewer to diagnose their own blank page. Say
  // the cause, and offer the only step that fixes it.
  if (!hasCameras) {
    return (
      <CameraEmptyState
        description="Head count works per camera, so there is nothing to count yet. Add a camera or recorder first — then you can pick which of them count here."
        title="No cameras have been added"
      />
    );
  }
  return (
    <CameraEmptyState
      action={(
        <Button onClick={onChoose} type="button">
          <Video strokeWidth={2} />
          Choose cameras
        </Button>
      )}
      description="Pick the cameras you want counted — each one appears here within about 15 seconds. Counting areas are optional: a camera with no zone counts its whole view."
      title="No cameras are being counted yet"
    />
  );
}

/**
 * Choosing cameras is configuration, not monitoring — it is done occasionally
 * and then left alone. Inline it added roughly a screen and a half of scroll
 * beneath the wall, pushing the live tiles (the reason for the page) out of
 * view. It lives in a dialog instead, with its own scroll area, so the page
 * itself stays one screen.
 */
/**
 * Detail is the one per-camera setting with a real cost, so each level says
 * what it buys and what it costs — on hover, over the level itself, rather
 * than as a `title` on an `<option>` (browsers show those unreliably, and a
 * native menu cannot put a sentence beside a choice at all).
 */
const DETAIL_LEVELS = [
  { v: 640,  short: 'Standard', label: 'Standard detail', reach: 'to 9 m',
    hint: 'Counts people up to roughly 9 m away on a standard lens. Lightest on the detector — the right choice for offices, shops and small rooms.' },
  { v: 960,  short: 'High',     label: 'High detail',     reach: 'to 13 m',
    hint: 'Reaches roughly 13 m, for about 1.5x the processing. Use it when people at the back of a deep room are being missed.' },
  { v: 1280, short: 'Max',      label: 'Maximum detail',  reach: 'to 18 m',
    hint: 'Reaches roughly 18 m, for about 2x the processing — the most one camera can cost. For halls, atriums and long corridors.' },
];

/**
 * The three detail levels as a segmented control rather than a dropdown: all
 * three are visible at once, each is its own hover target, and hovering (or
 * focusing) one says in a sentence what it reaches and what it costs. The row
 * is full width, so it never competes with Set up zones for horizontal space.
 */
function DetailPicker({ value, onChange }) {
  const current = DETAIL_LEVELS.find((d) => d.v === value) || DETAIL_LEVELS[0];
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="cursor-help text-micro font-medium uppercase tracking-wide text-fg-muted">
              Detail
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[18rem] text-caption leading-relaxed" side="top" variant="card">
            How much of the picture the detector examines. Higher detail finds people further
            away and costs more processing on this camera — hover a level for its range.
          </TooltipContent>
        </Tooltip>
        <span className="shrink-0 text-micro font-medium text-fg-muted">{current.reach}</span>
      </div>

      <div role="group" aria-label="Detection detail"
           className="flex w-full flex-wrap gap-0.5 rounded-lg bg-surface-muted p-0.5">
        {DETAIL_LEVELS.map((d) => {
          const active = d.v === current.v;
          return (
            <Tooltip key={d.v}>
              <TooltipTrigger asChild>
                <button
                  type="button" onClick={() => onChange(d.v)} aria-pressed={active}
                  className={`min-w-fit flex-1 cursor-pointer whitespace-nowrap rounded-md px-1.5 py-1 text-micro font-semibold
                              transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
                    ${active
                      ? 'bg-background text-fg ring-1 ring-line'
                      : 'text-fg-muted hover:text-fg'}`}>
                  {d.short}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[17rem] text-caption leading-relaxed" side="top" variant="card">
                <span className="font-semibold">{d.label}</span>
                <span className="mt-0.5 block">{d.hint}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function CameraPicker({ camList, query, setQuery, savingId, onToggle,
                        onDetail, runningIds, enabledCount, onClose }) {
  const [group, setGroup] = useState('all');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const set = new Set(camList.map((c) => c.groupName || 'Ungrouped'));
    return ['all', ...[...set].sort()];
  }, [camList]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return camList.filter((c) => {
      if (group !== 'all' && (c.groupName || 'Ungrouped') !== group) return false;
      if (!q) return true;
      return `${c.name} ${c.groupName || ''}`.toLowerCase().includes(q);
    });
  }, [camList, query, group]);

  const allOn = filtered.length > 0 && filtered.every((c) => c.headcount?.enabled === true);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
         onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="flex max-h-[calc(var(--app-vh)*0.88)] w-full max-w-5xl flex-col overflow-hidden rounded-xl
                      border border-line bg-surface shadow-2xl">

        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-fg sm:text-base">Choose cameras</h3>
            <p className="mt-0.5 text-body text-fg-muted">
              Click a camera to start or stop counting it · {enabledCount} of {camList.length} counting
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
                  className="cursor-pointer rounded p-1.5 text-fg-muted transition hover:bg-surface-muted hover:text-fg">
            <X size={18} />
          </button>
        </header>

      {/* Search, group filter, bulk switch — one line, so the grid fills the dialog. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cameras..." aria-label="Search cameras"
            className="w-full rounded-lg border border-line bg-background py-2 pl-9 pr-3 text-body text-fg
                       outline-none transition focus:ring-2 focus:ring-brand/50"
          />
        </div>
        {groups.length > 2 && (
          <div className="flex flex-wrap gap-1">
            {groups.map((g) => (
              <button key={g} onClick={() => setGroup(g)} aria-pressed={group === g}
                className={`cursor-pointer rounded-full px-3 py-1.5 text-small font-medium transition duration-200
                  ${group === g ? 'bg-foreground text-background' : 'bg-surface-muted text-fg-muted hover:text-fg'}`}>
                {g === 'all' ? 'All groups' : g}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => filtered.forEach((c) => {
            if ((c.headcount?.enabled === true) !== !allOn) onToggle(c, !allOn);
          })}
          className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-small font-semibold text-fg-muted
                     transition duration-200 hover:bg-surface-muted hover:text-fg">
          {allOn ? 'Turn all off' : 'Turn all on'}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {filtered.length === 0 ? (
        <p className="py-8 text-center text-body text-fg-muted">
          No camera matches that search. Try part of the name, or pick a different group.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((cam) => {
            const on = cam.headcount?.enabled === true;
            const counting = runningIds.has(cam.monitorId);
            const hasZone = (cam.headcount?.zones || []).length > 0;
            const limit = cam.headcount?.threshold || 0;
            return (
              <div key={cam.id}
                className={`overflow-hidden rounded-xl border bg-background transition duration-200
                  ${on ? 'border-brand ring-1 ring-brand/30' : 'border-line hover:border-muted-foreground/40'}`}>

                {/* The card face IS the on/off control. Picking cameras is a
                    visual task, so the picture is the target — not a switch at
                    the end of a dense row. */}
                <button
                  onClick={() => onToggle(cam, !on)} disabled={savingId === cam.id}
                  aria-pressed={on}
                  title={on ? 'Counting - click to stop' : 'Not counting - click to start'}
                  className="relative block w-full cursor-pointer text-left focus-visible:outline-none
                             focus-visible:ring-2 focus-visible:ring-brand">
                  <div className="relative aspect-video bg-black">
                    {counting ? (
                      <img src={`${HC}/video/${encodeURIComponent(cam.monitorId)}`} alt=""
                           className="h-full w-full object-cover" />
                    ) : (
                      <div className="grid h-full w-full place-items-center bg-surface-muted/30">
                        <Video size={20} className="text-fg-muted/40" />
                      </div>
                    )}

                    <span className={`absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-white transition duration-200
                      ${on ? 'bg-brand' : 'bg-black/50 ring-1 ring-white/25'}`}>
                      {on ? <Check size={13} strokeWidth={3} /> : null}
                    </span>

                    {hasZone && (
                      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-[#0A4994]/85 px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-white">
                        <Crop size={9} /> Zone
                      </span>
                    )}
                  </div>

                  <div className="px-2.5 py-2">
                    <div className="truncate text-body font-semibold text-fg" title={cam.name}>{cam.name}</div>
                    <div className="truncate text-caption text-fg-muted">
                      {cam.groupName || 'Ungrouped'}{limit > 0 ? ` - limit ${limit}` : ''}
                      {cam.headcount?.imgsz > 640 ? ' - long range' : ''}
                    </div>
                  </div>
                </button>

                {/* Per-camera settings appear only once it is actually being
                    counted, so an unselected grid stays clean. */}
                {/* Detail and Set up zones shared one row, and in a card this
                    narrow the select pushed the zone link against the card edge
                    — the one control an operator opens this dialog to press.
                    They are stacked now: detail spans the row, Set up zones has
                    a full row of its own and can never be squeezed out of it. */}
                {on && (
                  <div className="space-y-1.5 border-t border-line px-2.5 py-2">
                    <DetailPicker
                      value={cam.headcount?.imgsz || 640}
                      onChange={(v) => onDetail(cam, v)}
                    />
                    <Link to={zoneSetupHref(cam.monitorId)}
                      title="Draw the counting zone and set its capacity in Zone Setup"
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-1.5
                                 text-micro font-semibold text-brand-ink transition duration-200
                                 hover:border-brand/40 hover:bg-brand-soft">
                      <Crop size={11} /> Set up zones
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-caption text-fg-muted">
            A camera with no zone counts everyone it can see; zones and limits are set in Zone Setup.
            Raise <strong>detail</strong> for deep rooms — hover a level to see how far it reaches and what it costs.
            Changes apply within about 15 seconds.
          </p>
          <button onClick={onClose}
            className="cursor-pointer rounded-lg bg-brand px-4 py-2 text-body font-semibold text-white
                       transition duration-200 hover:brightness-95">
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function Tile({ s }) {
  const { heads, limit, over, zones = [] } = s;
  const status = s?.status || 'starting';
  const live = status === 'online';
  const reliable = s?.count_reliable !== false;
  const zoneCounts = Object.entries(s?.zone_counts || {});
  const scoped = zones.length > 0;

  // Label each shape at its highest corner, so an operator can tell which
  // outline is which zone. With one zone the camera's limit IS that zone's
  // capacity (Zone Setup pushes it there), so it rides on the label.
  const labelAt = (z) => (z.points || []).reduce(
    (a, p) => (p[1] < a[1] ? p : a), (z.points || [[0.5, 0.5]])[0]);

  return (
    <div className={`group relative overflow-hidden rounded-xl border bg-black aspect-video transition duration-200
                     ${over ? 'border-danger ring-1 ring-danger/40' : 'border-line'}`}>
      <img src={`${HC}/video/${encodeURIComponent(s.id)}`} alt={`${s.name} live view`}
           className="h-full w-full object-contain" />

      {/* The counting area, drawn over the picture. Without it an operator
          cannot tell WHY someone plainly in shot isn't in the count. */}
      {/* Two layers. Polygon `points` take user units, not percentages -- a
          "40%,30%" list is invalid and draws nothing -- so the shapes live in a
          0..100 viewBox stretched to the tile. Text would stretch with it, so
          the labels sit in a second, unscaled layer where x/y may be percent. */}
      {scoped && (
        <>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true"
               preserveAspectRatio="none" viewBox="0 0 100 100">
            {zones.map((z, i) => (
              <polygon key={z.id || i} points={pointsToSvg(z.points || [])}
                       fill="rgba(76,201,240,0.12)" stroke="#4CC9F0" strokeWidth="2"
                       strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            {zones.map((z, i) => {
              const [lx, ly] = labelAt(z);
              return (
                <text key={z.id || i} x={`${lx * 100}%`} y={`${ly * 100}%`} dy="-6"
                      className="fill-[#7FD8F0] text-micro font-semibold"
                      style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,.85)', strokeWidth: 3 }}>
                  {z.name || 'Zone'}{zones.length === 1 && limit > 0 ? ` · capacity ${limit}` : ''}
                </text>
              );
            })}
          </svg>
        </>
      )}

      {/* TOP — identity, liveness, and the primary number. One scrim, so text
          never sits on raw video where contrast is unpredictable. */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2
                      bg-gradient-to-b from-black/80 to-transparent px-3 pb-6 pt-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${live ? 'bg-success motion-safe:animate-pulse' : 'bg-warning'}`} />
          <span className="truncate text-body font-semibold text-white" title={s.name}>{s.name}</span>
          {!live && (
            <span className="shrink-0 rounded bg-warning/90 px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-slate-900">
              {status}
            </span>
          )}
        </div>

        {/* A count we cannot currently verify shows as "—" rather than a
            confident number that happens to be stale. */}
        <div className={`shrink-0 rounded-lg px-2.5 py-1 text-right ring-1
                         ${over ? 'bg-danger/85 ring-danger-line/40' : 'bg-black/70 ring-white/15'}`}>
          <div className={`text-2xl font-bold leading-none tabular-nums
                           ${!reliable ? 'text-white/40' : over ? 'text-white' : 'text-success'}`}>
            {reliable ? heads : '—'}
          </div>
          <div className="text-micro font-semibold uppercase tracking-wider text-white/60">
            {limit > 0 ? `of ${limit}` : scoped ? 'in zone' : 'people'}
          </div>
        </div>
      </div>

      {/* BOTTOM — what is being counted, and the throughput behind it. */}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2
                      bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2.5 pt-8">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {over && (
            <span className="inline-flex items-center gap-1 rounded bg-danger px-1.5 py-0.5 text-micro font-bold text-white">
              <AlertTriangle size={10} /> Over limit
            </span>
          )}
          {zoneCounts.length > 0 ? (
            zoneCounts.map(([name, n]) => (
              <span key={name}
                    className="rounded bg-[#4CC9F0]/18 px-1.5 py-0.5 text-micro font-semibold text-[#7FD8F0] ring-1 ring-[#4CC9F0]/40">
                {name} <span className="tabular-nums">{n}</span>
              </span>
            ))
          ) : (
            <span className={`rounded px-1.5 py-0.5 text-micro font-medium ring-1
                              ${scoped ? 'bg-[#4CC9F0]/15 text-[#7FD8F0] ring-[#4CC9F0]/35'
                                       : 'bg-white/10 text-white/60 ring-white/15'}`}>
              {/* A limit with no shape is a zone that covers the whole view
                  (saved in Zone Setup without drawing), not "no zone". */}
              {scoped ? 'Counting zone' : limit > 0 ? `Whole camera view · limit ${limit}` : 'Whole camera view · no zones set up'}
            </span>
          )}
          <span className="text-micro tabular-nums text-white/45">
            {Math.round(s?.fps || 0)} fps · {nfmt(s?.frames_processed)} frames
          </span>
        </div>

        {/* Revealed on hover, but always reachable by keyboard so it is not a
            mouse-only control. */}
        <Link to={zoneSetupHref(s.id)}
          title="Zones and their capacity are set in Zone Setup"
          className="shrink-0 rounded-md bg-white/12 px-2.5 py-1.5 text-caption font-semibold text-white
                     opacity-0 ring-1 ring-white/20 transition duration-200 hover:bg-white/22
                     focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2
                     focus-visible:ring-[#4CC9F0] group-hover:opacity-100">
          Set up zones
        </Link>
      </div>
    </div>
  );
}
