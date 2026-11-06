import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EyeOff, ChartColumn, ArrowUpRight, LayoutGrid, Camera, ScrollText, Search, X, CheckCircle2 } from 'lucide-react';
import PolicyBar from './PolicyBar';
import PolicyTip from './PolicyTip';
import { TH, TH_STICKY } from './type';
import { useActivityParams } from './useCaseStore';
import { useModuleData } from './useModuleData';
import { toMinutes } from './shifts';
import { ZONE_LIVE, ZONE_INCIDENTS } from './pages-data';
import { HoverText, MetaHover } from './MetaHover';
import CameraPreviewModal from './dashboard/CameraPreviewModal';
import { zonePreviewSource } from './dashboard/cameraStreams';
import { eventLogHref } from '@/modules/event-log/eventlog/log-query';

// Zone Coverage — the LIVE, retail-only view: who is on post in each zone
// right now. Gated on the vertical's `zones` param — corporate doesn't
// configure it, so this page (and its sidebar row) hide themselves.
//
// Real-time only, on purpose. The hourly coverage matrix and the full
// incident history answer "how did the day / week go", which is analytics,
// not triage — they live in Analytics › Zone Coverage & Trends, with date
// ranges and exports. This page links there once, from its header.
//
// ONE CARD, FULL WIDTH. There used to be an "Active Incidents" rail down the
// right-hand side listing unresolved incidents from the last 30 minutes. It
// was cut, because every row in it was a restatement of a row already in the
// table beside it: an incident in that list was, by definition, a zone reading
// Unattended two columns to the left, with the same elapsed time. It cost the
// table a third of the page to say the same thing twice, and the table is what
// a manager reads. Where the incidents actually went:
//
//   the count      → the "open incidents" link in the page header
//   the detail     → the Coverage cell's hover card (since when, for how long)
//   the history    → Event Log, reached from the Coverage badge of the zone
//                    concerned, pre-filtered to that zone's open incidents
//   older/resolved → the same Event Log link with the status chip cleared, and
//                    the hourly matrix in Analytics
//
// DEEP LINKS. Every Coverage badge is a link into the global Event Log carrying
// the zone, and — when the zone is in trouble — the event type and ACTIVE
// status too, so the log opens showing that zone's open incidents rather than
// the whole estate's day. The parameter contract lives in
// event-log/eventlog/log-query.js; `eventLogHref` is the only thing that
// spells it, so this page cannot drift from the page it links to.
//
// Frontend-only: dummy data (future backend: /activity/zone-status,
// /activity/zone-incidents?active=1).

const ANALYTICS_HREF = '/activity-monitoring/analytics/zones';

