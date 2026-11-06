import { Search, RefreshCw, Activity } from 'lucide-react';
import UseCaseSwitcher from '../../UseCaseSwitcher';

// Module title row for Activity Monitoring. Deliberately lean: the global VMS
// Topbar already owns notifications + user profile, and the sidebar shows the
// location — so this bar carries only what's unique to the page (search, the
// live-refresh state and a manual refresh), matching the retail dashboard.
export default function CampusHeader({
  query, onQuery,
  lastUpdated, autoRefresh, onToggleAutoRefresh,
  refreshing, onRefresh,
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {/* Title */}
      <div className="flex items-center gap-2.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-brand-line bg-brand-soft text-brand">
          <Activity className="h-5 w-5" strokeWidth={2} />
        </span>
        <div>
          <h1 className="text-xl font-bold leading-tight tracking-tight text-fg">Staff activity</h1>
          <p className="mt-1 text-small text-fg-muted">Campus-wide AI activity intelligence · live analytics</p>
        </div>
      </div>

      {/* Controls — unique to this page, not duplicated from the Topbar */}
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:ml-auto">
          <UseCaseSwitcher />
        <label className="relative inline-flex flex-1 items-center sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search activity, room, person…"
            className="w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-3 text-small text-fg-secondary placeholder:text-fg-subtle focus:border-brand focus:outline-none sm:w-56"
          />
        </label>

        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-caption text-fg-muted">
          <span className={`h-2 w-2 rounded-full ${autoRefresh ? 'animate-pulse bg-success' : 'bg-line-strong'}`} />
          <span className="hidden md:inline">Updated</span>
          <span className="font-semibold text-fg-secondary">{lastUpdated}</span>
        </span>

        <label className="inline-flex cursor-pointer select-none items-center gap-1.5 whitespace-nowrap text-caption font-medium text-fg-muted">
          <span className="hidden sm:inline">Auto</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoRefresh}
            aria-label="Auto refresh"
            onClick={onToggleAutoRefresh}
            className={`relative h-5 w-9 rounded-full transition-colors ${autoRefresh ? 'bg-brand' : 'bg-line-strong'}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform ${autoRefresh ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </label>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-small font-semibold text-fg-secondary transition hover:border-brand/40 hover:text-brand-ink disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
    </div>
  );
}
