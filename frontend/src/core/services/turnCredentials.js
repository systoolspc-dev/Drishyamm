/**
 * TURN-credentials fetcher with in-flight de-dupe + lifetime cache.
 *
 * Backend `/api/turn/credentials` returns short-lived iceServers (~1 hour
 * default). Every WebRTC connection wants TURN; we only want to issue
 * one network call per cache lifetime, not one per stream.
 *
 * Pattern:
 *   - First subscriber triggers the fetch; subsequent subscribers reuse
 *     the in-flight promise.
 *   - Once resolved, the result is cached until 60 seconds before it
 *     expires (gives time for in-flight ICE negotiations to complete
 *     before the cred goes stale).
 *   - If backend says `{ available: false }` (coturn not configured),
 *     we cache that decision for 5 minutes so we don't hammer the
 *     endpoint forever.
 *
 * If the user logs out or auth expires mid-session, the next refresh
 * will return 401; we clear the cache and fall back to STUN-only for
 * the next connection.
 */
import api from './api';

let cachedCreds = null;       // resolved value of last successful fetch
let cachedExpiry = 0;         // ms-epoch when cache becomes stale
let inflight = null;          // Promise of in-flight request (de-dupe)

// How long before the real cred expiry we treat cache as stale. Gives
// in-flight ICE negotiations a buffer to complete.
const REFRESH_LEAD_MS = 60_000;
// How long to remember "TURN not configured" before re-asking. 5 min.
const NEGATIVE_CACHE_MS = 5 * 60_000;

const STUN_ONLY = Object.freeze({
  available: false,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
});

/**
 * Returns `{ available, iceServers, username?, expiresAt? }`.
 * NEVER throws — falls back to STUN-only on any error so streaming
 * never blocks on TURN availability.
 */
export async function getIceServers() {
  const now = Date.now();
  if (cachedCreds && now < cachedExpiry) return cachedCreds;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data } = await api.get('/turn/credentials', { timeout: 5000 });
      if (!data || data.available === false) {
        cachedCreds = STUN_ONLY;
        cachedExpiry = now + NEGATIVE_CACHE_MS;
        return STUN_ONLY;
      }
      const expiryMs = data.expiresAt
        ? new Date(data.expiresAt).getTime()
        : (now + 30 * 60_000);
      cachedCreds = {
        available: true,
        iceServers: data.iceServers || [],
        username: data.username,
        expiresAt: data.expiresAt,
      };
      cachedExpiry = expiryMs - REFRESH_LEAD_MS;
      return cachedCreds;
    } catch (err) {
      // Don't poison the cache on transient failures — try again sooner.
      console.warn('[turnCredentials] fetch failed, falling back to STUN', err?.message);
      cachedCreds = STUN_ONLY;
      cachedExpiry = now + 30_000; // brief negative cache on error
      return STUN_ONLY;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Force a fresh fetch on next call. Use when the user logs in/out so a
 * stale cred from a previous session doesn't get reused.
 */
export function resetTurnCache() {
  cachedCreds = null;
  cachedExpiry = 0;
  inflight = null;
}

export default { getIceServers, resetTurnCache };
