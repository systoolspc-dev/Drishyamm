import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ListChecks, ChevronLeft, CalendarDays, CalendarClock, Clock3, Search, Info, PlayCircle, Users,
} from 'lucide-react';
import KpiBand from '../kpi-card';
import Panel from './components/Panel';
import { ACTIVE_ACTIVITIES } from './data';

// ─────────────────────────────────────────────────────────────────────────────
// Active Activities — full page (drill-down from the dashboard's Active
// Activities panel). Every in-progress / scheduled / completed activity, with
// Date, Time-of-day and Status filters. FRONTEND-ONLY.
//
// The summary band sits under the filter bar on the shared KPI card
// (../kpi-card.jsx), so its counts follow the filters above it.
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_ICONS = {
  activities: ListChecks, ongoing: PlayCircle, scheduled: CalendarClock, people: Users,
};

const STATUS_CHIP = {
  ongoing: 'bg-success-soft text-success-ink ring-success-line',
  scheduled: 'bg-info-soft text-info-ink ring-info-line',
  completed: 'bg-surface-muted text-fg-muted ring-line',
};
const TIMES = [
  { id: 'all', label: 'All day' },
  { id: 'morning', label: 'Morning (before 12:00)' },
  { id: 'afternoon', label: 'Afternoon (12:00–17:00)' },
  { id: 'evening', label: 'Evening (after 17:00)' },
];
const STATUSES = ['all', 'ongoing', 'scheduled', 'completed'];

// classify a HH:MM start into a time-of-day bucket ('—' counts as all-day).
function bucket(started) {
  if (!started || started === '—') return 'all';
  const h = parseInt(started.split(':')[0], 10);
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

export default function ActiveActivities() {
  const [date, setDate] = useState('2026-07-22');
  const [time, setTime] = useState('all');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');

  const selectCls = 'w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-2 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none';

  const rows = ACTIVE_ACTIVITIES.filter((a) => {
    if (a.date !== date) return false;
    if (status !== 'all' && a.status !== status) return false;
    if (time !== 'all' && bucket(a.started) !== 'all' && bucket(a.started) !== time) return false;
    if (q) {
      const hay = `${a.activity} ${a.location} ${a.type}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const ongoing = rows.filter((a) => a.status === 'ongoing').length;
  const scheduled = rows.filter((a) => a.status === 'scheduled').length;
  const people = rows.reduce((s, a) => s + a.people, 0);

  // Ongoing takes the same green as its status chip; the rest stay brand.
  const summary = [
    { key: 'activities', label: 'Activities', value: rows.length },
    { key: 'ongoing', label: 'Ongoing', value: ongoing, tone: 'good' },
    { key: 'scheduled', label: 'Scheduled', value: scheduled },
    { key: 'people', label: 'People engaged', value: people.toLocaleString() },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        {/* Title + back */}
        <Link to="/activity-monitoring" className="mb-2 inline-flex items-center gap-1 text-caption font-semibold text-fg-subtle transition hover:text-brand-ink">
          <ChevronLeft className="h-3.5 w-3.5" /> Back to Dashboard
        </Link>
        <div className="mb-3 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
            <ListChecks className="h-5 w-5" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Active Activities</h1>
            <p className="mt-1 text-small text-fg-muted">Every session in progress right now — the current-state inventory.</p>
          </div>
        </div>

        {/* Difference note */}
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-caption text-fg-muted shadow-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <p>
            <span className="font-semibold text-fg-secondary">This is current state</span> — what is running now (people, status, start time).
            For the time-ordered stream of events as they happen, see the{' '}
            <Link to="/activity-monitoring/live-activity" className="font-semibold text-brand-ink hover:underline">Live Activity Feed</Link>.
          </p>
        </div>

        {/* Filters: Date · Time · Status · Search */}
        <div className="mb-4 rounded-2xl border border-line bg-surface p-2.5 shadow-sm">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label className="relative flex items-center">
              <CalendarDays className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={selectCls} />
            </label>
            <label className="relative flex items-center">
              <Clock3 className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
              <select value={time} onChange={(e) => setTime(e.target.value)} className={selectCls}>
                {TIMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <div className="inline-flex rounded-lg bg-surface-muted p-0.5 text-small font-semibold">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={`flex-1 rounded-md px-2 py-1.5 capitalize transition ${status === s ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg-secondary'}`}
                >
                  {s}
                </button>
              ))}
            </div>
            <label className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search activity, room…" className={`${selectCls} pr-3`} />
            </label>
          </div>
        </div>

        {/* Summary band — under the filter bar, like every KPI band */}
        <KpiBand cards={summary} className="mb-4" icons={SUMMARY_ICONS} />

        {/* Table */}
        <Panel icon={ListChecks} title="Activities" count={rows.length} bodyClass="p-4">
          {rows.length === 0 ? (
            <p className="py-10 text-center text-small text-fg-subtle">No activities match these filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                    <th className="px-2 pb-2 font-semibold">Activity</th>
                    <th className="px-2 pb-2 font-semibold">Type</th>
                    <th className="px-2 pb-2 font-semibold">Location</th>
                    <th className="px-2 pb-2 text-right font-semibold">People</th>
                    <th className="px-2 pb-2 text-right font-semibold">Started</th>
                    <th className="px-2 pb-2 text-right font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-subtle">
                  {rows.map((a) => (
                    <tr key={a.id} className="hover:bg-surface-sunken">
                      <td className="px-2 py-2.5 text-heading font-semibold text-fg">{a.activity}</td>
                      <td className="px-2 py-2.5">
                        <span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-micro font-semibold text-fg-muted">{a.type}</span>
                      </td>
                      <td className="px-2 py-2.5 text-fg-muted">{a.location}</td>
                      <td className="px-2 py-2.5 text-right font-bold tabular-nums text-fg-secondary">{a.people}</td>
                      <td className="px-2 py-2.5 text-right font-mono text-small text-fg-muted">{a.started}</td>
                      <td className="px-2 py-2.5 text-right">
                        <span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[a.status]}`}>{a.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
