import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { UtensilsCrossed, Clock, Users, Timer, Building2, Store } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { DINING_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { StatCards, Chip } from './components/bits';

const ICONS = { wait: Clock, queue: Users, counters: Store, serving: Timer, occ: Building2 };

export default function Dining() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = DINING_DATA[hostel];
  const cards = [
    { key: 'wait', label: 'Waiting Time', value: d.studentWaitingTime.value, sub: d.studentWaitingTime.deltaLabel },
    { key: 'queue', label: 'Queue Length', value: `${d.queueLength.value}`, sub: d.queueLength.deltaLabel },
    { key: 'counters', label: 'Counters Open', value: `${d.counterAvailability.value} / ${d.counterAvailability.of}`, sub: d.counterAvailability.deltaLabel },
    { key: 'serving', label: 'Serving Time', value: d.servingTime.value, sub: d.servingTime.deltaLabel },
    { key: 'occ', label: 'Hall Occupancy', value: `${d.diningHallOccupancy.value}%`, sub: d.diningHallOccupancy.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><UtensilsCrossed className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Mess &amp; Dining Analytics</h1><p className="mt-1 text-small text-fg-muted">Queue, serving time, counters and hall occupancy.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel icon={UtensilsCrossed} title="Meal Trend" right={<span className="text-caption text-fg-subtle">wait vs queue</span>} bodyClass="p-4">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.mealTrend} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="meal" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                  <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="waitingMin" name="Wait (min)" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={22} />
                  <Bar dataKey="queueLength" name="Queue" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel icon={Store} title="Counters" count={d.counters.length} bodyClass="p-4">
            <table className="w-full border-collapse text-sm">
              <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Counter</th><th className="px-2 pb-2 text-right font-semibold">Queue</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
              <tbody className="divide-y divide-line-subtle">
                {d.counters.map((c, i) => (
                  <tr key={i} className="hover:bg-surface-sunken"><td className="px-2 py-2.5 text-heading font-semibold text-fg">{c.name}</td><td className="px-2 py-2.5 text-right tabular-nums text-fg-secondary">{c.queue}</td><td className="px-2 py-2.5 text-right"><Chip status={c.status} label={c.status} /></td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </div>
  );
}
