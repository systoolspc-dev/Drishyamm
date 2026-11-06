import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Wrench, Clock, Timer, Hourglass, ListTodo, Repeat } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { MAINTENANCE_DATA } from './pages-data';
import { useHostelStore } from './useHostelStore';
import { StatCards, Chip } from './components/bits';

const ICONS = { response: Clock, completion: Timer, active: Hourglass, pending: ListTodo, repeat: Repeat };

export default function Maintenance() {
  const hostel = useHostelStore((s) => s.hostel);
  const d = MAINTENANCE_DATA[hostel];
  const cards = [
    { key: 'response', label: 'Complaint Response', value: d.complaintResponseTime.value, sub: d.complaintResponseTime.deltaLabel },
    { key: 'completion', label: 'Repair Completion', value: d.repairCompletionTime.value, sub: d.repairCompletionTime.deltaLabel },
    { key: 'active', label: 'Active Repair', value: d.activeRepairDuration.value, sub: d.activeRepairDuration.deltaLabel },
    { key: 'pending', label: 'Pending Tasks', value: `${d.pendingTasks.value}`, sub: d.pendingTasks.deltaLabel },
    { key: 'repeat', label: 'Repeat Visits', value: `${d.repeatVisits.value}`, sub: d.repeatVisits.deltaLabel },
  ];
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Wrench className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Maintenance Analytics</h1><p className="mt-1 text-small text-fg-muted">Response &amp; completion times, pending tasks and repeat visits.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel icon={Clock} title="Response Trend" right={<span className="text-caption text-fg-subtle">minutes · this week</span>} bodyClass="p-4">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={d.responseTrend} margin={{ top: 4, right: 8, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="day" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} unit="m" />
                  <Tooltip {...TIP} />
                  <Line type="monotone" dataKey="minutes" name="Response (min)" stroke="#F7983A" strokeWidth={2} dot={{ r: 2.5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel icon={Wrench} title="Maintenance Tasks" count={d.tasks.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Task</th><th className="px-2 pb-2 font-semibold">Room</th><th className="px-2 pb-2 font-semibold">Assignee</th><th className="px-2 pb-2 text-right font-semibold">Logged</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {d.tasks.map((t, i) => (
                    <tr key={i} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{t.task}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{t.room}</td>
                      <td className="px-2 py-2.5 text-fg-secondary">{t.assignee}</td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-muted">{t.logged}</td>
                      <td className="px-2 py-2.5 text-right"><Chip status={t.status} label={t.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
