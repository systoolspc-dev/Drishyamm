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
// a few seconds after /stream/start. That is warm-up, not failure: stay
// 'connecting' and re-POST the SAME offer — no new peer connection, no new ICE
// gathering (up to ICE_GATHER_TIMEOUT_MS each time). Poll fast at first, since
// the path usually appears within seconds, then back off. A 404 from the Stream
// Service is a cheap local answer: it never reaches the camera or NVR.
const WARMUP_FIRST_MS = 250;
const WARMUP_MAX_DELAY_MS = 1_500;
const WARMUP_BUDGET_MS = 45_000;
// Used to decide whether a late subscriber should upgrade a shared connection.
// Anything unrecognised ranks as 'auto' — the backend's own default for an
// unknown ?quality — so a typo can never silently downgrade a live view.
const QUALITY_RANK = { low: 0, auto: 1, high: 2 };
const rankOf = (q) => (q in QUALITY_RANK ? QUALITY_RANK[q] : QUALITY_RANK.auto);
// How long to wait for ICE candidates before sending the offer. The Stream
// Service has its own public/host candidates and learns ours from the
// connectivity checks (peer-reflexive), so a direct path needs nothing beyond
// the host candidates Chrome gathers in a few ms. Waiting for full gathering
// (Google STUN round trips) cost up to 1.5 s on EVERY start — warm, cold and
// reload alike. Only a TURN relay is worth waiting for, and only briefly.
const ICE_GATHER_TIMEOUT_MS = 200;
const ICE_GATHER_TIMEOUT_TURN_MS = 800;

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
    // subscriber callback → the quality it asked for; the entry steps down
    // when the richest remaining ask is lower (see retarget()).
    wants: new Map(),
    downgradeTimer: null,
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

// Wait this long before stepping a camera down from main, so leaving and
// re-entering fullscreen doesn't bounce between streams.
const DOWNGRADE_DELAY_MS = 8_000;

/**
 * Upgrades happen in subscribe(); this handles the other direction. When the
 * richest quality any current subscriber wants is below what the entry runs
 * at, step down after DOWNGRADE_DELAY_MS. With no subscribers the grace close
 * takes care of it.
 */
function retarget(entry) {
  if (entry.wants.size === 0) return;
  let want = 'low';
  for (const q of entry.wants.values()) if (rankOf(q) > rankOf(want)) want = q;
  if (rankOf(want) >= rankOf(entry.quality)) {
    if (entry.downgradeTimer) { clearTimeout(entry.downgradeTimer); entry.downgradeTimer = null; }
    return;
  }
  if (entry.downgradeTimer) return;
  entry.downgradeTimer = setTimeout(() => {
    entry.downgradeTimer = null;
    if (registry.get(entry.monitorId) !== entry || entry.wants.size === 0) return;
    let now = 'low';
    for (const q of entry.wants.values()) if (rankOf(q) > rankOf(now)) now = q;
    if (rankOf(now) >= rankOf(entry.quality)) return;
    entry.quality = now;
    if (entry.onMain) downgradeFromMain(entry);
  }, DOWNGRADE_DELAY_MS);
}