const STATUS = {
  unattended:   { rank: 0, text: 'Unattended',   cls: 'bg-danger-soft text-danger-ink ring-danger-line',    dot: 'bg-danger' },
  understaffed: { rank: 1, text: 'Understaffed', cls: 'bg-warning-soft text-warning-ink ring-warning-line', dot: 'bg-warning' },
  covered:      { rank: 2, text: 'Covered',      cls: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
};

// A zone's coverage problem, in the Event Log's event-type vocabulary. A
// counter with nobody on it raises counter-unattended; a floor zone with
// nobody on it raises low-activity. Covered zones get no type — their link is
// "everything that has happened in this zone", which is the useful question
// when nothing is wrong right now.
const EVENT_TYPE = { counter: 'UNATTENDED', zone: 'LOW_ACTIVITY' };

// Minutes from "HH:MM" to now, both IST.
const minutesSince = (hhmm, now) => toMinutes(now) - toMinutes(hhmm);

function fmtElapsed(min) {
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function lastHourCls(pct) {
  if (pct >= 80) return 'text-fg-secondary';
  if (pct >= 50) return 'text-warning-ink';
  return 'text-danger-ink';
}

export default function ZoneCoverage() {
  const { label, params } = useActivityParams();
  const { NOW_IST, EMPLOYEES } = useModuleData();
  const [preview, setPreview] = useState(null);
  const closePreview = useCallback(() => setPreview(null), []);

  // Name → { role, shift window } for the roster hover card.
  const people = useMemo(() => {
    const shifts = new Map((params.shifts || []).map((s) => [s.label, s]));
    return new Map(EMPLOYEES.map((e) => {
      const sh = shifts.get(e.shift);
      return [e.name, { role: e.role, shift: sh ? `${sh.label} ${sh.start}–${sh.end}` : e.shift }];
    }));
  }, [EMPLOYEES, params.shifts]);

  // A key of VIEWS below. Local on purpose — a triage lens, not a saved view.
  const [filterStatus, setFilterStatus] = useState('all');
  const [query, setQuery] = useState('');

  const zones = useMemo(() => {
    // Zones with an unresolved incident are flagged even if someone has since
    // stepped back on post — the incident is still open until it is resolved.
    const activeIncidentZones = new Set(ZONE_INCIDENTS.filter((i) => i.active).map((i) => i.zone));
    return ZONE_LIVE
      .map((z) => {
        const status = z.staff.length === 0 ? 'unattended' : z.staff.length < z.required ? 'understaffed' : 'covered';
        // Flagged = anything a manager should look at: a coverage warning
        // (unattended / understaffed), an open incident, or an occupancy breach.
        const flagged = status !== 'covered' || activeIncidentZones.has(z.zone) || z.occupancy > z.capacity;
        return { ...z, status, flagged, idleMin: z.unattendedSince ? minutesSince(z.unattendedSince, NOW_IST) : null };
      })
      // Problems first; within a status, the longest-running problem first.
      .sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank || (b.idleMin ?? 0) - (a.idleMin ?? 0));
  }, [NOW_IST]);

  // Search matches the zone name, its camera, or anyone on post there.
  const visibleZones = useMemo(() => {
    const q = query.trim().toLowerCase();
    const view = VIEWS[filterStatus] || VIEWS.all;
    return zones.filter((z) => view.test(z) && (!q
      || z.zone.toLowerCase().includes(q)
      || z.camera?.toLowerCase().includes(q)
      || z.staff.some((n) => n.toLowerCase().includes(q))));
  }, [zones, filterStatus, query]);
  const isFiltered = filterStatus !== 'all' || query.trim() !== '';
  const resetFilters = () => { setFilterStatus('all'); setQuery(''); };

  // Unresolved incidents, for the header's "open incidents" link. The list of
  // them is no longer rendered here (see the note at the top) — only the count,
  // and only so the link can say how many rows it is about to show.
  const openIncidents = useMemo(
    () => ZONE_INCIDENTS.filter((i) => i.active).length,
    [],
  );

  // Vertical doesn't run zone coverage (e.g. corporate) → explain, don't 404.
  if (!params.zones) {
    return (
      <div className="w-full page-inset">
        {/* Switcher must stay reachable here — it's how you leave the disabled state */}
        <PolicyBar />
        <div className="rounded-xl border border-line bg-surface p-10 text-center shadow-sm">
          <EyeOff className="mx-auto mb-2 h-8 w-8 text-fg-disabled" />
          <p className="text-body font-semibold text-fg-secondary">Zone Coverage is not enabled for the {label} use case</p>
          <p className="mx-auto mt-1 max-w-md text-small text-fg-subtle">
            This page needs the <code className="rounded bg-surface-muted px-1 font-mono text-caption">zones</code> parameter block
            (counter-unattended thresholds), which only floor-based verticals like Retail configure.
          </p>
          <Link to="/activity-monitoring" className="mt-3 inline-block text-small font-semibold text-brand-ink hover:underline">← Back to dashboard</Link>
        </div>
      </div>
    );
  }

  const unattendedMin = Math.round(params.zones.counterUnattendedSec / 60);

  return (
    // Below lg the page scrolls naturally. From lg up it is held to the
    // viewport (--app-vh, never raw 100vh — see the app-zoom note in index.css)
    // and the card scrolls its own body.
    <div className="flex min-h-[calc(var(--app-vh)-var(--topbar-h))] w-full flex-col gap-4 page-inset-x pb-5 pt-3 lg:h-[calc(var(--app-vh)-var(--topbar-h))] lg:min-h-0 lg:overflow-hidden">
      {/* Header — the module's page header: icon tile, title with the live
          marker and policy beside it, one-line subtitle; links on the right */}
      <div className="flex shrink-0 flex-wrap items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
          <LayoutGrid className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Zone Coverage</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-micro font-semibold text-success-ink ring-1 ring-success-line">
              <span className="relative flex h-1.5 w-1.5" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              Live · {NOW_IST} IST
            </span>
            <PolicyTip />
          </div>
          <p className="mt-1 text-small text-fg-muted">Who is on post in every zone right now, and which counters are unattended.</p>
        </div>

        {/* The two ways off this page: the open incidents behind the numbers
            (Event Log, every zone, still unresolved) and the history behind
            the day (Analytics). This is where the deleted rail's footer link
            went — it is one link now rather than one per incident. */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {openIncidents > 0 ? (
            <Link
              to={eventLogHref({ category: 'COVERAGE', status: 'ACTIVE' })}
              className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-danger-line bg-danger-soft px-3 text-caption font-semibold text-danger-ink transition hover:brightness-95 lg:h-8"
            >
              <ScrollText className="h-3.5 w-3.5" />
              {openIncidents} open {openIncidents === 1 ? 'incident' : 'incidents'}
            </Link>
          ) : null}
          <Link
            to={ANALYTICS_HREF}
            className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-caption font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink lg:h-8"
          >
            <ChartColumn className="h-3.5 w-3.5" /> Hourly matrix &amp; history
          </Link>
        </div>
      </div>

      {/* One card, the full width of the content column. From lg it fills the
          remaining height and scrolls its own body. */}
      <section className="flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:min-h-0 lg:flex-1">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-fg sm:text-base">Live Zone Status</h2>
          <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-caption font-bold tabular-nums text-fg-muted">
            {isFiltered ? `${visibleZones.length} / ${zones.length}` : zones.length}
          </span>
          <span className="flex-1" />
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search zones, staff, camera…"
              aria-label="Search zones"
              className="h-9 w-56 rounded-lg border border-line bg-surface pl-8 pr-7 text-small text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none lg:h-8 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {/* View filter. Each option carries its live count so "Flagged (3)"
              reads as worth picking before it is selected. */}
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            aria-label="Filter zones"
            className={`h-9 rounded-lg border px-2.5 text-small font-semibold focus:border-brand focus:outline-none lg:h-8 ${
              filterStatus === 'all' ? 'border-line bg-surface text-fg-secondary' : 'border-brand-line bg-brand-soft text-brand-ink'
            }`}
          >
            {Object.entries(VIEWS).map(([key, v]) => (
              <option key={key} value={key}>{v.label} ({zones.filter(v.test).length})</option>
            ))}
          </select>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
          {visibleZones.length === 0 ? (
            <div className="grid h-full min-h-[16rem] place-items-center p-6">
              <div className="max-w-sm rounded-xl border border-success-line bg-success-soft/40 px-6 py-8 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-success" aria-hidden />
                <p className="text-body font-semibold text-fg">
                  {filterStatus === 'flagged' && !query.trim() ? 'All Clear — No zones currently flagged' : 'No zones match these filters'}
                </p>
                <p className="mt-1 text-small text-fg-muted">
                  {filterStatus === 'flagged' && !query.trim()
                    ? 'Every zone is covered, with no open incidents or occupancy breaches.'
                    : 'Try a different search or view.'}
                </p>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="mt-4 inline-flex h-11 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-caption font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink lg:h-8"
                >
                  Reset Filter
                </button>
              </div>
            </div>
          ) : (
          /* `table-fixed` with percentage tracks, so the columns share the
              full width in fixed proportion instead of the browser sizing them
              off whichever zone happens to have the longest name today.
              Percentages were re-cut when the 400px rail went: Coverage and
              Staff took the room, because both carry a badge or two lines that
              used to sit one character from wrapping.

              `min-w` is the point below which the card scrolls sideways rather
              than crushing a column — 52rem, up from 36rem, because at 36rem
              the six headers were already touching. */
          <table className="w-full min-w-[52rem] table-fixed border-collapse text-left text-sm">
            <colgroup>
              <col className="w-[19%]" />
              <col className="w-[25%]" />
              <col className="w-[14%]" />
              <col className="w-[22%]" />
              <col className="w-[12%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr>
                <th className={thCls.left}>Zone</th>
                <th className={thCls.left}>Staff on post</th>
                <th className={thCls.left}>Customers</th>
                <th className={thCls.left}>Coverage</th>
                <th className={thCls.right}>Last hour</th>
                {/* Was `sr-only`: at the old width the word did not fit beside
                    five other headers. It does now, and a column of unlabelled
                    icon buttons is a guessing game. */}
                <th className={`${thCls.right} pl-2`}>Camera</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {visibleZones.map((z) => {
                const s = STATUS[z.status];
                const load = Math.min(100, Math.round((z.occupancy / z.capacity) * 100));
                // A zone in trouble links to its OPEN incidents of the matching
                // type; a healthy one links to everything recorded in it. Both
                // carry the zone, which is the point of the link.
                const inTrouble = z.status !== 'covered';
                // The ZONE, deliberately not the camera. A zone can have
                // several cameras (retail's Apparel has two), so pinning the
                // link to the one this table happens to show would hide any
                // incident the other camera raised — a narrower link that
                // looks more precise and is less correct.
                const logHref = eventLogHref({
                  zoneId: z.zone,
                  eventType: inTrouble ? EVENT_TYPE[z.kind] : undefined,
                  status: inTrouble ? 'ACTIVE' : undefined,
                });
                return (
                  <tr key={z.zone} className="transition hover:bg-surface-sunken">
                    <td className="px-4 py-2.5">
                      <MetaHover
                        title={z.zone}
                        rows={[
                          ['Kind', z.kind === 'counter' ? 'Counter' : 'Floor zone'],
                          ['Camera', z.camera],
                          ['Capacity', `${z.capacity} customers`],
                          ['Posts needed', z.required],
                        ]}
                      >
                        <HoverText className="block truncate text-sm font-semibold text-foreground">{z.zone}</HoverText>
                      </MetaHover>
                    </td>
                    <td className="px-4 py-2.5">
                      <MetaHover
                        title="Staff on post"
                        rows={[
                          ['On post', `${z.staff.length} of ${z.required} needed`],
                          ...z.staff.map((n) => {
                            const who = people.get(n);
                            return [n, who ? [who.role, who.shift].filter(Boolean).join(' · ') : 'On post'];
                          }),
                        ]}
                        note={z.staff.length ? null : 'No one detected on post.'}
                      >
                        {z.staff.length ? (
                          <HoverText className="block min-w-0 leading-tight">
                            <span className="block truncate text-sm font-semibold text-foreground">
                              {z.staff[0]}{z.staff.length > 1 && <span className="font-normal text-muted-foreground"> +{z.staff.length - 1}</span>}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">{people.get(z.staff[0])?.role || 'On post'}</span>
                          </HoverText>
                        ) : (
                          <HoverText className="text-sm text-muted-foreground">No one on post</HoverText>
                        )}
                      </MetaHover>
                    </td>
                    <td className="px-4 py-2.5">
                      <MetaHover title="Customers in zone" rows={[['Now', z.occupancy], ['Capacity', z.capacity], ['Load', `${load}%`]]}>
                        <HoverText className="block">
                          <span className="text-sm tabular-nums text-foreground">{z.occupancy}</span>
                          <span className="text-xs text-muted-foreground"> / {z.capacity}</span>
                          <span className="mt-1 block h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
                            <span className="block h-full rounded-full bg-brand/70" style={{ width: `${load}%` }} />
                          </span>
                        </HoverText>
                      </MetaHover>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <MetaHover
                        title="Coverage"
                        rows={[
                          ['Status', s.text],
                          ['Unattended since', z.unattendedSince ? `${z.unattendedSince} IST` : null],
                          ['For', z.idleMin != null ? fmtElapsed(z.idleMin) : null],
                          ['Alert after', z.kind === 'counter' ? `${unattendedMin} min unattended` : null],
                        ]}
                        note={inTrouble
                          ? `Opens the Event Log, filtered to open ${z.zone} incidents.`
                          : `Opens the Event Log, filtered to ${z.zone}.`}
                      >
                        {/* The badge IS the drill-down. It is what the eye lands
                            on when scanning for trouble, so it is also the thing
                            that should take you to the record of that trouble —
                            rather than a separate action column repeating it. */}
                        <Link
                          to={logHref}
                          aria-label={`${z.zone} — ${s.text}. Open in Event Log`}
                          className={`group/log inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ring-1 outline-none transition hover:brightness-95 focus-visible:ring-2 ${s.cls}`}
                        >
                          {s.text}
                          {z.idleMin != null && <span className="font-normal opacity-80">· {fmtElapsed(z.idleMin)}</span>}
                          <ArrowUpRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/log:opacity-100" aria-hidden />
                        </Link>
                      </MetaHover>
                    </td>
                    <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${lastHourCls(z.lastHourPct)}`}>
                      <MetaHover align="end" title="Last hour" note="Share of the past 60 minutes with staff detected on post.">
                        <HoverText className="text-sm">{z.lastHourPct}%</HoverText>
                      </MetaHover>
                    </td>
                    <td className="py-2.5 pl-2 pr-4 text-right">
                      {z.camera && (
                        <MetaHover side="left" align="center" note={`View live feed (${z.camera})`}>
                          <button
                            type="button"
                            onClick={() => setPreview(zonePreviewSource({
                              cameraIds: [z.camera], label: z.zone, typeLabel: z.kind === 'counter' ? 'Counter' : 'Zone', area: 'Live coverage',
                            }))}
                            aria-label={`View live feed — ${z.zone}, ${z.camera}`}
                            className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-line text-fg-secondary transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-7 lg:w-7"
                          >
                            <Camera className="h-3.5 w-3.5" />
                          </button>
                        </MetaHover>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
        <p className="mt-auto shrink-0 border-t border-line-subtle px-4 py-2 text-caption text-fg-subtle">
          Counters alert after {unattendedMin}m unattended. Last hour = share of the past 60 minutes with staff detected.
          Select a coverage status to open that zone&rsquo;s events in the Event Log.
        </p>
      </section>
      {preview && <CameraPreviewModal source={preview} onClose={closePreview} />}
    </div>
  );
}

// The card header's view dropdown, in menu order.
const VIEWS = {
  all:          { label: 'All zones',    test: () => true },
  flagged:      { label: 'Flagged',      test: (z) => z.flagged },
  unattended:   { label: 'Unattended',   test: (z) => z.status === 'unattended' },
  understaffed: { label: 'Understaffed', test: (z) => z.status === 'understaffed' },
  covered:      { label: 'Covered',      test: (z) => z.status === 'covered' },
  counter:      { label: 'Counters',     test: (z) => z.kind === 'counter' },
  zone:         { label: 'Floor zones',  test: (z) => z.kind === 'zone' },
};

// The module's sticky header band (type.js TH), over px-4 cells.
const thCls = { left: `${TH_STICKY} ${TH.left}`, right: `${TH_STICKY} ${TH.right}` };
