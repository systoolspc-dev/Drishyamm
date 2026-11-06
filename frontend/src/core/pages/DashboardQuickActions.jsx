import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ScanFace, ScanSearch, Users, ShieldAlert, Car,
  UsersRound, ClipboardList, GraduationCap, UserSearch, Radar, Route,
  Footprints, Ban, FlameKindling, Flame, Video, AlarmClock, MapPin, Camera,
  Search, CalendarDays, ChevronDown, ArrowRight, PlayCircle, AlertTriangle,
  Clock, Check,
} from 'lucide-react';
import { useAuthStore } from '@/core/store/authStore';
import { useGroups } from '@/core/hooks/useQueries';
import { makeEntitlement } from '@/core/nav/entitlements';

/**
 * "Quick actions" — the dashboard's front door: one omnibox for starting an
 * investigation, six big destinations for the jobs operators do all day, and
 * the trail of what this operator searched most recently.
 *
 * Everything here is filtered through the same entitlement rules as the
 * sidebar (core/nav/entitlements.js) so the two never tell a different story,
 * and every `to` is a route that exists in App.jsx. Note `personlsearch` —
 * the real route carries that typo; "correcting" it here breaks the link.
 *
 * The full feature list this panel used to render as grouped pills is still
 * here, behind the "All tools" disclosure in the header — the six cards are
 * the common path, not the only one.
 */

const ORANGE = '#F7983A';

// ── The six headline actions ────────────────────────────────────────────────
//
// `ai: true` puts an item under the AI entitlement rules — a curated account
// only sees it when its `feature` is on the account. The grid is responsive,
// so an account that owns four of these gets a balanced row of four rather
// than four cards and two holes.
const ACTIONS = [
  {
    key: 'person', label: 'Find a Person', desc: 'Search and track a person',
    icon: UserSearch, tint: '#6366f1', to: '/ai-event/personlsearch',
    feature: 'person_search', ai: true,
  },
  {
    key: 'vehicle', label: 'Find a Vehicle', desc: 'Search number plates',
    icon: Car, tint: '#3b82f6', to: '/ai-analytics/vehicle',
    feature: 'anpr', ai: true,
  },
  {
    key: 'event', label: 'Investigate an Event', desc: 'Analyse AI detections',
    icon: Radar, tint: ORANGE, to: '/event-logs',
  },
  {
    key: 'live', label: 'View Live Cameras', desc: 'Watch real-time feeds',
    icon: Video, tint: '#10b981', to: '/live',
  },
  {
    key: 'footage', label: 'Search Footage', desc: 'Browse recorded video',
    icon: PlayCircle, tint: '#06b6d4', to: '/playback',
  },
  {
    key: 'alerts', label: 'View Alerts', desc: 'Check active alerts',
    icon: AlertTriangle, tint: '#ef4444', to: '/alerts',
  },
];

// ── Everything else, grouped by the job it does (the "All tools" drawer) ────
const USE_CASES = [
  {
    key: 'identity',
    job: 'Know who is here',
    why: 'Recognise people against your own gallery',
    icon: ScanFace,
    tint: '#8b5cf6',
    items: [
      { label: 'Face Watchlist', desc: 'Manage the gallery', icon: UsersRound,    to: '/watchlist',         feature: 'face_watchlist' },
      { label: 'Attendance',     desc: 'Who came in, when',  icon: ClipboardList, to: '/attendance-report', feature: 'activity' },
      { label: 'Face Learning',  desc: 'Improve accuracy',   icon: GraduationCap, to: '/face-learning',     feature: 'face_detection' },
    ],
  },
  {
    key: 'find',
    job: 'Find someone',
    why: 'Search the footage, then follow them camera to camera',
    icon: ScanSearch,
    tint: '#3b82f6',
    items: [
      { label: 'Personnel Search', desc: 'Search by person', icon: UserSearch, to: '/ai-event/personlsearch', feature: 'person_search' },
      { label: 'Person Tracker',   desc: 'Trace a route',    icon: ScanSearch, to: '/person-tracker',         feature: 'person_tracker' },
      { label: 'Live Tracker',     desc: 'Who is where now', icon: Radar,      to: '/live-tracker',           feature: 'person_tracker' },
      { label: 'Journey Map',      desc: 'Path over time',   icon: Route,      to: '/ai-event/journeymap',    feature: 'journey_map' },
    ],
  },
  {
    key: 'occupancy',
    job: 'See how busy it is',
    why: 'Live counts, footfall and crowding per space',
    icon: Users,
    tint: '#0ea5e9',
    items: [
      { label: 'Head Count', desc: 'People per camera', icon: Users,      to: '/ai-event/headcount', feature: 'headcount' },
    ],
  },
  {
    key: 'safety',
    job: 'Keep the site safe',
    why: 'Alerts the moment something happens, not a recording to find later',
    icon: ShieldAlert,
    tint: '#ef4444',
    items: [
      { label: 'Zone Breaches',   desc: 'Intrusion history', icon: Ban,          to: '/occupancy/breaches', feature: 'restricted_zone' },
      { label: 'Weapon',          desc: 'Checkpoint watch', icon: ShieldAlert,   to: '/ai-analytics/weapon',     feature: 'weapon' },
      { label: 'Fire',            desc: 'Smoke and flame',  icon: FlameKindling, to: '/ai-analytics/fire',       feature: 'fire' },
      { label: 'Aggression',      desc: 'Scuffles, fights', icon: Flame,         to: '/ai-analytics/aggression', feature: 'aggression' },
    ],
  },
  {
    key: 'vehicles',
    job: 'Vehicles and plates',
    why: 'Read number plates at gates and lanes',
    icon: Car,
    tint: '#2563eb',
    items: [
      { label: 'ANPR / Vehicles', desc: 'Plate reads', icon: Car, to: '/ai-analytics/vehicle', feature: 'anpr' },
    ],
  },
];

