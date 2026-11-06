import { createElement } from 'react';
import {
  Cctv, CheckCircle2, Clock, Cpu, Gauge, MapPin, MonitorPlay, PlaySquare,
  ScanSearch, Shapes, X,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import TargetThumb from '@/modules/ai-feed/aifeed/TargetThumb';
import { SeverityBadge } from '@/modules/ai-feed/aifeed/chips';
import { EventIcon } from '@/modules/ai-feed/aifeed/icons';
import { fmtDateTime, statusOf } from './log-model';

/**
 * Everything known about one event, and the three things you can do about it.
 *
 * The same component is the right-hand column on a wide screen and the drawer
 * on a narrow one — one definition of what an event's record looks like, so
 * the phone never shows a shorter truth than the desk.
 */

function Field({ icon, label, children }) {
  if (children == null || children === '' || children === '—') return null;
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="flex w-[7.5rem] shrink-0 items-center gap-1.5 text-small text-fg-muted">
        {createElement(icon, { className: 'h-3.5 w-3.5 shrink-0 text-fg-subtle', strokeWidth: 2 })}
        {label}
      </span>
      <span className="min-w-0 break-words text-small font-semibold text-fg">{children}</span>
    </div>
  );
}

function Action({ icon, children, onClick, primary = false, disabled = false, title, className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-small font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        primary
          ? 'border-brand bg-brand text-white hover:bg-brand-hover'
          : 'border-line bg-surface text-fg-secondary hover:bg-surface-sunken hover:text-fg',
        className,
      )}
    >
      {createElement(icon, { className: 'h-3.5 w-3.5', strokeWidth: 2.1 })}
      {children}
    </button>
  );
}

export default function EventDetail({ event, onClose, onLive, onPlayback, onAcknowledge, onTrack, acking, ackError }) {
  if (!event) return null;
  const acked = statusOf(event) === 'acknowledged';
  // The activity service's timeline hands out no row id, so there is nothing to
  // acknowledge against. Say that rather than offering a button that 404s.
  const ackable = !event.fromActivityService;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="flex-1 text-lg font-semibold text-fg">Event Details</h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close event details"
            className="rounded-md p-1 text-fg-subtle transition hover:bg-surface-sunken hover:text-fg"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* Evidence first. The thumbnail pans to the detection's own box when
            the snapshot is a full frame, so the panel shows the subject, not a
            wide shot of a car park with a person somewhere in it. */}
        <div className="rounded-lg border border-line-subtle bg-surface-sunken p-2">
          <TargetThumb event={event} size={248} rounded="rounded-md" className="mx-auto" />
          <p className="mt-2 flex items-center justify-between gap-2 px-0.5 text-caption text-fg-muted">
            <span className="truncate font-semibold text-fg-secondary">{event.cameraName || event.monitorId}</span>
            <span className="shrink-0 tabular-nums">{fmtDateTime(event.ts)}</span>
          </p>
        </div>

        <div className="mt-4 flex items-start gap-2">
          <EventIcon name={event.iconName} className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" strokeWidth={2.1} />
          <h3 className="min-w-0 flex-1 text-sm font-semibold text-fg">{event.title}</h3>
          <SeverityBadge severity={event.severity} />
        </div>
        {event.detail ? <p className="mt-1 text-small text-fg-muted">{event.detail}</p> : null}

        <h4 className="mt-5 text-micro font-bold uppercase tracking-[0.1em] text-fg-subtle">Event Information</h4>
        <dl className="mt-1 divide-y divide-line-subtle">
          <Field icon={Clock} label="Date & Time">{fmtDateTime(event.ts)}</Field>
          <Field icon={Cctv} label="Camera">{event.cameraName || event.monitorId || '—'}</Field>
          <Field icon={MapPin} label="Location">{event.location || '—'}</Field>
          <Field icon={Shapes} label="Zone">{event.zoneName || '—'}</Field>
          <Field icon={Cpu} label="AI Model">{event.model || '—'}</Field>
          <Field icon={Gauge} label="Confidence">
            {event.confidence != null ? `${event.confidence}%` : '—'}
          </Field>
          <Field icon={ScanSearch} label="Track ID">{event.trackId || '—'}</Field>
        </dl>

        <h4 className="mt-5 text-micro font-bold uppercase tracking-[0.1em] text-fg-subtle">Actions</h4>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Action icon={MonitorPlay} primary onClick={() => onLive(event)}>View Live</Action>
          <Action icon={PlaySquare} onClick={() => onPlayback(event)}>View Playback</Action>
        </div>
        <div className="mt-2 grid gap-2">
          <Action
            icon={CheckCircle2}
            onClick={() => onAcknowledge(event)}
            disabled={acked || acking || !ackable}
            title={ackable ? undefined : 'Attendance and activity-monitor rows carry no id to acknowledge against'}
          >
            {acked ? 'Acknowledged' : acking ? 'Marking…' : 'Mark as Acknowledged'}
          </Action>
          {event.subject && !event.isUnknown ? (
            <Action icon={ScanSearch} onClick={() => onTrack(event)}>Track {event.subject}</Action>
          ) : null}
        </div>
        {ackError ? (
          <p className="mt-2 rounded-md border border-warning-line bg-warning-soft px-2.5 py-1.5 text-caption text-warning-ink">
            {ackError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
