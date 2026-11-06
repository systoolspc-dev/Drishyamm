import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Car, ChevronDown, ChevronRight, Clock, History, ScanSearch, Search,
  ShieldAlert, UserSearch, Video,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { useAuthStore } from '@/core/store/authStore';
import { useInvestigationStore } from '@/core/store/investigationStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import { toneClass } from '@/core/ui/tone';

/**
 * "Quick actions" — the dashboard's jumping-off point: one search box for an
 * investigation, six shortcuts to the jobs operators actually start from, and
 * (contextually, under the search box) a trail of what they last searched.
 *
 * Every `to` is a route that exists in App.jsx. Note `personlsearch` — the real
 * route carries that typo; "correcting" it here breaks the link. Items are
 * filtered through the shared entitlement rules so the panel never offers a
 * feature the account does not own (which the catch-all turns into a bounce to
 * /login).
 *
 * `tone` is purely for visual differentiation between the six shortcuts, not a
 * status signal — six distinct semantic tones so no two tiles share a colour.
 */
const ACTIONS = [
  { key: 'person',  title: 'Find a person',   desc: 'Search every camera for one person',  icon: UserSearch, tone: 'ai',      to: '/ai-event/personlsearch', feature: 'person_search', ai: true },
  { key: 'vehicle', title: 'Find a vehicle',  desc: 'Search by number plate',              icon: Car,        tone: 'info',    to: '/ai-analytics/vehicle',   feature: 'anpr',          ai: true },
  { key: 'event',   title: 'Live detections', desc: 'What the cameras are seeing now',     icon: ScanSearch, tone: 'warning', to: '/ai-feed',                feature: 'ai_feed',       ai: true },
  { key: 'live',    title: 'Watch live',      desc: 'See your cameras right now',          icon: Video,      tone: 'success', to: '/live' },
  { key: 'footage', title: 'Recordings',      desc: 'Watch what happened earlier',         icon: History,    tone: 'neutral', to: '/playback', featureAny: ['playback', 'cloud_recordings'] },
  { key: 'alerts',  title: 'Alerts',          desc: 'Things that need your attention',     icon: ShieldAlert, tone: 'danger', to: '/alerts', feature: 'alerts' },
];

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: '7d',    label: 'Last 7 days' },
  { id: '30d',   label: 'Last 30 days' },
];

// Icon + tone for recent-search rows, keyed by the action that produced them —
// so a "Find a Person" entry in the history carries the exact same violet as
// the "Find a Person" shortcut itself.
const ROW_ICONS = Object.fromEntries(ACTIONS.map((a) => [a.key, a.icon]));
const ROW_TONES = Object.fromEntries(ACTIONS.map((a) => [a.key, a.tone]));
// Short type label for a history row ("Person", "Vehicle") — the store's
// `kind` is the full action title ("Find a Person") or, for a free-text
// search, the literal word "Search"; neither reads well as a compact tag.
const ROW_LABELS = {
  person: 'Person',
  vehicle: 'Vehicle',
  event: 'Event',
  live: 'Live Camera',
  footage: 'Footage',
  alerts: 'Alert',
};

