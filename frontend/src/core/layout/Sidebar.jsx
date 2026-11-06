import { NavLink, useLocation } from 'react-router-dom';
import { useState } from 'react';
import {
  Home,
  Wrench,
  HeartPulse,
  Cctv,
  Tv,
  History,
  Map,
  Rss,
  BellRing,
  UsersRound,
  GraduationCap,
  UserSearch,
  ScanSearch,
  Route,
  FileBarChart,
  Settings,
  ChevronDown,
  Car,
  ShieldAlert,
  Flame,
  FlameKindling,
  ScanFace,
  Users,
  Ban,
  ScrollText,
  Activity,
  LayoutGrid,
  MapPin,
  SlidersHorizontal,
  // IndianRupee, // used by the parked "Plans & Pricing" nav item
} from 'lucide-react';
import logo from '@/assets/drishyam-logo.svg';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import {
  NavHome, NavCameraSetup, NavHealth, NavLiveView, NavMonitorWall, NavPlayback, NavMap,
  NavActivity, NavFaces, NavFindTrack, NavOccupancy, NavSafety, NavVehicles,
  NavAiFeed, NavAlerts, NavEventLog, NavReports, NavSettings,
} from '@/core/icons/NavIcons';
import { useIconSet } from '@/core/hooks/useIconSet';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import { activityPagesFor, isPrimaryActivityPage } from '@/core/nav/activityPages';
import { moduleParams } from '@/use-cases';
import { useUseCaseStore } from '@/modules/employee-productivity/useCaseStore';

