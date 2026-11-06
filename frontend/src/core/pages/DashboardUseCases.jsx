import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ScanFace, ScanSearch, Users, ShieldAlert, Car,
  UsersRound, ClipboardList, GraduationCap, UserSearch, Radar, Route,
  Footprints, Ban, FlameKindling, Flame, Video, AlarmClock, MapPin, Camera,
} from 'lucide-react';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';

/**
 * "What do you want to do?" — the dashboard's feature surface, grouped by the
 * JOB the operator is trying to do rather than by which service answers it.
 *
 * This replaces two hand-maintained panels ("AI Search" and "Quick Actions")
 * that listed features the account did not necessarily own and, in three
 * places, linked to a route that no longer exists. Grouping mirrors the
 * sidebar so the two never tell a different story, and every item is filtered
 * through the same entitlement rules.
 *
 * Every `to` below is a route that exists in App.jsx. Note `personlsearch` —
 * the real route carries that typo; "correcting" it here breaks the link.
 */
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

/**
 * Pills, not description-carrying tiles. A full account owns every use case
 * here, and stacked two-line tiles ran the panel to ~840px in a 360px rail —
 * taller than the two panels this replaced. The group heading already carries
 * the explanation, so each item only needs its name.
 */
function Pill({ item, tint, onOpen }) {
  const Icon = item.icon;
  return (
    <button
      onClick={() => onOpen(item.to)}
      title={item.desc}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-caption font-semibold text-fg-secondary transition-colors duration-200 hover:border-brand/50 hover:bg-brand/5 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: tint }} />
      <span className="truncate">{item.label}</span>
    </button>
  );
}

export default function DashboardUseCases() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  // Drop a whole use case when the account owns none of it, rather than
  // rendering an empty heading — an empty group reads as something broken.
  const groups = useMemo(() => {
    const { aiOn, allows } = makeEntitlement(user);
    const ai = aiOn
      ? USE_CASES
          .map((g) => ({ ...g, items: g.items.filter((it) => allows(it, true)) }))
          .filter((g) => g.items.length)
      : [];
    const everyday = { ...EVERYDAY, items: EVERYDAY.items.filter((it) => allows(it, false)) };
    return everyday.items.length ? [...ai, everyday] : ai;
  }, [user]);

  if (!groups.length) return null;

  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-[0_4px_20px_rgba(15,23,42,0.04)]">
      <h2 className="text-sm font-semibold text-fg sm:text-base">What do you want to do?</h2>
      <p className="mt-0.5 text-caption text-fg-muted">Only what this account has enabled</p>

      <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => {
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
                  <span className="block text-caption font-bold text-fg">{g.job}</span>
                  <span className="block text-micro font-medium text-fg-muted">{g.why}</span>
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {g.items.map((it) => (
                  <Pill key={it.to + it.label} item={it} tint={g.tint} onOpen={navigate} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
