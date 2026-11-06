import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownNarrowWide,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Filter,
  SlidersHorizontal,
  Maximize2,
  RefreshCw,
  RotateCcw,
  ScanFace,
  Search,
  ShieldCheck,
  Sparkles,
  GraduationCap,
  ThumbsDown,
  UserCheck,
  Video,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/core/ui/dialog';
import {
  OperationsPage,
  PageAction,
  PageCard,
  PageContent,
  PageHeader,
} from '@/core/layout/OperationsPage';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/core/ui/select';
import api from '@/core/services/api';
import EnhanceFaceDialog from '@/core/components/EnhanceFaceDialog';

const PAGE_DESCRIPTION =
  'Review the CCTV face crops the AI suggests for the enrolled gallery. Approve the clean ones to strengthen recognition.';

const STATUS_META = {
  pending:  { label: 'Pending',  icon: Clock3,        tone: 'border-warning-line   bg-warning-soft   text-warning-ink',   dot: 'bg-warning' },
  approved: { label: 'Approved', icon: CheckCircle2,  tone: 'border-success-line bg-success-soft text-success-ink', dot: 'bg-success' },
  rejected: { label: 'Rejected', icon: XCircle,       tone: 'border-danger-line    bg-danger-soft    text-danger-ink',    dot: 'bg-danger' },
};

const QUALITY_OPTIONS = [
  { value: 0,  label: 'Any quality' },
  { value: 50, label: '50%+' },
  { value: 70, label: '70%+' },
  { value: 90, label: '90%+' },
];

const SORT_OPTIONS = [
  { value: 'newest',  label: 'Newest first' },
  { value: 'oldest',  label: 'Oldest first' },
  { value: 'quality', label: 'Best quality' },
  { value: 'match',   label: 'Best match' },
];

