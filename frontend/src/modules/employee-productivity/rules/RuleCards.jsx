import { Layers, CircleCheck, CircleSlash, Clock } from 'lucide-react';

const ICONS = { total: Layers, active: CircleCheck, disabled: CircleSlash, pending: Clock };

// Four rule cards — compact accent tiles (icon beside the figures, so the row
// stays short enough for the rules table to keep most of the viewport).
export default function RuleCards({ cards, className = '' }) {
  return (
    <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${className}`}>
      {cards.map((c) => {
        const Icon = ICONS[c.key] || Layers;
        return (
          <div key={c.key} className="flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 shadow-sm">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-caption font-medium text-fg-muted">{c.label}</p>
              <p className="mt-0.5 text-xl font-bold leading-tight tracking-tight text-fg lg:text-2xl">{c.value}</p>
              <p className="truncate text-xs text-fg-subtle">{c.sub}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
