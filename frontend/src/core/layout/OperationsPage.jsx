import { AlertTriangle } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { HeaderInfo } from '@/core/ui/header-info';

/**
 * Shared outer shell for the Operations pages — Camera Setup, Camera Health,
 * Live View, Playback and Map.
 *
 * Each of those pages had hand-rolled its own frame, and the values had
 * drifted: header padding ranged from `px-2 py-3` to `px-5 py-4`, titles from
 * 16px bold to 24px bold, title icons from a 36px slate square to a 48px
 * orange tile to a 6px accent bar, and page height from `h-[calc(100vh-4rem)]`
 * to an inline `calc(100vh - 64px)`. Navigating between them felt like
 * changing applications.
 *
 * The rule now: pages own their CONTENT, this file owns the FRAME. A page
 * composes
 *
 *   <OperationsPage>
 *     <PageHeader icon={…} title="…" description="…" actions={…} context={…} />
 *     <PageContent>…anything…</PageContent>
 *   </OperationsPage>
 *
 * and inherits the shared width, padding, vertical rhythm and typography. No
 * Operations page should set its own outer margin, padding, max-width or
 * viewport height — change them here and every page follows.
 */

// ── Frame tokens ────────────────────────────────────────────────────────────
// Every value on the 4px scale. Edit here, not in the pages.
const PAGE_HEIGHT  = 'h-[calc(var(--app-vh)-var(--topbar-h))]';   // topbar height lives in index.css
const PAGE_SURFACE = 'bg-surface-app text-fg';
// Full width, no centred cap. This used to be `mx-auto max-w-[1600px]`, which
// left 26px of dead space each side at 1920 and ~300px at 2560 - on pages whose
// content is a camera grid, a timeline or a wide table, that is width thrown
// away, not a reading measure. The inset below is the only left/right gutter.
const PAGE_WIDTH   = 'w-full';
const PAGE_RHYTHM  = 'gap-5';                             // header → content

// The left/right content edge. It is no longer spelled out here: `page-inset`
// (index.css) is the product-wide gutter, so Operations pages, the vertical
// dashboards, Settings and the AI-analytics scope all sit on the same content
// edge and moving between any two of them does not shift it. There is no
// per-page variant, because a page that insets itself differently is exactly
// the drift this file exists to prevent.
const PAGE_INSET = 'page-inset';

/**
 * Full-height page frame. One horizontal inset for the header and the content.
 *
 * `bleed` drops the inset so the content runs edge to edge. It is for a page
 * that is all video and has no header (Live View), not a per-page gutter.
 */
export function OperationsPage({ children, className, bleed = false }) {
  return (
    <div className={cn('flex w-full min-h-0 flex-col overflow-hidden', PAGE_HEIGHT, PAGE_SURFACE)}>
      <div className={cn('flex min-h-0 flex-1 flex-col', PAGE_WIDTH, !bleed && PAGE_INSET, PAGE_RHYTHM, className)}>
        {children}
      </div>
    </div>
  );
}

/**
 * Title icon. The SVG stays page-specific (a camera for Camera Setup, a shield
 * for Health, a map pin for Map); only the container is standardised — 40px
 * rounded tile in the brand orange, so the icons read as one family.
 */
export function PageIcon({ icon: Icon }) {
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
      <Icon className="h-5 w-5" strokeWidth={2} />
    </span>
  );
}

/**
 * Page header: icon + title + description on the left, page-specific actions
 * (tabs, buttons, filters) on the right, optional context line underneath.
 *
 * `descriptionAs="tooltip"` moves the description off the page and onto an
 * info affordance beside the title. Same words, none of the vertical space —
 * for pages whose blurb is read once and then only takes up room. Opt-in, so
 * every other page keeps its visible paragraph.
 *
 * `tagline` pairs with that: a short line under the title on wide screens,
 * dropped below `md`. The long description stays in the tooltip either way.
 */
