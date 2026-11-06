import { useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import {
  LayoutDashboard, ClipboardCheck, Route, BookOpen, FlaskConical, Activity,
  Brain, BellRing, FileSpreadsheet, MapPin, ArrowRight, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import Panel from '../Panel';
import { PROFILE, RISK_META } from '../../student-data';
import ExportButtons from '../reports/ExportButtons';
import { exportReportDocument } from '../../../report-document';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'attendance', label: 'Attendance', icon: ClipboardCheck },
  { id: 'movement', label: 'Movement', icon: Route },
  { id: 'library', label: 'Library', icon: BookOpen },
  { id: 'labs', label: 'Labs', icon: FlaskConical },
  { id: 'timeline', label: 'Activity Timeline', icon: Activity },
  { id: 'behavior', label: 'Behavior', icon: Brain },
  { id: 'alerts', label: 'Alerts', icon: BellRing },
  { id: 'reports', label: 'Reports', icon: FileSpreadsheet },
];

const TONE_DOT = { ok: 'bg-success', info: 'bg-info', warn: 'bg-warning', alert: 'bg-danger' };
const SEV_BAR = { high: 'bg-danger', medium: 'bg-warning', low: 'bg-line-strong' };

// ── small shared bits ────────────────────────────────────────────────────────
function Tile({ label, value, unit, sub }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
      <p className="truncate text-caption font-medium text-fg-muted">{label}</p>
      <p className="mt-1 text-section font-bold leading-none tracking-tight text-fg">
        {value}{unit && <span className="ml-0.5 text-caption font-semibold text-fg-subtle">{unit}</span>}
      </p>
      {sub && <p className="mt-1 truncate text-micro text-fg-subtle">{sub}</p>}
    </div>
  );
}

function BarRow({ label, value, suffix = '%', max = 100, tone = '#F7983A' }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-caption">
        <span className="font-medium text-fg-secondary">{label}</span>
        <span className="font-bold tabular-nums text-fg">{value}{suffix}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
        <div className="h-full rounded-full" style={{ width: `${(value / max) * 100}%`, background: tone }} />
      </div>
    </div>
  );
}

function AttendanceChart({ height = 176 }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={PROFILE.attendanceWeekly} margin={{ top: 4, right: 6, left: -22, bottom: 0 }}>
          <defs>
            <linearGradient id="stuAtt" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#F7983A" stopOpacity={0.32} />
              <stop offset="95%" stopColor="#F7983A" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="w" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[60, 100]} unit="%" />
          <Tooltip {...TIP} />
          <Area type="monotone" dataKey="pct" name="Attendance" stroke="#F7983A" strokeWidth={2} fill="url(#stuAtt)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function SubjectTable() {
  return (
    <div className="space-y-2.5">
      {PROFILE.subjects.map((s) => (
        <BarRow key={s.name} label={`${s.name}`} value={s.pct} tone={s.pct < 85 ? '#f59e0b' : '#F7983A'} />
      ))}
    </div>
  );
}

