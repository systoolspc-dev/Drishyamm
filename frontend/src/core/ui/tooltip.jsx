import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/core/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}) {
  return (<TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />);
}

function Tooltip({
  ...props
}) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  ...props
}) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/**
 * Every tooltip in the app is the same light card with a brand border and
 * brand ink text, in both themes — see the --tooltip-* tokens for why it does
 * not flip. One colour everywhere, whether the tooltip holds two words or two
 * sentences, so no tooltip reads as a different kind of thing from another.
 *
 * The variants differ only in weight: `default` is a short label ("Home",
 * "Collapse sidebar") and sets it semibold; `card` carries a sentence and
 * leaves it at normal weight, which is easier to read at that length.
 *
 * `sideOffset` defaults to 8 so the card always clears the trigger — and with
 * it the cursor — instead of opening under the pointer.
 */
function TooltipContent({
  className,
  sideOffset = 8,
  variant = "default",
  children,
  ...props
}) {
  const card = variant === "card";
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-variant={variant}
        sideOffset={sideOffset}
        className={cn(
          "bg-tooltip text-tooltip-ink border border-tooltip-line shadow-[var(--tooltip-shadow)] backdrop-blur-md",
          card ? "" : "font-semibold",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-small text-balance",
          className
        )}
        {...props}>
        {children}
        {/* The arrow is a rotated square, so it needs the border on the two
            sides that end up facing out — otherwise the card is outlined and
            its point is not. */}
        <TooltipPrimitive.Arrow
          className="bg-tooltip fill-tooltip border-tooltip-line z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] border-b border-r" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
