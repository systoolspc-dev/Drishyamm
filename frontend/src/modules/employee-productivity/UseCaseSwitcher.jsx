import { Building2, Store, GraduationCap, School, BedDouble, Hotel, Landmark, Check, ChevronDown } from 'lucide-react';
import { USE_CASES } from '@/use-cases';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { useUseCaseStore } from './useCaseStore';
import ActivityPagesMenu from './ActivityPagesMenu';

// The same modules render Corporate / Retail / Campus / School / Hostel /
// Hospitality / Bank — this is how you flip between them.
//
// It used to be a full-width strip of seven buttons sitting above the page
// title, which put the demo control above the page's own name and cost a whole
// row of vertical space on every dashboard. As a dropdown it sits in the header
// action bar with everything else, and the current vertical is still readable
// without opening it because the trigger says which one is active.
const ICONS = {
  corporate: Building2,
  retail: Store,
  campus: GraduationCap,
  school: School,
  hostel: BedDouble,
  hospitality: Hotel,
  bank: Landmark,
};

// Only these verticals are finished. The rest still open (so their work in
// progress can be viewed) but carry an "Under Progress" pill beside the name.
const ACTIVE = new Set(['corporate', 'retail']);

// The amber pill, on theme tokens (bg-warning-soft ≈ amber-50, text-warning-ink
// ≈ amber-700, border-warning-line ≈ amber-200) so it also reads in dark mode.
const PILL = 'ml-auto shrink-0 rounded-full border border-warning-line/80 bg-warning-soft px-2 py-0.5 text-[10px] font-medium text-warning-ink';

export default function UseCaseSwitcher({ className = '' }) {
  const useCase = useUseCaseStore((s) => s.useCase);
  const setUseCase = useUseCaseStore((s) => s.setUseCase);

  const options = Object.values(USE_CASES);
  const active = options.find((uc) => uc.key === useCase) || options[0];
  const ActiveIcon = ICONS[active?.key] || Building2;

  // "All pages" sits beside the switcher: every Staff activity header carries
  // this component, and the sidebar now lists only a few of the module's pages.
  return (
    <>
    <ActivityPagesMenu />
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary shadow-sm transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${className}`}
          title="Switch the vertical this dashboard is showing"
          type="button"
        >
          <ActiveIcon className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
          {/* The label is the point of the control, so it survives to the
              narrowest width the header allows; only the prefix is dropped. */}
          <span className="hidden text-fg-muted sm:inline">Viewing as</span>
          <span className="truncate text-fg">{active?.label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        {options.map((uc) => {
          const Icon = ICONS[uc.key] || Building2;
          const on = uc.key === useCase;
          const ready = ACTIVE.has(uc.key);
          return (
            <DropdownMenuItem
              title={ready ? undefined : `${uc.label} is under progress`}
              className={on ? 'text-brand-ink' : ''}
              key={uc.key}
              onSelect={() => setUseCase(uc.key)}
            >
              <Icon className={`h-4 w-4 ${on ? 'text-brand' : 'text-fg-subtle'}`} strokeWidth={2} />
              <span className="flex-1 truncate">{uc.label}</span>
              {on ? <Check className="h-3.5 w-3.5 text-brand" strokeWidth={2.5} /> : null}
              {ready ? null : <span className={PILL}>Under Progress</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
