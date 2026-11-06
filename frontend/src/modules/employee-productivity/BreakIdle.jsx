import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { Info, Search, X, Camera, ShieldCheck, ShieldAlert, BellRing, Filter, Smartphone } from 'lucide-react';
import { HoverText, MetaHover } from './MetaHover';
import { ACTIVITY, formatMin, incidentFlag, formatIsoDate, customRangeLabel, customRangeValid } from './break-idle';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/core/ui/tooltip';
import { QuickInsightsPopover } from './BreakInsights';

// Staff profile · Break & Idle. Everything here renders summarizeDay() output
// (./break-idle.js), so the header badges and the log rows cannot disagree.

const TONE_CLS = {
  success: { chip: 'bg-success-soft text-success-ink ring-success-line', dot: 'bg-success' },
  warning: { chip: 'bg-warning-soft text-warning-ink ring-warning-line', dot: 'bg-warning' },
  danger:  { chip: 'bg-danger-soft text-danger-ink ring-danger-line',    dot: 'bg-danger' },
  neutral: { chip: 'bg-surface-muted text-fg-muted ring-line',            dot: 'bg-neutral' },
};

/** Real-time status pill: pulsing dot while the state is live. */
export function LiveStatusBadge({ status }) {
  const t = TONE_CLS[status.tone] || TONE_CLS.neutral;
  const live = status.since && status.key !== 'left';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-semibold ring-1 ${t.chip}`}>
      <span className="relative flex h-1.5 w-1.5" aria-hidden>
        {live && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${t.dot}`} />}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${t.dot}`} />
      </span>
      {status.label}
      {status.since && <span className="font-normal opacity-80">· since {status.since}</span>}
    </span>
  );
}

/** Soft shift-policy badge: "Compliant" or "N policy exceptions". */
export function PolicyStatusBadge({ exceptions }) {
  const ok = exceptions === 0;
  const Icon = ok ? ShieldCheck : ShieldAlert;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-semibold ring-1 ${ok ? TONE_CLS.success.chip : TONE_CLS.warning.chip}`}>
      <Icon className="h-3 w-3" />
      {ok ? 'Compliant' : `${exceptions} policy exception${exceptions === 1 ? '' : 's'}`}
    </span>
  );
}

/**
 * "ⓘ Retail Policy" — the vertical's break / idle thresholds in a small card.
 * Opens on hover (for a glance) and on click / Enter (touch and keyboard), so
 * the rules are one gesture away without a banner holding page height for them.
 */
// `phone` is set where the log carries phone detections (the Activity Log),
// so the popover states the rule those rows are judged against rather than
// leaving it on a page that no longer exists.
export function PolicyRulesPopover({ limits, phone }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(null);
  const hoverOpen = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const hoverClose = () => { closeTimer.current = setTimeout(() => setOpen(false), 120); };

  const rules = [
    ['Max tea break', `${limits.teaMin} mins`],
    ['Max lunch break', `${limits.lunchMin} mins`],
    ['Max floor absence / idle', `${limits.idleMin} mins`],
    ...(phone ? [['Phone in hand — violation past', `${phone.violationSec}s`]] : []),
  ];

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          className="inline-flex h-11 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-caption font-semibold text-fg-subtle transition hover:bg-surface-sunken hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=open]:text-brand-ink lg:h-7"
        >
          <Info className="h-3.5 w-3.5" /> Policy
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          className="z-50 w-72 max-w-[calc(var(--app-vw)-2rem)] rounded-xl border border-line bg-surface p-3 text-left shadow-lg outline-none"
        >
          <p className="text-micro font-semibold uppercase tracking-wide text-fg-subtle">{phone ? 'Activity policy' : 'Break & idle policy'}</p>
          <dl className="mt-2 space-y-1.5">
            {rules.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <dt className="text-caption text-fg-muted">{k}</dt>
                <dd className="text-caption font-semibold tabular-nums text-fg">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2.5 flex gap-2 rounded-lg bg-danger-soft px-2.5 py-2 ring-1 ring-danger-line">
            <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-ink" />
            <p className="text-caption leading-snug text-danger-ink">
              <span className="font-semibold">Overstay action:</span> an alert flag is raised automatically {limits.graceMin} mins past a threshold.
            </p>
          </div>
          {phone && (
            <div className="mt-2 flex gap-2 rounded-lg bg-surface-sunken px-2.5 py-2 ring-1 ring-line">
              <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-muted" />
              <p className="text-caption leading-snug text-fg-secondary">
                <span className="font-semibold">Phone allowed:</span> {phone.allowed} Escalates after {phone.escalateAfter} violations in a shift.
              </p>
            </div>
          )}
          <PopoverPrimitive.Arrow className="fill-surface" width={10} height={5} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ── filter popover ──────────────────────────────────────────────────────────

const RANGE_CHOICES = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'shift', label: 'Current shift' },
  { key: 'custom', label: 'Custom' },
];
// Activity-type chips. The log can carry six event types, but a given page
// loads only some of them — the staff dossier has one person's day, the
// unified Activity Log has the whole floor's — so the chips are DERIVED from
// the events on screen rather than hard-coded. A page never offers a filter
// that would empty its own table.
//
// `breaks` is a group, not a type: it is what the old Breaks & Idle page
// showed, kept as one chip so that URL can redirect into the log and still
// mean what it meant. Tea, lunch and idle stay available beside it — they
// carry different limits, so "Breaks & idle" alone would hide why one of two
// equal-length stops was flagged.
const ACTIVITY_GROUPS = { breaks: ['tea', 'lunch', 'idle'] };
const ACTIVITY_LABELS = {
  breaks: 'Breaks & idle', tea: 'Tea break', lunch: 'Lunch break', idle: 'Floor idle',
  phone: 'Phone usage', unattended: 'Unattended', arrival: 'Clock-in',
};
const ACTIVITY_ORDER = ['breaks', 'tea', 'lunch', 'idle', 'phone', 'unattended', 'arrival'];