function destroyEntry(monitorId) {
  const entry = registry.get(monitorId);
  if (!entry) return;
  if (entry.closeTimer) { clearTimeout(entry.closeTimer); entry.closeTimer = null; }
  if (entry.downgradeTimer) { clearTimeout(entry.downgradeTimer); entry.downgradeTimer = null; }
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

  // Fullscreen ('high') starts on the grid stream — kept warm while the user is
  // logged in, so it plays in well under a second — and upgradeToMain() swaps
  // in the 1080p main stream once that is publishing. Waiting for main first
  // meant 5–12 s of spinner, or a blur after all if the NVR stalled main.
  entry.onMain = false;
  const startQuality = entry.quality === 'high' ? 'low' : entry.quality;
  // Ask the backend which path to play NOW, in parallel with building the
  // offer: /stream/start and ICE gathering used to run one after the other.
  const urlPromise = resolveWhepUrl(entry.monitorId, startQuality);
  urlPromise.catch(() => {});

  try {
    // Phase 1.4: pull TURN creds from backend if coturn is deployed. The
    // service falls back to STUN-only iceServers when the backend says
    // TURN isn't configured, so this call is safe in every environment
    // (dev/LAN/prod) without conditional logic here. Cached after the first call.
    const { iceServers, available: turnAvailable } = await getIceServers();
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

    watchIce(entry, pc, epoch);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc, turnAvailable ? ICE_GATHER_TIMEOUT_TURN_MS : ICE_GATHER_TIMEOUT_MS);

    if (epoch !== entry.epoch) return;

    const url = await urlPromise;
    if (epoch !== entry.epoch) return;
    const post = () => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    let resp = await post();
    const warmUntil = Date.now() + WARMUP_BUDGET_MS;
    let delay = WARMUP_FIRST_MS;
    while (resp.status === 404 && Date.now() < warmUntil) {
      entry.warmTries = (entry.warmTries || 0) + 1;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(WARMUP_MAX_DELAY_MS, Math.round(delay * 1.5));
      if (epoch !== entry.epoch || entry.refCount <= 0) {
        try { pc.close(); } catch { /* already closed */ }
        return;
      }
      resp = await post();
    }
    // Still 404 after the budget: fall through to the failure path, which
    // re-resolves via /stream/start so the backend can restart the transcoder.
    if (!resp.ok) throw new Error(`WHEP ${resp.status}`);
    entry.warmTries = 0;
    const answerSdp = await resp.text();
    if (epoch !== entry.epoch) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    // 'streaming' will get set when ICE connects (watchIce).
    // If ICE never connects, callers' stall watchdog catches it.
    if (entry.quality === 'high') upgradeToMain(entry);
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
    invalidateWhepUrl(entry.monitorId, startQuality);
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
    // Keep showing what is already playing; fetch main alongside it.
    if (quality === 'high' && entry.pc && !entry.negotiating) upgradeToMain(entry);
    else negotiate(entry);
  }

  entry.refCount++;
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
  }
  entry.subscribers.add(callback);
  entry.wants.set(callback, quality);
  retarget(entry);
  // Initial snapshot — caller doesn't have to wait for the first
  // state change to render something.
  try { callback(snapshot(entry)); } catch (e) { console.warn(e); }

  return function unsubscribe() {
    entry.subscribers.delete(callback);
    entry.wants.delete(callback);
    entry.refCount = Math.max(0, entry.refCount - 1);
    retarget(entry);
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


/** Connection-state handling for the entry's current peer connection. */
function watchIce(entry, pc, epoch) {
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
      invalidateWhepUrl(entry.monitorId, entry.onMain ? 'high' : (entry.quality === 'high' ? 'low' : entry.quality));
      entry.onMain = false;
      // Auto-retry only while someone is still watching. If everyone
      // navigated away and ICE failed at the same time, just close.
      if (entry.refCount > 0) {
        setTimeout(() => {
          if (entry.refCount > 0 && entry.epoch === epoch) negotiate(entry);
        }, RETRY_AFTER_FAIL_MS);
      }
    }
  });
}

const MAIN_RETRY_MS = 20_000;
const MAIN_FIRST_FRAME_TIMEOUT_MS = 10_000;

const MAIN_STALL_MS = 4_000;
const MAIN_BACKOFF_MS = 60_000;

/**
 * Main streams from a remote NVR can start and then stall while ICE stays
 * "connected" (seen 2026-10-19: 64 KB, then nothing). Watch decoded frames;
 * if they stop for MAIN_STALL_MS, go back to the grid stream (renegotiate,
 * which starts on the warm sub) and leave main alone for MAIN_BACKOFF_MS.
 */
function watchMainFrames(entry, epoch) {
  let last = -1;
  let lastChange = Date.now();
  const iv = setInterval(async () => {
    if (entry.epoch !== epoch || !entry.pc || !entry.onMain) { clearInterval(iv); return; }
    let decoded = 0;
    try {
      (await entry.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') decoded = r.framesDecoded || 0;
      });
    } catch { return; }
    if (decoded !== last) { last = decoded; lastChange = Date.now(); return; }
    if (Date.now() - lastChange < MAIN_STALL_MS) return;
    clearInterval(iv);
    entry.mainBackoffUntil = Date.now() + MAIN_BACKOFF_MS;
    invalidateWhepUrl(entry.monitorId, 'high');
    if (entry.refCount > 0) negotiate(entry);
  }, 1_000);
}

const isMainPath = (path) => !/_(sub|low)(_h264)?$/.test(path);

/**
 * Swap a fullscreen entry from the grid stream to the main stream without a
 * black frame: open a second connection to main, decode it off-screen until
 * its first frame, then hand subscribers the new MediaStream and close the
 * old connection. If the backend can't serve main yet (NVR slow / stalled /
 * at its session limit) it answers with the sub path; we keep the sub
 * playing and try again in MAIN_RETRY_MS while someone still wants 'high'.
 */
