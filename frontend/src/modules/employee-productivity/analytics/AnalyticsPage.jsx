import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChartColumn, Clock3, UsersRound, LayoutGrid, Smartphone, Users } from 'lucide-react';
import {
  OperationsPage, PageHeader, PageContent, PageTabs,
} from '@/core/layout/OperationsPage';
import { useActivityParams } from '../useCaseStore';
import { useModuleData } from '../useModuleData';
import { shiftSummary } from '../shifts';
import { ALL_SITES, useActivitySite, useActivitySites } from '../siteStore';
import PolicyTip from '../PolicyTip';
import TrendsTab from './TrendsTab';
import StaffTab from './StaffTab';
import ZonesTab from './ZonesTab';
import PhoneTab from './PhoneTab';
import PhoneRangeBar from './PhoneRangeBar';
import HeadcountHistory from '../headcount/HeadcountHistory';

// ─────────────────────────────────────────────────────────────────────────────
// /activity-monitoring/analytics — the charts that used to sit at the bottom of
// the Activity Monitoring dashboard, given a page of their own.
//
// Why a page and not a collapsible band: "how is the day going" is a question
// asked once or twice a shift, and answering it well needs more room than a
// realtime triage screen can spare. On the dashboard the charts were either
// collapsed (and so invisible) or expanded (and so pushing the alert queue off
// screen). Here they get full width, and the dashboard gets its height back.
//
// WHY IT LIVES UNDER /activity-monitoring (§16). It first shipped at a
// top-level /analytics, in the Live & Records sidebar group. That was a
// product-wide word for a page that reports on exactly one module: a store
// manager who wanted their trend charts opened Activity Monitoring — where
// Zone Coverage, Breaks & Idle and Zone Headcount already live — and did not
// find them. The page is now a child of the module it describes, and the old
// /analytics/* URLs redirect here (App.jsx) so bookmarks survive.
//
// The default view is Today's Trends, because the first question is always
// about today. Staff and Zones are the two follow-ups: who, and where.
//
// Zone Coverage & Trends is the historical half of the live Zone Coverage
// page: the hourly matrix, shift compliance and the full incident log over a
// date range, with exports. It replaced Traffic & Zones — the old
// .../analytics/traffic URL redirects to it.
//
// Zone Headcount (…/analytics/headcount) is the historical half of the live
// Zone Headcount page: hourly density heatmap, peak & bottleneck summary and
// the capacity compliance log over a date range, with exports. Live occupancy
// is its own sidebar page (/activity-monitoring/headcount) — operations, not
// analytics. The old …/zone-headcount[/live|/historical] URLs redirect.
//
// The store is the page's scope, not a tab's: one selector in the header,
// bound to the module-wide site (siteStore.js) so it holds across tabs, the
// other Activity Monitoring pages and reloads. ?store= deep links still work
// and the address bar mirrors the pick, so a copied URL keeps its store.
//
// Tabs are ROUTES, not local state — .../analytics/trends, .../analytics/staff
// and .../analytics/zones are all linkable and back-button-able. The sidebar
// carries ONE row for the page (`matchPrefix`) rather than one per tab: three
// rows for three tabs of one page was the sidebar restating the tab strip.
// ─────────────────────────────────────────────────────────────────────────────

// Every link into this page derives from this constant — there is no second
// spelling of the base path to fall out of sync with the routes in App.jsx.
const BASE = '/activity-monitoring/analytics';

// Not exported: the sidebar declares its own child routes, and a second
// exported binding here would break Fast Refresh for the page.
const ANALYTICS_TABS = [
  { id: 'trends',  label: "Today's Trends",  Icon: Clock3 },
  { id: 'staff',   label: 'Staff',           Icon: UsersRound },
  { id: 'zones',   label: 'Zone Coverage & Trends', Icon: LayoutGrid },
  { id: 'phone-usage', label: 'Phone Usage', Icon: Smartphone },
  { id: 'headcount', label: 'Zone Headcount', Icon: Users },
];

