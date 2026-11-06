import * as React from "react"

import { cn } from "@/core/lib/utils"

function Input({
  className,
  type,
  ...props
}) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // 14/20/400 for the value, and the placeholder matches it in size so
        // the field doesn't reflow as you type. Stock shadcn shipped 16px on
        // mobile and 14px above `md`; one size is less surprising.
        "file:text-fg placeholder:text-fg-subtle selection:bg-brand selection:text-white dark:bg-input/30 border-line h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-control text-fg shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-small file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-line-focus focus-visible:ring-brand/25 focus-visible:ring-[3px]",
        "aria-invalid:ring-danger/20 dark:aria-invalid:ring-danger/40 aria-invalid:border-danger",
        className
      )}
      {...props} />
  );
}

export { Input }