function rel(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// One line — icon, title, chevron. No description: six of these sit in a
// single row, and a second text line is what forced them into a cramped
// 3-column grid before.
//
// The resting border + shadow are LIGHT-THEME ONLY, and are what separate a
// tile from the panel it sits in there: `rounded-lg` keeps these out of the
// glass-card rule in index.css, so the tile fill is the same solid `bg-surface`
// as its parent and an untreated light tile had no edge of its own. The `dark:`
// resets put dark back to a borderless tile that only lifts on hover — the
// translucent glass panel already gives it an edge, and a shadow on near-black
// reads as grime rather than depth. The border WIDTH stays in both themes
// (transparent on dark) so nothing reflows when the theme flips.
function ActionTile({ action, onOpen }) {
  const Icon = action.icon;
  return (
    <button
      onClick={() => onOpen(action)}
      className="group flex items-center gap-2.5 rounded-lg border border-line bg-surface p-3 text-left shadow-sm transition hover:border-brand/50 hover:bg-brand/5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-transparent dark:shadow-none dark:hover:border-brand/50 dark:hover:shadow-sm"
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${toneClass(action.tone, 'soft')}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-small font-bold text-fg">{action.title}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-disabled transition group-hover:translate-x-0.5 group-hover:text-brand" />
    </button>
  );
}

export default function QuickActions({ sites = [] }) {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const items = useInvestigationStore((s) => s.items);
  const record = useInvestigationStore((s) => s.record);
  const clearHistory = useInvestigationStore((s) => s.clear);

  const [query, setQuery] = useState('');
  const [range, setRange] = useState(RANGES[0]);
  const [site, setSite]   = useState(null);      // null → all sites

  // Recent-searches dropdown: open while the input is focused and empty,
  // closed by Escape, a click outside, or picking a row. It never shows while
  // there's typed text — that's the user's own query in progress, and there's
  // no live-suggestion engine to blend it with.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchBoxRef = useRef(null);
  const inputRef = useRef(null);

  const historyVisible = historyOpen && query.trim() === '';

  useEffect(() => {
    if (!historyVisible) return;
    const onPointerDown = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [historyVisible]);

  const actions = useMemo(() => {
    const { aiOn, allows } = makeEntitlement(user);
    return ACTIONS.filter((a) => (a.ai ? aiOn && allows(a, true) : allows(a, false)));
  }, [user]);

  const open = (action) => {
    record({ key: action.key, kind: action.title, detail: action.desc, to: action.to });
    navigate(action.to);
  };

  // The AI feed is the one surface that spans people, vehicles, cameras and
  // events, so a free-text investigation starts there with the filters carried
  // in the URL. Shared by the form submit and by re-running a recent search.
  const performSearch = (q) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const params = new URLSearchParams({ q: trimmed, range: range.id });
    if (site) params.set('site', site.id);
    const to = `/ai-feed?${params}`;
    record({ key: 'event', kind: 'Search', detail: trimmed, to });
    setHistoryOpen(false);
    navigate(to);
  };

  const runSearch = (e) => {
    e.preventDefault();
    performSearch(query);
  };

  // A history row either replays a free-text search (populate + re-run with
  // the current filters) or continues a shortcut click (just open it) —
  // exactly what each row already recorded when it was created.
  const openRecent = (it) => {
    if (it.kind === 'Search') {
      setQuery(it.detail);
      performSearch(it.detail);
    } else {
      setHistoryOpen(false);
      navigate(it.to);
    }
  };

  const onSearchKeyDown = (e) => {
    if (!historyVisible || items.length === 0) {
      if (e.key === 'Escape') setHistoryOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      openRecent(items[activeIndex]);
    } else if (e.key === 'Escape') {
      setHistoryOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
      <h2 className="text-sm font-semibold text-fg sm:text-base">Quick actions</h2>

      {/* ── Investigation search ─────────────────────────────────────────── */}
      <form onSubmit={runSearch} className="mt-3 flex flex-wrap items-start gap-2">
        <div ref={searchBoxRef} className="relative min-w-[240px] flex-1">
          <label className="flex h-10 items-center gap-2 rounded-lg border border-line bg-surface-sunken px-3 transition focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/15">
            <Search className="h-4 w-4 shrink-0 text-fg-subtle" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={historyVisible}
              aria-controls="quick-actions-recent-searches"
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? `recent-search-opt-${activeIndex}` : undefined}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActiveIndex(-1); }}
              onFocus={() => { setHistoryOpen(true); setActiveIndex(-1); }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search a person, vehicle, camera, event or time…"
              className="min-w-0 flex-1 bg-transparent text-small font-medium text-fg placeholder:text-fg-subtle outline-none"
            />
          </label>

          {/* ── Recent searches — contextual, overlays in place so the six
              shortcuts below never shift down while it's open. ─────────── */}
          {historyVisible && (
            <div
              id="quick-actions-recent-searches"
              role="listbox"
              aria-label="Recent searches"
              className="absolute inset-x-0 top-full z-30 mt-1.5 rounded-lg border border-line bg-surface p-2 shadow-md"
            >
              <div className="mb-1 flex items-center gap-1.5 px-1.5 pt-0.5">
                <Clock className="h-3 w-3 text-fg-subtle" />
                <span className="text-caption font-bold text-fg-secondary">Recent searches</span>
              </div>

              {items.length === 0 ? (
                <p className="px-1.5 py-2 text-caption text-fg-subtle">
                  Your recent searches will appear here.
                </p>
              ) : (
                <>
                  <ul className="space-y-0.5">
                    {items.map((it, idx) => {
                      const Icon = ROW_ICONS[it.key] || Search;
                      const tone = ROW_TONES[it.key] || 'neutral';
                      const label = ROW_LABELS[it.key] || it.kind;
                      return (
                        <li key={`${it.kind}-${it.detail}-${it.ts}`} role="none">
                          <button
                            type="button"
                            id={`recent-search-opt-${idx}`}
                            role="option"
                            aria-selected={idx === activeIndex}
                            onMouseEnter={() => setActiveIndex(idx)}
                            onClick={() => openRecent(it)}
                            className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition ${
                              idx === activeIndex ? 'bg-brand/5' : 'hover:bg-surface-sunken'
                            }`}
                          >
                            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${toneClass(tone, 'soft')}`}>
                              <Icon className="h-3 w-3" />
                            </span>
                            <span className="min-w-0 flex-1 truncate text-caption">
                              <span className="font-bold text-fg">{label}</span>{' '}
                              <span className="text-fg-muted">
                                {it.detail ? `(${it.detail})` : ''} · {rel(it.ts)}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    type="button"
                    onClick={clearHistory}
                    className="mt-1 w-full rounded-md px-1.5 py-1 text-left text-caption font-medium text-fg-subtle transition hover:text-danger-ink"
                  >
                    Clear recent searches
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-small font-bold text-fg-secondary transition hover:bg-surface-sunken">
              {range.label} <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {RANGES.map((r) => (
              <DropdownMenuItem key={r.id} onClick={() => setRange(r)}>{r.label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-small font-bold text-fg-secondary transition hover:bg-surface-sunken">
              {site?.name || 'All Sites'} <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => setSite(null)}>All Sites</DropdownMenuItem>
            {sites.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => setSite(s)}>{s.name}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="submit"
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-5 text-small font-bold text-white shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!query.trim()}
        >
          <Search className="h-3.5 w-3.5" />
          Search
        </button>
      </form>

      {/* ── Shortcuts ────────────────────────────────────────────────────── */}
      {/* 3 columns (2 rows) — verified non-truncating at 1280/1440/1600/1920.
          A 6-across single row needs more width per tile than the sidebar +
          page padding leave even at 1920px, so it isn't a safe default. */}
      {actions.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-3">
          {actions.map((a) => (
            <ActionTile key={a.key} action={a} onOpen={open} />
          ))}
        </div>
      )}
    </section>
  );
}
