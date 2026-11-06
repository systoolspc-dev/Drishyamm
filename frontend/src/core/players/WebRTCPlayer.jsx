import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { subscribe as subscribeToStream, setPlayoutDelayHint } from '@/core/services/streamRegistry';
import useAdaptivePlayback from '@/core/hooks/useAdaptivePlayback';
import useNetworkClass, { CLASS_TO_PROFILE } from '@/core/hooks/useNetworkClass';
import PlayerFrame from './PlayerFrame';

// Consecutive WHEP failures before a tile gives up on WebRTC and hands off to
// HLS. The registry retries every 4 s and a cold transcode publishes in ~2 s,
// so 3 gives a genuinely slow camera ~12 s while still bailing on a dead one.
const WEBRTC_FALLBACK_AFTER = 3;

/**
 * WebRTCPlayer — WebRTC (WHEP) only, sub-500ms latency.
 *
 * Knows nothing about HLS. The RTCPeerConnection is owned by streamRegistry
 * (persists across page navigation, refcounted with a grace window); this
 * component just subscribes to the shared MediaStream and reports state.
 *
 * When the registry's own retry loop gives up, we call `onFallback()` exactly
 * once and stop. We never switch protocols ourselves — the parent picker
 * decides whether to mount an HLSPlayer instead. That one-way hand-off is what
 * stops the old WebRTC⇄HLS thrash.
 */
export default function WebRTCPlayer({
  monitorId,
  // Which stream to ask the backend for. This used to not be a prop at all, so
  // every WebRTC surface — grid thumbnails included — fell through to the
  // backend's 'auto' default, which warms the camera's MAIN channel and blocks
  // on its transcode (~10 s) instead of taking the sub channel (~12 ms).
  quality = 'auto',
  muted = true,
  controls = true,
  className = '',
  aiOverlay = true,
  digitalZoom = true,
  fit = 'contain',
  volumeToggle = false,
  // Small "LIVE · WebRTC" corner pill. Dense surfaces (dashboard tiles) draw
  // their own status chip and switch this off so the two don't stack up in the
  // same corner.
  protocolBadge = true,
  onFallback,            // called once if WebRTC can't be established
}) {
  const videoRef = useRef(null);
  const pcRef    = useRef(null);   // holds the unsubscribe shim while subscribed
  const firedFallbackRef = useRef(false);

  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);

  const [userMuted, setUserMuted] = useState(muted);
  useEffect(() => { setUserMuted(muted); }, [muted, monitorId]);

  const netClass = useNetworkClass();
  const initialProfile = CLASS_TO_PROFILE[netClass] || 'smooth';

  useAdaptivePlayback({
    videoRef, hlsRef: { current: null }, pcRef,
    enabled: state === 'playing',
    initialProfile,
    setPlayoutDelayHint: (seconds) => setPlayoutDelayHint(monitorId, seconds),
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

  const fallback = () => {
    if (firedFallbackRef.current) return;
    firedFallbackRef.current = true;
    onFallback?.();
  };

  useEffect(() => {
    if (!monitorId || !videoRef.current) return;

    let mounted = true;
    firedFallbackRef.current = false;
    setState('loading');
    setError(null);
    if (videoRef.current) videoRef.current.srcObject = null;

    if (typeof RTCPeerConnection === 'undefined') {
      // Browser can't do WebRTC at all — hand off immediately.
      fallback();
      return () => { mounted = false; };
    }

    const unsubscribe = subscribeToStream(monitorId, (snap) => {
      if (!mounted) return;

      if (snap.mediaStream && videoRef.current && videoRef.current.srcObject !== snap.mediaStream) {
        videoRef.current.srcObject = snap.mediaStream;
        videoRef.current.play().catch(() => {});
      }

      if (snap.state === 'streaming') {
        setState('playing');
      } else if (snap.state === 'offline' && snap.error) {
        // NOT on the first miss. The backend answers a grid tile before the
        // transcoder has published (~2 s), so the first WHEP POST to a cold
        // camera 404s BY DESIGN, and the registry retries 4 s later — which
        // succeeds. Handing off to HLS here turned every cold tile into an HLS
        // player on the raw HEVC sub channel, which is what showed "Stream
        // Unavailable" with a Retry button on first load and then looked fine
        // on the next visit once everything was warm.
        //
        // So sit through the registry's retries and only give up on WebRTC
        // once the failures are consecutive enough to mean the path is dead.
        if ((snap.failures || 0) < WEBRTC_FALLBACK_AFTER) {
          setState('loading');
          return;
        }
        setError(snap.error);
        fallback();
      }
    }, { quality });

    pcRef.current = { close: unsubscribe };

    return () => {
      mounted = false;
      if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorId, quality]);

  return (
    <PlayerFrame
      videoRef={videoRef}
      monitorId={monitorId}
      state={state}
      error={error}
      onRetry={null}       // no manual retry — a failed WebRTC hands off to HLS
      muted={userMuted}
      controls={controls}
      aiOverlay={aiOverlay}
      digitalZoom={digitalZoom}
      fit={fit}
      className={className}
    >
      {protocolBadge && state === 'playing' && (
        <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 px-2 py-0.5 rounded-full pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
          <span className="text-micro font-semibold text-success tracking-wider">LIVE · WebRTC</span>
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
    </PlayerFrame>
  );
}
