import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, ScanFace, VideoOff, WifiOff } from 'lucide-react';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { cn, playerQuality } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';
import { DetectionOverlay, ZoneOverlay } from './overlays';
import { DemoScene, EventBoxOverlay } from './EventBoxOverlay';
import { SeverityBadge } from './chips';
import { EventIcon } from './icons';
import { fmtClock, fmtRelative, locationLabel } from './event-model';
import { useInView } from './useInView';

/** Every label drawn on the video is this pill. One shape, one weight. */
function FramePill({ className, children }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded bg-black/55 px-1.5 text-micro font-bold tracking-[0.06em] text-white backdrop-blur-sm',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * One camera on the AI Feed grid.
 *
 * The card IS the video — no strip of page colour under it. Who the camera is
 * sits top left, whether it is live sits top right, and what the AI saw rides
 * on a gradient along the bottom of the frame: headline and severity, then the
 * supporting detail and when it happened. Two lines, the same two lines in
 * every state, so the grid reads straight down a column.
 *
 * A camera that produced several kinds of detection gets ONE headline and a
 * "+N" against it, never a chip per detection.
 *
 * Colour rules: the frame border is neutral and only turns brand when the
 * camera is selected. Severity is carried by the icon, the badge and the
 * bounding boxes — nothing else on the card is tinted.
 */
export default function AiCameraCard({
  cam,
  models = [],
  aiEnabled = false,
  aiRunning = false,
  detections,
  zones = [],
  summary,
  selected = false,
  highlighted = false,
  focusEvent = null,
  demo = false,
  demoEvents = [],
  layout = 'grid',
  onOpen,
  onEnableAi,
  registerRef,
}) {
  const cardRef = useRef(null);
  const inView = useInView(cardRef);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    registerRef?.(cam.monitorId, cardRef.current);
    return () => registerRef?.(cam.monitorId, null);
  }, [cam.monitorId, registerRef]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === cardRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const online = cam.status === 'online';
  const boxes = detections?.boxes || [];
  const liveCount = aiEnabled ? (detections?.people?.smoothed_total ?? boxes.length) : 0;
  const headline = summary?.headline || null;
  const typeCount = summary?.types?.length || 0;
  const modelLine = models.length ? models.join(' · ') : 'No AI models assigned';
  const list = layout === 'list';

  const toggleFullscreen = async (e) => {
    e.stopPropagation();
    try {
      if (document.fullscreenElement === cardRef.current) await document.exitFullscreen();
      else await cardRef.current?.requestFullscreen();
    } catch { /* blocked by browser policy — the card still works */ }
  };

  // One shape in every state: icon, headline, the count of anything else this
  // camera saw, and a badge or action — then the detail and a time or count.
  let primary;
  let secondary;
  let trailing = null;
  let meta = null;
  let metaTitle;
  const more = headline && summary?.count > 1 ? `+${summary.count - 1}` : null;
  const moreTitle = more ? `${summary.count} AI events · ${typeCount} type${typeCount > 1 ? 's' : ''}` : undefined;

  if (headline) {
    primary = headline.title;
    secondary = headline.detail || modelLine;
    trailing = <SeverityBadge severity={headline.severity} />;
    meta = fmtRelative(headline.ts);
    metaTitle = fmtClock(headline.ts);
  } else if (!online) {
    primary = 'Camera offline';
    secondary = 'No stream from this device';
  } else if (aiEnabled) {
    primary = aiRunning ? 'AI monitoring' : 'AI starting…';
    secondary = aiRunning ? modelLine : 'Bringing the models up';
    meta = `${liveCount} in frame`;
  } else {
    primary = 'AI models disabled';
    secondary = modelLine;
    trailing = demo ? null : (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onEnableAi?.(cam); }}
        className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-brand px-1.5 text-micro font-bold normal-case tracking-normal text-white transition hover:bg-brand-hover"
      >
        <ScanFace className="h-3 w-3" strokeWidth={2.2} />
        Enable AI
      </button>
    );
  }

  /** The icon is the same glyph on video or on surface, a different grey. */
  const renderIcon = (onVideo) => {
    const muted = onVideo ? 'text-white/55' : 'text-fg-disabled';
    if (headline) {
      return <EventIcon name={headline.iconName} className={cn('h-3.5 w-3.5 shrink-0', toneClass(headline.tone, 'icon'))} strokeWidth={2.1} />;
    }
    if (!online) return <WifiOff className={cn('h-3.5 w-3.5 shrink-0', muted)} strokeWidth={2.1} />;
    if (aiEnabled) return <ScanFace className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2.1} />;
    return <ScanFace className={cn('h-3.5 w-3.5 shrink-0', muted)} strokeWidth={2.1} />;
  };

  /**
   * On a grid tile this rides the bottom of the frame on a gradient; on a list
   * row, where there is width to spare, it sits beside the thumbnail.
   */
  const info = (onVideo) => (
    <div
      className={cn(
        'flex min-w-0 flex-col justify-center gap-0.5',
        onVideo
          ? 'pointer-events-none absolute inset-x-0 bottom-0 z-40 bg-gradient-to-t from-black/90 via-black/65 to-transparent px-2.5 pb-2 pt-8'
          : 'flex-1 px-3 py-2.5',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {renderIcon(onVideo)}
        <p className={cn('min-w-0 flex-1 truncate text-caption font-semibold', onVideo ? 'text-white' : 'text-fg')} title={primary}>
          {primary}
        </p>
        {more ? (
          <span
            className={cn('shrink-0 text-micro font-bold tabular-nums tracking-normal', onVideo ? 'text-white/70' : 'text-fg-subtle')}
            title={moreTitle}
          >
            {more}
          </span>
        ) : null}
        {trailing ? <span className="pointer-events-auto shrink-0">{trailing}</span> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 pl-[22px]">
        <p
          className={cn('min-w-0 flex-1 truncate text-micro font-medium normal-case tracking-normal', onVideo ? 'text-white/70' : 'text-fg-muted')}
          title={secondary}
        >
          {secondary}
        </p>
        {meta ? (
          <span
            className={cn('shrink-0 text-micro font-semibold tabular-nums tracking-normal', onVideo ? 'text-white/65' : 'text-fg-subtle')}
            title={metaTitle}
          >
            {meta}
          </span>
        ) : null}
      </div>
      {list && headline ? (
        <p className="mt-0.5 min-w-0 truncate pl-[22px] text-micro font-medium normal-case tracking-normal text-fg-subtle" title={modelLine}>
          {modelLine}
        </p>
      ) : null}
    </div>
  );

  return (
    <article
      ref={cardRef}
      role="button"
      tabIndex={0}
      aria-label={`${cam.name} — open AI events`}
      onClick={() => onOpen?.(cam)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(cam); } }}
      className={cn(
        'group relative flex min-w-0 cursor-pointer overflow-hidden rounded-lg border bg-black text-left shadow-sm outline-none transition',
        list ? 'flex-row bg-surface' : 'flex-col',
        selected || highlighted ? 'border-brand ring-1 ring-brand/35' : 'border-line hover:border-line-strong hover:shadow-md',
        isFullscreen && 'h-[var(--app-vh)] w-[var(--app-vw)] rounded-none border-0 ring-0',
        'focus-visible:ring-2 focus-visible:ring-brand/50',
      )}
    >
      {/* ── Video ─────────────────────────────────────────────────────── */}
      <div
        className={cn('relative shrink-0 overflow-hidden bg-black', list ? 'w-[200px] sm:w-[280px]' : 'w-full')}
        style={{ aspectRatio: isFullscreen ? 'auto' : '16 / 9', height: isFullscreen ? '100%' : undefined }}
      >
        {demo ? (
          <DemoScene events={focusEvent ? [focusEvent] : demoEvents} label={null} />
        ) : !online ? (
          <div className="absolute inset-0 grid place-items-center bg-[#0b0c10]">
            <VideoOff className="h-6 w-6 text-white/25" strokeWidth={1.6} />
          </div>
        ) : inView ? (
          <>
            <DirectStreamPlayer
              key={cam.monitorId}
              monitorId={cam.monitorId}
              mode="webrtc"
              quality={playerQuality(cam, 'low')}
              muted
              controls={false}
              aiOverlay={false}
              digitalZoom={false}
              protocolBadge={false}
              className="h-full w-full"
            />
            {aiEnabled ? (
              <ZoneOverlay zones={zones} frameW={detections?.frame_w || 1920} frameH={detections?.frame_h || 1080} subtle />
            ) : null}
            {aiEnabled && boxes.length > 0 ? (
              <DetectionOverlay boxes={boxes} frameW={detections?.frame_w} frameH={detections?.frame_h} />
            ) : null}
            {focusEvent ? (
              <EventBoxOverlay event={focusEvent} frameW={detections?.frame_w || 1920} frameH={detections?.frame_h || 1080} />
            ) : null}
          </>
        ) : (
          <div className="absolute inset-0 bg-[#0b0c10]" />
        )}

        {/* Top strip: who it is, whether it is live, and — on hover — the one
            control the tile carries. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-12 bg-gradient-to-b from-black/65 to-transparent" />
        <div className="pointer-events-none absolute inset-x-2.5 top-2 z-40 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-small font-semibold leading-tight text-white">{cam.name || `Camera ${cam.channel || ''}`}</p>
            {locationLabel(cam.name, cam.location) ? (
              <p className="truncate text-micro font-medium normal-case leading-tight tracking-normal text-white/60">{cam.location}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {online && !demo ? (
              <button
                type="button"
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                className="pointer-events-auto grid h-5 w-5 place-items-center rounded bg-black/55 text-white opacity-0 backdrop-blur-sm transition hover:bg-black/75 focus-visible:opacity-100 group-hover:opacity-100"
              >
                {isFullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              </button>
            ) : null}
            {online ? (
              <FramePill>
                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                LIVE
              </FramePill>
            ) : (
              <FramePill className="text-white/70">
                <WifiOff className="h-3 w-3" strokeWidth={2.2} />
                OFFLINE
              </FramePill>
            )}
          </div>
        </div>

        {/* On a grid tile the AI's read rides the bottom of the frame itself. */}
        {!list && !isFullscreen ? info(true) : null}
      </div>

      {/* A list row has the width to put it beside the thumbnail instead. */}
      {list && !isFullscreen ? info(false) : null}
    </article>
  );
}