// ── The customer menu, in the customer's words ─────────────────────────────
//
// Our customers are shop owners, school admins and facility managers, not
// video engineers. The menu used to say "Operations", "AI Intelligence",
// "Live ANPR", "Event Logs" and list 13 Activity Monitoring pages; it now asks
// one question per row — watch, look back, what happened, who, how many, is it
// safe — in two or three plain words. Rules:
//   - no acronyms (ANPR, AI, WebRTC, HLS) in a label; `hint` is the tooltip,
//     one plain sentence;
//   - a row the account cannot use is not shown (entitlements.js), an empty
//     section disappears, and a group left with ONE row shows as that row;
//   - URLs never change here — only labels — so bookmarks keep working.
//
// `feature` / `featureAny` = the account switch(es) behind a row (admin console
// › Account control); a child with no tag inherits its parent's. `alsoActive`
// = other paths that light the row (a page reached from inside this one).
const NAV_SECTIONS = [
  {
    id: 'home',
    items: [{ to: '/home', label: 'Home', icon: Home, end: true, hint: 'What is happening on your cameras right now' }],
  },
  {
    id: 'cameras',
    label: 'Cameras',
    items: [
      { to: '/live',         label: 'Watch live', icon: Cctv,    hint: 'See your cameras right now' },
      { to: '/monitor-wall', label: 'Video wall', icon: Tv,      feature: 'monitor_wall', hint: 'Many cameras on one big screen' },
      { to: '/playback',     label: 'Recordings', icon: History, featureAny: ['playback', 'cloud_recordings'], hint: 'Watch what happened earlier' },
      { to: '/map',          label: 'Map',        icon: Map,     feature: 'map', hint: 'Your sites and cameras on a map' },
    ],
  },
  {
    id: 'alerts',
    label: 'Alerts',
    items: [
      { to: '/alerts',     label: 'Alerts',           icon: BellRing,   feature: 'alerts',    hint: 'Things that need your attention' },
      { to: '/event-logs', label: 'Activity history', icon: ScrollText, feature: 'event_log', hint: 'Everything the cameras noticed, by day' },
    ],
  },
  {
    id: 'smart',
    label: 'Smart features',
    ai: true,
    items: [
      {
        id: 'people', to: '/watchlist', label: 'People', icon: ScanFace,
        hint: 'Recognise, find and follow people',
        children: [
          { to: '/watchlist',              label: 'Known people',    icon: UsersRound,    feature: 'face_watchlist', hint: 'Get an alert when someone on your list is seen' },
          { to: '/face-learning',          label: 'Teach faces',     icon: GraduationCap, feature: 'face_detection', hint: 'Name the faces your cameras keep seeing' },
          { to: '/ai-event/personlsearch', label: 'Find a person',   icon: UserSearch,    feature: 'person_search',  hint: 'Search every camera for one person' },
          { to: '/person-tracker',         label: 'Track a person',  icon: ScanSearch,    feature: 'person_tracker', hint: 'Follow one person across cameras, live or recorded', alsoActive: ['/live-tracker'] },
          { to: '/ai-event/journeymap',    label: 'Where they went', icon: Route,         feature: 'journey_map',    hint: 'A person’s route around your site' },
        ],
      },
      {
        id: 'counting', to: '/occupancy', label: 'Counting', icon: Users,
        hint: 'How many people, and where',
        children: [
          { to: '/occupancy',            label: 'People count',   icon: LayoutGrid, feature: 'headcount', hint: 'How many people are in each area now', alsoActive: ['/ai-event/headcount'] },
          // Its own row rather than a tab on People count: "how busy was it
          // last week" is a different question, asked at a different time, and
          // someone after last week's numbers looks in the nav — not in a strip
          // above a live number. Label matches the page's own title.
          { to: '/occupancy/usage-trends', label: 'Past Headcount Data', icon: Activity, feature: 'headcount', hint: 'How busy each area was on earlier days' },
          { to: '/occupancy/zone-setup', label: 'Counting areas', icon: MapPin,     feature: 'headcount', hint: 'Draw the areas and doors to count' },
        ],
      },
      {
        id: 'safety', to: '/occupancy/breaches', label: 'Safety', icon: ShieldAlert,
        hint: 'Alerts for danger and no-entry areas',
        children: [
          { to: '/occupancy/breaches',      label: 'No-entry areas', icon: Ban,           feature: 'restricted_zone', hint: 'Someone went where they should not' },
          { to: '/ai-analytics/weapon',     label: 'Weapon alerts',  icon: ShieldAlert,   feature: 'weapon',     hint: 'A gun or knife seen on camera' },
          { to: '/ai-analytics/fire',       label: 'Fire & smoke',   icon: FlameKindling, feature: 'fire',       hint: 'Fire or smoke seen on camera' },
          { to: '/ai-analytics/aggression', label: 'Fights',         icon: Flame,         feature: 'aggression', hint: 'Fighting or pushing seen on camera' },
        ],
      },
      // One row: the vehicle tabs (find, live, outside, records, check) live
      // inside the page's own tab strip.
      { to: '/ai-analytics/vehicle', label: 'Number plates', icon: Car, feature: 'anpr', hint: 'Vehicles and number plates at your gates' },
      // Children are filled in per vertical below (core/nav/activityPages.js).
      { id: 'staff', to: '/activity-monitoring', label: 'Staff activity', icon: Activity, feature: 'activity', hint: 'Activity log, attendance and staff performance', activity: true },
      { to: '/ai-feed', label: 'Live detections', icon: Rss, feature: 'ai_feed', hint: 'Everything the cameras detect, as it happens' },
    ],
  },
  {
    id: 'reports',
    items: [{ to: '/reports', label: 'Reports', icon: FileBarChart, feature: 'reports', hint: 'Make and download reports' }],
  },
];

// Settings › Manage Users is for account admins (the same roles Settings.jsx
// shows the section to).
const USER_ADMIN_ROLES = ['admin', 'owner', 'user'];

const SETUP = {
  id: 'setup', to: '/settings', label: 'Setup', icon: SlidersHorizontal, iconKey: '/settings',
  hint: 'Cameras, users and account settings',
  children: [
    { to: '/camera-setup',       label: 'Add cameras',   icon: Wrench,     feature: 'camera_setup',  hint: 'Add, edit or remove cameras and recorders' },
    { to: '/health',             label: 'Camera Status', icon: HeartPulse, feature: 'camera_health', hint: 'Which cameras are working or offline' },
    { to: '/settings?tab=users', label: 'Users',         icon: UsersRound, feature: 'user_management', roles: USER_ADMIN_ROLES, hint: 'Who in your team can log in' },
    { to: '/settings',           label: 'Settings',      icon: Settings,   hint: 'Your account, email alerts and privacy' },
  ],
};

