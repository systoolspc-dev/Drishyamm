import { useEffect, useState } from 'react';
import WebRTCPlayer from './WebRTCPlayer';
import HLSPlayer from './HLSPlayer';
import RelayPlayer from './RelayPlayer';
import { relaySupported, forcedDecoder } from '@/core/services/liveRelay';

// Live relay (camera's own stream over WebSocket, GOP cache, no transcode
// where the device can decode it) is the default for WebRTC-mode surfaces.
// VITE_LIVE_RELAY=0 turns it off; ?decoder=webrtc forces the old path.
const RELAY_ON = import.meta.env.VITE_LIVE_RELAY !== '0';

/**
 * DirectStreamPlayer — thin picker over the two protocol-specific players.
 *
 * The WebRTC and HLS engines now live in separate, self-contained components
 * (player/WebRTCPlayer, player/HLSPlayer). This wrapper only decides which one
 * to mount and manages a single, ONE-WAY WebRTC→HLS hand-off so the two never
 * thrash against each other (the old "collapse").
 *
 *   mode='webrtc' (or 'auto')  → WebRTCPlayer; if it gives up, mount HLSPlayer
 *                                 once and stay there for this camera.
 *   mode='hls'                 → HLSPlayer only.
 *   quality='low'              → always HLS (the sub-stream is an HLS path).
 *   forceHls (legacy prop)     → same as mode='hls', kept for existing callers.
 *
 * Dedicated routes render the players directly: /live uses the WebRTC path,
 * /live-hls forces HLS.
 *
 * NOTE on grid tiles: they pass mode="webrtc" + quality="low", NOT forceHls, so
 * they stay on WebRTC and `quality` is what keeps them cheap — it must reach the
 * chosen player, and from there the /stream/start request. See `common` below.
 */
export default function DirectStreamPlayer({
  monitorId,
  mode,
  forceHls = false,
  quality = 'auto',
  muted = true,
  controls = true,
  qualityControl = true,
  volumeToggle = false,
  className = '',
  aiOverlay = true,
  digitalZoom = true,
  protocolBadge = true,
  fit = 'contain',
}) {
  // Resolve the effective mode. An explicit mode='webrtc' WINS — grid tiles and
  // the dashboard use it to stay on the low-latency WebRTC path (WHEP forwards
  // RTP directly, sidestepping MediaMTX's HLS muxer, which crashes on some
  // cameras' frame reordering → black tiles). forceHls / quality='low' only pin
  // HLS when WebRTC wasn't explicitly requested. WebRTC still falls back to HLS
  // on its own if it can't establish.
  const forceWebrtc = mode === 'webrtc';
  const wantHls = !forceWebrtc && (mode === 'hls' || forceHls || quality === 'low');
  const resolvedMode = wantHls ? 'hls' : 'webrtc';

  // One-way fallback latch. Reset whenever the camera / quality / mode changes
  // so a new view starts fresh on WebRTC again.
  const [fellBack, setFellBack] = useState(false);
  useEffect(() => { setFellBack(false); }, [monitorId, resolvedMode, quality]);

  const useHls = resolvedMode === 'hls' || fellBack;

  // Relay first; if it can't play here, one-way hand-off to WebRTC.
  const [relayFailed, setRelayFailed] = useState(false);
  useEffect(() => { setRelayFailed(false); }, [monitorId]);
  const useRelay = RELAY_ON && !relayFailed && resolvedMode === 'webrtc'
    && relaySupported() && forcedDecoder() !== 'webrtc';

  // `quality` belongs to BOTH players. It used to be handed to HLSPlayer only,
  // so every WebRTC surface silently dropped it and the backend applied its
  // 'auto' default — main channel, blocking transcode, ~10 s per call. Since
  // every caller here passes mode="webrtc", that meant NO tile anywhere was
  // getting the cheap sub-stream path it asked for.
  const common = {
    monitorId, quality, muted, controls, className, aiOverlay, digitalZoom,
    volumeToggle, protocolBadge, fit,
  };

  if (useRelay) {
    return <RelayPlayer {...common} onFallback={() => setRelayFailed(true)} />;
  }

  if (useHls) {
    return <HLSPlayer {...common} qualityControl={qualityControl} />;
  }

  return <WebRTCPlayer {...common} onFallback={() => setFellBack(true)} />;
}
