import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Minus, Radio } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { AXIS, GRID, TIP } from '@/core/ui/chart-theme';
import { PageCard } from '@/core/layout/OperationsPage';
import { T } from '../type';
import { rangeLabel, usePhoneHistory } from './phone-history';

// ─────────────────────────────────────────────────────────────────────────────
// /activity-monitoring/analytics/phone-usage — Phone Usage aggregates.
//
// The count by employee and the store-wide trend used to sit under the live
// detections table on /activity-monitoring/phone. They answer "is this a
// pattern", not "what just happened", so they moved here and the live page
// became the table alone. That table is now one filter of the module's
// Activity Log (…/activity-log?type=phone) — the detections were never a
// destination of their own, they are an input to the staff score.
//
// Both read the date range in the page header (PhoneRangeBar; the URL's
// ?startDate=&endDate=, default Last 7 days). The trend's grain follows the
// span — hours for a day, days up to a month, weeks up to six months, months
// beyond — so the X axis stays readable at any range. Data: phone-history.js
// (future backend: /activity/phone-events?store&from&to).
// ─────────────────────────────────────────────────────────────────────────────

const TREND_ICON = { up: TrendingUp, down: TrendingDown, flat: Minus };
const TREND_CLS = { up: 'text-danger', down: 'text-success-ink', flat: 'text-fg-subtle' };
const TREND_TEXT = { up: 'rising', down: 'falling', flat: 'steady' };

const TREND_TITLE = { hour: 'Hourly trend', day: 'Daily trend', week: 'Weekly trend', month: 'Monthly trend' };

export default function PhoneTab() {
  const { range, data, violationSec } = usePhoneHistory();
  const { from, to } = range;
  // Bars scale to the busiest person, so the list reads at any roster size.
  const max = Math.max(1, ...data.byEmployee.map((p) => p.total));
  const period = rangeLabel(from, to);
  // Long series thin their ticks; Recharts drops overlapping labels itself.
  const dense = data.trend.length > 16;

  return (
    <div className="space-y-4 pb-5">
      <p className={T.itemMeta}>
        <span className="font-semibold text-fg-secondary">{period}</span> ·{' '}
        <span className="font-semibold text-fg-secondary tabular-nums">{data.total}</span> detections store-wide
        {' '}(<span className="tabular-nums">{data.flagged}</span> over {violationSec}s) ·{' '}
        <Link to="/activity-monitoring/activity-log?type=phone" className="inline-flex items-center gap-1 font-semibold text-brand-ink hover:underline print:hidden">
          <Radio className="h-3 w-3" /> Live detections
        </Link>
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 print:grid-cols-1">
        <PageCard className="p-4">
          <h2 className="text-lg font-semibold text-fg">Detections by employee</h2>
          <p className={`mb-3 ${T.itemMeta}`}>
            per person over the period, with the direction against the {data.days === 1 ? 'day' : `${data.days} days`} before
          </p>
          {data.byEmployee.length === 0 ? (
            <p className="py-6 text-center text-caption text-fg-subtle">No phone detections in this period.</p>
          ) : (
            <div className="space-y-2">
              {data.byEmployee.map((p) => {
                const TIcon = TREND_ICON[p.trend];
                return (
                  <div key={p.name} className="flex items-center gap-2.5" title={`${p.total} this period · ${p.prior} the period before`}>
                    <p className={`w-32 truncate ${T.itemTitle}`}>{p.name}</p>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
                      <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${(p.total / max) * 100}%` }} />
                    </div>
                    <span className="min-w-5 text-right text-small font-bold tabular-nums text-fg">{p.total}</span>
                    <TIcon className={`h-3.5 w-3.5 ${TREND_CLS[p.trend]}`} aria-label={TREND_TEXT[p.trend]} />
                  </div>
                );
              })}
            </div>
          )}
        </PageCard>

        <PageCard className="p-4">
          <h2 className="text-lg font-semibold text-fg">{TREND_TITLE[data.grain]}</h2>
          <p className={`mb-2 ${T.itemMeta}`}>detections {data.grainText}, store-wide</p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.trend} margin={{ top: 4, right: 8, left: -28, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis
                  dataKey="d"
                  tick={AXIS}
                  axisLine={false}
                  tickLine={false}
                  interval={dense ? 'preserveStartEnd' : 0}
                  minTickGap={dense ? 12 : 4}
                />
                <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip {...TIP} labelFormatter={(label, items) => items?.[0]?.payload?.range || label} />
                <Line
                  type="monotone"
                  dataKey="n"
                  name="Detections"
                  stroke="var(--brand)"
                  strokeWidth={2}
                  dot={data.trend.length > 45 ? false : { r: 2.5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </PageCard>
      </div>
    </div>
  );
}
