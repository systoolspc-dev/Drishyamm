import { Info, X } from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/core/ui/select';

/**
 * "No site selected" — shown once, on arrival, when the page opened without a
 * usable ?siteId= (a plain link, or one naming a site that no longer exists)
 * and is therefore showing every site's events. It sits directly under the
 * filter bar it points at, carries a quick site pick so the operator does not
 * have to hunt for the Site select, and goes away on dismiss or on any pick.
 *
 * `missingSite`: the id a link asked for that matched no site — said out loud,
 * because otherwise the link looks like it was simply ignored.
 */
export default function SiteScopeNotice({ sites, missingSite, onPick, onDismiss }) {
  return (
    <div
      role="status"
      className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-info-line bg-info-soft px-3 py-2.5 text-small text-info-ink sm:flex-row sm:items-center"
    >
      <Info className="hidden h-4 w-4 shrink-0 sm:block" strokeWidth={2} aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">
          {missingSite ? 'The site in this link was not found.' : 'No site selected.'}
        </span>
        {' '}Showing event logs for All Sites. Select a specific site from the filter above.
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Select value="" onValueChange={onPick}>
          <SelectTrigger className="h-9 w-full min-w-44 bg-surface text-fg sm:w-52" aria-label="Choose a site">
            <SelectValue placeholder="Choose a site…" />
          </SelectTrigger>
          <SelectContent>
            {sites.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-info-ink/80 transition hover:bg-surface/60 hover:text-info-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