function activityChoices(events) {
  const present = new Set(events.map((e) => e.type));
  const inGroup = ACTIVITY_GROUPS.breaks.filter((t) => present.has(t)).length;
  return [
    { key: 'all', label: 'All' },
    ...ACTIVITY_ORDER
      // The group chip earns its place only where the log also carries types
      // outside it; on a break-only table it would just restate "All".
      .filter((k) => (k === 'breaks' ? inGroup > 0 && present.size > inGroup : present.has(k)))
      .map((k) => ({ key: k, label: ACTIVITY_LABELS[k] })),
  ];
}

/** Does this row pass the activity chip? A group chip matches any of its types. */
function matchesActivity(e, activity) {
  if (activity === 'all') return true;
  return ACTIVITY_GROUPS[activity]?.includes(e.type) ?? e.type === activity;
}

const STATUS_CHOICES = [
  { key: 'all', label: 'All' },
  { key: 'ok', label: 'Within policy' },
  { key: 'exception', label: 'Policy overstay' },
];
const DEFAULT_FILTERS = { range: 'today', activity: 'all', status: 'all' };

/** One row of choice chips inside a filter popover. Shared with Phone Usage. */
export function Segmented({ label, choices, value, onChange }) {
  return (
    <fieldset className="px-3 py-2.5">
      <legend className="float-left mb-1.5 w-full text-micro font-semibold uppercase tracking-wide text-fg-subtle">{label}</legend>
      <div className="clear-both flex flex-wrap gap-1">
        {choices.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
            className={`h-11 flex-1 whitespace-nowrap rounded-md border px-2 text-caption transition lg:h-7 ${value === o.key ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink' : 'border-line text-fg-secondary hover:border-brand/40'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * From / To date fields shown under a range picker when "Custom" is chosen.
 * `min` / `max` bound both inputs (the plan's retention window … today).
 */
export function CustomRangeFields({ from, to, min, max, onChange }) {
  const invalid = from && to && from > to;
  const field = 'h-11 w-full rounded-md border bg-surface px-2 text-caption text-fg-secondary outline-none focus:border-brand lg:h-8';
  return (
    <div className="px-3 pb-2.5">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-micro font-semibold uppercase tracking-wide text-fg-subtle">
          From
          <input
            type="date"
            value={from || ''}
            min={min}
            max={to || max}
            onChange={(e) => onChange({ from: e.target.value, to })}
            className={`mt-1 normal-case tracking-normal ${field} ${invalid ? 'border-danger' : 'border-line'}`}
          />
        </label>
        <label className="text-micro font-semibold uppercase tracking-wide text-fg-subtle">
          To
          <input
            type="date"
            value={to || ''}
            min={from || min}
            max={max}
            onChange={(e) => onChange({ from, to: e.target.value })}
            className={`mt-1 normal-case tracking-normal ${field} ${invalid ? 'border-danger' : 'border-line'}`}
          />
        </label>
      </div>
      <p className={`mt-1.5 text-[11px] ${invalid ? 'text-danger-ink' : 'text-fg-subtle'}`}>
        {invalid ? 'Start date must be on or before the end date.' : min ? `History is kept from ${formatIsoDate(min)}.` : null}
      </p>
    </div>
  );
}

/**
 * One Filter button for the log. Picks are a draft until Apply — the range
 * swaps which day loads, so it should not churn on every click. Outside click /
 * Esc close without applying (Radix), and each open starts from what is applied.
 */
// `withRange` false: the page owns the range elsewhere (the staff profile's
// timeframe bar), so the popover only filters within what is loaded.
function LogFilterPopover({ value, onApply, withRange = true, bounds = {}, choices }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const count = (withRange && value.range !== 'today' ? 1 : 0) + (value.activity !== 'all' ? 1 : 0) + (value.status !== 'all' ? 1 : 0);
  const draftIsDefault = (!withRange || draft.range === 'today') && draft.activity === 'all' && draft.status === 'all';
  const draftCustom = withRange && draft.range === 'custom';
  const canApply = !draftCustom || customRangeValid(draft.from, draft.to);
  // Picking Custom the first time pre-fills the last 7 days, so Apply works at once.
  const pickRange = (range) => set(range === 'custom' && !draft.from
    ? { range, from: bounds.defaultFrom, to: bounds.max }
    : { range });

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => { if (next) setDraft(value); setOpen(next); }}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={count ? `Filters, ${count} active` : 'Filters'}
          title={count ? `${count} filter${count === 1 ? '' : 's'} applied` : 'Filter events'}
          className={`relative inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-8 lg:px-2.5 ${
            count ? 'border-brand/50 bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-secondary hover:border-brand/40 hover:text-brand-ink'
          }`}
        >
          <Filter className="h-3.5 w-3.5" />
          <span>Filters</span>
          {count > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-bold tabular-nums text-white">{count}</span>}
          {count > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-brand ring-2 ring-surface" aria-hidden />}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-80 max-w-[calc(var(--app-vw)-2rem)] rounded-xl border border-line bg-surface text-left shadow-lg outline-none"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-small font-semibold text-fg">Filter events</p>
            <PopoverPrimitive.Close className="grid h-11 w-11 place-items-center rounded-md text-fg-subtle hover:bg-surface-sunken hover:text-fg lg:h-6 lg:w-6" aria-label="Close filters">
              <X className="h-3.5 w-3.5" />
            </PopoverPrimitive.Close>
          </div>
          <div className="divide-y divide-line-subtle">
            {withRange && (
              <div>
                <Segmented label="Shift / date" choices={RANGE_CHOICES} value={draft.range} onChange={pickRange} />
                {draftCustom && <CustomRangeFields from={draft.from} to={draft.to} min={bounds.min} max={bounds.max} onChange={set} />}
              </div>
            )}
            <Segmented label="Activity type" choices={choices} value={draft.activity} onChange={(activity) => set({ activity })} />
            <Segmented label="Compliance" choices={STATUS_CHOICES} value={draft.status} onChange={(status) => set({ status })} />
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
            <button
              type="button"
              onClick={() => setDraft({ ...DEFAULT_FILTERS, range: withRange ? DEFAULT_FILTERS.range : draft.range })}
              disabled={draftIsDefault}
              className="h-11 rounded-md px-1.5 text-caption font-semibold text-fg-muted transition hover:text-brand-ink disabled:opacity-40 lg:h-8"
            >
              Reset filters
            </button>
            <button
              type="button"
              onClick={() => { onApply(draft); setOpen(false); }}
              disabled={!canApply}
              className="h-11 rounded-lg bg-brand px-3 text-caption font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50 lg:h-8"
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

// ── log ─────────────────────────────────────────────────────────────────────

// Activity tag: the kind of stop, nothing else. Tea and lunch stay distinct —
// they carry different limits, so "On Break" alone would hide why one of two
// equal-length breaks was flagged. Where it happened is the Location column.
const ACTIVITY_TAG = {
  tea:   { cls: 'border-line-strong bg-surface-muted text-fg-secondary', label: 'Tea Break' },
  lunch: { cls: 'border-info-line bg-info-soft text-info-ink',           label: 'Lunch Break' },
  idle:  { cls: 'border-warning-line bg-warning-soft text-warning-ink',  label: 'Idle' },
  arrival:    { cls: 'border-line-strong bg-surface text-fg-secondary',       label: 'Clock-in' },
  unattended: { cls: 'border-warning-line bg-warning-soft text-warning-ink',  label: 'Unattended' },
  phone:      { cls: 'border-line-strong bg-surface-muted text-fg-secondary', label: 'Phone Usage' },
};

// Incident severity badge beside the activity tag — red = high (late arrival,
// unattended station), amber = medium (over-break, idle, phone). The dot is
// the red / amber flag at a glance; the words say which rule.
const SEVERITY = {
  high:   { cls: 'border-danger-line bg-danger-soft text-danger-ink',    dot: 'bg-danger',  label: 'High severity' },
  medium: { cls: 'border-warning-line bg-warning-soft text-warning-ink', dot: 'bg-warning', label: 'Medium severity' },
};

function FlagBadge({ flag }) {
  const s = SEVERITY[flag.severity];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${s.cls}`} title={s.label}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
      <span className="sr-only">{s.label}: </span>
      {flag.label}
    </span>
  );
}

// Policy: one badge. Amber = over the limit but inside the grace window (no
// alert yet); red = past the grace, alert raised. The limit itself is on the
// badge's hover and in the ⓘ policy card — not repeated under every duration.
const COMPLIANCE = {
  ok:      { cls: 'border-success-line bg-success-soft text-success-ink', text: () => 'Within Limits' },
  over:    { cls: 'border-warning-line bg-warning-soft text-warning-ink', text: (e) => `Overstayed (+${e.overMin}m)` },
  flagged: { cls: 'border-danger-line bg-danger-soft text-danger-ink',    text: (e) => `Overstayed (+${e.overMin}m)` },
};
// Instant rows (clock-in, camera alerts) have no duration to overstay.
function policyText(e) {
  if (e.type === 'arrival') return e.overMin ? `Late (+${e.overMin}m)` : 'On Time';
  if (e.instant) return 'Alert raised';
  return COMPLIANCE[e.compliance].text(e);
}

// Hover cards for a log row: every fact the cell no longer prints.
function timingRows(e, limits) {
  if (e.instant) {
    return [
      ['Date', formatIsoDate(e.date)],
      ['At', `${e.start} IST`],
      ['Held for', e.holdSec != null ? `${e.holdSec}s` : null],
      ['Limit', e.limitSec != null ? `${e.limitSec}s before it reads as a violation` : null],
      ['Detection confidence', e.confidence != null ? `${Math.round(e.confidence * 100)}%` : null],
      ['Late by', e.type === 'arrival' && e.overMin ? `${e.overMin} min` : null],
    ];
  }
  return [
    ['Started', `${e.start} IST`],
    ['Ended', e.ongoing ? 'Still running' : `${e.end} IST`],
    ['Elapsed', formatMin(e.durationMin)],
    ['Allowed', `${e.limitMin} min`],
    ['Grace', limits.graceMin ? `${limits.graceMin} min before an alert` : null],
    ['Over by', e.overMin ? `${e.overMin} min` : null],
  ];
}

function alertNote(e, limits) {
  if (e.type === 'arrival') return e.overMin ? 'Clock-in past the shift start + grace — flagged as a late arrival.' : 'Clocked in within the shift grace.';
  if (e.instant) return e.note || 'Alert raised by the camera.';
  if (e.compliance === 'flagged') return `Alert raised — more than ${limits.graceMin} min past the ${e.limitMin} min limit.`;
  if (e.compliance === 'over') return `Over the limit, still inside the ${limits.graceMin} min grace — no alert yet.`;
  return 'Within the allowed time.';
}

// "18 mins" / "1 min"; an hour or more keeps the compact "1h 05m".
function durationText(min) {
  const m = Math.max(0, Math.round(min));
  if (m >= 60) return formatMin(m);
  return `${m} min${m === 1 ? '' : 's'}`;
}

// Time-share segments — the log's badge language: break blue (like the Lunch
// badge), idle amber (like the Unplanned-idle badge), floor green.
const SHARE_SEG = [
  { key: 'activeMin', label: 'On floor', cls: 'bg-success', ink: 'text-success-ink' },
  { key: 'breakMin',  label: 'Break',    cls: 'bg-info',    ink: 'text-info-ink' },
  { key: 'idleMin',   label: 'Idle',     cls: 'bg-warning', ink: 'text-warning-ink' },
];

/** Slim on-floor / break / idle bar for the team log's Employee cell; exact split on hover. */
function TimeShareBar({ share }) {
  const total = share.activeMin + share.breakMin + share.idleMin;
  if (!total) return null;
  const pct = (min) => Math.round((min / total) * 100);
  const summary = SHARE_SEG.map((s) => `${s.label}: ${pct(share[s.key])}%`).join(' | ');
  return (
    <Tooltip delayDuration={120}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={`Time share — ${summary}`}
          className="mt-1.5 flex h-1.5 w-28 cursor-help overflow-hidden rounded-full bg-surface-muted outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          {SHARE_SEG.map((s) => (share[s.key] ? <span key={s.key} className={s.cls} style={{ width: `${(share[s.key] / total) * 100}%` }} /> : null))}
        </span>
      </TooltipTrigger>
      <TooltipContent variant="card" side="right" align="center" sideOffset={8} collisionPadding={12} className="w-56 rounded-xl !border-line !bg-surface p-3 text-left !text-fg shadow-lg backdrop-blur-none [&_svg]:!bg-surface [&_svg]:!fill-surface">
        <p className="text-micro font-semibold uppercase tracking-wide text-fg-muted">Time share · this range</p>
        <dl className="mt-1.5 space-y-1">
          {SHARE_SEG.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <i className={`h-2 w-2 shrink-0 rounded-sm ${s.cls}`} />
              <dt className="flex-1 text-caption text-fg-secondary">{s.label}</dt>
              <dd className={`text-caption font-semibold tabular-nums ${s.ink}`}>{pct(share[s.key])}%</dd>
              <dd className="w-14 text-right text-micro tabular-nums text-fg-subtle">{formatMin(share[s.key])}</dd>
            </div>
          ))}
        </dl>
        {share.exceptions > 0 && (
          <p className="mt-2 border-t border-line-subtle pt-1.5 text-micro font-semibold text-danger-ink">
            {share.exceptions} policy overstay{share.exceptions === 1 ? '' : 's'}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The page's primary content: one row per break or idle event. Its toolbar is
 * the only control row on the page — title, policy popover, one Filter button,
 * search — so the table sits directly under the employee header.
 *
 * The range (which day loads) is owned by the page; activity / compliance /
 * search are table-local. Both are set through the one Filter popover.
 *
 * Used twice: on one person's staff profile, and on the team Breaks & Idle
 * page with `showEmployee` — an Employee column (linking to the profile, with
 * the person's time-share bar when events carry `employeeShare`) and names in
 * the search. `subject` names who the empty state is about.
 */
// `roomy`: the single-employee page's spacing — 24px gutters on the toolbar,
// the empty state and the table's outer columns. The team page stays dense.
// `title` / `rangeLabel`: the staff profile calls this an Activity Log and owns
// its range (no `onRange` — the Shift / date filter is hidden then).
export function BreakIdleLog({ events, limits, isRetail, range, customRange, rangeBounds, onRange, rangeLabel: rangeLabelProp, title = 'Break & Idle Log', subject, showEmployee = false, fill = false, roomy = false, selectedId = null, onSelect, onPreview, activity: activityProp, onActivity, phone }) {
  const [activityState, setActivityState] = useState('all');
  // The activity chip is uncontrolled by default. The Activity Log passes it
  // down from ?type= so the filter is linkable and survives a reload.
  const ownsActivity = typeof onActivity === 'function';
  const choices = useMemo(() => activityChoices(events), [events]);
  const requested = ownsActivity ? activityProp : activityState;
  // A chip the loaded events cannot satisfy — a stale bookmark, a hand-edited
  // ?type= — widens to All rather than showing an empty table.
  const activity = choices.some((c) => c.key === requested) ? requested : 'all';
  const setActivity = ownsActivity ? onActivity : setActivityState;
  // "All Logs" vs "Flagged Only" — incidents are rows of this table, not a
  // second list; the tab just narrows to the ones incidentFlag() marks.
  const [view, setView] = useState('all');
  const ownsRange = typeof onRange === 'function';
  // Team view: a row click selects its person, highlighting all their rows.
  const selectable = showEmployee && typeof onSelect === 'function';
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  // Team view: the person hovered in the Quick Insights card — their rows glow.
  const [peekId, setPeekId] = useState(null);
  const tableRef = useRef(null);
  const peek = (id) => {
    setPeekId(id);
    if (id) tableRef.current?.querySelector(`tr[data-emp="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) =>
      matchesActivity(e, activity) &&
      (status === 'all' || (status === 'ok' ? e.compliance === 'ok' : e.compliance !== 'ok')) &&
      (!q || [e.location, e.cameraId, e.note, ACTIVITY[e.type]?.label, ACTIVITY_TAG[e.type]?.label, incidentFlag(e)?.label, e.employeeName].some((v) => String(v || '').toLowerCase().includes(q))));
  }, [events, activity, status, query]);
  const flaggedRows = useMemo(() => rows.filter((e) => incidentFlag(e)), [rows]);
  const shown = view === 'flagged' ? flaggedRows : rows;
  // More than one day loaded → the Time cell carries the date too.
  const multiDay = useMemo(() => new Set(events.map((e) => e.date)).size > 1, [events]);

  const applyFilters = (f) => { if (ownsRange) onRange(f.range, f.range === 'custom' ? { from: f.from, to: f.to } : customRange); setActivity(f.activity); setStatus(f.status); };
  const resetAll = () => { if (ownsRange) onRange('today'); setActivity('all'); setStatus('all'); setQuery(''); setView('all'); };

  const filtered = (ownsRange && range !== 'today') || activity !== 'all' || status !== 'all' || query || view !== 'all';
  const locationLabel = isRetail ? 'Location / counter' : 'Location / zone';
  const rangeLabel = rangeLabelProp
    || (range === 'custom' ? customRangeLabel(customRange?.from, customRange?.to) : RANGE_CHOICES.find((o) => o.key === range)?.label)
    || 'Today';

  return (
    // fill: from xl the card takes its container's full height and the table
    // body scrolls inside it (the team page locks to the viewport).
    <section className={`overflow-hidden rounded-xl border border-line bg-surface shadow-sm ${fill ? 'xl:flex xl:h-full xl:min-h-0 xl:flex-col' : ''}`}>
      {/* Toolbar — title + policy, then the Filter button and search */}
      <div className={`flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line ${roomy ? 'p-4 sm:px-6 sm:py-5' : 'p-3 sm:p-4'}`}>
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="whitespace-nowrap text-sm font-semibold text-fg sm:text-base">{title}</h2>
          <span className="min-w-[1.5rem] rounded-full bg-surface-muted px-2 py-0.5 text-center text-caption font-semibold tabular-nums text-fg-secondary ring-1 ring-line">{shown.length}</span>
          <span className="hidden whitespace-nowrap text-caption text-fg-subtle sm:inline">· {rangeLabel}</span>
        </div>
        <PolicyRulesPopover limits={limits} phone={phone} />
        <span className="flex-1" />
        <LogFilterPopover value={{ range, from: customRange?.from, to: customRange?.to, activity, status }} onApply={applyFilters} withRange={ownsRange} bounds={rangeBounds} choices={choices} />
        {showEmployee && (
          <QuickInsightsPopover
            events={events}
            rangeLabel={rangeLabel}
            limits={limits}
            onPeek={peek}
            onSelect={selectable ? (id) => { onSelect(id); peek(id); setPeekId(null); } : undefined}
            onViewFlagged={() => setView('flagged')}
          />
        )}
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isRetail ? 'Search store section, counter or reason…' : 'Search location, zone or reason…'}
            aria-label={isRetail ? 'Search store section, counter or reason' : 'Search location, zone or reason'}
            className="h-11 w-full rounded-lg border border-line bg-surface pl-8 pr-9 text-[12px] text-fg-secondary outline-none focus:border-brand lg:h-8"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-0 top-0 flex h-full w-9 items-center justify-center text-fg-subtle hover:text-fg-secondary">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Incidents & Flags — the same rows, narrowed to the flagged ones */}
      <div role="tablist" aria-label="Incidents and flags" className={`flex shrink-0 items-center gap-1 border-b border-line ${roomy ? 'px-4 sm:px-6' : 'px-3 sm:px-4'}`}>
        {[
          { key: 'all', label: 'All Logs', count: rows.length },
          { key: 'flagged', label: 'Flagged Only', count: flaggedRows.length },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={view === t.key}
            onClick={() => setView(t.key)}
            className={`-mb-px inline-flex h-11 items-center gap-1.5 whitespace-nowrap border-b-2 px-2 text-small font-semibold transition lg:h-10 ${
              view === t.key ? 'border-brand text-brand-ink' : 'border-transparent text-fg-muted hover:text-fg-secondary'
            }`}
          >
            {t.key === 'flagged' && <BellRing className="h-3.5 w-3.5" aria-hidden />}
            {t.label}
            <span className={`rounded-full px-1.5 text-caption tabular-nums ${
              t.key === 'flagged' && t.count ? 'bg-danger-soft text-danger-ink' : 'bg-surface-muted text-fg-muted'
            }`}>{t.count}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className={`rounded-lg bg-surface-sunken px-3 py-6 text-center text-small text-fg-subtle ${roomy ? 'm-4 sm:m-6' : 'm-3'}`}>
          {events.length === 0
            ? `No activity recorded for ${subject} (${rangeLabel.toLowerCase()}).`
            : view === 'flagged' && rows.length
              ? `No flagged incidents for ${subject} in this view.`
              : 'No events match these filters.'}
          {filtered && (
            <button type="button" onClick={resetAll} className="ml-1 font-semibold text-brand-ink hover:underline">Reset filters</button>
          )}
        </p>
      ) : (
        <div ref={tableRef} className={`scrollbar-thin w-full max-h-[calc(var(--app-vh)-220px)] overflow-auto ${fill ? 'xl:max-h-none xl:min-h-0 xl:flex-1' : ''}`}>
          {/* table-auto with a floor per column and an 850px minimum overall:
              columns size to their content, nothing wraps or overlaps, and a
              card narrower than the table scrolls sideways inside itself. */}
          <table className={`w-full min-w-[850px] table-auto border-collapse text-left ${roomy ? 'sm:[&_td:first-child]:pl-6 sm:[&_td:last-child]:pr-6 sm:[&_th:first-child]:pl-6 sm:[&_th:last-child]:pr-6' : ''}`}>
            <thead>
              <tr>
                <th className={`${thCls} min-w-[150px]`}>Time</th>
                {showEmployee && <th className={`${thCls} min-w-[180px]`}>Employee</th>}
                <th className={`${thCls} min-w-[160px]`}>Activity</th>
                <th className={`${thCls} min-w-[130px]`}>Duration</th>
                <th className={`${thCls} min-w-[150px]`}>{locationLabel}</th>
                <th className={`${thCls} min-w-[160px]`}>Policy</th>
                <th className={`${thCls} w-16 text-center`}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {shown.map((e) => {
                const c = COMPLIANCE[e.compliance];
                const flag = incidentFlag(e);
                return (
                  <tr
                    key={e.id}
                    data-emp={e.employeeId}
                    onClick={selectable ? () => onSelect(e.employeeId === selectedId ? null : e.employeeId) : undefined}
                    aria-selected={selectable ? e.employeeId === selectedId : undefined}
                    className={`transition ${selectable ? 'cursor-pointer' : ''} ${
                      peekId && e.employeeId === peekId
                        ? 'bg-warning-soft shadow-[inset_3px_0_0_var(--warning)]'
                        : selectedId && e.employeeId === selectedId
                        ? 'bg-brand-soft/60 shadow-[inset_3px_0_0_var(--brand)] hover:bg-brand-soft'
                        : 'hover:bg-surface-sunken'
                    }`}
                  >
                    <td className={`${tdCls} whitespace-nowrap ${primaryCls} tabular-nums`}>
                      {e.instant ? e.start : <>{e.start} – {e.ongoing ? <span className="text-brand-ink">now</span> : e.end}</>}
                      {multiDay && <span className={`block ${secondaryCls}`}>{formatIsoDate(e.date)}</span>}
                    </td>
                    {showEmployee && (
                      <td className={tdCls}>
                        <MetaHover
                          title={e.employeeName}
                          rows={[
                            ['Role', e.employeeRole],
                            ['Shift', e.employeeShift],
                            ['Home zone', e.employeeZone],
                          ]}
                          note="Click the name to open their profile."
                        >
                          <Link
                            to={`/activity-monitoring/employee/${e.employeeId}`}
                            onClick={(ev) => ev.stopPropagation()}
                            className={`block whitespace-nowrap ${primaryCls} hover:text-brand-ink`}
                          >
                            {e.employeeName}
                          </Link>
                        </MetaHover>
                        {e.employeeRole && <span className={`block whitespace-nowrap ${secondaryCls}`}>{e.employeeRole}</span>}
                        {e.employeeShare && <TimeShareBar share={e.employeeShare} />}
                      </td>
                    )}
                    <td className={tdCls}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <MetaHover
                          title={ACTIVITY[e.type].label}
                          rows={[['Reason', e.note || null], ['Location', e.location]]}
                        >
                          <span tabIndex={0} className={`inline-block cursor-help whitespace-nowrap rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${badgeCls} ${ACTIVITY_TAG[e.type].cls}`}>
                            {ACTIVITY_TAG[e.type].label}
                          </span>
                        </MetaHover>
                        {flag && <FlagBadge flag={flag} />}
                      </div>
                    </td>
                    <td className={`${tdCls} whitespace-nowrap tabular-nums`}>
                      <MetaHover title="Timing" rows={timingRows(e, limits)}>
                        {/* Instant rows have no span — except a phone detection,
                            whose hold time IS the measurement, in seconds. */}
                        <HoverText className={valueCls}>{e.instant ? (e.holdSec != null ? `${e.holdSec}s` : '—') : durationText(e.durationMin)}</HoverText>
                      </MetaHover>
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>
                      <MetaHover title={e.location} rows={[['Camera', e.cameraId || null]]}>
                        <HoverText className={valueCls}>{e.location}</HoverText>
                      </MetaHover>
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>
                      <MetaHover title="Policy" rows={timingRows(e, limits).slice(3)} note={alertNote(e, limits)}>
                        <span tabIndex={0} className={`inline-flex cursor-help items-center gap-1 whitespace-nowrap rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${badgeCls} ${c.cls}`}>
                          {e.compliance === 'flagged' && <BellRing className="h-3 w-3" aria-hidden />}
                          {policyText(e)}
                        </span>
                      </MetaHover>
                    </td>
                    <td className={`${tdCls} w-16 text-center`}>
                      {e.cameraId && (
                        <MetaHover side="left" align="center" note={`View event footage (${e.cameraId} · ${e.start} IST)`}>
                          <button
                            type="button"
                            onClick={(ev) => { ev.stopPropagation(); onPreview(e); }}
                            aria-label={`View event footage — ${e.location}, ${e.cameraId} at ${e.start}`}
                            className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-line text-fg-secondary transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-7 lg:w-7"
                          >
                            <Camera className="h-3.5 w-3.5" />
                          </button>
                        </MetaHover>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Header band: sticky, its bottom hairline an inset shadow so it sticks with
// the cell (a border-collapse border would stay on the scrolled row). The tint
// is muted at 50% MIXED onto the card surface — the same colour as
// `bg-muted/50`, but opaque, so rows scrolling under it don't show through.
// High-density cells: py-2.5 px-3.5.
const tdCls = 'px-3.5 py-2.5 align-middle';
const thCls = 'sticky top-0 z-10 bg-[color-mix(in_oklab,var(--muted)_50%,var(--surface))] px-3.5 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground shadow-[inset_0_-1px_0_var(--line)]';
// Each cell says one thing: time and name 14px semibold, other values 14px
// medium, the role 12px muted, badges 12px.
const primaryCls = 'text-sm font-semibold text-foreground';
const valueCls = 'text-sm font-medium text-foreground';
const secondaryCls = 'text-xs text-muted-foreground';
const badgeCls = 'px-2.5 py-1 text-xs font-medium';
