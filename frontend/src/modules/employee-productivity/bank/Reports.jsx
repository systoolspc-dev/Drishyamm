import { useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { FileSpreadsheet, Building2, CheckCircle2, AlertTriangle, TrendingUp, Download, X } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import ExportButtons from '../campus/components/reports/ExportButtons';
import { REPORTS_DATA } from './pages-data';
import { exportReportDocument } from '../report-document';

const HL_CHIP = { good: 'bg-success-soft text-success-ink ring-success-line', warn: 'bg-warning-soft text-warning-ink ring-warning-line' };

export default function Reports() {
  const d = REPORTS_DATA;
  const [toast, setToast] = useState(null);

  const totalStaff = d.departmentSummary.reduce((s, r) => s + r.staffCount, 0);
  const totalTasks = d.departmentSummary.reduce((s, r) => s + r.tasksCompleted, 0);
  const avgCompliance = Math.round(d.departmentSummary.reduce((s, r) => s + r.complianceScore, 0) / d.departmentSummary.length);

  const stat = [
    { key: 'staff', icon: Building2, label: 'Total Staff Tracked', value: `${totalStaff}`, sub: `across ${d.departmentSummary.length} departments` },
    { key: 'tasks', icon: CheckCircle2, label: 'Tasks Completed', value: `${totalTasks}`, sub: 'this week, branch-wide' },
    { key: 'compliance', icon: AlertTriangle, label: 'Avg. Compliance', value: `${avgCompliance}%`, sub: 'across all departments' },
  ];

  // Every format is a real, branded download (logo, header, report ID).
  const handleExport = async (report, format) => {
    await exportReportDocument({
      title: report.label,
      code: `BNK-${report.key}`,
      subtitle: 'Drishyam Activity Monitoring  -  Bank branch report',
      details: [['Vertical', 'Bank'], ['Prepared For', report.generatedFor]],
      tables: [{ title: report.label, sheet: 'Metrics', columns: ['Metric', 'Value'], rows: report.metrics.map((m) => [m.label, m.value]) }],
      rowNoun: 'metrics',
      filename: `${report.key}-report`,
    }, format);
    setToast({ tone: 'ok', msg: `${report.label} · ${format} downloaded.` });
  };

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><FileSpreadsheet className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Reports &amp; Analytics</h1><p className="mt-1 text-small text-fg-muted">Department-wise summaries and trends, branch-wide.</p></div>
        </div>

        {toast && (
          <div className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-small ${toast.tone === 'ok' ? 'border-success-line bg-success-soft text-success-ink' : 'border-info-line bg-info-soft text-info-ink'}`}>
            <CheckCircle2 className="h-4 w-4 shrink-0" /><span className="flex-1">{toast.msg}</span><button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {stat.map((s) => (
              <div key={s.key} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><s.icon className="h-4 w-4" strokeWidth={2} /></span>
                <p className="mt-3 truncate text-caption font-medium text-fg-muted">{s.label}</p>
                <p className="mt-1 text-metric-sm font-bold leading-none tracking-tight text-fg">{s.value}</p>
                <p className="mt-1.5 truncate text-micro text-fg-subtle">{s.sub}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Panel icon={TrendingUp} title="Compliance & Customer Volume, This Week" right={<span className="text-caption text-fg-subtle">daily trend</span>} bodyClass="p-4">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={d.weeklyTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                      <CartesianGrid {...GRID} />
                      <XAxis dataKey="day" tick={AXIS} axisLine={false} tickLine={false} />
                      <YAxis yAxisId="left" tick={AXIS} axisLine={false} tickLine={false} domain={[80, 100]} unit="%" />
                      <YAxis yAxisId="right" orientation="right" tick={AXIS} axisLine={false} tickLine={false} />
                      <Tooltip {...TIP} />
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                      <Line yAxisId="left" type="monotone" dataKey="compliance" name="Compliance %" stroke="#F7983A" strokeWidth={2} dot={{ r: 2.5 }} />
                      <Line yAxisId="right" type="monotone" dataKey="customers" name="Customers" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 2.5 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
            </div>
            <Panel icon={AlertTriangle} title="Highlights" count={d.highlights.length} bodyClass="p-4">
              <ul className="space-y-2">
                {d.highlights.map((h, i) => (
                  <li key={i} className="rounded-lg border border-line p-2.5">
                    <div className="flex items-center gap-1.5"><span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${HL_CHIP[h.level]}`}>{h.type}</span><span className="ml-auto text-micro text-fg-subtle">{h.time}</span></div>
                    <p className="mt-1 text-caption text-fg-secondary">{h.detail}</p>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-fg sm:text-base">Section Reports</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {d.sectionReports.map((r) => (
                <div key={r.key} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-sm transition hover:shadow-md">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"><FileSpreadsheet className="h-5 w-5" strokeWidth={2} /></span>
                    <div className="min-w-0 flex-1"><p className="text-body font-bold text-fg">{r.label}</p><p className="mt-0.5 text-caption text-fg-muted">{r.metrics.length} metrics · {r.generatedFor}</p></div>
                  </div>
                  <div className="mt-3 flex items-center justify-end border-t border-line-subtle pt-3">
                    <ExportButtons size="sm" onExport={(fmt) => handleExport(r, fmt)} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Panel icon={Download} title="Department Summary" count={d.departmentSummary.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Department</th><th className="px-2 pb-2 font-semibold">Staff count</th><th className="px-2 pb-2 font-semibold">Avg. active time</th><th className="px-2 pb-2 font-semibold">Tasks completed</th><th className="px-2 pb-2 text-right font-semibold">Compliance score</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.departmentSummary.map((row) => (
                    <tr key={row.dept} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{row.dept}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{row.staffCount}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{row.avgActiveTime}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{row.tasksCompleted}</td>
                      <td className="px-2 py-2.5 text-right font-semibold text-success-ink">{row.complianceScore}%</td>
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
