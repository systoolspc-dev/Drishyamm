import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

/**
 * useAdaptivePlayback — runtime adjustment of jitter-buffer / latency targets.
 *
 * The streamCache picks aggressive defaults (maxBufferLength 4s, lowLatencyMode
 * on, liveSyncDurationCount 1) because most cameras on a healthy LAN deliver
 * smooth frames. On flaky networks or bursty NVRs the player stalls visibly.
 *
 * This hook *measures* stall pressure on the actual <video> element and the
 * HLS.js event stream, then nudges the live HLS config in three regimes:
 *
 *   smooth (default)  → maxBufferLength 6,  liveSyncDurationCount 3   (~1s behind live)
 *   bumpy             → maxBufferLength 12, liveSyncDurationCount 6   (~2s latency)
 *   choppy            → maxBufferLength 20, liveSyncDurationCount 10  (~3s latency)
 *
 * NOTE: `smooth` deliberately uses liveSyncDurationCount 3, NOT 1. A value of 1
 * left the player ~1 part behind live with no jitter cushion and stalled on the
 * slightest bursty fragment timing — the most common cause of "choppy live".
 * The streamCache instance also sets liveSyncOnStallIncrease 0.1 +
 * maxLiveSyncPlaybackRate 1.5 once at creation; this hook never touches those,
 * so they persist across every profile change.
 *
 * We *promote* (towards larger buffer) on the FIRST stall — frame freezes are
 * highly visible. We *demote* (back towards low latency) only after 60 s of
 * uninterrupted playback. This asymmetry biases the player towards smoothness
 * for the first minute after a stall — common pattern when an NVR's bursty
 * fragment timing is the underlying issue.
 *
 * For WebRTC, we expose receivers' playoutDelayHint as a separate setter:
 *   smooth → 0.1s,  bumpy → 0.3s,  choppy → 0.5s.
 *
 * The hook is purely additive — it never tears down or recreates instances.
 */

const PROFILES = {
  smooth: { maxBufferLength: 6,  liveSyncDurationCount: 3,  playoutDelayHint: 0.1 },
  bumpy:  { maxBufferLength: 12, liveSyncDurationCount: 6,  playoutDelayHint: 0.3 },
  choppy: { maxBufferLength: 20, liveSyncDurationCount: 10, playoutDelayHint: 0.5 },
};

const STALL_WINDOW_MS = 30_000;     // how long a stall counts against us
const STABLE_DEMOTE_MS = 60_000;     // smooth playback before stepping back down

