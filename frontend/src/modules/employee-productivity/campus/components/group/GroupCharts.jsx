import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { Clock3, Ruler, TrendingUp } from 'lucide-react';
import Panel from '../Panel';
import { AXIS, GRID, TIP } from '../profileConstants';
import { GROUP_DURATION, GROUP_SIZE, FORMATION_TIMELINE } from '../../group-data';

// Group Duration + Group Size (distributions) and the Formation Timeline.
export default function GroupCharts() {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel icon={Clock3} title="Group Duration" right={<span className="text-caption text-fg-subtle">how long groups last</span>} bodyClass="p-4">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={GROUP_DURATION} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="range" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="count" name="Groups" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel icon={Ruler} title="Group Size" right={<span className="text-caption text-fg-subtle">people per group</span>} bodyClass="p-4">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={GROUP_SIZE} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="size" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="count" name="Groups" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <Panel icon={TrendingUp} title="Formation Timeline" right={<span className="text-caption text-fg-subtle">groups forming through the day</span>} bodyClass="p-4">
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={FORMATION_TIMELINE} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
              <defs>
                <linearGradient id="grpForm" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} />
                  <stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRID} />
              <XAxis dataKey="h" tick={AXIS} axisLine={false} tickLine={false} />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} />
              <Area type="monotone" dataKey="groups" name="Groups formed" stroke="#F7983A" strokeWidth={2} fill="url(#grpForm)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </>
  );
}
