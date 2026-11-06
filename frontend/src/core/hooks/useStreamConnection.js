/**
 * useStreamConnection — React hook over the global stream registry.
 *
 * Usage:
 *   const { state, mediaStream, error } = useStreamConnection(monitorId);
 *   useEffect(() => {
 *     if (videoRef.current && mediaStream) {
 *       videoRef.current.srcObject = mediaStream;
 *     }
 *   }, [mediaStream]);
 *
 * The component never owns the PeerConnection. Mount → subscribe;
 * unmount → unsubscribe (with a 30 s grace window before the underlying
 * connection actually closes). See services/streamRegistry.js for the
 * lifecycle reasoning.
 */
import { useEffect, useState } from 'react';

import { subscribe, reconnect } from '@/core/services/streamRegistry';

export function useStreamConnection(monitorId) {
  const [snap, setSnap] = useState({
    state: 'connecting',
    mediaStream: null,
    error: null,
    monitorId,
  });

  useEffect(() => {
    if (!monitorId) {
      setSnap({ state: 'offline', mediaStream: null, error: null, monitorId: null });
      return undefined;
    }
    return subscribe(monitorId, setSnap);
  }, [monitorId]);

  return {
    ...snap,
    // Re-negotiate this monitor's connection. Use this from a stall
    // watchdog (the video element's currentTime isn't advancing).
    reconnect: () => reconnect(monitorId),
  };
}

export default useStreamConnection;
