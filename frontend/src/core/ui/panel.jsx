/**
 * Level-2 card wrapper: bordered surface, header with a bare accent icon, bold
 * title, optional count badge and right-hand slot.
 *
 * This lived in `modules/employee-productivity/campus/components` and was the
 * de-facto panel for every analytics page in the app. It is promoted here so a
 * module that is not part of employee-productivity can use the same card
 * without importing across verticals; the campus path still re-exports it, so
 * nothing that already imported it had to change.
 */
export default function Panel({ icon, title, count, right, bodyClass, className = '', titleClassName = 'text-small font-bold text-fg', fill = true, children }) {
  const Icon = icon;
  return (
    // `fill` (h-full) is right inside a grid or flex ROW, where it evens up
    // card heights -- which is why it stays the default for the ~220 call
    // sites that rely on it. It is wrong inside a flex COLUMN, where it is a
    // hard CAP rather than a minimum: every sibling asks for 100% of the
    // container, the total overflows, and `overflow-hidden` then guillotines
    // whatever did not fit -- silently, so a zone list just loses its last
    // rows. Callers in a column pass `fill={false}` and the panel takes its
    // content height, letting the PAGE scroll instead.
    <div className={`flex ${fill ? 'h-full' : ''} flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm ${className}`}>
      <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />}
        <h2 className={titleClassName}>{title}</h2>
        {count != null && (
          <span className="rounded-full bg-surface-muted px-1.5 py-0.5 text-micro font-bold text-fg-muted">{count}</span>
        )}
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {/* `overflow-x-auto` + `min-w-0`: a table wider than the card (phones)
          scrolls inside the body instead of being clipped by the root's
          `overflow-hidden`. Content that fits is unaffected. */}
      <div className={`min-h-0 min-w-0 flex-1 overflow-x-auto ${bodyClass ?? 'p-2.5'}`}>{children}</div>
    </div>
  );
}
