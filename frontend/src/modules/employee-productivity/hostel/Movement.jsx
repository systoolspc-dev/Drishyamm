import { ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ArrowLeftRight, Ban, Users, ScanEye, Building2 } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { MOVEMENT_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { StatCards, LevelChip } from './components/bits';

const ICONS = { transitions: ArrowLeftRight, restricted: Ban, congestion: Users, coverage: ScanEye };

export default function Movement() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = MOVEMENT_DATA[hostel];
  const cards = [
    { key: 'transitions', label: 'Zone Transitions', value: d.zoneTransitionCount.value.toLocaleString(), sub: d.zoneTransitionCount.deltaLabel },
    { key: 'restricted', label: 'Restricted-Area Entry', value: `${d.restrictedAreaEntry.value}`, sub: d.restrictedAreaEntry.deltaLabel },
    { key: 'congestion', label: 'Congestion Detected', value: `${d.congestionDetection.value}`, sub: d.congestionDetection.deltaLabel },
    { key: 'coverage', label: 'Area Coverage', value: d.areaCoverage.value, sub: d.areaCoverage.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ArrowLeftRight className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Movement Analytics</h1><p className="mt-1 text-small text-fg-muted">Zone transitions, restricted-area detection and congestion.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel icon={Building2} title="Zone Compliance" right={<span className="text-caption text-fg-subtle">%</span>} bodyClass="p-4">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.zoneCompliance} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke="var(--line)" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={AXIS} axisLine={false} tickLine={false} unit="%" />
                  <YAxis type="category" dataKey="zone" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={130} />
                  <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                  <Bar dataKey="compliance" name="Compliance %" radius={[0, 4, 4, 0]} maxBarSize={16}>
                    {d.zoneCompliance.map((z) => <Cell key={z.zone} fill={z.compliance < 90 ? '#f59e0b' : '#F7983A'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel icon={ArrowLeftRight} title="Movement Events" count={d.movementEvents.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Event</th><th className="px-2 pb-2 font-semibold">Detail</th><th className="px-2 pb-2 font-semibold">Level</th><th className="px-2 pb-2 text-right font-semibold">Time</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.movementEvents.map((e, i) => (
                    <tr key={i} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{e.type}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{e.detail}</td>
                      <td className="px-2 py-2.5"><LevelChip level={e.level} /></td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-secondary">{e.time}</td>
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