const LIVE_HEADCOUNT = '/activity-monitoring/headcount';

const DEFAULT_TAB = 'trends';
const VALID = new Set(ANALYTICS_TABS.map((t) => t.id));

const PANES = {
  trends: TrendsTab,
  staff: StaffTab,
  zones: ZonesTab,
  'phone-usage': PhoneTab,
};

export default function AnalyticsPage() {
  const { tab, view } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { useCase, params } = useActivityParams();
  const { NOW_IST } = useModuleData();

  // Store scope — the module-wide site. Trends, Staff, Zones and Phone can
  // read "All stores"; the Zone Headcount history is per store, so there an
  // All preference shows the first store (the preference itself is kept).
  const sites = useActivitySites();
  const siteLabel = params.headcount?.label?.site || 'Store';
  const perSite = tab === 'headcount';
  const { siteId: store, bound, setSiteId: setStore } = useActivitySite({
    sites, allowAll: !perSite, fallbackToFirst: true, urlParam: 'store',
  });
  const qs = search.toString() ? `?${search.toString()}` : '';

  // Renamed tabs: keep old bookmarks working.
  if (tab === 'traffic') return <Navigate to={`${BASE}/zones${qs}`} replace />;
  // Zone Headcount's live view moved out to its own sidebar page; the rest of
  // the old tab is now …/headcount.
  if (tab === 'zone-headcount') {
    return <Navigate to={view === 'live' ? `${LIVE_HEADCOUNT}${qs}` : `${BASE}/headcount${qs}`} replace />;
  }
  // An unknown tab is a typo or a stale bookmark, not an error page.
  if (!VALID.has(tab)) return <Navigate to={`${BASE}/${DEFAULT_TAB}${qs}`} replace />;
  // No tab has sub-views.
  if (view) return <Navigate to={`${BASE}/${tab}${qs}`} replace />;

  const isRetail = useCase === 'retail';
  const pane = tab === 'headcount'
    ? <HeadcountHistory siteId={store} siteLabel={sites.find((s) => s.id === store)?.label} />
    : (() => { const Pane = PANES[tab]; return <Pane />; })();

  return (
    <OperationsPage>
      <PageHeader
        icon={ChartColumn}
        // Named for the vertical, matching its sidebar row — a store manager
        // looking for "Retail Analytics" should land on a page that says so.
        title={isRetail ? 'Retail Analytics' : 'Analytics'}
        description={
          isRetail
            ? 'Hourly trends, staff performance and zone flow for the selected store. Times IST.'
            : 'Hourly trends, staff performance and workspace flow for the selected office. Times IST.'
        }
        descriptionAs="tooltip"
        tagline={`${shiftSummary(params.shifts, NOW_IST)} · as of ${NOW_IST} IST`}
        actions={
          <>
            <PageTabs
              tabs={ANALYTICS_TABS}
              active={tab}
              onChange={(id) => navigate(`${BASE}/${id}${qs}`)}
            />
            {/* The page's scope: one store for every tab and view */}
            {sites.length > 0 && (
              <select
                value={store}
                onChange={(e) => setStore(e.target.value)}
                aria-label={siteLabel}
                title={siteLabel}
                className="h-11 max-w-[13rem] shrink-0 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary outline-none focus:border-brand lg:h-9"
              >
                {!perSite && !bound && <option value={ALL_SITES}>All {siteLabel.toLowerCase()}s</option>}
                {sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            )}
            {/* Phone Usage reads a date range; its picker and export sit
                beside the store, in the URL as ?startDate=&endDate= */}
            {tab === 'phone-usage' && (
              <PhoneRangeBar storeLabel={sites.find((s) => s.id === store)?.label} />
            )}
            <PolicyTip />
          </>
        }
      />

      <PageContent scroll>
        {pane}
      </PageContent>
    </OperationsPage>
  );
}
