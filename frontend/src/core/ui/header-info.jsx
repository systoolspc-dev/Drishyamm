import { useState } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { useMediaQuery, BELOW_SM } from '@/core/hooks/useMediaQuery';

/**
 * The info affordance that stands in for a page description once the viewport
 * is too narrow to spend vertical space on a paragraph. Same words, none of
 * the height.
 *
 * Hover opens it; click pins it open. The pin matters on touch, where there is
 * no hover at all and a tooltip that only responds to a pointer is simply
 * unreachable — and on desktop it lets someone move the mouse into a long
 * blurb without it vanishing.
 *
 * `side="right"` keeps the card clear of the cursor and of the title below it;
 * Radix flips it automatically when there is no room. The button stays 24px so
 * it never outweighs the title next to it, but `before:-inset-2` widens the hit
 * area to ~40px for thumbs without changing what is drawn.
 */
export function HeaderInfo({
  text,
  label,
  side = 'right',
  sideOffset = 12,
  // Some triggers are a "?" rather than an "i" — search tips as opposed to a
  // page description. Only the glyph changes; the popover is the same.
  icon: Icon = Info,
  className = '',
  // Defaults to "About <label>"; overridden where the trigger is not a page
  // description, e.g. the search-tips "?".
  ariaLabel,
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  // On a phone neither flank has room for the card: the icon sits near the left
  // edge, so Radix reports ~200px available either side of it and a wider card
  // gets placed off-screen. `bottom` is the only side with the full width, and
  // the pointer-obstruction that motivates `right` does not exist on touch.
  const narrow = useMediaQuery(BELOW_SM);

  return (
    <Tooltip open={pinned || hovered} onOpenChange={setHovered}>
      <TooltipTrigger asChild>
        <button
          aria-expanded={pinned}
          aria-label={ariaLabel || (label ? `About ${label}` : 'More information')}
          className={`relative grid h-6 w-6 shrink-0 place-items-center rounded-full transition before:absolute before:-inset-2 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
            pinned
              ? 'bg-brand text-white'
              : 'bg-brand-soft text-brand hover:bg-brand/20 hover:shadow-[0_0_8px_-1px_var(--tooltip-glow)]'
          } ${className}`}
          onClick={() => setPinned((v) => !v)}
          type="button"
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        // Radix publishes how much room the chosen side actually has; capping
        // to it means the card can never be placed wider than it fits, whatever
        // the anchor's position turns out to be.
        className="max-w-[min(20rem,var(--radix-tooltip-content-available-width))] text-sm leading-relaxed"
        collisionPadding={12}
        onPointerDownOutside={() => setPinned(false)}
        align={narrow ? 'start' : 'center'}
        side={narrow ? 'bottom' : side}
        sideOffset={sideOffset}
        variant="card"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export default HeaderInfo;
