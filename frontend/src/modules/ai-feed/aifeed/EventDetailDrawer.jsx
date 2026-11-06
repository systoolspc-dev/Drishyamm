import { createElement, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BellPlus, Car, CheckCircle2, Cctv, Footprints, History, PlaySquare,
  UserPlus, UserSearch, Route,
} from 'lucide-react';
import { aiService } from '@/core/services/ai';
import { cn } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/core/ui/sheet';
import TargetThumb from './TargetThumb';
import { SeverityBadge } from './chips';
import { fmtClock, locationLabel } from './event-model';
import { eventIcon } from './icons';

function Field({ label, children, mono = false }) {
  if (children == null || children === '') return null;
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-3 py-2">
      <dt className="text-micro font-semibold uppercase tracking-[0.1em] text-fg-subtle">{label}</dt>
      <dd className={cn('min-w-0 break-words text-small font-medium text-fg', mono && 'font-mono tabular-nums')}>{children}</dd>
    </div>
  );
}

function Action({ icon, children, onClick, primary = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-small font-semibold transition',
        primary
          ? 'border-brand bg-brand text-white hover:bg-brand-hover'
          : 'border-line bg-surface text-fg-secondary hover:bg-surface-sunken hover:text-fg',
      )}
    >
      {createElement(icon, { className: "h-3.5 w-3.5", strokeWidth: 2.1 })}
      {children}
    </button>
  );
}

/**
 * Event details, on the right. The fields and the actions change with the
 * category — a plate wants "Track vehicle", a stranger wants "Add to
 * watchlist", a zone breach wants "Track person" — but the frame, the order
 * and the weight of everything stay the same so the drawer reads as one
 * component whatever opened it.
 */
