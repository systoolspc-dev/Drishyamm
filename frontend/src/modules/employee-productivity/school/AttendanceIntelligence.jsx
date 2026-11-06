import { useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { ClipboardCheck, UserCheck, UserX, AlarmClock, CalendarOff, BellRing, TrendingUp } from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import SchoolFilterBar from './components/SchoolFilterBar';
import { StatCards } from './components/bits';
import { ATT_CARDS, ATT_TREND, ATT_LATE, ATT_SECTIONS, ATT_ABSENTEES } from './pages-data';

const ICONS = { present: UserCheck, absent: UserX, late: AlarmClock, leave: CalendarOff, pct: ClipboardCheck, notified: BellRing };
const DEFAULT_FILTERS = { school: 'greenwood', wing: 'all', grade: 'all', section: 'all', room: 'all', range: 'today' };

export default function AttendanceIntelligence() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><ClipboardCheck className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Attendance Intelligence</h1>
            <p className="mt-1 text-small text-fg-muted">Section-wise attendance, lateness and absentee parent-notifications.</p>
          </div>
        </div>

        <SchoolFilterBar value={filters} onChange={setFilters} />

        <div className="space-y-4">
          <StatCards cards={ATT_CARDS} icons={ICONS} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel icon={TrendingUp} title="Attendance Trend" right={<span className="text-caption text-fg-subtle">this week</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={ATT_TREND} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <defs><linearGradient id="schAtt" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} /><stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="d" tick={AXIS} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[80, 100]} unit="%" />
                    <Tooltip {...TIP} />
                    <Area type="monotone" dataKey="pct" name="Attendance" stroke="#F7983A" strokeWidth={2} fill="url(#schAtt)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Panel>
            <Panel icon={AlarmClock} title="Late Analysis" right={<span className="text-caption text-fg-subtle">by lateness</span>} bodyClass="p-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={ATT_LATE} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
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

          <Panel icon={ClipboardCheck} title="Section-wise Attendance" count={ATT_SECTIONS.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Section</th><th className="px-2 pb-2 font-semibold">Teacher</th>
                  <th className="px-2 pb-2 text-right font-semibold">Present / Total</th><th className="px-2 pb-2 font-semibold">Attendance</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {ATT_SECTIONS.map((s) => (
                    <tr key={s.section} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2 text-heading font-semibold text-fg">{s.section}</td>
                      <td className="px-2 py-2 text-fg-muted">{s.teacher}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{s.present} / {s.total}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-muted"><div className="h-full rounded-full" style={{ width: `${s.pct}%`, background: s.pct < 90 ? '#f59e0b' : '#F7983A' }} /></div>
                          <span className="tabular-nums text-caption font-semibold text-fg-secondary">{s.pct}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel icon={UserX} title="Absentees — Parent Notifications" count={ATT_ABSENTEES.length} bodyClass="p-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead><tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-2 pb-2 font-semibold">Student</th><th className="px-2 pb-2 font-semibold">Grade</th>
                  <th className="px-2 pb-2 font-semibold">Reason</th><th className="px-2 pb-2 text-right font-semibold">Parent Notified</th>
                </tr></thead>
                <tbody className="divide-y divide-line-subtle">
                  {ATT_ABSENTEES.map((a) => (
                    <tr key={a.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2"><p className="font-semibold text-fg">{a.name}</p><p className="text-micro text-fg-subtle">{a.id}</p></td>
                      <td className="px-2 py-2 text-fg-muted">{a.grade}</td>
                      <td className="px-2 py-2 text-fg-secondary">{a.reason}</td>
                      <td className="px-2 py-2 text-right">
                        <span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${a.notified ? 'bg-success-soft text-success-ink ring-success-line' : 'bg-warning-soft text-warning-ink ring-warning-line'}`}>{a.notified ? 'Notified' : 'Pending'}</span>
                      </td>
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
