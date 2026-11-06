import { Activity } from 'lucide-react';
import Panel from './Panel';
import ConfidenceBadge from './ConfidenceBadge';
import { ACTIVE_SESSIONS, PEOPLE } from '../live-data';

// Initials avatar with a deterministic accent — no photos on this analytics page.
function Avatar({ name }) {
  const initials = (name.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand/15 text-micro font-bold text-brand-ink">
      {initials}
    </span>
  );
}

// Active Sessions — every person the AI is currently tracking. Rows open the
// person drawer.
export default function ActiveSessions({ onSelect, selectedId }) {
  const rows = ACTIVE_SESSIONS.map((id) => PEOPLE[id]).filter(Boolean);
  return (
    <Panel icon={Activity} title="Active Sessions" count={rows.length} bodyClass="p-2 max-h-[360px] overflow-y-auto">
      <ul className="space-y-1">
        {rows.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition hover:bg-surface-sunken ${
                selectedId === p.id ? 'bg-brand/[0.06] ring-1 ring-brand/25' : ''
              }`}
            >
              <Avatar name={p.name} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-small font-semibold text-fg">{p.name}</span>
                  <ConfidenceBadge value={p.confidence} />
                </span>
                <span className="mt-0.5 block truncate text-caption text-fg-muted">
                  {p.activity} · {p.room}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-mono text-caption font-semibold text-fg-secondary">{p.duration}</span>
                <span className="block text-micro uppercase tracking-wide text-fg-subtle">elapsed</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
