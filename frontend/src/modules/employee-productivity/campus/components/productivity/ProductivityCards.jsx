import { Gauge, BookOpen, Hourglass, Brain, Users } from 'lucide-react';
import { CARDS } from '../../productivity-data';

const ICONS = { productivity: Gauge, study: BookOpen, idle: Hourglass, learning: Brain, collab: Users };

// Five productivity cards — uniform accent tiles, consistent with the module.
export default function ProductivityCards() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {CARDS.map((c) => {
        const Icon = ICONS[c.key] || Gauge;
        return (
          <div key={c.key} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <p className="mt-3 truncate text-caption font-medium text-fg-muted">{c.label}</p>
            <p className={`mt-1 font-bold tracking-tight text-fg ${c.small ? 'text-heading leading-tight' : 'text-metric-sm leading-none'}`}>
              {c.value}{c.unit && <span className="ml-0.5 text-small font-semibold text-fg-subtle">{c.unit}</span>}
            </p>
            <p className="mt-1.5 truncate text-micro text-fg-subtle">{c.sub}</p>
          </div>
        );
      })}
    </div>
  );
}
