import { cn } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';

/**
 * The KPI tile, for the whole product.
 *
 * Fifteen separate implementations of this card existed — `MetricCard` ×5,
 * `StatCard` ×4, `Metric` ×4, `Kpi`, `KpiGrid`, `StatCards` — and between them
 * the VALUE rendered at ten different sizes (text-lg, 15px, 16px, 18px, 19px,
 * 20px, 21px, 22px, text-2xl, 32px). A dashboard is a comparison surface; if
 * the numbers are not the same size, they are not comparable.
 *
 *   <MetricCard icon={Cctv} label="Cameras" value={42} sub="12 offline" />
 *   <MetricCard icon={ShieldAlert} label="Alerts" value={3} tone="danger" />
 *   <MetricCard … onClick={…} />          clickable tiles get hover affordance
 *   <MetricCard … size="sm" />            dense six-across grids
 *
 * `tone` colours the ICON and, when the metric is itself a problem, the value.
 * It does not repaint the card — a wall of tinted cards reads as noise.
 */
export function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'brand',
  /** Colour the VALUE too. For counts that are themselves the alarm. */
  alert = false,
  size = 'md',
  active = false,
  onClick,
  className,
  children,
  ...props
}) {
  const clickable = Boolean(onClick);
  const Tag = clickable ? 'button' : 'div';

  return (
    <Tag
      data-slot="metric-card"
      type={clickable ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'rounded-xl border bg-surface p-4 text-left shadow-sm transition',
        active ? 'border-brand-line ring-1 ring-brand-line' : 'border-line',
        clickable && 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:outline-none',
        size === 'sm' && 'p-3',
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        {Icon && (
          <span
            className={cn(
              'grid shrink-0 place-items-center rounded-lg',
              size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
              toneClass(tone, 'soft'),
            )}
          >
            <Icon className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} strokeWidth={2} />
          </span>
        )}
        <span className="truncate text-caption text-fg-muted">{label}</span>
      </div>

      {/* Rendered even with no value (e.g. a metric that's temporarily
          unavailable) so every card in a row reserves the same line — the
          sub line then lands at the same baseline everywhere instead of
          climbing up one row on just the cards missing a value. */}
      <p
        className={cn(
          'mt-2 tabular-nums',
          size === 'sm' ? 'text-metric-sm' : 'text-metric',
          value != null && alert ? toneClass(tone, 'text') : 'text-fg',
        )}
      >
        {value ?? ' '}
      </p>

      {sub && <p className="mt-1 truncate text-caption text-fg-subtle">{sub}</p>}
      {children}
    </Tag>
  );
}

/**
 * Responsive KPI row. Columns follow the count so a four-metric page and a
 * six-metric page still align to the same grid rhythm.
 */
export function MetricGrid({ children, cols, className }) {
  const n = cols ?? 4;
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3 sm:grid-cols-3',
        n <= 3 ? 'xl:grid-cols-3' : n === 4 ? 'xl:grid-cols-4' : n === 5 ? 'xl:grid-cols-5' : 'xl:grid-cols-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

export default MetricCard;
