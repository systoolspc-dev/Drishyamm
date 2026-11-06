import { useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import {
  LayoutDashboard, CalendarClock, Clock3, DoorOpen, Building2, Users, ClipboardCheck,
  BellRing, FileSpreadsheet, ArrowRight,
} from 'lucide-react';
import Panel from '../Panel';
import { AXIS, GRID, TIP } from '../profileConstants';
import { Tile, BarRow, AlertCards } from '../profileBits';
import { PROFILE, LECTURE_STATUS } from '../../faculty-data';
import ExportButtons from '../reports/ExportButtons';
import { exportReportDocument } from '../../../report-document';

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'lectures', label: 'Lecture Timeline', icon: CalendarClock },
  { id: 'teaching', label: 'Teaching Hours', icon: Clock3 },
  { id: 'office', label: 'Office Hours', icon: DoorOpen },
  { id: 'rooms', label: 'Room Utilization', icon: Building2 },
  { id: 'interaction', label: 'Student Interaction', icon: Users },
  { id: 'attendance', label: 'Attendance', icon: ClipboardCheck },
  { id: 'alerts', label: 'Alerts', icon: BellRing },
  { id: 'reports', label: 'Reports', icon: FileSpreadsheet },
];

const SLOT_STATUS = {
  booked: 'bg-success-soft text-success-ink ring-success-line',
  free: 'bg-surface-muted text-fg-muted ring-line',
  held: 'bg-brand/10 text-brand-ink ring-brand/25',
};

// ── charts ───────────────────────────────────────────────────────────────────
function TeachingChart({ height = 176 }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={PROFILE.teaching.weekly} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="d" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} unit="h" />
          <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
          <Bar dataKey="hours" name="Teaching h" fill="#F7983A" radius={[4, 4, 0, 0]} maxBarSize={26} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function AttendanceChart({ height = 176 }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={PROFILE.attendance.weekly} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
          <defs>
            <linearGradient id="facAtt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} />
              <stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="w" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[80, 100]} unit="%" />
          <Tooltip {...TIP} />
          <Area type="monotone" dataKey="pct" name="Attendance" stroke="#F7983A" strokeWidth={2} fill="url(#facAtt)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── shared renderers ─────────────────────────────────────────────────────────