export default function EventDetailDrawer({ event, open, onOpenChange, onViewCamera, onAddToWatchlist, demo = false }) {
  const navigate = useNavigate();
  const [acked, setAcked] = useState(false);
  const [acking, setAcking] = useState(false);

  if (!event) return null;
  const Icon = eventIcon(event.iconName);
  const camQuery = `camera=${encodeURIComponent(event.monitorId)}`;
  const isAcked = acked || event.acknowledged;

  const goLive = () => navigate(`/live?${camQuery}`);
  const goPlayback = () => navigate(`/playback?${camQuery}&t=${encodeURIComponent(event.ts.toISOString())}`);
  const goTrackPerson = () => navigate(event.subject && !event.isUnknown
    ? `/person-tracker?name=${encodeURIComponent(event.subject)}`
    : '/person-tracker');
  const goAlerts = () => navigate('/alerts');
  const goVehicle = () => navigate(event.plate ? `/ai-analytics/vehicle?plate=${encodeURIComponent(event.plate)}` : '/ai-analytics/vehicle');

  const acknowledge = async () => {
    if (demo || !event.raw?.id || isAcked) { setAcked(true); return; }
    setAcking(true);
    try { await aiService.acknowledge(event.raw.id); setAcked(true); } catch { /* keep the button */ } finally { setAcking(false); }
  };

  let actions;
  if (event.category === 'faces') {
    actions = (
      <>
        {event.isUnknown
          ? <Action icon={UserPlus} primary onClick={() => onAddToWatchlist?.(event)}>Add to Watchlist</Action>
          : <Action icon={UserSearch} primary onClick={goTrackPerson}>View Person</Action>}
        <Action icon={Footprints} onClick={goTrackPerson}>Track</Action>
        <Action icon={Cctv} onClick={goLive}>View Live</Action>
        <Action icon={History} onClick={goPlayback}>Playback</Action>
      </>
    );
  } else if (event.category === 'vehicles') {
    actions = (
      <>
        <Action icon={Car} primary onClick={goVehicle}>View Vehicle</Action>
        <Action icon={Route} onClick={goVehicle}>Track Vehicle</Action>
        <Action icon={Cctv} onClick={goLive}>View Live</Action>
        <Action icon={History} onClick={goPlayback}>Playback</Action>
      </>
    );
  } else if (event.category === 'crowd') {
    actions = (
      <>
        <Action icon={Cctv} primary onClick={goLive}>View Live</Action>
        <Action icon={History} onClick={goPlayback}>View Playback</Action>
        <Action icon={PlaySquare} onClick={() => navigate('/occupancy')}>Occupancy</Action>
        <Action icon={BellPlus} onClick={goAlerts}>Create Alert</Action>
      </>
    );
  } else {
    actions = (
      <>
        <Action icon={Cctv} primary onClick={goLive}>View Live</Action>
        <Action icon={History} onClick={goPlayback}>View Playback</Action>
        <Action icon={Footprints} onClick={goTrackPerson}>Track Person</Action>
        <Action icon={BellPlus} onClick={goAlerts}>Create Alert</Action>
      </>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[440px] max-w-[calc(var(--app-vw)*0.94)] gap-0 p-0" showCloseButton>
        <div className="border-b border-line px-5 pb-4 pt-5">
          <div className="flex items-center gap-2">
            <span className={cn('grid h-7 w-7 place-items-center rounded-md border', toneClass(event.tone, 'soft'))}>
              <Icon className="h-4 w-4" strokeWidth={2.1} />
            </span>
            <SeverityBadge severity={event.severity} />
            {isAcked ? (
              <span className="inline-flex items-center gap-1 text-caption font-semibold text-success-ink">
                <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.2} /> Acknowledged
              </span>
            ) : null}
          </div>
          <SheetTitle className="mt-3 text-section text-fg">{event.title}</SheetTitle>
          <SheetDescription className="mt-1">
            {event.cameraName}{locationLabel(event.cameraName, event.location) ? ` · ${event.location}` : ''} · {fmtClock(event.ts)}
          </SheetDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex items-start gap-4">
            <TargetThumb event={event} size={112} rounded="rounded-lg" />
            <div className="min-w-0 flex-1">
              <p className="text-micro font-semibold uppercase tracking-[0.1em] text-fg-subtle">Detection</p>
              <p className="mt-1 text-body font-semibold text-fg">{event.detail || event.title}</p>
              <p className="mt-1 text-small text-fg-muted">{event.model}</p>
              {event.confidence != null ? (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-caption font-medium text-fg-muted">
                    <span>Confidence</span>
                    <span className="font-semibold tabular-nums text-fg">{event.confidence}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${event.confidence}%` }} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <dl className="mt-4 divide-y divide-line-subtle border-y border-line-subtle">
            <Field label="Camera">
              <button type="button" onClick={() => onViewCamera?.(event.monitorId)} className="text-brand-ink hover:text-brand">
                {event.cameraName}
              </button>
            </Field>
            <Field label="Location">{event.location || null}</Field>
            <Field label="Time" mono>{event.ts.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}</Field>
            {event.category === 'faces' ? <Field label="Person">{event.isUnknown ? 'Unknown' : event.subject}</Field> : null}
            {event.category === 'vehicles' ? <Field label="Licence plate" mono>{event.plate || 'Not read'}</Field> : null}
            {event.category === 'vehicles' ? <Field label="Vehicle">{event.raw?.payload?.vehicleType || 'Detected'}</Field> : null}
            {event.count != null ? <Field label="Count" mono>{event.count}{event.raw?.payload?.capacity ? ` / ${event.raw.payload.capacity}` : ''}</Field> : null}
            {event.zoneName ? <Field label="Zone">{event.zoneName}</Field> : null}
            <Field label="AI model">{event.model}</Field>
            <Field label="Severity">{event.severity === 'high' ? 'High' : event.severity === 'medium' ? 'Medium' : 'Informational'}</Field>
            {event.trackId ? <Field label="Track ID" mono>{event.trackId}</Field> : null}
            <Field label="Event ID" mono>{event.id}</Field>
          </dl>
        </div>

        <div className="border-t border-line px-5 py-4">
          <p className="mb-2 text-micro font-semibold uppercase tracking-[0.1em] text-fg-subtle">Actions</p>
          <div className="grid grid-cols-2 gap-2">
            {actions}
          </div>
          {!isAcked ? (
            <button
              type="button"
              onClick={acknowledge}
              disabled={acking}
              className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-small font-semibold text-fg-muted transition hover:bg-surface-sunken hover:text-fg disabled:opacity-50"
            >
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.1} />
              {acking ? 'Acknowledging…' : 'Acknowledge event'}
            </button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
