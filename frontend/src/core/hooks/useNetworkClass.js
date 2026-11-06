/**
 * useNetworkClass — translate the browser's Network Information API into one
 * of three streaming-relevant classes.
 *
 *   fast   — corporate / home wired / good wifi (>= 5 Mbps downlink, 4g/wifi)
 *   medium — congested wifi, decent mobile (1-5 Mbps, 4g/3g)
 *   slow   — saveData on, slow mobile, congested (< 1 Mbps, slow-2g/2g/3g)
 *
 * These map 1:1 to useAdaptivePlayback's smooth / bumpy / choppy profiles.
 * Picking the right *initial* profile avoids the bad UX where every session
 * starts on 'smooth' and then thrashes to 'choppy' after the first stall.
 *
 * Falls back to 'fast' when the Network Information API is unavailable
 * (Safari, older browsers) — biased toward "act like LAN" so we don't
 * pessimistically degrade quality for healthy clients.
 */
import { useEffect, useState } from 'react';

function classify(conn) {
  if (!conn) return 'fast';                            // API unavailable
  if (conn.saveData) return 'slow';                    // user asked for data-saver
  const et  = conn.effectiveType;
  const dl  = Number(conn.downlink) || 0;              // Mbps estimate
  const rtt = Number(conn.rtt) || 0;                   // ms
  if (et === 'slow-2g' || et === '2g')      return 'slow';
  if (dl > 0 && dl < 1)                     return 'slow';
  if (rtt > 600)                            return 'slow';
  if (et === '3g')                          return 'medium';
  if (dl > 0 && dl < 5)                     return 'medium';
  if (rtt > 300)                            return 'medium';
  return 'fast';
}

// Map class → useAdaptivePlayback profile. Centralised so future tuning
// only touches one table.
export const CLASS_TO_PROFILE = {
  fast:   'smooth',
  medium: 'bumpy',
  slow:   'choppy',
};

export default function useNetworkClass() {
  const conn = (typeof navigator !== 'undefined' && navigator.connection) || null;
  const [klass, setKlass] = useState(() => classify(conn));

  useEffect(() => {
    if (!conn) return undefined;
    const onChange = () => setKlass(classify(conn));
    // 'change' fires when downlink / effectiveType / saveData transitions
    conn.addEventListener?.('change', onChange);
    return () => conn.removeEventListener?.('change', onChange);
  }, [conn]);

  return klass;
}
