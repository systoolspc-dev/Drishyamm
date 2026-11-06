import { Link } from 'react-router-dom';
import {
  Radio, GraduationCap, Users, FlaskConical, UserCheck, LogIn, AlertTriangle, DoorOpen,
  ListChecks, BellRing, ChevronRight, Info,
} from 'lucide-react';
import { LIVE_FEED, ACTIVE_ACTIVITIES, RECENT_ALERTS } from '../data';

// Preview count on the dashboard; the full list lives on the Active Activities page.
const PREVIEW = 7;

// Hover tooltip that spells out what a panel is — and how it differs from its
// neighbour — so Feed vs Active never reads as redundant.
function InfoTip({ text }) {
  return (
    <span className="group/info relative cursor-help text-fg-disabled hover:text-fg-muted">
      <Info className="h-3.5 w-3.5" />
      <span className="pointer-events-none invisible absolute right-0 top-6 z-30 w-64 rounded-xl border border-line bg-surface p-2.5 text-left text-caption font-normal leading-snug text-fg-secondary shadow-lg opacity-0 transition group-hover/info:visible group-hover/info:opacity-100">
        {text}
      </span>
    </span>
  );
}

const FEED_INFO = 'Live Activity Feed — the stream of events as they happen (started, ended, entered, detected), newest first. Answers "what just happened?". The Active Activities panel instead lists what is running right now.';
const ACTIVE_INFO = 'Active Activities — a snapshot of sessions in progress right now, with people, status and start time. Answers "what is happening now?". The Live Activity Feed instead logs each event as it occurs.';

const FEED_ICON = {
  'class-start': GraduationCap, 'class-end': DoorOpen, crowd: Users,
  lab: FlaskConical, faculty: UserCheck, gathering: Users, visitor: LogIn,
};
const FEED_TONE = {
  ok: 'bg-success-soft text-success-ink', info: 'bg-info-soft text-info-ink',
  warn: 'bg-warning-soft text-warning-ink', alert: 'bg-danger-soft text-danger-ink',
};

const STATUS_CHIP = {
  ongoing: 'bg-success-soft text-success-ink ring-success-line',
  scheduled: 'bg-info-soft text-info-ink ring-info-line',
  completed: 'bg-surface-muted text-fg-muted ring-line',
};

const SEVERITY = {
  high: { bar: 'bg-danger', chip: 'bg-danger-soft text-danger-ink ring-danger-line', label: 'High' },
  medium: { bar: 'bg-warning', chip: 'bg-warning-soft text-warning-ink ring-warning-line', label: 'Medium' },
  low: { bar: 'bg-line-strong', chip: 'bg-surface-muted text-fg-muted ring-line', label: 'Low' },
};

function Panel({ icon, title, desc, info, count, to, children }) {
  const Icon = icon;
  return (
    <div className="flex h-full flex-col rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3">
        <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
        <div className="min-w-0">
          <p className="text-small font-bold leading-tight text-fg">{title}</p>
          {desc && <p className="truncate text-micro leading-tight text-fg-subtle">{desc}</p>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {info && <InfoTip text={info} />}
          {count != null && (
            <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-micro font-bold text-fg-muted">{count}</span>
          )}
          {to && (
            <Link to={to} className="inline-flex items-center text-micro font-semibold text-brand-ink hover:underline">
              View all <ChevronRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">{children}</div>
    </div>
  );
}

export default function LiveOverview() {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      {/* Live Activity Feed — the event stream (what just happened) */}
      <Panel icon={Radio} title="Live Activity Feed" desc="Events as they happen · newest first" info={FEED_INFO} to="/activity-monitoring/live-activity">
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
                  <p className="text-micro text-fg-subtle">{e.where} · {e.time} IST</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      {/* Active Activities Table — current state (what's happening now) */}
      <Panel icon={ListChecks} title="Active Activities" desc="Sessions in progress right now" info={ACTIVE_INFO} count={ACTIVE_ACTIVITIES.length} to="/activity-monitoring/active-activities">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wider text-fg-muted">
              <th className="px-1.5 pb-1.5 font-semibold">Activity</th>
              <th className="px-1.5 pb-1.5 text-right font-semibold">People</th>
              <th className="px-1.5 pb-1.5 text-right font-semibold">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {ACTIVE_ACTIVITIES.slice(0, PREVIEW).map((a) => (
              <tr key={a.id} className="transition hover:bg-surface-sunken">
                <td className="px-1.5 py-1.5">
                  <p className="font-semibold text-fg">{a.activity}</p>
                  <p className="text-micro text-fg-subtle">{a.location} · from {a.started}</p>
                </td>
                <td className="px-1.5 py-1.5 text-right font-bold tabular-nums text-fg-secondary">{a.people}</td>
                <td className="px-1.5 py-1.5 text-right">
                  <span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[a.status]}`}>
                    {a.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* Recent Alerts — events that need action */}
      <Panel icon={BellRing} title="Recent Alerts" desc="Issues that need attention" count={RECENT_ALERTS.length} to="/alerts">
        <ul className="space-y-2">
          {RECENT_ALERTS.map((a) => {
            const sev = SEVERITY[a.severity] || SEVERITY.low;
            return (
              <li key={a.id} className="relative overflow-hidden rounded-lg border border-line p-2.5 pl-3.5 transition hover:bg-surface-sunken">
                <span className={`absolute left-0 top-0 h-full w-1 ${sev.bar}`} aria-hidden />
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                  <p className="truncate text-small font-semibold text-fg">{a.title}</p>
                  <span className={`ml-auto shrink-0 rounded-full px-1.5 py-px text-micro font-bold uppercase tracking-wide ring-1 ${sev.chip}`}>{sev.label}</span>
                </div>
                <p className="mt-0.5 truncate text-micro text-fg-muted">{a.where} · {a.meta}</p>
                <p className="text-micro text-fg-subtle">since {a.since} IST</p>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
