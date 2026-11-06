import { useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { ArrowLeftRight, PieChart as PieIcon } from 'lucide-react';
import EyeToggle from '../../campus/components/EyeToggle';
import { AXIS, GRID, TIP } from '../../campus/components/profileConstants';
import { HOSTEL_DATA } from '../data';
import { useHostelStore } from '../useHostelStore';

const OCC_COLORS = ['#F7983A', '#0ea5e9', '#10b981'];

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
  const hostel = useHostelStore((s) => s.hostel);
  const d = HOSTEL_DATA[hostel];
  const present = d.studentsPresent.value;
  const out = Math.max(0, d.studentsPresent.of - present);
  const occ = [
    { label: 'Present', value: present }, { label: 'Out', value: out }, { label: 'Visitors', value: d.visitorCount.value },
  ];
  const total = occ.reduce((s, x) => s + x.value, 0);
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard icon={ArrowLeftRight} title="Entry / Exit Trend" sub="entries vs exits through the day">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={d.entryExitTrend} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
            <defs>
              <linearGradient id="hEnt" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} /><stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} /></linearGradient>
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip {...TIP} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="entries" name="Entries" stroke="#F7983A" strokeWidth={2} fill="url(#hEnt)" />
            <Area type="monotone" dataKey="exits" name="Exits" stroke="#0ea5e9" strokeWidth={1.5} fill="#0ea5e922" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard icon={PieIcon} title="Current Occupancy" sub="present · out · visitors">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={occ} dataKey="value" nameKey="label" cx="42%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={2} stroke="none">
              {occ.map((o, i) => <Cell key={o.label} fill={OCC_COLORS[i % OCC_COLORS.length]} />)}
            </Pie>
            <Tooltip {...TIP} formatter={(v, n) => [`${v} (${((v / total) * 100).toFixed(1)}%)`, n]} />
            <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={8} formatter={(v) => <span className="text-caption text-fg-secondary">{v}</span>} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
