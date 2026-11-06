import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { Button } from '@/core/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { Input } from '@/core/ui/input';
import { BRAND_SHEEN } from '@/core/ui/tone';
import { REPORT_TYPES, typeMeta } from './report-vocabulary';

/**
 * Which report to make — one control, searchable.
 *
 * This replaces the eight-card grid that used to own the top third of the
 * page. The grid showed every type at full size on every visit, including the
 * seven you were not there for, and pushed Recent Reports below the fold; an
 * operator who already knows they want "Camera Health" does not need a
 * 140px card to tell them it exists.
 *
 * Nothing is lost in the collapse: each row still carries the type's icon and
 * its one-line blurb, so the list still explains itself to someone browsing —
 * it just does it in a panel they opened on purpose.
 */
export function ReportTypePicker({ value, onChange, className }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);

  const chosen = typeMeta(value);
  const ChosenIcon = chosen.icon;

  // Label and blurb both, so "uptime" finds Camera Health.
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return REPORT_TYPES;
    return REPORT_TYPES.filter((t) =>
      `${t.label} ${t.blurb}`.toLowerCase().includes(needle));
  }, [query]);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          aria-label={`Report type: ${chosen.label}`}
          className={cn('h-9 w-full justify-start gap-2 px-3 font-normal text-fg', BRAND_SHEEN, className)}
        >
          <ChosenIcon className="h-4 w-4 shrink-0 text-brand" />
          <span className="min-w-0 flex-1 truncate text-left">{chosen.label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-80"
        // Radix focuses the first row on open, which would leave typing to its
        // own typeahead. The search field is the point of this menu.
        onOpenAutoFocus={(e) => { e.preventDefault(); searchRef.current?.focus(); }}
      >
        <div className="relative p-1.5">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search report types…"
            aria-label="Search report types"
            className="h-8 pl-8 text-small"
            // Every key stays in the field — otherwise the menu's typeahead
            // eats the letters and Space picks whatever row it landed on.
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>

        <div className="max-h-80 overflow-y-auto">
          {matches.length === 0 ? (
            <p className="px-2 py-4 text-center text-small text-fg-muted">
              No report type matches “{query}”
            </p>
          ) : (
            matches.map((t) => {
              const TypeIcon = t.icon;
              const selected = t.type === value;
              return (
                <DropdownMenuItem
                  key={t.type}
                  onSelect={() => onChange(t.type)}
                  className="items-start gap-2.5 py-2"
                >
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-brand-line bg-brand-soft text-brand">
                    <TypeIcon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-semibold text-fg">{t.label}</span>
                    <span className="block text-caption text-fg-muted">{t.blurb}</span>
                  </span>
                  {selected ? <Check className="mt-1 h-4 w-4 shrink-0 text-brand" /> : null}
                </DropdownMenuItem>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ReportTypePicker;
