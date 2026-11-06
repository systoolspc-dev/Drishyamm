// Card wrapper for the rules engine — matches the module's card language.
// `className` sizes the card inside its parent (e.g. `lg:flex-1 lg:min-h-0`
// in a viewport-contained page); `bodyClassName` replaces the default body
// padding so a panel can scroll its own body.
export default function RulePanel({ icon, title, count, right, className = '', bodyClassName = 'p-4', children }) {
  const Icon = icon;
  return (
    <div className={`flex flex-col rounded-xl border border-line bg-surface shadow-sm ${className}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-4 py-2.5">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />}
        <p className="text-small font-bold text-fg">{title}</p>
        {count != null && (
          <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-micro font-bold text-fg-muted">{count}</span>
        )}
        {right && <span className="ml-auto">{right}</span>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}
