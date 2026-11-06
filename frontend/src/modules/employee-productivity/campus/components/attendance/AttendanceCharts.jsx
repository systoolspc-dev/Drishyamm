import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import { TrendingUp, AlarmClock, Building2, GraduationCap } from 'lucide-react';
import Panel from '../Panel';
import { AXIS, GRID, TIP } from '../profileConstants';
import { ATTENDANCE_TREND, LATE_ANALYSIS, DEPARTMENT_COMPARISON, SEMESTER_COMPARISON } from '../../attendance-data';

// Colour a bar by whether it clears the 85% attendance target.
const barColor = (pct) => (pct >= 85 ? '#F7983A' : '#f59e0b');

export default function AttendanceCharts() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Attendance Trend */}
        <Panel icon={TrendingUp} title="Attendance Trend" right={<span className="text-caption text-fg-subtle">this week</span>} bodyClass="p-4">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={ATTENDANCE_TREND} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="attTrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} />
                    <stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="d" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[70, 100]} unit="%" />
                <Tooltip {...TIP} />
                <Area type="monotone" dataKey="pct" name="Attendance" stroke="#F7983A" strokeWidth={2} fill="url(#attTrend)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* Late Analysis */}
        <Panel icon={AlarmClock} title="Late Analysis" right={<span className="text-caption text-fg-subtle">by lateness</span>} bodyClass="p-4">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={LATE_ANALYSIS} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="range" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="count" name="Students" fill="#f59e0b" radius={[4, 4, 0, 0]} maxBarSize={44} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Department (School) Comparison — horizontal bars for long labels */}
        <Panel icon={Building2} title="Department Comparison" right={<span className="text-caption text-fg-subtle">attendance % by school</span>} bodyClass="p-4">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DEPARTMENT_COMPARISON} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tick={AXIS} axisLine={false} tickLine={false} unit="%" />
                <YAxis type="category" dataKey="dept" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={128} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="pct" name="Attendance %" radius={[0, 4, 4, 0]} maxBarSize={16}>
                  {DEPARTMENT_COMPARISON.map((d) => <Cell key={d.dept} fill={barColor(d.pct)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* Semester Comparison */}
        <Panel icon={GraduationCap} title="Semester Comparison" right={<span className="text-caption text-fg-subtle">attendance % by semester</span>} bodyClass="p-4">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={SEMESTER_COMPARISON} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="sem" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="pct" name="Attendance %" radius={[4, 4, 0, 0]} maxBarSize={30}>
                  {SEMESTER_COMPARISON.map((d) => <Cell key={d.sem} fill={barColor(d.pct)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
    </div>
  );
}
