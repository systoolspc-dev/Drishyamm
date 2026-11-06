import { useState } from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { PieChart as PieIcon, LineChart as LineIcon } from 'lucide-react';
import EyeToggle from '../../campus/components/EyeToggle';
import { ACTIVITY_DISTRIBUTION, ACTIVITY_TREND } from '../data';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';

function ChartCard({ icon, title, sub, children }) {
  const Icon = icon;
  const [shown, setShown] = useState(true);
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
        <div className="min-w-0">
          <p className="truncate text-small font-bold text-fg">{title}</p>
          <p className="truncate text-micro text-fg-subtle">{sub}</p>
        </div>
        <span className="ml-auto"><EyeToggle shown={shown} onToggle={() => setShown((v) => !v)} label={title} size="sm" /></span>
      </div>
      {shown ? <div className="h-56">{children}</div> : (
        <div className="flex h-56 items-center justify-center rounded-lg bg-surface-sunken text-caption text-fg-subtle">Chart hidden</div>
      )}
    </div>
  );
}

export default function ActivityInsights() {
  const total = ACTIVITY_DISTRIBUTION.reduce((s, d) => s + d.value, 0);
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard icon={PieIcon} title="Activity Distribution" sub="share of students by current activity">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={ACTIVITY_DISTRIBUTION} dataKey="value" nameKey="type" cx="42%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={2} stroke="none">
              {ACTIVITY_DISTRIBUTION.map((d) => <Cell key={d.type} fill={d.color} />)}
            </Pie>
            <Tooltip {...TIP} formatter={(v, n) => [`${v} (${((v / total) * 100).toFixed(1)}%)`, n]} />
            <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" iconSize={8}
              formatter={(v) => <span className="text-caption text-fg-secondary">{v}</span>} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard icon={LineIcon} title="Activity Trend" sub="students engaged through the day">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={ACTIVITY_TREND} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="schClasses" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#F7983A" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip {...TIP} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="classes" name="In Class" stackId="1" stroke="#F7983A" strokeWidth={2} fill="url(#schClasses)" />
            <Area type="monotone" dataKey="playground" name="Playground" stackId="1" stroke="#10b981" strokeWidth={1.5} fill="#10b98122" />
            <Area type="monotone" dataKey="labs" name="Labs" stackId="1" stroke="#8b5cf6" strokeWidth={1.5} fill="#8b5cf622" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
