import { useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, Building2, Camera, Car, Cctv, ChevronDown, ChevronRight,
  HardDrive, History, MonitorPlay, Plus, Sparkles,
  ShieldAlert, ShieldCheck,
  UserRound, UserSearch,
  AlertTriangle, Pin, Search, Clock, Tv, Video,
} from 'lucide-react';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { useDashboardStats } from '@/core/hooks/useDashboardStats';
import { useQuery } from '@tanstack/react-query';
import { useSearchStore } from '@/core/store/searchStore';
import { useInvestigationStore } from '@/core/store/investigationStore';
import { aiService, describe } from '@/core/services/ai';
import { MetricCard, MetricGrid } from '@/core/ui/metric-card';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';

const ORANGE = '#F7983A';

// ── Quick actions — the few things an operator opens the app to DO ──────────
//
// Deliberately NOT a second copy of the sidebar. The row this replaces listed
// ten feature areas and rendered whichever six came first in the array, so
// source order decided what a customer saw of their own product — and all ten
// were already sidebar rows.
//
// What earns a slot is a VERB, not a feature area: watch now, watch the wall,
// go back in time, find someone. Feature areas — Known people, People count,
// No-entry areas, Number plates, Staff activity, Reports — stay in the sidebar
// where they are browsed, not launched.
//
// Nothing here duplicates the metric cards below, which are already links:
// "Cameras working" opens Camera status, "Alerts today" opens Alerts, "Sites"
// opens Sites. State is navigable there; this row is for intent.
//
// Icons and labels are the sidebar's wherever the page has a sidebar row, so
// one action looks the same in both places. They all share one outline
// treatment: these are peers, and a filled pill among outlines reads as "start
// here", which overstates the case for any one of them. Order carries what
// little ranking is needed — live first, then recorded, then search.
const HOME_ACTIONS = [
  { to: '/live',                   label: 'Watch live',    icon: Cctv },
  { to: '/monitor-wall',           label: 'Video wall',    icon: Tv,         feature: 'monitor_wall' },
  { to: '/playback',               label: 'Recordings',    icon: History,    featureAny: ['playback', 'cloud_recordings'] },
  { to: '/ai-event/personlsearch', label: 'Find a person', icon: UserSearch, feature: 'person_search' },
  // Live per-camera people count. It has no sidebar row of its own — the
  // sidebar reaches it as `alsoActive` on Counting › People count — so the
  // label and icon come from the one existing affordance for it, the "Camera
  // Head Count" action on the Occupancy page. "Camera" is load-bearing: plain
  // "Head count" would read as the sidebar's People count, which is a
  // different page.
  { to: '/ai-event/headcount',     label: 'Camera head count', icon: Video,  feature: 'headcount' },
];

