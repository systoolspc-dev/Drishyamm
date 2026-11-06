import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "@/core/lib/utils"

// A panel that slides in from an edge. Built on the same Radix Dialog the
// modal uses, so it inherits focus trapping, Escape-to-close, scroll locking
// and `aria-modal` for free — the parts a hand-rolled drawer usually misses.
function Sheet({ ...props }) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props} />
  );
}

const SIDES = {
  left:  "inset-y-0 left-0 h-full w-[272px] max-w-[calc(var(--app-vw)*0.85)] border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
  right: "inset-y-0 right-0 h-full w-[272px] max-w-[calc(var(--app-vw)*0.85)] border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
  top:   "inset-x-0 top-0 w-full border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top",
  bottom:"inset-x-0 bottom-0 w-full border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
};

function SheetContent({
  className,
  children,
  side = "left",
  showCloseButton = true,
  overlayClassName,
  ...props
}) {
  return (
    <SheetPortal data-slot="sheet-portal">
      <SheetOverlay className={overlayClassName} />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "bg-background border-line data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col shadow-xl transition ease-in-out data-[state=closed]:duration-200 data-[state=open]:duration-300 outline-none",
          SIDES[side],
          className
        )}
        {...props}>
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            className="absolute top-4 right-3 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:outline-hidden disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0">
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetTitle({ className, ...props }) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-section leading-none font-semibold", className)}
      {...props} />
  );
}

function SheetDescription({ className, ...props }) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-fg-muted text-body", className)}
      {...props} />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
}
