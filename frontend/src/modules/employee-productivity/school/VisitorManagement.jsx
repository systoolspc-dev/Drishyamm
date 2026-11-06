import { useState } from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { UserPlus, LogIn, Clock, BadgeCheck, UserMinus, Timer, IdCard } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import SchoolFilterBar from './components/SchoolFilterBar';
import { StatCards, Chip } from './components/bits';
import { VIS_CARDS, VIS_PURPOSE, VIS_HOURLY, VIS_LOG } from './pages-data';

const ICONS = { oncampus: UserPlus, today: LogIn, pending: Clock, preapproved: BadgeCheck, flagged: UserMinus, duration: Timer };
const DEFAULT_FILTERS = { school: 'greenwood', wing: 'all', grade: 'all', section: 'all', room: 'all', range: 'today' };

export default function VisitorManagement() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const total = VIS_PURPOSE.reduce((s, d) => s + d.value, 0);
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><IdCard className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Visitor Management</h1>
            <p className="mt-1 text-small text-fg-muted">Check-in/out, pre-approval, badges and flagged (unregistered) visitors.</p>
          </div>
        </div>

        <SchoolFilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <StatCards cards={VIS_CARDS} icons={ICONS} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={UserPlus} title="Visitors by Purpose" right={<span className="text-caption text-fg-subtle">today</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={VIS_PURPOSE} dataKey="value" nameKey="purpose" cx="42%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={2} stroke="none">
                      {VIS_PURPOSE.map((d) => <Cell key={d.purpose} fill={d.color} />)}
                    </Pie>
                    <Tooltip {...TIP} formatter={(v, n) => [`${v} (${((v / total) * 100).toFixed(0)}%)`, n]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={LogIn} title="Check-ins by Hour" right={<span className="text-caption text-fg-subtle">today</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={VIS_HOURLY} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} labelFormatter={(h) => `${h}:00`} />
                    <Bar dataKey="n" name="Check-ins" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={26} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <Panel icon={IdCard} title="Visitor Log" count={VIS_LOG.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Visitor</th><th className="px-2 pb-2 font-semibold">Purpose</th><th className="px-2 pb-2 font-semibold">Host</th>
                  <th className="px-2 pb-2 font-semibold">Badge</th><th className="px-2 pb-2 text-right font-semibold">In</th><th className="px-2 pb-2 text-right font-semibold">Out</th><th className="px-2 pb-2 text-right font-semibold">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {VIS_LOG.map((v, i) => (
                    <tr key={i} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{v.name}</td>
                      <td className="px-2 py-2.5 text-fg-secondary">{v.purpose}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{v.host}</td>
                      <td className="px-2 py-2.5 font-mono text-small text-fg-muted">{v.badge}</td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-secondary">{v.checkIn}</td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-muted">{v.checkOut}</td>
                      <td className="px-2 py-2.5 text-right"><Chip status={v.status} label={v.status === 'in' ? 'In' : v.status === 'out' ? 'Out' : 'Flagged'} /></td>
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
