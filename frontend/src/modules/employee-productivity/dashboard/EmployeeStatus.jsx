import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UsersRound, SearchX, Search, X, Smartphone, Trophy, ArrowRight } from 'lucide-react';
import { useModuleData } from '../useModuleData';
import { T } from '../type';
import { avatarStyle } from '../scorecard';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 (left, ~60%) — Employee status list. One row per rostered
// employee with live status, in the slot the store floor plan used to hold.
//
// It carries the two metrics that lost their KPI cards, because both are facts
// about a person and a manager needs the name to act on:
//   · lateness       → the status badge reads "Late 26m", not just "Late"
//     (was the "On-Time Attendance" KPI)
//   · phone incidents→ a flag badge on the row, count included
//     (was the "Phone Incidents Today" KPI)
//
// Filters live INSIDE this card (they only affect this list), so the manager
// can answer "who is on break right now?" without hunting for a global filter.
// ─────────────────────────────────────────────────────────────────────────────

// Deterministic avatar hue per name (scorecard.js) — no avatar images in dummy
// mode. Backend later supplies employees[].avatar_url from the face-enrollment shot.

// Was the "Phone Incidents Today" KPI — now a per-person flag. Two or more in
// one day is a coaching conversation, so it escalates from warn to danger.
function PhoneFlag({ count }) {
  if (!count) return null;
  const hot = count > 1;
  return (
    <span
      title={`${count} phone incident${count > 1 ? 's' : ''} today`}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-caption font-bold ring-1 ${
        hot
          ? 'bg-danger-soft text-danger-ink ring-danger-line'
          : 'bg-warning-soft text-warning-ink ring-warning-line'
      }`}
    >
      <Smartphone className="h-2.5 w-2.5" />
      {count}
    </span>
  );
}

export default function EmployeeStatus({ loading }) {
  const { EMPLOYEES, STATUS_META } = useModuleData();
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');

  if (loading) {
    return (
      <div className="h-full animate-pulse overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-sm">
        <div className="mb-3 h-4 w-36 rounded bg-surface-muted" />
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="mb-2 h-12 rounded-lg bg-surface-muted" />)}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const rows = EMPLOYEES.filter((e) =>
    (statusFilter === 'all' || e.status === statusFilter) &&
    (!q || e.name.toLowerCase().includes(q) || e.zone.toLowerCase().includes(q)),
  );
  const present = EMPLOYEES.filter((e) => e.status !== 'notarrived').length;
  // Dashboard preview: unfiltered view shows the top rows; searching/filtering
  // shows every match (the user asked for those specifically).
  const filtered = statusFilter !== 'all' || q;
  const PREVIEW = 7;
  const shown = filtered ? rows : rows.slice(0, PREVIEW);

  return (
    <div className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-2.5 flex items-center gap-2">
        <UsersRound className="h-4 w-4 text-brand" />
        <h2 className="text-lg font-semibold text-fg">Employee Status</h2>
        <span className="ml-auto rounded-full bg-surface-muted px-2 py-0.5 text-caption font-semibold text-fg-secondary ring-1 ring-line tabular-nums">
          {present}/{EMPLOYEES.length} present
        </span>
        {/* Hand-off to the full Employee Scorecard (Staff Performance). */}
        <Link
          to="/activity-monitoring/performance"
          title="Open the staff scorecard on Staff Performance"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-brand-line bg-brand-soft px-2.5 py-0.5 text-caption font-semibold text-brand-ink transition hover:border-brand/60 hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <Trophy className="h-3.5 w-3.5" /> Staff Scorecard <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {/* In-card filters — they only affect this list */}
      <div className="mb-2.5 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or zone…"
            className="w-full rounded-lg border border-line py-1.5 pl-8 pr-7 text-small text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary" aria-label="Clear search">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="shrink-0 rounded-lg border border-line bg-surface px-2 py-1.5 text-small font-medium text-fg-secondary focus:border-brand focus:outline-none"
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          {Object.entries(STATUS_META).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        // Empty state — filters matched nobody
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-fg-subtle">
            <SearchX className="h-5 w-5" />
          </span>
          <p className="text-body font-semibold text-fg-secondary">No employees match</p>
          <p className="text-caption text-fg-subtle">Adjust the status filter or search.</p>
        </div>
      ) : (
        // Mirrors Needs Attention: fills the height-locked parent, scrolls
        // inside, so the two panels bottom out on the same line whatever
        // either list contains.
        <div className="-mr-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {shown.map((e) => {
            const meta = STATUS_META[e.status] || STATUS_META.onfloor;
            const initials = e.name.split(' ').map((w) => w[0]).join('');
            // "Late 26m" — the duration rides on the badge it qualifies.
            const badgeLabel = e.lateBy ? `${meta.label} ${e.lateBy}` : meta.label;
            return (
              <Link to={`/activity-monitoring/employee/${e.id}`} key={e.id} className="flex items-center gap-2.5 rounded-lg border border-line-subtle px-2.5 py-2 transition hover:border-line hover:bg-surface-sunken">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-caption font-bold text-white"
                  style={avatarStyle(e.name)}
                  aria-hidden
                >
                  {initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className={`truncate ${T.itemTitle}`}>{e.name}</p>
                    <PhoneFlag count={e.phoneIncidents} />
                  </div>
                  <p className={`truncate ${T.itemMeta}`} title={`${e.role} · ${e.zone} · ${e.shift}`}>
                    {e.role} · {e.zone} · {e.shift}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`inline-flex items-center gap-1 whitespace-nowrap ${T.stateBadge} ring-1 ${meta.cls}`}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.dot }} /> {badgeLabel}
                  </span>
                  <p className={`mt-0.5 tabular-nums ${T.itemMeta}`}>
                    {e.clockIn ? `in ${e.clockIn} · ${e.worked}` : 'not clocked in'}
                  </p>
                </div>
              </Link>
            );
          })}
          {!filtered && rows.length > PREVIEW && (
            <Link
              to="/attendance-report"
              className="block rounded-lg border border-dashed border-line py-2 text-center text-caption font-semibold text-brand-ink transition hover:border-brand/40 hover:bg-brand/5"
            >
              +{rows.length - PREVIEW} more — full Attendance Report →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
