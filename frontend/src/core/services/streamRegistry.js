/**
 * streamRegistry — one persistent WebRTC connection per monitorId, shared
 * across every page that wants to watch it.
 *
 * The problem this solves: every page that showed video used to create its
 * own RTCPeerConnection on mount and tear it down on unmount. Clicking
 * between routes triggered a fresh WHEP negotiation + RTSP cold-start on
 * MediaMTX every time → 3-6 s of black screen on every navigation. With
 * this registry:
 *
 *   - Pages call `subscribe(monitorId, callback)` to get notified of stream
 *     state changes; they never own the PeerConnection themselves.
 *   - The registry refcounts subscribers per monitorId. The connection
 *     stays open while refCount > 0.
 *   - When refCount drops to 0, a 30s grace timer starts. If anyone
 *     subscribes again before it fires, the existing connection is reused.
 *     Otherwise it closes cleanly.
 *
 * Effect: clicking around the app reuses the connection. MediaMTX never
 * notices the operator changed tabs. Pages feel instant.
 *
 * The grace window (GRACE_MS) is the only knob — too short and we lose
 * the benefit, too long and we hold MediaMTX paths longer than needed.
 * 30 s comfortably covers operator paging behaviour without monopolising
 * a path nobody is watching.
 */
import { WHEP_BASE } from '@/core/config/endpoints';
import { getIceServers } from '@/core/services/turnCredentials';
import api from '@/core/services/api';

const GRACE_MS = 30_000;
const RETRY_AFTER_FAIL_MS = 4_000;
// A transcoded (_h264) path 404s until ffmpeg publishes into it, which takes
// 5-30 s after /stream/start. That is warm-up, not failure: stay 'connecting'
// and poll the same URL briefly instead of flipping the tile offline.
const WARMUP_RETRY_MS = 1_500;
const WARMUP_MAX_TRIES = 30;
// Used to decide whether a late subscriber should upgrade a shared connection.
// Anything unrecognised ranks as 'auto' — the backend's own default for an
// unknown ?quality — so a typo can never silently downgrade a live view.
const QUALITY_RANK = { low: 0, auto: 1, high: 2 };
const rankOf = (q) => (q in QUALITY_RANK ? QUALITY_RANK[q] : QUALITY_RANK.auto);
const ICE_GATHER_TIMEOUT_MS = 1_500;

// Background-tab suspension.
//
// refCount only drops when a component UNMOUNTS. Backgrounding a tab keeps
// every component mounted, so without this a hidden wall of 36 tiles holds 36
// WebRTC sessions — and 36 RTSP pulls off the NVR — open indefinitely for
// nobody. Entry-level NVRs only serve a handful of concurrent sessions, so
// unwatched tabs were competing with operators who are actually looking.
//
// We wait before suspending so alt-tabbing for a few seconds doesn't cause
// reconnect churn, and we STAGGER the resume: bringing 36 tiles back
// simultaneously is precisely the connection storm the per-NVR limits exist to
// prevent.
const HIDDEN_SUSPEND_MS = 20_000;
const RESUME_STAGGER_MS = 200;

let hiddenTimer = null;
let suspended = false;

// monitorId → resolved WHEP endpoint.
//
// The MediaMTX path is NOT always `cam_<monitorId>`. H265 cameras are
// republished on a transcoded `cam_<monitorId>_h264` path, and only the
// backend knows which cameras those are — it tells us in `webrtcUrl` from
// /stream/start. This module used to rebuild the URL from the monitorId
// alone, so for those cameras every WHEP POST came back 400 and each player
// quietly fell through to its HLS fallback. Symptoms were "grid tiles stuck
// on Connecting" and a tainted canvas that made snapshots impossible.
//
// We take only the PATH from the backend and keep the configured WHEP_BASE,
// so deployments where the browser reaches MediaMTX on a different host than
// the backend advertises keep working.
// Keyed by monitorId + quality: the backend answers with a DIFFERENT path per
// quality (main `_h264` vs the sub channel's `_sub_h264`), so one cache slot per
// camera would hand a tile the URL the single view resolved, or vice versa.
const whepUrls = new Map();

