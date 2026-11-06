import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import { Brain, MessagesSquare, BookOpen, Building2 } from 'lucide-react';
import Panel from '../Panel';
import { AXIS, GRID, TIP } from '../profileConstants';
import { FOCUS, DISCUSSION, LIBRARY_USAGE, DEPARTMENT_PRODUCTIVITY } from '../../productivity-data';

const barColor = (pct) => (pct >= 75 ? '#F7983A' : '#f59e0b');

export default function ProductivityCharts() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Focus */}
        <Panel icon={Brain} title="Focus" right={<span className="text-caption text-fg-subtle">attention index · today</span>} bodyClass="p-4">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={FOCUS} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="prodFocus" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} />
                    <stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                <Tooltip {...TIP} />
                <Area type="monotone" dataKey="focus" name="Focus" stroke="#F7983A" strokeWidth={2} fill="url(#prodFocus)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* Discussion */}
        <Panel icon={MessagesSquare} title="Discussion" right={<span className="text-caption text-fg-subtle">sessions per hour</span>} bodyClass="p-4">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DISCUSSION} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="sessions" name="Discussions" fill="#8b5cf6" radius={[4, 4, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Library Usage */}
        <Panel icon={BookOpen} title="Library Usage" right={<span className="text-caption text-fg-subtle">visits per day</span>} bodyClass="p-4">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={LIBRARY_USAGE} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="d" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="visits" name="Visits" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={30} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        {/* Department Productivity — horizontal bars for long school labels */}
        <Panel icon={Building2} title="Department Productivity" right={<span className="text-caption text-fg-subtle">by school</span>} bodyClass="p-4">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={DEPARTMENT_PRODUCTIVITY} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} tick={AXIS} axisLine={false} tickLine={false} unit="%" />
                <YAxis type="category" dataKey="dept" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={128} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="pct" name="Productivity %" radius={[0, 4, 4, 0]} maxBarSize={16}>
                  {DEPARTMENT_PRODUCTIVITY.map((d) => <Cell key={d.dept} fill={barColor(d.pct)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
    </div>
  );
}
