import { Fragment, forwardRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';

// ─────────────────────────────────────────────────────────────────────────────
// Clean surface, rich hover. A table cell shows one thing; everything else we
// know about that thing — camera ids, zone codes, shift windows, timestamps,
// limits — lives one hover (or keyboard focus) away in a small key/value card,
// instead of being deleted or crammed under the value.
//
//   <MetaHover title="Billing Counter A" rows={[['Zone ID', 'BILL-A'], …]}>
//     <HoverText>Billing Counter A</HoverText>
//   </MetaHover>
//
// Rows whose value is null / '' are dropped, so a card never shows a field the
// data doesn't have — it lists what is known, and nothing is made up to fill
// a slot. `delayDuration` 200ms: long enough not to flicker while the pointer
// crosses a table, short enough to feel immediate once it rests.
//
// The trigger must be focusable so keyboard users get the same card: buttons
// and links already are; plain text goes in <HoverText>, a focusable span.
// ─────────────────────────────────────────────────────────────────────────────

export function MetaHover({ title, rows = [], note, side = 'top', align = 'start', children }) {
  const items = rows.filter((r) => r && r[1] != null && r[1] !== '');
  if (!title && !items.length && !note) return children;
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent variant="card" side={side} align={align} className="max-w-[20rem] px-3 py-2.5 text-left text-pretty">
        {title && <p className="mb-1.5 text-xs font-semibold">{title}</p>}
        {items.length > 0 && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {items.map(([k, v]) => (
              <Fragment key={k}>
                <dt className="whitespace-nowrap opacity-70">{k}</dt>
                <dd className="font-medium tabular-nums">{v}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {note && <p className={`text-xs ${items.length || title ? 'mt-2 border-t border-tooltip-line pt-1.5' : ''}`}>{note}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Plain text that can carry a MetaHover: focusable, with a dotted underline
 * that appears only on hover / focus — the surface stays clean, and the cue
 * shows the moment the pointer asks.
 */
export const HoverText = forwardRef(function HoverText({ className = '', children, ...props }, ref) {
  return (
    <span
      ref={ref}
      tabIndex={0}
      className={`cursor-help rounded-sm decoration-line-strong decoration-dotted underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-brand/30 ${className}`}
      {...props}
    >
      {children}
    </span>
  );
});
