import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, BarChart3, CheckCircle2, ChevronDown, Download, Eye, FileText, Flag, Funnel, Gauge, GraduationCap, HeartPulse, LayoutGrid,
  Loader2, MapPin, Search, Sheet, Smartphone, Table2, Trophy, X,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/core/ui/popover';
import { toast } from '@/core/store/toastStore';
import PolicyRulesButton from './PolicyRulesButton';
import { KpiCard, KpiRow } from './kpi-card';
import ScorecardQuickView from './ScorecardQuickView';
import StaffInsights from './StaffInsights';
import ScorecardInsights from './ScorecardInsights';
import ReportScopeFilters from './ReportScopeFilters';
import ExportReportMenu from './ExportReportMenu';
import { cn } from '@/core/lib/utils';
import { T, TH, TH_STICKY } from './type';
import { useReportContext, useReportScope, useSiteRequired } from './report-scope';
import {
  BREAK_WARN_MIN, COACHING_BELOW, COUNTER_WARN_MIN, ROLE_CHIP, avatarStyle, hueStyle, initials, scoreBand, scoreBar, scoreCls,
} from './scorecard';
import { formatRange } from './scorecard-export';
import { exportEmployee, exportSection } from './report-bundle';

// Staff Performance — the weekly per-employee scorecard the owner forwards to
// HR/payroll: team KPIs, then every employee as a table or a card matrix.
// Split out of Reports, which is now only the export catalog; both pages share
// one scope (report-scope.js), so the site picked on one holds on the other.
//
// Frontend-only: dummy data (future backend: GET /activity/report?store&from&to&shift).
// score = 0.4·onTime + 0.3·hoursVsShift + 0.2·breakCompliance + 0.1·(1−phoneRate), ×100
// — computed server-side once the API exists; the dummy values follow it.
// The dummy dataset is one week for one store, so until the API lands the
// rows don't change with the filters — only the scope the export declares does.

const BTN_MINI = 'inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-micro font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50';

// Ghost icon button — per-employee actions (table row + card footer) that shouldn't compete with the data.
const BTN_ICON = 'grid h-7 w-7 place-items-center rounded-md text-fg-muted transition hover:bg-surface-muted hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50 data-[state=open]:bg-surface-muted data-[state=open]:text-brand-ink';

