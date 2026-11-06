import { useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/core/ui/dialog';
import { shiftIsoDate } from '../break-idle';
import ExportReportMenu from '../ExportReportMenu';
import { exportReportDocument } from '../report-document';
import { dayLabel } from './zone-history';
import {
  MAX_RANGE_DAYS, PHONE_PRESETS, dayDiff, presetRange, rangeLabel, usePhoneHistory,
} from './phone-history';

// Analytics › Phone Usage — the date range and export, in the page header
// beside the store selector. The range is the URL's (?startDate=&endDate=),
// shared with PhoneTab through usePhoneRange, so the charts, the export and a
// copied link always agree on the period.

const triggerCls = 'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary outline-none transition hover:border-brand/40 hover:text-brand-ink focus-visible:ring-2 focus-visible:ring-brand/40 data-[state=open]:border-brand/50 lg:h-9';

export default function PhoneRangeBar({ storeLabel }) {
  const { range, data, violationSec } = usePhoneHistory();
  const { from, to, preset, today, setRange } = range;
  const [calendarOpen, setCalendarOpen] = useState(false);

  const current = PHONE_PRESETS.find((p) => p.key === preset);
  const faceLabel = current ? current.label : rangeLabel(from, to).replace(/ \(\d+ days\)$/, '');

  // Every format goes through the branded report writer (logo + header).
  const onExport = (format) => exportReportDocument({
    title: 'Phone Usage Report',
    code: 'PHN',
    subtitle: 'Drishyam Activity Monitoring  -  Analytics: phone usage',
    details: [
      ['Store', storeLabel || 'All stores'],
      ['Period', `${rangeLabel(from, to)}`],
    ],
    policy: [['Policy violation', `Phone held over ${violationSec}s`]],
    kpis: [
      { label: 'Detections', value: data.total, note: `${data.days} day${data.days === 1 ? '' : 's'}` },
      { label: 'Policy violations', value: data.flagged, note: `Held over ${violationSec}s` },
      { label: 'Employees involved', value: data.byEmployee.length, note: 'With at least one detection' },
    ],
    tables: [
      {
        title: 'By employee',
        columns: ['Employee', 'Detections', `Flagged (>${violationSec}s)`, 'Previous period', 'Direction'],
        rows: data.byEmployee.map((p) => [p.name, p.total, p.flagged, p.prior, p.trend === 'up' ? 'Rising' : p.trend === 'down' ? 'Falling' : 'Steady']),
      },
      {
        title: `Trend (${data.grainText})`,
        sheet: 'Trend',
        columns: ['Period', 'Detections'],
        rows: data.trend.map((b) => [b.range || (data.grain === 'hour' ? `${from} ${b.d}` : b.key), b.n]),
      },
      {
        title: 'Detections',
        columns: ['Date', 'Time (IST)', 'Employee', 'Location', 'Camera', 'Hold (s)', 'Status', 'Confidence'],
        rows: data.rows.map((e) => [e.date, e.ts, e.employee || 'Unidentified', e.location, e.camera, e.holdSec,
          e.severity === 'violation' ? 'Policy Violation' : 'Warning / Brief', e.confidence]),
      },
    ],
    countLine: `${data.rows.length} detections`,
    filename: `phone-usage-${from}_${to}`,
  }, format);

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={`${triggerCls} print:hidden`} aria-label={`Date range: ${rangeLabel(from, to)}`} title={rangeLabel(from, to)}>
            <CalendarDays className="h-4 w-4 text-fg-subtle" />
            <span className="max-w-[12rem] truncate">{faceLabel}</span>
            <ChevronDown className="h-4 w-4 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56 border-line bg-surface">
          {PHONE_PRESETS.map((p) => (
            <DropdownMenuItem key={p.key} onSelect={() => setRange(presetRange(p.key, today))} className="justify-between text-small">
              {p.label}
              {preset === p.key && <Check className="text-brand-ink" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCalendarOpen(true)} className="justify-between text-small">
            Custom range…
            {preset === 'custom' && <Check className="text-brand-ink" />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ExportReportMenu
        label="Export"
        reportName="Phone usage"
        align="end"
        onSelect={onExport}
        className="print:hidden"
      />

      {calendarOpen && (
        <RangeCalendarDialog
          from={from}
          to={to}
          today={today}
          onClose={() => setCalendarOpen(false)}
          onApply={(r) => { setRange(r); setCalendarOpen(false); }}
        />
      )}
    </>
  );
}

// ── calendar modal ──────────────────────────────────────────────────────────

const WEEK_HEAD = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
const addMonths = (iso, n) => {
  const [y, m] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-01`;
};

/** Day cells for one month, Monday first; null pads the leading blanks. */
function monthCells(first) {
  const [y, m] = first.split('-').map(Number);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const count = new Date(y, m, 0).getDate();
  return [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => shiftIsoDate(first, i))];
}

/**
 * Two months side by side (one on a phone). First click sets the start,
 * second the end — in either order; clicking one day twice picks that day.
 * Days after today, and ends past MAX_RANGE_DAYS from the start, are disabled.
 */
function RangeCalendarDialog({ from, to, today, onClose, onApply }) {
  const [draft, setDraft] = useState({ from, to });
  const [hover, setHover] = useState(null);
  // The right-hand month is the one holding the range's end.
  const [anchor, setAnchor] = useState(() => addMonths(monthStart(to), -1));
  const months = [anchor, addMonths(anchor, 1)];
  const canNext = addMonths(anchor, 1) < monthStart(today);

  const picking = draft.from && !draft.to;
  const [lo, hi] = useMemo(() => {
    if (!picking) return [draft.from, draft.to];
    const other = hover || draft.from;
    return draft.from <= other ? [draft.from, other] : [other, draft.from];
  }, [draft, hover, picking]);

  const disabled = (iso) => iso > today || (picking && Math.abs(dayDiff(draft.from, iso)) >= MAX_RANGE_DAYS);

  const pick = (iso) => {
    if (!picking) { setDraft({ from: iso, to: null }); return; }
    setDraft(iso < draft.from ? { from: iso, to: draft.from } : { from: draft.from, to: iso });
    setHover(null);
  };

  const summary = draft.to ? rangeLabel(draft.from, draft.to) : `${dayLabel(draft.from)} – pick an end date`;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[calc(var(--app-vw)-2rem)] gap-0 border-line bg-surface p-0 sm:max-w-[40rem]">
        <div className="border-b border-line px-4 py-3 pr-12">
          <DialogTitle className="text-base font-semibold text-fg">Custom date range</DialogTitle>
          <DialogDescription className="mt-0.5 text-caption text-fg-muted">
            Pick a start and an end day. Up to {MAX_RANGE_DAYS} days, ending today at the latest.
          </DialogDescription>
        </div>

        <div className="relative px-4 py-3">
          <div className="absolute inset-x-4 top-3 flex justify-between">
            <button
              type="button"
              onClick={() => setAnchor((a) => addMonths(a, -1))}
              aria-label="Previous month"
              className="grid h-11 w-11 place-items-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg lg:h-7 lg:w-7"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setAnchor((a) => addMonths(a, 1))}
              disabled={!canNext}
              aria-label="Next month"
              className="grid h-11 w-11 place-items-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg disabled:opacity-30 lg:h-7 lg:w-7"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-6 sm:grid-cols-2" onMouseLeave={() => setHover(null)}>
            {months.map((first, mi) => {
              const [y, m] = first.split('-').map(Number);
              return (
                // On a phone only the right-hand month shows; the arrows page.
                <div key={first} className={mi === 0 ? 'hidden sm:block' : ''}>
                  <p className="mb-2 text-center text-small font-semibold leading-7 text-fg">
                    {new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
                  </p>
                  <div className="grid grid-cols-7 text-center" role="grid">
                    {WEEK_HEAD.map((w) => (
                      <span key={w} className="pb-1 text-micro font-semibold uppercase text-fg-subtle">{w}</span>
                    ))}
                    {monthCells(first).map((iso, i) => {
                      if (!iso) return <span key={`b${i}`} />;
                      const off = disabled(iso);
                      const edge = iso === lo || iso === hi;
                      const inside = lo && hi && iso > lo && iso < hi;
                      return (
                        <button
                          key={iso}
                          type="button"
                          disabled={off}
                          onClick={() => pick(iso)}
                          onMouseEnter={() => picking && setHover(iso)}
                          aria-pressed={edge}
                          aria-label={dayLabel(iso)}
                          className={`h-10 text-small tabular-nums transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:text-fg-disabled lg:h-8 ${
                            edge ? 'rounded-md bg-brand font-semibold text-white'
                              : inside ? 'bg-brand-soft text-brand-ink'
                                : `rounded-md text-fg-secondary hover:bg-surface-sunken ${iso === today ? 'font-bold ring-1 ring-inset ring-line-strong' : ''}`
                          }`}
                        >
                          {Number(iso.slice(8))}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
          <p className="text-caption font-semibold tabular-nums text-fg-secondary" aria-live="polite">{summary}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-11 rounded-lg px-3 text-caption font-semibold text-fg-muted transition hover:text-fg lg:h-8"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!draft.to}
              onClick={() => onApply({ from: draft.from, to: draft.to })}
              className="h-11 rounded-lg bg-brand px-3 text-caption font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:opacity-40 lg:h-8"
            >
              Apply range
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
