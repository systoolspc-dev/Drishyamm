import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { UsersRound, UserCheck, Coffee, UserX, Activity, Search } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { STAFF_DATA } from './pages-data';
import { StatCards, Chip } from './components/bits';

const ICONS = { onduty: UserCheck, break: Coffee, offline: UserX, active: Activity };

export default function StaffRoster() {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');

  const onDuty = STAFF_DATA.filter((p) => p.status === 'active').length;
  const onBreak = STAFF_DATA.filter((p) => p.status === 'break').length;
  const offline = STAFF_DATA.filter((p) => p.status === 'offline').length;
  const avgActive = Math.round(STAFF_DATA.reduce((a, p) => a + p.load, 0) / STAFF_DATA.length);
  const cards = [
    { key: 'onduty', label: 'On Duty', value: `${onDuty}`, sub: `of ${STAFF_DATA.length} staff` },
    { key: 'break', label: 'On Break', value: `${onBreak}`, sub: 'currently' },
    { key: 'offline', label: 'Offline', value: `${offline}`, sub: 'not clocked in' },
    { key: 'active', label: 'Avg Load', value: `${avgActive}%`, sub: 'of shift' },
  ];

  const FILTERS = ['all', 'active', 'break', 'offline'];
  const rows = useMemo(() => STAFF_DATA
    .filter((p) => filter === 'all' || p.status === filter)
    .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.role.toLowerCase().includes(q.toLowerCase()) || p.dept.toLowerCase().includes(q.toLowerCase())), [filter, q]);

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><UsersRound className="h-5 w-5" strokeWidth={2} /></span>
          <div><h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Employees on Duty</h1><p className="mt-1 text-small text-fg-muted">Everyone clocked in right now, branch-wide. Click a row for full detail.</p></div>
        </div>
        <div className="space-y-4">
          <StatCards cards={cards} icons={ICONS} />
          <Panel
            icon={UsersRound} title="Staff" count={rows.length}
            right={
              <div className="flex items-center gap-2">
                <div className="hidden sm:inline-flex rounded-lg bg-surface-muted p-0.5 text-caption font-semibold">
                  {FILTERS.map((f) => <button key={f} onClick={() => setFilter(f)} className={`rounded-md px-2 py-1 capitalize transition ${filter === f ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}>{f}</button>)}
                </div>
                <label className="relative inline-flex items-center"><Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search staff…" className="w-40 rounded-lg border border-line bg-surface py-1.5 pl-8 pr-2 text-small text-fg-secondary focus:border-brand focus:outline-none" /></label>
              </div>
            }
            bodyClass="p-4"
          >
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"><th className="px-2 pb-2 font-semibold">Staff member</th><th className="px-2 pb-2 font-semibold">Role</th><th className="px-2 pb-2 font-semibold">Department</th><th className="px-2 pb-2 font-semibold">Current load</th><th className="px-2 pb-2 text-right font-semibold">Status</th></tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {rows.map((p) => (
                    <tr key={p.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5"><Link to={`/activity-monitoring/bank/staff/${p.id}`} className="font-semibold text-fg hover:text-brand-ink">{p.name}</Link><p className="text-micro text-fg-subtle">{p.employeeId}</p></td>
                      <td className="px-2 py-2.5 text-fg-muted">{p.role}</td>
                      <td className="px-2 py-2.5 text-fg-muted">{p.dept}</td>
                      <td className="px-2 py-2.5"><div className="flex items-center gap-2"><div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${p.load}%` }} /></div><span className="tabular-nums text-caption text-fg-secondary">{p.load}%</span></div></td>
                      <td className="px-2 py-2.5 text-right"><Chip status={p.status} label={p.status} /></td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={5} className="px-2 py-6 text-center text-small text-fg-subtle">No staff match this filter.</td></tr>}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