function LectureList({ items }) {
  return (
    <ul className="space-y-2">
      {items.map((l, i) => {
        const st = LECTURE_STATUS[l.status] || LECTURE_STATUS.upcoming;
        return (
          <li key={i} className="flex items-start gap-3 rounded-lg border border-line p-2.5">
            <span className="w-24 shrink-0 font-mono text-micro leading-5 text-fg-muted">{l.time}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-small font-semibold text-fg">{l.subject}</span>
                <span className={`shrink-0 rounded-full px-1.5 py-px text-micro font-bold uppercase tracking-wide ring-1 ${st.chip}`}>{st.label}</span>
              </span>
              <span className="mt-0.5 block truncate text-micro text-fg-subtle">{l.batch} · {l.room} · {l.students} students</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RoomList() {
  return (
    <div className="space-y-2.5">
      {PROFILE.rooms.map((r) => (
        <BarRow key={r.room} label={`${r.room} · ${r.hours}h`} value={r.utilizationPct} tone={r.utilizationPct < 40 ? '#f59e0b' : '#F7983A'} />
      ))}
    </div>
  );
}

// ── tab panels ───────────────────────────────────────────────────────────────
function Overview() {
  const t = PROFILE.teaching;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel icon={Clock3} title="Teaching Hours" right={<span className="text-caption font-semibold text-fg-muted">{t.weekHours}h / {t.targetWeek}h</span>} bodyClass="p-4"><TeachingChart /></Panel>
      <Panel icon={CalendarClock} title="Today's Lectures" count={PROFILE.lectures.length} bodyClass="p-3"><LectureList items={PROFILE.lectures.slice(0, 4)} /></Panel>
      <Panel icon={Building2} title="Room Utilization" bodyClass="p-4"><RoomList /></Panel>
      <Panel icon={BellRing} title="Open Alerts" count={PROFILE.alerts.length} bodyClass="p-4"><AlertCards items={PROFILE.alerts} emptyText="No active alerts for this faculty." /></Panel>
    </div>
  );
}

function Lectures() {
  return (
    <Panel icon={CalendarClock} title="Lecture Timeline" right={<span className="text-caption text-fg-subtle">today</span>} count={PROFILE.lectures.length} bodyClass="p-3">
      <LectureList items={PROFILE.lectures} />
    </Panel>
  );
}

function Teaching() {
  const t = PROFILE.teaching;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 sm:max-w-md">
        <Tile label="Today" value={t.todayHours} unit="h" />
        <Tile label="This week" value={t.weekHours} unit="h" sub={`target ${t.targetWeek}h`} />
        <Tile label="Attainment" value={Math.round((t.weekHours / t.targetWeek) * 100)} unit="%" sub="of weekly target" />
      </div>
      <Panel icon={Clock3} title="Teaching Hours by Day" right={<span className="text-caption text-fg-subtle">this week</span>} bodyClass="p-4">
        <TeachingChart height={220} />
      </Panel>
    </div>
  );
}

function Office() {
  const o = PROFILE.office;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
        <Tile label="Students met" value={o.studentsMetWeek} sub="this week" />
        <Tile label="Office hours" value={o.hoursWeek} unit="h" sub="this week" />
      </div>
      <Panel icon={DoorOpen} title="Office Hour Schedule" bodyClass="p-3">
        <ul className="space-y-1.5">
          {o.slots.map((s) => (
            <li key={s.slot} className="flex items-center gap-2.5 rounded-lg border border-line p-2.5">
              <DoorOpen className="h-4 w-4 shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">{s.slot}</span>
              <span className="shrink-0 text-micro text-fg-subtle">{s.note}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${SLOT_STATUS[s.status]}`}>{s.status}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function Rooms() {
  return (
    <Panel icon={Building2} title="Room Utilization" right={<span className="text-caption text-fg-subtle">this week</span>} bodyClass="p-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
              <th className="px-2 pb-2 font-semibold">Room</th>
              <th className="px-2 pb-2 text-right font-semibold">Hours</th>
              <th className="px-2 pb-2 font-semibold">Utilization</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {PROFILE.rooms.map((r) => (
              <tr key={r.room} className="hover:bg-surface-sunken">
                <td className="px-2 py-2 text-heading font-semibold text-fg">{r.room}</td>
                <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{r.hours}h</td>
                <td className="px-2 py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-muted">
                      <div className="h-full rounded-full" style={{ width: `${r.utilizationPct}%`, background: r.utilizationPct < 40 ? '#f59e0b' : '#F7983A' }} />
                    </div>
                    <span className="tabular-nums text-caption font-semibold text-fg-secondary">{r.utilizationPct}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Interaction() {
  const it = PROFILE.interaction;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Students taught" value={it.studentsTaught} sub="this term" />
        <Tile label="Queries handled" value={it.queriesHandled} sub="this week" />
        <Tile label="Mentees" value={it.mentees} sub="active" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel icon={Users} title="Interactions" right={<span className="text-caption text-fg-subtle">this week</span>} bodyClass="p-4">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={it.weekly} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="d" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="interactions" name="Interactions" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel icon={Users} title="Top Batches" bodyClass="p-4">
          <div className="space-y-2.5">
            {it.topBatches.map((b) => (
              <BarRow key={b.batch} label={b.batch} value={b.students} suffix="" max={Math.max(...it.topBatches.map((x) => x.students))} />
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Attendance() {
  const a = PROFILE.attendance;
  const avg = Math.round(a.weekly.reduce((s, x) => s + x.pct, 0) / a.weekly.length);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 sm:max-w-md">
        <Tile label="Term average" value={avg} unit="%" />
        <Tile label="Punctuality" value={a.punctuality} unit="%" />
        <Tile label="Leaves taken" value={a.leavesTaken} sub="this term" />
      </div>
      <Panel icon={ClipboardCheck} title="Weekly Attendance" bodyClass="p-4"><AttendanceChart height={220} /></Panel>
    </div>
  );
}

function Alerts() {
  return (
    <Panel icon={BellRing} title="Alerts" count={PROFILE.alerts.length} bodyClass="p-4">
      <AlertCards items={PROFILE.alerts} emptyText="No active alerts for this faculty." />
    </Panel>
  );
}

function Reports({ faculty }) {
  const latest = PROFILE.reports[0];
  const exportReport = (format) => exportReportDocument({
    title: `Faculty Activity Report - ${faculty.name}`,
    code: `FAC-${faculty.id}`,
    subtitle: 'Drishyam Activity Monitoring  -  Campus faculty report',
    details: [
      ['Organisation', 'Sharda University'],
      ['Faculty', `${faculty.name} (${faculty.id})`],
      ['Department', faculty.deptLabel],
      ['Designation', faculty.designationLabel],
    ],
    kpis: [
      { label: 'Teaching hours', value: `${latest.teachingHours}h`, note: latest.period },
      { label: 'Room utilization', value: `${latest.utilization}%`, note: latest.period },
      { label: 'Attendance', value: `${latest.attendance}%`, note: latest.period },
    ],
    tables: [{
      title: 'Report history',
      columns: ['Period', 'Teaching hours', 'Utilization %', 'Attendance %', 'Generated'],
      rows: PROFILE.reports.map((r) => [r.period, r.teachingHours, `${r.utilization}%`, `${r.attendance}%`, r.generated]),
    }],
    rowNoun: 'periods',
    filename: `faculty-report-${faculty.id}`,
  }, format);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Teaching hours" value={latest.teachingHours} unit="h" sub={latest.period} />
        <Tile label="Room utilization" value={latest.utilization} unit="%" sub={latest.period} />
        <Tile label="Attendance" value={latest.attendance} unit="%" sub={latest.period} />
      </div>
      <Panel
        icon={FileSpreadsheet} title="Report History"
        right={
          <ExportButtons size="sm" onExport={exportReport} />
        }
        bodyClass="p-4"
      >
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                <th className="px-2 pb-2 font-semibold">Period</th>
                <th className="px-2 pb-2 text-right font-semibold">Teaching</th>
                <th className="px-2 pb-2 text-right font-semibold">Utilization</th>
                <th className="px-2 pb-2 text-right font-semibold">Attendance</th>
                <th className="px-2 pb-2 text-right font-semibold">Generated</th>
                <th className="px-2 pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {PROFILE.reports.map((r) => (
                <tr key={r.period} className="hover:bg-surface-sunken">
                  <td className="px-2 py-2 text-heading font-semibold text-fg">{r.period}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{r.teachingHours}h</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{r.utilization}%</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{r.attendance}%</td>
                  <td className="px-2 py-2 text-right text-fg-subtle">{r.generated}</td>
                  <td className="px-2 py-2 text-right"><ArrowRight className="ml-auto h-3.5 w-3.5 text-fg-disabled" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export default function FacultyTabs({ faculty }) {
  const [tab, setTab] = useState('overview');
  return (
    <div className="mt-4">
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-small font-semibold transition ${
                active ? 'bg-brand/10 text-brand-ink ring-1 ring-brand/25' : 'text-fg-muted hover:bg-surface-sunken hover:text-fg-secondary'
              }`}
            >
              <Icon className="h-4 w-4" strokeWidth={2} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && <Overview />}
      {tab === 'lectures' && <Lectures />}
      {tab === 'teaching' && <Teaching />}
      {tab === 'office' && <Office />}
      {tab === 'rooms' && <Rooms />}
      {tab === 'interaction' && <Interaction />}
      {tab === 'attendance' && <Attendance />}
      {tab === 'alerts' && <Alerts />}
      {tab === 'reports' && <Reports faculty={faculty} />}
    </div>
  );
}