/** Core VMS — no AI, so it survives on a basic account. `map` stays taggable. */
const EVERYDAY = {
  key: 'everyday',
  job: 'Everyday',
  why: 'The things you open most',
  icon: Video,
  tint: '#64748b',
  items: [
    { label: 'Live View',  desc: 'All cameras',    icon: Video,      to: '/live' },
    { label: 'Playback',   desc: 'Find a moment',  icon: AlarmClock, to: '/playback' },
    { label: 'Map',        desc: 'Sites on a map', icon: MapPin,     to: '/map', feature: 'map' },
    { label: 'Add Camera', desc: 'Connect device', icon: Camera,     to: '/devices' },
  ],
};

// ── The day being investigated ──────────────────────────────────────────────
//
// A single day, not a range: the event log (and the activity service behind
// it) filters by one calendar day, so offering "last 7 days" here would be a
// control that silently does nothing. The chosen day rides along as `date`,
// which is exactly the key the Event Log seeds itself from.

/** IST day key — matches what the Event Log's date filter expects. */
function dayKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function todayKey() { return dayKey(Date.now()); }
function yesterdayKey() { return dayKey(Date.now() - 86_400_000); }

function dayLabel(key) {
  if (key === todayKey()) return 'Today';
  if (key === yesterdayKey()) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// ── Query intent ────────────────────────────────────────────────────────────
//
// Indian plates: 2 letters, 1-2 digits, 0-3 letters, 1-4 digits (MH12AB1234,
// GJ01AB1234, DL8CAF5031). Separators are stripped before the test, so
// "GJ 01 AB 1234" and "GJ-01-AB-1234" both resolve.
const PLATE_RE = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;

function normalizePlate(q) {
  return String(q || '').toUpperCase().replace(/[\s-]/g, '');
}
function looksLikePlate(q) {
  const p = normalizePlate(q);
  return p.length >= 6 && PLATE_RE.test(p);
}

// ── Recent investigations ───────────────────────────────────────────────────
//
// This operator's own trail on this device — what they searched and where it
// took them, so a half-finished investigation is one click away tomorrow.
// Nothing here is invented: a row exists only because the operator ran that
// search or opened that action from this panel.
const RECENT_KEY = 'dashboard.recentInvestigations';
const RECENT_MAX = 12;

function readRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(raw) ? raw.filter((r) => r && r.to && r.label) : [];
  } catch { return []; }
}
function writeRecents(rows) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(rows.slice(0, RECENT_MAX))); }
  catch { /* quota etc — the trail is a convenience, never a blocker */ }
}

function relativeTime(ms) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Icons can't be persisted, so a recent row stores an icon *key* and these
// maps turn it back into a component + tint on read.
const ROW_ICONS = {
  person: UserSearch, vehicle: Car, event: Radar,
  live: Video, footage: PlayCircle, alerts: AlertTriangle, camera: Camera,
};
const ROW_TINTS = {
  person: '#6366f1', vehicle: '#3b82f6', event: ORANGE,
  live: '#10b981', footage: '#06b6d4', alerts: '#ef4444', camera: '#64748b',
};

