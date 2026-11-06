import { Search, Landmark } from 'lucide-react';
import ActivityToolbar, {
  ToolbarLive, ToolbarRefresh, ToolbarScope, ToolbarSep,
} from '../../ActivityToolbar';
import { BANK_DATA } from '../data';

// Bank's dressing on the shared Activity Monitoring toolbar (../../ActivityToolbar,
// extracted from dashboard/ActivityDashboard.jsx). The band, the h1, the icon
// tile and PolicyTip come from there; this file supplies only what is bank.
//
// CONTEXT LINE — branch · live stamp. Two segments, not three:
//   · Scope is ONE branch, so ToolbarScope renders it as text rather than as a
//     select with a single option.
//   · No shift segment. src/use-cases/bank/index.js sets businessHours but no
//     `shifts[]`, and shiftSummary() answers an empty roster with "Outside shift
//     hours" — which would be a false statement dressed as a derived fact. The
//     segment stays out until the vertical has a roster to derive it from.
// The old branch subtitle ("branch workforce & compliance intelligence") is gone:
// it was decoration under a heading that already says what the page is.
//
// AUTO-REFRESH lives in the actions, not the context line: it is a control, and
// the context line is the one place on this page that carries no controls.
export default function BankHeader({
  query, onQuery, lastUpdated, autoRefresh, onToggleAutoRefresh, refreshing, onRefresh,
}) {
  return (
    <ActivityToolbar
      icon={Landmark}
      context={
        <>
          <ToolbarScope options={[{ id: 'branch', label: BANK_DATA.branch }]} />
          <ToolbarSep />
          <ToolbarLive>Live · {lastUpdated} IST</ToolbarLive>
        </>
      }
      actions={
        <>
          <label className="relative inline-flex items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-fg-subtle" />
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search staff, counter, zone…"
              className="w-full rounded-lg border border-line bg-surface py-2 pl-8 pr-3 text-small text-fg-secondary placeholder:text-fg-subtle focus:border-brand focus:outline-none sm:w-56"
            />
          </label>

          <label className="inline-flex cursor-pointer select-none items-center gap-1.5 whitespace-nowrap text-caption font-medium text-fg-muted">
            <span className="hidden sm:inline">Auto</span>
            <button
              type="button" role="switch" aria-checked={autoRefresh} aria-label="Auto refresh"
              onClick={onToggleAutoRefresh}
              className={`relative h-5 w-9 rounded-full transition-colors ${autoRefresh ? 'bg-brand' : 'bg-line-strong'}`}
            >
              <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform ${autoRefresh ? 'translate-x-4' : 'translate-x-0'}`} />
            </button>
          </label>

          <ToolbarRefresh busy={refreshing} onClick={onRefresh} />
        </>
      }
    />
  );
}
