import * as React from "react"
import { cva } from "class-variance-authority";
import { Slot } from "radix-ui"

import { cn } from "@/core/lib/utils"

// Generic label chip. For anything that communicates DEVICE OR SYSTEM STATE
// (online, degraded, offline, live) use <StatusBadge> from
// core/ui/status-badge.jsx instead — it owns the semantic colour mapping so
// the same state cannot be drawn two different ways on two different pages.
const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border border-transparent px-2 py-0.5 text-caption font-semibold w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-danger transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default: "bg-brand text-white [a&]:hover:bg-brand-hover",
        secondary:
          "bg-surface-muted text-fg-secondary [a&]:hover:bg-surface-muted/80",
        destructive:
          "bg-danger text-white [a&]:hover:bg-danger/90 focus-visible:ring-danger/20 dark:focus-visible:ring-danger/40 dark:bg-danger/60",
        outline:
          "border-line text-fg [a&]:hover:bg-surface-muted",
        ghost: "[a&]:hover:bg-surface-muted [a&]:hover:text-fg",
        link: "text-brand-ink underline-offset-4 [a&]:hover:underline",
        // Semantic tones, so a category chip can borrow the status palette
        // without hand-writing the three classes every time.
        success: "bg-success-soft text-success-ink border-success-line",
        warning: "bg-warning-soft text-warning-ink border-warning-line",
        danger: "bg-danger-soft text-danger-ink border-danger-line",
        info: "bg-info-soft text-info-ink border-info-line",
        ai: "bg-ai-soft text-ai-ink border-ai-line",
        neutral: "bg-neutral-soft text-neutral-ink border-neutral-line",
        brand: "bg-brand-soft text-brand-ink border-brand-line",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props} />
  );
}

export { Badge, badgeVariants }
