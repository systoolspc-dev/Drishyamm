import { Radio, ChevronRight, Users } from 'lucide-react';
import Panel from './Panel';
import ConfidenceBadge from './ConfidenceBadge';
import { LIVE_TIMELINE } from '../live-data';

// Live Activity Timeline — the AI's running read of what's happening, newest
// first. Rows tied to a tracked person open the right drawer; group rows are
// anonymous crowd classifications (no identity).
export default function LiveTimeline({ onSelect }) {
  return (
    <Panel
      icon={Radio}
      title="Live Activity Timeline"
      right={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-micro font-bold uppercase tracking-wide text-success-ink ring-1 ring-success-line">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live
        </span>
      }
      bodyClass="p-2.5 max-h-[520px] overflow-y-auto"
    >
      <ol className="relative space-y-1">
        {LIVE_TIMELINE.map((e) => {
          const clickable = !!e.personId;
          const isGroup = !e.personId;
          return (
            <li key={e.id}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onSelect(e.personId)}
                className={`flex w-full items-start gap-3 rounded-lg p-2 text-left transition ${
                  clickable ? 'cursor-pointer hover:bg-surface-sunken' : 'cursor-default'
                }`}
              >
                <span className="mt-0.5 w-14 shrink-0 text-right font-mono text-micro leading-5 text-fg-subtle">{e.time}</span>
                <span className="relative mt-1 flex h-2 w-2 shrink-0 rounded-full bg-brand" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-small font-semibold text-fg">{e.actor}</span>
                    {isGroup && <Users className="h-3 w-3 shrink-0 text-fg-subtle" />}
                    <ConfidenceBadge value={e.conf} />
                  </span>
                  <span className="mt-0.5 block truncate text-caption text-fg-muted">
                    {e.activity} · {e.room}
                  </span>
                </span>
                {clickable && <ChevronRight className="mt-1.5 h-3.5 w-3.5 shrink-0 text-fg-disabled" />}
              </button>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
