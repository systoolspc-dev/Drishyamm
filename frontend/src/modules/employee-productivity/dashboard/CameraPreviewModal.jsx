import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  X, Play, Pause, Volume2, VolumeX, Maximize, Minimize, Radio, History,
  ExternalLink, VideoOff, RotateCcw, Loader2,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// CameraPreviewModal — in-place camera preview, used by the dashboard's Needs
// Attention rows and the Zone Headcount table.
//
// `source` is { cameraId, cameraName, title, subtitle?, employee?, timestamp,
// startTimeISO, clipUrl, liveStreamUrl } — built in ./cameraStreams.js.
//
// Opens over the page (portal + blurred mask) so the page underneath keeps its
// state. Two modes:
//   · clip — auto-plays the pre-buffered event clip (`clipUrl`), scrubbable.
//   · live — swaps to `liveStreamUrl`, LIVE badge, scrubbing disabled.
// A source with no clip (a zone rather than an event) opens straight in live
// and has no mode toggle.
// "Open Full Playback View" hands off to /playback?camera&time for anything
// beyond a quick look.
//
// Sizing: centred at every width — 95vw × ≤90vh on phones, max-w-3xl from sm.
// The video keeps 16:9 but never exceeds 60vh, so on a landscape phone or a
// 768px laptop the controls stay on screen (the dialog scrolls if it must).
// Every control is a 44px touch target below lg and compact on desktop.
//
// Takes a plain URL rather than a monitorId, so it uses a bare <video> instead
// of core/players/HLSPlayer. hls.js is imported on demand, only for .m3u8
// sources in browsers without native HLS (i.e. everything except Safari).
// ─────────────────────────────────────────────────────────────────────────────

const isHls = (url) => /\.m3u8(\?|$)/i.test(url);

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Attaches `src` to the <video>, tracking buffering and error state. Re-runs on
 * every source change (clip ↔ live) and tears the hls.js instance down after.
 */
function useVideoSource(videoRef, src, attempt) {
  const [status, setStatus] = useState('loading'); // loading | ready | error

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) { setStatus('error'); return undefined; }

    let hls = null;
    let cancelled = false;
    setStatus('loading');

    const onWaiting = () => setStatus((s) => (s === 'error' ? s : 'loading'));
    const onPlaying = () => setStatus('ready');
    const onError   = () => setStatus('error');
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onPlaying);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);

    const start = () => { video.play().catch(() => { /* autoplay blocked — controls still work */ }); };

    if (isHls(src) && !video.canPlayType('application/vnd.apple.mpegurl')) {
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) { setStatus('error'); return; }
        hls = new Hls({ lowLatencyMode: true });
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setStatus('error'); });
        hls.on(Hls.Events.MANIFEST_PARSED, start);
        hls.loadSource(src);
        hls.attachMedia(video);
      }).catch(() => { if (!cancelled) setStatus('error'); });
    } else {
      video.src = src;
      video.load();
      start();
    }

    return () => {
      cancelled = true;
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onPlaying);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error', onError);
      if (hls) hls.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [videoRef, src, attempt]);

  return status;
}

