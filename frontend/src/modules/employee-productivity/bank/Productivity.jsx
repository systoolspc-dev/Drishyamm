import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Gauge, Activity, Coffee, Smartphone, Hourglass } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { PRODUCTIVITY_DATA, STAFF_DATA } from './pages-data';
import { StatCards, Chip } from './components/bits';

const ICONS = { active: Activity, idle: Hourglass, break: Coffee, phone: Smartphone };

export default function Productivity() {
  const d = PRODUCTIVITY_DATA;
  const cards = [
    { key: 'active', label: 'Active Time', value: d.stats.activeTime.value, sub: d.stats.activeTime.deltaLabel },
    { key: 'idle', label: 'Idle Time', value: d.stats.idleTime.value, sub: d.stats.idleTime.deltaLabel },
    { key: 'break', label: 'Break Duration', value: d.stats.breakDuration.value, sub: d.stats.breakDuration.deltaLabel },
    { key: 'phone', label: 'Phone Usage', value: d.stats.phoneUsage.value, sub: d.stats.phoneUsage.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Gauge className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Workforce Productivity</h1><p className="mt-1 text-small text-fg-muted">How staff time is spent across customer-facing and support departments.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={Activity} title="Active vs Idle by Department" right={<span className="text-caption text-fg-subtle">minutes</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.timeBreakdown} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="dept" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="active" name="Active" stackId="a" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={26} />
                    <Bar dataKey="idle" name="Idle" stackId="a" fill="var(--line)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={Gauge} title="Active Staff Through the Day" right={<span className="text-caption text-fg-subtle">% working</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.activeTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <defs><linearGradient id="bankProd" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.28} /><stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                    <Tooltip {...TIP} />
                    <Area type="monotone" dataKey="active" name="Active %" stroke="#0ea5e9" strokeWidth={2} fill="url(#bankProd)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
          <Panel icon={Activity} title="Zone Occupancy by Staff Member" count={STAFF_DATA.length} bodyClass="p-4">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Staff</th><th className="px-2 pb-2 font-semibold">Department</th><th className="px-2 pb-2 font-semibold">Activity</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
              <tbody className="divide-y divide-line-subtle">
                {STAFF_DATA.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-sunken">
                    <td className="px-2 py-2.5"><Link to={`/activity-monitoring/bank/staff/${p.id}`} className="font-semibold text-fg hover:text-brand-ink">{p.name}</Link><p className="text-micro text-fg-subtle">{p.role}</p></td>
                    <td className="px-2 py-2.5 text-fg-muted">{p.dept}</td>
                    <td className="px-2 py-2.5"><div className="flex items-center gap-2"><div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${p.load}%` }} /></div><span className="tabular-nums text-caption text-fg-secondary">{p.load}%</span></div></td>
                    <td className="px-2 py-2.5 text-right"><Chip status={p.status} label={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}
