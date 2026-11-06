import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Flag } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/core/ui/dialog';
import { BREAK_WARN_MIN, avatarStyle, coachingFlags, initials, scoreBar, scoreCls } from './scorecard';
import { T } from './type';

// ACTION column → a one-screen summary of one employee's week, so a manager can
// check why someone scored what they did without leaving the report. The full
// timeline stays on the profile page, one click further.
export default function ScorecardQuickView({ row, rank, total, showImpact, onClose }) {
  const flags = row ? coachingFlags(row) : [];

  return (
    <Dialog open={!!row} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="border-line bg-surface sm:max-w-md">
        {row && (
          <>
            <DialogHeader className="text-left">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-small font-bold text-white" style={avatarStyle(row.name)} aria-hidden>
                  {initials(row.name)}
                </span>
                <div className="min-w-0">
                  <DialogTitle className="truncate text-lg font-semibold text-fg">{row.name}</DialogTitle>
                  <DialogDescription className={T.itemMeta}>
                    {row.role} · Rank #{rank} of {total}
                  </DialogDescription>
                </div>
                <div className="ml-auto pr-6 text-right">
                  <p className={`text-metric-sm font-bold leading-none tabular-nums ${scoreCls(row.score)}`}>{row.score}</p>
                  <p className={T.itemMeta}>score / 100</p>
                </div>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                <div className={`h-full rounded-full ${scoreBar(row.score)}`} style={{ width: `${row.score}%` }} />
              </div>
            </DialogHeader>

            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Days worked" value={row.days} />
              <Stat label="On-time" value={`${row.onTime}%`} warn={row.onTime < 80} />
              <Stat label="Avg hours" value={row.avgH} />
              <Stat label="Break time" value={`${row.breakMin}m`} warn={row.breakMin > BREAK_WARN_MIN} />
              <Stat label="Phone incidents" value={row.phone} warn={row.phone >= 3} />
              {showImpact && (
                <Stat
                  label="Counter / queue"
                  value={`${row.impact?.counterMin ?? 0}m · ${row.impact?.queueBreaches ?? 0}×`}
                  warn={(row.impact?.counterMin ?? 0) >= 10}
                />
              )}
            </dl>

            <div>
              <p className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-fg-subtle">Coaching focus</p>
              {flags.length ? (
                <ul className="space-y-1">
                  {flags.map((f) => (
                    <li key={f} className="flex items-center gap-2 rounded-lg border border-warning-line bg-warning-soft px-2.5 py-1.5 text-caption text-warning-ink">
                      <Flag className="h-3.5 w-3.5 shrink-0" /> {f}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 rounded-lg border border-success-line bg-success-soft px-2.5 py-1.5 text-caption text-success-ink">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Within policy on every measure this period.
                </p>
              )}
            </div>

            <DialogFooter>
              <Link
                to={`/activity-monitoring/employee/${row.id}`}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-small font-semibold text-white shadow-sm hover:bg-brand-hover"
              >
                Open full profile <ArrowRight className="h-4 w-4" />
              </Link>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-2.5 py-2">
      <dt className={T.itemMeta}>{label}</dt>
      <dd className={`text-body font-bold tabular-nums ${warn ? 'text-warning-ink' : 'text-fg'}`}>{value}</dd>
    </div>
  );
}
