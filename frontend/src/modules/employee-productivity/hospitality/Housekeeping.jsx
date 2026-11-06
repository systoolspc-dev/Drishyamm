import { ResponsiveContainer, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Sparkles, RotateCcw, Activity, Timer, LayoutGrid } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { HOUSEKEEPING_DATA } from './pages-data';
import { StatCards, Chip } from './components/bits';

const ICONS = { cleaning: Sparkles, turnaround: RotateCcw, active: Activity, revisit: Timer };

export default function Housekeeping() {
  const d = HOUSEKEEPING_DATA;
  const cards = [
    { key: 'cleaning', label: 'Room Cleaning Time', value: d.stats.cleaningTime.value, sub: d.stats.cleaningTime.deltaLabel },
    { key: 'turnaround', label: 'Room Turnaround', value: d.stats.turnaroundTime.value, sub: d.stats.turnaroundTime.deltaLabel },
    { key: 'active', label: 'Active Working Time', value: d.stats.activeWorking.value, sub: d.stats.activeWorking.deltaLabel },
    { key: 'revisit', label: 'Room Revisits', value: d.stats.revisitCount.value, sub: d.stats.revisitCount.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Sparkles className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Housekeeping Analytics</h1><p className="mt-1 text-small text-fg-muted">How efficiently rooms are cleaned and turned around, right now.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={Timer} title="Cleaning Time by Room Type" right={<span className="text-caption text-fg-subtle">minutes</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.cleaningByType} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="type" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} cursor={{ fill: 'rgba(247,152,58,0.06)' }} />
                    <Bar dataKey="minutes" name="Minutes" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={44} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={Activity} title="Active Time Through the Day" right={<span className="text-caption text-fg-subtle">% cleaning</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.activityTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <defs><linearGradient id="hospHkAct" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.28} /><stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                    <Tooltip {...TIP} />
                    <Area type="monotone" dataKey="active" name="Active %" stroke="#0ea5e9" strokeWidth={2} fill="url(#hospHkAct)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
          <Panel icon={LayoutGrid} title="Floor Status Right Now" count={d.floorStatus.length} bodyClass="p-4">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Floor section</th><th className="px-2 pb-2 font-semibold">Assignment</th><th className="px-2 pb-2 font-semibold">Revisits</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
              <tbody className="divide-y divide-line-subtle">
                {d.floorStatus.map((f, i) => (
                  <tr key={i} className="hover:bg-surface-sunken">
                    <td className="px-2 py-2.5 text-heading font-semibold text-fg">{f.name}</td>
                    <td className="px-2 py-2.5 text-fg-muted">{f.role}</td>
                    <td className="px-2 py-2.5 tabular-nums text-fg-secondary">{f.revisits} revisit{f.revisits === 1 ? '' : 's'}</td>
                    <td className="px-2 py-2.5 text-right"><Chip status={f.status} label={f.status} /></td>
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
