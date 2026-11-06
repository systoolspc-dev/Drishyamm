/**
 * streamCache — persistent stream instance manager (MediaMTX v2.0)
 *
 * Keeps HLS.js instances alive across component mounts/unmounts so that
 * switching cameras does NOT restart the stream. Coming back to a camera
 * that was already opened reattaches the existing instance instantly.
 *
 * Also stores the WebRTC URL so DirectStreamPlayer can attempt WebRTC first
 * (sub-500ms) and fall back to HLS automatically.
 */

import api from '@/core/services/api';
import { hevcParam } from '@/core/services/codecSupport';
import Hls from 'hls.js';

// monitorId → { webrtcUrl, hlsUrl, hlsSubUrl, hls, lastAccess }
const registry = new Map();

// monitorId → in-flight Promise (deduplicates concurrent acquireStream calls)
const inFlight = new Map();

// Bound the warm-HLS cache. Without a cap, every camera opened on any page
// (Playback, Gallery, Footfall, AiFeed, Map, MonitorWall…) left its HLS.js
// instance alive forever — releaseAllStreams() only ran on the LiveView page.
// A long session browsing many cameras leaked ~1 HLS instance + buffers each.
// We keep instances warm for fast reattach but evict the least-recently-used
// DETACHED ones (never a currently-attached/visible stream) once over cap.
const MAX_CACHED_STREAMS = 32;

function cacheKey(monitorId, quality = 'auto') {
  return `${monitorId}:${quality || 'auto'}`;
}

function touch(key) {
  const entry = registry.get(key);
  if (entry) entry.lastAccess = Date.now();
}

/**
 * Evict least-recently-used DETACHED HLS instances until the cache is within
 * MAX_CACHED_STREAMS. An instance is "attached" (and skipped) while its hls is
 * bound to a <video> element (hls.media) — evicting that would kill a visible
 * tile. If every entry is attached we simply stay over cap until one detaches.
 */
function enforceCap(protectKey = null) {
  if (registry.size <= MAX_CACHED_STREAMS) return;
  const evictable = [...registry.entries()]
    .filter(([k, e]) => k !== protectKey && !e.hls?.media)   // detached, not the just-created one
    .sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0)); // oldest first
  let over = registry.size - MAX_CACHED_STREAMS;
  for (const [key, entry] of evictable) {
    if (over <= 0) break;
    try { entry.hls?.destroy(); } catch (_) {}
    registry.delete(key);
    over--;
  }
}

/**
 * Read the auth JWT. Used by xhrSetup so HLS.js can send `Authorization`
 * on the master-playlist fetch (variant playlists from MediaMTX stay unauthed).
 *
 * The token is persisted directly as `auth_token` by authService — see
 * services/auth.js.
 */
function getAuthToken() {
  return localStorage.getItem('auth_token');
}

function createHlsInstance() {
  return new Hls({
    enableWorker:                true,
    // Smoothness-first live playback. The old setup (liveSyncDurationCount:1,
    // no catch-up rate, default stall-drift) kept the player ~1 part behind
    // live with zero cushion, so ANY camera/NVR jitter stalled it — and once
    // stalled it could not recover its latency target without a full rebuild.
    // This config trades ~1s of latency for a stream that absorbs jitter and
    // self-corrects. WebRTC stays the sub-500ms path for single-view; HLS is
    // the grid/fallback path where smoothness matters more than raw latency.
    lowLatencyMode:              true,
    autoStartLoad:               false,
    startPosition:               -1,
    backBufferLength:            4,
    maxBufferLength:             6,
    maxMaxBufferLength:          12,
    // Cushion of ~3 parts/segments behind live (raised from 1, which was below
    // hls.js's own default of 3). This is the single biggest anti-stutter lever.
    liveSyncDurationCount:       3,
    // Don't hard-seek to the live edge on minor drift; allow real headroom.
    liveMaxLatencyDurationCount: 10,
    // ROOT-CAUSE FIX: hls.js adds `liveSyncOnStallIncrease` (default 1.0s) to
    // the target latency on EVERY stall and never resets it without recreating
    // the player (hls.js #6350). At 0.1s that drift is negligible and
    // effectively self-healing instead of a one-way ratchet up to 4s+.
    liveSyncOnStallIncrease:     0.1,
    // Catch back up to live by gently speeding up (<=1.5x) rather than seeking.
    // A seek is a visible jump/stutter; rate-based catch-up is invisible.
    maxLiveSyncPlaybackRate:     1.5,
    // Manifest retries are generous — MediaMTX HLS muxer can take 1-4 s to
    // warm up after a path becomes ready. Without enough retries the player
    // gives up before the muxer's first segments land.
    manifestLoadingTimeOut:      8000,
    manifestLoadingMaxRetry:     6,
    manifestLoadingRetryDelay:   1000,
    levelLoadingTimeOut:         8000,
    levelLoadingMaxRetry:        4,
    levelLoadingRetryDelay:      1000,
    fragLoadingTimeOut:          10000,
    fragLoadingMaxRetry:         5,
    fragLoadingRetryDelay:       1000,
    // ABR: start adaptively, mid-bitrate initial estimate
    startLevel:                  -1,
    abrEwmaDefaultEstimate:      1_000_000,
    /**
     * Inject the JWT only on the master-playlist fetch (which goes through
     * our backend). Variant playlists / segments hit MediaMTX directly and
     * stay unauthed — adding a Bearer header to a cross-origin MediaMTX
     * request would just trigger a CORS preflight without changing access.
     */
    xhrSetup: (xhr, url) => {
      if (url.includes('/api/stream/master/')) {
        const token = getAuthToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        return;
      }
      // Everything else goes straight to MediaMTX, which hands out an HLS
      // session as a `cookieCheck` cookie on the master playlist (via a 302)
      // and then REJECTS the variant playlist / segments that arrive without
      // it — HTTP 401 "authentication error", which Chrome surfaces to the
      // page as the far less obvious `net::ERR_BLOCKED_BY_ORB`.
      //
      // hls.js does not send credentials on cross-origin requests by default,
      // so that cookie never came back and every tile failed. MediaMTX already
      // answers with `Access-Control-Allow-Credentials: true` and an explicit
      // (non-wildcard) `Access-Control-Allow-Origin`, which is exactly what a
      // credentialed CORS request requires — so this is safe to turn on.
      xhr.withCredentials = true;
    },
  });
}

