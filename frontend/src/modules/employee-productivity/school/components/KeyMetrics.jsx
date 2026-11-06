import { useState } from 'react';
import {
  Users, UserCheck, ClipboardCheck, GraduationCap, ShieldAlert, UserPlus, Bus, UserX,
  TrendingUp, TrendingDown, Minus, X, ChevronDown, ChevronUp,
} from 'lucide-react';
import { KpiCard, KpiRow } from '../../kpi-card';
import { KPIS, PRESENT_BY_CATEGORY, PRESENT_BY_GRADE } from '../data';

// ─────────────────────────────────────────────────────────────────────────────
// School KPI band — eight cards on the shared card and grid (../../kpi-card.jsx),
// laid out as two rows of four: the shared grid tops out at six tracks, and
// 6 + 2 would leave a ragged second row. Students Present is a toggle that
// opens the category / grade breakdown; the rest are static.
// ─────────────────────────────────────────────────────────────────────────────

const ICONS = {
  students: Users, staff: UserCheck, attendance: ClipboardCheck, classes: GraduationCap,
  safety: ShieldAlert, visitors: UserPlus, buses: Bus, absentees: UserX,
};

// ../data.js predates the shared card: 'primary' is the brand tone, a "/ 12"
// unit is a ratio, and the delta has no slot of its own so it rides on the
// sub-line.
const TONE = { primary: 'brand' };
function toCard({ delta, unit, tone, sub, ...kpi }) {
  const ratio = unit?.startsWith('/');
  return {
    ...kpi,
    tone: TONE[tone] || tone,
    ...(ratio ? { display: 'ratio', total: unit.slice(1).trim() } : { unit }),
    sub: delta ? `${sub} · ${delta}` : sub,
  };
}

const ROW = 4;

function BreakdownRow({ r, max }) {
  const flat = r.trend === 0, up = r.trend > 0;
  return (
    <li>
      <div className="flex items-center justify-between text-caption">
        <span className="font-medium text-fg-secondary">{r.label}</span>
        <span className="flex items-center gap-2 tabular-nums">
          <span className="font-bold text-fg">{r.count.toLocaleString()}</span>
          <span className="w-9 text-right text-fg-subtle">{r.pct}%</span>
          <span className={`inline-flex w-10 items-center justify-end gap-0.5 font-semibold ${flat ? 'text-fg-subtle' : up ? 'text-success-ink' : 'text-danger'}`}>
            {flat ? <Minus className="h-3 w-3" /> : up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {Math.abs(r.trend)}%
          </span>
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted">
        <div className="h-full rounded-full bg-brand" style={{ width: `${(r.count / max) * 100}%` }} />
      </div>
    </li>
  );
}

function Breakdown({ title, rows }) {
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <div>
      <p className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-fg-subtle">{title}</p>
      <ul className="space-y-1.5">{rows.map((r) => <BreakdownRow key={r.label} r={r} max={max} />)}</ul>
    </div>
  );
}

function PresentPopover({ onClose }) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />
      <div className="absolute left-0 top-full z-40 mt-2 max-h-[440px] w-[320px] overflow-y-auto rounded-xl border border-line bg-surface p-3 text-left shadow-xl">
        <div className="sticky top-0 -mt-3 mb-2 flex items-center justify-between bg-surface pt-3">
          <p className="text-small font-bold text-fg">Students Present · 1,486</p>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg-secondary"><X className="h-3.5 w-3.5" /></button>
        </div>
        <div className="space-y-3">
          <Breakdown title="By Category" rows={PRESENT_BY_CATEGORY} />
          <div className="border-t border-line-subtle" />
          <Breakdown title="By Grade Band" rows={PRESENT_BY_GRADE} />
        </div>
      </div>
    </>
  );
}

export default function KeyMetrics() {
  const [popover, setPopover] = useState(false);

  const card = (raw) => {
    const kpi = toCard(raw);
    const icon = ICONS[kpi.key] || Users;
    if (!raw.interactive) return <KpiCard icon={icon} key={kpi.key} kpi={kpi} />;
    // The popover sits beside the card, not inside it, so clicks in the
    // breakdown do not toggle the card.
    const toggle = () => setPopover((v) => !v);
    return (
      <div className="relative min-w-0" key={kpi.key}>
        <KpiCard
          active={popover}
          icon={icon}
          kpi={{ ...kpi, action: { icon: popover ? ChevronUp : ChevronDown, label: 'Show breakdown', onClick: toggle } }}
          onClick={toggle}
          title="Show breakdown by category and grade band"
        />
        {popover && <PresentPopover onClose={() => setPopover(false)} />}
      </div>
    );
  };

  const rows = [];
  for (let i = 0; i < KPIS.length; i += ROW) rows.push(KPIS.slice(i, i + ROW));

  return (
    <div className="space-y-4">
      {rows.map((row) => (
        <KpiRow count={row.length} key={row[0].key}>{row.map(card)}</KpiRow>
      ))}
    </div>
  );
}
