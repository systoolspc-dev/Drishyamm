import { useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronDown, LayoutList } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { activityPagesFor } from '@/core/nav/activityPages';
import { moduleParams } from '@/use-cases';
import { useUseCaseStore } from './useCaseStore';

// Every Staff activity page for the current vertical, one click away from any
// of them. The sidebar lists only the overview and four main pages (see
// core/nav/activityPages.js); this menu is where the rest live. It rides along
// with the vertical switcher, which every page header of the module carries.
export default function ActivityPagesMenu() {
  const useCase = useUseCaseStore((s) => s.useCase);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pages = activityPagesFor(useCase, moduleParams(useCase, 'employee-productivity'));
  const isOn = (p) => pathname === p.to || (p.matchPrefix && pathname.startsWith(`${p.to}/`));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary shadow-sm transition hover:border-brand/40 hover:bg-brand-soft hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          title="Every staff activity page"
          type="button"
        >
          <LayoutList className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
          <span className="text-fg">All pages</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-60 overflow-y-auto">
        <DropdownMenuLabel>Staff activity</DropdownMenuLabel>
        {pages.map((p) => {
          const on = isOn(p);
          const Icon = p.icon;
          return (
            <DropdownMenuItem key={p.to} className={on ? 'text-brand-ink' : ''} onSelect={() => navigate(p.to)}>
              <Icon className={`h-4 w-4 ${on ? 'text-brand' : 'text-fg-subtle'}`} strokeWidth={2} />
              <span className="flex-1 truncate">{p.label}</span>
              {on ? <Check className="h-3.5 w-3.5 text-brand" strokeWidth={2.5} /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