function HomeActions({ has, navigate }) {
  // No slice: the list is short by design, so entitlement is the only thing
  // deciding what shows and nothing falls silently off the end. Adding a row
  // is a deliberate edit here, never an array reshuffle.
  const actions = HOME_ACTIONS.filter(
    (a) => (a.featureAny ? a.featureAny.some(has) : !a.feature || has(a.feature)),
  );
  if (!actions.length) return null;

  return (
    <nav aria-label="Quick actions" className="mb-5 flex flex-wrap gap-2">
      {actions.map(({ to, label, icon: Icon }) => (
        <button
          key={to}
          type="button"
          onClick={() => navigate(to)}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-4 text-small font-semibold text-fg-secondary transition hover:border-brand/40 hover:bg-brand/5 hover:text-brand-ink"
        >
          <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
          {label}
        </button>
      ))}
    </nav>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────────

function Card({ children, className = '' }) {
  return (
    <section className={`rounded-xl border border-line bg-surface shadow-[0_4px_20px_rgba(15,23,42,0.04)] ${className}`}>
      {children}
    </section>
  );
}

// ── Live thumbnail tile (real stream, not stock photo) ──────────────────────

function CameraTile({ camera, onClick, pinned, onTogglePin }) {
  const status = camera?.status || 'offline';
  const isOnline = status === 'online';
  return (
    <div
      className={`group relative block aspect-video w-full overflow-hidden rounded-lg bg-slate-950 text-left ring-1 transition cursor-pointer
        ${pinned ? 'ring-2 ring-brand' : 'ring-line hover:ring-2 hover:ring-brand/40'}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
    >
      {isOnline ? (
        <DirectStreamPlayer
          monitorId={camera.monitorId}
          mode="webrtc"
          quality="low"
          aiOverlay={false}
          digitalZoom={false}
          muted
          controls={false}
          qualityControl={false}  /* thumbnail — no quality gear over the status chip */
          protocolBadge={false}   /* the tile draws its own name + status chip */
          className="absolute inset-0 w-full h-full"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-muted">
          <div className="flex flex-col items-center gap-2 text-fg-subtle">
            <Camera className="h-8 w-8" />
            <span className="text-micro font-bold uppercase tracking-widest">Offline</span>
          </div>
        </div>
      )}

      {/* Top overlay — name + status chip + pin button. The status chip is
          hover-only: at rest the tile is just the picture and its name, so a
          wall of tiles reads as video rather than as a field of badges. */}
      <div className="absolute left-2 top-2 right-2 z-10 flex items-start justify-between gap-2">
        <p className="pointer-events-none truncate rounded bg-black/55 px-2 py-1 text-small font-bold text-white backdrop-blur-sm">
          {camera?.name || 'Camera'}
        </p>
        <div className="flex items-center gap-1.5">
          <span className={`pointer-events-none inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-micro font-bold opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${
            isOnline ? 'bg-success/90 text-white' : 'bg-slate-500/90 text-white'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full bg-surface ${isOnline ? 'animate-pulse' : ''}`} />
            {isOnline ? 'LIVE' : 'OFF'}
          </span>
          {onTogglePin && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
              title={pinned ? 'Unpin' : 'Pin to top'}
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full backdrop-blur-sm transition ${
                pinned
                  ? 'bg-brand text-white shadow-md'
                  : 'bg-black/55 text-white opacity-0 group-hover:opacity-100 hover:bg-black/75'
              }`}
            >
              {pinned ? <Pin className="h-3 w-3 fill-white" /> : <Pin className="h-3 w-3" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

function HourBars({ counts }) {
  // 24 slots, current hour highlighted. Bars auto-scale to peak hour.
  //
  // Every hour draws a full-height TRACK and the value sits inside it. The old
  // version gave empty hours a 2%-tall grey bar, which read as debris floating
  // on no baseline rather than as "nothing happened at 03:00". The hour labels
  // also used to live inside each column, so a labelled column was shorter than
  // its neighbours and the baseline came out ragged — they now sit in their own
  // axis row underneath.
  const max = Math.max(1, ...counts);
  const now = new Date().getHours();
  return (
    <div className="flex h-full min-h-[8rem] flex-col">
      <div className="flex flex-1 items-end gap-[3px]">
        {counts.map((c, h) => {
          const isCurrent = h === now;
          return (
            <div
              key={h}
              className="group flex h-full flex-1 items-end overflow-hidden rounded-sm bg-surface-sunken"
              title={`${pad2(h)}:00 — ${c} ${c === 1 ? 'event' : 'events'}`}
            >
              {c > 0 && (
                <div
                  className="w-full rounded-sm transition-all duration-300 group-hover:opacity-80"
                  style={{
                    height: `${Math.max(4, (c / max) * 100)}%`,
                    backgroundColor: isCurrent ? ORANGE : '#fbbf77',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-[3px]">
        {counts.map((_, h) => (
          <div key={h} className="flex-1 text-center">
            {h % 6 === 0 ? (
              <span className={`text-micro font-mono ${h === now ? 'font-bold text-brand' : 'text-fg-subtle'}`}>
                {pad2(h)}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// Percentages that always add up to exactly 100.
//
// Rounding each share on its own overflows or undershoots the circle (187 of
// 200 rounds to 94%, 13 rounds to 7% — 101% total), and the overflow wrapped
// past the start of the ring, showing the empty track through as grey gaps.
// Largest-remainder hands the leftover points to the biggest fractions, so the
// arcs close the ring and the legend adds up to 100%.
function wholePercents(values) {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (!total) return values.map(() => 0);
  const exact  = values.map((v) => (v / total) * 100);
  const out    = exact.map(Math.floor);
  const byFrac = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  let left = 100 - out.reduce((sum, v) => sum + v, 0);
  for (let k = 0; k < byFrac.length && left > 0; k += 1, left -= 1) out[byFrac[k].i] += 1;
  return out;
}

function DonutChart({ mix }) {
  const segments = [
    { label: 'Recognized', key: 'match',    color: '#10b981' },
    { label: 'Unknown',    key: 'unknown',  color: '#f59e0b' },
    { label: 'Alerts',     key: 'alert',    color: '#ef4444' },
    { label: 'Other',      key: 'other',    color: '#94a3b8' },
  ].map((s) => ({ ...s, value: mix?.[s.key] || 0 }));

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const pcts  = wholePercents(segments.map((s) => s.value));
  const withPct = segments.map((s, i) => ({ ...s, pct: pcts[i] }));

  let offset = 25;
  return (
    // `w-full` so the chart fills the card (its parent is a flex row, which
    // would otherwise shrink it to content and pin it to the left). Below `xl`
    // the card is full-width, so the donut + legend pair is centred and the
    // legend capped at `max-w-xs` rather than stretched across the card.
    <div className="flex w-full flex-col items-center gap-5 sm:flex-row sm:justify-center sm:gap-8 xl:gap-6">
      <div className="relative h-36 w-36 shrink-0">
        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
          <circle cx="60" cy="60" r="42" fill="none" stroke="var(--surface-muted)" strokeWidth="16" />
          {withPct.map((s) => {
            if (!s.pct) return null;
            const dash = `${s.pct} ${100 - s.pct}`;
            const node = (
              <circle key={s.label} cx="60" cy="60" r="42" fill="none"
                stroke={s.color} strokeWidth="16"
                strokeDasharray={dash} strokeDashoffset={-offset} />
            );
            offset += s.pct;
            return node;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums text-fg">{total}</span>
          <span className="text-micro font-semibold uppercase tracking-wide text-fg-muted">today</span>
        </div>
      </div>
      {/* Categories with nothing in them stay on the list — "0 alerts today" is
          the answer an operator came for — but they recede so the eye lands on
          the rows that actually carry today's traffic. */}
      <div className="w-full max-w-xs flex-1 space-y-2">
        {withPct.map((s) => (
          <div key={s.label} className={`flex items-center justify-between gap-3 ${s.value ? '' : 'opacity-45'}`}>
            <span className="inline-flex items-center gap-2 text-small font-semibold text-fg-secondary">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
            <span className="text-small font-mono tabular-nums text-fg-muted">
              {s.value} <span className="text-fg-subtle">({s.pct}%)</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Snapshot thumbnail (real frame from when the event was detected) ───────
//
// Each AI event has a `snapshot_uri` pointing to S3/MinIO. The browser can't
// fetch it directly; we ask the backend for a 1h presigned URL and cache it
// per event id so the same row across multiple panels reuses the same fetch.
function useSnapshotUrl(eventId) {
  return useQuery({
    queryKey: ['ai-snapshot', eventId],
    queryFn: () => aiService.getSnapshotUrl(eventId).then((d) => d?.url || null).catch(() => null),
    enabled: !!eventId,
    staleTime: 30 * 60_000,    // presigned URL is valid 1h, cache 30m
    cacheTime: 60 * 60_000,
  });
}

function EventThumb({ eventId, snapshotUri, fallbackIcon: FallbackIcon, fallbackTint, className = '' }) {
  // s3:// crops (vms_face detections) stream straight from MinIO via the
  // byte-relay; only local ai_events fall back to the presigned fetch.
  const directSrc = aiService.snapshotSrc(snapshotUri);
  const { data: fetchedUrl } = useSnapshotUrl(!directSrc && snapshotUri ? eventId : null);
  const url = directSrc || fetchedUrl;
  if (!url) {
    return (
      <div className={`flex items-center justify-center bg-surface-muted ${className}`}>
        <FallbackIcon className="w-4 h-4" style={{ color: fallbackTint }} />
      </div>
    );
  }
  return (
    <div className={`overflow-hidden bg-surface-muted ${className}`}>
      <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
    </div>
  );
}

// ── Activity items ──────────────────────────────────────────────────────────

// Compact byte formatter — picks the right suffix automatically, 1 decimal
// past KB. Used by the Storage card so the card renders correctly whether the
// disk is 200 GB or 10 PB without a per-card rule.
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1e15) return `${(v / 1e15).toFixed(1)} PB`;
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)} TB`;
  if (v >= 1e9)  return `${(v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6)  return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3)  return `${(v / 1e3).toFixed(0)} KB`;
  return `${v} B`;
}

function fmtRel(iso) {
  if (!iso) return '—';
  // Clamp at 0: the AI hosts run a few seconds ahead of the browser clock, and
  // an event stamped in the future rendered as "-2s ago".
  const d = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 60)    return `${Math.floor(d)}s ago`;
  if (d < 3600)  return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(iso).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
}

function eventIcon(kind) {
  const k = String(kind || '').toLowerCase();
  if (k.includes('alert')) return ShieldAlert;
  if (k.includes('match')) return UserRound;
  if (k.includes('vehicle')) return Car;
  return Activity;
}

function eventColor(kind) {
  const k = String(kind || '').toLowerCase();
  if (k.includes('alert')) return '#ef4444';
  if (k.includes('match')) return '#10b981';
  return ORANGE;
}

function ActivityRow({ event, cameraLabels }) {
  const eventKind = event.kind || event.action || event.eventType;
  const Icon  = eventIcon(eventKind);
  const color = eventColor(eventKind);
  const matchedName = event.payload?.matchedName || event.name || event.person_name || event.full_name;
  const name  = matchedName || (String(eventKind || '').includes('alert') ? 'Alert' : 'Detection');
  // Resolve the monitor hash to the name the operator gave the camera. Events
  // carry the hash in any of these fields depending on which service wrote
  // them, and printing it raw ("demolocalcam0000000001") tells nobody where
  // this happened. Fall back to the hash only when the camera isn't in the
  // group list any more.
  const monitor = event.monitorId || event.monitor_id || event.camera_code || '';
  const where = cameraLabels?.[monitor]?.name || event.cameraName || monitor;
  const when = event.ts || event.occurred_at || event.timestamp || event.createdAt;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-subtle bg-surface p-2 transition hover:border-line hover:bg-surface-sunken/60">
      <EventThumb
        eventId={event.id}
        snapshotUri={event.snapshot_uri || event.snapshotUri || event.snapshotKey}
        fallbackIcon={Icon}
        fallbackTint={color}
        className="h-10 w-14 shrink-0 rounded-md ring-1 ring-line"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-bold text-fg">{name}</p>
        <p className="truncate text-caption font-medium text-fg-muted">{where || event.camera_id?.slice(0, 8) || '—'}</p>
      </div>
      <span className="text-micro font-mono tabular-nums text-fg-muted shrink-0">{fmtRel(when)}</span>
    </div>
  );
}

// ── Tab pill (Live Overview tab navigation) ────────────────────────────────
function TabPill({ label, Icon, active, onClick, accent }) {
  // `accent` lights up the Smart tab in primary orange even when inactive,
  // signalling it as the recommended/default view.
  const base = 'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-small font-bold transition';
  if (active) {
    return (
      <button onClick={onClick} className={`${base} bg-brand text-white shadow-sm`}>
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </button>
    );
  }
  if (accent) {
    return (
      <button
        onClick={onClick}
        className={`${base} border border-brand/30 bg-brand/10 text-brand-hover hover:bg-brand/20`}
      >
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </button>
    );
  }
  return (
    <button onClick={onClick} className={`${base} bg-surface-muted text-fg-secondary hover:bg-line`}>
      {Icon && <Icon className="h-3 w-3" />}
      {label}
    </button>
  );
}

// ── Camera preferences (pinning + most-watched intelligence) ────────────────
//
// Persisted in localStorage so prefs survive reloads. Two keys:
//   dashboard.pinnedCameras → ["monitorId", ...]
//   dashboard.cameraViews   → { "monitorId": { count: N, lastAt: ms } }
//
// "Smart" tab score = view-count × exp(-daysSinceLastView / 14).
// Half-life of 14 days means a camera viewed once two weeks ago weighs ~half
// of what it did when fresh — keeps the list adaptive without forgetting too
// fast.
const PIN_KEY = 'dashboard.pinnedCameras';
const VIEW_KEY = 'dashboard.cameraViews';
const VIEW_HALF_LIFE_DAYS = 14;

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota etc — silently ignore */ }
}

function useCameraPreferences() {
  const [pinned, setPinned] = useState(() => new Set(readJSON(PIN_KEY, [])));
  const [views,  setViews]  = useState(() => readJSON(VIEW_KEY, {}));

  const togglePin = useCallback((id) => {
    if (!id) return;
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      writeJSON(PIN_KEY, Array.from(next));
      return next;
    });
  }, []);

  const recordView = useCallback((id) => {
    if (!id) return;
    setViews((prev) => {
      const cur = prev[id] || { count: 0, lastAt: 0 };
      const next = { ...prev, [id]: { count: cur.count + 1, lastAt: Date.now() } };
      writeJSON(VIEW_KEY, next);
      return next;
    });
  }, []);

  // Recency-weighted score for "most watched" sorting
  const scoreOf = useCallback((id) => {
    const v = views[id];
    if (!v || !v.count) return 0;
    const days = Math.max(0, (Date.now() - v.lastAt) / (1000 * 60 * 60 * 24));
    return v.count * Math.exp(-days / VIEW_HALF_LIFE_DAYS);
  }, [views]);

  const viewCountOf = useCallback((id) => views[id]?.count || 0, [views]);

  return { pinned, togglePin, views, recordView, scoreOf, viewCountOf };
}

// ── Main ─────────────────────────────────────────────────────────────────────

// "Activity by Hour" reads the same fetched event pool as everything else on
// the dashboard (useDashboardStats already normalizes it) and re-buckets it
// into 24 hourly counts for whichever day is selected — no second API call.
// Hour-of-day only makes sense for a single day, so the choices are Today and
// Yesterday, not the week/month ranges other filters on this page use.
const HOUR_RANGES = [
  { id: 'today',     label: 'Today',     daysAgo: 0 },
  { id: 'yesterday', label: 'Yesterday', daysAgo: 1 },
];

function bucketEventsByHour(events, daysAgo) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  dayStart.setDate(dayStart.getDate() - daysAgo);
  const startMs = dayStart.getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;

  const counts = new Array(24).fill(0);
  let total = 0;
  for (const e of events) {
    const t = new Date(e.ts || e.occurred_at || e.timestamp || e.createdAt || 0).getTime();
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    counts[new Date(t).getHours()] += 1;
    total += 1;
  }
  return { counts, total };
}

export default function Dashboard() {
  const navigate     = useNavigate();
  const stats        = useDashboardStats();
  // Account switches: a card or button never leads to a page this account
  // does not have (it would only bounce back here).
  const user         = useAuthStore((s) => s.user);
  const { has, aiOn } = makeEntitlement(user);
  const goIf         = (key, to) => (has(key) ? () => navigate(to) : undefined);

  const [hourRange, setHourRange] = useState(HOUR_RANGES[0]);
  const hourly = useMemo(
    () => bucketEventsByHour(stats.events || [], hourRange.daysAgo),
    [stats.events, hourRange],
  );
  const peakHour = useMemo(
    () => hourly.counts.indexOf(Math.max(...hourly.counts)),
    [hourly.counts],
  );

  // Camera preferences — pin & most-watched intelligence (persisted in localStorage)
  const { pinned, togglePin, recordView, scoreOf, viewCountOf } = useCameraPreferences();

  // Live Overview state — active tab + search query
  // tab: 'all' | 'pinned' | 'recent' | <groupId>
  // "All" applies smart sorting implicitly (pinned → most-watched → online → offline).
  // The query itself is typed into the navbar search box, so it comes from the
  // shared store rather than local state.
  const [activeTab, setActiveTab] = useState('all');
  const searchQuery    = useSearchStore((s) => s.query);
  const setSearchQuery = useSearchStore((s) => s.setQuery);
  const recordInvestigation = useInvestigationStore((s) => s.record);

  // Build the unique group list straight from cameras' groupId mapping
  const groupTabs = useMemo(() => {
    const seen = new Map();
    for (const c of stats.cameraList) {
      if (c.groupId && !seen.has(c.groupId)) {
        seen.set(c.groupId, c.group?.name || c.groupName || 'Group');
      }
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [stats.cameraList]);

  const pinnedCount = useMemo(
    () => stats.cameraList.filter((c) => pinned.has(c.monitorId)).length,
    [stats.cameraList, pinned],
  );
  const recentCount = useMemo(
    () => stats.cameraList.filter((c) => viewCountOf(c.monitorId) > 0).length,
    [stats.cameraList, viewCountOf],
  );

  // Filter + sort the camera list based on tab and search query.
  //   smart  → pinned cams first, then top scored by recency-weighted views,
  //            then fill with online cams. Capped at 8.
  //   all    → all cameras, pinned floated to top.
  //   pinned → only pinned.
  //   recent → only cameras with view-count > 0, sorted by score desc.
  //   group  → only cameras in that group, pinned floated to top.
  const filteredCameras = useMemo(() => {
    const all = stats.cameraList;
    const q = searchQuery.trim().toLowerCase();
    const matchesQuery = (c) => {
      if (!q) return true;
      return (
        c.name?.toLowerCase().includes(q) ||
        c.groupName?.toLowerCase().includes(q) ||
        c.group?.name?.toLowerCase().includes(q) ||
        c.monitorId?.toLowerCase().includes(q) ||
        c.host?.toLowerCase().includes(q)
      );
    };

    // Smart sort applied implicitly to a list — pinned first, then most-watched
    // (recency-weighted), then online fill, then offline fill.
    const smartSort = (list) => {
      const pinnedList = list.filter((c) =>  pinned.has(c.monitorId));
      const watched    = list
        .filter((c) => !pinned.has(c.monitorId) && viewCountOf(c.monitorId) > 0)
        .slice()
        .sort((a, b) => scoreOf(b.monitorId) - scoreOf(a.monitorId));
      const seen      = new Set([...pinnedList, ...watched].map((c) => c.monitorId));
      const onlineFill  = list.filter((c) => !seen.has(c.monitorId) && c.status === 'online');
      const offlineFill = list.filter((c) => !seen.has(c.monitorId) && c.status !== 'online');
      return [...pinnedList, ...watched, ...onlineFill, ...offlineFill];
    };

    let pool;
    if (activeTab === 'pinned') {
      pool = all.filter((c) => pinned.has(c.monitorId));
    } else if (activeTab === 'recent') {
      pool = all
        .filter((c) => viewCountOf(c.monitorId) > 0)
        .slice()
        .sort((a, b) => scoreOf(b.monitorId) - scoreOf(a.monitorId));
    } else if (activeTab === 'all') {
      pool = smartSort(all);
    } else {
      // group tab — same smart sort applied within the group
      pool = smartSort(all.filter((c) => c.groupId === activeTab));
    }

    return pool.filter(matchesQuery).slice(0, 8);
  }, [activeTab, searchQuery, stats.cameraList, pinned, scoreOf, viewCountOf]);

  const handleCameraOpen = (camera) => {
    recordView(camera.monitorId);
    const to = `/live?monitor=${encodeURIComponent(camera.monitorId)}`;
    // Also leaves a row in Quick actions → Recent investigations.
    recordInvestigation({ key: 'live', kind: 'Live View', detail: camera.name || camera.monitorId, to });
    navigate(to);
  };

  // System Health rolls the fleet into one word: alerts outrank offline
  // cameras, because an alert is something to act on now.
  const health = stats.alertsActive > 0
    ? { label: 'Attention', tone: 'danger',  sub: `${stats.alertsActive} alert${stats.alertsActive > 1 ? 's' : ''} need attention` }
    : stats.offline > 0
      ? { label: 'Degraded', tone: 'warning', sub: `${stats.offline} camera${stats.offline > 1 ? 's' : ''} offline` }
      : { label: 'Healthy',  tone: 'success', sub: 'All systems operational' };

  const onlinePct = stats.cameras ? Math.round((stats.online / stats.cameras) * 100) : 0;
  // Per-account cloud usage (this account's recordings in the 10 PB tier) —
  // not the server's disk, which is shared by every customer (prod 2026-10-15).
  const cloud = (stats.storage && stats.storage.cloud) || null;
  const storageCritical = Boolean(cloud && cloud.usedRatio > 0.85);

  return (
    <div className="min-h-[var(--app-vh)] bg-surface-app page-inset text-fg">
      {/* No page header — the greeting, search, Add Camera and Refresh all live
          in the global Navbar, so the page opens straight on the actions. */}

      <HomeActions has={has} navigate={navigate} />


      {/* ── Metric cards (real numbers from useDashboardStats) ─────────── */}
      <MetricGrid cols={6} className="mb-5">
        <MetricCard
          icon={Camera} tone="success"
          label="Cameras working"
          value={stats.loading ? '—' : `${stats.online} / ${stats.cameras}`}
          sub={`${onlinePct}% online`}
          onClick={goIf('camera_health', '/health')}
        />
        {/* Detections only exist with the AI+VMS plan. */}
        {aiOn && (
          <MetricCard
            icon={Sparkles} tone="brand"
            label="Detections today" value={stats.loading ? '—' : stats.eventsToday}
            sub={`${stats.detectionMix.match} recognised · ${stats.detectionMix.unknown} unknown`}
            onClick={goIf('alerts', '/alerts')}
          />
        )}
        <MetricCard
          icon={ShieldAlert} tone="danger"
          label="Alerts today" value={stats.loading ? '—' : stats.alertsActive}
          sub={stats.alertsActive ? 'Need a look' : 'All clear'}
          alert={stats.alertsActive > 0}
          onClick={goIf('alerts', '/alerts')}
        />
        <MetricCard
          icon={Building2} tone="info"
          label="Sites" value={stats.loading ? '—' : stats.sites}
          sub={`${stats.sitesOnline} online`}
          onClick={goIf('camera_setup', '/sites')}
        />
        <MetricCard
          icon={HardDrive} tone={storageCritical ? 'danger' : 'info'}
          label="Cloud Storage"
          value={cloud ? fmtBytes(cloud.usedBytes) : (stats.storage ? fmtBytes(stats.storage.usedBytes) : null)}
          sub={cloud
            ? `of ${cloud.tierLabel || fmtBytes(cloud.tierBytes)} · ${cloud.objects.toLocaleString()} clip${cloud.objects === 1 ? '' : 's'}`
            : (stats.storage ? 'Cloud usage unavailable' : 'Not available')}
          alert={storageCritical}
        />
        <MetricCard
          icon={ShieldCheck} tone={health.tone}
          label="Overall" value={health.label} alert
          sub={health.sub}
          onClick={goIf('camera_health', '/health')}
        />
      </MetricGrid>

      {/* ── Main grid: live wall on the left, alerts + fleet on the right ── */}
      <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* Live Overview — REAL camera streams as thumbnails */}
        <Card className="p-4">
          <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-fg sm:text-base">Your cameras</h2>
              <p className="mt-0.5 text-caption text-fg-muted">
                {activeTab === 'all'    && 'Pinned + most-watched cameras surfaced first'}
                {activeTab === 'pinned' && 'Cameras you have pinned'}
                {activeTab === 'recent' && 'Cameras you watch most often'}
                {!['all','pinned','recent'].includes(activeTab) && 'Cameras in this group'}
              </p>
            </div>
            <div className="flex items-center gap-1.5 self-start lg:self-center">
              {has('monitor_wall') ? (
                <>
                  <button
                    onClick={() => navigate('/monitor-wall')}
                    title="Open the video wall — many cameras on one screen"
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-3 text-caption font-bold text-brand-hover transition hover:border-brand/40 hover:bg-brand/15"
                  >
                    <Tv className="h-3 w-3" />
                    Video wall
                  </button>
                  <span className="h-3 w-px bg-line" aria-hidden />
                </>
              ) : null}
              <button
                onClick={() => navigate('/live')}
                className="inline-flex items-center gap-0.5 text-caption font-bold text-brand hover:text-brand-hover"
              >
                Watch live <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Filtering is driven by the navbar search box (shared searchStore),
              so the card carries the tabs only. */}
          {searchQuery && (
            <div className="mb-3 flex items-center gap-2 rounded-lg bg-brand/10 px-3 py-2 text-small font-semibold text-brand-ink">
              <Search className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Filtered by "{searchQuery}"</span>
              <button
                onClick={() => setSearchQuery('')}
                className="ml-auto shrink-0 text-caption font-bold text-brand-hover hover:underline"
              >
                Clear
              </button>
            </div>
          )}

          {/* Tabs — All / Pinned / Recent / Groups (All is implicitly smart-sorted) */}
          <div className="mb-4 flex flex-wrap gap-1">
            <TabPill
              label={`All (${stats.cameras})`}
              active={activeTab === 'all'}
              onClick={() => setActiveTab('all')}
            />
            {pinnedCount > 0 && (
              <TabPill
                label={`Pinned (${pinnedCount})`}
                Icon={Pin}
                active={activeTab === 'pinned'}
                onClick={() => setActiveTab('pinned')}
              />
            )}
            {recentCount > 0 && (
              <TabPill
                label={`Recent (${recentCount})`}
                Icon={Clock}
                active={activeTab === 'recent'}
                onClick={() => setActiveTab('recent')}
              />
            )}
            {groupTabs.map((g) => (
              <TabPill
                key={g.id}
                label={g.name}
                active={activeTab === g.id}
                onClick={() => setActiveTab(g.id)}
              />
            ))}
          </div>

          {filteredCameras.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-fg-muted">
              {searchQuery ? (
                <>
                  <Search className="h-10 w-10 mb-2 text-fg-disabled" />
                  <p className="text-body font-bold">No cameras match "{searchQuery}"</p>
                  <p className="text-small mt-1">Try a different search term or switch tab.</p>
                  <button onClick={() => setSearchQuery('')} className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-4 text-small font-bold text-fg-secondary hover:bg-surface-sunken">
                    Clear search
                  </button>
                </>
              ) : activeTab === 'pinned' ? (
                <>
                  <Pin className="h-10 w-10 mb-2 text-fg-disabled" />
                  <p className="text-body font-bold">No pinned cameras yet</p>
                  <p className="text-small mt-1">Hover over any camera tile and click the pin icon to add it here.</p>
                </>
              ) : activeTab === 'recent' ? (
                <>
                  <Clock className="h-10 w-10 mb-2 text-fg-disabled" />
                  <p className="text-body font-bold">Nothing watched yet</p>
                  <p className="text-small mt-1">Open a camera to start building your most-watched list.</p>
                </>
              ) : (
                <>
                  <Camera className="h-10 w-10 mb-2 text-fg-disabled" />
                  <p className="text-body font-bold">No cameras yet</p>
                  {has('camera_setup') ? (
                    <>
                      <p className="text-small mt-1">Add a camera or recorder to start watching.</p>
                      <button onClick={() => navigate('/devices')} className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-small font-bold text-white">
                        <Plus className="h-3.5 w-3.5" /> Add camera
                      </button>
                    </>
                  ) : (
                    <p className="text-small mt-1">Your cameras will appear here once they are connected.</p>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="grid gap-2.5 md:grid-cols-2 2xl:grid-cols-4">
              {filteredCameras.map((camera) => (
                <CameraTile
                  key={camera.monitorId}
                  camera={camera}
                  pinned={pinned.has(camera.monitorId)}
                  onTogglePin={() => togglePin(camera.monitorId)}
                  onClick={() => handleCameraOpen(camera)}
                />
              ))}
            </div>
          )}
        </Card>

        {/* ── Recent Alerts — REAL. Stretches to the Live Overview's height so
               the row has no dead space under it. ─────────────────────────── */}
        <Card className="flex h-full flex-col p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-danger" />
              <h2 className="text-sm font-semibold text-fg sm:text-base">Recent Alerts</h2>
            </div>
            <button onClick={() => navigate('/alerts')} className="text-small font-bold text-brand hover:text-brand-hover">
              All
            </button>
          </div>
          {stats.recentAlerts.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center text-small text-fg-subtle">
              <ShieldCheck className="h-7 w-7 text-success" />
              <span className="font-semibold text-success-ink">No active alerts</span>
              <span>All systems green.</span>
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {stats.recentAlerts.map((alert) => {
                // Same view-model the Alerts page uses, so an event is worded
                // and coloured identically in both places.
                const vm = describe(alert, stats.cameraLabels);
                const critical = vm.tone === 'critical';
                return (
                  <button
                    key={alert.id}
                    onClick={() => navigate('/alerts')}
                    className={`flex w-full items-center gap-2.5 rounded-lg border p-2 text-left transition ${
                      critical
                        ? 'border-danger-line bg-danger-soft/50 hover:bg-danger-soft'
                        : 'border-warning-line bg-warning-soft/50 hover:bg-warning-soft'
                    }`}
                  >
                    <EventThumb
                      eventId={alert.id}
                      snapshotUri={alert.snapshot_uri || alert.snapshotUri || alert.snapshotKey}
                      fallbackIcon={AlertTriangle}
                      fallbackTint={vm.theme.hex}
                      className={`h-12 w-14 shrink-0 rounded-md ring-1 ${critical ? 'ring-danger-line' : 'ring-warning-line'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-small font-bold text-fg">{vm.title}</p>
                      <p className="truncate text-micro font-medium text-fg-muted">{vm.cameraLabel}</p>
                      <p className="mt-0.5 text-micro font-mono text-fg-muted">
                        {fmtRel(alert.ts || alert.occurred_at || alert.timestamp || alert.createdAt)}
                        {alert.repeatCount > 1 && (
                          <span className={`ml-1.5 font-sans font-bold ${critical ? 'text-danger-ink' : 'text-warning-ink'}`}>
                            ×{alert.repeatCount}
                          </span>
                        )}
                      </p>
                    </div>
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${critical ? 'animate-pulse bg-danger' : 'bg-warning'}`} />
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* ── Analytics row: hourly load, detection split, latest detections ──
          The three cards stretch to a common height, so each one is a flex
          column whose body claims the leftover space (`flex-1`). Without that
          the chart and the donut kept their intrinsic height and the bottom
          third of both cards sat empty while the activity list set the height.
          The headers are deliberately identical — title, one context line, one
          action — so the three read as one row rather than three widgets. */}
      {/* AI analytics only exist with the AI+VMS plan. */}
      {aiOn && (
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="flex flex-col p-4">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-fg sm:text-base">Activity by Hour</h2>
              <p className="text-small font-medium text-fg-muted mt-0.5">{hourRange.label} · all cameras · {hourly.total} AI events</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-small font-bold text-fg-muted transition hover:bg-surface-sunken">
                  {hourRange.label} <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                {HOUR_RANGES.map((r) => (
                  <DropdownMenuItem key={r.id} onClick={() => setHourRange(r)}>{r.label}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex flex-1 flex-col">
            <HourBars counts={hourly.counts} />
            {/* The axis already prints 00 / 06 / 12 / 18, so the old
                "00:00 … 23:59" footer restated it. Peak hour is the thing an
                operator actually scans this card for. */}
            <p className="mt-3 text-caption font-medium text-fg-subtle">
              {hourly.total > 0
                ? `Peak at ${pad2(peakHour)}:00 · ${hourly.counts[peakHour]} events`
                : `No activity recorded ${hourRange.label.toLowerCase()}`}
            </p>
          </div>
        </Card>

        <Card className="flex flex-col p-4">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-fg sm:text-base">Detection Mix</h2>
              <p className="text-small font-medium text-fg-muted mt-0.5">Today · {stats.eventsToday} total</p>
            </div>
            <button onClick={() => navigate('/alerts')} className="shrink-0 text-small font-bold text-brand hover:text-brand-hover">
              View all
            </button>
          </div>
          <div className="flex flex-1 items-center">
            <DonutChart mix={stats.detectionMix} />
          </div>
        </Card>

        {/* Recent AI activity — REAL events from /ai/events */}
        <Card className="flex flex-col p-4">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-fg sm:text-base">Recent AI Activity</h2>
              <p className="text-small font-medium text-fg-muted mt-0.5">Newest first · across all cameras</p>
            </div>
            <button onClick={() => navigate('/alerts')} className="shrink-0 text-small font-bold text-brand hover:text-brand-hover">
              View all
            </button>
          </div>
          {stats.recentEvents.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
              <MonitorPlay className="h-8 w-8 text-fg-disabled" />
              <p className="text-body font-bold text-fg-muted">No recent activity</p>
              <p className="text-small text-fg-subtle">AI detections will appear here</p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col gap-2">
              {stats.recentEvents.slice(0, 4).map((event) => (
                <ActivityRow key={event.id} event={event} cameraLabels={stats.cameraLabels} />
              ))}
            </div>
          )}
        </Card>
      </div>
      )}
    </div>
  );
}