export function PageHeader({ icon, title, description, descriptionAs, tagline, actions, context }) {
  // Derived, not a prop: pages opt in with `descriptionAs="tooltip"`, and the
  // long description then renders in the info popover instead of as a
  // paragraph. Any other value keeps the visible paragraph.
  const asTooltip = descriptionAs === 'tooltip';
  // A title with nothing under it is one line: centre it on the icon tile and
  // centre the action row on the header, so title, tile and buttons share one
  // midline. With a visible paragraph the block is taller, and top-aligning
  // keeps the title level with the tile and the actions.
  const singleLine = !(description && !asTooltip) && !tagline;

  return (
    <header className="shrink-0">
      <div className={cn('flex flex-col gap-3 xl:flex-row xl:justify-between', singleLine ? 'xl:items-center' : 'xl:items-start')}>
        <div className={cn('flex min-w-0 gap-3', singleLine ? 'items-center' : 'items-start')}>
          <PageIcon icon={icon} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <h1 className="truncate text-xl font-bold leading-tight tracking-tight text-fg">
                {title}
              </h1>
              {/* The same affordance Face Learning and Attendance
                  Report use — one component, so the icon, the
                  click-to-pin behaviour and the popover styling cannot drift
                  between the pages that show a description this way. */}
              {asTooltip ? <HeaderInfo text={description} label={title} /> : null}
            </div>
            {description && !asTooltip ? (
              <p className="mt-1 max-w-[68ch] text-xs font-normal text-fg-muted">{description}</p>
            ) : null}

            {/* A one-line orientation note for pages whose full description
                lives behind the info icon. Hidden below `md`, where the
                vertical space is worth more than the sentence and the icon
                still carries the same words. */}
            {tagline ? (
              <p className="mt-1 hidden max-w-[68ch] text-xs font-normal text-fg-muted md:block">{tagline}</p>
            ) : null}
          </div>
        </div>

        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">{actions}</div>
        ) : null}
      </div>

      {context ? <div className="mt-3">{context}</div> : null}
    </header>
  );
}

/**
 * The context line under the header. Pages choose the words and
 * the icon; size, colour, separator and spacing are fixed here.
 */
export function PageContext({ icon: Icon, label, detail, children }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-small font-medium text-fg-muted">
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.25} /> : null}
      {label ? <span className="shrink-0 font-semibold text-fg-secondary">{label}</span> : null}
      {detail ? (
        <>
          <span className="shrink-0 text-fg-disabled">/</span>
          <span className="hidden truncate sm:inline">{detail}</span>
        </>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Content region. Fills the rest of the frame; `scroll` picks between a page
 * that scrolls its content (tables, forms) and one that fits the viewport and
 * manages its own panes (map, video wall).
 */
export function PageContent({ children, scroll = false, className }) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', scroll ? 'overflow-auto' : 'overflow-hidden', className)}>
      {children}
    </div>
  );
}

/**
 * Shared outer card treatment. Internal card layouts stay page-specific — this
 * only fixes the border, radius, shadow and surface so panels across pages
 * read as the same material.
 */
export function PageCard({ children, className, as: Tag = 'section' }) {
  return (
    <Tag className={cn('rounded-xl border border-line bg-surface shadow-sm', className)}>
      {children}
    </Tag>
  );
}

/**
 * The segmented tab control Camera Setup and Playback both had, with the two
 * copies' drift (font-medium vs font-semibold, different tracking) resolved.
 *
 * The selected tab is a TINTED segment -- soft brand fill, brand ink, a brand
 * hairline -- rather than the solid brand block it used to be. Two reasons.
 * A tab bar sits in the header action row beside Refresh and the other page
 * actions, and a saturated fill there competed with the page's actual primary
 * buttons for the eye. And it now matches the affordance the rest of the app
 * already uses for "this one is on" (tooltips, the vertical switcher, the
 * active room card), so selection reads the same wherever it appears.
 *
 * Inactive tabs carry a transparent border so selecting one does not shift the
 * row by the width of the hairline.
 */
