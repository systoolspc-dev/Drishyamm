import {
  ResponsiveContainer, BarChart, Bar, Cell, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { BarChart3, Activity } from 'lucide-react';
import { HOURLY_ACTIVITY, ACTIVITY_STATUS } from '../data';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';

const PEAK = Math.max(...HOURLY_ACTIVITY.map((d) => d.activities));

export default function ActivityAnalytics() {
  const statusTotal = ACTIVITY_STATUS.reduce((s, d) => s + d.value, 0);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      {/* Hourly Activity — bars; the peak hour is accented in orange */}
      <div className="rounded-xl border border-line bg-surface p-4 shadow-sm lg:col-span-2">
        <div className="mb-3 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
          <div>
            <p className="text-small font-bold text-fg">Hourly Activity</p>
            <p className="text-micro text-fg-subtle">activities detected per hour · peak at 11:00</p>
          </div>
        </div>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={HOURLY_ACTIVITY} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} labelFormatter={(h) => `${h}:00`} />
              <Bar dataKey="activities" name="Activities" radius={[4, 4, 0, 0]} maxBarSize={30}>
                {HOURLY_ACTIVITY.map((d) => (
                  <Cell key={d.h} fill={d.activities === PEAK ? '#F7983A' : '#e2a86b'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Activity Status — donut with center total */}
      <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
          <div>
            <p className="text-small font-bold text-fg">Activity Status</p>
            <p className="text-micro text-fg-subtle">by lifecycle state</p>
          </div>
        </div>
        <div className="relative h-52">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={ACTIVITY_STATUS} dataKey="value" nameKey="status" cx="50%" cy="50%" innerRadius={52} outerRadius={80} paddingAngle={2} stroke="none">
                {ACTIVITY_STATUS.map((d) => <Cell key={d.status} fill={d.color} />)}
              </Pie>
              <Tooltip {...TIP} formatter={(v, n) => [`${v} (${((v / statusTotal) * 100).toFixed(0)}%)`, n]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-metric-sm font-bold leading-none text-fg">{statusTotal}</span>
            <span className="text-micro font-medium text-fg-subtle">total today</span>
          </div>
        </div>
        <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
          {ACTIVITY_STATUS.map((d) => (
            <li key={d.status} className="flex items-center gap-1.5 text-micro text-fg-secondary">
              <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
              <span className="truncate">{d.status}</span>
              <span className="ml-auto font-bold tabular-nums text-fg">{d.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
