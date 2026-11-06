import { useRef, useState } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronDown, Clock, Download, Scissors, X } from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { PageCard } from '@/core/layout/OperationsPage';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { EXPORT_MAX_MS, atTime, dayKey, fmtDate, fmtDuration, timeValue } from './model';

const NVR_LIMIT_TEXT = (max) => `Clips are limited to ${fmtDuration(max)}: the NVR replays in real time, so export takes as long as the clip.`;

const FORMATS = [
  { id: 'mp4', label: 'MP4 (H.264)', hint: 'Opens on any device. Recommended.' },
  { id: 'original', label: 'Original stream', hint: "The NVR's own encoding, not re-encoded. May need VLC." },
];

/**
 * Clip export: a start and end moment, downloaded by the backend straight
 * off the NVR. The range also draws as a band on the timeline, so it can be
 * checked against what happened.
 */
export default function ClipExport({
  id, range, onChange, playhead, canExport, onExport, notice, onDismissNotice,
  formats = FORMATS, limitText = NVR_LIMIT_TEXT, actionLabel = 'Export Clip',
}) {
  const [format, setFormat] = useState(formats[0].id);
  const duration = range.end - range.start;
  const problem = duration <= 0
    ? 'End must be after start.'
    : duration > EXPORT_MAX_MS
      ? limitText(EXPORT_MAX_MS)
      : null;
  const disabled = !canExport || Boolean(problem);
  const current = formats.find((f) => f.id === format) || formats[0];

  return (
    // Laid out by the card's own width, not the viewport's.
    <PageCard id={id} className="@container scroll-mt-4 px-4 py-3">
      <h2 className="text-heading font-bold text-fg">Clip Export</h2>

      <div className="mt-2.5 flex flex-col gap-3 @5xl:flex-row @5xl:items-end @5xl:justify-between">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
          <MomentField
            label="Start"
            value={range.start}
            onChange={(ms) => onChange({ start: ms, end: range.end })}
            onPlayhead={playhead == null ? null : () => onChange({ start: Math.round(playhead), end: range.end })}
          />
          <ArrowRight aria-hidden className="mb-3 hidden h-4 w-4 shrink-0 text-fg-subtle @xl:block" />
          <MomentField
            label="End"
            value={range.end}
            onChange={(ms) => onChange({ start: range.start, end: ms })}
            onPlayhead={playhead == null ? null : () => onChange({ start: range.start, end: Math.round(playhead) })}
          />
          <div className="flex min-w-28 flex-col gap-1 @xl:ml-3">
            <span className="text-caption font-medium text-fg-muted">Duration</span>
            <span className={cn('flex h-10 items-center text-body font-semibold tabular-nums', problem ? 'text-fg-disabled' : 'text-fg')}>
              {problem ? '—' : fmtDuration(duration)}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-caption font-medium text-fg-muted">Format</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={!canExport}
                  className="inline-flex h-10 min-w-40 items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {current.label}
                  <ChevronDown className="h-4 w-4 text-fg-muted" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72 border-line bg-surface">
                {formats.map((f) => (
                  <DropdownMenuItem key={f.id} onSelect={() => setFormat(f.id)} className="items-start">
                    <span className="flex flex-1 flex-col">
                      <span className="text-small font-semibold text-fg">{f.label}</span>
                      <span className="text-caption text-fg-muted">{f.hint}</span>
                    </span>
                    {f.id === format ? <Check className="mt-0.5 text-brand" /> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <button
            type="button"
            disabled={disabled}
            onClick={() => onExport(current.id)}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-brand px-5 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-brand"
          >
            <Download className="h-4 w-4" />
            {actionLabel}
          </button>
        </div>
      </div>

      {problem ? (
        <p className="mt-2 text-small font-medium text-danger-ink">{problem}</p>
      ) : notice ? (
        <div
          role="status"
          className={cn(
            'mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-small',
            notice.tone === 'danger' ? 'border-danger-line bg-danger-soft text-danger-ink' : 'border-info-line bg-info-soft text-info-ink',
          )}
        >
          <p className="min-w-0 flex-1">{notice.text}</p>
          <button type="button" aria-label="Dismiss" onClick={onDismissNotice} className="shrink-0 opacity-70 transition hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </PageCard>
  );
}

const showPicker = (input) => { try { input?.showPicker(); } catch { input?.focus(); } };

/** A labelled date + time (to the second) for one end of the clip. */
function MomentField({ label, value, onChange, onPlayhead }) {
  const [today] = useState(() => dayKey(Date.now()));
  const dateRef = useRef(null);
  const timeRef = useRef(null);
  const day = dayKey(value);
  const time = timeValue(value, true);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption font-medium text-fg-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="relative">
          <button
            type="button"
            onClick={() => showPicker(dateRef.current)}
            aria-label={`${label} date`}
            className="flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-medium text-fg transition hover:border-line-strong"
          >
            <CalendarDays className="h-4 w-4 text-fg-muted" />
            <span className="whitespace-nowrap">{fmtDate(value)}</span>
          </button>
          <input
            ref={dateRef}
            type="date"
            value={day}
            max={today}
            onChange={(e) => { if (e.target.value) onChange(atTime(e.target.value, time)); }}
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
          />
        </span>
        <span className="flex h-10 items-center gap-1 rounded-lg border border-line bg-surface pl-3 pr-1.5 transition focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
          <input
            ref={timeRef}
            type="time"
            step="1"
            value={time}
            onChange={(e) => { if (e.target.value) onChange(atTime(day, e.target.value)); }}
            aria-label={`${label} time`}
            className="w-24 bg-transparent text-small font-medium tabular-nums text-fg outline-none [&::-webkit-calendar-picker-indicator]:hidden"
          />
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => showPicker(timeRef.current)}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-muted transition hover:text-fg"
          >
            <Clock className="h-4 w-4" />
          </button>
        </span>
        <button
          type="button"
          onClick={onPlayhead || undefined}
          disabled={!onPlayhead}
          title={`${label} at playhead`}
          aria-label={`${label} at playhead`}
          className="grid h-10 w-9 place-items-center rounded-lg text-fg-muted transition hover:bg-surface-sunken hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Scissors className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
