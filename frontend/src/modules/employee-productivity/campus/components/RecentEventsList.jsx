import { ListChecks } from 'lucide-react';
import Panel from './Panel';
import { RECENT_EVENTS, PEOPLE } from '../live-data';

const TONE = {
  ok: 'bg-success', info: 'bg-info', warn: 'bg-warning', alert: 'bg-danger',
};

// Recent Events — discrete movement / state changes. Person-attributed rows are
// clickable and open the drawer; ambient events are not.
export default function RecentEventsList({ onSelect }) {
  return (
    <Panel icon={ListChecks} title="Recent Events" count={RECENT_EVENTS.length} bodyClass="p-2 max-h-[360px] overflow-y-auto">
      <ul className="space-y-0.5">
        {RECENT_EVENTS.map((e) => {
          const person = e.personId ? PEOPLE[e.personId] : null;
          const clickable = !!person;
          return (
            <li key={e.id}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onSelect(e.personId)}
                className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition ${
                  clickable ? 'hover:bg-surface-sunken' : 'cursor-default'
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[e.tone] || TONE.info}`} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-small text-fg-secondary">
                  {person && <span className="font-semibold text-fg">{person.name} · </span>}
                  {e.text}
                </span>
                <span className="shrink-0 font-mono text-micro text-fg-subtle">{e.time}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
