/**
 * Past Headcount Data (was "Usage Trends") — /occupancy/usage-trends.
 * The URL keeps the old slug so bookmarks and links still land.
 *
 * The RECORD of how full the building has been: the hourly occupancy curve,
 * the IN/OUT flow that produced it, and which space was full at which hour.
 *
 * It was a tab of /occupancy, beside the live wall. It is its own page now
 * because the two are read at different times by different people for
 * different reasons: the wall is glanced at all shift to answer "is it OK
 * right now", and this is opened deliberately to answer "what happened" —
 * planning, staffing, a complaint about Tuesday. A tab strip says the two are
 * alternate views of one subject and costs the second one a sidebar row of its
 * own, which is the only entry point someone looking for past records would
 * think to look for.
 *
 * The charts themselves are unchanged (`FlowAnalytics`), and so is the data
 * hook — the same poll that feeds the live wall also accrues the per-hour
 * history this page plots, so leaving it live is what fills the heatmap while
 * the page is open.
 *
 * Legacy `?tab=usage-trends` and `?tab=analytics` on /occupancy redirect here,
 * so bookmarks and links in handover notes still land.
 */
import { useMemo } from 'react';
import { Activity, LayoutGrid, RefreshCw, WifiOff } from 'lucide-react';
import {
  OperationsPage, PageAction, PageContent, PageHeader,
} from '@/core/layout/OperationsPage';
import { NoCamerasOnboarding } from '@/core/components/RequireCameras';
import { useCameraPresence } from '@/core/hooks/useCameraPresence';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { useOccupancy } from './useOccupancy';
import FlowAnalytics from './components/FlowAnalytics';

const PAGE_DESCRIPTION =
  'Past head-count records for every counted space: how full the building was hour by hour, whether it was filling or emptying, and which space was busiest at which hour. Hourly totals come from the footfall service and are kept since midnight; the per-zone heatmap is built from readings taken while this page is open.';

const NO_CAMERA_BENEFITS = [
  {
    icon: Activity,
    title: 'Hour-by-hour history',
    text: 'Occupancy and gate crossings bucketed per hour, so a busy Tuesday can be compared with a quiet one.',
  },
  {
    icon: LayoutGrid,
    title: 'Peak of the day',
    text: 'The hour each space filled up, ranked — the number staffing and cleaning rotas are planned against.',
  },
];

export default function UsageTrends() {
  const {
    errors, updatedAt, timeline, heatmap, refresh,
  } = useOccupancy();

  // Only the EMPTY answer is acted on -- not 'loading', not 'error'. The
  // series on this page comes from the footfall service, not from the camera
  // registry, so a slow or failed registry request must not put a spinner or
  // a retry card in front of charts that are perfectly able to draw.
  const presence = useCameraPresence();
  const noCameras = presence.status === 'empty';

  const peak = useMemo(() => (
    timeline.reduce((best, p) => (!best || p.inside > best.inside ? p : best), null)
  ), [timeline]);

  const offline = errors.heads && errors.footfall;
  const serviceErrors = [errors.heads, errors.footfall, errors.series].filter(Boolean);

  return (
    <OperationsPage>
      {/* The shared header, icon tile included -- the same anatomy as every
          other page in the product, so moving here from the live wall does not
          move the title, the icon or the action row. */}
      <PageHeader
        actions={
          <>
            {/* One service down still leaves most of the page useful, so this
                is a pill beside the clock rather than an error state that
                blanks the charts. */}
            {serviceErrors.length ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-warning-line bg-warning-soft px-2.5 py-1 text-caption font-semibold text-warning-ink"
                    role="status"
                    tabIndex={0}
                  >
                    <WifiOff className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                    Service Offline
                    <span className="hidden text-warning-ink/70 sm:inline">· Retrying…</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[18rem] text-caption leading-relaxed" side="bottom" variant="card">
                  {serviceErrors.join(' ')} The series shown is the last good reading; polling retries automatically.
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
            <PageAction onClick={refresh} title="Refresh" type="button">
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden sm:inline">Refresh</span>
            </PageAction>
          </>
        }
        description={PAGE_DESCRIPTION}
        descriptionAs="tooltip"
        icon={Activity}
        tagline="Past head-count records — hourly occupancy, net flow and utilisation per zone."
        title="Past Headcount Data"
      />

      <PageContent className="gap-4 xl:overflow-hidden" scroll>
        {/* Nothing on this page can have a history until a camera exists, so
            that comes first and the one way forward is Camera Setup. Inside
            PageContent, so the title block stays and the operator can still
            see which page they are on. */}
        {noCameras ? (
          <NoCamerasOnboarding
            benefits={NO_CAMERA_BENEFITS}
            description="Add cameras from Camera Setup, then turn head counting on for the ones you want recorded. Their hourly history appears here."
            title="No cameras have been added"
          />
        ) : (
          <FlowAnalytics heatmap={heatmap} peak={peak} timeline={timeline} />
        )}
      </PageContent>
    </OperationsPage>
  );
}
