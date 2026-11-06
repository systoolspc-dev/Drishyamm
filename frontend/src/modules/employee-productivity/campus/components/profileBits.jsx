import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { TONE_DOT, SEV_BAR } from './profileConstants';

// Generic building blocks shared by the Student Activity and Faculty Activity
// profile pages — stat tiles, labelled bars, timelines and alert cards. One
// implementation, one look. (Chart tokens live in ./profileConstants.)

export function Tile({ label, value, unit, sub }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
      <p className="truncate text-caption font-medium text-fg-muted">{label}</p>
      <p className="mt-1 text-section font-bold leading-none tracking-tight text-fg">
        {value}{unit && <span className="ml-0.5 text-caption font-semibold text-fg-subtle">{unit}</span>}
      </p>
      {sub && <p className="mt-1 truncate text-micro text-fg-subtle">{sub}</p>}
    </div>
  );
}

export function BarRow({ label, value, suffix = '%', max = 100, tone = '#F7983A' }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-caption">
        <span className="font-medium text-fg-secondary">{label}</span>
        <span className="font-bold tabular-nums text-fg">{value}{suffix}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
        <div className="h-full rounded-full" style={{ width: `${(value / max) * 100}%`, background: tone }} />
      </div>
    </div>
  );
}

export function TimelineList({ items }) {
  return (
    <ol className="relative ml-1 border-l border-line pl-4">
      {items.map((t, i) => (
        <li key={i} className="relative pb-3 last:pb-0">
          <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${TONE_DOT[t.tone] || TONE_DOT.info}`} />
          <p className="text-small font-semibold text-fg">{t.activity}</p>
          <p className="text-micro text-fg-subtle">{t.time} · {t.room}</p>
        </li>
      ))}
    </ol>
  );
}

export function AlertCards({ items, emptyText = 'No active alerts.' }) {
  if (!items.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft/60 px-3 py-2 text-caption text-success-ink">
        <CheckCircle2 className="h-4 w-4 shrink-0" /> {emptyText}
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((a, i) => (
        <li key={i} className="relative overflow-hidden rounded-lg border border-line p-2.5 pl-3.5">
          <span className={`absolute left-0 top-0 h-full w-1 ${SEV_BAR[a.severity]}`} />
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <p className="truncate text-small font-semibold text-fg">{a.title}</p>
            <span className="ml-auto shrink-0 text-micro text-fg-subtle">{a.since}</span>
          </div>
          <p className="mt-0.5 truncate text-micro text-fg-muted">{a.meta}</p>
        </li>
      ))}
    </ul>
  );
}