export default function CameraPreviewModal({ source, onClose }) {
  const [mode, setMode] = useState(source.clipUrl ? 'clip' : 'live'); // clip | live
  const canToggle = Boolean(source.clipUrl && source.liveStreamUrl);
  const [attempt, setAttempt] = useState(0); // bump to retry the same source
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(true);   // autoplay requires muted
  const [volume, setVolume] = useState(1);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const videoRef = useRef(null);
  const frameRef = useRef(null);
  const closeRef = useRef(null);

  const live = mode === 'live';
  const src = live ? source.liveStreamUrl : source.clipUrl;
  const status = useVideoSource(videoRef, src, attempt);

  // Esc closes (unless the browser is using Esc to leave fullscreen); focus
  // moves into the dialog and returns to the trigger on close; page scroll is
  // locked while open.
  useEffect(() => {
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose();
    };
    const onFs = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [onClose]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }, []);

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.5;
  };

  const onVolume = (e) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Number(e.target.value);
    v.muted = v.volume === 0;
  };

  const onSeek = (e) => {
    const v = videoRef.current;
    if (!v || live) return;
    v.currentTime = Number(e.target.value);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else frameRef.current?.requestFullscreen?.();
  };

  const playbackHref = `/playback?${new URLSearchParams({ camera: source.cameraId, time: source.startTimeISO })}`;
  const iconBtn = 'flex h-11 w-11 shrink-0 lg:h-8 lg:w-8 items-center justify-center rounded-md text-white/90 transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40 disabled:hover:bg-transparent';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-[calc(var(--app-vw)*0.025)] backdrop-blur-sm sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="camera-preview-title"
        className="flex max-h-[calc(var(--app-vh)*0.9)] w-[calc(var(--app-vw)*0.95)] flex-col overflow-y-auto rounded-2xl border border-line bg-surface shadow-2xl sm:w-full sm:max-w-3xl"
      >
        {/* Header — camera, mode badge, close */}
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4 sm:py-3">
          <div className="min-w-0 flex-1">
            <h2 id="camera-preview-title" className="truncate text-heading text-fg">{source.cameraName}</h2>
            <p className="truncate text-caption text-fg-muted">{source.subtitle || `${source.title}${source.employee ? ` · ${source.employee}` : ''}`}</p>
          </div>
          {live ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-micro font-bold uppercase tracking-wide text-danger-ink ring-1 ring-danger-line">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
              </span>
              Live
            </span>
          ) : (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-surface-muted px-2 py-0.5 text-micro font-semibold uppercase tracking-wide text-fg-muted ring-1 ring-line">
              Recorded Event · {source.timestamp}
            </span>
          )}
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close preview"
            className="flex h-11 w-11 shrink-0 lg:h-8 lg:w-8 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-sunken hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Player */}
        <div ref={frameRef} className="group relative aspect-video max-h-[calc(var(--app-vh)*0.6)] w-full shrink-0 bg-black">
          <video
            ref={videoRef}
            className="h-full w-full object-contain"
            playsInline
            muted={muted}
            onClick={togglePlay}
            onPlay={() => setPaused(false)}
            onPause={() => setPaused(true)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
            onEmptied={() => { setTime(0); setDuration(0); }}
            onVolumeChange={(e) => { setMuted(e.currentTarget.muted); setVolume(e.currentTarget.volume); }}
          />

          {status === 'loading' && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-white/80">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-caption">{live ? 'Connecting to live stream…' : 'Buffering event clip…'}</span>
            </div>
          )}

          {status === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-white/85">
              <VideoOff className="h-8 w-8" />
              <p className="text-small font-semibold">{live ? 'Live stream unavailable' : 'Event clip unavailable'}</p>
              <p className="text-caption text-white/60">
                {source.cameraId} may be offline, or the {live ? 'stream' : 'clip'} has not been recorded yet.
              </p>
              <button
                onClick={() => setAttempt((n) => n + 1)}
                className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-white/30 px-3 py-1.5 text-caption font-semibold transition hover:bg-white/10"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </button>
            </div>
          )}

          {/* Transport — play/pause · scrub · time · volume · fullscreen */}
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-2 pb-2 pt-6">
            <button onClick={togglePlay} className={iconBtn} aria-label={paused ? 'Play' : 'Pause'} disabled={status === 'error'}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>

            {live ? (
              <div className="flex flex-1 items-center gap-2 px-1">
                <div className="h-1 flex-1 rounded-full bg-danger/70" aria-hidden />
                <span className="text-micro font-bold uppercase tracking-wide text-white/80">Live edge</span>
              </div>
            ) : (
              <>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.1}
                  value={Math.min(time, duration || 0)}
                  onChange={onSeek}
                  disabled={!duration}
                  aria-label="Seek"
                  className="h-1 min-w-0 flex-1 cursor-pointer accent-white disabled:cursor-default"
                />
                <span className="shrink-0 text-micro tabular-nums text-white/80">{fmt(time)} / {fmt(duration)}</span>
              </>
            )}

            <button onClick={toggleMute} className={iconBtn} aria-label={muted ? 'Unmute' : 'Mute'}>
              {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={onVolume}
              aria-label="Volume"
              className="hidden h-1 w-20 cursor-pointer accent-white sm:block"
            />
            <button onClick={toggleFullscreen} className={iconBtn} aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
              {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Control bar — mode toggle + hand-off to full playback */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-4 sm:py-3">
          {canToggle ? (
            <button
              onClick={() => { setMode(live ? 'clip' : 'live'); setAttempt(0); }}
              className="inline-flex items-center gap-1.5 min-h-11 rounded-lg bg-brand px-3 py-2 lg:min-h-0 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover"
            >
              {live ? <><History className="h-4 w-4" /> View Event Clip</> : <><Radio className="h-4 w-4" /> Switch to Live</>}
            </button>
          ) : <span />}
          <Link
            to={playbackHref}
            className="inline-flex min-h-11 items-center gap-1.5 text-small lg:min-h-0 font-semibold text-brand-ink transition hover:underline"
          >
            Open Full Playback View <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}
