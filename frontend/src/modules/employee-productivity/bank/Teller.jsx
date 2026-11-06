import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Users, Clock, ListOrdered, Timer, Armchair } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { TELLER_DATA } from './pages-data';
import { StatCards, Chip } from './components/bits';

const ICONS = { waiting: Clock, queue: ListOrdered, service: Timer, counters: Armchair };

export default function Teller() {
  const d = TELLER_DATA;
  const cards = [
    { key: 'waiting', label: 'Avg. Waiting Time', value: d.stats.waitingTime.value, sub: d.stats.waitingTime.deltaLabel },
    { key: 'queue', label: 'Queue Length (live)', value: d.stats.queueLength.value, sub: `${d.stats.queueLength.deltaLabel} · waiting` },
    { key: 'service', label: 'Service Completion', value: d.stats.serviceTime.value, sub: d.stats.serviceTime.deltaLabel },
    { key: 'counters', label: 'Counter Availability', value: d.stats.counterAvailability.value, sub: d.stats.counterAvailability.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Users className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Customer Service &amp; Teller</h1><p className="mt-1 text-small text-fg-muted">How efficiently customer-facing staff handle banking services, counter by counter.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={Clock} title="Customer Waiting Time Through the Day" right={<span className="text-caption text-fg-subtle">seconds</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.waitTimeTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <defs><linearGradient id="bankWait" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.28} /><stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} unit="s" />
                    <Tooltip {...TIP} />
                    <Area type="monotone" dataKey="seconds" name="Wait (s)" stroke="#0ea5e9" strokeWidth={2} fill="url(#bankWait)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={ListOrdered} title="Queue Length by Counter" right={<span className="text-caption text-fg-subtle">waiting now</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.queueByCounter} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="counter" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} cursor={{ fill: 'rgba(247,152,58,0.06)' }} />
                    <Bar dataKey="waiting" name="Waiting" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={22} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
          <Panel icon={Armchair} title="Counter Status" count={d.counters.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Counter</th><th className="px-2 pb-2 font-semibold">Assigned teller</th><th className="px-2 pb-2 font-semibold">Waiting</th><th className="px-2 pb-2 font-semibold">Avg. interaction</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.counters.map((c) => (
                    <tr key={c.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{c.counter}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{c.teller}</td>
                      <td className="px-2 py-2.5 tabular-nums text-fg-secondary">{c.waiting}</td>
                      <td className="px-2 py-2.5 font-mono text-small text-fg-secondary">{c.avgInteraction}</td>
                      <td className="px-2 py-2.5 text-right"><Chip status={c.status} label={c.status} /></td>
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