function TimelineList({ items }) {
  return (
    <ol className="relative ml-1 border-l border-line pl-4">
      {items.map((t, i) => (
        <li key={i} className="relative pb-3 last:pb-0">
          <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${TONE_DOT[t.tone] || TONE_DOT.info}`} />
          <p className="text-small font-semibold text-fg">{t.activity}</p>
          <p className="text-micro text-fg-subtle">{t.time} · {t.room}</p>
        </li>
      ))}
    </ol>
  );
}

function AlertCards({ items }) {
  if (!items.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft/60 px-3 py-2 text-caption text-success-ink">
        <CheckCircle2 className="h-4 w-4 shrink-0" /> No active alerts for this student.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((a, i) => (
        <li key={i} className="relative overflow-hidden rounded-lg border border-line p-2.5 pl-3.5">
          <span className={`absolute left-0 top-0 h-full w-1 ${SEV_BAR[a.severity]}`} />
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <p className="truncate text-small font-semibold text-fg">{a.title}</p>
            <span className="ml-auto shrink-0 text-micro text-fg-subtle">{a.since}</span>
          </div>
          <p className="mt-0.5 truncate text-micro text-fg-muted">{a.meta}</p>
        </li>
      ))}
    </ul>
  );
}

// ── tab panels ───────────────────────────────────────────────────────────────
function Overview() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel icon={ClipboardCheck} title="Attendance Trend" bodyClass="p-4"><AttendanceChart /></Panel>
      <Panel icon={Activity} title="Today at a Glance" bodyClass="p-4"><TimelineList items={PROFILE.timeline.slice(0, 5)} /></Panel>
      <Panel icon={Brain} title="Behavior Indices" bodyClass="p-4">
        <div className="space-y-2.5">
          {PROFILE.behavior.indices.slice(0, 3).map((b) => (
            <BarRow key={b.label} label={b.label} value={b.value} suffix="" tone={b.value < 70 ? '#f59e0b' : '#F7983A'} />
          ))}
        </div>
      </Panel>
      <Panel icon={BellRing} title="Open Alerts" count={PROFILE.alerts.length} bodyClass="p-4"><AlertCards items={PROFILE.alerts.slice(0, 3)} /></Panel>
    </div>
  );
}

function Attendance() {
  const overall = Math.round(PROFILE.subjects.reduce((s, x) => s + x.pct, 0) / PROFILE.subjects.length);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel icon={ClipboardCheck} title="Weekly Attendance" right={<span className="text-caption font-semibold text-fg-muted">Term avg {overall}%</span>} bodyClass="p-4">
        <AttendanceChart height={220} />
      </Panel>
      <Panel icon={ClipboardCheck} title="Subject-wise Attendance" bodyClass="p-4"><SubjectTable /></Panel>
    </div>
  );
}

function Movement() {
  const maxZone = Math.max(...PROFILE.zoneTime.map((z) => z.minutes));
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel icon={Route} title="Today's Movement" bodyClass="p-4">
        <ol className="space-y-2">
          {PROFILE.movementToday.map((m, i) => (
            <li key={i} className="flex items-start gap-2.5 rounded-lg p-1.5 hover:bg-surface-sunken">
              <span className="w-12 shrink-0 text-right font-mono text-micro leading-5 text-fg-subtle">{m.time}</span>
              <MapPin className="mt-1 h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-semibold text-fg">{m.room}</span>
                <span className="block truncate text-micro text-fg-subtle">{m.activity}</span>
              </span>
              <span className="shrink-0 rounded-md bg-surface-muted px-1.5 py-0.5 text-micro font-semibold text-fg-muted">{m.dwell}</span>
            </li>
          ))}
        </ol>
      </Panel>
      <Panel icon={Route} title="Time by Zone" right={<span className="text-caption text-fg-subtle">today</span>} bodyClass="p-4">
        <div className="space-y-2.5">
          {PROFILE.zoneTime.map((z) => (
            <BarRow key={z.zone} label={z.zone} value={z.minutes} suffix="m" max={maxZone} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Library() {
  const lib = PROFILE.library;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Visits this week" value={lib.visitsWeek} />
        <Tile label="Hours this week" value={lib.hoursWeek} unit="h" />
        <Tile label="Books out" value={lib.booksOut} sub="1 overdue" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel icon={BookOpen} title="Library Hours" right={<span className="text-caption text-fg-subtle">this week</span>} bodyClass="p-4">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={lib.weekly} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="d" tick={AXIS} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} unit="h" />
                <Tooltip {...TIP} cursor={{ fill: 'var(--surface-sunken)' }} />
                <Bar dataKey="hours" name="Hours" fill="#0ea5e9" radius={[4, 4, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel icon={BookOpen} title="Borrowed Books" count={lib.books.length} bodyClass="p-3">
          <ul className="space-y-1.5">
            {lib.books.map((b) => (
              <li key={b.title} className="flex items-center gap-2 rounded-lg border border-line p-2.5">
                <BookOpen className="h-4 w-4 shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate text-small font-medium text-fg">{b.title}</span>
                <span className={`shrink-0 text-micro font-semibold ${b.due.includes('overdue') ? 'text-danger' : 'text-fg-subtle'}`}>{b.due}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Labs() {
  const labs = PROFILE.labs;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
        <Tile label="Lab sessions" value={labs.sessionsWeek} sub="this week" />
        <Tile label="Lab hours" value={labs.hoursWeek} unit="h" sub="this week" />
      </div>
      <Panel icon={FlaskConical} title="Per-lab Breakdown" bodyClass="p-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
                <th className="px-2 pb-2 font-semibold">Lab</th>
                <th className="px-2 pb-2 text-right font-semibold">Sessions</th>
                <th className="px-2 pb-2 text-right font-semibold">Hours</th>
                <th className="px-2 pb-2 font-semibold">Attendance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {labs.perLab.map((l) => (
                <tr key={l.lab} className="hover:bg-surface-sunken">
                  <td className="px-2 py-2 text-heading font-semibold text-fg">{l.lab}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{l.sessions}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{l.hours}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-muted">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${l.attendance}%` }} />
                      </div>
                      <span className="tabular-nums text-caption font-semibold text-fg-secondary">{l.attendance}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function TimelineTab() {
  return (
    <Panel icon={Activity} title="Activity Timeline" right={<span className="text-caption text-fg-subtle">today</span>} bodyClass="p-4">
      <TimelineList items={PROFILE.timeline} />
    </Panel>
  );
}

function Behavior() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel icon={Brain} title="Behavior Indices" bodyClass="p-4">
        <div className="space-y-3">
          {PROFILE.behavior.indices.map((b) => (
            <BarRow key={b.label} label={b.label} value={b.value} suffix="" tone={b.value < 70 ? '#f59e0b' : '#F7983A'} />
          ))}
        </div>
      </Panel>
      <Panel icon={Brain} title="Observations" bodyClass="p-3">
        <ul className="space-y-1.5">
          {PROFILE.behavior.notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2 rounded-lg border border-line p-2.5">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[n.tone] || TONE_DOT.info}`} />
              <span className="text-small text-fg-secondary">{n.text}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function Alerts() {
  return (
    <Panel icon={BellRing} title="Alerts" count={PROFILE.alerts.length} bodyClass="p-4">
      <AlertCards items={PROFILE.alerts} />
    </Panel>
  );
}

function Reports({ student }) {
  const latest = PROFILE.reports[0];
  const exportReport = (format) => exportReportDocument({
    title: `Student Activity Report - ${student.name}`,
    code: `STU-${student.id}`,
    subtitle: 'Drishyam Activity Monitoring  -  Campus student report',
    details: [
      ['Organisation', 'Sharda University'],
      ['Student', `${student.name} (${student.id})`],
      ['Department', student.deptLabel],
    ],
    kpis: [
      { label: 'Attendance', value: `${latest.attendance}%`, note: latest.period },
      { label: 'Productivity', value: `${latest.productivity}%`, note: latest.period },
      { label: 'Risk band', value: latest.risk, note: latest.period },
    ],
    tables: [{
      title: 'Report history',
      columns: ['Period', 'Attendance %', 'Productivity %', 'Risk', 'Generated'],
      rows: PROFILE.reports.map((r) => [r.period, `${r.attendance}%`, `${r.productivity}%`, r.risk, r.generated]),
    }],
    rowNoun: 'periods',
    filename: `student-report-${student.id}`,
  }, format);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Attendance" value={latest.attendance} unit="%" sub={latest.period} />
        <Tile label="Productivity" value={latest.productivity} unit="%" sub={latest.period} />
        <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
          <p className="text-caption font-medium text-fg-muted">Risk band</p>
          <p className={`mt-1 text-section font-bold leading-none ${RISK_META[latest.risk] || 'text-fg'}`}>{latest.risk}</p>
          <p className="mt-1 text-micro text-fg-subtle">{latest.period}</p>
        </div>
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
                <th className="px-2 pb-2 text-right font-semibold">Attendance</th>
                <th className="px-2 pb-2 text-right font-semibold">Productivity</th>
                <th className="px-2 pb-2 text-right font-semibold">Risk</th>
                <th className="px-2 pb-2 text-right font-semibold">Generated</th>
                <th className="px-2 pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {PROFILE.reports.map((r) => (
                <tr key={r.period} className="hover:bg-surface-sunken">
                  <td className="px-2 py-2 text-heading font-semibold text-fg">{r.period}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{r.attendance}%</td>
                  <td className="px-2 py-2 text-right tabular-nums text-fg-secondary">{r.productivity}%</td>
                  <td className={`px-2 py-2 text-right font-semibold ${RISK_META[r.risk] || 'text-fg-secondary'}`}>{r.risk}</td>
                  <td className="px-2 py-2 text-right text-fg-subtle">{r.generated}</td>
                  <td className="px-2 py-2 text-right">
                    <ArrowRight className="ml-auto h-3.5 w-3.5 text-fg-disabled" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

export default function StudentTabs({ student }) {
  const [tab, setTab] = useState('overview');

  return (
    <div className="mt-4">
      {/* Tab nav */}
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

      {/* Active panel */}
      {tab === 'overview' && <Overview />}
      {tab === 'attendance' && <Attendance />}
      {tab === 'movement' && <Movement />}
      {tab === 'library' && <Library />}
      {tab === 'labs' && <Labs />}
      {tab === 'timeline' && <TimelineTab />}
      {tab === 'behavior' && <Behavior />}
      {tab === 'alerts' && <Alerts />}
      {tab === 'reports' && <Reports student={student} />}
    </div>
  );
}