export function PageTabs({ tabs, active, onChange }) {
  return (
    // `max-w-full` caps the strip at the header's width so `overflow-x-auto`
    // can engage on phones instead of the tabs running off-screen.
    <div className="flex max-w-full shrink-0 items-center gap-1.5 self-start overflow-x-auto rounded-lg border border-line bg-surface-sunken p-1">
      {tabs.map(({ id, label, Icon }) => {
        const selected = active === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-small transition',
              selected
                ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink'
                : 'border-transparent font-medium text-fg-muted hover:bg-surface/70 hover:text-fg',
            )}
          >
            {Icon ? <Icon className={cn('h-3.5 w-3.5', selected && 'text-brand')} strokeWidth={selected ? 2.25 : 1.85} /> : null}
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Full-width section switcher for a page whose content is split into tabs —
 * Camera Setup's Sites / Devices / Cameras / AI Detection. It is the shared
 * Tabs "line" variant (core/ui/tabs.jsx) drawn as plain buttons: h-9
 * triggers, px-2, nav text, a 2px brand bar under the active one.
 *
 * It sits UNDER the page title, not in the action row. A tab bar in the
 * action row read as a toolbar, and the tab pages then drew their own second
 * heading to say which section was open. Here the strip IS the section
 * heading, so a tab page renders no title of its own — it opens straight on
 * its toolbar row.
 *
 * `count` on a tab is optional; it shows as a pill so the size of each
 * section is visible before it is opened.
 */
export function PageTabStrip({ tabs, active, onChange, className }) {
  return (
    // overflow-x-auto alone turns vertical overflow to auto as well, and the
    // active bar overlapping a real border showed as a 1px vertical scrollbar.
    // So: vertical overflow clipped, the bottom line drawn as an inset shadow
    // (inside the box), and the bar painted over it at bottom-0.
    <nav
      className={cn('flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--line)]', className)}
      aria-label="Sections"
    >
      {tabs.map(({ id, label, Icon, count }) => {
        const selected = active === id;
        return (
          <button
            key={id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onChange(id)}
            className={cn(
              'relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md px-2 text-nav transition-colors',
              'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-brand after:opacity-0 after:transition-opacity',
              selected ? 'font-semibold text-fg after:opacity-100' : 'text-fg-muted hover:text-fg',
            )}
          >
            {Icon ? (
              <Icon className={cn('h-4 w-4', selected ? 'text-brand' : 'text-fg-subtle')} strokeWidth={selected ? 2.25 : 2} />
            ) : null}
            {label}
            {count != null ? (
              <span
                className={cn(
                  'rounded-full px-1.5 text-caption font-semibold tabular-nums',
                  selected ? 'bg-brand-soft text-brand-ink' : 'bg-surface-muted text-fg-subtle',
                )}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * The one toolbar row a tab page owns: search and filters on the left,
 * Refresh and the primary action on the right, in the same place on every
 * tab. Wraps on narrow screens.
 */
export function PageToolbar({ children, actions, className }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {children}
      {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * The one line a setup tab shows when something needs attention — offline
 * cameras, AI selected but not running, cameras not linked to a site.
 *
 * Renders nothing when `items` is empty, so a healthy fleet opens straight
 * on its list. Each item is a link that applies the matching filter or jumps
 * to the tab where the fix happens.
 *
 * This replaced a four-card KPI row on every tab. Fleet size already lives
 * in the tab strip and on Home, and health lives on Camera Health; a setup
 * page only has to say what is wrong, not how big the fleet is. The row
 * repeated the same three numbers on three tabs and cost ~120px before the
 * thing the operator came to edit.
 */
export function PageAttention({ items, className }) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border border-warning-line bg-warning-soft px-4 py-2.5 text-small font-medium text-warning-ink',
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2} />
      <span className="font-semibold">Needs attention</span>
      {list.map((item) => (
        <span key={item.key || item.label} className="inline-flex items-center gap-1.5">
          <span className="text-warning-ink/50" aria-hidden>·</span>
          {item.onClick ? (
            <button
              type="button"
              onClick={item.onClick}
              className="rounded-sm underline-offset-4 hover:underline focus-visible:underline"
            >
              {item.label}
            </button>
          ) : (
            <span>{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Header action button. Gives the per-page controls (Refresh, Auto refresh,
 * filters) one height and one visual weight across pages.
 */
export function PageAction({ children, className, as: Tag = 'button', ...props }) {
  return (
    <Tag
      className={cn(
        'inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}