export default function useAdaptivePlayback({
  videoRef, hlsRef, pcRef, enabled = true,
  // Phase 2.3 — starting profile picked by the caller based on
  // navigator.connection (see useNetworkClass). Defaults to 'smooth'
  // for back-compat.
  initialProfile = 'smooth',
  // Phase 2.3 — preferred way to push playoutDelayHint into the shared
  // streamRegistry PC. If provided, this is used INSTEAD of pcRef.
  // Signature: setPlayoutDelayHint(seconds: number) → void.
  setPlayoutDelayHint = null,
}) {
  const stallTimes = useRef([]);          // ts of recent stalls
  const lastStallAt = useRef(0);
  const profileRef = useRef(initialProfile);
  const [profile, setProfile] = useState(initialProfile);

  function applyProfile(name) {
    const p = PROFILES[name];
    if (!p) return;
    profileRef.current = name;
    setProfile(name);

    // HLS.js tunables can be changed live; the running buffer ramps to the
    // new setting on the next FRAG_BUFFERED tick.
    if (hlsRef?.current) {
      hlsRef.current.config.maxBufferLength       = p.maxBufferLength;
      hlsRef.current.config.maxMaxBufferLength    = p.maxBufferLength * 2;
      hlsRef.current.config.liveSyncDurationCount = p.liveSyncDurationCount;
    }

    // WebRTC: playoutDelayHint controls how much the browser keeps in its
    // jitter buffer before rendering. Larger = smoother but more behind live.
    // Prefer the explicit setter (streamRegistry-owned PC) when provided;
    // fall back to the legacy pcRef path for components that still own their
    // own RTCPeerConnection. Both are exclusive — using both would just
    // overwrite the same property twice.
    if (typeof setPlayoutDelayHint === 'function') {
      try { setPlayoutDelayHint(p.playoutDelayHint); } catch (_) { /* no-op */ }
    } else if (pcRef?.current) {
      try {
        pcRef.current.getReceivers().forEach((r) => {
          if ('playoutDelayHint' in r) r.playoutDelayHint = p.playoutDelayHint;
        });
      } catch (_) { /* not all browsers support it */ }
    }
  }

  // If the caller's network class changes mid-session (carrier handoff,
  // wifi→cellular), reset to that new initial profile. We don't blindly
  // overwrite a profile the stall-promotion logic has already pushed
  // toward — only step DOWN to the cleaner network's profile if it's
  // cleaner than current.
  useEffect(() => {
    if (!enabled) return;
    const order = ['smooth', 'bumpy', 'choppy'];
    const incomingIdx = order.indexOf(initialProfile);
    const currentIdx  = order.indexOf(profileRef.current);
    if (incomingIdx < 0 || currentIdx < 0) return;
    // Only adopt a STRICTER (higher latency) initial if it's worse than
    // we currently are, or a LESS strict initial if no stalls in the
    // last STABLE_DEMOTE_MS — same hysteresis as the demote loop.
    if (incomingIdx > currentIdx) {
      applyProfile(initialProfile);
    } else if (incomingIdx < currentIdx &&
               Date.now() - lastStallAt.current > STABLE_DEMOTE_MS) {
      applyProfile(initialProfile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProfile, enabled]);

  function noteStall(reason) {
    const now = Date.now();
    stallTimes.current = stallTimes.current.filter((t) => now - t < STALL_WINDOW_MS);
    stallTimes.current.push(now);
    lastStallAt.current = now;

    const recent = stallTimes.current.length;
    let next = profileRef.current;
    if (recent >= 4)      next = 'choppy';
    else if (recent >= 1) next = 'bumpy';
    if (next !== profileRef.current) {
      // eslint-disable-next-line no-console
      console.info(`[AdaptivePlayback] promote ${profileRef.current} → ${next} (${reason}, ${recent} stalls/30s)`);
      applyProfile(next);
    }
  }

  // ── Observers ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return undefined;
    const video = videoRef?.current;
    const hls   = hlsRef?.current;

    const onWaiting = () => noteStall('media:waiting');
    const onStalled = () => noteStall('media:stalled');
    video?.addEventListener('waiting', onWaiting);
    video?.addEventListener('stalled', onStalled);

    const onHlsErr = (_evt, data) => {
      if (!data) return;
      // hls.js emits BUFFER_STALLED_ERROR (non-fatal) when playback freezes
      if (data.details === 'bufferStalledError' || data.details === 'bufferNudgeOnStall') {
        noteStall(`hls:${data.details}`);
      }
    };
    hls?.on(Hls.Events.ERROR, onHlsErr);

    // Demote loop — every 5s check if we've been smooth long enough to step down
    const demote = setInterval(() => {
      if (profileRef.current === 'smooth') return;
      if (Date.now() - lastStallAt.current < STABLE_DEMOTE_MS) return;
      const next = profileRef.current === 'choppy' ? 'bumpy' : 'smooth';
      // eslint-disable-next-line no-console
      console.info(`[AdaptivePlayback] demote ${profileRef.current} → ${next}`);
      applyProfile(next);
    }, 5000);

    return () => {
      video?.removeEventListener('waiting', onWaiting);
      video?.removeEventListener('stalled', onStalled);
      hls?.off(Hls.Events.ERROR, onHlsErr);
      clearInterval(demote);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, videoRef?.current, hlsRef?.current, pcRef?.current]);

  // Apply the initial profile once on mount so playoutDelayHint + HLS
  // tunables take effect from the first frame. initialProfile comes from
  // the network class — if it's anything other than 'smooth' we already
  // know the network is too slow to start aggressive.
  useEffect(() => {
    if (enabled) applyProfile(initialProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { profile, applyProfile };
}
