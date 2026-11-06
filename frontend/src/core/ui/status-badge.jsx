import { cn } from '@/core/lib/utils';
import { STATUS_LABEL, toneClass, toneForStatus } from '@/core/ui/tone';

/**
 * The status pill, for the whole product.
 *
 * This replaces twenty-one hand-rolled `Chip` / `Pill` / `StatusBadge`
 * components that had each picked their own padding, radius, case, font size
 * and green. "Online" now looks the same in Camera Setup, on the Home
 * dashboard, in Live View and on the Health page because there is only one of
 * it.
 *
 *   <StatusBadge status="online" />                 label from the vocabulary
 *   <StatusBadge status="live" pulse />             animated dot for live feeds
 *   <StatusBadge status={cam.status} size="sm" />   dense tables and tiles
 *   <StatusBadge tone="ai">Face match</StatusBadge> non-state category chip
 *
 * `tone` is an escape hatch for chips that are categories rather than states
 * (an AI class, a severity level). Prefer `status` — it keeps the meaning in
 * one place.
 */
export function StatusBadge({
  status,
  tone,
  children,
  label,
  dot = true,
  pulse = false,
  size = 'md',
  className,
  ...props
}) {
  const resolved = tone || toneForStatus(status);
  const text =
    children ??
    label ??
    STATUS_LABEL[String(status || '').toLowerCase()] ??
    status ??
    '';

  return (
    <span
      data-slot="status-badge"
      data-status={status}
      data-tone={resolved}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold',
        size === 'sm' ? 'px-2 py-0.5 text-caption' : 'px-2.5 py-1 text-small',
        toneClass(resolved, 'soft'),
        className,
      )}
      {...props}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          {pulse && (
            <span
              className={cn(
                'absolute inline-flex h-full w-full animate-ping rounded-full opacity-70',
                toneClass(resolved, 'dot'),
              )}
              aria-hidden
            />
          )}
          <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', toneClass(resolved, 'dot'))} />
        </span>
      )}
      {text}
    </span>
  );
}

/**
 * Just the coloured dot — for table rows and camera tiles where the label
 * would be redundant. Same tone vocabulary, so it always agrees with the
 * badge next to it.
 */
export function StatusDot({ status, tone, pulse = false, className, title }) {
  const resolved = tone || toneForStatus(status);
  return (
    <span
      className={cn('relative flex h-2 w-2 shrink-0', className)}
      title={title ?? STATUS_LABEL[String(status || '').toLowerCase()] ?? status}
    >
      {pulse && (
        <span
          className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-70', toneClass(resolved, 'dot'))}
          aria-hidden
        />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', toneClass(resolved, 'dot'))} />
    </span>
  );
}

export default StatusBadge;
