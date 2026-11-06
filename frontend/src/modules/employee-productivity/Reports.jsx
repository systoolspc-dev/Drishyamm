import { useRef, useState } from 'react';
import { FileSpreadsheet, Package } from 'lucide-react';
import { useAuthStore } from '@/core/store/authStore';
import { toast } from '@/core/store/toastStore';
import PolicyRulesButton from './PolicyRulesButton';
import FederatedReportDialog from './FederatedReportDialog';
import ReportScopeFilters from './ReportScopeFilters';
import ExportReportMenu from './ExportReportMenu';
import { useActivityParams } from './useCaseStore';
import { useReportContext, useReportScope, useSiteRequired } from './report-scope';
import { REPORT_SERVICES } from './report-services';
import { exportSection } from './report-bundle';

// Reports — the export hub, and nothing else:
//   1. header: title · scope filters (period / shift / site) · Federated CTA
//   2. the report catalog: one card per domain report, one Export Report ▾
// The team KPIs and the employee scorecard live on Staff Performance
// (/activity-monitoring/performance), which shares this page's scope.
//
// Every export is built from ONE report context (report-scope.js →
// report-sections.js), so a number reads the same in every file and format.
// A report needs a site: multi-site users pick one; a single site is bound.

function ServiceCard({ service, site, available, busy, onExport, blocked, onBlocked }) {
  const Icon = service.icon;
  const title = service.title(site);
  return (
    <article className={`flex min-w-0 flex-col rounded-xl border border-line p-5 shadow-sm transition ${available ? 'bg-surface hover:border-brand/30 hover:shadow' : 'bg-surface-sunken'}`}>
      {/* One tile style for every card; an unavailable service only dims it. */}
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand ${available ? '' : 'opacity-50'}`}>
        <Icon className="h-5 w-5" strokeWidth={2} />
      </span>
      <h3 className="mt-4 text-body font-bold text-fg">{title}</h3>
      {/* Two-line minimum so the export buttons line up across the row. */}
      <p className="mt-1.5 min-h-[40px] text-small leading-5 text-fg-muted">{available ? service.description : service.unavailable}</p>
      <div className="mt-auto pt-5">
        <ExportReportMenu
          reportName={title}
          disabled={!available}
          busy={busy}
          blocked={blocked}
          onBlocked={onBlocked}
          onSelect={onExport}
        />
      </div>
    </article>
  );
}

export default function Reports() {
  const { params } = useActivityParams();
  const scope = useReportScope();
  const ctx = useReportContext(scope);
  const email = useAuthStore((st) => st.user?.email || '');
  const siteRef = useRef(null);
  const [fedOpen, setFedOpen] = useState(false);
  const [busyId, setBusyId] = useState(null); // one export at a time

  // No site yet: say so, and put the cursor on the site picker.
  const requireSite = useSiteRequired(scope, siteRef);

  async function runExport(id, format) {
    setBusyId(id);
    try {
      await exportSection(ctx, id, format);
    } catch (err) {
      toast.error('Export failed', err?.message || 'Could not build the file.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="w-full page-inset">
      {/* Header — title left; compact scope filters + the Federated CTA right */}
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center gap-3 lg:mr-auto">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <FileSpreadsheet className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Reports</h1>
              <PolicyRulesButton />
            </div>
            <p className="mt-1 text-small text-fg-muted">Export domain reports or a consolidated site audit.</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <ReportScopeFilters scope={scope} siteRef={siteRef} />
          <button
            type="button"
            onClick={() => (ctx ? setFedOpen(true) : requireSite('generate a federated site report'))}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-small font-semibold text-white shadow-sm hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:w-auto"
          >
            <Package className="h-4 w-4" /> Generate Federated Site Report
          </button>
        </div>
      </header>

      {/* Report catalog — 2 × 2 */}
      <section aria-labelledby="catalog-title">
        <h2 id="catalog-title" className="sr-only">Report catalog</h2>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {REPORT_SERVICES.map((s) => (
            <ServiceCard
              key={s.id}
              service={s}
              site={scope.site}
              available={s.id !== 'zones' || !!params.zones}
              busy={busyId === s.id}
              blocked={!ctx}
              onBlocked={() => requireSite('export this report')}
              onExport={(format) => runExport(s.id, format)}
            />
          ))}
        </div>
      </section>

      {ctx && (
        <FederatedReportDialog open={fedOpen} onOpenChange={setFedOpen} ctx={ctx} defaultEmail={email} />
      )}
    </div>
  );
}
