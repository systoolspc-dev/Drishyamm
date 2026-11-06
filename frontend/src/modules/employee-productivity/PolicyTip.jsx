import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import { useActivityParams } from './useCaseStore';
import { policyItems } from './policy-items';

// The PolicyBar's content, folded into a single ⓘ.
//
// Thresholds explain the numbers, but a manager reads them once a month and the
// numbers every ten minutes — so on a realtime dashboard they are reference,
// not chrome, and a full-width strip above the KPI cards was paying header
// space for them every visit. Same data, same source (policyItems), one icon.
//
// Renders through the shared Radix tooltip, so it portals out of the header and
// cannot be clipped or covered by the cards below it.
export default function PolicyTip({ className = '' }) {
  const { params } = useActivityParams();
  const items = policyItems(params);

  if (!items.length) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Policy thresholds"
          className={`inline-flex items-center gap-1 rounded text-fg-subtle transition hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${className}`}
        >
          <Info className="h-3.5 w-3.5" />
          <span className="text-caption font-semibold">Policy</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        variant="card"
        side="bottom"
        align="start"
        collisionPadding={12}
        className="w-64 max-w-[calc(var(--app-vw)-2rem)] p-3 text-left"
      >
        <p className="text-micro font-semibold uppercase tracking-wide text-fg-subtle">
          Policy thresholds
        </p>
        <dl className="mt-1.5 space-y-1">
          {items.map(([k, v]) => (
            <div key={`${k}-${v}`} className="flex items-baseline justify-between gap-3">
              <dt className="text-caption text-fg-muted">{k}</dt>
              <dd className="text-caption font-semibold text-fg-secondary tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 border-t border-line pt-1.5 text-micro leading-snug text-fg-subtle">
          Set per vertical in <span className="font-mono">src/use-cases/</span>, not on this page.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
