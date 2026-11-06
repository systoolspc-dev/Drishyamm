import { ChevronDown, LogOut, Menu, Moon, PanelLeft, PanelLeftClose, Plus, RefreshCw, Search, Sun, User, X } from 'lucide-react';
import logo from '@/assets/drishyam-logo.svg';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { Button } from '@/core/ui/button';
import NotificationBell from '@/core/layout/NotificationBell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/core/ui/avatar';
import { useAuthStore } from '@/core/store/authStore';
import { makeEntitlement } from '@/core/nav/entitlements';
import { useSearchStore } from '@/core/store/searchStore';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '@/core/context/ThemeContext';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';

// Routes that render the dashboard, and so get the search + quick-action row.
const ACTION_ROUTES = ['/home', '/dashboard'];

// The nav toggle is supplied by the app shell, which owns the sidebar state.
// `navMode` says what the button is operating on right now — the fixed rail or
// the overlay drawer — because the icon and the hint differ between them.
export default function Topbar({ onToggleNav, navMode = 'rail', sidebarOpen = true }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { dark, toggle } = useTheme();
  const queryClient = useQueryClient();
  const isFetching = useIsFetching();
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);

  const showActions = ACTION_ROUTES.includes(pathname);
  // Managed accounts (Add & edit cameras switched off) get no Add button.
  const canAddCameras = makeEntitlement(user).has('camera_setup');

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const initials = user?.name
    ? user.name.split(' ').map((n) => n[0]).join('').toUpperCase()
    : 'U';

  // The drawer gets a hamburger; the rail gets a panel glyph that shows which
  // way it will move. The shortcut is only mentioned where a keyboard is
  // likely to exist.
  const drawerMode = navMode === 'drawer';
  const NavToggleIcon = drawerMode ? Menu : sidebarOpen ? PanelLeftClose : PanelLeft;
  const navLabel = drawerMode
    ? (sidebarOpen ? 'Close navigation' : 'Open navigation')
    : (sidebarOpen ? 'Collapse sidebar (Ctrl+B)' : 'Expand sidebar (Ctrl+B)');

  return (
    // The bar's bottom hairline is an INSET SHADOW, not a `border-b`. It has to
    // be on every route, and a real border added a 65th pixel to a bar the whole
    // app measures as `--topbar-h` (64px) — every `calc(100vh - var(--topbar-h))`
    // page then came out 1px taller than the viewport and showed a phantom
    // scrollbar it could not remove from its own markup. A shadow paints the
    // same 1px line inside the box and contributes nothing to layout, so the
    // header stays exactly 64px on every page and in both themes. `--line` is
    // theme-aware, so this follows light/dark on its own.
    <header data-app-chrome="topbar" className="bg-background sticky top-0 z-20 shadow-[inset_0_-1px_0_0_var(--line)] transition-colors duration-200">
      {/* ── Row 1: greeting + account controls ──────────────────────────── */}
      {/* Always 64px (--topbar-h) — matches the Sidebar's brand row so the
          seam between them runs unbroken across the full width, on every
          route. This used to compact to 48px on dashboard routes, which
          visibly misaligned it against the sidebar. */}
      <div className={`flex h-16 items-center justify-between gap-3 px-3.5 sm:px-6 ${showActions ? 'border-b border-line' : ''}`}>
        <div className="flex min-w-0 items-center gap-2">
          {/* One control, two jobs. Below `lg` the sidebar is off-canvas and
              this opens it as a drawer; at `lg` and up it collapses the fixed
              rail to icons and back. The icon says which. */}
          {onToggleNav ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleNav}
                  aria-label={navLabel}
                  aria-expanded={sidebarOpen}
                  className="-ml-1 h-9 w-9 shrink-0 text-fg-secondary hover:bg-brand-soft hover:text-brand-ink focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  <NavToggleIcon className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{navLabel}</TooltipContent>
            </Tooltip>
          ) : null}
          <img src={logo} alt="" className="h-[20px] w-auto shrink-0 object-contain lg:hidden" />
          <h2 className="truncate text-body font-bold text-fg">
            Welcome back{user?.name ? `, ${user.name}` : ''}
          </h2>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Light / Dark toggle */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="text-fg-muted hover:text-fg w-9 h-9"
          >
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>

          {/* Notifications */}
          <NotificationBell />

          {/* User Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center gap-2 px-2 h-9">
                <Avatar className="w-7 h-7">
                  <AvatarFallback className="bg-primary text-primary-foreground text-caption font-bold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <ChevronDown className="w-3.5 h-3.5 text-fg-muted" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => navigate('/settings')}>
                <User className="w-4 h-4 mr-2" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} className="text-danger-ink focus:text-danger-ink">
                <LogOut className="w-4 h-4 mr-2" />
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Row 2: search + quick actions (dashboard routes only) ───────── */}
      {/* No bottom rule of its own — the header's inset hairline already closes
          the bar off, on this route like every other. */}
      {showActions && (
        <div className="flex items-center gap-2 px-3.5 py-3 sm:gap-3 sm:px-6">
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg bg-surface-muted px-3.5 transition focus-within:ring-2 focus-within:ring-primary/25">
            <Search className="h-4 w-4 shrink-0 text-fg-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cameras, people, vehicles, events…"
              className="min-w-0 flex-1 bg-transparent text-body font-medium text-fg placeholder:text-fg-muted outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                title="Clear search"
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-border hover:text-fg"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </label>

          {/* Below `sm` the two actions drop to icon-only so the search
              field keeps usable width; the label stays as the accessible name. */}
          {canAddCameras ? (
            <button
              onClick={() => navigate('/devices')}
              aria-label="Add camera"
              title="Add a camera or recorder"
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-body font-bold text-primary-foreground shadow-sm transition hover:bg-primary/90 sm:px-4"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Add camera</span>
            </button>
          ) : null}

          <button
            onClick={() => queryClient.invalidateQueries()}
            aria-label="Refresh"
            title="Refresh"
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-background px-3 text-body font-bold text-fg-muted transition hover:bg-surface-muted hover:text-fg sm:px-4"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      )}
    </header>
  );
}
