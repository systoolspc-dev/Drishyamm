/**
 * Phase 4 — LiveKit room helpers.
 *
 * Backend `/api/livekit/token` mints short-lived participant JWTs scoped
 * to one camera's room. This module:
 *
 *   1. Caches tokens per (cameraId, role) until ~60 s before expiry.
 *   2. Provides `joinCameraRoom(cameraId)` → a connected LiveKit Room.
 *   3. Exposes `disconnectAll()` for SPA-wide teardown (logout flow).
 *
 * The LiveKit JS SDK is loaded on demand (dynamic import) — it's a
 * ~150 KB chunk we don't want in the initial bundle for operators who
 * never look at SFU-enabled cameras. The first call awaits the load;
 * subsequent calls reuse the same module.
 *
 * If the backend says `{ available: false }` (LIVEKIT_WS_URL unset),
 * we throw `SFU_NOT_AVAILABLE`. Callers fall back to the existing
 * MediaMTX WHEP path (DirectStreamPlayer) just like today.
 */
import api from './api';

const TOKEN_REFRESH_LEAD_MS = 60_000;
const NEGATIVE_CACHE_MS = 5 * 60_000;

const tokenCache = new Map();    // key → { resolved, expiresAt }
const inflight = new Map();      // key → Promise<token result>

// Dynamic-import handle for the LiveKit SDK. Loaded once; resolved
// promise reused.
let _livekitModulePromise = null;

export const SFU_NOT_AVAILABLE = 'sfu-not-available';

function cacheKey(cameraId, role) {
  return `${cameraId}::${role}`;
}

async function fetchToken(cameraId, role = 'subscriber') {
  const key = cacheKey(cameraId, role);
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && now < cached.expiresAt - TOKEN_REFRESH_LEAD_MS) return cached.resolved;
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const { data } = await api.post('/livekit/token', { cameraId, role });
      if (!data?.available) {
        tokenCache.set(key, {
          resolved: { available: false },
          expiresAt: now + NEGATIVE_CACHE_MS,
        });
        return { available: false };
      }
      const expiresAtMs = now + (Number(data.expiresIn) || 3600) * 1000;
      const resolved = {
        available: true,
        wsUrl: data.wsUrl,
        roomName: data.roomName,
        token: data.token,
        identity: data.identity,
        role: data.role,
        expiresAtMs,
      };
      tokenCache.set(key, { resolved, expiresAt: expiresAtMs });
      return resolved;
    } catch (err) {
      console.warn('[livekit] token fetch failed', err?.message);
      // Negative-cache transient failures briefly so we don't hammer.
      const resolved = { available: false, error: err?.message || 'token fetch failed' };
      tokenCache.set(key, { resolved, expiresAt: now + 30_000 });
      return resolved;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

async function loadLivekit() {
  if (!_livekitModulePromise) {
    // Lazy-load — vite will code-split this into its own chunk so the
    // operators on non-SFU cameras never pay the bundle cost.
    _livekitModulePromise = import('livekit-client');
  }
  return _livekitModulePromise;
}

/**
 * Join the LiveKit room for `cameraId` as a subscriber. Returns the
 * connected `Room` instance — callers attach their own TrackSubscribed
 * listeners and pull the video element from there.
 *
 * Throws SFU_NOT_AVAILABLE if the backend says LiveKit isn't configured;
 * caller is expected to catch and fall back to MediaMTX WHEP.
 */
export async function joinCameraRoom(cameraId, opts = {}) {
  const tokenInfo = await fetchToken(cameraId, opts.role || 'subscriber');
  if (!tokenInfo.available) {
    const err = new Error(tokenInfo.error || 'LiveKit not available');
    err.code = SFU_NOT_AVAILABLE;
    throw err;
  }
  const { Room, RoomEvent } = await loadLivekit();
  const room = new Room({
    // Adaptive stream so the SFU drops simulcast layers we don't need
    // for a small tile — see Phase 2.3's network-class profile.
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: { dtx: true },
  });
  await room.connect(tokenInfo.wsUrl, tokenInfo.token, {
    autoSubscribe: true,
  });
  return { room, tokenInfo, RoomEvent };
}

/**
 * Drop all cached tokens. Call from authStore on logout so a stale
 * token from the previous session doesn't get reused.
 */
export function resetTokenCache() {
  tokenCache.clear();
  inflight.clear();
}

export default { joinCameraRoom, resetTokenCache, SFU_NOT_AVAILABLE };
