/**
 * WebRTCStream — view-side player. Owns the <video> element and the
 * stall watchdog; the WHEP negotiation + RTCPeerConnection live in
 * @/core/services/streamRegistry so navigations don't tear the stream down.
 *
 * Why the split (refactored 2026-05-27 for demo): before this change
 * every mount opened a new PC, which meant clicking between routes
 * triggered a full WHEP renegotiation + MediaMTX source-on-demand
 * cold-start. 3-6 s of black screen on every navigation. The registry
 * holds one PC per monitorId across the SPA's lifetime (with a 30 s
 * grace window after the last subscriber unmounts).
 *
 * What this component still does:
 *   - Renders the <video>
 *   - Attaches the registry's MediaStream to it
 *   - Runs a stall watchdog (currentTime not advancing → ask the
 *     registry to reconnect)
 *   - Calls onStateChange so the parent can render an MJPEG fallback
 *     when 'offline' persists
 *
 * What this component NO LONGER does:
 *   - Create / close RTCPeerConnections
 *   - POST to /whep
 *   - Wait for ICE gathering
 */
import { useEffect, useRef } from 'react';

import { useStreamConnection } from '@/core/hooks/useStreamConnection';

// If the <video> emits no progress event in this window after seeing
// 'streaming', we treat it as a stall and ask the registry to reconnect.
const STALL_WINDOW_MS = 8000;

export default function WebRTCStream({
  monitorId,
  className = '',
  muted = true,
  // Called on every state transition. Parent uses this to swap in
  // the MJPEG fallback when we're 'offline' for too long.
  onStateChange,
  // Latency vs smoothness trade-off. Lower = more interactive, more
  // visible jitter on bad networks. The default 100 ms favours
  // interactivity (the previous, unset, default was ~250 ms).
  playoutDelayMs = 100,
}) {
  const videoRef = useRef(null);
  const lastNotifiedStateRef = useRef(null);
  const { state, mediaStream, reconnect } = useStreamConnection(monitorId);

  // Push state transitions to the parent (status chip + MJPEG fallback
  // decisions). We dedupe so onStateChange fires only on real changes.
  useEffect(() => {
    if (state === lastNotifiedStateRef.current) return;
    lastNotifiedStateRef.current = state;
    onStateChange?.(state);
  }, [state, onStateChange]);

  // Attach / detach the MediaStream on the <video> element whenever the
  // registry produces a new one (initial track event, reconnect).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (mediaStream && video.srcObject !== mediaStream) {
      video.srcObject = mediaStream;
      // Some browsers won't auto-play a late-arriving srcObject without
      // an explicit .play() call — muted videos rarely fail this.
      video.play().catch(() => {});
    } else if (!mediaStream) {
      video.srcObject = null;
    }
  }, [mediaStream]);

  // Hint to the receiver about the latency we'd prefer. WebRTC has no
  // hard contract here, but Chromium honours it for receive jitter
  // buffer sizing. Setting on every track-add covers reconnects too.
  useEffect(() => {
    if (state !== 'streaming' || !mediaStream) return;
    try {
      // pc.getReceivers().forEach(r => r.playoutDelayHint = playoutDelayMs / 1000)
      // is what we'd normally do, but pc lives in the registry.
      // The hint can also be set on the track via the RTCRtpReceiver,
      // which is what we expose here via the MediaStream's tracks.
      const ms = playoutDelayMs / 1000;
      mediaStream.getTracks().forEach((track) => {
        // Some browsers expose receiver on the track via internal
        // properties; the standardised path is pc.getReceivers. We
        // attempt the per-track shortcut where supported.
        if (track && typeof track.playoutDelayHint === 'number') {
          track.playoutDelayHint = ms;
        }
      });
    } catch (_) { /* hint is best-effort */ }
  }, [state, mediaStream, playoutDelayMs]);

  // Stall watchdog — independent of the registry because it observes
  // *this* component's <video> element. If currentTime doesn't advance
  // past a 'streaming' transition for STALL_WINDOW_MS, signal the
  // registry to renegotiate. Other subscribers of the same monitorId
  // get the new MediaStream automatically.
  useEffect(() => {
    if (state !== 'streaming') return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    let lastTime = -1;
    let lastProgressTs = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastProgressTs = now;
        return;
      }
      if (now - lastProgressTs > STALL_WINDOW_MS) {
        // Reset our local timer so we don't trigger reconnect every tick.
        lastProgressTs = now;
        reconnect();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [state, reconnect]);

  return (
    <video
      ref={videoRef}
      muted={muted}
      autoPlay
      playsInline
      controls={false}
      className={className}
    />
  );
}