async function resolveWhepUrl(monitorId, quality = 'auto') {
  const cacheKey = `${monitorId}|${quality}`;
  const cached = whepUrls.get(cacheKey);
  if (cached) return cached;

  let path = `/cam_${encodeURIComponent(monitorId)}`;
  try {
    // `quality` matters enormously and used to be omitted entirely, so every
    // caller — a 200px grid thumbnail included — got the backend's 'auto'
    // default. 'auto' warms the camera's MAIN channel and BLOCKS on the
    // transcode; 'low' takes the sub channel non-blocking. Measured on one real
    // camera: auto = 10,334 ms, low = 12 ms. Eight tiles of that, against the
    // browser's ~6-connections-per-origin limit, is what stalled the grids.
    const { data } = await api.get(
      `/stream/start/${encodeURIComponent(monitorId)}`,
      { params: { quality } },
    );
    if (data?.webrtcUrl) {
      // Accept absolute or path-only, and drop any trailing slash.
      path = new URL(data.webrtcUrl, WHEP_BASE).pathname.replace(/\/$/, '') || path;
    }
  } catch {
    // Fall back to the conventional path; a 400 here just triggers the
    // player's existing HLS fallback, exactly as before this fix.
  }

  const url = `${WHEP_BASE}${path}/whep`;
  whepUrls.set(cacheKey, url);
  return url;
}

/**
 * Drop a cached WHEP endpoint so the next negotiation re-asks /stream/start.
 *
 * This is what makes the retry loop able to actually recover. For a grid tile
 * the backend requests the transcode NON-blocking and answers immediately, so
 * the `_sub_h264` path can legitimately not exist yet (or the transcode may not
 * have started at all, if the sub source was still cold). Retrying against the
 * cached URL could then 404 forever, because only a fresh /stream/start asks the
 * backend to spawn the transcoder again.
 */
function invalidateWhepUrl(monitorId, quality = 'auto') {
  whepUrls.delete(`${monitorId}|${quality}`);
}

// monitorId → Entry. Lives at module scope so it survives every component
// mount/unmount in the SPA — only a full page reload clears it.
const registry = new Map();

function makeEntry(monitorId, quality = 'auto') {
  return {
    monitorId,
    // Quality this connection was negotiated at. One PC is shared per camera
    // (sharing it is the point — a second PC is a second NVR session), so the
    // entry remembers what it asked for and only ever upgrades. See subscribe().
    quality,
    pc: null,
    mediaStream: null,
    // 'connecting' | 'streaming' | 'offline'
    state: 'connecting',
    error: null,
    // Consecutive negotiation failures since the last successful connect.
    // Exposed in the snapshot so a player can tell a transient miss (the
    // backend answers grid tiles BEFORE the transcoder has published, so the
    // first WHEP POST to a cold camera 404s by design) from a dead path.
    failures: 0,
    refCount: 0,
    subscribers: new Set(),
    closeTimer: null,
    // Bumped on every (re)negotiation. Pending async work checks this
    // to avoid mutating an entry that's been superseded.
    epoch: 0,
    // True while a negotiate() is mid-flight. Prevents two concurrent
    // negotiations on the same entry.
    negotiating: false,
  };
}

function snapshot(entry) {
  return {
    state: entry.state,
    mediaStream: entry.mediaStream,
    error: entry.error,
    failures: entry.failures,
    monitorId: entry.monitorId,
  };
}

function notify(entry) {
  const snap = snapshot(entry);
  for (const cb of entry.subscribers) {
    try { cb(snap); } catch (e) { console.warn('[streamRegistry] subscriber threw', e); }
  }
}

function closeConnection(entry) {
  if (entry.pc) {
    try { entry.pc.getSenders?.().forEach((s) => s.track?.stop()); } catch (_) {}
    try { entry.pc.close(); } catch (_) {}
  }
  entry.pc = null;
  entry.mediaStream = null;
}

function destroyEntry(monitorId) {
  const entry = registry.get(monitorId);
  if (!entry) return;
  if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
  closeConnection(entry);
  registry.delete(monitorId);
}

/**
 * Close every live connection but KEEP the entries — subscribers are still
 * mounted and will be re-served on resume. Bumping epoch invalidates any
 * negotiation already in flight so it can't resurrect a connection we just
 * closed.
 */
function suspendAll() {
  hiddenTimer = null;
  if (suspended) return;
  suspended = true;
  let closed = 0;
  for (const entry of registry.values()) {
    if (!entry.pc) continue;
    entry.epoch++;
    closeConnection(entry);
    entry.state = 'connecting';   // players show their reconnecting affordance
    notify(entry);
    closed++;
  }
  if (closed) console.info(`[streamRegistry] tab hidden — suspended ${closed} stream(s)`);
}

