import { useEffect, useMemo, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import {
  ArrowRight, BarChart3, BellRing, CalendarDays, Clock, ScrollText, ShieldCheck, TriangleAlert, Users, X,
} from 'lucide-react';
import { formatMin } from './break-idle';

// Breaks & Idle · Quick Insights. A glance-card over the team log that answers
// three questions in plain words, each with one simple visual:
//   Who needs a follow-up?      one card per person: allowed vs what they took
//   When do overstays happen?   overstays per hour, filterable by break type
//   Where did the time go?      away / lunch / tea, direct-labelled bars
// Reads the same events the log renders (summarizeDay() rows), so its numbers
// are the table's numbers.
//
// Opens on hover (200ms delay, so passing the cursor over it does nothing) and
// on click. A click pins it open — then leaving the trigger doesn't close it,
// and the people can be hovered to highlight their log rows (`onPeek`).

// Colours match the log's activity badges: idle amber, lunch blue, tea grey.
const KINDS = [
  { key: 'idle',  label: 'Away from post', short: 'Away',  cls: 'bg-warning' },
  { key: 'lunch', label: 'Lunch break',    short: 'Lunch', cls: 'bg-info' },
  { key: 'tea',   label: 'Tea break',      short: 'Tea',   cls: 'bg-neutral' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.key, k.label]));

const OPEN_DELAY = 200;
const CLOSE_DELAY = 150;
const MAX_PEOPLE = 4;

const hourOf = (e) => Number(e.start.slice(0, 2));

/** Everything the card shows, from the loaded break / idle events. */
function breakInsights(events) {
  const stops = events.filter((e) => KIND_LABEL[e.type]);
  const violations = stops.filter((e) => e.compliance !== 'ok');

  // Per person: their single worst event, and how many times they went over.
  const byEmp = new Map();
  for (const e of violations) {
    const p = byEmp.get(e.employeeId) || { id: e.employeeId, name: e.employeeName, role: e.employeeRole, count: 0, worst: e };
    p.count += 1;
    if (e.overMin > p.worst.overMin) p.worst = e;
    byEmp.set(e.employeeId, p);
  }
  const people = [...byEmp.values()].sort((a, b) => b.worst.overMin - a.worst.overMin);

  const mix = KINDS.map((k) => ({ ...k, min: stops.filter((e) => e.type === k.key).reduce((s, e) => s + e.durationMin, 0) }));
  const mixTotal = mix.reduce((s, k) => s + k.min, 0);

  // Every hour the range has events in — the chart's x-axis, whatever the filter.
  const hours = stops.map(hourOf);
  const hourSpan = hours.length ? [Math.min(...hours), Math.max(...hours)] : null;

  return {
    people, mix, mixTotal, violations, hourSpan,
    alerts: violations.filter((e) => e.compliance === 'flagged').length,
    idleMin: mix.find((k) => k.key === 'idle').min,
  };
}

/** Overstays per start hour, over `span`, and the worst hour. */
function hourlyOverstays(violations, span) {
  const hourly = [];
  for (let h = span[0]; h <= span[1]; h += 1) {
    const inHour = violations.filter((e) => hourOf(e) === h);
    hourly.push({ hour: h, count: inHour.length, overMin: inHour.reduce((s, e) => s + e.overMin, 0) });
  }
  const peak = hourly.reduce((best, b) => (b.count > (best?.count || 0) || (best && b.count === best.count && b.overMin > best.overMin) ? b : best), null);
  return { hourly, peak: peak?.count ? peak : null };
}

// 13 → "1 PM"
const hour12 = (h) => `${h % 12 || 12} ${h % 24 < 12 ? 'AM' : 'PM'}`;
const initials = (name = '') => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

function SectionTitle({ children, sub, aside }) {
  return (
    <div className="mb-2.5 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-fg">{children}</p>
        {sub && <p className="text-[11px] text-fg-muted">{sub}</p>}
      </div>
      {aside}
    </div>
  );
}

