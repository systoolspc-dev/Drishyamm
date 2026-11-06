import EyeToggle from './EyeToggle';

// Reusable section wrapper. Implements the spec's "one eye toggle controls the
// entire section": when hidden, the body collapses and only the header row
// remains, so the page compacts cleanly instead of leaving placeholder noise.
//
// Props:
//   icon     — lucide component for the section title
//   title    — section heading
//   subtitle — muted one-liner beside the title
//   visible  — whether the body is shown
//   onToggle — flips visibility
//   right    — optional node at the far right of the header (shown when open)
export default function SectionCard({ icon, title, subtitle, visible, onToggle, right, children }) {
  const Icon = icon;
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <header className={`flex items-center gap-3 px-4 py-3 ${visible ? 'border-b border-line-subtle' : ''}`}>
        {Icon && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Icon className="h-4 w-4" strokeWidth={2} />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg sm:text-base">{title}</h2>
          {subtitle && <p className="truncate text-caption leading-tight text-fg-subtle">{subtitle}</p>}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {visible && right}
          <EyeToggle shown={visible} onToggle={onToggle} label={title} />
        </div>
      </header>

      {visible && <div className="p-4">{children}</div>}
    </section>
  );
}
