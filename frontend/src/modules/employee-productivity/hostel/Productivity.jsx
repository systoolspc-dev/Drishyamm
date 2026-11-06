import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { Gauge, Activity, Hourglass, Coffee, Smartphone, MapPin, CheckSquare } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { PRODUCTIVITY_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { StatCards } from './components/bits';

const ICONS = { active: Activity, idle: Hourglass, break: Coffee, phone: Smartphone, zone: MapPin, tasks: CheckSquare };

export default function Productivity() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = PRODUCTIVITY_DATA[hostel];
  const cards = [
    { key: 'active', label: 'Active Time', value: d.activeTime.value, sub: d.activeTime.deltaLabel },
    { key: 'idle', label: 'Idle Time', value: d.idleTime.value, sub: d.idleTime.deltaLabel },
    { key: 'break', label: 'Break Duration', value: d.breakDuration.value, sub: d.breakDuration.deltaLabel },
    { key: 'phone', label: 'Phone Usage', value: d.phoneUsageDuration.value, sub: d.phoneUsageDuration.deltaLabel },
    { key: 'zone', label: 'Zone Occupancy', value: d.zoneOccupancyTime.value, sub: d.zoneOccupancyTime.deltaLabel },
    { key: 'tasks', label: 'Tasks Completed', value: `${d.taskCompletionCount.value}`, sub: d.taskCompletionCount.deltaLabel },
  ];
  const maxTarget = Math.max(...d.taskCompletion.map((t) => t.target));
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Gauge className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Workforce Productivity</h1><p className="mt-1 text-small text-fg-muted">Active vs idle, breaks, phone usage and task completion.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={Activity} title="Active vs Idle by Department" right={<span className="text-caption text-fg-subtle">minutes</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.activeIdleByDept} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="dept" tick={{ fontSize: 9, fill: 'var(--text-subtle)' }} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                    <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="active" name="Active" stackId="a" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={26} />
                    <Bar dataKey="idle" name="Idle" stackId="a" fill="var(--line)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={CheckSquare} title="Task Completion" count={d.taskCompletion.length} bodyClass="p-4">
              <div className="space-y-2.5">
                {d.taskCompletion.map((t) => (
                  <div key={t.name}>
                    <div className="mb-1 flex items-center justify-between text-caption"><span className="font-medium text-fg-secondary">{t.name} <span className="text-fg-subtle">· {t.role}</span></span><span className="font-bold tabular-nums text-fg">{t.tasksCompleted} / {t.target}</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${(t.tasksCompleted / maxTarget) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
