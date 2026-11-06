import { useState } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuItem,
} from '@/core/ui/dropdown-menu';
import { ZoneIcon } from './bits';
import { EMPTY_ZONE_FILTERS, activeFilterCount } from '../headcount-data';

// Global filter controls for Zone Headcount. Both are driven by config, never by
// hard-coded lists: the type options are the vertical's own zoneTypes catalog,
// so a hospital sees "Triage" where a store sees "Billing Counter".

/** Multi-select over the vertical's zone types. `value` [] means all types. */
export function ZoneTypeSelect({ types, value, onChange, className = '' }) {
  const selected = new Set(value);
  const label = value.length === 0
    ? 'All zone types'
    : value.length === 1
      ? types.find((t) => t.id === value[0])?.label || value[0]
      : `${value.length} zone types`;

  const toggle = (id, on) => {
    const next = new Set(selected);
    if (on) next.add(id); else next.delete(id);
    // Keep catalog order, so the trigger label and URL-ish state are stable.
    onChange(types.filter((t) => next.has(t.id)).map((t) => t.id));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`inline-flex h-11 min-w-[8.5rem] items-center justify-between gap-2 rounded-lg border bg-surface px-2.5 text-[12px] outline-none transition focus-visible:border-brand lg:h-8 ${value.length ? 'border-brand/40 text-brand-ink' : 'border-line text-fg-secondary'} ${className}`}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-[11px]">Zone types</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {types.map((t) => (
          <DropdownMenuCheckboxItem
            key={t.id}
            checked={selected.has(t.id)}
            onCheckedChange={(on) => toggle(t.id, on)}
            onSelect={(e) => e.preventDefault()}   // keep open for multi-pick
            className="text-[12px]"
          >
            <ZoneIcon kind={t.kind} className="h-3.5 w-3.5 text-fg-subtle" />
            {t.label}
          </DropdownMenuCheckboxItem>
        ))}
        {value.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])} className="text-[12px]">Clear selection</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Live table filter popover ──────────────────────────────────────────────
// The Live Zone Occupancy header keeps only title · search · this button ·
// live state. Everything that narrows the table lives behind the button.
//
// Draft → Apply: picks inside the popover are a draft; nothing on the page
// moves until Apply, so the KPIs above do not flicker through intermediate
// states. Reset clears the draft (Apply still confirms). Outside click and Esc
// close WITHOUT applying — Radix handles both, plus focus return.

const STATUS_CHOICES = [
  { key: 'all',      label: 'All',           dot: null },
  { key: 'normal',   label: 'Normal',        dot: 'bg-success' },
  { key: 'warning',  label: 'Nearing limit', dot: 'bg-warning' },
  { key: 'exceeded', label: 'Over capacity', dot: 'bg-danger', hint: 'incl. below-minimum' },
];

const DWELL_CHOICES = [
  { key: 'all', label: 'All' },
  { key: '5',   label: '> 5 mins' },
  { key: '10',  label: '> 10 mins' },
];

function Group({ title, children }) {
  return (
    <fieldset className="border-t border-line-subtle px-3 py-2.5 first:border-t-0">
      <legend className="float-left mb-1.5 w-full text-micro font-semibold uppercase tracking-wide text-fg-subtle">{title}</legend>
      <div className="clear-both">{children}</div>
    </fieldset>
  );
}

function Radio({ name, checked, onChange, children }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1.5 text-caption text-fg-secondary hover:bg-surface-sunken lg:min-h-7">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="h-3.5 w-3.5 accent-[var(--brand)]" />
      {children}
    </label>
  );
}

