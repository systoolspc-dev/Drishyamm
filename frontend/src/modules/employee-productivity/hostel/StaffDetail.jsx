import { useParams, Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ChevronLeft, Activity, BadgeCheck, CheckSquare, Clock, Route, BellRing, ShieldCheck } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { STAFF_DATA, generateActivityTrend, generateAssignedTasks, generateMovementHistory, generateAlerts } from './pages-data';
import { Chip, LevelChip } from './components/bits';

const initials = (n) => (n.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();

export default function StaffDetail() {
  const { id } = useParams();
  const emp = [...STAFF_DATA.boys, ...STAFF_DATA.girls].find((e) => e.id === id);

  if (!emp) {
    return (
      <div className="w-full page-inset-x py-10 text-center">
        <p className="text-body text-fg-muted">Staff member not found.</p>
        <Link to="/activity-monitoring/hostel/staff" className="mt-2 inline-block text-small font-semibold text-brand-ink hover:underline">← Back to Staff</Link>
      </div>
    );
  }

  const trend = generateActivityTrend(emp);
  const tasks = generateAssignedTasks(emp);
  const movement = generateMovementHistory(emp);
  const alerts = generateAlerts(emp);
  const maxTarget = Math.max(...tasks.map((t) => t.target), 1);

  const cards = [
    { icon: Activity, label: 'Active', value: `${emp.activePct}%`, sub: 'of shift' },
    { icon: BadgeCheck, label: 'Compliance', value: `${emp.complianceScore}`, sub: 'score' },
    { icon: CheckSquare, label: 'Tasks', value: `${emp.tasksCompleted} / ${emp.tasksAssigned}`, sub: 'completed' },
    { icon: Clock, label: 'Clock-in', value: emp.actualClockIn, sub: emp.scheduledShift, small: true },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <Link to="/activity-monitoring/hostel/staff" className="mb-2 inline-flex items-center gap-1 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink"><ChevronLeft className="h-3.5 w-3.5" /> Back to Staff</Link>
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-heading font-bold text-brand-ink">{initials(emp.name)}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold text-fg sm:text-base">{emp.name}</h2><Chip status={emp.status} label={emp.status} /></div>
            <p className="truncate text-small text-fg-muted">{emp.employeeId} · {emp.role} · {emp.dept}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map((c) => (
            <div key={c.label} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><c.icon className="h-4 w-4" strokeWidth={2} /></span>
              <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
              <p className={`mt-1 font-bold tracking-tight text-fg ${c.small ? 'text-body leading-tight' : 'text-metric-sm leading-none'}`}>{c.value}</p>
              <p className="mt-1.5 truncate text-micro text-fg-subtle">{c.sub}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel icon={Activity} title="Activity Trend" right={<span className="text-caption text-fg-subtle">active % · 7 days</span>} bodyClass="p-4">
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
                  <defs><linearGradient id="staffAct" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} /><stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} /></linearGradient></defs>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                  <Tooltip {...TIP} />
                  <Area type="monotone" dataKey="activePct" name="Active %" stroke="#F7983A" strokeWidth={2} fill="url(#staffAct)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel icon={CheckSquare} title="Assigned Tasks" count={tasks.length} bodyClass="p-4">
            <div className="space-y-2.5">
              {tasks.map((t) => (
                <div key={t.task}>
                  <div className="mb-1 flex items-center justify-between text-caption"><span className="font-medium text-fg-secondary">{t.task}</span><span className="font-bold tabular-nums text-fg">{t.completed} / {t.target}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full bg-brand" style={{ width: `${(t.completed / maxTarget) * 100}%` }} /></div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel icon={Route} title="Movement History" count={movement.length} bodyClass="p-4">
            <ol className="space-y-2">
              {movement.map((m, i) => (
                <li key={i} className="flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-surface-sunken"><span className="w-16 shrink-0 text-right font-mono text-micro text-fg-subtle">{m.time}</span><Route className="h-3.5 w-3.5 shrink-0 text-brand" /><span className="text-small font-semibold text-fg">{m.zone}</span></li>
              ))}
            </ol>
          </Panel>
          <Panel icon={BellRing} title="Alerts" count={alerts.length} bodyClass="p-4">
            {alerts.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft/60 px-3 py-2.5 text-caption text-success-ink"><ShieldCheck className="h-4 w-4 shrink-0" /> No alerts for this staff member.</div>
            ) : (
              <ul className="space-y-2">
                {alerts.map((a, i) => (
                  <li key={i} className="rounded-lg border border-line p-2.5"><div className="flex items-center gap-1.5"><p className="truncate text-small font-semibold text-fg">{a.type}</p><span className="ml-auto"><LevelChip level={a.level} /></span></div><p className="mt-0.5 truncate text-micro text-fg-muted">{a.detail}</p></li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
