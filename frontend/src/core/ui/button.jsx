import * as React from "react"
import { cva } from "class-variance-authority";
import { Slot } from "radix-ui"

import { cn } from "@/core/lib/utils"

// Button typography is fixed by the design system: 14/20/600 (`text-control`)
// for every size except `xs`, which steps down to 12/600 so it can sit inside
// a table row. Pages had been shipping 12px, 13px, 14px and 16px buttons side
// by side; the size variants below are the only sanctioned steps.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-control font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-danger",
  {
    variants: {
      variant: {
        default: "bg-brand text-white hover:bg-brand-hover",
        destructive:
          "bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger/20 dark:focus-visible:ring-danger/40 dark:bg-danger/60",
        outline:
          "border border-line bg-surface text-fg-secondary shadow-xs hover:bg-surface-sunken hover:text-fg dark:hover:bg-surface-muted",
        secondary:
          "bg-surface-muted text-fg hover:bg-surface-muted/80",
        ghost:
          "text-fg-secondary hover:bg-surface-muted hover:text-fg",
        link: "text-brand-ink underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-small font-semibold has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props} />
  );
}

export { Button, buttonVariants }