// Tile tints — the colour says whether the number is a problem.
const TILE = {
  danger:  { box: 'bg-danger-soft/60 ring-danger-line',   chip: 'bg-danger-soft text-danger-ink',   value: 'text-danger-ink' },
  warning: { box: 'bg-warning-soft/60 ring-warning-line', chip: 'bg-warning-soft text-warning-ink', value: 'text-warning-ink' },
  success: { box: 'bg-success-soft/60 ring-success-line', chip: 'bg-success-soft text-success-ink', value: 'text-success-ink' },
  neutral: { box: 'bg-surface-sunken ring-line',          chip: 'bg-surface-muted text-fg-muted',   value: 'text-fg' },
};

/** Icon chip, big number, one-line label. */
function Tile({ icon: Icon, value, label, tone = 'neutral' }) {
  const t = TILE[tone];
  return (
    <div className={`rounded-xl p-3 ring-1 ${t.box}`}>
      <span className={`grid h-7 w-7 place-items-center rounded-lg ${t.chip}`} aria-hidden><Icon className="h-3.5 w-3.5" /></span>
      <p className={`mt-2.5 text-xl font-bold leading-none tabular-nums ${t.value}`}>{value}</p>
      <p className="mt-1 text-[11px] font-medium text-fg-muted">{label}</p>
    </div>
  );
}

/**
 * One person who went over: who, a plain sentence, and a bar where the grey
 * part is the time allowed and the red / amber part is the time over it. Bars
 * share one scale (`maxMin`), so a longer bar is a longer absence.
 */
function PersonCard({ p, maxMin, graceMin, onPeek, onShow }) {
  const w = p.worst;
  const flagged = w.compliance === 'flagged';
  const graceLeft = Math.max(0, graceMin - w.overMin);
  return (
    <li
      onMouseEnter={() => onPeek(p.id)}
      onMouseLeave={() => onPeek(null)}
      className={`rounded-xl border bg-surface p-3 transition hover:shadow-sm ${flagged ? 'border-line hover:border-danger-line' : 'border-warning-line bg-warning-soft/30'}`}
    >
      <div className="flex items-start gap-2.5">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold ${flagged ? 'bg-danger-soft text-danger-ink' : 'bg-warning-soft text-warning-ink'}`} aria-hidden>
          {initials(p.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-caption font-semibold text-fg">
              {p.name}{p.role && <span className="font-normal text-fg-muted"> · {p.role}</span>}
            </p>
            <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold tabular-nums ring-1 ${flagged ? 'bg-danger-soft text-danger-ink ring-danger-line' : 'bg-warning-soft text-warning-ink ring-warning-line'}`}>
              +{w.overMin}m{!flagged && ' grace'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-fg-muted">
            {KIND_LABEL[w.type]} <span className="font-semibold text-fg-secondary">{formatMin(w.durationMin)}</span> at {w.start} · limit {w.limitMin}m
            {p.count > 1 && <span className="font-semibold text-fg-secondary"> · {p.count}× in range</span>}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex h-2 gap-0.5" aria-hidden>
        <span className="rounded-l-full bg-neutral/35" style={{ width: `${(w.limitMin / maxMin) * 100}%` }} />
        <span className={`rounded-r-full ${flagged ? 'bg-danger' : 'bg-warning'}`} style={{ width: `${Math.max(1.5, (w.overMin / maxMin) * 100)}%` }} />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line-subtle pt-2">
        {flagged ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger-ink">
            <BellRing className="h-3 w-3" /> Alert raised
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-warning-ink">
            <Clock className="h-3 w-3" /> In grace · {graceLeft}m left
          </span>
        )}
        <button
          type="button"
          onClick={() => onShow(p.id)}
          className="inline-flex h-11 items-center gap-1 rounded-md px-2 text-[11px] font-semibold text-fg-secondary transition hover:bg-surface-sunken hover:text-brand-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-7"
        >
          <ScrollText className="h-3.5 w-3.5" /> Show in log
        </button>
      </div>
    </li>
  );
}