// Drishyam's own icons for the top-level rows, keyed by route (or `iconKey`).
// `icon` in the nav config is the stock lucide glyph and what the sidebar
// shows by default (DEFAULT_ICON_SET is 'lucide'); these only appear when
// <html data-icons> is set to 'line' or 'duotone'. Child rows always use their
// lucide glyph.
const DRISHYAM_ICONS = {
  '/home':                 NavHome,
  '/camera-setup':         NavCameraSetup,
  '/health':               NavHealth,
  '/live':                 NavLiveView,
  '/monitor-wall':         NavMonitorWall,
  '/playback':             NavPlayback,
  '/map':                  NavMap,
  '/activity-monitoring':  NavActivity,
  '/watchlist':            NavFaces,
  '/person-tracker':       NavFindTrack,
  '/occupancy':            NavOccupancy,
  '/occupancy/breaches':   NavSafety,
  '/ai-analytics/vehicle': NavVehicles,
  '/ai-feed':              NavAiFeed,
  '/alerts':               NavAlerts,
  '/event-logs':           NavEventLog,
  '/reports':              NavReports,
  '/settings':             NavSettings,
};

// Active-row text color now baked into ACTIVE_ROW below — only the idle base
// is needed as a separate token.
const IDLE_TEXT = 'text-sidebar-muted';

// The idle row, hover included. This used to be spelled out at each of the
// three call sites as `hover:text-white`, which dated from when the rail was
// dark: on today's white rail it painted white text onto a near-white hover
// fill, so a row APPEARED TO EMPTY OUT under the cursor. Hover now goes to the
// same foreground token the active row uses, and the fill carries a hairline
// inset so the highlight has an edge rather than bleeding into the rail.
const IDLE_ROW = `${IDLE_TEXT} hover:text-sidebar-foreground hover:bg-sidebar-accent hover:inset-ring-1 hover:inset-ring-sidebar-border`;

