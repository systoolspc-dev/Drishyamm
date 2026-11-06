import { STATUS_CHIP, LEVEL_CHIP } from '../data';
import KpiBand from '../../kpi-card';
// The module-wide KPI band (../../kpi-card.jsx) — same card, colours and grid
// as the Activity Monitoring dashboard. Kept as a named export so the pages
// importing StatCards from here did not have to change.
export function StatCards({ cards, icons }) {
  return <KpiBand cards={cards} icons={icons} />;
}

export function Chip({ status, label }) {
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[status] || STATUS_CHIP.pending}`}>
      {label || status}
    </span>
  );
}

export function LevelChip({ level }) {
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${LEVEL_CHIP[level] || LEVEL_CHIP.low}`}>
      {level}
    </span>
  );
}
