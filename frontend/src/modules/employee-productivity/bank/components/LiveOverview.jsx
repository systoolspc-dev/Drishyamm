import { Link } from 'react-router-dom';
import { Radio, ListChecks, BellRing, Info, ShieldAlert, Users, Clock, Siren, Wrench } from 'lucide-react';
import Panel from '../../campus/components/Panel';
import { ALERTS_DATA, FACILITY_DATA } from '../pages-data';
import { Chip, LevelChip } from './bits';

const KIND_ICON = { vault: ShieldAlert, queue: Users, counter: Clock, emergency: Siren, maintenance: Wrench };
const LEVEL_TONE = { high: 'bg-danger-soft text-danger-ink', medium: 'bg-warning-soft text-warning-ink', low: 'bg-surface-muted text-fg-muted' };
const SEV_BAR = { high: 'bg-danger', medium: 'bg-warning', low: 'bg-line-strong' };

const FEED_INFO = 'Live Activity Feed — the stream of flagged events as they happen (vault access, queue, emergencies), newest first. Answers "what just happened?". Active Tasks instead lists facility work in progress right now.';
const ACTIVE_INFO = 'Active Tasks — a snapshot of facility/maintenance tickets in progress or overdue right now. The Live Activity Feed instead logs each event as it occurs.';

function InfoTip({ text }) {
  return (
    <span className="group/info relative cursor-help text-fg-disabled hover:text-fg-muted">
      <Info className="h-3.5 w-3.5" />
      <span className="pointer-events-none invisible absolute right-0 top-6 z-30 w-64 rounded-xl border border-line bg-surface p-2.5 text-left text-caption font-normal leading-snug text-fg-secondary shadow-lg opacity-0 transition group-hover/info:visible group-hover/info:opacity-100">{text}</span>
    </span>
  );
}

export default function LiveOverview() {
  const feed = ALERTS_DATA;
  const activeTasks = FACILITY_DATA.tickets.filter((t) => t.status !== 'resolved');

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      {/* Live feed */}
      <Panel icon={Radio} title="Live Activity Feed" right={<InfoTip text={FEED_INFO} />}>
        <ul className="space-y-2">
          {feed.map((e) => {
            const Icon = KIND_ICON[e.kind] || Radio;
            return (
              <li key={e.id} className="flex items-start gap-2.5 rounded-lg p-1.5 transition hover:bg-surface-sunken">
                <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${LEVEL_TONE[e.level] || LEVEL_TONE.low}`}><Icon className="h-3.5 w-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5"><span className="truncate text-small font-semibold text-fg">{e.type}</span><LevelChip level={e.level} /></span>
                  <p className="truncate text-micro text-fg-subtle">{e.detail} · {e.time}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      {/* Active tasks */}
      <Panel icon={ListChecks} title="Active Tasks" count={activeTasks.length} right={<InfoTip text={ACTIVE_INFO} />}>
        <ul className="space-y-1.5">
          {activeTasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2.5 rounded-lg border border-line p-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-fg-muted"><Wrench className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-small font-semibold text-fg">{t.equipment}</span><span className="block text-micro text-fg-subtle">{t.issue} · {t.responseTime}</span></span>
              <Chip status={t.status} label={t.label} />
            </li>
          ))}
        </ul>
      </Panel>

      {/* Recent alerts */}
      <Panel icon={BellRing} title="Recent Alerts" count={feed.length} right={<Link to="/activity-monitoring/bank/alerts" className="text-caption font-semibold text-brand-ink hover:underline">View all</Link>}>
        <ul className="space-y-2">
          {feed.slice(0, 5).map((a) => (
            <li key={a.id} className="relative overflow-hidden rounded-lg border border-line p-2.5 pl-3.5">
              <span className={`absolute left-0 top-0 h-full w-1 ${SEV_BAR[a.level] || SEV_BAR.low}`} />
              <div className="flex items-center gap-1.5"><ShieldAlert className="h-3.5 w-3.5 shrink-0 text-fg-subtle" /><p className="truncate text-small font-semibold text-fg">{a.type}</p><span className="ml-auto"><LevelChip level={a.level} /></span></div>
              <p className="mt-0.5 truncate text-micro text-fg-muted">{a.detail}</p>
              <p className="text-micro text-fg-subtle">{a.time}</p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
