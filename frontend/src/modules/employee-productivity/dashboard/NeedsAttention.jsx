import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, CheckCheck, ChevronDown, Video } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { CATEGORIES, eventLogHref } from '@/modules/event-log/eventlog/log-query';
import { useModuleData } from '../useModuleData';
import { T } from '../type';
import CameraPreviewModal from './CameraPreviewModal';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 (right, ~40%) — Needs Attention. The dashboard's PRIMARY alert
// feed: coverage breaches, queue-threshold trips, staff-policy alerts and
// system/infrastructure warnings in one severity-ranked queue.
//
// The header is just the title and the Category filter: each row already
// carries its own severity badge, and the filter's menu shows the counts, so
// count / severity pills beside the title only repeated the list below.
//
// A row says only what a manager needs to decide: severity, what happened,
// where / who / how long. The camera id and start time are one click away in
// the preview modal (and on hover), and the subsystem (coverage / queue /
// staff / system) is implicit in the title — so neither gets a line or a badge.
// A manager who wants one subsystem narrows the list with the compact
// Category dropdown in the header, and "View all in Event Log" carries that
// choice across as ?category= (see event-log/eventlog/log-query.js).
//
// "Acknowledge" is local state for now; the future call is
// POST /activity/alerts/:id/ack (the contract Attendance Report already uses
// via aiService.activityAckAlert).
//
// The camera button on a row opens CameraPreviewModal in place — event clip
// first, one click to live — so a manager can verify an alert without leaving
// the dashboard. Rows with no attributable camera have no button.
// ─────────────────────────────────────────────────────────────────────────────

// Type ramp for this card (type.js): section title 18px · alert title 14px ·
// location / duration 12px · severity badges 12px. Rows are single-line
// (truncate) so a long title can never push the actions out or change a row's
// height.

const SEVERITY = {
  high:   { chip: 'bg-danger-soft text-danger-ink ring-danger-line',   label: 'High',   rank: 0 },
  medium: { chip: 'bg-warning-soft text-warning-ink ring-warning-line', label: 'Medium', rank: 1 },
  low:    { chip: 'bg-surface-muted text-fg-muted ring-line',           label: 'Low',    rank: 2 },
};

function Skeleton() {
  return (
    <div className="h-full animate-pulse overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 h-4 w-36 rounded bg-surface-muted" />
      {[0, 1, 2, 3, 4].map((i) => <div key={i} className="mb-2 h-16 rounded-lg bg-surface-muted" />)}
    </div>
  );
}

