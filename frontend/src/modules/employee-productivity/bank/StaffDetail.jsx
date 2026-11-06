import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ChevronLeft, Clock, Calendar, ShieldAlert, Gauge } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { STAFF_DATA, generateTrend, generateIncidents } from './pages-data';
import { Chip, LevelChip } from './components/bits';

const initials = (n) => (n.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();

export default function StaffDetail() {
  const { id } = useParams();
  const person = STAFF_DATA.find((p) => p.id === id);

  const trend = useMemo(() => (person ? generateTrend(person.id, person.load || 50) : []), [person]);
  const incidents = useMemo(() => (person ? generateIncidents(person.id) : []), [person]);

  if (!person) {
    return (
      <div className="w-full page-inset-x py-10 text-center">
        <p className="text-body text-fg-muted">Staff member not found.</p>
        <Link to="/activity-monitoring/bank/staff-roster" className="mt-2 inline-block text-small font-semibold text-brand-ink hover:underline">← Back to Staff</Link>
      </div>
    );
  }

  const avgActive = Math.round(trend.reduce((sum, d) => sum + d.activePct, 0) / trend.length);

  const cards = [
    { icon: Clock, label: 'Current Status', value: `${person.load}%`, sub: person.status, chip: true },
    { icon: Calendar, label: 'Shift', value: person.actualClockIn, sub: person.scheduledShift, small: true },
    { icon: ShieldAlert, label: 'Compliance', value: `${person.complianceScore}%`, sub: 'uniform, ID & vault access' },
    { icon: Gauge, label: person.metricLabel, value: `${person.metricValue}`, sub: `team avg ${person.teamAvgMetric}` },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <Link to="/activity-monitoring/bank/staff-roster" className="mb-2 inline-flex items-center gap-1 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink"><ChevronLeft className="h-3.5 w-3.5" /> Back to Staff</Link>
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-heading font-bold text-brand-ink">{initials(person.name)}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h2 className="truncate text-sm font-semibold text-fg sm:text-base">{person.name}</h2><Chip status={person.status} label={person.status} /></div>
            <p className="truncate text-small text-fg-muted">{person.employeeId} · {person.role} · {person.dept}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {cards.map((c) => (
            <div key={c.label} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><c.icon className="h-4 w-4" strokeWidth={2} /></span>
              <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
              <p className={`mt-1 font-bold tracking-tight text-fg ${c.small ? 'text-body leading-tight' : 'text-metric-sm leading-none'}`}>{c.value}</p>
              {c.chip ? <p className="mt-1.5"><Chip status={person.status} label={person.status} /></p> : <p className="mt-1.5 truncate text-micro text-fg-subtle">{c.sub}</p>}
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel icon={Gauge} title="Active % by Day" right={<span className="text-caption text-fg-subtle">avg {avgActive}%</span>} bodyClass="p-4">
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend} margin={{ top: 4, right: 6, left: -26, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                  <Tooltip {...TIP} cursor={{ fill: 'rgba(247,152,58,0.06)' }} />
                  <Bar dataKey="activePct" name="Active %" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
          <Panel icon={ShieldAlert} title="Incident Timeline" count={incidents.length} bodyClass="p-4">
            {incidents.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft/60 px-3 py-2.5 text-caption text-success-ink">No flagged incidents this range.</div>
            ) : (
              <ul className="space-y-2">
                {incidents.map((inc, i) => (
                  <li key={i} className="rounded-lg border border-line p-2.5">
                    <div className="flex items-center gap-1.5"><p className="truncate text-small font-semibold text-fg">{inc.type}</p><span className="ml-auto"><LevelChip level={inc.level} /></span></div>
                    <p className="mt-0.5 truncate text-micro text-fg-muted">{inc.detail} · {inc.timeLabel}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
