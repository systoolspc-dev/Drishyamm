import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ConciergeBell, Clock, Timer, MessageSquare, Users } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { GUEST_SERVICE_DATA } from './pages-data';
import { StatCards, Chip } from './components/bits';

const ICONS = { response: Clock, waiting: Timer, interaction: MessageSquare, queue: Users };

export default function GuestService() {
  const d = GUEST_SERVICE_DATA;
  const cards = [
    { key: 'response', label: 'Guest Response Time', value: d.stats.responseTime.value, sub: d.stats.responseTime.deltaLabel },
    { key: 'waiting', label: 'Guest Waiting Time', value: d.stats.waitingTime.value, sub: d.stats.waitingTime.deltaLabel },
    { key: 'interaction', label: 'Interaction Duration', value: d.stats.interactionDuration.value, sub: d.stats.interactionDuration.deltaLabel },
    { key: 'queue', label: 'Queue Length', value: d.stats.queueLength.value, sub: `${d.stats.queueLength.deltaLabel} · guests waiting` },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ConciergeBell className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Guest Service</h1><p className="mt-1 text-small text-fg-muted">How efficiently guest-facing staff respond and assist, right now.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={Users} title="Guests Waiting Through the Day" right={<span className="text-caption text-fg-subtle">count</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={d.queueTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <defs><linearGradient id="hospQueue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#F7983A" stopOpacity={0.3} /><stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} />
                    <Area type="monotone" dataKey="guests" name="Guests waiting" stroke="#F7983A" strokeWidth={2} fill="url(#hospQueue)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={MessageSquare} title="Time Spent per Guest, by Desk" right={<span className="text-caption text-fg-subtle">minutes</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.interactionByDesk} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke="var(--line)" horizontal={false} />
                    <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} unit="m" />
                    <YAxis type="category" dataKey="desk" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={84} />
                    <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                    <Bar dataKey="actual" name="Minutes / guest" fill="#0ea5e9" radius={[0, 4, 4, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>
          <Panel icon={ConciergeBell} title="Desk Availability" count={d.desks.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Desk</th><th className="px-2 pb-2 font-semibold">Function</th><th className="px-2 pb-2 font-semibold">Waiting</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.desks.map((desk) => (
                    <tr key={desk.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5"><Link to={`/activity-monitoring/hospitality/guest-service/${desk.id}`} className="font-semibold text-fg hover:text-brand-ink">{desk.name}</Link></td>
                      <td className="px-2 py-2.5 text-fg-muted">{desk.role}</td>
                      <td className="px-2 py-2.5 tabular-nums text-fg-secondary">{desk.queue} waiting</td>
                      <td className="px-2 py-2.5 text-right"><Chip status={desk.status} label={desk.status} /></td>
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
