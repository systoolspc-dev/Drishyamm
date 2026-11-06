import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Sparkles, Timer, Droplets, LayoutGrid, Activity, Hourglass, Route } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { HOUSEKEEPING_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { StatCards, Chip } from './components/bits';

const ICONS = { floor: Timer, washroom: Droplets, common: LayoutGrid, active: Activity, idle: Hourglass, route: Route };

export default function Housekeeping() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = HOUSEKEEPING_DATA[hostel];
  const cards = [
    { key: 'floor', label: 'Floor Cleaning', value: d.floorCleaningDuration.value, sub: d.floorCleaningDuration.deltaLabel },
    { key: 'washroom', label: 'Washroom Cleaning', value: d.washroomCleaningDuration.value, sub: d.washroomCleaningDuration.deltaLabel },
    { key: 'common', label: 'Common Area', value: d.commonAreaCleaningTime.value, sub: d.commonAreaCleaningTime.deltaLabel },
    { key: 'active', label: 'Active Time', value: d.activeWorkingTime.value, sub: d.activeWorkingTime.deltaLabel },
    { key: 'idle', label: 'Idle Time', value: d.idleTime.value, sub: d.idleTime.deltaLabel },
    { key: 'route', label: 'Route Coverage', value: `${d.routeCoverage.value}%`, sub: d.routeCoverage.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Sparkles className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Housekeeping Analytics</h1><p className="mt-1 text-small text-fg-muted">Cleaning durations, active vs idle time and zone coverage.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel icon={Activity} title="Active vs Idle by Staff" right={<span className="text-caption text-fg-subtle">minutes</span>} bodyClass="p-4">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.activeIdleByStaff} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="name" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="active" name="Active" stackId="a" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="idle" name="Idle" stackId="a" fill="var(--line)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel icon={LayoutGrid} title="Zone Coverage" count={d.zoneCoverage.length} bodyClass="p-4">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Zone</th><th className="px-2 pb-2 font-semibold">Coverage</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
              <tbody className="divide-y divide-line-subtle">
                {d.zoneCoverage.map((z, i) => (
                  <tr key={i} className="hover:bg-surface-sunken">
                    <td className="px-2 py-2.5 text-heading font-semibold text-fg">{z.zone}</td>
                    <td className="px-2 py-2.5"><div className="flex items-center gap-2"><div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${z.coverage}%` }} /></div><span className="tabular-nums text-caption font-semibold text-fg-secondary">{z.coverage}%</span></div></td>
                    <td className="px-2 py-2.5 text-right"><Chip status={z.status} label={z.status} /></td>
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