// Header filter: [ Category: All Categories ▾ ] → All / Coverage / Queue / ….
function CategoryFilter({ value, onChange, counts, total }) {
  const current = CATEGORIES.find((c) => c.id === value);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Category: ${current ? current.label : 'All Categories'}`}
          className="inline-flex h-11 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-caption font-semibold text-fg-secondary transition hover:border-line-strong data-[state=open]:border-brand/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-7 lg:px-2"
        >
          <span className="text-fg-subtle max-sm:hidden">Category:</span> {current ? current.label : 'All Categories'}
          <ChevronDown className="h-3.5 w-3.5 text-fg-subtle" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 border-line bg-surface">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="all" className="text-small">
            All Categories <span className="ml-auto tabular-nums text-fg-subtle">{total}</span>
          </DropdownMenuRadioItem>
          {CATEGORIES.map((c) => (
            <DropdownMenuRadioItem key={c.id} value={c.id} disabled={!counts[c.id]} className="text-small">
              {c.label} <span className="ml-auto tabular-nums text-fg-subtle">{counts[c.id] || 0}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function NeedsAttention({ loading, siteId }) {
  const { ATTENTION } = useModuleData();
  const [acked, setAcked] = useState(() => new Set());
  const [category, setCategory] = useState('all');
  // Alert whose camera is being previewed; null = modal closed.
  const [preview, setPreview] = useState(null);
  const closePreview = useCallback(() => setPreview(null), []);

  // Open alerts, severity-ranked — the single source for the filter counts
  // and the rows.
  const open = useMemo(
    () => ATTENTION
      .filter((a) => !acked.has(a.id))
      .slice()
      .sort((a, b) => (SEVERITY[a.severity]?.rank ?? 9) - (SEVERITY[b.severity]?.rank ?? 9)),
    [ATTENTION, acked],
  );

  const byCategory = useMemo(
    () => open.reduce((acc, a) => ({ ...acc, [a.source]: (acc[a.source] || 0) + 1 }), {}),
    [open],
  );

  if (loading) return <Skeleton />;

  // A category that has just been emptied (its last alert acked) falls back
  // to All rather than leaving the manager on an empty filter.
  const active = category !== 'all' && byCategory[category] ? category : 'all';
  const rows = active === 'all' ? open : open.filter((a) => a.source === active);
  const logHref = eventLogHref({ siteId, status: 'UNACKNOWLEDGED', category: active });

  return (
    <div className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 shadow-sm">
      {/* Header — title left, Category filter right, one line */}
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-brand" />
        <h2 className="truncate text-lg font-semibold leading-tight text-fg">Needs Attention</h2>
        {open.length > 0 && (
          <span className="ml-auto shrink-0">
            <CategoryFilter value={active} onChange={setCategory} counts={byCategory} total={open.length} />
          </span>
        )}
      </div>

      {/* Empty state — everything acknowledged / nothing wrong */}
      {open.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success-soft text-success">
            <CheckCheck className="h-5 w-5" />
          </span>
          <p className="text-body font-semibold text-fg-secondary">All clear</p>
          <p className="text-caption text-fg-subtle">No active issues need action right now.</p>
        </div>
      ) : (
        // Fills whatever the height-locked parent gives it and scrolls inside.
        // `min-h-0` is what lets a flex child actually shrink to that box; the
        // panel's outer height therefore never depends on the list length.
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto border-t border-line">
          {rows.map((a) => {
            const sev = SEVERITY[a.severity] || SEVERITY.low;
            return (
              <div
                key={a.id}
                title={a.camera ? `${a.camera} · since ${a.since} IST` : `Since ${a.since} IST`}
                className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 transition-colors hover:bg-surface-sunken"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`w-16 shrink-0 text-center ${T.severityBadge} ring-1 ${sev.chip}`}>
                    {sev.label}
                  </span>
                  <div className="min-w-0 leading-tight">
                    <h4 className={`truncate ${T.itemTitle}`}>{a.title}</h4>
                    <p className={`mt-0.5 truncate leading-tight ${T.itemMeta}`}>
                      {a.employee ? `${a.employee} · ` : ''}{a.location} · {a.duration}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.cameraId && (
                    <button
                      type="button"
                      onClick={() => setPreview(a)}
                      aria-label={`View feed clip — ${a.cameraName}`}
                      title="View Feed Clip"
                      className="flex h-11 w-11 items-center justify-center rounded-md border border-line text-fg-secondary transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-7 lg:w-7"
                    >
                      <Video className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAcked((s) => new Set(s).add(a.id))}
                    aria-label={`Acknowledge — ${a.title}`}
                    className="inline-flex min-h-11 items-center gap-1 rounded-md border border-line px-3 text-caption font-semibold text-fg-secondary transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:min-h-0 lg:px-2 lg:py-1"
                  >
                    <Check className="h-3 w-3" /> Ack
                  </button>
                </div>
              </div>
            );
          })}
          <Link
            to={logHref}
            className="block py-2.5 text-center text-caption font-semibold text-brand-ink transition hover:bg-brand/5"
          >
            View all {rows.length}{active === 'all' ? '' : ` ${CATEGORIES.find((c) => c.id === active).label.toLowerCase()}`} in Event Log →
          </Link>
        </div>
      )}

      {preview && <CameraPreviewModal source={preview} onClose={closePreview} />}
    </div>
  );
}
