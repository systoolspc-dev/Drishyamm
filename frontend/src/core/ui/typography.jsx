import { cn } from '@/core/lib/utils';

/**
 * Typography components for pages that don't sit inside the Operations frame
 * (core/layout/OperationsPage.jsx already supplies these for Camera Setup,
 * Health, Live View, Playback and Map).
 *
 * These are thin — they set a level and nothing else. The point is that
 * "page title" resolves to ONE answer. It used to resolve to nine:
 * text-2xl/slate-950, text-2xl/slate-900, text-xl/neutral-900, text-[26px],
 * text-[32px], text-[24px], text-[22px], text-[20px], text-3xl.
 *
 * Everything still accepts `className`, because a page occasionally has a real
 * reason to differ. Reach for that rarely and deliberately.
 */

/** The one page title. 20/25/700. */
export function PageTitle({ as: Tag = 'h1', className, children, ...props }) {
  return (
    <Tag className={cn('text-title text-fg', className)} {...props}>
      {children}
    </Tag>
  );
}

/** The sentence under a page title. 13/18/400. */
export function PageDescription({ className, children, ...props }) {
  return (
    <p className={cn('max-w-[68ch] text-body text-fg-muted', className)} {...props}>
      {children}
    </p>
  );
}

/**
 * Page header for non-Operations pages: title, description, and the page's own
 * actions on the right. Matches the Operations frame's header proportions so
 * moving between the two doesn't feel like changing products.
 */
/**
 * `size="lg"` (default) is a full page's own title — 20px, used once per page.
 * `size="md"` is for a header INSIDE an already-headed page (a module tab's
 * own "Sites" / "Devices" header sitting under the module's own "Camera
 * Setup" header) — same icon-container treatment, one step down in title
 * size (18px) so the two headers don't compete at the same weight.
 */
export function PageHeading({ icon: Icon, title, description, actions, size = 'lg', className, children }) {
  const boxSize = size === 'md' ? 'h-9 w-9' : 'h-10 w-10';
  const iconSize = size === 'md' ? 'h-4 w-4' : 'h-5 w-5';
  return (
    <header className={cn('flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className={cn('grid shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand', boxSize)}>
            <Icon className={iconSize} strokeWidth={2} />
          </span>
        )}
        <div className="min-w-0">
          {size === 'md' ? (
            <SectionHeading className="truncate">{title}</SectionHeading>
          ) : (
            <PageTitle className="truncate">{title}</PageTitle>
          )}
          {description && <PageDescription className="mt-1">{description}</PageDescription>}
          {children}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">{actions}</div>}
    </header>
  );
}

/** Section heading inside a page. 18/24/600. */
export function SectionHeading({ as: Tag = 'h2', className, children, ...props }) {
  return (
    <Tag className={cn('text-section text-fg', className)} {...props}>
      {children}
    </Tag>
  );
}

/**
 * Section header with the optional right-hand slot most panels need
 * ("View all", a filter, a count).
 */
export function SectionHeader({ icon: Icon, title, description, actions, className }) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-fg-muted" strokeWidth={2} />}
        <div className="min-w-0">
          <SectionHeading className="truncate">{title}</SectionHeading>
          {description && <p className="mt-0.5 text-small text-fg-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Card / panel heading. 15/20/600. The most common heading in the product. */
export function CardHeading({ as: Tag = 'h3', className, children, ...props }) {
  return (
    <Tag className={cn('text-heading text-fg', className)} {...props}>
      {children}
    </Tag>
  );
}

/**
 * Uppercase eyebrow label — sidebar group headers, table overlines, the small
 * caps above a value. 10/13/600 with tracking, which is what makes 10px
 * uppercase legible at all.
 */
export function Overline({ as: Tag = 'span', className, children, ...props }) {
  return (
    <Tag className={cn('text-micro uppercase text-fg-subtle', className)} {...props}>
      {children}
    </Tag>
  );
}

/** Form field label. 12/16/500. */
export function FieldLabel({ className, children, ...props }) {
  return (
    <label className={cn('text-small font-medium text-fg-secondary', className)} {...props}>
      {children}
    </label>
  );
}

/** Helper text under a field. */
export function FieldHint({ className, children, ...props }) {
  return (
    <p className={cn('text-caption text-fg-subtle', className)} {...props}>
      {children}
    </p>
  );
}

/** Validation message under a field. Danger tone, always. */
export function FieldError({ className, children, ...props }) {
  return (
    <p className={cn('text-caption font-medium text-danger-ink', className)} {...props}>
      {children}
    </p>
  );
}

/**
 * In-product link — "View all", "Open camera health", "Retry".
 * Brand ink so links are recognisable as links without being blue in an app
 * where blue already means "information".
 */
export function TextLink({ as: Tag = 'a', className, children, ...props }) {
  return (
    <Tag
      className={cn(
        'font-semibold text-brand-ink underline-offset-2 transition hover:underline focus-visible:underline focus-visible:outline-none',
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
}
