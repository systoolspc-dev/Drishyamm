import { useState } from 'react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { FileSpreadsheet, TrendingUp, ClipboardList, ShieldCheck, AlertTriangle, Download, CheckCircle2, X } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import ExportButtons from '../campus/components/reports/ExportButtons';
import { REPORTS_DATA, SAFETY_DATA, PRODUCTIVITY_DATA, MOVEMENT_DATA } from './pages-data';
import { exportReportDocument } from '../report-document';

const TYPE_ICON = { operations: ClipboardList, safety: ShieldCheck, incidents: AlertTriangle, productivity: TrendingUp };
const FMT_CHIP = { PDF: 'bg-danger-soft text-danger-ink ring-danger-line', Excel: 'bg-success-soft text-success-ink ring-success-line', CSV: 'bg-info-soft text-info-ink ring-info-line' };

function dataset(key) {
  switch (key) {
    case 'safety': return { columns: ['Incident', 'Detail', 'Level', 'Time'], rows: SAFETY_DATA.incidents.map((i) => [i.type, i.detail, i.level, i.time]) };
    case 'incidents': return { columns: ['Event', 'Detail', 'Level', 'Time'], rows: MOVEMENT_DATA.events.map((e) => [e.type, e.detail, e.level, e.time]) };
    case 'productivity': return { columns: ['Department', 'Active (min)', 'Idle (min)'], rows: PRODUCTIVITY_DATA.timeBreakdown.map((d) => [d.dept, d.active, d.idle]) };
    default: return { columns: ['Week', 'Incidents', 'Compliance %'], rows: REPORTS_DATA.weeklyTrend.map((w) => [w.week, w.incidents, w.compliance]) };
  }
}

export default function Reports() {
  const d = REPORTS_DATA;
  const [toast, setToast] = useState(null);

  // Every format is a real, branded download (logo, header, report ID).
  const handleExport = async (report, format) => {
    const { columns, rows } = dataset(report.key);
    await exportReportDocument({
      title: report.title,
      code: `HSP-${report.key}`,
      subtitle: `Drishyam Activity Monitoring  -  ${report.desc || 'Hospitality report'}`,
      details: [['Vertical', 'Hospitality'], ['Last Generated', report.lastGenerated]],
      tables: [{ title: report.title, columns, rows }],
    }, format);
    setToast({ tone: 'ok', msg: `${report.title} · ${format} downloaded.` });
  };

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><FileSpreadsheet className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Reports</h1><p className="mt-1 text-small text-fg-muted">Generate summaries for stakeholders, and see how this week compares to last.</p></div>
        </div>

        {toast && (
          <div className={`mb-4 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-small ${toast.tone === 'ok' ? 'border-success-line bg-success-soft text-success-ink' : 'border-info-line bg-info-soft text-info-ink'}`}>
            <CheckCircle2 className="h-4 w-4 shrink-0" /><span className="flex-1">{toast.msg}</span><button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={TrendingUp} title="Incidents & Compliance, Last 8 Weeks" right={<span className="text-caption text-fg-subtle">incidents vs compliance</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={d.weeklyTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="week" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="incidents" name="Incidents" stroke="#f43f5e" strokeWidth={2} dot={{ r: 2.5 }} />
                    <Line type="monotone" dataKey="compliance" name="Compliance %" stroke="#F7983A" strokeWidth={2} dot={{ r: 2.5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={TrendingUp} title="This Week vs Last" right={<span className="text-caption text-fg-subtle">key metrics</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.thisVsLast} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }} barCategoryGap={16}>
                    <CartesianGrid stroke="var(--line)" horizontal={false} />
                    <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="metric" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={82} />
                    <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="lastWeek" name="Last week" fill="var(--line)" radius={[0, 4, 4, 0]} maxBarSize={14} />
                    <Bar dataKey="thisWeek" name="This week" fill="#F7983A" radius={[0, 4, 4, 0]} maxBarSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-fg sm:text-base">Report Library</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {d.reportTypes.map((r) => {
                const Icon = TYPE_ICON[r.key] || ClipboardList;
                return (
                  <div key={r.key} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-sm transition hover:shadow-md">
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"><Icon className="h-5 w-5" strokeWidth={2} /></span>
                      <div className="min-w-0 flex-1"><p className="text-body font-bold text-fg">{r.title}</p><p className="mt-0.5 text-caption leading-snug text-fg-muted">{r.desc}</p></div>
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-line-subtle pt-3">
                      <span className="text-micro text-fg-subtle">Last {r.lastGenerated}</span>
                      <ExportButtons size="sm" onExport={(fmt) => handleExport(r, fmt)} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <Panel icon={Download} title="Report History" count={d.reportHistory.length} bodyClass="p-4">
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
