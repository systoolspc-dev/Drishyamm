import { createElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cctv, History, MapPinned, ScanFace, UserPlus, VideoOff } from 'lucide-react';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { cn } from '@/core/lib/utils';
import { StatusBadge } from '@/core/ui/status-badge';
import { EmptyState } from '@/core/ui/states';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/core/ui/sheet';
import { DetectionOverlay, ZoneOverlay } from './overlays';
import { DemoScene } from './EventBoxOverlay';
import { EventRow } from './EventStream';
import { CountPill } from './chips';
import AttendancePanel from './AttendancePanel';

function Action({ icon, children, onClick, primary = false, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-small font-semibold transition disabled:cursor-not-allowed disabled:opacity-40',
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
 * The camera's own view: a larger live frame with every overlay, the AI
 * models it runs, and the list of what those models saw in the window.
 * Opened by clicking a tile; the tile stays selected behind it.
 */
export default function CameraDetailDrawer({
  cam,
  models = [],
  aiEnabled = false,
  aiRunning = false,
  detections,
  zones = [],
  events = [],
  open,
  onOpenChange,
  onSelectEvent,
  onEnableAi,
  onOpenZones,
  onRegisterFace,
  demo = false,
  now,
  hasLine = false,
}) {
  const navigate = useNavigate();
  if (!cam) return null;
  const online = cam.status === 'online';
  const boxes = detections?.boxes || [];
  const inFrame = aiEnabled ? (detections?.people?.smoothed_total ?? boxes.length) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[520px] max-w-[calc(var(--app-vw)*0.94)] gap-0 p-0" showCloseButton>
        <div className="border-b border-line px-5 pb-4 pt-5">
          <div className="flex items-center gap-2">
            <StatusBadge status={online ? 'online' : 'offline'} size="sm" pulse={online} />
            {aiEnabled ? <StatusBadge tone="brand" size="sm" dot={false}>{aiRunning ? 'AI live' : 'AI on'}</StatusBadge> : null}
          </div>
          <SheetTitle className="mt-3 text-section text-fg">{cam.name}</SheetTitle>
          <SheetDescription className="mt-1">
            {[cam.siteName, cam.location].filter(Boolean).join(' · ') || 'No site assigned'}
            {cam.channel != null ? ` · CH ${cam.channel}` : ''}
          </SheetDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative aspect-video w-full overflow-hidden bg-black">
            {demo ? (
              <DemoScene events={events.slice(0, 3)} label="Sample feed" labelMode="full" />
            ) : !online ? (
              <div className="absolute inset-0 grid place-items-center">
                <div className="flex flex-col items-center gap-1.5">
                  <VideoOff className="h-7 w-7 text-white/30" strokeWidth={1.6} />
                  <p className="text-small font-semibold text-white/60">Camera offline</p>
                </div>
              </div>
            ) : open ? (
              <>
                <DirectStreamPlayer
                  key={cam.monitorId}
                  monitorId={cam.monitorId}
                  mode="webrtc"
                  quality="high"
                  muted
                  controls={false}
                  aiOverlay={false}
                  digitalZoom={false}
                  protocolBadge={false}
                  className="h-full w-full"
                />
                {aiEnabled ? <ZoneOverlay zones={zones} frameW={detections?.frame_w || 1920} frameH={detections?.frame_h || 1080} /> : null}
                {aiEnabled && boxes.length ? <DetectionOverlay boxes={boxes} frameW={detections?.frame_w} frameH={detections?.frame_h} /> : null}
              </>
            ) : null}
          </div>

          <div className="px-5 py-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-micro font-semibold uppercase tracking-[0.1em] text-fg-subtle">AI models</span>
              {models.length ? models.map((m) => (
                <span key={m} className="rounded-md border border-line bg-surface-sunken px-2 py-0.5 text-caption font-semibold text-fg-secondary">{m}</span>
              )) : <span className="text-caption font-medium text-fg-muted">None enabled</span>}
              {aiEnabled ? (
                <span className="ml-auto inline-flex items-center gap-1 text-caption font-semibold text-fg-muted">
                  <ScanFace className="h-3.5 w-3.5 text-brand" strokeWidth={2.1} />
                  <span className="tabular-nums text-fg">{inFrame}</span> in frame
                </span>
              ) : null}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <Action icon={Cctv} primary onClick={() => navigate(`/live?camera=${encodeURIComponent(cam.monitorId)}`)} disabled={demo}>View Live</Action>
              <Action icon={History} onClick={() => navigate(`/playback?camera=${encodeURIComponent(cam.monitorId)}`)} disabled={demo}>Playback</Action>
              {aiEnabled
                ? <Action icon={MapPinned} onClick={onOpenZones} disabled={demo}>Detection Area{zones.length ? ` (${zones.length})` : ''}</Action>
                : <Action icon={ScanFace} onClick={() => onEnableAi?.(cam)} disabled={demo || !online}>Enable AI</Action>}
              <Action icon={UserPlus} onClick={onRegisterFace} disabled={demo}>Register Face</Action>
            </div>

            {!demo && aiEnabled ? (
              <div className="mt-4">
                <AttendancePanel hasLine={hasLine} aiEnabled={aiEnabled || aiRunning} onDrawLine={onOpenZones} />
              </div>
            ) : null}

            <div className="mt-5 flex items-center gap-2">
              <h3 className="text-body font-semibold text-fg">AI events on this camera</h3>
              <CountPill value={events.length} />
            </div>
            <div className="mt-2">
              {events.length ? (
                <ol className="space-y-0.5">
                  {events.map((e) => (
                    <li key={e.id}>
                      <EventRow event={e} now={now} onSelect={onSelectEvent} dense />
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState
                  icon={ScanFace}
                  title={aiEnabled || demo ? 'No events in this window' : 'AI is off for this camera'}
                  description={aiEnabled || demo ? 'Detections from this camera will appear here as they happen.' : 'Enable an AI model to start receiving detections from this camera.'}
                  className="py-6"
                />
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