/** Re-negotiate everything that still has subscribers, spread over time. */
function resumeAll() {
  if (!suspended) return;
  suspended = false;
  let i = 0;
  for (const entry of registry.values()) {
    if (entry.refCount <= 0 || entry.pc) continue;
    const delay = (i++) * RESUME_STAGGER_MS;
    setTimeout(() => {
      // Re-check: the tab may have been hidden again, or everyone unsubscribed.
      if (suspended || entry.refCount <= 0 || entry.pc) return;
      negotiate(entry);
    }, delay);
  }
  if (i) console.info(`[streamRegistry] tab visible — resuming ${i} stream(s)`);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!hiddenTimer && !suspended) hiddenTimer = setTimeout(suspendAll, HIDDEN_SUSPEND_MS);
    } else {
      if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
      resumeAll();
    }
  });
}

async function negotiate(entry) {
  if (entry.negotiating) return;
  // Never open a connection for a tab nobody is looking at.
  if (suspended) return;
  entry.negotiating = true;
  entry.state = 'connecting';
  entry.error = null;
  notify(entry);

  // Tear down any previous PC before opening a new one. Reconnect path
  // (called by reconnect() or the iceconnectionstatechange handler).
  closeConnection(entry);

  const epoch = ++entry.epoch;

  try {
    // Phase 1.4: pull TURN creds from backend if coturn is deployed. The
    // service falls back to STUN-only iceServers when the backend says
    // TURN isn't configured, so this call is safe in every environment
    // (dev/LAN/prod) without conditional logic here.
    const { iceServers } = await getIceServers();
    if (epoch !== entry.epoch) return;

    const pc = new RTCPeerConnection({
      iceServers,
      // 'all' = candidate gathering tries host + srflx (STUN) + relay (TURN).
      // 'relay' would force every connection through TURN — useful for
      // testing relay paths but expensive; leave to 'all' so direct
      // connections are still preferred when possible.
      iceTransportPolicy: 'all',
    });
    entry.pc = pc;

    pc.addTransceiver('video', { direction: 'recvonly' });
    // Audio transceiver added so MediaMTX answers with audio when the
    // camera publishes it. Useful diagnostic ("is this path even alive")
    // even if the UI keeps the audio muted.
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.addEventListener('track', (e) => {
      if (epoch !== entry.epoch) return;
      if (e.streams[0]) {
        entry.mediaStream = e.streams[0];
        notify(entry);
      }
    });

    pc.addEventListener('iceconnectionstatechange', () => {
      if (epoch !== entry.epoch) return;
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') {
        entry.failures = 0;
        if (entry.state !== 'streaming') {
          entry.state = 'streaming';
          notify(entry);
        }
      } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        if (entry.state === 'offline') return; // dedupe
        entry.failures += 1;
        entry.state = 'offline';
        notify(entry);
        // Re-resolve too: if the transcoder behind this path has exited, only a
        // fresh /stream/start will start it again (requestTranscode is
        // idempotent, so asking when it is alive costs nothing).
        invalidateWhepUrl(entry.monitorId, entry.quality);
        // Auto-retry only while someone is still watching. If everyone
        // navigated away and ICE failed at the same time, just close.
        if (entry.refCount > 0) {
          setTimeout(() => {
            if (entry.refCount > 0 && entry.epoch === epoch) negotiate(entry);
          }, RETRY_AFTER_FAIL_MS);
        }
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc, ICE_GATHER_TIMEOUT_MS);

    if (epoch !== entry.epoch) return;

    const url = await resolveWhepUrl(entry.monitorId, entry.quality);
    if (epoch !== entry.epoch) return;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (resp.status === 404 && (entry.warmTries || 0) < WARMUP_MAX_TRIES) {
      entry.warmTries = (entry.warmTries || 0) + 1;
      try { pc.close(); } catch { /* already closed */ }
      if (entry.refCount > 0) {
        setTimeout(() => {
          if (entry.refCount > 0 && entry.epoch === epoch) negotiate(entry);
        }, WARMUP_RETRY_MS);
      }
      return;
    }
    if (!resp.ok) throw new Error(`WHEP ${resp.status}`);
    entry.warmTries = 0;
    const answerSdp = await resp.text();
    if (epoch !== entry.epoch) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    // 'streaming' will get set when ICE connects (the listener above).
    // If ICE never connects, callers' stall watchdog catches it.
  } catch (err) {
    if (epoch !== entry.epoch) return;
    entry.warmTries = 0;
    entry.failures += 1;
    entry.error = err;
    entry.state = 'offline';
    notify(entry);
    // The path we were told to use did not work (a 404 here means it does not
    // exist yet). Re-resolve on the retry so the backend gets another chance to
    // start the transcoder, instead of us hammering a URL that never appears.
    invalidateWhepUrl(entry.monitorId, entry.quality);
    if (entry.refCount > 0) {
      setTimeout(() => {
        if (entry.refCount > 0 && entry.epoch === epoch) negotiate(entry);
      }, RETRY_AFTER_FAIL_MS);
    }
  } finally {
    entry.negotiating = false;
  }
}

