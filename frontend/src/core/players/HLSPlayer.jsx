import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Volume2, VolumeX, Gauge } from 'lucide-react';
import { acquireStream, detachStream, evictStream } from '@/core/services/streamCache';
import useAdaptivePlayback from '@/core/hooks/useAdaptivePlayback';
import useNetworkClass, { CLASS_TO_PROFILE } from '@/core/hooks/useNetworkClass';
import PlayerFrame from './PlayerFrame';

function labelFromHeight(h) {
  if (!h) return null;
  if (h >= 1080) return '1080p';
  if (h >= 720)  return '720p';
  if (h >= 480)  return '480p';
  if (h >= 360)  return '360p';
  if (h >= 240)  return '240p';
  return `${h}p`;
}

/**
 * HLSPlayer — HLS-only stream player (hls.js + Safari native).
 *
 * Deliberately knows nothing about WebRTC: no RTCPeerConnection, no registry.
 * This is the "reliable" path used by the /live-hls route and by grid tiles
 * (many cameras at once). The HLS.js instance is kept warm in streamCache
 * across mounts so camera switches reattach instantly.
 *
 * quality: 'auto' (ABR master) | 'high' (main variant) | 'low' (sub variant).
 */
export default function HLSPlayer({
  monitorId,
  quality = 'auto',
  muted = true,
  controls = true,
  qualityControl = true,
  volumeToggle = false,
  // See WebRTCPlayer: off for surfaces that render their own status chip.
  protocolBadge = true,
  className = '',
  aiOverlay = true,
  digitalZoom = true,
  fit = 'contain',
}) {
  const videoRef = useRef(null);
  const hlsRef   = useRef(null);
  const retryRef = useRef(0);
  const fallbackToMainRef = useRef(false);

  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);
  const [levels, setLevels] = useState([]);
  const [, setCurrentLevel] = useState(-1);
  const [, setActiveLevel]  = useState(-1);
  const [showQualityMenu, setShowMenu] = useState(false);

  const [userMuted, setUserMuted] = useState(muted);
  useEffect(() => { setUserMuted(muted); }, [muted, monitorId]);

  const [activeQuality, setActiveQuality] = useState(quality);
  useEffect(() => { setActiveQuality(quality); }, [quality, monitorId]);

  const netClass = useNetworkClass();
  const initialProfile = CLASS_TO_PROFILE[netClass] || 'smooth';

  const adaptive = useAdaptivePlayback({
    videoRef, hlsRef, pcRef: { current: null },
    enabled: state === 'playing',
    initialProfile,
    setPlayoutDelayHint: () => {},   // no-op for HLS
  });

  const toggleMute = () => {
    const v = videoRef.current;
    const next = !userMuted;
    setUserMuted(next);
    if (v) {
      v.muted = next;
      if (!next) v.play().catch(() => {});
    }
  };

  const pickHlsUrl = ({ hlsUrl, hlsSubUrl, masterUrl }) =>
    activeQuality === 'low'  ? (fallbackToMainRef.current ? hlsUrl : (hlsSubUrl || hlsUrl))
  : activeQuality === 'high' ? hlsUrl
  : (masterUrl || hlsUrl);

  useEffect(() => {
    if (!monitorId || !videoRef.current) return;

    let mounted = true;
    retryRef.current = 0;
    fallbackToMainRef.current = false;
    setState('loading');
    setError(null);
    if (videoRef.current) videoRef.current.srcObject = null;

    acquireStream(monitorId, { quality: activeQuality })
      .then(({ hlsUrl, hlsSubUrl, masterUrl, hls, fresh }) => {
        if (!mounted || !videoRef.current) return;
        startHLS(pickHlsUrl({ hlsUrl, hlsSubUrl, masterUrl }), hls, fresh, mounted);
      })
      .catch((err) => {
        if (mounted) { setState('error'); setError(err.message || 'Failed to get stream URL'); }
      });

    return () => {
      mounted = false;
      detachStream(monitorId, activeQuality);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorId, activeQuality]);

  function startHLS(hlsUrl, hls, fresh, mounted) {
    // Safari: native HLS
    if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.current.src = hlsUrl;
      videoRef.current.addEventListener('loadedmetadata', () => {
        if (mounted) { setState('playing'); videoRef.current.play().catch(() => {}); }
      });
      return;
    }

    hlsRef.current = hls;

    if (fresh) {
      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
        if (!mounted) return;
        const lv = (data?.levels || hls.levels || []).map((l, idx) => ({
          idx,
          height:  l.height || 0,
          bitrate: l.bitrate || 0,
          name:    l.name || labelFromHeight(l.height) || `Level ${idx + 1}`,
        }));
        setLevels(lv);
        setCurrentLevel(hls.currentLevel ?? -1);
        setState('playing');
        hls.startLoad(-1);
        videoRef.current?.play().catch(() => {});
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => setActiveLevel(data.level));

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (!videoRef.current || !hls.liveSyncPosition) return;
        if (hls.liveSyncPosition - videoRef.current.currentTime > 2) hls.seekToLiveEdge();
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          hls.destroy();
          evictStream(monitorId, activeQuality);
          if (!mounted) return;
          if (retryRef.current < 5) {
            retryRef.current++;
            if (activeQuality === 'low') fallbackToMainRef.current = true;
            setState('loading');
            setError(null);
            setTimeout(() => {
              if (!mounted || !videoRef.current) return;
              acquireStream(monitorId, { quality: activeQuality })
                .then(({ hlsUrl: hUrl, hlsSubUrl: hsUrl, masterUrl: mUrl, hls: newHls, fresh: f }) => {
                  if (mounted) startHLS(pickHlsUrl({ hlsUrl: hUrl, hlsSubUrl: hsUrl, masterUrl: mUrl }), newHls, f, mounted);
                })
                .catch(() => {
                  if (mounted) { setState('error'); setError('Camera stream unavailable.'); }
                });
            }, 3000);
          } else {
            setState('error');
            setError('Camera stream unavailable. Check camera is online.');
          }
        }
      });

      hls.attachMedia(videoRef.current);
      hls.loadSource(hlsUrl);
    } else {
      hls.attachMedia(videoRef.current);
      setState('playing');
      videoRef.current?.play().catch(() => {});
      hls.seekToLiveEdge();
    }
  }

  const handleRetry = () => {
    retryRef.current = 0;
    evictStream(monitorId, activeQuality);
    setState('loading');
    setError(null);
    acquireStream(monitorId, { quality: activeQuality })
      .then(({ hlsUrl, hlsSubUrl, masterUrl, hls, fresh }) =>
        startHLS(pickHlsUrl({ hlsUrl, hlsSubUrl, masterUrl }), hls, fresh, true))
      .catch((err) => { setState('error'); setError(err.message || 'Failed to connect'); });
  };

  return (
    <PlayerFrame
      videoRef={videoRef}
      monitorId={monitorId}
      state={state}
      error={error}
      onRetry={handleRetry}
      muted={userMuted}
      controls={controls}
      aiOverlay={aiOverlay}
      digitalZoom={digitalZoom}
      fit={fit}
      className={className}
    >
      {/* HLS badge */}
      {protocolBadge && state === 'playing' && !qualityControl && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 px-2 py-0.5 rounded-full pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
          <span className="text-micro font-semibold text-info tracking-wider">LIVE · HLS</span>
        </div>
      )}

      {/* Network-health pill. Gated on `protocolBadge` like the LIVE chip:
          surfaces that draw their own corner chrome (grid tiles put the camera
          name at top-left) own that corner, and a second pill lands on top of
          it. The internal profile name stays in the tooltip — an operator has
          no use for "bumpy" / "choppy" on the tile itself. */}
      {protocolBadge && state === 'playing' && adaptive.profile !== 'smooth' && (
        <div
          className="absolute top-2 left-2 flex items-center gap-1 bg-warning/20 backdrop-blur-sm border border-warning/40 px-2 py-0.5 rounded-full pointer-events-none"
          title={`Adaptive playback: ${adaptive.profile}`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-warning-line animate-pulse" />
          <span className="text-micro font-semibold text-warning tracking-wider uppercase">
            Buffering
          </span>
        </div>
      )}

      {volumeToggle && state === 'playing' && (
        <button
          type="button"
          onClick={toggleMute}
          className="absolute bottom-3 right-3 z-10 flex items-center justify-center w-9 h-9 rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/80 transition border border-white/10"
          title={userMuted ? 'Unmute audio' : 'Mute audio'}
        >
          {userMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
      )}

      {qualityControl && state === 'playing' && (
        <div className="absolute top-2 right-2 select-none">
          <button
            type="button"
            onClick={() => setShowMenu((s) => !s)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/60 text-white text-small font-semibold backdrop-blur-sm hover:bg-black/80 transition border border-white/10"
            title="Video quality"
          >
            <Gauge className="w-3.5 h-3.5" />
            {activeQuality === 'high' ? 'High' : activeQuality === 'low' ? 'Low' : 'Auto'}
          </button>

          {showQualityMenu && (
            <div className="absolute right-0 mt-1 min-w-[180px] rounded-md bg-black/90 backdrop-blur-sm border border-white/10 shadow-lg overflow-hidden">
              {[
                { v: 'auto', t: 'Auto',  s: 'Picks for you' },
                { v: 'high', t: 'High',  s: 'Clear · more data' },
                { v: 'low',  t: 'Low',   s: 'Saves data' },
              ].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => { setActiveQuality(o.v); setShowMenu(false); }}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-small text-left transition ${
                    activeQuality === o.v ? 'bg-white/15 text-white' : 'text-white/85 hover:bg-white/10'
                  }`}
                >
                  <span className="font-semibold">{o.t}</span>
                  <span className="text-white/50">{o.s}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </PlayerFrame>
  );
}
