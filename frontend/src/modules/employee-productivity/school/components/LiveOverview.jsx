import { Link } from 'react-router-dom';
import {
  Radio, GraduationCap, Users, FlaskConical, LogIn, ShieldAlert, DoorOpen, Bus, Megaphone,
  ListChecks, BellRing, ChevronRight, Info,
} from 'lucide-react';
import Panel from '../../campus/components/Panel';
import { LIVE_FEED, ACTIVE_CLASSES, SAFETY_ALERTS } from '../data';

const FEED_ICON = {
  'class-start': GraduationCap, gate: DoorOpen, playground: Users, visitor: LogIn,
  safety: ShieldAlert, assembly: Megaphone, bus: Bus, lab: FlaskConical,
};
const FEED_TONE = { ok: 'bg-success-soft text-success-ink', info: 'bg-info-soft text-info-ink', warn: 'bg-warning-soft text-warning-ink', alert: 'bg-danger-soft text-danger-ink' };
const STATUS_CHIP = {
  ongoing: 'bg-success-soft text-success-ink ring-success-line',
  scheduled: 'bg-info-soft text-info-ink ring-info-line',
};
const SEVERITY = {
  high: { bar: 'bg-danger', chip: 'bg-danger-soft text-danger-ink ring-danger-line', label: 'High' },
  medium: { bar: 'bg-warning', chip: 'bg-warning-soft text-warning-ink ring-warning-line', label: 'Medium' },
  low: { bar: 'bg-line-strong', chip: 'bg-surface-muted text-fg-muted ring-line', label: 'Low' },
};

const FEED_INFO = 'Live Activity Feed — the stream of events as they happen (class started, gate entry, bus arrived, safety detection), newest first. Answers "what just happened?". Active Classes instead lists what is running right now.';
const ACTIVE_INFO = 'Active Classes — a snapshot of the sessions in progress right now, with headcount, status and start time. Answers "what is happening now?". The Live Activity Feed instead logs each event as it occurs.';

function InfoTip({ text }) {
  return (
    <span className="group/info relative cursor-help text-fg-disabled hover:text-fg-muted">
      <Info className="h-3.5 w-3.5" />
      <span className="pointer-events-none invisible absolute right-0 top-6 z-30 w-64 rounded-xl border border-line bg-surface p-2.5 text-left text-caption font-normal leading-snug text-fg-secondary shadow-lg opacity-0 transition group-hover/info:visible group-hover/info:opacity-100">{text}</span>
    </span>
  );
}

export default function LiveOverview() {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      {/* Live Activity Feed */}
      <Panel icon={Radio} title="Live Activity Feed" right={<InfoTip text={FEED_INFO} />}>
        <ul className="space-y-2">
          {LIVE_FEED.map((e) => {
            const Icon = FEED_ICON[e.type] || Radio;
            return (
              <li key={e.id} className="flex items-start gap-2.5 rounded-lg p-1.5 transition hover:bg-surface-sunken">
                <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${FEED_TONE[e.tone] || FEED_TONE.info}`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-small font-medium leading-snug text-fg">{e.text}</p>
                  <p className="text-micro text-fg-subtle">{e.where} · {e.time}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      {/* Active Classes */}
      <Panel icon={ListChecks} title="Active Classes" count={ACTIVE_CLASSES.length} right={<InfoTip text={ACTIVE_INFO} />}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
              <th className="px-1.5 pb-1.5 font-semibold">Class</th>
              <th className="px-1.5 pb-1.5 text-right font-semibold">Students</th>
              <th className="px-1.5 pb-1.5 text-right font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {ACTIVE_CLASSES.map((a) => (
              <tr key={a.id} className="transition hover:bg-surface-sunken">
                <td className="px-1.5 py-1.5">
                  <p className="font-semibold text-fg">{a.activity}</p>
                  <p className="text-micro text-fg-subtle">{a.grade} · {a.location}</p>
                </td>
                <td className="px-1.5 py-1.5 text-right font-bold tabular-nums text-fg-secondary">{a.students}</td>
                <td className="px-1.5 py-1.5 text-right">
                  <span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[a.status]}`}>{a.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* Safety & Recent Alerts */}
      <Panel
        icon={BellRing} title="Safety & Recent Alerts" count={SAFETY_ALERTS.length}
        right={<Link to="/alerts" className="inline-flex items-center text-micro font-semibold text-brand-ink hover:underline">View all <ChevronRight className="h-3 w-3" /></Link>}
      >
        <ul className="space-y-2">
          {SAFETY_ALERTS.map((a) => {
            const sev = SEVERITY[a.severity] || SEVERITY.low;
            return (
              <li key={a.id} className="relative overflow-hidden rounded-lg border border-line p-2.5 pl-3.5 transition hover:bg-surface-sunken">
                <span className={`absolute left-0 top-0 h-full w-1 ${sev.bar}`} aria-hidden />
                <div className="flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                  <p className="truncate text-small font-semibold text-fg">{a.title}</p>
                  <span className={`ml-auto shrink-0 rounded-full px-1.5 py-px text-micro font-bold uppercase tracking-wide ring-1 ${sev.chip}`}>{sev.label}</span>
                </div>
                <p className="mt-0.5 truncate text-micro text-fg-muted">{a.where} · {a.meta}</p>
                <p className="text-micro text-fg-subtle">since {a.since}</p>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
