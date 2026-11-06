import { useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Sparkles, Clock } from 'lucide-react';
import EyeToggle from '../../campus/components/EyeToggle';
import { AXIS, GRID, TIP } from '../../campus/components/profileConstants';
import { HOSPITALITY_DATA } from '../data';

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
  const d = HOSPITALITY_DATA;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard icon={Sparkles} title="Rooms Cleaned per Day" sub="rooms finished vs scheduled, this week">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={d.weeklyVolume} margin={{ top: 4, right: 8, left: -22, bottom: 0 }} barGap={4}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="day" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip {...TIP} cursor={{ fill: 'rgba(247,152,58,0.06)' }} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="pending" name="Scheduled" fill="var(--line)" radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Bar dataKey="completed" name="Cleaned" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard icon={Clock} title="Guest Response Time" sub="minutes to reach a guest, hour by hour">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={d.responseTrend} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
            <defs>
              <linearGradient id="hospResp" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.28} /><stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.02} /></linearGradient>
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="time" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} unit="m" />
            <Tooltip {...TIP} />
            <Area type="monotone" dataKey="minutes" name="Response (min)" stroke="#0ea5e9" strokeWidth={2} fill="url(#hospResp)" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