// ── Small building blocks ───────────────────────────────────────────────────

function Dropdown({ icon: Icon, label, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-9 max-w-[170px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-[12px] font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7983A]"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className="truncate">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-30 mt-1.5 max-h-64 w-52 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {options.map((opt) => (
            <li key={opt.value}>
              <button
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] font-medium transition hover:bg-slate-50 ${
                  opt.value === value ? 'text-slate-900' : 'text-slate-600'
                }`}
              >
                <span className="truncate">{opt.label}</span>
                {opt.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-[#F7983A]" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Day picker — Today / Yesterday / any calendar day. Deliberately a single day
 * rather than a range, because that is what the destination pages can honour.
 */
function DayPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const presets = [
    { value: todayKey(), label: 'Today' },
    { value: yesterdayKey(), label: 'Yesterday' },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-[12px] font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7983A]"
      >
        <CalendarDays className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className="truncate">{dayLabel(value)}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1.5 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          {presets.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium transition hover:bg-slate-50 ${
                opt.value === value ? 'text-slate-900' : 'text-slate-600'
              }`}
            >
              <span className="truncate">{opt.label}</span>
              {opt.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-[#F7983A]" />}
            </button>
          ))}
          <label className="mt-1 block border-t border-slate-100 px-2.5 pb-1 pt-2">
            <span className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Pick a day
            </span>
            <input
              type="date"
              value={value}
              max={todayKey()}
              onChange={(e) => { if (e.target.value) { onChange(e.target.value); setOpen(false); } }}
              className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1 text-[12px] font-medium text-slate-700 outline-none focus:border-[#F7983A]"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function ActionCard({ action, onOpen }) {
  const Icon = action.icon;
  return (
    <button
      type="button"
      onClick={() => onOpen(action)}
      className="group flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-4 text-center transition hover:-translate-y-0.5 hover:border-[#F7983A]/40 hover:shadow-[0_6px_20px_rgba(15,23,42,0.07)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7983A]"
    >
      <span
        className="flex h-10 w-10 items-center justify-center rounded-xl transition group-hover:scale-105"
        style={{ backgroundColor: `${action.tint}1a`, color: action.tint }}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="block text-[13px] font-bold leading-tight text-slate-900">{action.label}</span>
      <span className="block text-[11px] font-medium leading-tight text-slate-500">{action.desc}</span>
    </button>
  );
}

