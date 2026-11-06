import { useState } from 'react';
import { FileSpreadsheet, ClipboardCheck, ShieldAlert, Bus, IdCard, DoorOpen, GraduationCap, Clock, CheckCircle2, X, Download } from 'lucide-react';
import Panel from '../campus/components/Panel';
import ExportButtons from '../campus/components/reports/ExportButtons';
import {
  SCH_REPORT_TYPES, SCH_RECENT_REPORTS, ATT_SECTIONS, SAF_ALERTS, TR_BUSES, VIS_LOG, DIS_LOG, STUDENTS,
} from './pages-data';
import { exportReportDocument } from '../report-document';

const ICONS = { attendance: ClipboardCheck, safety: ShieldAlert, transport: Bus, visitor: IdCard, dismissal: DoorOpen, student: GraduationCap };
const FMT_CHIP = { PDF: 'bg-danger-soft text-danger-ink ring-danger-line', Excel: 'bg-success-soft text-success-ink ring-success-line', CSV: 'bg-info-soft text-info-ink ring-info-line' };
const PERIODS = [{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }];

// Table content per report category (frontend-only), for every export format.
function dataset(key) {
  switch (key) {
    case 'attendance': return { columns: ['Section', 'Teacher', 'Present', 'Total', 'Attendance %'], rows: ATT_SECTIONS.map((s) => [s.section, s.teacher, s.present, s.total, `${s.pct}%`]) };
    case 'safety': return { columns: ['Severity', 'Alert', 'Zone', 'Since', 'Status'], rows: SAF_ALERTS.map((a) => [a.severity, a.title, a.zone, a.since, a.status]) };
    case 'transport': return { columns: ['Bus', 'Route', 'Driver', 'ETA', 'Onboard', 'Capacity', 'Status'], rows: TR_BUSES.map((b) => [b.id, b.route, b.driver, b.eta, b.onboard, b.capacity, b.status]) };
    case 'visitor': return { columns: ['Visitor', 'Purpose', 'Host', 'In', 'Out', 'Status'], rows: VIS_LOG.map((v) => [v.name, v.purpose, v.host, v.checkIn, v.checkOut, v.status]) };
    case 'dismissal': return { columns: ['Student', 'Guardian', 'Mode', 'Time', 'Status'], rows: DIS_LOG.map((d) => [d.student, d.guardian, d.mode, d.time, d.status]) };
    default: return { columns: ['Student', 'ID', 'Grade', 'Attendance %', 'Punctuality %', 'Status'], rows: STUDENTS.map((s) => [s.name, s.id, `${s.grade}-${s.section}`, `${s.attendance}%`, `${s.punctuality}%`, s.status]) };
  }
}

export default function SchoolReports() {
  const [period, setPeriod] = useState('daily');
  const [toast, setToast] = useState(null);

  // Every format is a real, branded download (logo, header, report ID).
  const handleExport = async (report, format) => {
    const { columns, rows } = dataset(report.key || 'student');
    const p = String(report.period || period);
    await exportReportDocument({
      title: report.title,
      code: `SCH-${report.key || 'student'}`,
      subtitle: 'Drishyam Activity Monitoring  -  School report',
      details: [['Organisation', 'Greenwood International School'], ['Period', p.charAt(0).toUpperCase() + p.slice(1)]],
      tables: [{ title: report.title, columns, rows }],
    }, format);
    setToast({ tone: 'ok', msg: `${report.title} · ${format} downloaded.` });
  };

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><FileSpreadsheet className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Reports</h1>
            <p className="mt-1 text-small text-fg-muted">Generate and export school activity, safety and transport reports.</p>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="text-caption font-semibold uppercase tracking-wide text-fg-subtle">Period</span>
          <div className="inline-flex rounded-lg bg-surface p-0.5 text-small font-semibold ring-1 ring-line">
            {PERIODS.map((p) => (
              <button key={p.id} onClick={() => setPeriod(p.id)} className={`rounded-md px-3 py-1.5 transition ${period === p.id ? 'bg-brand/10 text-brand-ink ring-1 ring-brand/25' : 'text-fg-muted hover:text-fg-secondary'}`}>{p.label}</button>
            ))}
          </div>
        </div>

        {toast && (
          <div className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-small ${toast.tone === 'ok' ? 'border-success-line bg-success-soft text-success-ink' : 'border-info-line bg-info-soft text-info-ink'}`}>
            <CheckCircle2 className="h-4 w-4 shrink-0" /><span className="flex-1">{toast.msg}</span>
            <button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-fg sm:text-base">Report Library</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {SCH_REPORT_TYPES.map((r) => {
                const Icon = ICONS[r.key] || FileSpreadsheet;
                return (
                  <div key={r.key} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-sm transition hover:shadow-md">
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"><Icon className="h-5 w-5" strokeWidth={2} /></span>
                      <div className="min-w-0 flex-1"><p className="text-body font-bold text-fg">{r.title}</p><p className="mt-0.5 text-caption leading-snug text-fg-muted">{r.desc}</p></div>
                    </div>
                    <div className="mt-3"><span className="rounded-md bg-surface-sunken px-2 py-0.5 text-caption font-semibold text-fg-secondary ring-1 ring-line">{r.stat}</span></div>
                    <div className="mt-3 flex items-center justify-between border-t border-line-subtle pt-3">
                      <span className="text-micro font-medium capitalize text-fg-subtle">{period} report</span>
                      <ExportButtons onExport={(fmt) => handleExport({ title: r.title, key: r.key, period }, fmt)} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <Panel icon={Download} title="Recent Reports" count={SCH_RECENT_REPORTS.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Report</th><th className="px-2 pb-2 font-semibold">Type</th><th className="px-2 pb-2 font-semibold">Period</th>
                  <th className="px-2 pb-2 font-semibold">Generated</th><th className="px-2 pb-2 text-right font-semibold">Size</th><th className="px-2 pb-2 font-semibold">Format</th>
                  <th className="px-2 pb-2 text-right font-semibold"><Clock className="ml-auto hidden h-3 w-3" /></th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {SCH_RECENT_REPORTS.map((r, i) => (
                    <tr key={i} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2 text-heading font-semibold text-fg">{r.name}</td>
                      <td className="px-2 py-2 text-fg-secondary">{r.type}</td>
                      <td className="px-2 py-2 text-fg-muted">{r.period}</td>
                      <td className="px-2 py-2 text-fg-muted">{r.generated}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-fg-muted">{r.size}</td>
                      <td className="px-2 py-2"><span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${FMT_CHIP[r.format]}`}>{r.format}</span></td>
                      <td className="px-2 py-2 text-right">
                        <button onClick={() => handleExport({ title: r.name, key: r.type.toLowerCase(), period: r.period }, r.format)} className="inline-flex items-center justify-center rounded-md border border-line bg-surface p-1.5 text-fg-muted transition hover:border-brand/40 hover:text-brand-ink"><Download className="h-3.5 w-3.5" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
