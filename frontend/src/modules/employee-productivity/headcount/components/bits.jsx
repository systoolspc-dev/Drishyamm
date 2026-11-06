import { Fragment } from 'react';
import {
  CircleDot, DoorOpen, Building2, Presentation, GraduationCap, FlaskConical,
  Laptop, Briefcase, Users, UtensilsCrossed, ListOrdered, MoveHorizontal,
  BookOpen, Trophy, Waves, Armchair, Wrench, Lock, Gem,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { STATUS_CHIP, STATUS_LABEL, heatColor } from '../headcount-data';
import KpiBand from '../../kpi-card';

// Zone kind → icon. Local (not exported) so this .jsx keeps exporting components
// only and Fast Refresh stays happy.
const ZONE_ICON = {
  gate: DoorOpen, lobby: Building2, hall: Presentation, classroom: GraduationCap,
  lab: FlaskConical, work: Laptop, office: Briefcase, meeting: Users,
  dining: UtensilsCrossed, queue: ListOrdered, corridor: MoveHorizontal,
  library: BookOpen, sports: Trophy, leisure: Waves, lounge: Armchair,
  service: Wrench, secure: Lock, display: Gem,
};

export function Chip({ status, label }) {
  return (
    <span className={`inline-block shrink-0 rounded-full px-1.5 py-0.5 text-caption font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[status] || STATUS_CHIP.empty}`}>
      {label || STATUS_LABEL[status] || status}
    </span>
  );
}

// The module-wide KPI band (../../kpi-card.jsx) — same card, colours and grid
// as the Activity Monitoring dashboard. Kept as a named export so the pages
// importing StatCards from here did not have to change.
export function StatCards({ cards, icons }) {
  return <KpiBand cards={cards} icons={icons} />;
}

// Zone icon, picked by behavioural `kind` (not the vertical's own type id), so
// a newly configured type gets the right glyph with no change here.
export function ZoneIcon({ kind, className = 'h-3.5 w-3.5' }) {
  const Icon = ZONE_ICON[kind] || CircleDot;
  return <Icon className={className} strokeWidth={2} />;
}

// Zone × hour utilization. Sequential single hue — darker is fuller.
export function Heatmap({ rows, buckets }) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[620px]">
        <div
          className="grid items-center gap-[3px]"
          style={{ gridTemplateColumns: `minmax(96px,150px) repeat(${buckets.length}, minmax(0,1fr))` }}
        >
          {rows.map((r) => (
            <HeatRow key={r.id} label={r.label} cells={r.cells} />
          ))}
          <div />
          {buckets.map((t) => (
            <div key={t} className="text-center font-mono text-[9.5px] text-fg-subtle">{t.slice(0, 2)}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// A heatmap row: label + its cells, flattened into the parent grid.
function HeatRow({ label, cells }) {
  return (
    <>
      <div className="truncate pr-2 text-right text-[10.5px] text-fg-muted">{label}</div>
      {cells.map((c) => (
        <div
          key={c.time}
          title={`${label} · ${c.time} — ${c.count} present (${c.pct}%)`}
          className="h-[22px] rounded transition-transform hover:scale-110"
          style={{ background: heatColor(c.pct) }}
        />
      ))}
    </>
  );
}

// Count vs identified, per zone. The delta is the reconciliation signal — the one
// measurement a face pipeline cannot produce alone.
export function ReconBars({ zones }) {
  const max = Math.max(...zones.map((z) => z.count), 1);
  return (
    <div className="flex flex-col gap-3">
      {zones.map((z) => {
        const tone = z.delta === 0 ? 'text-success-ink' : z.delta / Math.max(z.count, 1) > 0.4 ? 'text-danger-ink' : 'text-warning-ink';
        return (
          <div key={z.id}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11.5px] font-semibold text-fg-secondary">{z.label}</span>
              <span className={`shrink-0 text-[11.5px] font-extrabold tabular-nums ${tone}`}>
                {z.delta > 0 ? '+' : ''}{z.delta} unidentified
              </span>
            </div>
            <div className="mt-1 flex flex-col gap-[3px]">
              {[
                { v: z.count, c: 'var(--brand)', t: 'counted' },
                { v: z.identified, c: 'var(--info)', t: 'identified' },
              ].map((b) => (
                <div key={b.t} className="flex items-center gap-2">
                  <div className="h-2 rounded-sm" style={{ width: `${(b.v / max) * 100}%`, minWidth: 2, background: b.c }} />
                  <span className="whitespace-nowrap text-[10px] tabular-nums text-fg-subtle">{b.v} {b.t}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