export function ZoneFilterPopover({ value, onApply, zoneTypes, areas, areaLabel, statusCounts }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const count = activeFilterCount(value);

  // Every open starts from what is applied, so a dismissed draft never leaks.
  const onOpenChange = (next) => { if (next) setDraft(value); setOpen(next); };
  const toggleType = (id) => set({
    types: draft.types.includes(id)
      ? draft.types.filter((t) => t !== id)
      : zoneTypes.filter((t) => t.id === id || draft.types.includes(t.id)).map((t) => t.id),
  });

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={count ? `Filters, ${count} active` : 'Filters'}
          title={count ? `${count} filter${count === 1 ? '' : 's'} applied` : 'Filter zones'}
          className={`relative inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-8 lg:px-2.5 ${
            count ? 'border-brand/50 bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-secondary hover:border-brand/40 hover:text-brand-ink'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>Filters</span>
          {count > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-bold tabular-nums text-white">{count}</span>
          )}
          {count > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand ring-2 ring-surface" aria-hidden />}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 flex max-h-[min(34rem,var(--radix-popover-content-available-height))] w-72 max-w-[calc(var(--app-vw)-2rem)] flex-col rounded-xl border border-line bg-surface text-left shadow-lg outline-none"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-small font-semibold text-fg">Filter zones</p>
            <PopoverPrimitive.Close className="grid h-11 w-11 place-items-center rounded-md text-fg-subtle hover:bg-surface-sunken hover:text-fg lg:h-6 lg:w-6" aria-label="Close filters">
              <X className="h-3.5 w-3.5" />
            </PopoverPrimitive.Close>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            <Group title="Zone type">
              <div className="grid grid-cols-1 gap-0.5">
                {zoneTypes.map((t) => (
                  <label key={t.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1.5 text-caption text-fg-secondary hover:bg-surface-sunken lg:min-h-7">
                    <input type="checkbox" checked={draft.types.includes(t.id)} onChange={() => toggleType(t.id)} className="h-3.5 w-3.5 accent-[var(--brand)]" />
                    <ZoneIcon kind={t.kind} className="h-3.5 w-3.5 text-fg-subtle" />
                    {t.label}
                  </label>
                ))}
              </div>
            </Group>

            <Group title="Status">
              {STATUS_CHOICES.map((o) => (
                <Radio key={o.key} name="zone-status" checked={draft.status === o.key} onChange={() => set({ status: o.key })}>
                  {o.dot && <span className={`h-1.5 w-1.5 rounded-full ${o.dot}`} aria-hidden />}
                  <span>{o.label}</span>
                  {o.hint && <span className="text-micro text-fg-subtle">{o.hint}</span>}
                  <span className="ml-auto tabular-nums text-fg-subtle">{o.key === 'all' ? statusCounts.all : statusCounts[o.key] || 0}</span>
                </Radio>
              ))}
            </Group>

            <Group title="Dwell time (typical)">
              <div className="flex gap-1">
                {DWELL_CHOICES.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    aria-pressed={draft.dwell === o.key}
                    onClick={() => set({ dwell: o.key })}
                    className={`h-11 flex-1 rounded-md border text-caption transition lg:h-7 ${draft.dwell === o.key ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink' : 'border-line text-fg-secondary hover:border-brand/40'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </Group>

            <Group title={areaLabel}>
              <select
                value={draft.area}
                onChange={(e) => set({ area: e.target.value })}
                aria-label={areaLabel}
                className="h-11 w-full rounded-md border border-line bg-surface px-2 text-caption text-fg-secondary outline-none focus:border-brand lg:h-8"
              >
                <option value="">{areas[0] || `All ${areaLabel.toLowerCase()}s`}</option>
                {areas.slice(1).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </Group>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
            <button
              type="button"
              onClick={() => setDraft(EMPTY_ZONE_FILTERS)}
              disabled={activeFilterCount(draft) === 0}
              className="h-11 rounded-md px-1.5 text-caption font-semibold text-fg-muted transition hover:text-brand-ink disabled:opacity-40 lg:h-8"
            >
              Reset filters
            </button>
            <button
              type="button"
              onClick={() => { onApply(draft); setOpen(false); }}
              className="h-11 rounded-lg bg-brand px-3 text-caption font-semibold text-white shadow-sm transition hover:bg-brand-hover lg:h-8"
            >
              Apply filters
            </button>
          </div>
          <PopoverPrimitive.Arrow className="fill-surface" width={10} height={5} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
