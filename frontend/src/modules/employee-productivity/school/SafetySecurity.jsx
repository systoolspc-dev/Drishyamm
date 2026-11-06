import { useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ShieldAlert, Ban, Baby, ShieldX, UserMinus, CircleCheck, AlertTriangle, ListChecks } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import SchoolFilterBar from './components/SchoolFilterBar';
import { StatCards, Chip } from './components/bits';
import { SAF_CARDS, SAF_BY_TYPE, SAF_HOURLY, SAF_ALERTS, SAF_RESTRICTED_LOG } from './pages-data';

const ICONS = { alerts: ShieldAlert, restricted: Ban, unattended: Baby, perimeter: ShieldX, visitorsFlagged: UserMinus, drill: CircleCheck };
const SEV = { high: 'bg-danger', medium: 'bg-warning', low: 'bg-line-strong' };
const DEFAULT_FILTERS = { school: 'greenwood', wing: 'all', grade: 'all', section: 'all', room: 'all', range: 'today' };

export default function SafetySecurity() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ShieldAlert className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Safety &amp; Security</h1>
            <p className="mt-1 text-small text-fg-muted">Gate &amp; perimeter, restricted zones, unattended-child and drill compliance.</p>
          </div>
        </div>

        <SchoolFilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <StatCards cards={SAF_CARDS} icons={ICONS} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={ShieldAlert} title="Safety Incidents by Type" right={<span className="text-caption text-fg-subtle">today</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={SAF_BY_TYPE} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke="var(--line)" horizontal={false} />
                    <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="type" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={110} />
                    <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                    <Bar dataKey="count" name="Incidents" fill="#F7983A" radius={[0, 4, 4, 0]} maxBarSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={AlertTriangle} title="Incidents by Hour" right={<span className="text-caption text-fg-subtle">today</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={SAF_HOURLY} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} labelFormatter={(h) => `${h}:00`} />
                    <Line type="monotone" dataKey="n" name="Incidents" stroke="#f43f5e" strokeWidth={2} dot={{ r: 2.5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={ShieldAlert} title="Active Safety Alerts" count={SAF_ALERTS.length} bodyClass="p-4">
              <ul className="space-y-2">
                {SAF_ALERTS.map((a, i) => (
                  <li key={i} className="relative overflow-hidden rounded-lg border border-line p-2.5 pl-3.5">
                    <span className={`absolute left-0 top-0 h-full w-1 ${SEV[a.severity]}`} />
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-small font-semibold text-fg">{a.title}</p>
                      <span className="ml-auto"><Chip status={a.status} label={a.status === 'open' ? 'Open' : 'Ack'} /></span>
                    </div>
                    <p className="mt-0.5 truncate text-micro text-fg-muted">{a.zone} · since {a.since}</p>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel icon={ListChecks} title="Restricted-Zone Log" count={SAF_RESTRICTED_LOG.length} bodyClass="p-4">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Time</th><th className="px-2 pb-2 font-semibold">Person</th><th className="px-2 pb-2 font-semibold">Zone</th><th className="px-2 pb-2 font-semibold">Action</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {SAF_RESTRICTED_LOG.map((r, i) => (
                    <tr key={i} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2 font-mono text-small text-fg-secondary">{r.time}</td>
                      <td className="px-2 py-2 text-fg">{r.person}</td>
                      <td className="px-2 py-2 text-fg-muted">{r.zone}</td>
                      <td className="px-2 py-2 text-fg-secondary">{r.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
