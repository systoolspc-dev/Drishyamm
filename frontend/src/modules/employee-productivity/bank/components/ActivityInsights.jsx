import { useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Users, Activity } from 'lucide-react';
import EyeToggle from '../../campus/components/EyeToggle';
import { AXIS, GRID, TIP } from '../../campus/components/profileConstants';
import { BANK_DATA } from '../data';

function ChartCard({ icon, title, sub, children }) {
  const Icon = icon;
  const [shown, setShown] = useState(true);
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
        <div className="min-w-0"><p className="truncate text-small font-bold text-fg">{title}</p><p className="truncate text-micro text-fg-subtle">{sub}</p></div>
        <span className="ml-auto"><EyeToggle shown={shown} onToggle={() => setShown((v) => !v)} label={title} size="sm" /></span>
      </div>
      {shown ? <div className="h-56">{children}</div> : <div className="flex h-56 items-center justify-center rounded-lg bg-surface-sunken text-caption text-fg-subtle">Chart hidden</div>}
    </div>
  );
}

export default function ActivityInsights() {
  const d = BANK_DATA;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard icon={Users} title="Customers Served" sub="interactions logged each hour, branch-wide">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={d.customerTrend} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip {...TIP} cursor={{ fill: 'rgba(247,152,58,0.06)' }} />
            <Bar dataKey="customers" name="Customers" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={26} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard icon={Activity} title="Staff Utilization by Department" sub="minutes active vs idle today">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={d.utilizationByDept} margin={{ top: 4, right: 8, left: -22, bottom: 0 }} barGap={4}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="dept" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="active" name="Active" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Bar dataKey="idle" name="Idle" fill="var(--line)" radius={[4, 4, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
