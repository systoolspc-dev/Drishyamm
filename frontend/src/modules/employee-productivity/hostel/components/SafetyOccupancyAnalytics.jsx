import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { ArrowLeftRight, Building2, Sparkles } from 'lucide-react';
import Panel from '../../campus/components/Panel';
import { AXIS, GRID, TIP } from '../../campus/components/profileConstants';
import { HOSTEL_DATA } from '../data';
import { MOVEMENT_DATA } from '../pages-data';
import { useHostelStore } from '../useHostelStore';
import { Chip } from './bits';

export default function SafetyOccupancyAnalytics() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = HOSTEL_DATA[hostel];
  const zc = MOVEMENT_DATA[hostel].zoneCompliance;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Panel icon={ArrowLeftRight} title="Hourly Entry / Exit" bodyClass="p-4">
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={d.entryExitTrend} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
              <Bar dataKey="entries" name="Entries" fill="#F7983A" radius={[3, 3, 0, 0]} maxBarSize={14} />
              <Bar dataKey="exits" name="Exits" fill="#0ea5e9" radius={[3, 3, 0, 0]} maxBarSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel icon={Building2} title="Zone Compliance" right={<span className="text-caption text-fg-subtle">%</span>} bodyClass="p-4">
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={zc} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
              <CartesianGrid stroke="var(--line)" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={AXIS} axisLine={false} tickLine={false} unit="%" />
              <YAxis type="category" dataKey="zone" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={110} />
              <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
              <Bar dataKey="compliance" name="Compliance %" radius={[0, 4, 4, 0]} maxBarSize={14}>
                {zc.map((z) => <Cell key={z.zone} fill={z.compliance < 90 ? '#f59e0b' : '#F7983A'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel icon={Sparkles} title="Housekeeping Status" count={d.cleaningStatus.length} bodyClass="p-4">
        <ul className="space-y-1.5">
          {d.cleaningStatus.map((c, i) => (
            <li key={i} className="flex items-center gap-2 rounded-lg border border-line p-2">
              <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg-secondary">{c.zone}</span>
              <span className="shrink-0 text-micro text-fg-subtle">{c.updated}</span>
              <Chip status={c.status} label={c.status} />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
