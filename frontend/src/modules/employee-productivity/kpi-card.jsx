import { Link } from 'react-router-dom';
import {
  CircleDot, Info,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';

// ─────────────────────────────────────────────────────────────────────────────
// THE Activity Monitoring KPI card — one component for every KPI row in the
// module: the retail/corporate dashboard (dashboard/KpiGrid.jsx), every
// subpage (Performance, Attendance, Analytics, Headcount, Employee Detail) and
// every vertical (bank, hospitality, hostel, school, campus — their
// `StatCards` in components/bits.jsx are thin adapters over KpiBand).
//
// Before this file owned the card there were eight hand-rolled variants, each
// with its own padding, label size, icon placement and colour rule, so the
// same number looked different depending on which page you read it on. Do not
// add a ninth: extend this one.
//
// ANATOMY (identical on every page)
//
//   ┌─────────────────────────────────────────────┐
//   │ LABEL                 [badge]   ⓘ  [icon]   │  header row
//   │ 87 /100                                     │  value
//   │ ─────────────────────────────────────────── │
//   │ Counter coverage            Weakest area    │  footer (optional)
//   └─────────────────────────────────────────────┘
//
//   label   text-xs 12px / 600 uppercase, truncates first
//   badge   text-xs 12px / 500 pill, the state in plain words
//   value   text-2xl 24px / 700, always text-fg — the state is carried by
//           the icon tile and badge colours, never by recolouring the number
//   footer  text-caption, under a hairline. `foot: { label, value, tone }`
//           splits it into a key on the left and a toned value on the right;
//           a plain `sub` string fills it as one truncated line.
//
// COLOUR. One `tone` per card paints the icon tile; the badge may carry its
// own tone. Tones: good · warn · bad · neutral · brand (the default when a
// card states no tone). Aliases accepted from older data: crit/danger → bad,
// warning → warn, success → good.
//
// PLACEMENT. The band is the FIRST block of a page's content — directly under
// the page header and the filter bar that scopes its numbers, above any
// charts, panels or tables — and it is not wrapped in a panel. Every page gets the same grid and gap from
// KpiRow, so the cards line up the same way everywhere.
// ─────────────────────────────────────────────────────────────────────────────

// Fixed track count per breakpoint rather than auto-fit, so the row cannot
// re-flow unpredictably as the sidebar collapses. Four cards go one-row at
// xl; five and six go 3-up at lg and one row only at 2xl, where a sixth of the
// content width is still wide enough for the label, badge and icon cluster.
const GRID = {
  1: 'grid grid-cols-1 gap-4',
  2: 'grid grid-cols-1 sm:grid-cols-2 gap-4',
  // A third card on the 2-col grid would leave a hole, so it spans both.
  3: 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 sm:[&>:nth-child(3)]:col-span-2 xl:[&>:nth-child(3)]:col-span-1',
  4: 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4',
  5: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 gap-4',
  6: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-4',
};
const gridCls = (n) => GRID[Math.min(Math.max(n, 1), 6)];

// Every zone is one line (label, badge and footer all truncate), so a card's
// height is fixed by its anatomy rather than by its copy: a long badge or
// sub-line cannot make one card taller than its neighbours. The floor is the
// header-and-value card; a row with footers grows to hold them, and the grid
// stretches every card in the row to the same height either way. The three
// zones are spread with justify-between, so the value sits centred between
// the header and the footer on every card.
const CARD_BASE = 'group/kpi flex min-h-[7.25rem] min-w-0 flex-col justify-between rounded-xl border bg-surface p-4 shadow-sm';

// Header row: [label · badge] on the left, [ⓘ · icon tile] pinned right. The
// left group is the only thing allowed to shrink — the label truncates first —
// so the icons can never wrap or be pushed off the card.
const HEADER_CLS = 'mb-2 flex items-center justify-between gap-2';
const LABEL_CLS = 'min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-fg-muted';
const VALUE_CLS = 'flex min-w-0 items-baseline gap-1 text-2xl font-bold leading-none text-fg';
const FOOT_CLS = 'mt-3 flex min-w-0 items-center justify-between gap-3 border-t border-line-subtle pt-2 text-caption';
// The footer's value carries the card's state in words, so it takes the tone.
const FOOT_INK = {
  good: 'text-success-ink', warn: 'text-warning-ink', bad: 'text-danger-ink',
  neutral: 'text-fg-secondary', brand: 'text-brand-ink',
};

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40';
const HOVER = `transition hover:border-brand/40 hover:shadow-md ${FOCUS}`;

// `tile` paints the icon square, `badge` the status pill. They are separate
// because a healthy card can still carry a count worth flagging.
const TONES = {
  good:    { tile: 'bg-success-soft text-success-ink', badge: 'bg-success-soft text-success-ink ring-success-line' },
  warn:    { tile: 'bg-warning-soft text-warning-ink', badge: 'bg-warning-soft text-warning-ink ring-warning-line' },
  bad:     { tile: 'bg-danger-soft text-danger-ink',   badge: 'bg-danger-soft text-danger-ink ring-danger-line' },
  neutral: { tile: 'bg-surface-muted text-fg-muted',   badge: 'bg-surface-muted text-fg-muted ring-line' },
  brand:   { tile: 'bg-brand-soft text-brand-ink',     badge: 'bg-brand-soft text-brand-ink ring-brand-line' },
};
const ALIAS = { crit: 'bad', danger: 'bad', warning: 'warn', success: 'good' };
const toneOf = (t) => TONES[ALIAS[t] || t] || TONES.brand;
const inkOf = (t) => FOOT_INK[ALIAS[t] || t] || FOOT_INK.neutral;

function KpiFoot({ kpi }) {
  const { foot, sub } = kpi;
  if (foot) {
    return (
      <div className={FOOT_CLS}>
        <span className="min-w-0 truncate text-fg-subtle" title={foot.label}>{foot.label}</span>
        <span className={`min-w-0 truncate text-right font-semibold ${inkOf(foot.tone)}`} title={foot.value}>{foot.value}</span>
      </div>
    );
  }
  if (!sub) return null;
  return (
    <div className={FOOT_CLS}>
      <span className="min-w-0 truncate text-fg-subtle" title={typeof sub === 'string' ? sub : undefined}>{sub}</span>
    </div>
  );
}

export function KpiCardSkeleton({ className = '' }) {
  return (
    <div className={`${CARD_BASE} border-line ${className} animate-pulse`}>
      <div className={HEADER_CLS}>
        <div className="h-3 w-24 rounded bg-surface-muted" />
        <div className="h-7 w-7 rounded-lg bg-surface-muted" />
      </div>
      <div className="flex flex-1 items-center">
        <div className="h-7 w-20 rounded bg-line" />
      </div>
    </div>
  );
}

// The ⓘ carries the spec: purpose, formula, and the backend fields that will
// populate the card once the API exists. Managers hover it; devs read it as the
// field contract. Older data carries the same three under `tip` (fields as a
// string) — normalised here so every page gets the same tooltip.
function specOf(kpi) {
  const tip = kpi.tip || {};
  const fields = kpi.fields || tip.fields;
  return {
    purpose: kpi.purpose || tip.purpose,
    formula: kpi.formula || tip.formula,
    fields: typeof fields === 'string' ? [fields] : fields || [],
  };
}

function KpiSpec({ spec, goesTo }) {
  return (
    <>
      {spec.purpose && <p className="text-caption leading-snug text-fg-secondary">{spec.purpose}</p>}
      {goesTo && (
        <p className="mt-1.5 text-caption leading-snug text-fg-muted">
          Opens <span className="font-semibold text-fg-secondary">{goesTo}</span>.
        </p>
      )}
      {spec.formula && (
        <>
          <p className="mt-2 text-micro font-semibold uppercase tracking-wide text-fg-subtle">Formula</p>
          <p className="mt-0.5 rounded-md bg-surface-sunken px-2 py-1.5 font-mono text-micro leading-snug break-words text-fg-secondary">{spec.formula}</p>
        </>
      )}
      {spec.fields.length ? (
        <>
          <p className="mt-2 text-micro font-semibold uppercase tracking-wide text-fg-subtle">Backend fields</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {spec.fields.map((f) => (
              <span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-micro text-brand-ink" key={f}>{f}</span>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

// One branch per `display` kind — the DTO decides the shape, not the consumer.
// Both render the number at the same step so cards share a value baseline.
function KpiValue({ kpi }) {
  if (kpi.display === 'ratio') {
    return (
      <p className={VALUE_CLS}>
        <span className="tabular-nums">{kpi.value}</span>
        <span className="font-semibold text-fg-subtle tabular-nums">/ {kpi.total}</span>
        {kpi.unit && <span className="ml-0.5 truncate text-small text-fg-muted">{kpi.unit}</span>}
      </p>
    );
  }
  return (
    <p className={VALUE_CLS}>
      <span className="truncate tabular-nums">{kpi.value}</span>
      {kpi.unit && <span className="truncate text-small text-fg-muted">{kpi.unit}</span>}
    </p>
  );
}

// Swallow a click so a control inside a clickable card acts on its own.
const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

/**
 * One card.
 *
 *   kpi       { key, label, value, unit?, total?, display?, tone?, badge?,
 *               sub?, purpose?, formula?, fields?, tip?, action? }
 *   to        makes the card a Link to the page holding the story behind it
 *   goesTo    names that page for the ⓘ and the aria-label
 *   onClick   makes the card a toggle (quick filter); `active` shows it on
 *   children  replaces the value when a card shows something other than a
 *             number (e.g. a person's name) — keep it to one text-2xl line
 */
export function KpiCard({
  kpi, icon: Icon = CircleDot, to, goesTo, onClick, active = false, title,
  className = '', children,
}) {
  const tone = toneOf(kpi.tone);
  const badge = kpi.badge ? toneOf(kpi.badge.tone || kpi.tone) : null;
  const spec = specOf(kpi);
  const hasSpec = Boolean(spec.purpose || spec.formula || spec.fields.length || goesTo);
  const action = kpi.action;
  const ActionIcon = action?.icon;

  const border = active ? 'border-brand ring-2 ring-brand/30' : 'border-line';
  const cls = `${CARD_BASE} ${border} ${className}`;

  const body = (
    <>
      <div className={HEADER_CLS}>
        <span className={LABEL_CLS} title={kpi.label}>{kpi.label}</span>

        {/* Badge, ⓘ and icon share the right edge, so every badge ends at the
            same x on every card however long its text or the label. */}
        <div className="flex min-w-0 shrink-0 items-center gap-1.5 text-fg-disabled">
          {kpi.badge && (
            <span
              className={`mr-0.5 max-w-[8rem] truncate rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${badge.badge}`}
              title={kpi.badge.text}
            >
              {kpi.badge.text}
            </span>
          )}
          {hasSpec && (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A span, not a button: this may sit inside the card's <Link>,
                    and clicking the ⓘ should explain the metric rather than
                    navigate away from it. */}
                <span
                  aria-label={`What ${kpi.label} measures`}
                  className={`flex shrink-0 cursor-help items-center rounded transition hover:text-fg-muted focus:outline-none ${FOCUS}`}
                  onClick={stop}
                  role="button"
                  tabIndex={0}
                >
                  <Info className="h-4 w-4 shrink-0" />
                </span>
              </TooltipTrigger>
              <TooltipContent
                align="end"
                className="w-72 max-w-[calc(var(--app-vw)-2rem)] p-3 text-left"
                collisionPadding={12}
                side="bottom"
                variant="card"
              >
                <KpiSpec goesTo={goesTo} spec={spec} />
              </TooltipContent>
            </Tooltip>
          )}
          {action && (
            <button
              aria-label={action.label}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line text-fg-subtle transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink ${FOCUS}`}
              onClick={(e) => { stop(e); action.onClick(e); }}
              title={action.label}
              type="button"
            >
              {ActionIcon ? <ActionIcon className="h-4 w-4 shrink-0" strokeWidth={2} /> : null}
            </button>
          )}
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tone.tile}`}>
            <Icon className="h-4 w-4 shrink-0" strokeWidth={2} />
          </span>
        </div>
      </div>

      {/* The value takes the space between header and footer and sits centred
          in it, so the whitespace around the number is the same on every card. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center">
        {children ?? <KpiValue kpi={kpi} />}
      </div>

      <KpiFoot kpi={kpi} />
    </>
  );

  if (to) {
    return (
      <Link
        aria-label={goesTo ? `${kpi.label} — open ${goesTo}` : `${kpi.label} — open details`}
        className={`${cls} ${HOVER}`}
        to={to}
      >
        {body}
      </Link>
    );
  }

  if (onClick) {
    // A div with role="button" rather than a <button>, because a card may
    // nest its own controls (the ⓘ, an action, a name that opens a profile).
    return (
      <div
        aria-pressed={active}
        className={`${cls} cursor-pointer ${HOVER}`}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onClick();
        }}
        role="button"
        tabIndex={0}
        title={title}
      >
        {body}
      </div>
    );
  }

  return <div className={cls} title={title}>{body}</div>;
}

/**
 * The grid alone, for pages that compose their own <KpiCard>s (custom values,
 * quick-filter cards). `count` is the number of cards inside.
 */
export function KpiRow({ count, className = '', children }) {
  return <div className={`${gridCls(count)} ${className}`}>{children}</div>;
}

/**
 * The band. `cards` is the page's KPIs in reading order; `icons` and `links`
 * are keyed by card key, `linkLabels` names each destination for the ⓘ.
 * Cards without a link render static. Pass `className` for the page's own
 * vertical spacing (e.g. "mb-4") — never to change the grid.
 */
export default function KpiBand({
  cards = [], icons = {}, links = {}, linkLabels = {},
  fallbackLink, loading = false, className = '',
}) {
  if (loading) {
    return (
      <KpiRow className={className} count={cards.length}>
        {cards.map((c) => <KpiCardSkeleton key={c.key} />)}
      </KpiRow>
    );
  }
  return (
    <KpiRow className={className} count={cards.length}>
      {cards.map((kpi) => (
        <KpiCard
          goesTo={linkLabels[kpi.key]}
          icon={icons[kpi.key]}
          key={kpi.key}
          kpi={kpi}
          onClick={kpi.onClick}
          title={kpi.title}
          to={links[kpi.key] || fallbackLink}
        />
      ))}
    </KpiRow>
  );
}