const STATUS_TABS = [
  { value: 'pending',  label: 'Pending'  },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const SAMPLE_LIMIT = 32;

function fmtTime(value) {
  if (!value) return '--';
  return new Date(value).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function pctNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function cameraCode(sample) {
  const meta = sample.metadata || sample.metadata_json || {};
  return meta.camera_code || sample.camera_id?.slice(0, 8) || 'Unknown';
}

function cropLabel(sample) {
  const meta = sample.metadata || sample.metadata_json || {};
  return meta.person_name || sample.person_id?.slice(0, 8) || 'Known person';
}

function reviewDecision(sample) {
  const meta = sample.metadata || sample.metadata_json || {};
  const match = Number(sample.similarity || 0);
  const quality = Number(sample.quality_score || 0);
  const detect = Number(sample.det_score || 0);
  const blur = Number(meta.blur_var || 0);
  const facePx = Number(meta.face_px || 0);

  if (match >= 0.45 && quality >= 0.72 && detect >= 0.8 && blur >= 60 && facePx >= 120) {
    return { label: 'Approve candidate', tone: 'border-success-line bg-success-soft text-success-ink' };
  }
  if (quality < 0.62 || detect < 0.72 || blur < 45 || facePx < 96) {
    return { label: 'Reject recommended', tone: 'border-danger-line bg-danger-soft text-danger-ink' };
  }
  return { label: 'Inspect closely', tone: 'border-warning-line bg-warning-soft text-warning-ink' };
}

function useInViewport(rootMargin = '500px') {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return undefined;
    const node = ref.current;
    if (!node) return undefined;
    if (!('IntersectionObserver' in window)) {
      setVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin, visible]);

  return [ref, visible];
}

// The brand gradient the filter controls wear: a soft brand → deeper-brand
// wash on hover, a stronger one while selected / open.
const BRAND_IDLE = 'border-line bg-surface text-fg-secondary hover:border-brand/40 hover:bg-linear-to-r hover:from-brand/15 hover:to-brand-active/5 hover:text-brand-ink';
const BRAND_ON = 'border-brand/50 bg-linear-to-r from-brand/25 to-brand-active/10 text-brand-ink shadow-sm shadow-brand/10';

export default function FaceLearning() {
  const [status, setStatus] = useState('pending');
  const [samples, setSamples] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  // Client-side filter state
  const [query, setQuery] = useState('');
  const [cameraFilter, setCameraFilter] = useState('all');
  const [qualityMin, setQualityMin] = useState(0);
  const [sortBy, setSortBy] = useState('newest');

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/ai/face-learning/samples', {
        params: { status, limit: SAMPLE_LIMIT },
      });
      setSamples(data?.data || []);
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not load learning samples.');
      setSamples([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll cadence: pending is "near real-time" so operators see new crops
  // queue up within ~3 seconds of the AI service queueing them. Approved/
  // rejected lists are historical — slower poll is fine. `silent: true`
  // suppresses the loading spinner so the grid doesn't flash on every tick.
  useEffect(() => {
    const intervalMs = status === 'pending' ? 2500 : 10000;
    const timer = window.setInterval(() => {
      load({ silent: true });
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [load, status]);

  // Derived: list of cameras in the current sample set (for filter dropdown)
  const cameraOptions = useMemo(() => {
    const set = new Set();
    samples.forEach((s) => {
      const code = (s.metadata || s.metadata_json || {}).camera_code || s.camera_id;
      if (code) set.add(String(code));
    });
    return Array.from(set).sort();
  }, [samples]);

  // Apply client-side filters + sort
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = samples.filter((s) => {
      const meta = s.metadata || s.metadata_json || {};
      const code = String(meta.camera_code || s.camera_id || '');
      const name = String(meta.person_name || '').toLowerCase();
      const matchesQuery = !q
        || name.includes(q)
        || code.toLowerCase().includes(q)
        || String(s.track_id || '').toLowerCase().includes(q);
      const matchesCamera = cameraFilter === 'all' || code === cameraFilter;
      const matchesQuality = pctNum(s.quality_score) >= qualityMin;
      return matchesQuery && matchesCamera && matchesQuality;
    });

    const byTime    = (a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0);
    const byQuality = (a, b) => Number(b.quality_score || 0) - Number(a.quality_score || 0);
    const byMatch   = (a, b) => Number(b.similarity || 0) - Number(a.similarity || 0);

    if (sortBy === 'quality')      list = [...list].sort(byQuality);
    else if (sortBy === 'match')   list = [...list].sort(byMatch);
    else if (sortBy === 'oldest')  list = [...list].sort((a, b) => -byTime(a, b));
    else                           list = [...list].sort(byTime);

    return list;
  }, [samples, query, cameraFilter, qualityMin, sortBy]);

  const summary = useMemo(() => {
    const total = visible.length;
    const bestQuality = visible.reduce((max, item) => Math.max(max, Number(item.quality_score || 0)), 0);
    const bestSimilarity = visible.reduce((max, item) => Math.max(max, Number(item.similarity || 0)), 0);
    const avgQuality = total > 0
      ? visible.reduce((sum, item) => sum + Number(item.quality_score || 0), 0) / total
      : 0;
    return { total, bestQuality, bestSimilarity, avgQuality };
  }, [visible]);

  const filtersActive = query !== '' || cameraFilter !== 'all' || qualityMin !== 0 || sortBy !== 'newest';
  // Only the collapsed controls count toward the badge — search has its own
  // visible field and status is always on screen, so neither is a hidden
  // narrowing the badge needs to warn about.
  const hiddenFilterCount =
    (cameraFilter !== 'all' ? 1 : 0) + (qualityMin !== 0 ? 1 : 0) + (sortBy !== 'newest' ? 1 : 0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersBtnRef = useRef(null);
  const filtersPanelRef = useRef(null);

  // The phone filter panel floats, so it closes like a menu: Escape, or a
  // press anywhere outside it. Presses inside a Select's own list are not
  // "outside" — that list is portalled to <body>, away from the panel.
  useEffect(() => {
    if (!filtersOpen) return undefined;
    const onDown = (e) => {
      const t = e.target;
      if (filtersPanelRef.current?.contains(t) || filtersBtnRef.current?.contains(t)) return;
      if (t.closest?.('[data-radix-popper-content-wrapper]')) return;
      setFiltersOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setFiltersOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [filtersOpen]);

  const resetFilters = () => {
    setQuery('');
    setCameraFilter('all');
    setQualityMin(0);
    setSortBy('newest');
  };

  const approve = async (sample) => {
    setBusyId(sample.id);
    setError('');
    try {
      await api.post(`/ai/face-learning/samples/${sample.id}/approve`);
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || 'Approve failed.');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (sample) => {
    setBusyId(sample.id);
    setError('');
    try {
      await api.post(`/ai/face-learning/samples/${sample.id}/reject`, {
        reason: 'Rejected from operator review page',
      });
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || 'Reject failed.');
    } finally {
      setBusyId(null);
    }
  };

  // The same frame Face Watchlist, Camera Setup, Health, Playback and Map use,
  // so the title block, the gutter and the header → content rhythm are
  // inherited rather than re-derived here. The page is now three distinct
  // sections, as on Face Watchlist: a top-level header, one action bar, and a
  // single content card that owns the scroll.
  return (
    <OperationsPage>
      {/* ── 1. Page header ───────────────────────────────────────────────
          Title, description and the metric badges sit at the top level, on the
          page surface — not inside a card. This used to be a PageCard that
          wrapped the heading AND the KPI row, which made the metrics read as
          part of a panel and gave Face Learning a header built from different
          material than every other page's. The badges are the Watchlist's
          header-badge affordance, so "how many / how good" reads the same on
          both face pages. */}
      <PageHeader
        icon={GraduationCap}
        title="Teach faces"
        description={PAGE_DESCRIPTION}
        actions={
          <>
            <KpiGroup
              items={[
                { label: STATUS_META[status]?.label || status, short: 'Pend', value: summary.total, tone: 'amber' },
                { label: 'Avg quality', short: 'Avg qual', value: pctNum(summary.avgQuality), suffix: '%', tone: 'emerald' },
                { label: 'Best match',  short: 'Match',    value: pctNum(summary.bestSimilarity), suffix: '%', tone: 'emerald' },
              ]}
            />
            <PageAction onClick={load} disabled={loading} type="button">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={2} />
              Refresh
            </PageAction>
          </>
        }
      />

      <PageContent className="gap-4">
        {/* ── 2. Action & filter bar ──────────────────────────────────────
            Its own bar between the header and the content, where the Watchlist
            puts its upload tabs. It wears PageCard's treatment so the bar and
            the content card below are made of the same material; it used to be
            a band bled to the window edges with a bottom hairline, which cut
            the page in half and ignored the content gutter.

            One wrapping row. Below `md` the wrap points do the work of a
            hand-built mobile layout: search + Filters stay on line one because
            only search grows, and each `w-full` block below claims its own
            line. Above `md` everything collapses back to a single inline row. */}
        <PageCard as="div" className="shrink-0 p-3 sm:px-4 sm:py-3">
          {/* `relative`: the phone filter panel anchors to this row. */}
          <div className="relative flex flex-wrap items-center gap-2 md:gap-3">

            {/* Search — shares line one with the Filters toggle on phones. */}
            <div className="relative min-w-0 flex-1 md:min-w-[240px] md:max-w-[340px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" strokeWidth={2} />
              <input
                className="min-h-[38px] w-full rounded-lg border border-line bg-surface-sunken py-2.5 pl-9 pr-3 text-xs tracking-[-0.005em] outline-none transition focus:border-line-focus focus:bg-surface focus:ring-2 focus:ring-brand/25 md:h-9 md:py-0 md:text-body"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by person, camera, or track"
                value={query}
              />
            </div>

            {/* Filters toggle — phones only. The badge reports how many of the
                controls it hides are currently narrowing the list, so a filtered
                view is never silently collapsed out of sight. */}
            <button
              ref={filtersBtnRef}
              aria-controls="face-learning-filters"
              aria-expanded={filtersOpen}
              className={`inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold tracking-[-0.005em] transition-all duration-200 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 md:hidden ${
                filtersOpen || hiddenFilterCount ? BRAND_ON : BRAND_IDLE
              }`}
              onClick={() => setFiltersOpen((v) => !v)}
              type="button"
            >
              <SlidersHorizontal className="h-4 w-4" strokeWidth={2} />
              Filters
              {hiddenFilterCount ? (
                <span className="grid h-4 min-w-[16px] place-items-center rounded-full bg-brand px-1 text-[10px] font-bold tabular-nums text-white">
                  {hiddenFilterCount}
                </span>
              ) : null}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform duration-200 ${filtersOpen ? 'rotate-180' : ''}`}
                strokeWidth={2}
              />
            </button>

            {/* Status — full-width segmented control on its own line below `md`. */}
            <div className="grid w-full grid-cols-3 gap-1 rounded-lg bg-surface-muted p-1 md:inline-flex md:h-9 md:w-auto md:gap-0 md:p-0.5">
              {STATUS_TABS.map((item) => {
                const meta = STATUS_META[item.value];
                const Icon = meta.icon;
                const on = status === item.value;
                return (
                  <button
                    aria-pressed={on}
                    className={`inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold tracking-[-0.005em] transition-all duration-200 active:scale-95 md:h-8 md:min-h-0 md:justify-start md:text-small ${
                      on ? BRAND_ON : 'border-transparent text-fg-muted hover:border-brand/30 hover:bg-linear-to-r hover:from-brand/15 hover:to-brand-active/5 hover:text-brand-ink'
                    }`}
                    key={item.value}
                    onClick={() => setStatus(item.value)}
                    type="button"
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={on ? 2.25 : 1.85} />
                    {item.label}
                  </button>
                );
              })}
            </div>

            {/* Camera / quality / sort. Below `md` a menu-style panel that drops
                directly under the Filters toggle (right-aligned to it — the
                toggle sits at the row's right edge, so a left-aligned panel
                would run off a phone screen). `md:contents` dissolves the
                wrapper so the three controls rejoin the inline row instead of
                forming a nested group. */}
            <div
              ref={filtersPanelRef}
              className={`${filtersOpen ? 'grid' : 'hidden'} absolute right-0 top-[46px] z-50 w-64 max-w-full origin-top-right grid-cols-1 gap-2 rounded-xl border border-line bg-surface p-2 shadow-xl animate-in fade-in-0 zoom-in-95 duration-150 md:contents`}
              id="face-learning-filters"
            >
              <FilterSelect
                Icon={Video}
                value={cameraFilter}
                onChange={setCameraFilter}
                options={[
                  { value: 'all', label: 'All cameras' },
                  ...cameraOptions.map((c) => ({ value: c, label: c })),
                ]}
              />

              {/* Quality filter */}
              <FilterSelect
                Icon={ShieldCheck}
                value={qualityMin}
                onChange={(v) => setQualityMin(Number(v))}
                options={QUALITY_OPTIONS}
              />

              {/* Sort */}
              <FilterSelect
                Icon={ArrowDownNarrowWide}
                value={sortBy}
                onChange={setSortBy}
                options={SORT_OPTIONS}
              />

              {filtersActive ? (
                <button
                  className="inline-flex min-h-[38px] w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-caption font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken md:h-9 md:min-h-0 md:w-auto"
                  onClick={resetFilters}
                  type="button"
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
                  Reset
                </button>
              ) : null}
            </div>

            {/* Result count. `ml-auto` only once the row is inline, otherwise it
                would fight the wrap and strand itself mid-line. */}
            <span className="inline-flex w-full shrink-0 items-center gap-1.5 text-caption font-semibold tracking-[-0.005em] text-fg-muted md:ml-auto md:w-auto">
              <Filter className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="tabular-nums">{visible.length}</span>
              <span className="text-fg-subtle">of</span>
              <span className="tabular-nums">{samples.length}</span>
              <span>{samples.length === 1 ? 'sample' : 'samples'}</span>
            </span>
          </div>
        </PageCard>

        {/* ── 3. Content card ────────────────────────────────────────────
            The only card on the page, and it holds only the samples — the grid,
            the empty state, the spinner — exactly as the Watchlist's "Known
            faces" panel holds only the roster. The card is the scroll
            container, so the header and the filter bar stay put. */}
        <PageCard className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 w-full max-w-full flex-1 overflow-x-hidden overflow-y-auto p-3.5 sm:p-5">
            {/* Inside the scroll region and above the grid, so it reads as a note
                about these results rather than a bar bolted to the chrome. */}
            {error ? (
              <div
                className="mb-4 flex items-start gap-2.5 rounded-lg border border-danger-line bg-danger-soft px-3.5 py-3 text-body text-danger-ink"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
                <p className="font-medium leading-snug">{error}</p>
              </div>
            ) : null}

            {loading ? (
              <div className="grid h-64 place-items-center">
                <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-brand-line border-t-brand" />
              </div>
            ) : visible.length === 0 ? (
              <div className="flex h-full min-h-[350px] items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-line bg-surface text-fg-subtle">
                    <ScanFace className="h-7 w-7" strokeWidth={1.5} />
                  </div>
                  <p className="mt-4 text-body font-semibold tracking-[-0.005em] text-fg">
                    {samples.length === 0
                      ? `No ${STATUS_META[status]?.label.toLowerCase() || status} samples`
                      : 'No samples match these filters'}
                  </p>
                  <p className="mt-1 max-w-[42ch] text-small leading-[1.55] text-fg-muted">
                    {samples.length === 0
                      ? 'New samples appear after known people are matched from live cameras with enough quality.'
                      : 'Try resetting the camera, quality, or search filters above.'}
                  </p>
                  {samples.length > 0 && filtersActive ? (
                    <button
                      className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-small font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken"
                      onClick={resetFilters}
                      type="button"
                    >
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
                      Reset filters
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="grid w-full grid-cols-1 gap-3 min-[507px]:gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {visible.map((sample) => (
                  <SampleCard
                    key={sample.id}
                    sample={sample}
                    busy={busyId === sample.id}
                    onApprove={() => approve(sample)}
                    onReject={() => reject(sample)}
                  />
                ))}
              </div>
            )}
          </div>
        </PageCard>
      </PageContent>
    </OperationsPage>
  );
}

/**
 * The three header metrics — Pend / Avg qual / Match.
 *
 * Each one is its OWN tile at every width: sunken fill, hairline border,
 * rounded-lg. They used to merge into a single `surface-muted` pill above
 * 507px, which put a second surface inside what was then a header card — a
 * panel in a panel. As separate tiles they read as badges on the page header,
 * the same affordance the Face Watchlist header uses for its count.
 *
 * The wrapper is a plain wrapping row now. It was `contents` below 507px so
 * the tiles could join the old header's 2-up grid; the header's action row is
 * `flex-wrap`, so they wrap on their own and need no parent grid to borrow.
 */
function KpiGroup({ items }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 min-[1152px]:gap-3">
      {items.map((item) => (
        <div className="flex min-h-[38px] min-w-0 items-center gap-1.5 rounded-lg border border-line bg-surface-muted px-2.5 dark:border-line-strong dark:bg-surface-sunken min-[507px]:h-8 min-[507px]:min-h-0 min-[1152px]:h-10 min-[1152px]:gap-2 min-[1152px]:px-3" key={item.label}>
          <span className={`h-1.5 w-1.5 rounded-full ${
            item.tone === 'emerald' ? 'bg-success'
              : item.tone === 'amber' ? 'bg-warning'
                : item.tone === 'rose' ? 'bg-danger'
                  : item.tone === 'sky' ? 'bg-info'
                    : 'bg-neutral'
          }`} />
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-fg-muted min-[507px]:whitespace-nowrap min-[507px]:text-micro min-[507px]:tracking-[0.1em]">
            <span className="min-[1152px]:hidden">{item.short || item.label}</span>
            <span className="hidden min-[1152px]:inline">{item.label}</span>
          </span>
          <span className="ml-auto text-xs font-semibold tabular-nums text-fg min-[507px]:ml-0 min-[507px]:text-xs min-[507px]:font-semibold">
            {Number(item.value || 0).toLocaleString('en-IN')}
            {item.suffix ? <span className="ml-0.5 text-caption font-semibold text-fg-muted">{item.suffix}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A native <select> renders its option list through the OS, so the highlighted
 * row is Windows blue and no CSS can reach it. The shared Radix Select draws
 * its own menu, which means the open list follows the theme too — brand focus
 * ring on the trigger, `surface-muted` on the active row.
 *
 * Values cross the Radix boundary as strings; callers that need a number
 * (quality) already coerce on the way back, so nothing else changes.
 */
function FilterSelect({ Icon, value, onChange, options }) {
  return (
    <Select value={String(value)} onValueChange={onChange}>
      <SelectTrigger
        className="relative min-h-[38px] w-full gap-2 rounded-lg border-line bg-surface pl-8 text-xs font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken md:h-9 md:min-h-0 md:w-auto md:text-small"
        size="sm"
      >
        <Icon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" strokeWidth={2} />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={String(opt.value)} value={String(opt.value)}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SampleCard({ sample, busy, onApprove, onReject }) {
  const meta = sample.metadata || sample.metadata_json || {};
  const statusInfo = STATUS_META[sample.status] || STATUS_META.pending;
  const StatusIcon = statusInfo.icon;
  const qualityNum = pctNum(sample.quality_score);
  const matchNum = pctNum(sample.similarity);
  const decision = reviewDecision(sample);

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-line-strong hover:shadow-[0_4px_12px_rgba(15,23,42,0.06)]">
      <div className="relative aspect-[4/5] overflow-hidden bg-slate-950">
        <SampleImage sample={sample} />

        {/* Status pill (top-left) */}
        <span className={`absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-md border px-1.5 py-[3px] text-micro font-bold uppercase tracking-[0.06em] backdrop-blur-sm ${statusInfo.tone}`}>
          <StatusIcon className="h-3 w-3" strokeWidth={2.5} />
          {statusInfo.label}
        </span>

        {/* Quality badge (top-right) */}
        <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-[3px] text-micro font-bold uppercase tracking-[0.06em] text-white backdrop-blur-sm">
          <ShieldCheck className="h-3 w-3" strokeWidth={2.5} />
          {qualityNum}%
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-3.5">
        <span className={`w-fit rounded-md border px-2 py-1 text-micro font-bold uppercase tracking-[0.05em] ${decision.tone}`}>
          {decision.label}
        </span>
        <div className="min-w-0">
          <p className="truncate text-body font-semibold tracking-[-0.005em] text-fg">
            {cropLabel(sample)}
          </p>
          <p className="mt-0.5 truncate text-caption font-medium text-fg-muted">
            <span className="inline-flex items-center gap-1">
              <Video className="h-3 w-3 text-fg-subtle" strokeWidth={2} />
              {cameraCode(sample)}
            </span>
            <span className="mx-1.5 text-fg-disabled">·</span>
            {fmtTime(sample.occurred_at)}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <Metric label="Match" value={matchNum} tone="emerald" />
          <Metric label="Quality" value={qualityNum} tone="sky" />
          <Metric label="Detect" value={pctNum(sample.det_score)} tone="amber" />
        </div>

        {(meta.gender || sample.gender || sample.track_id || meta.face_px || meta.blur_var || meta.brightness) ? (
          <div className="grid grid-cols-2 gap-1.5">
            {sample.track_id ? (
              <InfoChip label="Track" value={String(sample.track_id).slice(0, 10)} />
            ) : null}
            {sample.gender ? (
              <InfoChip label="Gender" value={String(sample.gender)} />
            ) : null}
            {meta.face_px ? (
              <InfoChip label="Face px" value={String(Math.round(Number(meta.face_px)))} />
            ) : null}
            {meta.blur_var ? (
              <InfoChip label="Blur" value={String(Math.round(Number(meta.blur_var)))} />
            ) : null}
            {meta.brightness ? (
              <InfoChip label="Light" value={String(Math.round(Number(meta.brightness)))} />
            ) : null}
          </div>
        ) : null}

        <div className="mt-auto pt-1">
          {sample.status === 'pending' ? (
            <div className="grid grid-cols-2 gap-1.5">
              <button
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-line bg-surface text-small font-semibold tracking-[-0.005em] text-fg-secondary transition hover:bg-surface-sunken disabled:opacity-60"
                disabled={busy}
                onClick={onReject}
                type="button"
              >
                <ThumbsDown className="h-3.5 w-3.5" strokeWidth={2} />
                Reject
              </button>
              <button
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-brand text-small font-semibold tracking-[-0.005em] text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-60"
                disabled={busy}
                onClick={onApprove}
                type="button"
              >
                <UserCheck className="h-3.5 w-3.5" strokeWidth={2} />
                Approve
              </button>
            </div>
          ) : sample.reason ? (
            <p className="rounded-md bg-surface-sunken px-2.5 py-1.5 text-caption leading-[1.4] text-fg-muted">
              {sample.reason}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function SampleImage({ sample }) {
  const [containerRef, shouldLoad] = useInViewport();
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = null;
    setUrl(null);
    setFailed(false);
    if (!shouldLoad) return undefined;
    if (!sample.snapshot_uri) return undefined;

    api.get(`/ai/face-learning/samples/${sample.id}/snapshot`, {
      responseType: 'blob',
      timeout: 10000,
    })
      .then((res) => {
        if (!active) return;
        if (!res.data || Number(res.data.size || 0) === 0) {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(res.data);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sample.id, sample.snapshot_uri, reloadKey, shouldLoad]);

  if (!url) {
    return (
      <div ref={containerRef} className="absolute inset-0 grid place-items-center text-fg-muted">
        <div className="text-center">
          <ScanFace className="mx-auto h-7 w-7" strokeWidth={1.5} />
          <p className="mt-2 text-micro font-semibold uppercase tracking-[0.08em]">
            {!sample.snapshot_uri ? 'No snapshot' : failed ? 'Image failed' : shouldLoad ? 'Loading' : 'Queued'}
          </p>
          {failed ? (
            <button
              className="mt-2 rounded-md border border-line bg-surface px-2 py-1 text-caption font-semibold text-fg-secondary hover:bg-surface-sunken"
              onClick={() => setReloadKey((key) => key + 1)}
              type="button"
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <img ref={containerRef} src={url} alt="" className="absolute inset-0 h-full w-full bg-slate-950 object-contain" decoding="async" />
      <button
        className="absolute bottom-2.5 right-2.5 grid h-8 w-8 place-items-center rounded-md border border-line bg-surface/90 text-fg shadow-sm backdrop-blur-sm transition hover:bg-surface"
        onClick={() => setOpen(true)}
        title="View full image"
        type="button"
      >
        <Maximize2 className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(var(--app-vw)*0.96)] border-slate-700 bg-slate-950 p-0 text-white sm:max-w-[calc(var(--app-vw)*0.96)]">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle className="text-body font-semibold tracking-[-0.005em]">
              {cropLabel(sample)}
            </DialogTitle>
          </DialogHeader>
          <div className="relative flex max-h-[calc(var(--app-vh)*0.86)] items-center justify-center px-4 pb-4">
            <img src={url} alt="" className="max-h-[calc(var(--app-vh)*0.82)] max-w-full object-contain" />
            {/* Enhance affordance for blurry CCTV crops. FaceLearning is
                the most common place operators see borderline-quality
                faces — quick CodeFormer pass often pushes them from
                "reject" to "approve". */}
            {url ? (
              <div className="absolute bottom-6 right-6">
                <EnhanceFaceDialog imageUrl={url}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand hover:bg-brand-hover px-3 py-2 text-small font-bold text-white shadow-lg"
                    title="Clean up this face with CodeFormer + Real-ESRGAN"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Enhance face
                  </button>
                </EnhanceFaceDialog>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Metric({ label, value, tone = 'slate' }) {
  const v = Number(value) || 0;
  const accent = {
    emerald: 'text-success-ink bg-success-soft',
    sky:     'text-info-ink bg-info-soft',
    amber:   'text-warning-ink bg-warning-soft',
    slate:   'text-fg-secondary bg-surface-sunken',
  }[tone];
  return (
    <div className="rounded-md border border-line-subtle bg-surface px-2 py-1.5 text-center">
      <p className="text-micro font-semibold uppercase tracking-[0.1em] text-fg-subtle">{label}</p>
      <p className={`mt-0.5 inline-block rounded px-1 text-small font-bold tabular-nums tracking-[-0.005em] ${accent}`}>
        {v}%
      </p>
    </div>
  );
}

function InfoChip({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-md bg-surface-sunken px-2 py-1">
      <span className="text-micro font-semibold uppercase tracking-[0.08em] text-fg-subtle">{label}</span>
      <span className="truncate text-caption font-semibold tracking-[-0.005em] text-fg-secondary">{value}</span>
    </div>
  );
}