function Pill({ item, tint, onOpen }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onOpen(item.to)}
      title={item.desc}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 transition-colors duration-200 hover:border-[#F7983A]/50 hover:bg-[#F7983A]/5 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7983A]"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: tint }} />
      <span className="truncate">{item.label}</span>
    </button>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function DashboardQuickActions() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  // Same query key the dashboard's stats hook already uses, so the suggestion
  // list rides on that cache instead of costing a second round trip.
  const { data: groups = [] } = useGroups({ refetchInterval: 30_000 });

  const [query, setQuery] = useState('');
  const [day, setDay] = useState(() => todayKey());
  const [site, setSite] = useState('all');
  const [openSuggest, setOpenSuggest] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [showAllTools, setShowAllTools] = useState(false);
  const [showAllRecents, setShowAllRecents] = useState(false);
  const [recents, setRecents] = useState(() => readRecents());

  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const entitlement = useMemo(() => makeEntitlement(user), [user]);
  const { aiOn, allows } = entitlement;

  // Six cards, minus whatever this account does not own.
  const actions = useMemo(
    () => ACTIONS.filter((a) => (a.ai ? aiOn && allows(a, true) : allows(a, false))),
    [aiOn, allows],
  );

  // The "All tools" drawer — drop a whole group when the account owns none of
  // it, rather than rendering an empty heading; an empty group reads as broken.
  const toolGroups = useMemo(() => {
    const ai = aiOn
      ? USE_CASES
          .map((g) => ({ ...g, items: g.items.filter((it) => allows(it, true)) }))
          .filter((g) => g.items.length)
      : [];
    const everyday = { ...EVERYDAY, items: EVERYDAY.items.filter((it) => allows(it, false)) };
    return everyday.items.length ? [...ai, everyday] : ai;
  }, [aiOn, allows]);

  const siteOptions = useMemo(() => ([
    { value: 'all', label: 'All Sites' },
    ...groups.map((g) => ({ value: String(g.id), label: g.name || `Site ${g.id}` })),
  ]), [groups]);

  const siteLabel = siteOptions.find((o) => o.value === site)?.label || 'All Sites';

  // Cameras in scope — the site picker narrows what the omnibox can resolve to.
  const cameras = useMemo(() => (
    groups
      .filter((g) => site === 'all' || String(g.id) === site)
      .flatMap((g) => (g.cameras || []).map((c) => ({ ...c, siteName: g.name })))
  ), [groups, site]);

  // Params every destination gets: the query plus the window the operator
  // picked, so a page that reads them opens already scoped.
  const scopeParams = useCallback((q) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    p.set('date', day);
    if (site !== 'all') p.set('site', site);
    return p.toString();
  }, [day, site]);

  const remember = useCallback((row) => {
    setRecents((prev) => {
      const key = `${row.to}|${row.label}`;
      const next = [
        { ...row, at: Date.now() },
        ...prev.filter((r) => `${r.to}|${r.label}` !== key),
      ];
      writeRecents(next);
      return next.slice(0, RECENT_MAX);
    });
  }, []);

  const go = useCallback((row) => {
    remember(row);
    setOpenSuggest(false);
    navigate(row.to);
  }, [navigate, remember]);

  // ── Suggestions ───────────────────────────────────────────────────────────
  const suggestions = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const lower = q.toLowerCase();
    const out = [];

    if (looksLikePlate(q) && actions.some((a) => a.key === 'vehicle')) {
      const plate = normalizePlate(q);
      out.push({
        iconKey: 'vehicle', label: plate, hint: 'Open vehicle profile',
        to: `/ai-analytics/vehicle/profile/${encodeURIComponent(plate)}`, meta: plate,
      });
    }

    for (const c of cameras) {
      if (out.length >= 5) break;
      const name = c.name || c.monitorId || '';
      if (!name.toLowerCase().includes(lower)) continue;
      out.push({
        iconKey: 'camera', label: name,
        hint: c.siteName ? `Live view · ${c.siteName}` : 'Open live view',
        to: `/live?monitor=${encodeURIComponent(c.monitorId)}`, meta: 'Live',
      });
    }

    if (actions.some((a) => a.key === 'person')) {
      out.push({
        iconKey: 'person', label: `Find “${q}”`, hint: 'Personnel search',
        to: `/ai-event/personlsearch?${scopeParams(q)}`, meta: q,
      });
    }

    out.push({
      iconKey: 'event', label: `Events matching “${q}”`,
      hint: `Event log · ${dayLabel(day).toLowerCase()}`,
      to: `/event-log?${scopeParams(q)}`, meta: q,
    });

    return out.slice(0, 8);
  }, [query, cameras, actions, scopeParams, day]);

  useEffect(() => {
    if (!openSuggest) return undefined;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpenSuggest(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [openSuggest]);

  const runSearch = useCallback(() => {
    const q = query.trim();
    if (!q) { inputRef.current?.focus(); setOpenSuggest(true); return; }
    const pick = suggestions[cursor] || suggestions[0];
    if (pick) { go(pick); return; }
    go({
      iconKey: 'event', label: `Events matching “${q}”`, hint: 'Event log',
      to: `/event-log?${scopeParams(q)}`, meta: q,
    });
  }, [query, suggestions, cursor, go, scopeParams]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setOpenSuggest(true);
      setCursor((c) => (c + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setCursor((c) => (c - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    } else if (e.key === 'Escape') {
      setOpenSuggest(false);
    }
  };

  const openAction = useCallback((action) => {
    go({
      iconKey: action.key, label: action.label, hint: action.desc,
      to: `${action.to}?${scopeParams('')}`, meta: dayLabel(day),
    });
  }, [go, scopeParams, day]);

  const visibleRecents = showAllRecents ? recents : recents.slice(0, 4);

  if (!actions.length && !toolGroups.length) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-bold text-slate-900">Quick actions</h2>
        <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">
          Start an investigation or jump to a common task
        </span>
        {!!toolGroups.length && (
          <button
            type="button"
            onClick={() => setShowAllTools((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 transition hover:text-slate-900"
          >
            All tools
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAllTools ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {/* ── Omnibox ────────────────────────────────────────────────────── */}
      <div ref={boxRef} className="relative mt-4">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-2.5 transition focus-within:border-[#F7983A]/50 focus-within:bg-white focus-within:ring-2 focus-within:ring-[#F7983A]/10">
          <label htmlFor="qa-omnibox" className="flex min-w-[240px] flex-1 items-center gap-2.5 pl-2">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <span className="hidden shrink-0 text-[13px] font-bold text-slate-900 sm:inline">
              What are you looking for?
            </span>
            <input
              id="qa-omnibox"
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setCursor(0); setOpenSuggest(true); }}
              onFocus={() => setOpenSuggest(true)}
              onKeyDown={onKeyDown}
              placeholder="Search a person, vehicle, camera, event or time…"
              autoComplete="off"
              role="combobox"
              aria-expanded={openSuggest && suggestions.length > 0}
              aria-controls="qa-suggestions"
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-slate-900 outline-none placeholder:font-normal placeholder:text-slate-400"
            />
          </label>

          <div className="flex items-center gap-2">
            <DayPicker value={day} onChange={setDay} />
            <Dropdown
              icon={MapPin}
              label={siteLabel}
              value={site}
              onChange={setSite}
              options={siteOptions}
            />
            <button
              type="button"
              onClick={runSearch}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[#F7983A] px-5 text-[12px] font-bold text-white transition hover:bg-[#e4872d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7983A]"
            >
              <Search className="h-3.5 w-3.5" />
              Search
            </button>
          </div>
        </div>

        {openSuggest && suggestions.length > 0 && (
          <ul
            id="qa-suggestions"
            role="listbox"
            className="absolute left-0 right-0 z-30 mt-1.5 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-[0_12px_32px_rgba(15,23,42,0.12)]"
          >
            {suggestions.map((s, i) => {
              const Icon = ROW_ICONS[s.iconKey] || Search;
              const tint = ROW_TINTS[s.iconKey] || '#64748b';
              return (
                <li key={`${s.to}-${s.label}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => go(s)}
                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition ${i === cursor ? 'bg-slate-50' : ''}`}
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                      style={{ backgroundColor: `${tint}1a`, color: tint }}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-bold text-slate-900">{s.label}</span>
                      <span className="block truncate text-[11px] font-medium text-slate-500">{s.hint}</span>
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── The headline destinations ──────────────────────────────────── */}
      {!!actions.length && (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {actions.map((a) => <ActionCard key={a.key} action={a} onOpen={openAction} />)}
        </div>
      )}

      {/* ── All tools (the full, entitlement-filtered feature list) ─────── */}
      {showAllTools && !!toolGroups.length && (
        <div className="mt-4 grid gap-x-6 gap-y-4 border-t border-slate-100 pt-4 sm:grid-cols-2 xl:grid-cols-3">
          {toolGroups.map((g) => {
            const GroupIcon = g.icon;
            return (
              <div key={g.key}>
                <div className="flex items-start gap-2">
                  <span
                    className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded"
                    style={{ backgroundColor: `${g.tint}1a`, color: g.tint }}
                  >
                    <GroupIcon className="h-3 w-3" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[11px] font-bold text-slate-900">{g.job}</span>
                    <span className="block text-[10px] font-medium text-slate-500">{g.why}</span>
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {g.items.map((it) => (
                    <Pill key={it.to + it.label} item={it} tint={g.tint} onOpen={(to) => navigate(to)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Recent investigations ──────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <span className="shrink-0 text-[12px] font-semibold text-slate-500">Recent investigations</span>

        {recents.length === 0 ? (
          <span className="text-[11px] font-medium text-slate-400">
            Searches you run from here show up on this list.
          </span>
        ) : (
          <>
            {visibleRecents.map((r) => {
              const Icon = ROW_ICONS[r.iconKey] || Clock;
              const tint = ROW_TINTS[r.iconKey] || '#64748b';
              return (
                <button
                  key={`${r.to}-${r.at}`}
                  type="button"
                  onClick={() => { setOpenSuggest(false); navigate(r.to); }}
                  title={r.hint || r.label}
                  className="inline-flex max-w-[260px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left transition hover:border-[#F7983A]/40 hover:bg-[#F7983A]/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F7983A]"
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: tint }} />
                  <span className="min-w-0">
                    <span className="block truncate text-[11px] font-bold leading-tight text-slate-900">{r.label}</span>
                    <span className="block truncate font-mono text-[10px] leading-tight text-slate-400">
                      {[r.meta, relativeTime(r.at)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              );
            })}
            {recents.length > 4 && (
              <button
                type="button"
                onClick={() => setShowAllRecents((v) => !v)}
                className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-[#F7983A] transition hover:text-[#e4872d]"
              >
                {showAllRecents ? 'Show less' : 'View all'}
                <ArrowRight className={`h-3.5 w-3.5 transition-transform ${showAllRecents ? 'rotate-180' : ''}`} />
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
