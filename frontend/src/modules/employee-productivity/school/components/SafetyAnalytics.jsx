import {
  ResponsiveContainer, BarChart, Bar, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { BarChart3, GraduationCap, DoorOpen } from 'lucide-react';
import { HOURLY_ACTIVITY, ATTENDANCE_BY_GRADE, GATE_FLOW } from '../data';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';

const PEAK = Math.max(...HOURLY_ACTIVITY.map((d) => d.activities));

function Card({ icon, title, sub, children }) {
  const Icon = icon;
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
        <div>
          <p className="text-small font-bold text-fg">{title}</p>
          <p className="text-micro text-fg-subtle">{sub}</p>
        </div>
      </div>
      <div className="h-52">{children}</div>
    </div>
  );
}

export default function SafetyAnalytics() {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <Card icon={BarChart3} title="Hourly Activity" sub="activities detected per hour">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={HOURLY_ACTIVITY} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} labelFormatter={(h) => `${h}:00`} />
            <Bar dataKey="activities" name="Activities" radius={[4, 4, 0, 0]} maxBarSize={26}>
              {HOURLY_ACTIVITY.map((d) => <Cell key={d.h} fill={d.activities === PEAK ? '#F7983A' : '#e2a86b'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card icon={GraduationCap} title="Attendance by Grade" sub="% present · target 90%">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={ATTENDANCE_BY_GRADE} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="grade" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} interval={0} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[70, 100]} unit="%" />
            <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
            <Bar dataKey="pct" name="Attendance %" radius={[3, 3, 0, 0]} maxBarSize={16}>
              {ATTENDANCE_BY_GRADE.map((d) => <Cell key={d.grade} fill={d.pct < 90 ? '#f59e0b' : '#F7983A'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card icon={DoorOpen} title="Gate Entry / Exit" sub="footfall through gates">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={GATE_FLOW} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis dataKey="h" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip {...TIP} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="in" name="Entries" stroke="#10b981" strokeWidth={2} dot={{ r: 2 }} />
            <Line type="monotone" dataKey="out" name="Exits" stroke="#f43f5e" strokeWidth={2} dot={{ r: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}
