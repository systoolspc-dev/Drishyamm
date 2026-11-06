import { Eye, EyeOff } from 'lucide-react';

// Single, identical show/hide control used by every section header and every
// chart card. One consistent affordance means the eye can learn it once and
// scan the whole page: same shape, same position (top-right), same colors —
// slate when shown, accent when hidden.
export default function EyeToggle({ shown, onToggle, label, size = 'md' }) {
  const box = size === 'sm' ? 'h-7 w-7' : 'h-8 w-8';
  const icon = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  return (
    <button
      type="button"
      onClick={onToggle}
      title={shown ? `Hide ${label}` : `Show ${label}`}
      aria-label={shown ? `Hide ${label}` : `Show ${label}`}
      aria-pressed={!shown}
      className={`inline-flex ${box} shrink-0 items-center justify-center rounded-lg border transition ${
        shown
          ? 'border-line text-fg-subtle hover:border-brand/40 hover:text-brand-ink'
          : 'border-brand/30 bg-brand/10 text-brand-ink'
      }`}
    >
      {shown ? <Eye className={icon} /> : <EyeOff className={icon} />}
    </button>
  );
}