function initials(value) {
  return (
    String(value || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'D'
  );
}

/**
 * Resolve one row for this account: drop children it cannot use, give a group
 * its live `to` (its first remaining child, so the collapsed rail never links
 * to a page that redirects), and turn a group of one into that one row.
 * Returns null when nothing is left.
 */
function resolveItem(item, { allows, isAi, role, activityChildren }) {
  const source = item.activity ? activityChildren : item.children;
  if (!source) {
    if (item.roles && !item.roles.includes(role)) return null;
    return allows(item, isAi) ? item : null;
  }
  if (item.feature && !allows(item, isAi)) return null;
  const children = source.filter((c) => {
    if (c.roles && !c.roles.includes(role)) return false;
    // A child with no tag of its own inherits its parent's.
    return allows(c.feature || c.featureAny || !item.feature ? c : { ...c, feature: item.feature }, isAi);
  });
  if (!children.length) return null;
  if (children.length === 1 && !item.activity) {
    // A group of one is just that row — e.g. Safety with only No-entry areas.
    const only = children[0];
    return { ...only, iconKey: item.iconKey || item.to };
  }
  return { ...item, to: children[0].to.split('?')[0], groupKey: item.id || item.to, children };
}

// `variant` decides who owns positioning:
//   'rail'  → the fixed left column the desktop shell reserves margin for.
//   'sheet' → the same nav rendered inside a mobile drawer, which supplies its
//             own fixed frame; the rail's chevron is meaningless there because
//             the drawer is either open or gone.
export default function Sidebar({ open, variant = 'rail', onNavigate }) {
  const inSheet = variant === 'sheet';
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  // Per-account curation. The rules themselves live in core/nav/entitlements.js
  // so the dashboard's feature surface applies exactly the same ones — when this
  // logic was local, every other surface hand-rolled its own and drifted.
  const { aiOn, allows } = makeEntitlement(user);

  // Staff activity: the overview plus at most four pages for the account's
  // vertical; the rest are on the overview page's "All pages" strip.
  const useCase = useUseCaseStore((s) => s.useCase);
  const activityParams = moduleParams(useCase, 'employee-productivity');
  const activityChildren = activityPagesFor(useCase, activityParams)
    .filter((p) => isPrimaryActivityPage(p, useCase));

  const ctx = { allows, role: user?.role, activityChildren };
  const navSections = NAV_SECTIONS
    .filter((s) => !s.ai || aiOn)
    .map((s) => {
      const items = s.items.map((it) => resolveItem(it, { ...ctx, isAi: !!s.ai })).filter(Boolean);
      return items.length ? { ...s, items } : null;
    })
    .filter(Boolean);
  const setup = resolveItem(SETUP, { ...ctx, isAi: false });

  // Per-group collapse OVERRIDES, keyed by group id. A group whose child is the
  // current page auto-opens; the override only records a manual expand/
  // collapse, so no effect-driven setState is needed.
  const [groupOverrides, setGroupOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sidebar-groups') || '{}'); } catch { return {}; }
  });
  const toggleGroup = (key, currentlyOpen) => {
    setGroupOverrides((prev) => {
      const next = { ...prev, [key]: !currentlyOpen };
      try { localStorage.setItem('sidebar-groups', JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };

  // ONE row is lit: the best match for this URL across the whole menu, so a
  // prefix row (/occupancy) never lights beside an exact one
  // (/occupancy/breaches) in another group.
  const leaves = [...navSections.flatMap((s) => s.items), ...(setup ? [setup] : [])]
    .flatMap((it) => it.children || [it]);
  const activeRow = bestRow(leaves, location.pathname, location.search);

  const rowProps = {
    open, groupOverrides, onToggleGroup: toggleGroup, onNavigate,
    pathname: location.pathname, activeRow,
  };

  return (
    // Two shapes, one nav definition. In the mobile drawer (`variant="sheet"`)
    // Radix owns the positioning, so the aside just fills the panel. As the
    // desktop rail it is an in-flow flex item of the shell (App.jsx): its width
    // below is the only number, and the content column takes the rest.
    // `data-app-chrome` marks this as application furniture rather than page
    // content, so printing can drop it (see the print block in index.css).
    <aside
      data-app-chrome="rail"
      className={
        inSheet
          ? 'flex h-full w-full flex-col overflow-hidden bg-sidebar'
          : `hidden h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar transition-all duration-300 ease-in-out lg:flex ${open ? 'w-64' : 'w-16'}`
      }
    >
      {/* ── Brand row ── */}
      {/* h-16 matches --topbar-h so this row lines up exactly with the Topbar's
          first row, on every route — including Home/Dashboard, where Topbar
          used to compact to h-12 and break that alignment. */}
      <div className={`h-16 shrink-0 flex items-center border-b border-sidebar-border ${open ? 'px-3.5' : 'justify-center'}`}>
        {/* The eye mark is wide (≈1.54:1) with a transparent background —
            no tile treatment (rounded/ring), just the mark itself. Collapsed,
            the mark carries the brand on its own; only the wordmark drops, so
            the rail never shows an empty header band. */}
        <div className="flex items-center gap-2.5 min-w-0">
          <img src={logo} alt="Drishyam" className="h-[22px] w-auto shrink-0 object-contain" />
          {open && (
            <span className="text-heading font-bold text-sidebar-foreground tracking-[-0.012em] leading-none whitespace-nowrap">
              Drishyam
            </span>
          )}
        </div>
      </div>

      {/* ── Main nav ── */}
      <nav className="flex-1 overflow-y-auto py-2 px-1.5 [scrollbar-width:thin] [scrollbar-color:var(--sidebar-border)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-sidebar-border hover:[&::-webkit-scrollbar-thumb]:bg-line-strong">
        {navSections.map((section, idx) => (
          <div key={section.id} className={idx === 0 ? '' : open ? (section.label ? 'mt-3' : 'mt-2') : 'mt-4'}>
            {open ? (
              section.label ? (
                <div className="px-3 pt-2 pb-1.5">
                  <span className="text-caption font-bold uppercase tracking-[0.12em] text-fg-muted">
                    {section.label}
                  </span>
                </div>
              ) : null
            ) : idx > 0 ? (
              <div className="mx-2 my-2 border-t border-sidebar-border" />
            ) : null}

            <div className={open ? 'space-y-px' : 'space-y-1'}>
              {section.items.map((item) => (
                <NavItem key={item.groupKey || item.to} item={item} {...rowProps} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Footer (setup + user) ── */}
      <div className={`shrink-0 border-t border-sidebar-border px-1.5 ${open ? 'py-2 space-y-px' : 'py-3 space-y-1'}`}>
        {setup ? <NavItem item={setup} {...rowProps} /> : null}

        {open && (user?.email || user?.name) ? (
          <div className="mt-2 mx-1.5 rounded-lg bg-sidebar-raised border border-sidebar-border px-2.5 py-2 flex items-center gap-2.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand/15 text-brand text-caption font-semibold tracking-[0.02em]">
              {initials(user?.name || user?.email)}
            </span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-small font-semibold text-sidebar-foreground tracking-[-0.005em]">
                {user?.name || user?.email?.split('@')[0] || 'Operator'}
              </p>
              <p className="truncate text-micro font-medium text-fg-muted tracking-[0.01em]">
                {user?.email || 'admin@drishyam.local'}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

// Tailwind class strings for the active-state look. Pulled out so parent and
// child rows stay visually consistent.
//
//   activeRow   → background tint + slight inset shadow for the orange glow
//   activeBar   → 3 px orange indicator on the left
//   activeIcon  → orange accent + heavier stroke
const ACTIVE_ROW  = 'bg-gradient-to-r from-brand/[0.18] to-brand/[0.04] text-sidebar-foreground shadow-[inset_0_0_0_1px_rgba(247,152,58,0.18)]';
const ACTIVE_BAR  = 'absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-brand shadow-[0_0_10px_rgba(247,152,58,0.45)]';

// On the 64px rail the label is the only thing identifying a row, so it has to
// come back on hover. A real tooltip rather than `title`: it appears at once
// instead of after the OS delay, it is readable on the dark rail, and it is
// announced to screen readers. The plain-words hint rides along under it.
function RailTip({ show, label, hint, children }) {
  if (!show) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span className="block font-semibold">{label}</span>
        {hint ? <span className="block max-w-[220px] opacity-80">{hint}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * How well does this row match the URL? 0 = not at all.
 *
 * NavLink's own `isActive` compares pathnames and ignores the query, which is
 * wrong for children that are TABS of one page (Setup › Users is
 * /settings?tab=users beside Settings at /settings): a row whose `to` carries a
 * query matches only when that query matches too, and then beats the bare
 * path. A row also matches the pages under it (/reports/123, the weapon
 * module's sub-routes) unless it is marked `end`; the longest such prefix
 * wins. `alsoActive` lights a row on a page reached from inside it (Track a
 * person is also lit on /live-tracker).
 */
function rowScore(row, pathname, search) {
  const [path, query] = row.to.split('?');
  if (row.alsoActive?.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return 2;
  if (pathname === path) {
    if (!query) return 2;
    const want = new URLSearchParams(query);
    const have = new URLSearchParams(search || '');
    for (const [k, v] of want.entries()) {
      const got = have.get(k);
      if (got == null) { if (!row.defaultTab) return 0; continue; }
      if (got !== v) return 0;
    }
    return 3;
  }
  if (!row.end && !query && pathname.startsWith(`${path}/`)) return 1 + path.length / 1000;
  return 0;
}

function bestRow(rows, pathname, search) {
  let best = null;
  let top = 0;
  for (const r of rows) {
    const s = rowScore(r, pathname, search);
    if (s > top) { top = s; best = r; }
  }
  return best;
}

function NavItem({ item, open, groupOverrides, onToggleGroup, onNavigate, pathname, activeRow }) {
  const { to, label, children, hint } = item;
  const iconSet = useIconSet();
  const Icon = (iconSet !== 'lucide' && DRISHYAM_ICONS[item.iconKey || to]) || item.icon;

  if (!children) {
    const isActive = item === activeRow;
    return (
      <RailTip show={!open} label={label} hint={hint}>
      <NavLink
        to={to}
        onClick={onNavigate}
        title={open ? hint : undefined}
        aria-current={isActive ? 'page' : undefined}
        className={`relative flex items-center rounded-lg transition-all duration-150 group ${
          open ? 'gap-3 pl-3.5 pr-3 py-[9px]' : 'mx-auto h-10 w-10 justify-center p-0'
        } ${isActive ? ACTIVE_ROW : IDLE_ROW}`}
      >
        {isActive && open && <span className={ACTIVE_BAR} aria-hidden />}
        <Icon
          className={`shrink-0 ${open ? 'w-[18px] h-[18px]' : 'w-[20px] h-[20px]'} ${
            isActive ? 'text-brand' : 'text-sidebar-muted group-hover:text-sidebar-foreground'
          } transition-colors`}
          strokeWidth={isActive ? 2.2 : 1.85}
        />
        {open && (
          <span className={`text-nav-lg leading-none whitespace-nowrap truncate ${
            isActive ? 'font-bold' : 'font-semibold'
          }`}>
            {label}
          </span>
        )}
      </NavLink>
      </RailTip>
    );
  }

  // Group with children (People, Counting, Safety, Staff activity, Setup).
  // Active if any child matches OR the path lives under the group root (e.g.
  // /activity-monitoring/hostel/dining is not a sidebar row but is that group).
  const activeChild = children.includes(activeRow) ? activeRow : null;
  const groupKey = item.groupKey || to;
  const parentActive = !!activeChild
    || (item.activity && pathname.startsWith('/activity-monitoring/'));
  // Auto-open when a child is active; a manual override wins either way.
  const groupOpen = groupOverrides[groupKey] ?? parentActive;

  if (!open) {
    return (
      <RailTip show label={label} hint={hint}>
      <NavLink
        to={to}
        onClick={onNavigate}
        className={`group relative mx-auto flex h-10 w-10 items-center justify-center rounded-lg p-0 transition-all duration-150 ${
          parentActive ? ACTIVE_ROW : IDLE_ROW
        }`}
      >
        {parentActive && <span className={ACTIVE_BAR} aria-hidden />}
        <Icon
          className={`w-[20px] h-[20px] shrink-0 transition-colors ${
            parentActive ? 'text-brand' : 'text-sidebar-muted group-hover:text-sidebar-foreground'
          }`}
          strokeWidth={parentActive ? 2.2 : 1.85}
        />
      </NavLink>
      </RailTip>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleGroup(groupKey, groupOpen)}
        title={hint}
        className={`group relative w-full flex items-center gap-3 pl-3.5 pr-3 py-[9px] rounded-lg transition-all duration-150 ${
          parentActive ? ACTIVE_ROW : IDLE_ROW
        }`}
        aria-expanded={groupOpen}
        aria-label={`${groupOpen ? 'Collapse' : 'Expand'} ${label}`}
      >
        {parentActive && <span className={ACTIVE_BAR} aria-hidden />}
        <Icon
          className={`w-[18px] h-[18px] shrink-0 transition-colors ${
            parentActive ? 'text-brand' : 'text-sidebar-muted group-hover:text-sidebar-foreground'
          }`}
          strokeWidth={parentActive ? 2.2 : 1.85}
        />
        {/* `truncate`, not bare `whitespace-nowrap`: the rail is a fixed
            256px and a group label that outgrows it used to push the chevron
            out of the row rather than ellipsing. `min-w-0` is what lets a
            flex-1 child actually shrink. */}
        <span className={`text-nav-lg leading-none flex-1 min-w-0 text-left truncate ${
          parentActive ? 'font-bold' : 'font-semibold'
        }`}>
          {label}
        </span>
        <ChevronDown
          className={`w-4 h-4 transition-[transform,color] duration-200 ${
            parentActive ? 'text-brand/70' : 'text-sidebar-muted/70 group-hover:text-sidebar-foreground'
          } ${groupOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {groupOpen && (
        <div className="ml-[20px] mt-0.5 pl-[12px] border-l border-sidebar-border space-y-0.5">
          {children.map((child) => {
            const on = child === activeChild;
            return (
              <NavLink
                key={child.to}
                to={child.to}
                onClick={onNavigate}
                title={child.hint}
                aria-current={on ? 'page' : undefined}
                // Not NavLink's `isActive`: it ignores the query string, so tab
                // children of one page would all read as active together.
                className={`relative flex items-center gap-2.5 rounded-md pl-3 pr-2.5 py-[7px] text-nav transition-all duration-150 ${
                  on
                    ? 'text-brand bg-brand/[0.12] font-bold shadow-[inset_0_0_0_1px_rgba(247,152,58,0.18)]'
                    : 'text-sidebar-muted font-semibold hover:text-sidebar-foreground hover:bg-sidebar-accent'
                }`}
              >
                {child.icon ? <child.icon className="h-4 w-4 shrink-0" strokeWidth={1.9} /> : null}
                <span className="truncate">{child.label}</span>
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
