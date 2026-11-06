import { Link } from 'react-router-dom';
import {
  History, LogIn, LogOut, Coffee, CupSoda, Smartphone, MonitorX,
  UsersRound, EyeOff, Inbox,
} from 'lucide-react';
import { useModuleData } from '../useModuleData';
import { T } from '../type';

// Dashboard preview: latest few events only — Event Log holds the full stream.
const PREVIEW = 6;

// SECTION 7 — Recent activity feed. Latest N events as a vertical timeline —
// the same stream the Event Log page shows in full, so "View all" links there.

const TYPE_META = {
  'employee-entry':     { icon: LogIn,      tile: 'bg-success-soft text-success-ink' },
  'employee-exit':      { icon: LogOut,     tile: 'bg-surface-muted text-fg-muted' },
  'break-start':        { icon: Coffee,     tile: 'bg-warning-soft text-warning-ink' },
  'break-end':          { icon: CupSoda,    tile: 'bg-success-soft text-success-ink' },
  'phone-usage':        { icon: Smartphone, tile: 'bg-warning-soft text-warning-ink' },
  'counter-unattended': { icon: MonitorX,   tile: 'bg-danger-soft text-danger-ink' },
  'queue-alert':        { icon: UsersRound, tile: 'bg-danger-soft text-danger-ink' },
  'low-activity':       { icon: EyeOff,     tile: 'bg-warning-soft text-warning-ink' },
};

export default function ActivityFeed({ loading }) {
  const { FEED } = useModuleData();
  if (loading) {
    return (
      <div className="animate-pulse rounded-xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-3 h-4 w-40 rounded bg-surface-muted" />
        {[0, 1, 2, 3].map((i) => <div key={i} className="mb-2 h-12 rounded-lg bg-surface-muted" />)}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-brand" />
        <h2 className="text-lg font-semibold text-fg">Recent Activity</h2>
        <Link to="/event-log" className="ml-auto text-caption font-semibold text-brand-ink hover:underline">View all →</Link>
      </div>

      {FEED.length === 0 ? (
        // Empty state — quiet day / camera stream just started
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-fg-subtle">
            <Inbox className="h-5 w-5" />
          </span>
          <p className="text-body font-semibold text-fg-secondary">No activity yet</p>
          <p className="text-caption text-fg-subtle">Events appear here as cameras detect them.</p>
        </div>
      ) : (
        <div className="relative pr-1">
          {/* timeline spine */}
          <span className="absolute bottom-2 left-[13px] top-2 w-px bg-line" aria-hidden />
          <div className="space-y-1">
            {FEED.slice(0, PREVIEW).map((ev) => {
              const meta = TYPE_META[ev.type] || TYPE_META['employee-entry'];
              const Icon = meta.icon;
              return (
                <div key={ev.id} className="relative flex items-start gap-2.5 rounded-lg py-1.5 pl-0.5 pr-1 transition hover:bg-surface-sunken">
                  <span className={`relative z-[1] mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full ring-4 ring-surface ${meta.tile}`}>
                    <Icon className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    {/* Severity is already carried by the icon tile color —
                        no separate status chip needed. */}
                    <div className="flex items-baseline gap-1.5">
                      <span className={`tabular-nums ${T.itemMeta}`}>{ev.time}</span>
                      {ev.employee && <span className={`truncate ${T.itemTitle}`}>{ev.employee}</span>}
                      <span className={`ml-auto shrink-0 ${T.itemMeta}`}>{ev.camera} · {ev.zone}</span>
                    </div>
                    <p className={`truncate ${T.itemMeta}`}>{ev.text}</p>
                  </div>
                </div>
              );
            })}
            {FEED.length > PREVIEW && (
              <Link
                to="/event-log"
                className="relative z-[1] block rounded-lg border border-dashed border-line bg-surface py-2 text-center text-caption font-semibold text-brand-ink transition hover:border-brand/40 hover:bg-brand/5"
              >
                +{FEED.length - PREVIEW} earlier events — open Event Log →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
