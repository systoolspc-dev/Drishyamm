import { useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Bus, Navigation, Users, Clock3, AlertTriangle, BellRing } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import SchoolFilterBar from './components/SchoolFilterBar';
import { StatCards, Chip } from './components/bits';
import { TR_CARDS, TR_ARRIVALS, TR_BUSES } from './pages-data';

const ICONS = { onsite: Bus, enroute: Navigation, students: Users, ontime: Clock3, delayed: AlertTriangle, alerts: BellRing };
const DEFAULT_FILTERS = { school: 'greenwood', wing: 'all', grade: 'all', section: 'all', room: 'all', range: 'today' };

export default function Transport() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Bus className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Transport &amp; Bus Monitoring</h1>
            <p className="mt-1 text-small text-fg-muted">Bus arrivals, boarding counts, on-time performance and student-on-bus verification.</p>
          </div>
        </div>

        <SchoolFilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <StatCards cards={TR_CARDS} icons={ICONS} />

          <Panel icon={Bus} title="Bus Arrivals" right={<span className="text-caption text-fg-subtle">this morning</span>} bodyClass="p-4">
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={TR_ARRIVALS} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                  <Bar dataKey="arrivals" name="Buses arrived" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={30} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel icon={Navigation} title="Fleet Status" count={TR_BUSES.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Bus</th><th className="px-2 pb-2 font-semibold">Route</th><th className="px-2 pb-2 font-semibold">Driver</th>
                  <th className="px-2 pb-2 text-right font-semibold">ETA</th><th className="px-2 pb-2 font-semibold">Occupancy</th><th className="px-2 pb-2 text-right font-semibold">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {TR_BUSES.map((b) => (
                    <tr key={b.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{b.id}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{b.route}</td>
                      <td className="px-2 py-2.5 text-fg-secondary">{b.driver}</td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-secondary">{b.eta}</td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${(b.onboard / b.capacity) * 100}%` }} /></div>
                          <span className="tabular-nums text-caption text-fg-secondary">{b.onboard}/{b.capacity}</span>
                        </div>
                      </td>
                      <td className="px-2 py-2.5 text-right"><Chip status={b.status} label={b.status.replace('-', ' ')} /></td>
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
