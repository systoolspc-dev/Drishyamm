import { useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { FileSpreadsheet, TrendingUp, ShieldAlert, Sparkles, ShieldCheck, UtensilsCrossed, ClipboardList, Download, CheckCircle2, X } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import ExportButtons from '../campus/components/reports/ExportButtons';
import { REPORTS_DATA, SECURITY_DATA, HOUSEKEEPING_DATA, SAFETY_DATA, DINING_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { exportReportDocument } from '../report-document';

const REPORT_TYPES = [
  { key: 'operations', title: 'Operations Summary', desc: 'Weekly violations & compliance', icon: ClipboardList },
  { key: 'security', title: 'Security Report', desc: 'Entry/exit & incidents', icon: ShieldAlert },
  { key: 'housekeeping', title: 'Housekeeping Report', desc: 'Zone coverage & timings', icon: Sparkles },
  { key: 'safety', title: 'Safety Report', desc: 'Checkpoints & violations', icon: ShieldCheck },
  { key: 'mess', title: 'Mess Report', desc: 'Counters & serving', icon: UtensilsCrossed },
];
const FMT_CHIP = { PDF: 'bg-danger-soft text-danger-ink ring-danger-line', Excel: 'bg-success-soft text-success-ink ring-success-line', CSV: 'bg-info-soft text-info-ink ring-info-line' };

function dataset(key, hostel) {
  switch (key) {
    case 'security': return { columns: ['Incident', 'Detail', 'Level', 'Time'], rows: SECURITY_DATA[hostel].incidents.map((i) => [i.type, i.detail, i.level, i.time]) };
    case 'housekeeping': return { columns: ['Zone', 'Coverage %', 'Status'], rows: HOUSEKEEPING_DATA[hostel].zoneCoverage.map((z) => [z.zone, z.coverage, z.status]) };
    case 'safety': return { columns: ['Checkpoint', 'Status', 'Updated'], rows: SAFETY_DATA[hostel].checkpoints.map((c) => [c.point, c.status, c.updated]) };
    case 'mess': return { columns: ['Counter', 'Queue', 'Status'], rows: DINING_DATA[hostel].counters.map((c) => [c.name, c.queue, c.status]) };
    default: return { columns: ['Week', 'Violations', 'Compliance %'], rows: REPORTS_DATA[hostel].weeklyTrend.map((w) => [w.week, w.violations, w.compliance]) };
  }
}

export default function Reports() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = REPORTS_DATA[hostel];
  const [toast, setToast] = useState(null);

  // Every format is a real, branded download (logo, header, report ID).
  const handleExport = async (report, format) => {
    const { columns, rows } = dataset(report.key, hostel);
    const hostelLabel = `${hostel === 'boys' ? 'Boys' : 'Girls'} Hostel`;
    await exportReportDocument({
      title: report.title,
      code: `HST-${report.key}`,
      subtitle: `Drishyam Activity Monitoring  -  ${hostelLabel}`,
      details: [['Vertical', 'Hostel'], ['Hostel', hostelLabel], ['Covers', report.desc]],
      tables: [{ title: report.title, columns, rows }],
      filename: `${hostel}-hostel-${report.key}`,
    }, format);
    setToast({ tone: 'ok', msg: `${report.title} · ${format} downloaded.` });
  };

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><FileSpreadsheet className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Reports</h1><p className="mt-1 text-small text-fg-muted">Generate and export hostel operations, security and safety reports.</p></div>
        </div>

        {toast && (
          <div className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-small ${toast.tone === 'ok' ? 'border-success-line bg-success-soft text-success-ink' : 'border-info-line bg-info-soft text-info-ink'}`}>
            <CheckCircle2 className="h-4 w-4 shrink-0" /><span className="flex-1">{toast.msg}</span><button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          <Panel icon={TrendingUp} title="Weekly Trend" right={<span className="text-caption text-fg-subtle">violations vs compliance</span>} bodyClass="p-4">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={d.weeklyTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="week" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="violations" name="Violations" stroke="#f43f5e" strokeWidth={2} dot={{ r: 2.5 }} />
                  <Line type="monotone" dataKey="compliance" name="Compliance %" stroke="#F7983A" strokeWidth={2} dot={{ r: 2.5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-fg sm:text-base">Report Library</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {REPORT_TYPES.map((r) => (
                <div key={r.key} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-sm transition hover:shadow-md">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"><r.icon className="h-5 w-5" strokeWidth={2} /></span>
                    <div className="min-w-0 flex-1"><p className="text-body font-bold text-fg">{r.title}</p><p className="mt-0.5 text-caption leading-snug text-fg-muted">{r.desc}</p></div>
                  </div>
                  <div className="mt-3 flex items-center justify-end border-t border-line-subtle pt-3">
                    <ExportButtons onExport={(fmt) => handleExport({ title: r.title, key: r.key, desc: r.desc }, fmt)} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Panel icon={Download} title="Recent Reports" count={d.reportHistory.length} bodyClass="p-4">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Report</th><th className="px-2 pb-2 font-semibold">Range</th><th className="px-2 pb-2 font-semibold">Generated</th><th className="px-2 pb-2 font-semibold">Format</th></tr></thead>
              <tbody className="divide-y divide-line-subtle">
                {d.reportHistory.map((r, i) => (
                  <tr key={i} className="hover:bg-surface-sunken"><td className="px-2 py-2.5 text-heading font-semibold text-fg">{r.name}</td><td className="px-2 py-2.5 text-fg-muted">{r.range}</td><td className="px-2 py-2.5 text-fg-muted">{r.generated}</td><td className="px-2 py-2.5"><span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${FMT_CHIP[r.format]}`}>{r.format}</span></td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}
