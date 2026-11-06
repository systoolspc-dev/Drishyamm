import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BarChart3, CheckCircle2, Flag, SlidersHorizontal } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/core/ui/dialog';
import { avatarStyle, initials, insightMetrics } from './scorecard';
import { T } from './type';
import { useActivityParams } from './useCaseStore';

// ACTION column → Quick Insights: one employee (or the team average, from the
// header) against the store benchmarks, as paired bars — grey is what's
// expected, the coloured bar is what happened, toned by how far it strays.
// Under each label, the configured threshold that "expected" stands for.

const TONE = {
  good: { bar: 'bg-success', text: 'text-success-ink', chip: 'border-success-line bg-success-soft text-success-ink', label: 'Meets expected', icon: CheckCircle2 },
  warn: { bar: 'bg-warning', text: 'text-warning-ink', chip: 'border-warning-line bg-warning-soft text-warning-ink', label: 'Minor deviation', icon: AlertTriangle },
  bad:  { bar: 'bg-danger',  text: 'text-danger-ink',  chip: 'border-danger-line bg-danger-soft text-danger-ink',   label: 'Needs coaching', icon: Flag },
};

const pct = (v, max) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;

export default function ScorecardInsights({ row, showImpact, period, onClose }) {
  const { params } = useActivityParams();
  const metrics = row ? insightMetrics(row, showImpact, params) : [];
  const counts = metrics.reduce((c, m) => ({ ...c, [m.tone]: (c[m.tone] ?? 0) + 1 }), {});

  return (
    <Dialog open={!!row} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="scrollbar-thin max-h-[calc(var(--app-vh)-2rem)] overflow-y-auto border-line bg-surface sm:max-w-lg">
        {row && (
          <>
            <DialogHeader className="text-left">
              <div className="flex items-center gap-3">
                {row.team ? (
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-brand-line bg-brand-soft text-brand" aria-hidden>
                    <BarChart3 className="h-5 w-5" />
                  </span>
                ) : (
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-small font-bold text-white" style={avatarStyle(row.name)} aria-hidden>
                    {initials(row.name)}
                  </span>
                )}
                <div className="min-w-0">
                  <DialogTitle className="truncate text-lg font-semibold text-fg">{row.name} — Quick Insights</DialogTitle>
                  <DialogDescription className={T.itemMeta}>
                    Expected vs. actual · {row.team ? `${row.count} employees` : row.role} · {period}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {/* Legend + verdict tally */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-caption text-fg-muted">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-line-strong" /> Expected</span>
              <span className="inline-flex items-center gap-1.5">
                <span className="flex h-2 w-3 overflow-hidden rounded-sm"><span className="flex-1 bg-success" /><span className="flex-1 bg-warning" /><span className="flex-1 bg-danger" /></span>
                Actual
              </span>
              <span className="ml-auto flex gap-1">
                {['good', 'warn', 'bad'].map((t) => counts[t] > 0 && (
                  <span key={t} className={`inline-flex rounded-full border px-2 py-px text-micro font-semibold tabular-nums ${TONE[t].chip}`}>
                    {counts[t]} {TONE[t].label.toLowerCase()}
                  </span>
                ))}
              </span>
            </div>

            <ul className="space-y-3.5">
              {metrics.map((m) => <MetricBars key={m.id} m={m} />)}
            </ul>

            {!row.team && (
              <DialogFooter>
                <Link
                  to={`/activity-monitoring/employee/${row.id}`}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-small font-semibold text-white shadow-sm hover:bg-brand-hover"
                >
                  Open full profile <ArrowRight className="h-4 w-4" />
                </Link>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MetricBars({ m }) {
  const tone = TONE[m.tone];
  return (
    <li>
      <div className="flex items-baseline gap-2">
        <p className="text-small font-semibold text-fg">{m.label}</p>
        <span className={`ml-auto inline-flex items-center gap-1 text-micro font-semibold ${tone.text}`}>
          <tone.icon className="h-3 w-3" /> {tone.label}
        </span>
      </div>
      {m.rule && (
        <p className="mb-1.5 mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-fg-muted">
          <SlidersHorizontal className="mt-0.5 h-3 w-3 shrink-0 text-fg-subtle" aria-hidden />
          <span><span className="font-semibold text-fg-secondary">Threshold:</span> {m.rule}</span>
        </p>
      )}
      <div className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-x-2 gap-y-1">
        <span className={T.itemMeta}>Expected</span>
        <div className="h-2.5 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={`Expected ${m.expectedText}`}>
          <div className="h-full rounded-full bg-line-strong" style={{ width: pct(m.expected, m.max) }} />
        </div>
        <span className="text-right text-caption tabular-nums text-fg-muted">{m.expectedText}</span>

        <span className={T.itemMeta}>Actual</span>
        <div className="h-2.5 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={`Actual ${m.actual}${m.unit}, ${tone.label}`}>
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: pct(m.actual, m.max) }} />
        </div>
        <span className={`text-right text-caption font-bold tabular-nums ${tone.text}`}>{m.actual}{m.unit}</span>
      </div>
    </li>
  );
}
