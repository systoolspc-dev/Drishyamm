/**
 * Journey Map — one person's route, as a topological flow.
 *
 * The 2D floor plan this page used to draw is gone. It answered "where on the
 * site" at the cost of everything else: a 400-sighting journey put 400 pins on
 * one plan, and the two facts an investigator actually reads — the GAPS in
 * coverage and the VIOLATIONS — were invisible under the pile.
 *
 * What replaces it is a chain. Contiguous sightings through one zone collapse
 * into a single card, so 400 sightings become a few dozen; the connector
 * between two cards goes dashed and carries a duration when the feed had a
 * hole; and a policy violation is never swallowed by a cluster at any zoom.
 *
 * All the derivation lives in `journey/journey-model.js`, which imports no
 * React and is covered by `npm test`. The Route Flow card is `<RoutePlayer>`:
 * it plays the sightings back as footage, clip after clip, and drives the same
 * `t` / `node` URL state the timeline and Route History read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Camera,
  Clock3,
  Hourglass,
  Download,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  Route,
  Search,
  Share2,
  ShieldCheck,
  UserRound,
} from 'lucide-react';

import { AI_BASE } from '@/core/config/endpoints';
import { PageIcon } from '@/core/layout/OperationsPage';
import { DEMO_FACE_PHOTO, DEMO_SUBJECT_FULL_NAME } from '@/core/demo/demoIdentity';
import RoutePlayer from './journey/RoutePlayer';
import TimeScrubber from './journey/TimeScrubber';
import RouteHistoryPanel from './journey/RouteHistoryPanel';
import {
  ORDER, buildNodes, buildTimeAxis, filterHistory, isTruncated, terminalNodes,
} from './journey/journey-model';

const SAMPLE_CLIP = '/demos/human-detection.mp4';

// The event cap we ask /journey/map for, and the one signal that a journey came
// back incomplete. The service keeps the OLDEST `limit` events, so a response
// that filled the cap is missing its most RECENT sightings — which is exactly
// the end this page leads with. See the banner below, and isTruncated().
const EVENT_LIMIT = 400;

const ORDER_KEY = 'journey-history-order';

const FALLBACK = {
  subject: {
    id: 'sample',
    full_name: DEMO_SUBJECT_FULL_NAME,
    external_id: 'Sample journey',
    role_label: 'Known',
    department: 'AI Events',
    photo_url: DEMO_FACE_PHOTO,
  },
  summary: {
    first_seen_label: '10:14 AM',
    last_seen_label: 'Live now',
    cameras_visited: 4,
    total_duration_label: '15 min',
    events: 4,
    alerts: 1,
    search_ms: 0,
  },
  // Sample clips are windows into the shared demo reel, so the route plays as
  // four different shots. If the reel is not deployed the player holds on each
  // sighting instead and carries on.
  stops: [
    { label: 'Main Gate - CAM 01', zone: 'Entry', first_seen_at: '2026-05-08T10:14:00Z', last_seen_at: '2026-05-08T10:14:34Z', duration_sec: 34, note: 'First seen at campus entry', type: 'start', x: 14, y: 70, clip_url: SAMPLE_CLIP, clip_start_sec: 0, clip_end_sec: 6 },
    { label: 'Reception - CAM 04', zone: 'Public Area', first_seen_at: '2026-05-08T10:18:00Z', last_seen_at: '2026-05-08T10:20:00Z', duration_sec: 120, note: 'Moved through reception', type: 'normal', x: 34, y: 54, clip_url: SAMPLE_CLIP, clip_start_sec: 6, clip_end_sec: 12 },
    { label: 'Office Floor - CAM 09', zone: 'Staff Area', first_seen_at: '2026-05-08T10:22:00Z', last_seen_at: '2026-05-08T10:27:00Z', duration_sec: 300, note: 'Waited near meeting room', type: 'normal', x: 56, y: 36, clip_url: SAMPLE_CLIP, clip_start_sec: 12, clip_end_sec: 18 },
    { label: 'Server Room - CAM 12', zone: 'Restricted', first_seen_at: '2026-05-08T10:29:00Z', last_seen_at: '2026-05-08T10:29:00Z', duration_sec: 0, note: 'Restricted area entry', type: 'alert', x: 78, y: 48, clip_url: SAMPLE_CLIP, clip_start_sec: 18, clip_end_sec: 24 },
  ],
  timeline: [],
};

export default function JourneyMap() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') || '');
  const [payload, setPayload] = useState(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // ── The two pieces of shared state, and only two ────────────────────────
  // `cursorMs` is the single idea of "now" -- the canvas and the history panel
  // each DERIVE their highlight from it. Giving either one its own index is
  // exactly how a synchronised timeline drifts out of sync.
  // `selectedNodeId` is a separate, explicit act: clicking a card is not the
  // same gesture as dragging through time.
  // Both live in the URL so an investigator can send a colleague the moment,
  // not just the person -- the pattern the Occupancy and Vehicle hubs use.
  const cursorParam = params.get('t');
  const cursorMs = cursorParam ? Number(cursorParam) : null;
  const selectedNodeId = params.get('node') || null;

  const [floor, setFloor] = useState('all');
  const [historyFilter, setHistoryFilter] = useState('all');

  // Which way Route History reads. A per-viewer PREFERENCE, so it is remembered
  // in localStorage and deliberately NOT in the URL: `t` and `node` carry what
  // you are looking at, which is what a shared link must reproduce; how you
  // sorted it is yours. Same split as siteStore.js draws.
  const [order, setOrderState] = useState(() => {
    try {
      return localStorage.getItem(ORDER_KEY) === ORDER.OLDEST_FIRST
        ? ORDER.OLDEST_FIRST
        : ORDER.NEWEST_FIRST;
    } catch { return ORDER.NEWEST_FIRST; }
  });
  const setOrder = useCallback((next) => {
    try { localStorage.setItem(ORDER_KEY, next); } catch { /* private mode */ }
    setOrderState(next);
  }, []);

  // Playback lives in the Timeline dock, the video lives in the Route Flow
  // card; the page holds what both need. `step` is what the player reports is
  // on screen -- Route History highlights it, the dock enables prev/next by it.
  const playerRef = useRef(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [step, setStep] = useState(null);

  const personId = params.get('person_id') || '';
  const cameraId = params.get('camera_id') || '';
  const trackId = params.get('track_id') || '';

  // Written with `replace` so scrubbing does not fill the back button with a
  // hundred history entries.
  const patchParams = useCallback((patch) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') next.delete(k);
        else next.set(k, String(v));
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const setCursor = useCallback((ms) => patchParams({ t: ms == null ? null : Math.round(ms) }), [patchParams]);
  const setSelected = useCallback((id) => patchParams({ node: id }), [patchParams]);
  // The player moves the clock and the selection as footage plays. Only the
  // keys it passes are touched, so a cursor write never clears the node.
  const syncPlayback = useCallback(({ t, node } = {}) => {
    const patch = {};
    if (t !== undefined) patch.t = t == null ? null : Math.round(t);
    if (node !== undefined) patch.node = node;
    patchParams(patch);
  }, [patchParams]);

  // Keyed on the VALUE of `q`, not on `params`: the cursor lives in the URL
  // too, and playback writes it every second -- depending on the whole params
  // object would refetch the journey (and reset the player) on every tick.
  const query = params.get('q') || '';

  useEffect(() => {
    setSearch(query);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadJourney() {
      setLoading(true);
      setError('');
      try {
        const url = new URL('/journey/map', AI_BASE);
        if (personId) url.searchParams.set('person_id', personId);
        if (cameraId && trackId) {
          url.searchParams.set('camera_id', cameraId);
          url.searchParams.set('track_id', trackId);
        }
        if (!personId && query) url.searchParams.set('q', query);
        url.searchParams.set('since_hours', '168');
        url.searchParams.set('limit', String(EVENT_LIMIT));

        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Journey failed (${response.status})`);
        const data = await response.json();
        setPayload(normalizeJourney(data));
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError('Journey service is not reachable. Showing sample route.');
        setPayload(FALLBACK);
      } finally {
        setLoading(false);
      }
    }
    loadJourney();
    return () => controller.abort();
  }, [personId, cameraId, trackId, query]);

  const subject = payload.subject;
  const stops = useMemo(() => payload.stops || [], [payload.stops]);

  // Floors come from the data or not at all. The picker appears only when the
  // feed actually describes more than one level -- inventing "Ground / First /
  // Second" for a single-storey site would be three tabs showing one route.
  const floors = useMemo(
    () => Array.from(new Set(stops.map((stop) => stop.floor || stop.level).filter(Boolean))),
    [stops],
  );

  const visibleStops = useMemo(
    () => (floor === 'all' ? stops : stops.filter((stop) => (stop.floor || stop.level) === floor)),
    [stops, floor],
  );

  // Derived, never stored. Clustering runs on the filtered stops so a floor
  // filter re-clusters rather than punching holes in cards drawn from all of
  // them -- a card that says "12 sightings" must contain twelve visible ones.
  const nodes = useMemo(() => buildNodes(visibleStops), [visibleStops]);
  const axis = useMemo(() => buildTimeAxis(nodes), [nodes]);

  // The journey's two ends, resolved BY TIME rather than by array position, so
  // "first seen" is still the earliest stop while the list reads newest-first.
  const { first: firstNode, last: lastNode } = useMemo(() => terminalNodes(nodes), [nodes]);
  const lastEndMs = lastNode ? lastNode.lastSeenMs ?? lastNode.firstSeenMs : null;
  // With no cursor placed the whole journey is in view, so both ends are
  // somewhere to go; otherwise a button is dead once the cursor is already there.
  const canFirst = Boolean(firstNode) && (cursorMs == null || cursorMs > firstNode.firstSeenMs);
  const canLast = Boolean(lastNode) && (cursorMs == null || cursorMs < lastEndMs);

  // A jump writes the cursor and the selection, and nothing else: RoutePlayer
  // already seeks when `cursorMs` changes (locateInPlaylist), and a second
  // imperative path to the same seek is how a player and a timeline drift
  // apart. A filter that would hide the target is cleared first — landing on a
  // row the list is not showing is a dead control.
  const jumpTo = useCallback((node) => {
    if (!node) return;
    if (historyFilter !== 'all' && !filterHistory([node], historyFilter).length) setHistoryFilter('all');
    patchParams({ t: Math.round(node.firstSeenMs), node: node.id });
  }, [historyFilter, patchParams]);

  // The service filled the event cap, so the newest sightings were dropped and
  // the top card is not necessarily the latest one. Say so, rather than letting
  // a newest-first list present a partial route as a whole one.
  const truncated = isTruncated(payload, EVENT_LIMIT);

  const latestStop = stops[stops.length - 1] || null;
  const hasJourney = stops.length > 0;
  const liveMonitor = latestStop?.camera_code || latestStop?.monitor_id || '';
  const playbackMonitor = liveMonitor;
  const playbackTime = latestStop?.first_seen_at || latestStop?.last_seen_at || '';

  // Derived from the same stops the chain renders, so the headline range can
  // never disagree with the first and last card.
  const { firstSeenLabel, lastSeenLabel, totalLabel } = useMemo(() => {
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) {
      return {
        firstSeenLabel: payload.summary?.first_seen_label || '--',
        lastSeenLabel: payload.summary?.last_seen_label || '--',
        totalLabel: payload.summary?.total_duration_label || '0 sec',
      };
    }
    const dwell = stops.reduce((total, stop) => total + Number(stop.duration_sec || 0), 0);
    // Elapsed across the route, not the sum of dwell times -- the two differ by
    // however long the walking took, which the connectors already show.
    const span = diffSeconds(first.first_seen_at, last.last_seen_at || last.first_seen_at);
    return {
      firstSeenLabel: formatTime(first.first_seen_at),
      lastSeenLabel: formatTime(last.last_seen_at || last.first_seen_at),
      totalLabel: durationLabel(Math.max(span, dwell)),
    };
  }, [payload.summary, stops]);

  const submitSearch = (event) => {
    event.preventDefault();
    const next = {};
    if (search.trim()) next.q = search.trim();
    setParams(next);
  };

  return (
    // The page is exactly the viewport under the app's 4rem top bar (a bare
    // h-screen would overflow by that bar and bring back the page scrollbar).
    // Everything inside is a flex column: fixed-height rows take what they
    // need, the workspace takes the rest, and only the history list scrolls.
    <div className="flex h-[calc(var(--app-vh)-4rem)] max-h-[calc(var(--app-vh)-4rem)] flex-col overflow-hidden bg-surface-app dark:bg-[#0d1117]">
      <div className="flex h-full min-h-0 flex-col gap-4 page-inset">
        {/* ── Header: title, search, actions — one row ─────────────────── */}
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <PageIcon icon={Route} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2.5">
                <h1 className="truncate text-xl font-bold leading-tight tracking-tight text-fg">Where they went</h1>
                {(loading || error) && (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${error ? 'border-warning-line bg-warning-soft text-warning-ink' : 'border-info-line bg-info-soft text-info-ink'}`}
                    role={error ? 'alert' : undefined}
                    title={error || 'Loading latest journey data'}
                  >
                    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    {loading ? 'Loading' : 'Sample route'}
                  </span>
                )}
              </div>
              <p className="mt-1 hidden max-w-[68ch] text-small text-fg-muted lg:block">
                Replay where one person went, camera by camera. Sightings through one zone collapse
                into a single stop; a dashed link means the cameras lost them.
              </p>
            </div>
          </div>

          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto">
            <form className="relative min-w-0 flex-1 sm:max-w-[220px]" onSubmit={submitSearch}>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
              <input
                className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-sm font-medium leading-normal outline-none focus:border-brand-line focus:ring-4 focus:ring-brand-line"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search person journey"
                value={search}
              />
            </form>
            <button className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-control font-medium leading-normal text-fg-secondary transition hover:bg-surface-sunken sm:px-3" title="Share" type="button">
              <Share2 className="h-4 w-4" />
              <span className="hidden sm:inline">Share</span>
            </button>
            <button className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-control font-medium leading-normal text-fg-secondary transition hover:bg-surface-sunken sm:px-3" title="Export" type="button">
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">Export</span>
            </button>
            {liveMonitor ? (
              <Link
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-control font-medium leading-normal text-white shadow-sm transition hover:bg-brand-hover sm:px-3"
                title="Open the last seen camera in Live View"
                to={`/live?monitor=${encodeURIComponent(liveMonitor)}`}
              >
                <Radio className="h-4 w-4" />
                <span className="hidden sm:inline">Live View</span>
              </Link>
            ) : (
              <button className="inline-flex h-9 shrink-0 cursor-not-allowed items-center gap-1.5 rounded-lg bg-brand-line px-2.5 text-control font-medium leading-normal text-white sm:px-3" disabled title="No live camera available" type="button">
                <Radio className="h-4 w-4" />
                <span className="hidden sm:inline">Live View</span>
              </button>
            )}
          </div>
        </header>

        {/* ── Profile bar: who, when, where, and the one action that follows
             from looking at a route — all on one line ──────────────────── */}
        <section className="flex w-full max-w-full shrink-0 flex-row flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 shadow-sm">
          <div className="flex min-w-0 items-center gap-2.5">
            <SubjectFace subject={subject} />
            <h2 className="truncate text-sm font-semibold leading-tight text-fg sm:text-base">{subject?.full_name || 'Unknown person'}</h2>
            {payload.summary?.alerts ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger-line bg-danger-soft px-2.5 py-0.5 text-xs font-medium leading-normal text-danger-ink">
                <AlertTriangle className="h-3 w-3" />
                Restricted area entry
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success-line bg-success-soft px-2.5 py-0.5 text-xs font-medium leading-normal text-success-ink">
                <ShieldCheck className="h-3 w-3" />
                No alert
              </span>
            )}
          </div>

          <div className="flex min-w-0 shrink flex-wrap items-center justify-end gap-2">
            <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2.5 py-1 text-xs font-medium leading-normal text-fg-secondary">
              <Clock3 className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
              <span className="whitespace-nowrap tabular-nums">{firstSeenLabel} – {lastSeenLabel}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2.5 py-1 text-xs font-medium leading-normal text-fg-secondary">
              <Camera className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
              <span className="whitespace-nowrap">{stops.length} sighting{stops.length === 1 ? '' : 's'}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 rounded-md border border-brand-line bg-brand-soft px-2.5 py-1 text-xs font-medium leading-normal text-brand-ink">
              <Hourglass className="h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="whitespace-nowrap tabular-nums">{totalLabel} total</span>
            </div>

            {playbackMonitor ? (
              <Link
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-control font-medium leading-normal text-fg-secondary transition hover:bg-surface-sunken"
                title="Open recorded video around this time"
                to={`/playback?monitor=${encodeURIComponent(playbackMonitor)}${playbackTime ? `&t=${encodeURIComponent(playbackTime)}` : ''}`}
              >
                <Play className="h-4 w-4" />
                Playback
              </Link>
            ) : (
              <button className="inline-flex h-8 shrink-0 cursor-not-allowed items-center gap-1.5 rounded-lg border border-line bg-surface-sunken px-3 text-control font-medium leading-normal text-fg-subtle" disabled title="No camera to play back" type="button">
                <Play className="h-4 w-4" />
                Playback
              </button>
            )}
          </div>
        </section>

        {/* ── Truncation notice ──────────────────────────────────────────
             The service caps at EVENT_LIMIT events and keeps the OLDEST ones,
             so a journey that filled the cap is missing its most recent
             sightings. That matters more now the list leads with the newest
             card: without this line, a partial route reads as a complete one
             and "last seen" reads as the truth. Remove once /journey/map
             orders newest-first before applying the limit. */}
        {truncated ? (
          <div
            className="flex shrink-0 items-start gap-2 rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-xs leading-snug text-warning-ink"
            role="status"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong className="font-semibold">Showing the earliest {EVENT_LIMIT} sightings.</strong>{' '}
              This journey reached the service limit, which keeps the oldest events — later
              sightings were not loaded, so the most recent stop below may not be the latest one.
            </span>
          </div>
        ) : null}

        {/* ── Workspace: the video beside the history ─────────────────────
             A flex row that takes whatever height the fixed rows leave. Both
             columns stretch to it, so their bottom edges line up exactly one
             gap above the Timeline dock. Below lg the two stack and the
             workspace scrolls rather than squeezing either: side by side at
             900px wide, a 384px history column left the video 262px wide. */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:flex-row lg:overflow-hidden">
          <main className="flex min-h-[320px] min-w-0 flex-1 flex-col lg:min-h-0">
            {/* Keyed on the route itself, so a new journey or a floor filter
                starts the player clean instead of mid-clip on a stale list. */}
            <RoutePlayer
              cursorMs={cursorMs}
              floor={floor}
              floors={floors}
              key={`${floor}:${nodes.length}:${nodes[0]?.id || ''}:${nodes[nodes.length - 1]?.id || ''}`}
              nodes={nodes}
              onFloor={setFloor}
              onPlayingChange={setPlaying}
              onSpeedChange={setSpeed}
              onStep={setStep}
              onSync={syncPlayback}
              playing={playing}
              ref={playerRef}
              selectedNodeId={selectedNodeId}
              speed={speed}
            />
          </main>

          <aside className="flex min-h-[320px] w-full shrink-0 flex-col lg:min-h-0 lg:w-80 xl:w-96">
            <RouteHistoryPanel
              activeNodeId={step?.nodeId ?? null}
              cursorMs={cursorMs}
              filter={historyFilter}
              nodes={nodes}
              onCursor={setCursor}
              onFilter={setHistoryFilter}
              onOrder={setOrder}
              onSelect={setSelected}
              order={order}
              playing={playing && !step?.ended}
              selectedNodeId={selectedNodeId}
            />
          </aside>
        </div>

        {/* ── Timeline dock: full width, one fixed-height row ─────────────── */}
        {hasJourney ? (
          <TimeScrubber
            axis={axis}
            canFirst={canFirst}
            canLast={canLast}
            cursorMs={cursorMs}
            nodes={nodes}
            onCursor={setCursor}
            onFirst={() => jumpTo(firstNode)}
            onLast={() => jumpTo(lastNode)}
            onSelect={setSelected}
            transport={{
              playing,
              speed,
              canPrev: (step?.index ?? 0) > 0,
              canNext: step ? step.index + 1 < step.len : false,
              onPrev: () => playerRef.current?.prev(),
              onNext: () => playerRef.current?.next(),
              onToggle: () => playerRef.current?.togglePlay(),
              onSpeed: setSpeed,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function normalizeJourney(data) {
  return {
    ...FALLBACK,
    ...data,
    subject: data.subject || FALLBACK.subject,
    summary: { ...FALLBACK.summary, ...(data.summary || {}) },
    stops: Array.isArray(data.stops) ? data.stops : [],
    timeline: Array.isArray(data.timeline) ? data.timeline : [],
  };
}

function diffSeconds(fromIso, toIso) {
  const a = fromIso ? new Date(fromIso).getTime() : NaN;
  const b = toIso ? new Date(toIso).getTime() : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 1000));
}

function durationLabel(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  if (s < 60) return `${Math.round(s)} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} hr ${rem} min` : `${h} hr`;
}

function SubjectFace({ subject }) {
  const [failed, setFailed] = useState(false);
  const src = subject?.photo_url || subject?.face_url || '';

  if (!src || failed) {
    return (
      <div
        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"
        title={subject?.full_name || 'Tracked person'}
      >
        {/* The same tile PageIcon draws, so the avatar and the page icon above
            it read as one family instead of two. */}
        <UserRound className="h-5 w-5" strokeWidth={2} />
      </div>
    );
  }
  return (
    <img
      alt={subject?.full_name || 'Tracked person'}
      className="h-10 w-10 shrink-0 rounded-xl object-cover ring-1 ring-line"
      onError={() => setFailed(true)}
      src={src}
    />
  );
}

function formatTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}
