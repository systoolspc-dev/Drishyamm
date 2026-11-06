import { useState } from 'react';
import { FileSpreadsheet, CheckCircle2, Info, X } from 'lucide-react';

import FilterBar from './components/FilterBar';
import ReportLibrary from './components/reports/ReportLibrary';
import RecentReports from './components/reports/RecentReports';
import ScheduledReports from './components/reports/ScheduledReports';
import { PERIODS } from './reports-data';
import { exportReport } from './report-export';

// ─────────────────────────────────────────────────────────────────────────────
// Reports — campus subpage (reports centre).
//
// Report library (Department / Faculty / Student / Library / Lab / Attendance /
// Movement) scoped by period (Daily / Weekly / Monthly), exported as PDF / Excel
// / CSV, plus recent-report history and scheduled (auto) reports.
// FRONTEND-ONLY: every format is a real, branded download (report-export.js).
// ─────────────────────────────────────────────────────────────────────────────

export default function CampusReports() {
  const [filters, setFilters] = useState({
    university: 'sharda', building: 'all', department: 'all', floor: 'all', room: 'all', range: 'today',
  });
  const [period, setPeriod] = useState('daily');
  const [toast, setToast] = useState(null);

  // Every format produces a real, data-filled download (CSV / Excel / PDF).
  const handleExport = (report, format) => {
    exportReport({ ...report, period: report.period || period }, format);
    setToast({ tone: 'ok', msg: `${report.title} · ${format} downloaded.` });
  };

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title */}
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <FileSpreadsheet className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Reports</h1>
            <p className="mt-1 text-small text-fg-muted">Generate, schedule and export campus activity reports.</p>
          </div>
        </div>

        <FilterBar value={filters} onChange={setFilters} />

        {/* Period selector */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Period</span>
          <div className="inline-flex rounded-lg bg-surface p-0.5 text-small font-semibold ring-1 ring-line">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={`rounded-md px-3 py-1.5 transition ${period === p.id ? 'bg-brand/10 text-brand-ink ring-1 ring-brand/25' : 'text-fg-muted hover:text-fg-secondary'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Export toast */}
        {toast && (
          <div className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-small ${
            toast.tone === 'ok' ? 'border-success-line bg-success-soft text-success-ink' : 'border-info-line bg-info-soft text-info-ink'
          }`}>
            {toast.tone === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <Info className="h-4 w-4 shrink-0" />}
            <span className="flex-1">{toast.msg}</span>
            <button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          {/* Report library */}
          <div>
            <h2 className="mb-2 text-sm font-semibold text-fg sm:text-base">Report Library</h2>
            <ReportLibrary period={period} onExport={handleExport} />
          </div>

          <RecentReports onExport={handleExport} />
          <ScheduledReports />
        </div>
      </div>
    </div>
  );
}
