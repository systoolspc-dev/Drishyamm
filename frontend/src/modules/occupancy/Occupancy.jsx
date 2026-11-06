/**
 * Footfall & Occupancy — /occupancy
 *
 * One page over what used to be three: Headcount, Occupancy/Footfall and Crowd
 * Monitoring. They were split by which service produced them, which is an
 * implementation fact rather than a question anyone walks up to a screen
 * holding. The question is "is the building OK, and if not, where" — and
 * answering it needed all three at once.
 *
 *   Metric tiles        the answer, always visible above the panels
 *   Zone headcount      how many are inside each counted space, right now
 *   Gate Activity       how many came through each doorway today
 *
 * The rules those two are measured against used to be a third tab. They now
 * live at /occupancy/zone-setup, which is a superset of what the tab did --
 * the same fields plus the boundary, the cameras and the access whitelist --
 * so keeping both meant two places to set one thing.
 *
 * Three structural decisions worth keeping:
 *
 * There IS a page title block, with the shared icon tile. The page opened
 * bare for a while -- four tiles and a tab strip, no title -- on the argument
 * that a screen read from across a room should spend its largest type on
 * 412 / 600 rather than on its own name. What that cost was consistency:
 * every other page in the product opens with an icon, a name and a tagline,
 * so this one read as a different application, and the glyph that identifies
 * the module in the sidebar had no counterpart on the page. The long
 * description stays behind the title's info affordance
 * (`descriptionAs="tooltip"`), so the block is one row of chrome rather than
 * the four it would have been as a visible paragraph.
 *
 * The metric tiles sit at the TOP OF THE CONTENT, above both panels. Reading
 * the rooms and then the doorways is a change of detail, not of subject —
 * putting the headline numbers inside either panel would mean scrolling back
 * to re-read them.
 *
 * There is no tab strip. Usage Trends — the hourly record — was the second
 * tab; it is now /occupancy/usage-trends with a sidebar row of its own,
 * because the live wall and the historical record are opened at different
 * times, by different people, for different reasons. A tab strip claimed the
 * two were one subject and denied the record the one entry point someone
 * hunting for past numbers would think to use. Both old `?tab=` values
 * redirect, so bookmarks still land.
 */
import { useCallback, useMemo, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity, DoorOpen, LayoutGrid, MapPin, Plus, RefreshCw, Video, WifiOff,
} from 'lucide-react';
import {
  OperationsPage, PageContent, PageHeader, PageAction,
} from '@/core/layout/OperationsPage';
import Panel from '@/core/ui/panel';
import { NoCamerasOnboarding } from '@/core/components/RequireCameras';
import { useCameraPresence } from '@/core/hooks/useCameraPresence';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { useOccupancy } from './useOccupancy';
import { STATUS_BAR, nfmt } from './occupancy-data';
import {
  GateActivityMatrix, MetricBar, SetupCard, ZoneHeadcountTable,
} from './components/bits';
import QuickZoneDrawer from './components/QuickZoneDrawer';

const PAGE_DESCRIPTION =
  'Live occupancy for every counted space, the IN/OUT crossings at every gate, and the congestion those two produce together. Capacity, dwell ceilings, operating hours and privacy mode are set per space under Zone Setup — a space turns amber as it fills, and red once it is over its limit.';

const PAGE_TAGLINE =
  'Live occupancy per space and IN / OUT crossings at every gate. Past records are under Past Headcount Data.';

// What the account needs before any of this page can show a number. On an
// estate with no cameras RequireCameras draws these instead of the tiles and
// the two panels -- all three would otherwise render zeros and dashes, which
// reads as "nothing is happening here" rather than "nothing is watching yet".
const NO_CAMERA_BENEFITS = [
  {
    icon: MapPin,
    title: 'Live count per space',
    text: 'Draw a boundary on a camera and set its capacity: the space turns amber as it fills and red once it is over.',
  },
  {
    icon: DoorOpen,
    title: 'IN / OUT at every gate',
    text: 'A crossing line on a doorway counts people both ways, so the net still inside is a measured number.',
  },
  {
    icon: Activity,
    title: 'The record of both',
    text: 'Every reading is bucketed by hour, so Past Headcount Data can say how full the building was yesterday.',
  },
];

// Usage Trends left this page for a route of its own. Both slugs that used to
// select it as a tab still land somewhere correct, rather than dumping the
// visitor on a tab strip that no longer exists.
const USAGE_TRENDS_PATH = '/occupancy/usage-trends';
const MOVED_TO_USAGE_TRENDS = new Set(['usage-trends', 'analytics']);

// The rules tab moved out to its own route. Both slugs that used to reach it
// still land somewhere correct rather than dumping the visitor on the default
// tab with no explanation.
const MOVED_TO_ZONE_SETUP = new Set(['room-config', 'settings']);
const ZONE_SETUP_PATH = '/occupancy/zone-setup';

