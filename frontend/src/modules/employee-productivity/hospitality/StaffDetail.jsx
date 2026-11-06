import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ChevronLeft, Activity, Calendar, ShieldAlert, BellRing, CheckCircle2, X } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import ExportButtons from '../campus/components/reports/ExportButtons';
import { STAFF_DATA, generateTrend, generateIncidents } from './pages-data';
import { Chip, LevelChip } from './components/bits';
import { exportReportDocument } from '../report-document';

const initials = (n) => (n.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();

export default function StaffDetail() {
  const { id } = useParams();
  const emp = STAFF_DATA.find((e) => e.id === id);
  const [rangeDays, setRangeDays] = useState(7);
  const [toast, setToast] = useState(null);

  const trend = useMemo(() => (emp ? generateTrend(emp) : []), [emp]);
  const incidents = useMemo(() => (emp ? generateIncidents(emp) : []), [emp]);

  if (!emp) {
    return (
      <div className="w-full page-inset-x py-10 text-center">
        <p className="text-body text-fg-muted">Staff member not found.</p>
        <Link to="/activity-monitoring/hospitality/staff" className="mt-2 inline-block text-small font-semibold text-brand-ink hover:underline">← Back to Staff</Link>
      </div>
    );
  }

  const visibleTrend = trend.slice(-rangeDays);
  const avgActive = Math.round(visibleTrend.reduce((s, d) => s + d.activePct, 0) / visibleTrend.length);
  const avgResponse = (visibleTrend.reduce((s, d) => s + d.responseMin, 0) / visibleTrend.length).toFixed(1);
  const lateArrivals = incidents.filter((i) => i.type === 'Late clock-in').length;

  // Every format is a real, branded download (logo, header, report ID).
  const handleExport = async (format) => {
    await exportReportDocument({
      title: `Staff Performance Report - ${emp.name}`,
      code: `HSP-${emp.employeeId}`,
      subtitle: 'Drishyam Activity Monitoring  -  Individual staff report',
      details: [
        ['Employee', `${emp.name} (${emp.employeeId})`],
        ['Role & Department', `${emp.role} - ${emp.dept}`],
        ['Report Range', `Last ${rangeDays} days`],
        ['Scheduled Shift', emp.scheduledShift],
      ],
      kpis: [
        { label: 'Avg. active', value: `${avgActive}%`, note: `Last ${rangeDays} days` },
        { label: 'Avg. response', value: `${avgResponse} min`, note: `Team avg ${emp.teamAvgResponse}m` },
        { label: 'Compliance', value: `${emp.complianceScore}%`, note: 'PPE, uniform & zone rules' },
        { label: 'Late arrivals', value: lateArrivals, note: 'In the incident log' },
      ],
      tables: [{
        title: 'Daily performance',
        columns: ['Day', 'Active %', 'Response (min)', 'Tasks Done', 'Target'],
        rows: visibleTrend.map((r) => [r.label, `${r.activePct}%`, r.responseMin, r.tasksCompleted, r.tasksTarget]),
      }],
      rowNoun: 'days',
      filename: `${emp.name.replace(/\s+/g, '_')}_report_${rangeDays}d`,
    }, format);
    setToast({ tone: 'ok', msg: `${emp.name} · ${format} downloaded.` });
  };

  const cards = [
    { icon: Activity, label: 'Active', value: `${emp.activePct}%`, sub: `team avg ${emp.teamAvgLoad}%` },
    { icon: Calendar, label: 'Shift', value: emp.actualClockIn, sub: emp.scheduledShift, small: true },
    { icon: ShieldAlert, label: 'Compliance', value: `${emp.complianceScore}%`, sub: 'PPE, uniform & zone rules' },
    { icon: BellRing, label: 'Response', value: `${emp.avgResponse}m`, sub: `team avg ${emp.teamAvgResponse}m` },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <Link to="/activity-monitoring/hospitality/staff" className="mb-2 inline-flex items-center gap-1 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink"><ChevronLeft className="h-3.5 w-3.5" /> Back to Staff</Link>
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-heading font-bold text-brand-ink">{initials(emp.name)}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold text-fg sm:text-base">{emp.name}</h2><Chip status={emp.status} label={emp.status} /></div>
            <p className="truncate text-small text-fg-muted">{emp.employeeId} · {emp.role} · {emp.dept}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-lg bg-surface-muted p-0.5 text-caption font-semibold">
              {[7, 14].map((d) => <button key={d} onClick={() => setRangeDays(d)} className={`rounded-md px-2.5 py-1 transition ${rangeDays === d ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>Last {d}d</button>)}
            </div>
            <ExportButtons onExport={handleExport} />
          </div>
        </div>

        {toast && (
          <div className={`mb-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-small ${toast.tone === 'ok' ? 'border-success-line bg-success-soft text-success-ink' : 'border-info-line bg-info-soft text-info-ink'}`}>
            <CheckCircle2 className="h-4 w-4 shrink-0" /><span className="flex-1">{toast.msg}</span><button onClick={() => setToast(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map((c) => (
            <div key={c.label} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><c.icon className="h-4 w-4" strokeWidth={2} /></span>
              <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
              <p className={`mt-1 font-bold tracking-tight text-fg ${c.small ? 'text-body leading-tight' : 'text-metric-sm leading-none'}`}>{c.value}</p>
              <p className="mt-1.5 truncate text-micro text-fg-subtle">{c.sub}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel icon={Activity} title="Active % by Day" right={<span className="text-caption text-fg-subtle">avg {avgActive}%</span>} bodyClass="p-4">
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={visibleTrend} margin={{ top: 4, right: 6, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                  <Tooltip {...TIP} cursor={{ fill: 'rgba(247,152,58,0.06)' }} />
                  <Bar dataKey="activePct" name="Active %" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={20} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel icon={BellRing} title="Response Time Trend" right={<span className="text-caption text-fg-subtle">avg {avgResponse}m</span>} bodyClass="p-4">
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={visibleTrend} margin={{ top: 4, right: 6, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} unit="m" />
                  <Tooltip {...TIP} />
                  <Line type="monotone" dataKey="responseMin" name="Response (min)" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>

        <div className="mt-4">
          <Panel icon={ShieldAlert} title="Incident Timeline" count={incidents.length} right={lateArrivals > 0 ? <span className="text-caption font-semibold text-danger">{lateArrivals} late this range</span> : null} bodyClass="p-4">
            {incidents.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft/60 px-3 py-2.5 text-caption text-success-ink">No flagged incidents in this range.</div>
            ) : (
              <ul className="space-y-2">
                {incidents.map((inc, i) => (
                  <li key={i} className="rounded-lg border border-line p-2.5">
                    <div className="flex items-center gap-1.5"><p className="truncate text-small font-semibold text-fg">{inc.type}</p><span className="ml-auto"><LevelChip level={inc.level} /></span></div>
                    <p className="mt-0.5 truncate text-micro text-fg-muted">{inc.detail} · {inc.timeLabel}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
