import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useGroups } from '@/core/hooks/useQueries';
import { eventLogHref } from '@/modules/event-log/eventlog/log-query';
import {
  Activity, ChevronDown, Download, FileSpreadsheet, FileText, RefreshCw, ScrollText, Sheet as SheetIcon,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { download, exportScorecardPdf, exportScorecardXlsx, istNow, renderScorecardCsv } from '../scorecard-export';
import { useAuthStore } from '@/core/store/authStore';
import { useActivityParams } from '../useCaseStore';
import { useModuleData } from '../useModuleData';
import { ALL_SITES, useActivitySite, useActivitySites } from '../siteStore';
import PolicyTip from '../PolicyTip';
import { shiftSummary } from '../shifts';
import KpiGrid from './KpiGrid';
import NeedsAttention from './NeedsAttention';
import EmployeeStatus from './EmployeeStatus';
import CampusDashboard from '../campus/CampusDashboard';
import SchoolDashboard from '../school/SchoolDashboard';
import HostelDashboard from '../hostel/HostelDashboard';
import HospitalityDashboard from '../hospitality/HospitalityDashboard';
import BankDashboard from '../bank/BankDashboard';
import UseCaseSwitcher from '../UseCaseSwitcher';

// ─────────────────────────────────────────────────────────────────────────────
// Activity Monitoring Dashboard — the store manager's landing page.
//
// FRONTEND-ONLY build: every widget renders realistic dummy data from
// ./data.js; no API calls are made. When the activity-monitor backend lands,
// each section swaps its import for a useQuery against the endpoint named in
// data.js (and thresholds come from moduleParams(useCase,
// 'employee-productivity') instead of being baked into the copy).
// DTO shapes: ./dto.d.ts · full contract: docs/retail-activity-monitoring.md.
//
// Layout (desktop) — the whole page is now two bands:
//   sticky toolbar  (title + scope + live context + actions)
//   KPI cards       (1 → 2 → 4 columns, fixed-height cards from sm up)
//   [ employee status 60% | needs attention 40% ]  ← fills the rest
//
// RESPONSIVE MODEL
//   lg and up — the page is exactly one viewport tall (minus the topbar) and
//     never scrolls as a whole. The panel pair takes whatever height is left
//     (`flex-1`) and each list scrolls inside its own panel, so a 1366×768
//     laptop and a 1440p monitor both show the full dashboard with no dead
//     space and no page scroll. On a viewport too short for that, the body
//     scrolls rather than squashing the panels below a readable minimum.
//   below lg — natural document flow: everything stacks and the page scrolls.
//     A locked height on a phone would just clip the lists.
//
// WHAT IS NOT HERE, AND WHERE IT WENT
// The page is a realtime triage surface: it answers "what needs me now". Two
// things that used to live at the bottom were neither realtime nor triage, and
// both pushed the answer below the fold:
//   · Recent Activity stream → the Event Logs page (/event-logs), reached from
//     the header CTA with its live count. That page already has the filters,
//     search and CSV export an event stream actually needs; an eight-card rail
//     down here could offer none of them.
//   · Analytics charts → Retail Analytics
//     (/activity-monitoring/analytics), which opens on Today's Trends. Charts
//     are a "how did the day go" question asked once or twice a shift, not a
//     glance, and they now get a full page to answer it.
//
// HEADER — what this page is, and is not.
// The toolbar carries scope (which store) and context (what time, which shift,
// under which thresholds) — and no filters:
//   · Date picker — removed. A realtime page is always now; any other day is a
//     report. Attendance Report and Reports own the date range.
//   · Shift selector — removed. A shift is operator config, not a viewer
//     choice: the page resolves the shift that contains the current time from
//     params.shifts (src/use-cases/<vertical>/index.js) and states it.
//   · Policy strip — folded into the ⓘ beside the shift (PolicyTip).
//   · Store selector — kept, as the page's SCOPE rather than a filter. Its
//     options are the real sites (camera groups) whenever any exist, so the
//     id it holds is the same id Event Logs filters on: every link from here
//     into /event-logs carries it as ?siteId= and lands already scoped. The
//     demo STORES are only the fallback for a workspace with no sites.
// It is `sticky` under the topbar so that anything which grows in it (a filter
// row, a breach banner) pushes the grid down as one block and scrolls away
// cleanly, instead of shoving the KPI cards around mid-scroll. On lg+ the page
// is viewport-locked and never scrolls, so the toolbar is plain static there.
// ─────────────────────────────────────────────────────────────────────────────

// Export menu. All three formats go through the same branded writers the
// Reports page uses (scorecard-export.js): header block, then the roster.
const EXPORT_FORMATS = [
  { id: 'csv', label: 'Export as CSV', note: 'Header block + roster rows', icon: SheetIcon },
  { id: 'pdf', label: 'Export as PDF Report', note: 'Formatted summary with logo', icon: FileText },
  { id: 'xlsx', label: 'Export as Excel (.xlsx)', note: 'Summary + roster tabs', icon: FileSpreadsheet },
];

const EXPORT_COLUMNS = ['Name', 'Role', 'Zone', 'Shift', 'Status', 'Clock-in (IST)', 'Late by', 'Worked', 'Phone incidents'];

export default function ActivityDashboard() {
  // Same module, different vertical. When the Campus (education) use-case is
  // active, the dashboard renders the campus layout — hierarchy filters plus
  // student / faculty / library metrics — instead of the store/office layout.
  // Switch verticals from the toolbar's UseCaseSwitcher.
  const { useCase } = useActivityParams();
  if (useCase === 'campus') return <CampusDashboard />;
  if (useCase === 'school') return <SchoolDashboard />;
  if (useCase === 'hostel') return <HostelDashboard />;
  if (useCase === 'hospitality') return <HospitalityDashboard />;
  if (useCase === 'bank') return <BankDashboard />;

  return <RetailOfficeDashboard />;
}

function RetailOfficeDashboard() {
  // Retail and corporate share this dashboard; the retail-only KPIs (counter
  // coverage, billing queue) are gated inside KpiGrid so the corporate/office
  // vertical shows a clean attendance + presence view instead.
  const { useCase, params } = useActivityParams();
  const { STORES, NOW_IST, TODAY, EMPLOYEES, STATUS_META, FEED } = useModuleData();
  const user = useAuthStore((s) => s.user);
  const isRetail = useCase === 'retail';

  // Scope. The only thing on this page a viewer chooses, and the module-wide
  // site (siteStore.js): a pick here holds on every Activity Monitoring page
  // and across reloads. Real sites when the workspace has any (their ids are
  // what Event Logs understands), else the demo list.
  const sites = useActivitySites(STORES);
  const { siteId: store, bound, setSiteId: setStore } = useActivitySite({ sites });
  const siteWord = isRetail ? 'stores' : 'offices';
  // Only a real site travels to Event Logs as ?siteId= — a demo id would
  // match no camera group there and filter every row away.
  const { data: groups = [] } = useGroups();
  const siteId = groups.length && store !== ALL_SITES ? store : undefined;
  // Simulated fetch on refresh so loading skeletons are real, not dead code.
  const [loading, setLoading] = useState(false);
  const refresh = () => { setLoading(true); setTimeout(() => setLoading(false), 700); };

  // Context, derived — never picked. Shifts come from the vertical's params;
  // NOW_IST is the dummy clock that every number on the page agrees with.
  const shiftLine = shiftSummary(params.shifts, NOW_IST);

  // Badge on the Event Logs CTA. Today's event count — the same stream the
  // page it links to renders in full.
  const eventCount = FEED.length;

  // Export the employee-status snapshot (what a manager forwards to HR).
  // Lateness and phone incidents ride along now that they are row-level facts
  // rather than KPI cards — this CSV is where the analytical read lives.
  const exportRows = () => EMPLOYEES.map((e) => [
    e.name, e.role, e.zone, e.shift, STATUS_META[e.status]?.label || e.status,
    e.clockIn || '—', e.lateBy || '—', e.worked, e.phoneIncidents ?? 0,
  ]);
  const filename = `activity-monitoring-${TODAY}`;

  function exportCsv() {
    download(renderScorecardCsv(reportPayload()), `${filename}.csv`);
  }

  // PDF and Excel share one payload: header, a KPI row, then the roster.
  function reportPayload() {
    const now = istNow();
    const count = (status) => EMPLOYEES.filter((e) => e.status === status).length;
    const storeLabel = sites.find((s) => s.id === store)?.label || `All ${siteWord}`;
    return {
      title: 'Activity Monitoring Snapshot',
      reportId: `RPT-AM-${now.stamp}`,
      header: [
        ['Report Type', 'Activity Monitoring Snapshot'],
        [isRetail ? 'Store' : 'Office', storeLabel],
        ['Shift', shiftLine],
        ['Generated At', now.label],
        ['Generated By', user?.name || user?.email || 'Drishyam user'],
      ],
      policy: [],
      kpis: [
        { label: 'Staff', value: String(EMPLOYEES.length), note: 'On today\'s roster' },
        { label: STATUS_META.onfloor?.label || 'On floor', value: String(count('onfloor')), note: 'Present right now' },
        { label: 'Late', value: String(count('late')), note: 'Clocked in after shift start' },
        { label: 'Phone incidents', value: String(EMPLOYEES.reduce((n, e) => n + (e.phoneIncidents ?? 0), 0)), note: 'Across all staff' },
      ],
      tables: [{ title: 'Employee status', sheet: 'Employees', columns: EXPORT_COLUMNS, rows: exportRows() }],
      labels: {
        subtitle: `Live employee status as of ${NOW_IST} IST.`,
        footer: 'Exported from Drishyam Activity Monitoring.',
      },
      filename,
    };
  }

  const [exporting, setExporting] = useState(false);
  async function runExport(format) {
    if (format === 'csv') { exportCsv(); return; }
    setExporting(true);
    try {
      if (format === 'pdf') await exportScorecardPdf(reportPayload());
      else await exportScorecardXlsx(reportPayload());
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="min-h-[calc(var(--app-vh)-var(--topbar-h))] bg-surface-sunken/60 lg:flex lg:h-[calc(var(--app-vh)-var(--topbar-h))] lg:flex-col lg:overflow-hidden">
      {/* ── TOOLBAR · sticky, full-bleed ───────────────────────────────────
          Sticks to the top of <main>, the app's scroll container, just under
          the topbar. Full-bleed band with its own inset, so the blur
          reaches the page gutters instead of stopping at the content edge. */}
      <div className="sticky top-0 z-10 shrink-0 border-b border-line bg-surface-sunken/85 backdrop-blur-sm lg:static">
        <div className="w-full page-inset-x py-3">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
              <Activity className="h-5 w-5" />
            </div>

            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Staff activity</h1>

              {/* Context line: scope · clock · shift · policy. Everything here
                  is either the one choice the viewer makes (store) or a fact
                  the page derives — no control that silently filters below. */}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-fg-muted">
                {/* Store scope — styled as part of the sentence, not a filter */}
                <span className="relative inline-flex items-center">
                  <select
                    value={store}
                    onChange={(e) => setStore(e.target.value)}
                    aria-label={isRetail ? 'Store' : 'Office'}
                    className="cursor-pointer appearance-none rounded bg-transparent py-0.5 pr-4 text-small font-semibold text-fg-secondary transition hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    {!bound && <option value={ALL_SITES}>All {siteWord}</option>}
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-fg-subtle" aria-hidden />
                </span>

                <span className="text-fg-disabled" aria-hidden>·</span>

                {/* Live clock — the dummy "now" every widget below agrees with */}
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <span className="relative flex h-1.5 w-1.5" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                  </span>
                  Live · {NOW_IST} IST
                </span>

                <span className="text-fg-disabled" aria-hidden>·</span>

                {/* Shift is resolved from params.shifts, never chosen here */}
                <span className="whitespace-nowrap">{shiftLine}</span>

                <PolicyTip />
              </div>
            </div>

            {/* Actions. The vertical switcher sits with them because it is a
                control, not a heading. */}
            <div className="flex flex-wrap items-center gap-2">
              <UseCaseSwitcher />

              {/* The stream that used to sit at the bottom of this page. The
                  badge is the live count, so the CTA carries the information
                  the inline rail used to — without the vertical space. */}
              <Link
                to={eventLogHref({ siteId })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg-secondary transition hover:border-brand/40 hover:bg-brand/5 hover:text-brand-ink"
              >
                <ScrollText className="h-4 w-4" />
                Event Logs
                <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-micro font-bold text-brand-ink tabular-nums">
                  {eventCount}
                </span>
              </Link>

              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild disabled={exporting}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-lg bg-brand px-3.5 py-2 text-small font-medium text-white shadow-sm transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-60 data-[state=open]:bg-brand-hover"
                  >
                    <Download className="h-4 w-4" />
                    {exporting ? 'Exporting…' : 'Export'}
                    <ChevronDown className="h-3.5 w-3.5 opacity-80" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={8}
                  className="w-56 rounded-xl border-line bg-surface p-0 py-1 text-small text-fg-secondary shadow-lg"
                >
                  {EXPORT_FORMATS.map((f) => (
                    <DropdownMenuItem
                      key={f.id}
                      onSelect={() => runExport(f.id)}
                      className="mx-1 cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-small hover:bg-brand-soft hover:text-brand-ink focus:bg-brand-soft focus:text-brand-ink"
                    >
                      <f.icon className="mt-0.5 text-brand" />
                      <span className="flex flex-col">
                        <span className="font-medium">{f.label}</span>
                        <span className="text-micro text-fg-muted">{f.note}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                onClick={refresh}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-60"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Body. On lg+ it is the flex remainder under the toolbar; it only
          scrolls itself when the viewport is shorter than the panel minimum. */}
      <div className="flex w-full flex-col gap-2.5 page-inset-x py-3 sm:gap-3 sm:py-4 lg:min-h-0 lg:flex-1 lg:gap-4 lg:overflow-y-auto lg:py-4 xl:py-5">
        {/* ── SECTION 1 · KPI cards ─────────────────────────────────────── */}
        <div className="shrink-0">
          <KpiGrid loading={loading} />
        </div>

        {/* ── SECTION 2 · Employee Status (60%) | Needs Attention (40%) ──
            3:2 on lg+ — the roster takes the lead slot, with the alert queue
            beside it. The row takes the rest of the viewport (`flex-1`), so
            both panels share one height and scroll internally; neither list's
            length can stretch the row or leave the other short. The min-h is
            the floor below which the body scrolls instead of squashing them.
            Single column below lg (roster first, alerts under it). */}
        <div className="grid grid-cols-1 gap-2.5 sm:gap-3 lg:min-h-[22rem] lg:flex-1 lg:grid-cols-5 lg:gap-4">
          <div className="min-h-0 lg:col-span-3">
            <EmployeeStatus loading={loading} />
          </div>
          <div className="min-h-0 lg:col-span-2">
            <NeedsAttention loading={loading} siteId={siteId} />
          </div>
        </div>
      </div>
    </div>
  );
}