/**
 * Subscribe to a monitor's stream. The callback is invoked immediately
 * with the current snapshot, then again on every state change.
 *
 * Returns an unsubscribe function. ALWAYS call it on component unmount;
 * forgetting leaks a refcount and the stream stays open forever.
 */
export function subscribe(monitorId, callback, { quality = 'auto' } = {}) {
  if (!monitorId || typeof callback !== 'function') return () => {};

  let entry = registry.get(monitorId);
  if (!entry) {
    entry = makeEntry(monitorId, quality);
    registry.set(monitorId, entry);
    negotiate(entry);
  } else if (rankOf(quality) > rankOf(entry.quality)) {
    // A richer surface joined a camera the grid already had open (expanding a
    // wall tile over the grid behind it, say). Upgrade in place rather than
    // opening a second PC — that would be a second NVR session for one camera.
    // Only ever upwards: a thumbnail must never drag the expanded view down.
    entry.quality = quality;
    negotiate(entry);
  }

  entry.refCount++;
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
  }
  entry.subscribers.add(callback);
  // Initial snapshot — caller doesn't have to wait for the first
  // state change to render something.
  try { callback(snapshot(entry)); } catch (e) { console.warn(e); }

  return function unsubscribe() {
    entry.subscribers.delete(callback);
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount === 0) {
      // Grace timer — if nobody re-subscribes within GRACE_MS, close.
      // Cancels itself if refCount > 0 by the time it fires (race-safe).
      entry.closeTimer = setTimeout(() => {
        if (entry.refCount === 0) destroyEntry(monitorId);
      }, GRACE_MS);
    }
  };
}

/**
 * Set `playoutDelayHint` on every receiver of the shared PC for this
 * monitor. Larger = smoother but more behind live. The adaptive playback
 * hook calls this when the network class or observed stall pressure
 * change. Chromium-only — silently no-ops in browsers without support.
 *
 * Note that since the PC is shared across subscribers, the last call
 * wins. That's intentional: the most recently active adapter usually has
 * the freshest network info. Fighting between profiles across pages
 * isn't a real problem at our scale.
 */
export function setPlayoutDelayHint(monitorId, seconds) {
  const entry = registry.get(monitorId);
  if (!entry?.pc) return;
  try {
    entry.pc.getReceivers().forEach((r) => {
      if ('playoutDelayHint' in r) r.playoutDelayHint = seconds;
    });
  } catch (_) { /* not supported, fine */ }
}

/**
 * Force a fresh WHEP negotiation for this monitor — used by player
 * components that detect a stall via the video element's currentTime
 * not advancing. The mediaStream object stays the same React reference
 * during negotiation; only its underlying tracks swap when the new
 * connection emits 'track'.
 *
 * No-op if no one is currently subscribed to the monitor.
 */
export function reconnect(monitorId) {
  const entry = registry.get(monitorId);
  if (!entry) return;
  if (entry.negotiating) return;
  negotiate(entry);
}

/**
 * Pre-warm a list of monitorIds (used to prime the demo cameras before
 * the operator clicks them). Subscribes briefly to start negotiation,
 * unsubscribes immediately — the grace window keeps the connection
 * alive for 30 s so the actual operator subscription that follows
 * reuses the warm connection.
 */
export function preWarm(monitorIds) {
  for (const id of monitorIds) {
    const off = subscribe(id, () => {});
    // Immediately unsubscribe — refCount goes back to 0 + 30s grace begins.
    off();
  }
}

/** Diagnostics — used by the DevTools panel or a debug overlay. */
export function inspect() {
  return Array.from(registry.entries()).map(([monitorId, entry]) => ({
    monitorId,
    state: entry.state,
    refCount: entry.refCount,
    hasMediaStream: Boolean(entry.mediaStream),
    closingIn: entry.closeTimer ? GRACE_MS : null,
    epoch: entry.epoch,
  }));
}

// ── helpers ──────────────────────────────────────────────────────────────

function waitIceGatheringComplete(pc, timeoutMs) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, timeoutMs);
    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
  });
}
