import { Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';

/**
 * Empty, error and loading states — the three screens every page eventually
 * needs and every page used to invent for itself.
 *
 * "No cameras" alone appeared as `text-sm font-medium text-neutral-500`,
 * `text-sm font-bold text-slate-800`, `text-sm font-bold text-slate-700` and
 * `text-base font-semibold text-neutral-900`, and failures split between red
 * and rose. Semantically these are three fixed things: nothing here (neutral),
 * something broke (danger), working on it (neutral). Now they look it.
 */

/** Brand-coloured spinner. The only spinner in the product. */
export function Spinner({ className, size = 'md' }) {
  return (
    <Loader2
      className={cn(
        'animate-spin text-brand',
        size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-8 w-8' : 'h-5 w-5',
        className,
      )}
      strokeWidth={2.25}
      aria-hidden
    />
  );
}

/** Inline "working on it". Use inside a panel that already has its frame. */
export function LoadingState({ message = 'Loading…', className, size = 'md' }) {
  return (
    <div
      role="status"
      className={cn('flex flex-col items-center justify-center gap-3 px-6 py-10 text-center', className)}
    >
      <Spinner size={size} />
      {message && <p className="text-small text-fg-muted">{message}</p>}
    </div>
  );
}

/**
 * Nothing to show — and that is fine. Neutral, never red: an empty watchlist
 * is not a fault, and colouring it like one trains operators to ignore red.
 */
export function EmptyState({ icon: Icon, title, description, action, className, children }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {Icon && (
        <span className="mb-1 grid h-11 w-11 place-items-center rounded-xl bg-surface-muted text-fg-subtle">
          <Icon className="h-5 w-5" strokeWidth={1.9} />
        </span>
      )}
      {title && <p className="text-heading text-fg">{title}</p>}
      {description && <p className="max-w-[46ch] text-small text-fg-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
      {children}
    </div>
  );
}

/**
 * Something failed. Danger tone, and always offers the retry — a dead end with
 * no way forward is the most common complaint about error screens.
 */
export function ErrorState({
  icon: Icon = TriangleAlert,
  title = 'Something went wrong',
  description,
  onRetry,
  retryLabel = 'Try again',
  className,
  children,
}) {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}
    >
      <span className={cn('mb-1 grid h-11 w-11 place-items-center rounded-xl', toneClass('danger', 'soft'))}>
        <Icon className="h-5 w-5" strokeWidth={1.9} />
      </span>
      <p className="text-heading text-fg">{title}</p>
      {description && <p className="max-w-[46ch] text-small text-fg-muted">{description}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-control text-white transition hover:bg-brand-hover"
        >
          {retryLabel}
        </button>
      )}
      {children}
    </div>
  );
}

/**
 * The compact inline variant — a strip inside a card that failed while the
 * rest of the page is fine. Same tone, so it reads as the same kind of event.
 */
export function InlineError({ message, onRetry, retryLabel = 'Retry', className }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-small',
        toneClass('danger', 'soft'),
        className,
      )}
    >
      <TriangleAlert className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