function Legend() {
  return (
    <p className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-fg-muted">
      <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-neutral/50" /> Allowed</span>
      <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-danger" /> Over, alert raised</span>
      <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-warning" /> Over, in grace</span>
    </p>
  );
}

/** Overstays per hour, one break type or all: the worst hour in red, labelled. */
function PeakHours({ violations, span }) {
  const [kind, setKind] = useState('all');
  const picked = kind === 'all' ? violations : violations.filter((e) => e.type === kind);
  const { hourly, peak } = hourlyOverstays(picked, span);
  const max = Math.max(1, ...hourly.map((b) => b.count));
  const every = Math.ceil(hourly.length / 7);
  const share = peak && picked.length ? Math.round((peak.count / picked.length) * 100) : 0;
  const tabs = [{ key: 'all', short: 'All types', n: violations.length }, ...KINDS.map((k) => ({ ...k, n: violations.filter((e) => e.type === k.key).length }))];

  return (
    <section className="rounded-2xl bg-surface-sunken p-3.5 ring-1 ring-line">
      <SectionTitle
        sub="Overstays by the hour they started"
        aside={peak && (
          <span className="shrink-0 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger-ink ring-1 ring-danger-line">
            Busiest {hour12(peak.hour)} – {hour12(peak.hour + 1)}
          </span>
        )}
      >
        When overstays happen
      </SectionTitle>

      <div role="radiogroup" aria-label="Break type" className="mb-3 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="radio"
            aria-checked={kind === t.key}
            disabled={t.key !== 'all' && !t.n}
            onClick={() => setKind(t.key)}
            className={`inline-flex h-11 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold transition disabled:opacity-40 lg:h-7 ${
              kind === t.key ? 'bg-surface text-fg shadow-sm ring-1 ring-line-strong' : 'text-fg-muted hover:text-fg'
            }`}
          >
            {t.short}
            <span className="tabular-nums text-fg-subtle">{t.n}</span>
          </button>
        ))}
      </div>

      <div className="rounded-xl bg-surface p-3 ring-1 ring-line">
        {peak ? (
          <>
            <div className="flex h-24 items-end gap-1">
              {hourly.map((b) => {
                const isPeak = b.hour === peak.hour;
                return (
                  <div
                    key={b.hour}
                    className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                    title={`${hour12(b.hour)} – ${hour12(b.hour + 1)}: ${b.count} overstay${b.count === 1 ? '' : 's'}${b.overMin ? `, ${b.overMin} min over in total` : ''}`}
                  >
                    {b.count > 0 && (
                      isPeak
                        ? <span className="mb-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold tabular-nums text-white">{b.count}</span>
                        : <span className="mb-0.5 text-[10px] font-semibold tabular-nums text-fg-muted">{b.count}</span>
                    )}
                    <span
                      className={`block w-full max-w-10 rounded-md transition group-hover:opacity-80 ${b.count ? (isPeak ? 'bg-danger' : 'bg-danger/30') : 'bg-surface-muted'}`}
                      style={{ height: b.count ? `${(b.count / max) * 72}%` : '3px' }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex gap-1 border-t border-line pt-1.5">
              {hourly.map((b, i) => (
                <span
                  key={b.hour}
                  className={`min-w-0 flex-1 whitespace-nowrap text-center text-[10px] tabular-nums ${b.hour === peak.hour ? 'font-bold text-fg' : 'text-fg-subtle'}`}
                >
                  {i % every === 0 || b.hour === peak.hour ? hour12(b.hour) : ''}
                </span>
              ))}
            </div>
            <p className="mt-2.5 flex items-center justify-between gap-2 border-t border-line-subtle pt-2 text-[11px] text-fg-muted">
              <span>Peak hour <span className="font-semibold text-fg">{hour12(peak.hour)} – {hour12(peak.hour + 1)}</span></span>
              <span className="font-semibold text-danger-ink">{share}% of these overstays</span>
            </p>
          </>
        ) : (
          <p className="py-6 text-center text-[11px] text-fg-muted">No overstays of this type.</p>
        )}
      </div>
    </section>
  );
}

/** Away / lunch / tea: label and value on one line, the bar under it. */
function TimeSplit({ mix, total }) {
  const pct = (min) => (total ? Math.round((min / total) * 100) : 0);
  return (
    <section>
      <SectionTitle aside={<p className="text-[11px] text-fg-muted">Total <span className="font-semibold text-fg">{formatMin(total)}</span></p>}>
        Where the time went
      </SectionTitle>
      <ul className="space-y-3 rounded-2xl p-3.5 ring-1 ring-line">
        {mix.map((k) => (
          <li key={k.key} title={`${k.label}: ${formatMin(k.min)} (${pct(k.min)}%)`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 text-caption font-medium text-fg">
                <i className={`h-2 w-2 rounded-full ${k.cls}`} aria-hidden /> {k.label}
              </span>
              <span className="text-caption tabular-nums">
                <span className="font-semibold text-fg">{formatMin(k.min)}</span>
                <span className="text-fg-subtle"> · {pct(k.min)}%</span>
              </span>
            </div>
            <span className="mt-1.5 block h-2 rounded-full bg-surface-muted">
              <span className={`block h-full rounded-full ${k.cls}`} style={{ width: `${pct(k.min)}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The limits every number above was measured against. */
function PolicyFooter({ limits }) {
  if (!limits) return null;
  const rules = [['Tea', limits.teaMin], ['Lunch', limits.lunchMin], ['Away', limits.idleMin], ['Grace', limits.graceMin]];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-surface-sunken px-3 py-2.5 ring-1 ring-line">
      <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-fg">
        <ShieldCheck className="h-3.5 w-3.5 text-fg-muted" /> Policy applied
      </span>
      <span className="ml-auto flex flex-wrap gap-1">
        {rules.map(([k, v]) => (
          <span key={k} className="rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted ring-1 ring-line">
            {k} <span className="font-semibold tabular-nums text-fg">{v}m</span>
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * The "Insights" button beside the log's Filter button, and its card.
 *   onPeek(employeeId | null)  the person under the cursor in the card
 *   onSelect(employeeId)       [Show in log] — select that person's rows
 *   onViewFlagged()            [View flagged log] — switch the log's tab
 */
export function QuickInsightsPopover({ events, rangeLabel, limits, onPeek, onSelect, onViewFlagged }) {
  const data = useMemo(() => breakInsights(events), [events]);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const close = () => { clearTimeout(timer.current); setOpen(false); setPinned(false); onPeek(null); };
  const hoverOpen = () => { clearTimeout(timer.current); if (!open) timer.current = setTimeout(() => setOpen(true), OPEN_DELAY); };
  const hoverClose = () => { clearTimeout(timer.current); if (!pinned) timer.current = setTimeout(close, CLOSE_DELAY); };
  // Click: pins a hover-opened card, opens a closed one pinned, closes a pinned one.
  const onTriggerClick = (ev) => {
    ev.preventDefault();          // skip Radix's own toggle — this decides
    clearTimeout(timer.current);
    if (open && pinned) close();
    else { setOpen(true); setPinned(true); }
  };
  const showInLog = (id) => { close(); onSelect?.(id); };
  const viewFlagged = () => { close(); onViewFlagged?.(); };

  const count = data.violations.length;
  const flagged = count > 0;
  const shownPeople = data.people.slice(0, MAX_PEOPLE);
  const maxMin = Math.max(1, ...shownPeople.map((p) => p.worst.limitMin + p.worst.overMin));
  const isToday = rangeLabel === 'Today' || rangeLabel === 'Current shift';

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          onClick={onTriggerClick}
          aria-label={flagged ? `Quick insights, ${count} policy overstays` : 'Quick insights'}
          className={`relative inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-[12px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:h-8 lg:px-2.5 ${
            open ? 'border-brand/50 bg-brand-soft text-brand-ink' : 'border-line bg-surface text-fg-secondary hover:border-brand/40 hover:text-brand-ink'
          }`}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          <span>Insights</span>
          {flagged && (
            <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-danger ring-2 ring-surface" />
            </span>
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-insights-pop
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onMouseEnter={() => clearTimeout(timer.current)}
          onMouseLeave={hoverClose}
          onOpenAutoFocus={(ev) => ev.preventDefault()}   // a hover-open must not steal focus from the page
          // Height is capped to the room Radix measured between the trigger and
          // the viewport edge, so the card never runs off-screen; its body
          // scrolls under a pinned header instead.
          className="scrollbar-thin z-50 max-h-[var(--radix-popover-content-available-height)] w-[440px] max-w-[calc(var(--app-vw)-2rem)] overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface text-left shadow-2xl outline-none"
        >
          {/* Header — sticks while the body scrolls */}
          <div className="sticky top-0 z-10 border-b border-line bg-surface px-5 pb-3 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-bold leading-tight text-fg">{rangeLabel} at a glance</p>
                <p className="mt-0.5 text-caption text-fg-muted">Breaks &amp; idle time against policy</p>
              </div>
              <button type="button" onClick={close} className="grid h-11 w-11 place-items-center rounded-md text-fg-subtle hover:bg-surface-sunken hover:text-fg lg:h-7 lg:w-7" aria-label="Close insights">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-sunken px-2.5 py-1 text-caption font-semibold text-fg-secondary ring-1 ring-line">
                <CalendarDays className="h-3.5 w-3.5 text-fg-muted" /> {rangeLabel}
              </span>
              {isToday && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-semibold text-success-ink ring-1 ring-success-line">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden /> Live
                </span>
              )}
            </div>
          </div>

          <div className="space-y-5 px-5 pb-5 pt-4">
            <div className="grid grid-cols-3 gap-2">
              <Tile icon={TriangleAlert} value={count} label="Overstays" tone={flagged ? 'danger' : 'success'} />
              <Tile icon={Users} value={data.people.length} label="People over limit" tone={data.people.length ? 'warning' : 'neutral'} />
              <Tile icon={Clock} value={formatMin(data.idleMin)} label="Away from post" tone={data.idleMin ? 'warning' : 'neutral'} />
            </div>

            {shownPeople.length ? (
              <section>
                <SectionTitle
                  sub={data.alerts ? `${data.alerts} alert${data.alerts === 1 ? '' : 's'} raised · worst overstay first` : 'Worst overstay first'}
                  aside={onViewFlagged && (
                    <button type="button" onClick={viewFlagged} className="inline-flex h-11 shrink-0 items-center gap-1 text-caption font-semibold text-brand-ink hover:underline lg:h-auto">
                      View flagged log <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                >
                  Needs a follow-up
                </SectionTitle>
                <ul className="space-y-2">
                  {shownPeople.map((p) => (
                    <PersonCard key={p.id} p={p} maxMin={maxMin} graceMin={limits?.graceMin ?? 5} onPeek={onPeek} onShow={showInLog} />
                  ))}
                </ul>
                {data.people.length > shownPeople.length && (
                  <p className="mt-2 text-center text-[11px] text-fg-muted">+{data.people.length - shownPeople.length} more in the flagged log</p>
                )}
                <Legend />
              </section>
            ) : (
              <p className="flex items-center gap-2 rounded-xl bg-success-soft px-3 py-3 text-caption font-semibold text-success-ink ring-1 ring-success-line">
                <ShieldCheck className="h-4 w-4" /> Everyone stayed within policy.
              </p>
            )}

            {flagged && data.hourSpan && <PeakHours violations={data.violations} span={data.hourSpan} />}
            <TimeSplit mix={data.mix} total={data.mixTotal} />
            <PolicyFooter limits={limits} />
          </div>

          <PopoverPrimitive.Arrow className="fill-surface" width={10} height={5} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
