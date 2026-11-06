import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { SprayCan, Wrench, Zap, Activity } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { FACILITY_DATA } from './pages-data';
import { StatCards, Chip } from './components/bits';

const ICONS = { cleaning: SprayCan, maintenance: Wrench, downtime: Zap, active: Activity };

export default function Facility() {
  const d = FACILITY_DATA;
  const cards = [
    { key: 'cleaning', label: 'Cleaning Duration', value: d.stats.cleaningDuration.value, sub: `${d.stats.cleaningDuration.deltaLabel} · per zone` },
    { key: 'maintenance', label: 'Maintenance Response', value: d.stats.maintenanceResponse.value, sub: d.stats.maintenanceResponse.deltaLabel },
    { key: 'downtime', label: 'Equipment Downtime', value: d.stats.equipmentDowntime.value, sub: d.stats.equipmentDowntime.deltaLabel },
    { key: 'active', label: 'Active Working Time', value: d.stats.activeWorking.value, sub: d.stats.activeWorking.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Wrench className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Facility &amp; Support</h1><p className="mt-1 text-small text-fg-muted">Housekeeping and maintenance operations, branch-wide.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={Activity} title="Active Working Time Through the Day" right={<span className="text-caption text-fg-subtle">% working</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.activeTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <defs><linearGradient id="bankFac" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.28} /><stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                    <Tooltip {...TIP} />
                    <Area type="monotone" dataKey="active" name="Active %" stroke="#0ea5e9" strokeWidth={2} fill="url(#bankFac)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={SprayCan} title="Cleaning Duration by Zone" right={<span className="text-caption text-fg-subtle">minutes</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.cleaningByZone} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="zone" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} cursor={{ fill: 'rgba(247,152,58,0.06)' }} />
                    <Bar dataKey="minutes" name="Minutes" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={30} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
          <Panel icon={Wrench} title="Maintenance Tickets" count={d.tickets.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Equipment</th><th className="px-2 pb-2 font-semibold">Issue</th><th className="px-2 pb-2 font-semibold">Response time</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.tickets.map((t) => (
                    <tr key={t.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{t.equipment}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{t.issue}</td>
                      <td className="px-2 py-2.5 font-mono text-small text-fg-secondary">{t.responseTime}</td>
                      <td className="px-2 py-2.5 text-right"><Chip status={t.status} label={t.label} /></td>
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
