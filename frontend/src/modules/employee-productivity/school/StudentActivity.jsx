import { useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import {
  GraduationCap, Search, ScanFace, ClipboardCheck, Activity, MapPin, Gauge, Clock,
  LayoutDashboard, Route, CalendarClock, BellRing,
} from 'lucide-react';
import Panel from '../campus/components/Panel';
import { AXIS, GRID, TIP } from '../campus/components/profileConstants';
import { Tile, TimelineList, AlertCards } from '../campus/components/profileBits';
import { STUDENTS, STUDENT_PROFILE, STUDENT_STATUS } from './pages-data';

const P = STUDENT_PROFILE;
const initials = (n) => (n.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();

function AttendanceChart({ height = 176 }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={P.attendanceWeekly} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
          <defs><linearGradient id="stuSchAtt" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} /><stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} /></linearGradient></defs>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="w" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[80, 100]} unit="%" />
          <Tooltip {...TIP} />
          <Area type="monotone" dataKey="pct" name="Attendance" stroke="#F7983A" strokeWidth={2} fill="url(#stuSchAtt)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function MovementList() {
  return (
    <ol className="space-y-2">
      {P.movementToday.map((m, i) => (
        <li key={i} className="flex items-start gap-2.5 rounded-lg p-1.5 hover:bg-surface-sunken">
          <span className="w-12 shrink-0 text-right font-mono text-micro leading-5 text-fg-subtle">{m.time}</span>
          <MapPin className="mt-1 h-3.5 w-3.5 shrink-0 text-brand" />
          <span className="min-w-0 flex-1"><span className="block truncate text-small font-semibold text-fg">{m.room}</span><span className="block truncate text-micro text-fg-subtle">{m.activity}</span></span>
          <span className="shrink-0 rounded-md bg-surface-muted px-1.5 py-0.5 text-micro font-semibold text-fg-muted">{m.dwell}</span>
        </li>
      ))}
    </ol>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'attendance', label: 'Attendance', icon: ClipboardCheck },
  { id: 'movement', label: 'Movement', icon: Route },
  { id: 'timeline', label: 'Timeline', icon: CalendarClock },
  { id: 'alerts', label: 'Alerts', icon: BellRing },
];

export default function StudentActivity() {
  const [selectedId, setSelectedId] = useState(STUDENTS[0].id);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('overview');
  const [face, setFace] = useState(false);

  const s = STUDENTS.find((x) => x.id === selectedId) || STUDENTS[0];
  const st = STUDENT_STATUS[s.status] || STUDENT_STATUS.absent;
  const results = STUDENTS.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()) || x.id.toLowerCase().includes(q.toLowerCase()));

  const cards = [
    { icon: ClipboardCheck, label: 'Attendance', value: `${s.attendance}%`, sub: 'this term' },
    { icon: Activity, label: 'Current Activity', value: s.activity, sub: s.room, small: true },
    { icon: MapPin, label: 'Location', value: s.room, sub: st.label, small: true },
    { icon: Gauge, label: 'Punctuality', value: `${s.punctuality}%`, sub: 'on-time rate' },
    { icon: Clock, label: 'Last Seen', value: s.lastSeen, sub: s.lastRoom, small: true },
  ];

  return (
    <div className="min-h-[calc(var(--app-vh)-4rem)] bg-surface-sunken/60">
      <div className="w-full page-inset">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand"><GraduationCap className="h-5 w-5" strokeWidth={2} /></span>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Student Activity</h1>
            <p className="mt-1 text-small text-fg-muted">Complete AI activity profile for a single student.</p>
          </div>
        </div>

        {/* Search */}
        <div className="mb-4 rounded-2xl border border-line bg-surface p-2.5 shadow-sm">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <label className="relative flex items-center">
                <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
                <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Search by name or Student ID…"
                  className="w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-3 text-small text-fg-secondary placeholder:text-fg-subtle focus:border-brand focus:outline-none" />
              </label>
              {open && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
                  <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl">
                    {results.map((x) => (
                      <button key={x.id} onClick={() => { setSelectedId(x.id); setOpen(false); setQ(''); }}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-surface-sunken ${selectedId === x.id ? 'bg-brand/[0.06]' : ''}`}>
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/15 text-micro font-bold text-brand-ink">{initials(x.name)}</span>
                        <span className="min-w-0 flex-1"><span className="block truncate text-small font-semibold text-fg">{x.name}</span><span className="block truncate text-micro text-fg-subtle">{x.id} · {x.grade}-{x.section}</span></span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button onClick={() => setFace((v) => !v)} className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-small font-semibold transition ${face ? 'border-brand/40 bg-brand/10 text-brand-ink' : 'border-line bg-surface text-fg-secondary hover:border-brand/40 hover:text-brand-ink'}`}>
              <ScanFace className="h-4 w-4" /> Face Search
            </button>
          </div>
          {face && <p className="mt-2 rounded-xl border border-dashed border-brand/40 bg-brand/[0.04] p-2.5 text-caption text-fg-secondary">Match a student from a photo or a live camera frame. (Connects to the face-recognition service.)</p>}
        </div>

        {/* Identity */}
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-heading font-bold text-brand-ink">{initials(s.name)}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-fg sm:text-base">{s.name}</h2>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${st.chip}`}><span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} /> {st.label}</span>
            </div>
            <p className="truncate text-small text-fg-muted">{s.id} · {s.grade} · Section {s.section}</p>
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {cards.map((c) => (
            <div key={c.label} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand"><c.icon className="h-4 w-4" strokeWidth={2} /></span>
              <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
              <p className={`mt-1 font-bold tracking-tight text-fg ${c.small ? 'text-body leading-tight' : 'text-metric-sm leading-none'}`} title={c.value}><span className={c.small ? 'line-clamp-1' : ''}>{c.value}</span></p>
              <p className="mt-1.5 truncate text-micro text-fg-subtle">{c.sub}</p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="mt-4">
          <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-small font-semibold transition ${active ? 'bg-brand/10 text-brand-ink ring-1 ring-brand/25' : 'text-fg-muted hover:bg-surface-sunken hover:text-fg-secondary'}`}>
                  <t.icon className="h-4 w-4" strokeWidth={2} /> {t.label}
                </button>
              );
            })}
          </div>

          {tab === 'overview' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Panel icon={ClipboardCheck} title="Attendance Trend" bodyClass="p-4"><AttendanceChart /></Panel>
              <Panel icon={CalendarClock} title="Today's Timeline" bodyClass="p-4"><TimelineList items={P.timeline} /></Panel>
              <Panel icon={Route} title="Today's Movement" bodyClass="p-4"><MovementList /></Panel>
              <Panel icon={BellRing} title="Alerts" count={P.alerts.length} bodyClass="p-4"><AlertCards items={P.alerts} emptyText="No alerts for this student." /></Panel>
            </div>
          )}
          {tab === 'attendance' && <Panel icon={ClipboardCheck} title="Attendance" bodyClass="p-4"><AttendanceChart height={240} /></Panel>}
          {tab === 'movement' && <Panel icon={Route} title="Today's Movement" bodyClass="p-4"><MovementList /></Panel>}
          {tab === 'timeline' && <Panel icon={CalendarClock} title="Activity Timeline" bodyClass="p-4"><TimelineList items={P.timeline} /></Panel>}
          {tab === 'alerts' && <Panel icon={BellRing} title="Alerts" count={P.alerts.length} bodyClass="p-4"><AlertCards items={P.alerts} emptyText="No alerts for this student." /></Panel>}
        </div>
      </div>
    </div>
  );
}