/** Remove a camera from the registry (e.g. after a fatal HLS error). */
export function evictStream(monitorId, quality = null) {
  if (quality) {
    const key = cacheKey(monitorId, quality);
    const entry = registry.get(key);
    try { entry?.hls?.destroy(); } catch (_) {}
    registry.delete(key);
    return;
  }
  for (const [key, entry] of registry.entries()) {
    if (!key.startsWith(`${monitorId}:`)) continue;
    try { entry?.hls?.destroy(); } catch (_) {}
    registry.delete(key);
  }
}

/**
 * Get (or create) stream entry for a camera.
 * Calls GET /api/stream/start/:monitorId to obtain MediaMTX URLs,
 * then creates an HLS.js instance for the HLS fallback path.
 *
 * Returns { webrtcUrl, hlsUrl, hls, fresh }
 *   fresh=true  → brand-new instance, caller must attach + load
 *   fresh=false → existing running instance, caller reattaches
 */
export async function acquireStream(monitorId, { quality = 'auto' } = {}) {
  if (!monitorId) throw new Error('monitorId is required');
  const key = cacheKey(monitorId, quality);

  if (registry.has(key)) {
    touch(key);
    return { ...registry.get(key), fresh: false };
  }

  if (inFlight.has(key)) {
    await inFlight.get(key);
    touch(key);
    return { ...registry.get(key), fresh: false };
  }

  // Tell the server whether this machine can decode H.265 itself. When it can,
  // the server skips the H.264 re-encode and serves the camera's native stream
  // (no encoder slot, no quality generation loss, lower latency).
  const promise = api.get(`/stream/start/${monitorId}`, {
    params: { quality, hevc: hevcParam() },
  })
    .then(({ data }) => {
      const webrtcUrl = data.webrtcUrl ?? null;
      const hlsUrl    = data.hlsUrl || data.streamUrl;
      const hlsSubUrl = data.hlsSubUrl ?? null;   // null for non-Hikvision / unsupported cameras
      // Master ABR playlist — HLS.js auto-switches between high (main) and
      // low (sub) variants based on measured bandwidth. Falls back to single-
      // variant hlsUrl when a sub-stream isn't available.
      //
      // api.defaults.baseURL already ends in `/api`, and data.masterUrl starts
      // with `/api/...`, so we strip the duplicate prefix from one side.
      const apiOrigin = (api.defaults.baseURL || '').replace(/\/api\/?$/, '');
      const masterUrl = data.masterUrl ? `${apiOrigin}${data.masterUrl}` : null;
      const hls       = createHlsInstance();
      registry.set(key, { webrtcUrl, hlsUrl, hlsSubUrl, masterUrl, hls, lastAccess: Date.now() });
      inFlight.delete(key);
      enforceCap(key);
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });

  inFlight.set(key, promise);
  await promise;
  return { ...registry.get(key), fresh: true };
}

/** Detach HLS from video element without destroying it. */
export function detachStream(monitorId, quality = 'auto') {
  const entry = registry.get(cacheKey(monitorId, quality));
  if (!entry) return;
  try { entry.hls.detachMedia(); } catch (_) {}
}

/** Destroy all HLS instances — call when leaving the live view page. */
export function releaseAllStreams() {
  for (const { hls } of registry.values()) {
    try { hls.destroy(); } catch (_) {}
  }
  registry.clear();
  inFlight.clear();
}

// Legacy compat
export function getStreamUrls(monitorId) {
  return acquireStream(monitorId).then(({ hlsUrl, webrtcUrl }) => ({ hlsUrl, webrtcUrl }));
}
export function releaseStream() {} // no-op — streams stay alive
