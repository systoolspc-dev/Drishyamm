import { ChevronDown, RefreshCw } from 'lucide-react';
import UseCaseSwitcher from './UseCaseSwitcher';
import PolicyTip from './PolicyTip';

// ─────────────────────────────────────────────────────────────────────────────
// Activity Monitoring toolbar — the one header every vertical wears.
//
// Extracted from dashboard/ActivityDashboard.jsx, which is the reference. Five
// verticals (bank, campus, school, hostel, hospitality) each had their own
// header component with an IDENTICAL prop signature and a different band: an
// inline `mb-4` row inside the page inset rather than a sticky full-bleed band.
// That meant the KPI row sat at a different height per vertical and anything
// that grew in the header shoved the cards instead of pushing the whole block.
//
// WHAT THIS OWNS, AND WHY IT IS NOT CONFIGURABLE
//   · The band          — sticky to the top of the scroll container, full-bleed,
//                         with its own inset so the blur reaches the page
//                         gutters rather than stopping at the content edge.
//   · The title         — always "Activity Monitoring". The vertical says which
//                         vertical it is in the CONTEXT LINE, never in the h1:
//                         six pages with six different headings read as six
//                         different features.
//   · The icon tile     — 40px, brand-soft with a brand line. The vertical
//                         picks the glyph; it does not pick the tile.
//   · PolicyTip         — appended to the context line automatically. It reads
//                         the active vertical's params and renders nothing when
//                         that vertical has no thresholds, so a vertical gets
//                         it for free and cannot forget it.
//   · UseCaseSwitcher   — first in the action cluster, because it is a control,
//                         not a heading.
//
// WHAT THE VERTICAL SUPPLIES
//   context  the sentence after the title: scope · clock · shift. Compose it
//            from the exports below so the separators and the live dot match.
//            OMIT a segment you have no honest value for — a vertical with no
//            roster must not render "Outside shift hours" just to fill the slot.
//   actions  buttons after the switcher. Exactly ONE filled brand button per
//            page (Refresh, via ToolbarRefresh); everything else is TOOLBAR_BTN
//            outline, so the filled one still reads as the primary.
//   desktopStatic
//            which element scrolls on laptop+. The retail dashboard is a flex
//            column that scrolls its BODY, so its band must go `static` at lg
//            or it would stick to a container that never moves and eat a row of
//            height. The verticals that let the PAGE scroll need it to stay
//            sticky at every width. Wrong value is not a cosmetic slip — it is
//            the difference between a header that follows the cards and one that
//            scrolls away — so it is an explicit flag, not a default to guess.
// ─────────────────────────────────────────────────────────────────────────────

// The secondary action. Outline, never filled — see the action-cluster note.
export const TOOLBAR_BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken';

/** The `·` between context segments. Decorative, so it is hidden from AT. */
export function ToolbarSep() {
  return <span className="text-fg-disabled" aria-hidden>·</span>;
}

/**
 * The page's SCOPE — which store, branch, campus, block. This is the one thing
 * on the page a viewer chooses, and it is styled as part of the sentence rather
 * than as a form control: a bordered select here reads as a filter, and an
 * operator then expects the cards below to be filtered by everything in the
 * band. With fewer than two options there is nothing to choose, so it renders
 * as plain text instead of a select with a single item.
 */
export function ToolbarScope({ value, onChange, options = [], label }) {
  if (options.length < 2) {
    const only = options[0];
    if (!only) return null;
    return <span className="font-semibold text-fg-secondary">{only.label}</span>;
  }
  return (
    <span className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="cursor-pointer appearance-none rounded bg-transparent py-0.5 pr-4 text-small font-semibold text-fg-secondary transition hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-fg-subtle" aria-hidden />
    </span>
  );
}

/**
 * The live pulse — the "now" every number below agrees with. Pass the clock or
 * the last-updated stamp as children; the dot is the shared part.
 */
export function ToolbarLive({ children }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="relative flex h-1.5 w-1.5" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
      </span>
      {children}
    </span>
  );
}

/** The single filled button. One per page — see the action-cluster note. */
export function ToolbarRefresh({ busy = false, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      type="button"
      className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-60"
    >
      <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Refresh
    </button>
  );
}

export default function ActivityToolbar({
  icon: Icon,
  title = 'Staff activity',
  context = null,
  actions = null,
  desktopStatic = false,
}) {
  return (
    <div className={`sticky top-0 z-10 shrink-0 border-b border-line bg-surface-sunken/85 backdrop-blur-sm ${desktopStatic ? 'lg:static' : ''}`}>
      <div className="w-full page-inset-x py-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          {Icon ? (
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
              <Icon className="h-5 w-5" />
            </div>
          ) : null}

          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">{title}</h1>

            {/* Context line: scope · clock · shift · policy. Everything here is
                either the one choice the viewer makes (scope) or a fact the page
                derives — no control that silently filters below. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-fg-muted">
              {context}
              <PolicyTip />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <UseCaseSwitcher />
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
}
