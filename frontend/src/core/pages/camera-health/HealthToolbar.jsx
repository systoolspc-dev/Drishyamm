import { ChevronDown, ListFilter, RefreshCw, RotateCcw, Search, X } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { PageAction } from '@/core/layout/OperationsPage';
import { Button } from '@/core/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { Input } from '@/core/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/core/ui/select';
import { BRAND_SHEEN, toneClass } from '@/core/ui/tone';
import HealthGuide from './HealthGuide';
import { bucketMeta, FILTER_BUCKETS } from './health-vocabulary';

/** Radix Select forbids an empty-string item value, so "no choice" needs a name. */
export const ANY = 'all';


function statusSummary(statuses) {
  if (statuses.size === 0) return 'Any status';
  if (statuses.size === 1) return bucketMeta([...statuses][0]).label;
  return `${statuses.size} statuses`;
}

/**
 * Every control this page has, in one row beside the title: search, site,
 * group and status on the left, then the page's own controls — help, refresh
 * and auto refresh — on the right.
 *
 * This replaces a 320px sidebar card. The sidebar cost the table a third of
 * the page's width and pushed the first camera row to ~520px down the page,
 * below the fold of a laptop; the four controls it held fit in the header's
 * action row with height to spare.
 *
 * Every control applies IMMEDIATELY. The sidebar staged the site, group and
 * status choices behind an Apply button, which a toolbar cannot promise: a
 * dropdown you close and a table that does not move reads as a bug, not as a
 * pending change. There is nothing to apply, so the only commitment control
 * left is Clear, and it appears only when there is something to clear.
 */
export function HealthToolbar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  onClear,
  active,
  sites,
  groups,
  counts,
  loading,
  onRefresh,
  autoRefresh,
  onAutoRefreshChange,
}) {
  // A group belongs to a site, so choosing a site narrows the group list. The
  // alternative — offering groups that cannot match the chosen site — hands
  // the operator an empty table and no explanation.
  const visibleGroups = filter.siteId === ANY
    ? groups
    : groups.filter((g) => g.siteId === filter.siteId);

  const pickSite = (siteId) => {
    // Keep the group only while it still belongs to the chosen site.
    const keep = siteId === ANY || groups.some((g) => g.id === filter.groupId && g.siteId === siteId);
    onFilterChange({ ...filter, siteId, groupId: keep ? filter.groupId : ANY });
  };

  const toggleStatus = (bucket) => {
    const next = new Set(filter.statuses);
    if (next.has(bucket)) next.delete(bucket);
    else next.add(bucket);
    onFilterChange({ ...filter, statuses: next });
  };

  const statusActive = filter.statuses.size > 0;

  return (
    <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto">
      {/* Search runs as you type. It is a lookup, not a filter — you are
          reaching for a camera you can already name, and making that wait
          for a button press would be absurd. */}
      <div className="relative w-full sm:w-52">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search camera, site, group…"
          aria-label="Search cameras"
          className="bg-surface pl-9 pr-8"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <Select value={filter.siteId} onValueChange={pickSite}>
        <SelectTrigger className="min-w-0 flex-1 basis-32 bg-surface sm:w-[8.75rem] sm:flex-none" aria-label="Filter by site">
          <SelectValue placeholder="All sites" />
        </SelectTrigger>
        {/* `position="popper"` with `side="bottom" align="start"` is the Radix
            spelling of `absolute left-0 top-full mt-2`: the panel hangs from
            the trigger's bottom-left corner with an 8px gap. The default here
            is `item-aligned`, which positions the list so the SELECTED item
            lands over the trigger — so "All sites" opened overlapping its own
            button instead of beneath it. */}
        <SelectContent position="popper" side="bottom" align="start" sideOffset={8}>
          <SelectItem value={ANY}>All sites</SelectItem>
          {sites.map((site) => (
            <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filter.groupId}
        onValueChange={(groupId) => onFilterChange({ ...filter, groupId })}
      >
        <SelectTrigger className="min-w-0 flex-1 basis-32 bg-surface sm:w-[8.75rem] sm:flex-none" aria-label="Filter by camera group">
          <SelectValue placeholder="All groups" />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start" sideOffset={8}>
          <SelectItem value={ANY}>All groups</SelectItem>
          {visibleGroups.map((group) => (
            <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* The four status buckets, collapsed into one trigger. They are still
          checkboxes — an operator wants "offline OR unstable", which a Select
          cannot express — but closed they take 9rem instead of four rows. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            aria-label={`Filter by status, currently ${statusSummary(filter.statuses).toLowerCase()}`}
            // Fixed width from `sm`, like the two selects: the label changes
            // with the selection, and a trigger that resized would shuffle the
            // Clear button and the info icon sideways under the operator's
            // cursor. Below `sm` the three filters share the row and wrap
            // instead, because 3 × 140px does not fit a 288px phone.
            className={cn(
              'min-w-0 flex-1 basis-32 justify-start gap-2 px-3 font-normal text-fg sm:w-[9.5rem] sm:flex-none',
              BRAND_SHEEN,
              statusActive && 'border-brand/50 bg-brand-soft font-semibold text-brand-ink',
            )}
          >
            <ListFilter className={cn('h-4 w-4', statusActive ? 'text-brand' : 'text-fg-subtle')} />
            <span className="min-w-0 flex-1 truncate text-left">
              {statusSummary(filter.statuses)}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="w-60"
        >
          <DropdownMenuLabel>Filter by status</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/* The count is always of the WHOLE estate, never of the current
              filter. A filter control that renumbered itself as you used it
              would make it impossible to tell "no offline cameras" from "no
              offline cameras matching what I already typed". */}
          {FILTER_BUCKETS.map((bucket) => {
            const meta = bucketMeta(bucket);
            return (
              <DropdownMenuCheckboxItem
                key={bucket}
                checked={filter.statuses.has(bucket)}
                onCheckedChange={() => toggleStatus(bucket)}
                onSelect={(e) => e.preventDefault()}
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', toneClass(meta.tone, 'dot'))} />
                <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                <span className="shrink-0 text-small font-semibold tabular-nums text-fg-muted">
                  {counts[bucket] || 0}
                </span>
              </DropdownMenuCheckboxItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!statusActive}
            onSelect={() => onFilterChange({ ...filter, statuses: new Set() })}
          >
            Show any status
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {active ? (
        <Button variant="ghost" onClick={onClear} className={cn('px-2.5', BRAND_SHEEN)}>
          <RotateCcw className="h-4 w-4" />
          Clear
        </Button>
      ) : null}

      {/* The filters end here and the page's own controls begin. On a narrow
          screen the row has already wrapped, so the rule would be dividing
          nothing — it only shows once the two groups are side by side. */}
      <span className="hidden h-6 w-px shrink-0 bg-line sm:block" aria-hidden />

      <HealthGuide className={BRAND_SHEEN} />

      {/* Refresh only earns its place while auto-refresh is OFF: with it on
          (the default) the page reloads every 10s, so the button saves at most
          ten seconds and competes with the ticked box to say the same thing. */}
      {!autoRefresh ? (
        <Button variant="outline" onClick={onRefresh} className={BRAND_SHEEN}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      ) : null}

      <PageAction as="label" className={cn('cursor-pointer', BRAND_SHEEN)}>
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={(e) => onAutoRefreshChange(e.target.checked)}
          className="h-4 w-4 rounded border-line accent-brand"
        />
        Auto refresh
      </PageAction>
    </div>
  );
}

export default HealthToolbar;
