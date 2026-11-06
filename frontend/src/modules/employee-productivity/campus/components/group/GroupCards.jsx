import { UsersRound, Ruler, MessagesSquare, Users } from 'lucide-react';
import { CARDS } from '../../group-data';

const ICONS = { current: UsersRound, avg: Ruler, longest: MessagesSquare, largest: Users };

// Four summary cards — same calm uniform-accent style as the rest of the module.
export default function GroupCards() {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {CARDS.map((c) => {
        const Icon = ICONS[c.key] || UsersRound;
        return (
          <div key={c.key} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
            <p className="mt-1 text-metric-sm font-bold leading-none tracking-tight text-fg">
              {c.value}{c.unit && <span className="ml-0.5 text-small font-semibold text-fg-subtle">{c.unit}</span>}
            </p>
            <p className="mt-1.5 truncate text-micro text-fg-subtle" title={c.sub}>{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}
