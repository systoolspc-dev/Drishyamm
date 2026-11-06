import { useActivityParams } from './useCaseStore';
import { policyItems } from './policy-items';


// Context strip shown under a page header. Still used by the subpages
// (Reports, Phone Usage, Zone Coverage, Employee Detail, Activity Breakdown)
// and the Campus dashboard; the retail/office Activity Monitoring dashboard
// swapped it for PolicyTip to keep its header to two lines.
export default function PolicyBar() {
  const { params } = useActivityParams();
  const items = policyItems(params);

  if (!items.length) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-caption text-fg-muted">
      <span className="font-bold uppercase tracking-wide text-fg-subtle">Policy</span>
      {items.map(([k, v]) => (
        <span key={`${k}-${v}`} className="whitespace-nowrap">{k}: <span className="font-semibold text-fg-secondary">{v}</span></span>
      ))}
    </div>
  );
}