export default function Occupancy() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // With an id, Zone Setup opens on that zone rather than the first one, so the
  // drawer's "go to full setup" lands on the zone the operator was editing.
  const openZoneSetup = useCallback((zoneId) => (
    navigate(typeof zoneId === 'string' ? `${ZONE_SETUP_PATH}?zone=${encodeURIComponent(zoneId)}` : ZONE_SETUP_PATH)
  ), [navigate]);
  // Gate mode of the same page, on one camera.
  const openGateSetup = useCallback((monitorId) => (
    navigate(monitorId ? `${ZONE_SETUP_PATH}?gate=${encodeURIComponent(monitorId)}` : ZONE_SETUP_PATH)
  ), [navigate]);
  const [selected, setSelected] = useState(null);
  const [configuring, setConfiguring] = useState(null);

  // `?tab=` no longer selects anything here -- this page is one view. It is
  // still READ, because two of its old values named a view that MOVED, and a
  // stale bookmark should arrive where it meant to go rather than silently
  // here.
  const raw = params.get('tab');

  const {
    ready, errors, updatedAt, lineZones, regionZones, macro,
    rooms, setRooms, camByMonitor, gates, refresh,
  } = useOccupancy();

  // Does the ACCOUNT have a camera at all? Asked through the shared hook, so
  // this page and every other camera-driven one answer it the same way (and
  // TanStack dedupes the request). It decides both the empty state below and
  // whether the setup buttons belong in the header at all.
  //
  // Only the EMPTY answer is acted on -- not 'loading' and not 'error'. This
  // page's numbers come from the head-count and footfall services, not from
  // the camera registry, so putting the registry's spinner or its retry card
  // in front of them (which is what gating the whole page on RequireCameras
  // would do) would blank a working wall over a request the wall does not
  // depend on. A registry that is slow or down leaves the page exactly as it
  // was; only a registry that answers "zero cameras" changes it.
  const presence = useCameraPresence();
  const noCameras = presence.status === 'empty';

  // The drawer reads the zone from the live list, so its count keeps moving
  // with the wall; the snapshot only stands in if the zone drops out mid-edit.
  const configuringZone = configuring
    ? regionZones.find((z) => z.id === configuring.id) || configuring
    : null;

  const tiles = useMemo(() => [
    {
      key: 'live',
      label: 'Total campus occupancy',
      value: macro.capacity > 0 ? `${nfmt(macro.live)} / ${nfmt(macro.capacity)}` : nfmt(macro.live),
      sub: macro.busiest
        ? `Busiest: ${macro.busiest.label}${macro.busiest.capacity > 0 ? ` at ${macro.busiest.utilization}%` : ''}`
        : 'No space is counting yet',
      bar: macro.capacity > 0 ? macro.utilization : null,
      barColor: macro.utilization >= 90 ? STATUS_BAR.breach : macro.utilization >= 75 ? STATUS_BAR.busy : STATUS_BAR.ok,
      tone: macro.utilization >= 90 ? 'crit' : macro.utilization >= 75 ? 'warn' : 'ok',
      pill: macro.capacity > 0 ? `${macro.utilization}%` : null,
      tip: (
        <>
          <p><span className="font-bold">Purpose </span>Everyone inside a counted space right now, against the sum of those spaces&apos; limits.</p>
          <p className="mt-1"><span className="font-bold">Source </span>Head-count detector, one sample per camera every 1.5s.</p>
          <p className="mt-1">Gates are excluded — a doorway has no capacity, so counting one would inflate both halves of the ratio. Busiest is ranked by percentage, not headcount: a 3-person server room at 100% outranks a lobby holding 40 with room for 200.</p>
        </>
      ),
    },
    {
      key: 'footfall',
      label: 'Total Gate Traffic (In / Out)',
      value: `${nfmt(macro.dailyIn)} / ${nfmt(macro.dailyOut)}`,
      sub: `${macro.net >= 0 ? '+' : ''}${nfmt(macro.net)} net · ${macro.camerasTracking} of ${macro.camerasTotal} gates counting`,
      tip: (
        <>
          <p><span className="font-bold">Purpose </span>Every line crossing today — IN, OUT, and the net still inside.</p>
          <p className="mt-1"><span className="font-bold">Source </span>Footfall service, persisted per minute since midnight.</p>
          <p className="mt-1">Net should track the live occupancy above. A wide gap usually means a gate is counting one direction only.</p>
        </>
      ),
    },
    {
      key: 'breaches',
      label: 'Overcrowded Zones',
      value: nfmt(macro.breaches),
      sub: macro.breaches
        ? 'Over the configured limit right now'
        : macro.capacity > 0 ? 'Every space within its limit' : 'No capacity configured yet',
      tone: macro.breaches ? 'crit' : 'ok',
      tip: (
        <>
          <p><span className="font-bold">Purpose </span>Spaces standing over their limit — a fact, not a forecast.</p>
          <p className="mt-1"><span className="font-bold">Formula </span>count at or above max capacity, or anyone inside a space whose off-hours lock is active.</p>
        </>
      ),
    },
    {
      key: 'congestion',
      label: 'Congestion alerts',
      value: nfmt(macro.warnings),
      sub: macro.warnings ? 'Filling fast or nearing capacity' : 'No crowd forming',
      tone: macro.warnings ? 'warn' : 'ok',
      tip: (
        <>
          <p><span className="font-bold">Purpose </span>Crowds forming fast enough to become a breach, caught before the count itself is alarming.</p>
          <p className="mt-1"><span className="font-bold">Formula </span>at or above 90% of capacity, or +6 people inside 90 seconds.</p>
          <p className="mt-1">Kept separate from breaches because one is a level and the other is a rate — a bottleneck shows up here first.</p>
        </>
      ),
    },
  ], [macro]);

  const offline = errors.heads && errors.footfall;
  const serviceErrors = [errors.heads, errors.footfall].filter(Boolean);

  // THE SETUP BUTTONS LIVE IN ONE PLACE AT A TIME.
  //
  // Whatever this page is missing, the thing below it already says so and
  // carries the button that fixes it: with no camera on the account, the
  // empty state's one action is Camera Setup; with cameras but no zone, the
  // Zone Headcount panel's setup card goes exactly where the toolbar's
  // "Add / Manage Zones" went. Two buttons to one destination -- one of them
  // explaining itself and one of them a bare icon in a toolbar -- read as two
  // different things, and the operator then has to work out which. So the
  // toolbar drops its copy while the thing below is on screen, and gets it
  // back the moment there is something to MANAGE rather than to create.
  //
  // `ready` is part of the zone condition: before it the setup card renders
  // "Loading…" with no button at all, and hiding the toolbar on that frame
  // would leave the page with no way out to setup.
  const zoneSetupShownBelow = noCameras || (ready && !regionZones.length);

  // After every hook, so the hook order never changes between renders.
  if (MOVED_TO_ZONE_SETUP.has(raw)) return <Navigate replace to={ZONE_SETUP_PATH} />;
  if (MOVED_TO_USAGE_TRENDS.has(raw)) return <Navigate replace to={USAGE_TRENDS_PATH} />;

  return (
    <OperationsPage>
      {/* The shared title block -- icon tile, name, tagline, actions -- so
          this page's top level matches every other page in the product and
          the sidebar's glyph for the module has a counterpart on the page
          itself. The long description sits behind the info affordance beside
          the title rather than as a paragraph, which is what keeps the block
          to one row and the tiles at the top of the fold. */}
      <PageHeader
        description={PAGE_DESCRIPTION}
        descriptionAs="tooltip"
        icon={LayoutGrid}
        tagline={PAGE_TAGLINE}
        title="People count"
        actions={(
          <>
            {/* One service down still leaves half the page useful, so this is a
              pill beside the clock rather than an error state that blanks
              everything. The detail — which service, and that the numbers are
              the last good reading — is one hover away. */}
            {serviceErrors.length ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-warning-line bg-warning-soft px-2.5 py-1 text-[11px] font-semibold text-warning-ink"
                  role="status"
                  tabIndex={0}
                >
                  <WifiOff className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                  Service Offline
                  <span className="hidden text-warning-ink/70 sm:inline">· Retrying…</span>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[18rem] text-[10.5px] leading-relaxed" side="bottom" variant="card">
                {serviceErrors.join(' ')} The numbers shown are the last good reading; polling retries automatically.
              </TooltipContent>
            </Tooltip>
            ) : null}
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-caption text-fg-muted">
            <span className={`h-2 w-2 rounded-full ${offline ? 'bg-danger' : 'animate-pulse bg-success'}`} />
            <span className="hidden md:inline">Updated</span>
            <span className="font-semibold text-fg-secondary">
              {updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
            </span>
            </span>
            <PageAction onClick={refresh} type="button">
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="hidden sm:inline">Refresh</span>
            </PageAction>
            {/* The same count, per CAMERA rather than per zone -- a wall of live
              feeds with each one's number on it, and the switch for which
              cameras run the detector at all.

              It was labelled "Camera Counting Setup", which promised a form
              and delivered twelve video feeds; choosing the cameras is one
              dialog inside that page, not the page. "Camera" is the word
              carrying the distinction from this page's zone numbers, and the
              rest of the label now matches what the destination calls itself
              (and what Home's quick actions call it), so the click and the
              landing agree. */}
            {noCameras ? null : (
              <PageAction aria-label="Camera head count" onClick={() => navigate('/ai-event/headcount')} title="Live people count on each camera, and which cameras are counted" type="button">
                <Video className="h-3.5 w-3.5" strokeWidth={2} />
                <span className="hidden lg:inline">Camera Head Count</span>
              </PageAction>
            )}
            {zoneSetupShownBelow ? null : (
              <PageAction aria-label="Add or manage zones" onClick={() => openZoneSetup()} title="Add / Manage Zones" type="button">
                <Plus className="h-3.5 w-3.5" strokeWidth={2.25} />
                <span className="hidden sm:inline">Add / Manage Zones</span>
              </PageAction>
            )}
          </>
        )}
      />

      {/* From xl up the page fits the viewport: the tiles keep their height and
          the panels below share what is left, each scrolling inside itself.
          Smaller screens scroll the page as a whole. */}
      <PageContent className="gap-4 xl:overflow-hidden" scroll>
        {/* Nothing here can hold a number until the account has a camera, and
            an estate with none would otherwise get four tiles of zeros over
            two panels of dashes -- which reads as a quiet building, not as an
            unconfigured one. It sits INSIDE PageContent so the title block
            stays: the operator can still see which page they are on, and the
            one action is the page that fixes it. */}
        {noCameras ? (
          <NoCamerasOnboarding
            benefits={NO_CAMERA_BENEFITS}
            description="Add cameras from Camera Setup, then draw a zone or a gate line on the ones that should count. Live occupancy and gate traffic appear here."
            title="No cameras have been added"
          />
        ) : (
          <>
            <div className="shrink-0"><MetricBar tiles={tiles} /></div>

            {/* The congestion banner stood here: a stacked list of "N spaces
                need attention", ranked by severity. It came out because it was
                the third telling of the same reading — the Overcrowded Zones
                and Congestion alerts tiles are computed from the very same
                `congestion` array (buildMacro), and every zone it named is a
                row in the table below with its own status chip. What it alone
                had was the RANKING, which cost a banner's height on every load
                including the quiet ones. */}

            {/* Rooms and doorways side by side: "who is in there" and "who
                came through" are read against each other, so on a wide screen
                they share a row instead of one waiting below the other. */}
            <div className="grid shrink-0 items-stretch gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Panel
              bodyClass="p-3 xl:flex xl:flex-col"
              count={regionZones.length}
              icon={MapPin}
              right={<span className="text-micro font-semibold text-fg-subtle">Count / max capacity</span>}
              title="Zone headcount"
            >
              {regionZones.length ? (
                <ZoneHeadcountTable
                  onConfigure={setConfiguring}
                  onSelect={(zone) => setSelected((cur) => (cur?.id === zone.id ? null : zone))}
                  selectedId={selected?.id}
                  zones={regionZones}
                />
              ) : (
                <SetupCard
                  cta="Set Up Zones in Zone Setup"
                  hint="Turn head counting on for a camera, then draw its boundary and set a capacity in Zone Setup."
                  onSetup={() => openZoneSetup()}
                  ready={ready}
                  title="No space is counting yet"
                />
              )}
            </Panel>

            <Panel
              bodyClass="p-3 xl:flex xl:flex-col"
              count={lineZones.length}
              icon={DoorOpen}
              right={<span className="text-micro font-semibold text-fg-subtle">Today, since midnight</span>}
              title="Gate Activity Matrix"
            >
              {lineZones.length ? (
                <GateActivityMatrix onConfigure={openGateSetup} zones={lineZones} />
              ) : (
                <SetupCard
                  cta="Set Up Gates in Zone Setup"
                  // The zone card beside this one says what to do; without the
                  // same sentence here a first-time operator reads "No gate is
                  // counting yet" as a fault rather than as a step not taken.
                  hint="Point a camera at a doorway, then draw its crossing line in Zone Setup to count people in and out."
                  // Straight into gate mode on the first camera the footfall
                  // service knows; the rail there lists the rest.
                  onSetup={() => openGateSetup(Object.keys(gates)[0])}
                  ready={ready}
                  title="No gate is counting yet"
                />
              )}
            </Panel>
            </div>
          </>
        )}
      </PageContent>

      {/* Quick edit of one space from its card: the limit and the warning line,
          without losing the wall behind it. Zone Setup is for everything that
          needs the camera picture -- the drawer's footer links there. */}
      <QuickZoneDrawer
        onClose={() => setConfiguring(null)}
        onOpenZoneSetup={openZoneSetup}
        onSaved={setRooms}
        registry={camByMonitor}
        room={configuringZone ? rooms[configuringZone.id] : null}
        zone={configuringZone}
      />
    </OperationsPage>
  );
}
