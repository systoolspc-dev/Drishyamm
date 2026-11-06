import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, UserCheck, Coffee, UserX, Activity, Search } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { STAFF_DATA } from './pages-data';
import { StatCards, Chip } from './components/bits';

const ICONS = { onduty: UserCheck, break: Coffee, offline: UserX, active: Activity };

export default function Staff() {
  const roster = STAFF_DATA;
  const [q, setQ] = useState('');

  const onDuty = roster.filter((s) => s.status === 'active').length;
  const onBreak = roster.filter((s) => s.status === 'break').length;
  const offline = roster.filter((s) => s.status === 'offline').length;
  const avgActive = Math.round(roster.reduce((a, s) => a + s.activePct, 0) / roster.length);
  const cards = [
    { key: 'onduty', label: 'On Duty', value: `${onDuty}`, sub: `of ${roster.length} staff` },
    { key: 'break', label: 'On Break', value: `${onBreak}`, sub: 'currently' },
    { key: 'offline', label: 'Offline', value: `${offline}`, sub: 'not clocked in' },
    { key: 'active', label: 'Avg Active', value: `${avgActive}%`, sub: 'of shift' },
  ];
  const rows = roster.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()) || s.role.toLowerCase().includes(q.toLowerCase()) || s.dept.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><Users className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Staff Roster</h1><p className="mt-1 text-small text-fg-muted">On-duty status, active time and compliance per staff member.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel
            icon={Users} title="Staff" count={roster.length}
            right={<label className="relative inline-flex items-center"><Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search staff…" className="w-44 rounded-lg border border-line bg-surface py-1.5 pl-8 pr-2 text-small text-fg-secondary focus:border-brand focus:outline-none" /></label>}
            bodyClass="p-4"
          >
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Staff</th><th className="px-2 pb-2 font-semibold">Dept</th><th className="px-2 pb-2 font-semibold">Shift</th><th className="px-2 pb-2 text-right font-semibold">Clock-in</th><th className="px-2 pb-2 font-semibold">Active</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {rows.map((s) => (
                    <tr key={s.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5"><Link to={`/activity-monitoring/hospitality/staff/${s.id}`} className="font-semibold text-fg hover:text-brand-ink">{s.name}</Link><p className="text-micro text-fg-subtle">{s.role} · {s.employeeId}</p></td>
                      <td className="px-2 py-2.5 text-fg-muted">{s.dept}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{s.scheduledShift}</td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-secondary">{s.actualClockIn}</td>
                      <td className="px-2 py-2.5"><div className="flex items-center gap-2"><div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${s.activePct}%` }} /></div><span className="tabular-nums text-caption text-fg-secondary">{s.activePct}%</span></div></td>
                      <td className="px-2 py-2.5 text-right"><Chip status={s.status} label={s.status} /></td>
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