async function upgradeToMain(entry) {
  if (entry.upgrading || entry.onMain || suspended) return;
  if ((entry.mainBackoffUntil || 0) > Date.now()) {
    setTimeout(() => {
      if (entry.refCount > 0 && entry.quality === 'high' && registry.get(entry.monitorId) === entry) upgradeToMain(entry);
    }, entry.mainBackoffUntil - Date.now());
    return;
  }
  entry.upgrading = true;
  const startEpoch = entry.epoch;
  const stillWanted = () => entry.epoch === startEpoch && entry.refCount > 0 && entry.quality === 'high' && registry.get(entry.monitorId) === entry;
  try {
    const { data } = await api.get(`/stream/start/${encodeURIComponent(entry.monitorId)}`, { params: { quality: 'high' } });
    const path = data?.webrtcUrl ? new URL(data.webrtcUrl, WHEP_BASE).pathname.replace(/\/$/, '') : '';
    if (!stillWanted()) return;
    if (!path || !isMainPath(path)) {
      setTimeout(() => { if (stillWanted()) upgradeToMain(entry); }, MAIN_RETRY_MS);
      return;
    }
    const url = `${WHEP_BASE}${path}/whep`;
    const epoch = await swapConnection(entry, url, stillWanted, { onMain: true });
    whepUrls.set(`${entry.monitorId}|high`, url);
    watchMainFrames(entry, epoch);
  } catch {
    if (stillWanted()) setTimeout(() => { if (stillWanted()) upgradeToMain(entry); }, MAIN_RETRY_MS);
  } finally {
    entry.upgrading = false;
  }
}

/**
 * Back from main to the grid stream once nobody needs main any more (a tile
 * left fullscreen). Main costs the customer's uplink several sub-streams'
 * worth, and the NVR serves only so much (docs/14), so it is not kept for a
 * thumbnail. Same black-frame-free swap as the upgrade.
 */
async function downgradeFromMain(entry) {
  if (!entry.onMain || entry.upgrading || suspended) return;
  entry.upgrading = true;
  const startEpoch = entry.epoch;
  const stillWanted = () => entry.epoch === startEpoch && entry.refCount > 0 && entry.quality !== 'high' && registry.get(entry.monitorId) === entry;
  try {
    const url = await resolveWhepUrl(entry.monitorId, entry.quality);
    if (!stillWanted()) return;
    await swapConnection(entry, url, stillWanted, { onMain: false });
  } catch {
    // Keep main playing; the next quality change tries again.
  } finally {
    entry.upgrading = false;
  }
}

/**
 * Open a second connection to `url`, decode it off-screen until its first
 * frame (so the visible player never shows black while a decoder waits for a
 * keyframe), then hand subscribers the new MediaStream and close the old
 * connection. Throws if it can't; the caller's current stream keeps playing.
 * Returns the entry's new epoch.
 */
async function swapConnection(entry, url, stillWanted, { onMain }) {
  let pc = null;
  let probe = null;
  try {
    const { iceServers, available: turnAvailable } = await getIceServers();
    pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const streamP = new Promise((res) => pc.addEventListener('track', (e) => e.streams[0] && res(e.streams[0])));
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGatheringComplete(pc, turnAvailable ? ICE_GATHER_TIMEOUT_TURN_MS : ICE_GATHER_TIMEOUT_MS);
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
    if (!resp.ok) throw new Error(`WHEP ${resp.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });
    const stream = await streamP;
    probe = document.createElement('video');
    probe.muted = true;
    probe.playsInline = true;
    probe.srcObject = stream;
    probe.play?.().catch(() => {});
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('swap: no frame')), MAIN_FIRST_FRAME_TIMEOUT_MS);
      const done = () => { clearTimeout(t); res(); };
      if (probe.requestVideoFrameCallback) probe.requestVideoFrameCallback(done);
      else probe.addEventListener('loadeddata', done, { once: true });
    });
    if (!stillWanted()) throw new Error('no longer wanted');
    const old = entry.pc;
    const epoch = ++entry.epoch;
    entry.pc = pc;
    entry.mediaStream = stream;
    entry.onMain = onMain;
    entry.state = 'streaming';
    entry.failures = 0;
    pc = null; // owned by the entry now
    watchIce(entry, entry.pc, epoch);
    notify(entry);
    setTimeout(() => { try { old?.close(); } catch { /* closed */ } }, 1_000);
    return epoch;
  } finally {
    if (pc) { try { pc.close(); } catch { /* closed */ } }
    if (probe) setTimeout(() => { probe.srcObject = null; }, 2_000);
  }
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