function PhoneBadge({ n }) {
  if (!n) return <span className="text-small tabular-nums text-fg-subtle">0</span>;
  const tone = n >= 3 ? 'border-danger-line bg-danger-soft text-danger-ink' : 'border-warning-line bg-warning-soft text-warning-ink';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro font-bold tabular-nums ${tone}`}>
      <Smartphone className="h-3 w-3" /> {n}
    </span>
  );
}

function ImpactCell({ impact }) {
  const counter = impact?.counterMin ?? 0;
  const queue = impact?.queueBreaches ?? 0;
  if (!counter && !queue) {
    return <span className="inline-flex items-center gap-1 text-caption text-fg-subtle"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> None</span>;
  }
  const chip = 'inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums';
  return (
    <div className="flex flex-wrap gap-1">
      {counter > 0 && (
        <span
          title="Minutes their counter sat unattended past the policy limit"
          className={`${chip} ${counter >= COUNTER_WARN_MIN ? 'border-danger-line bg-danger-soft text-danger-ink' : 'border-warning-line bg-warning-soft text-warning-ink'}`}
        >
          Counter {counter}m
        </span>
      )}
      {queue > 0 && (
        <span title="Times the queue on their till exceeded the policy maximum" className={`${chip} border-warning-line bg-warning-soft text-warning-ink`}>
          Queue ×{queue}
        </span>
      )}
    </div>
  );
}

const BAND_BADGE = {
  Strong: 'border-success-line bg-success-soft text-success-ink',
  'On track': 'border-warning-line bg-warning-soft text-warning-ink',
  'Needs coaching': 'border-danger-line bg-danger-soft text-danger-ink',
};

function BandBadge({ score }) {
  const band = scoreBand(score);
  return <span className={`inline-flex whitespace-nowrap border ${T.stateBadge} ${BAND_BADGE[band]}`}>{band}</span>;
}

// Per-employee download icon → PDF / CSV menu. A ghost icon beside the View eye;
// the busy key stays per-format (emp:<id>:<fmt>) so the existing run() spinner logic holds.
const EMP_EXPORT_FORMATS = [
  { id: 'pdf', label: 'Export as PDF', icon: FileText },
  { id: 'csv', label: 'Export as CSV', icon: Sheet },
];

function EmployeeExportMenu({ r, busyKey, onExport, align = 'end' }) {
  const keyFor = (fmt) => `emp:${r.id}:${fmt}`;
  const busy = EMP_EXPORT_FORMATS.some((f) => busyKey === keyFor(f.id));
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={!!busyKey}>
        <button
          type="button"
          title="Export Data"
          aria-label={`Export ${r.name} scorecard`}
          className={BTN_ICON}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44 border-line bg-surface">
        {EMP_EXPORT_FORMATS.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => onExport(keyFor(f.id), r, f.id)} className="gap-2 text-small">
            <f.icon className="text-fg-muted" /> {f.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TONE_OK = { text: 'text-success-ink' };
const TONE_WARN = { text: 'text-warning-ink' };
const TONE_BAD = { text: 'text-danger-ink' };
const onTimeTone = (v) => (v >= 90 ? TONE_OK : v >= 75 ? TONE_WARN : TONE_BAD);

// One employee as a card — the Card Matrix view, and the table's phone layout.
// The score lives once, top right; the four metrics sit in a soft 2×2 grid
// (no meters — a grid of bars read as noise), with health-impact tags below.
function EmployeeCard({ r, rank, showImpact, busyKey, onView, onInsights, onExport }) {
  const overBreak = r.breakMin > BREAK_WARN_MIN;
  const breakText = `${r.breakMin}m / ${BREAK_WARN_MIN}m`;
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-3.5 shadow-sm">
      <div className="flex items-start gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-micro font-bold text-white" style={avatarStyle(r.name)} aria-hidden>{initials(r.name)}</span>
        <div className="min-w-0 flex-1">
          <Link to={`/activity-monitoring/employee/${r.id}`} className={`block truncate ${T.itemTitle} hover:text-brand-ink`}>{r.name}</Link>
          <p className={`mt-0.5 flex flex-wrap items-center gap-1.5 ${T.itemMeta}`}>
            <span className={`rounded-md border px-1.5 py-px ${ROLE_CHIP}`} style={hueStyle(r.role)}>{r.role}</span>
            <span>#{rank} · {r.days} days</span>
          </p>
        </div>
        <div className="text-right">
          <p className={`text-heading font-bold leading-none tabular-nums ${scoreCls(r.score)}`}>{r.score}</p>
          <p className="mt-1"><BandBadge score={r.score} /></p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-lg bg-surface-sunken px-3 py-2.5">
        <CardMetric label="On-time">
          <span className={onTimeTone(r.onTime).text}>{r.onTime}%</span>
        </CardMetric>
        <CardMetric label="Break time">
          {overBreak ? (
            <span
              title={`Exceeds the ${BREAK_WARN_MIN}m break guideline`}
              className="inline-flex rounded-full border border-warning-line bg-warning-soft px-1.5 py-px text-caption font-semibold text-warning-ink"
            >
              {breakText}
            </span>
          ) : breakText}
        </CardMetric>
        <CardMetric label="Avg shift">{r.avgH}</CardMetric>
        <CardMetric label="Phone activity"><PhoneBadge n={r.phone} /></CardMetric>
      </dl>

      {showImpact && (
        <div className={`mt-2.5 flex flex-wrap items-center gap-1.5 ${T.itemMeta}`}>
          <span>Health impact</span>
          <ImpactCell impact={r.impact} />
        </div>
      )}

      <div className="mt-auto flex items-center gap-1.5 pt-3">
        <button type="button" onClick={() => onView(r)} className={BTN_MINI} aria-label={`Quick view ${r.name}`}>
          <Eye className="h-3.5 w-3.5" /> View
        </button>
        <button type="button" onClick={() => onInsights(r)} className={BTN_MINI} aria-label={`Quick insights for ${r.name}`}>
          <BarChart3 className="h-3.5 w-3.5" /> Insights
        </button>
        <span className="ml-auto">
          <EmployeeExportMenu r={r} busyKey={busyKey} onExport={onExport} />
        </span>
      </div>
    </article>
  );
}

function CardMetric({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className={T.itemMeta}>{label}</dt>
      <dd className="mt-0.5 text-body font-semibold tabular-nums text-fg">{children}</dd>
    </div>
  );
}

const VIEWS = [
  { id: 'table', label: 'Table View', icon: Table2 },
  { id: 'cards', label: 'Card Matrix View', icon: LayoutGrid },
];

// Scorecard filters — narrow both views; ranks stay against the whole team.
const TOP_FROM = 90;
const TIERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'coaching', label: `Needs Coaching (<${COACHING_BELOW})`, test: (r) => r.score < COACHING_BELOW },
  { id: 'top', label: `Top Performers (≥${TOP_FROM})`, test: (r) => r.score >= TOP_FROM },
];
// `flagged` is set only from the Insights popover's [View Flagged Logs Only]:
// { ids, label } — the staff with an overstay or late clock-in in its range.
const NO_FILTERS = { tier: 'all', role: 'all', phone: false, flagged: null };

const activeFilterCount = (f) => (f.tier !== 'all') + (f.role !== 'all') + f.phone + !!f.flagged;

function applyFilters(rows, f) {
  const tier = TIERS.find((t) => t.id === f.tier) ?? TIERS[0];
  return rows.filter((r) => tier.test(r) && (f.role === 'all' || r.role === f.role) && (!f.phone || r.phone > 0)
    && (!f.flagged || f.flagged.ids.includes(r.id)));
}

// The Insights hand-off, visible and removable in the scorecard header and the filter popover.
function FlaggedChip({ flagged, onClear }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-danger-line bg-danger-soft pl-2 pr-0.5 text-micro font-semibold text-danger-ink">
      <Flag className="h-3 w-3" /> Flagged only · {flagged.label}
      <button
        type="button"
        onClick={onClear}
        aria-label="Show all employees"
        title="Show all employees"
        className="grid h-5 w-5 place-items-center rounded-full transition hover:bg-danger-line/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// Case-insensitive match on name, ID, role and department.
function applySearch(rows, query) {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => [r.name, r.id, r.role, r.department].some((v) => v != null && String(v).toLowerCase().includes(q)));
}

function ScorecardSearch({ query, setQuery }) {
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        placeholder="Search by employee name, ID, or role..."
        aria-label="Search employees"
        className="h-8 w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-8 text-sm text-fg placeholder:text-fg-subtle transition hover:border-line-strong focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery('')}
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-fg-subtle transition hover:bg-surface-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ScorecardFilters({ filters, setFilters, roles }) {
  const count = activeFilterCount(filters);
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count ? `Filters (${count} active)` : 'Filters'}
          title="Filter employees"
          className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            count
              ? 'border-brand-line bg-brand-soft text-brand-ink'
              : 'border-line bg-surface text-fg-muted hover:border-brand/40 hover:text-brand-ink data-[state=open]:border-brand/40 data-[state=open]:text-brand-ink'
          }`}
        >
          <Funnel className="h-3.5 w-3.5" />
          {count > 0 && (
            <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none text-white tabular-nums">
              {count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 border-line bg-surface p-0">
        <div className="space-y-3.5 p-3.5">
          <div>
            <p className="mb-1.5 text-micro font-semibold uppercase tracking-wider text-fg-muted">Performance tier</p>
            <div role="radiogroup" aria-label="Performance tier" className="flex flex-col gap-1">
              {TIERS.map((t) => {
                const on = filters.tier === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ tier: t.id })}
                    className={`flex h-8 items-center gap-2 rounded-md border px-2.5 text-left text-small font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                      on ? 'border-brand-line bg-brand-soft text-brand-ink' : 'border-line text-fg-secondary hover:border-line-strong'
                    }`}
                  >
                    <span className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${on ? 'border-brand' : 'border-line-strong'}`}>
                      {on && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
                    </span>
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-micro font-semibold uppercase tracking-wider text-fg-muted">Role</span>
            <select
              value={filters.role}
              onChange={(e) => set({ role: e.target.value })}
              className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-small font-medium text-fg-secondary transition hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <option value="all">All roles</option>
              {roles.map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-small font-medium text-fg-secondary">
            <input
              type="checkbox"
              checked={filters.phone}
              onChange={(e) => set({ phone: e.target.checked })}
              className="h-4 w-4 accent-brand"
            />
            <Smartphone className="h-3.5 w-3.5 text-fg-subtle" /> Phone Incidents (&gt;0)
          </label>

          {filters.flagged && (
            <div>
              <p className="mb-1.5 text-micro font-semibold uppercase tracking-wider text-fg-muted">From Insights</p>
              <FlaggedChip flagged={filters.flagged} onClear={() => set({ flagged: null })} />
            </div>
          )}
        </div>
        <div className="border-t border-line px-3.5 py-2.5">
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            disabled={!count}
            className="w-full rounded-md border border-line px-2.5 py-1.5 text-small font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear Filters
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function Performance() {
  const scope = useReportScope();
  const ctx = useReportContext(scope);
  const siteRef = useRef(null);
  const requireSite = useSiteRequired(scope, siteRef);

  const [selected, setSelected] = useState(null);
  const [insights, setInsights] = useState(null); // an employee row, or the team-average pseudo-row
  const [view, setView] = useState('table');
  const [busyKey, setBusyKey] = useState(null); // one export at a time

  async function run(key, job) {
    setBusyKey(key);
    try {
      await job();
    } catch (err) {
      toast.error('Export failed', err?.message || 'Could not build the file.');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="w-full page-inset">
      {/* Header — title left; scope filters + the scorecard export right */}
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center gap-3 lg:mr-auto">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <Trophy className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Staff Performance</h1>
              <PolicyRulesButton />
            </div>
            <p className={T.pageSub}>Weekly employee scorecard — for coaching, HR and payroll.</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <ReportScopeFilters scope={scope} siteRef={siteRef} />
          <ExportReportMenu
            align="end"
            reportName="Employee scorecard"
            blocked={!ctx}
            onBlocked={() => requireSite('export the scorecard')}
            busy={busyKey === 'scorecard'}
            onSelect={(format) => run('scorecard', () => exportSection(ctx, 'employees', format))}
            className="w-full md:w-auto"
          />
        </div>
      </div>

      {ctx ? <Scorecard ctx={ctx} view={view} setView={setView} busyKey={busyKey} run={run} onView={setSelected} onInsights={setInsights} /> : (
        <div className="grid place-items-center rounded-xl border border-dashed border-line bg-surface px-6 py-16 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-surface-muted text-fg-muted"><MapPin className="h-5 w-5" /></span>
          <h2 className="mt-3 text-lg font-semibold text-fg">Select a {scope.site.toLowerCase()} site</h2>
          <p className="mt-1 max-w-sm text-xs font-normal text-fg-muted">You have access to {scope.sites.length} sites. Pick one in the header to see its staff scorecard.</p>
          <button
            type="button"
            onClick={() => siteRef.current?.querySelector('select')?.focus()}
            className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary hover:border-brand/40 hover:text-brand-ink"
          >
            <MapPin className="h-4 w-4" /> Choose site
          </button>
        </div>
      )}

      {ctx && (
        <ScorecardQuickView
          row={selected}
          rank={selected ? ctx.rows.findIndex((r) => r.id === selected.id) + 1 : 0}
          total={ctx.rows.length}
          showImpact={ctx.showImpact}
          onClose={() => setSelected(null)}
        />
      )}
      {ctx && (
        <ScorecardInsights
          row={insights}
          showImpact={ctx.showImpact}
          period={formatRange(ctx.from, ctx.to)}
          onClose={() => setInsights(null)}
        />
      )}
    </div>
  );
}

function Scorecard({ ctx, view, setView, busyKey, run, onView, onInsights }) {
  const { rows, showImpact, site } = ctx;
  const rankOf = (r) => rows.findIndex((x) => x.id === r.id) + 1;
  const exportRow = (key, r, format) => run(key, () => exportEmployee(ctx, r, format));
  const cardProps = { showImpact, busyKey, onView, onInsights, onExport: exportRow };

  const [filters, setFilters] = useState(NO_FILTERS);
  const tableRef = useRef(null);
  const roles = useMemo(() => [...new Set(rows.map((r) => r.role))].sort(), [rows]);
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const shown = useMemo(() => applySearch(applyFilters(rows, filters), query), [rows, filters, query]);
  const filtered = activeFilterCount(filters) > 0 || searching;

  // Insights → [View Flagged Logs Only]: narrow to its flagged staff. Replaces
  // the tier and search so no other filter hides a flagged row.
  function viewFlagged(flagged) {
    setFilters({ ...NO_FILTERS, flagged });
    setQuery('');
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return (
    <>
      {/* NO KPI LAYER. This page used to open on four cards: store
          operational health, team average score, top performer and a
          needs-coaching count. Every one of them restated something already
          on screen or one screen away —
            store health      → the dashboard's Store Health KPI (dashboard/data.js)
            team average      → the Score column of the matrix below, and
                                ScorecardInsights' tier counts beside it
            top performer     → the matrix is sorted best-first; row 1 IS it
            needs coaching    → the Status column, and the same tier counts
          so the cards cost the page its first screen to say what the table
          says better. The two that doubled as quick filters (top / coaching)
          are the tier filter in Filters, which was always the fuller control.
          The four numbers are unchanged in the EXPORTS — scorecardKpis() in
          report-sections.js still carries them into every report. */}

      {/* Employee scorecard — table (md+) or card matrix */}
      <section
        id="employee-scorecard"
        ref={tableRef}
        aria-labelledby="scorecard-title"
        className="scroll-mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3.5 py-2.5">
          <div className="min-w-0">
            <h2 id="scorecard-title" className="text-lg font-semibold text-fg">Employee Scorecard</h2>
            <p className={T.itemMeta}>
              {filtered ? `${shown.length} of ${rows.length}` : rows.length} employees · {ctx.storeLabel} · {formatRange(ctx.from, ctx.to)} · {ctx.shiftLabel}
            </p>
          </div>
          {filters.flagged && <FlaggedChip flagged={filters.flagged} onClear={() => setFilters((f) => ({ ...f, flagged: null }))} />}
          <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
            <ScorecardSearch query={query} setQuery={setQuery} />
            <div role="radiogroup" aria-label="Scorecard view" className="inline-flex rounded-lg border border-line bg-surface-sunken p-0.5">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={view === v.id}
                  onClick={() => setView(v.id)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                    view === v.id ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  <v.icon className="h-3.5 w-3.5" /> <span className="max-sm:sr-only">{v.label}</span>
                </button>
              ))}
            </div>
            <StaffInsights onViewFlagged={viewFlagged} />
            <ScorecardFilters filters={filters} setFilters={setFilters} roles={roles} />
          </div>
        </div>

        {shown.length === 0 ? (
          <div className="grid place-items-center bg-surface-sunken px-6 py-12 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-muted text-fg-muted">
              {searching ? <Search className="h-4 w-4" /> : <Funnel className="h-4 w-4" />}
            </span>
            <p className="mt-3 break-all text-small font-semibold text-fg">
              {searching ? `No employees match '${query.trim()}'` : 'No employees match these filters'}
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {searching && (
                <button type="button" onClick={() => setQuery('')} className={BTN_EMPTY}>Clear Search</button>
              )}
              {activeFilterCount(filters) > 0 && (
                <button type="button" onClick={() => setFilters(NO_FILTERS)} className={BTN_EMPTY}>Clear Filters</button>
              )}
            </div>
          </div>
        ) : view === 'cards' ? (
          // Same inline scroll as the table, so the matrix never stretches the page
          <div className="scrollbar-thin max-h-[70vh] overflow-y-auto bg-surface-sunken">
            <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {shown.map((r) => <EmployeeCard key={r.id} r={r} rank={rankOf(r)} {...cardProps} />)}
            </div>
          </div>
        ) : (
          <>
            {/* Phones: the table's rows as stacked cards */}
            <div className="grid grid-cols-1 gap-3 bg-surface-sunken p-3 md:hidden">
              {shown.map((r) => <EmployeeCard key={r.id} r={r} rank={rankOf(r)} {...cardProps} />)}
            </div>
            {/* High-density table — header sticks while the body scrolls */}
            <div className="scrollbar-thin hidden max-h-[70vh] overflow-auto md:block">
              <table className="w-full min-w-[58rem] border-separate border-spacing-0 text-left text-sm">
                <thead>
                  <tr>
                    <th className={thCls.left}>Employee</th>
                    <th className={thCls.left}>Role</th>
                    <th className={`${thCls.num} w-24`}>Days Worked</th>
                    <th className={`${thCls.num} w-28`}>On-Time %</th>
                    <th className={thCls.num}>Avg Hours</th>
                    <th className={thCls.num}>Break Time</th>
                    <th className={`${thCls.num} w-28`}>Phone Incidents</th>
                    {showImpact && <th className={cn(thCls.left, 'whitespace-normal leading-tight')}>{site} Health Impact</th>}
                    <th className={cn(thCls.right, 'w-20 px-3')}>Score</th>
                    <th className={cn(thCls.center, 'w-28 px-2')}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const overBreak = r.breakMin > BREAK_WARN_MIN;
                    return (
                      <tr key={r.id} className="transition hover:bg-surface-sunken">
                        <td className={tdCls}>
                          <div className="flex items-center gap-2.5">
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-micro font-bold text-white" style={avatarStyle(r.name)} aria-hidden>
                              {initials(r.name)}
                            </span>
                            <Link to={`/activity-monitoring/employee/${r.id}`} className={`whitespace-nowrap ${T.tdPrimary} hover:text-brand-ink`}>
                              {r.name}
                            </Link>
                          </div>
                        </td>
                        <td className={tdCls}>
                          <span className={`inline-flex whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-normal ${ROLE_CHIP}`} style={hueStyle(r.role)}>
                            {r.role}
                          </span>
                        </td>
                        <td className={`${tdCls} text-right tabular-nums text-fg-secondary`}>{r.days}</td>
                        <td className={`${tdCls} text-right font-semibold tabular-nums ${onTimeTone(r.onTime).text}`}>
                          {r.onTime}%
                        </td>
                        <td className={`${tdCls} whitespace-nowrap text-right tabular-nums text-fg-secondary`}>{r.avgH}</td>
                        <td className={`${tdCls} text-right`}>
                          <span
                            title={overBreak ? `Exceeds the ${BREAK_WARN_MIN}m break guideline` : undefined}
                            className={`inline-flex items-center gap-1 tabular-nums ${overBreak ? 'font-semibold text-warning-ink' : 'text-fg-secondary'}`}
                          >
                            {overBreak && <AlertTriangle className="h-3.5 w-3.5" />}{r.breakMin}m
                          </span>
                        </td>
                        <td className={`${tdCls} text-right`}><PhoneBadge n={r.phone} /></td>
                        {showImpact && <td className={tdCls}><ImpactCell impact={r.impact} /></td>}
                        <td className={cn(tdCls, 'w-20 px-3')}>
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="h-1.5 w-7 shrink-0 overflow-hidden rounded-full bg-surface-muted">
                              <div className={`h-full rounded-full ${scoreBar(r.score)}`} style={{ width: `${r.score}%` }} />
                            </div>
                            <span className={`w-6 text-right text-sm font-bold tabular-nums ${scoreCls(r.score)}`}>{r.score}</span>
                          </div>
                        </td>
                        <td className={cn(tdCls, 'w-28 px-2')}>
                          <div className="flex items-center justify-center gap-1">
                            <button type="button" onClick={() => onView(r)} title="View Profile" aria-label={`Quick view ${r.name}`} className={BTN_ICON}>
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" onClick={() => onInsights(r)} title="Quick Insights — expected vs. actual" aria-label={`Quick insights for ${r.name}`} className={BTN_ICON}>
                              <BarChart3 className="h-3.5 w-3.5" />
                            </button>
                            <EmployeeExportMenu r={r} busyKey={busyKey} onExport={exportRow} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

// High-density table: the module's sticky header band (type.js TH) over
// px-4 py-2.5 cells, so header text sits over the cell text beneath it.
const thCls = {
  left: `${TH_STICKY} ${TH.left}`,
  right: `${TH_STICKY} ${TH.right}`,
  center: `${TH_STICKY} ${TH.center}`,
  // Numeric columns: right-aligned, and the two-word labels may wrap so the
  // header never sets a column wider than its short figures need.
  num: cn(TH_STICKY, TH.right, 'whitespace-normal leading-tight'),
};
const tdCls = 'border-b border-line-subtle px-4 py-2.5';
const BTN_EMPTY = 'inline-flex h-8 items-center rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary hover:border-brand/40 hover:text-brand-ink';
