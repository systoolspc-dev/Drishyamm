/**
 * cameraStatusCoalescer — turns the stream supervisor's per-camera transitions
 * into a few decided "these cameras went offline / came back" batches.
 *
 * Doctrine (docs/DETECTION_DECISION_ALERT_FRAMEWORK.md): observe every signal,
 * DECIDE per camera, ANNOUNCE per state transition, coalesce per account.
 *
 *   - Each camera has an ANNOUNCED state (what the admin feed last said) and a
 *     CURRENT state (what the supervisor last reported).
 *   - A transition only marks the camera dirty and opens a window for its
 *     account (windowMs, default 60 s). Nothing is emitted per transition.
 *   - When the window closes, every dirty camera whose current state differs
 *     from its announced state is announced — once — in ONE batch for the
 *     account. A camera that dropped and came back inside the window is never
 *     mentioned. 20 flaps in 10 s → at most one batch.
 *   - A camera announced less than cooldownMs ago is held back (re-checked
 *     when its cooldown ends), so a camera flapping every 61 s still cannot
 *     produce an event a minute.
 *   - The first transition seen for a camera (supervisor 'pending' start, or a
 *     process restart) only learns its state; bootGraceMs after start() every
 *     observation is learned silently, so a backend restart is not "16 cameras
 *     came back online".
 *
 * Pure: time and timers are injected so the unit test drives it directly.
 */

const ONLINE_STATES = new Set(['streaming', 'degraded', 'standby']);
// 'pending' is the supervisor's initial state — not a real previous state.
const INITIAL_STATES = new Set(['pending', null, undefined, '']);

function isOnlineState(state) {
  return ONLINE_STATES.has(state);
}

function createCameraStatusCoalescer({
  onBatch,
  windowMs = 60_000,
  cooldownMs = 5 * 60_000,
  bootGraceMs = 90_000,
  now = () => Date.now(),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  const cams = new Map();     // cameraKey -> { accountId, announced, current, lastAnnouncedAt, info }
  const pending = new Map();  // accountId -> { keys: Set, timer }
  const startedAt = now();

  function schedule(accountId, ms) {
    let p = pending.get(accountId);
    if (!p) { p = { keys: new Set(), timer: null }; pending.set(accountId, p); }
    if (!p.timer) p.timer = setTimer(() => flush(accountId), ms);
    return p;
  }

  /**
   * One supervisor transition.
   * @param {object} t  { key, accountId, fromState, toState, info? }
   *   key: stable camera id (monitorId); info: anything the batch consumer needs
   *   (cameraId, groupId, name…), latest wins.
   */
  function observe(t) {
    if (!t || !t.key || !t.accountId) return;
    const toOnline = isOnlineState(t.toState);
    let cam = cams.get(t.key);
    const inGrace = now() - startedAt < bootGraceMs;

    if (!cam) {
      // Learn the state. A real previous state is what the camera WAS; the
      // first transition out of 'pending' carries no history at all.
      const announced = INITIAL_STATES.has(t.fromState) || inGrace ? toOnline : isOnlineState(t.fromState);
      cam = { accountId: t.accountId, announced, current: toOnline, lastAnnouncedAt: 0, info: t.info || {} };
      cams.set(t.key, cam);
      if (announced === toOnline) return;
    } else {
      cam.current = toOnline;
      cam.accountId = t.accountId;
      if (t.info) cam.info = { ...cam.info, ...t.info };
      if (inGrace) { cam.announced = toOnline; return; }
    }
    cam.current = toOnline;
    const p = schedule(t.accountId, windowMs);
    p.keys.add(t.key);
  }

  function flush(accountId) {
    const p = pending.get(accountId);
    if (!p) return null;
    p.timer = null;
    const t = now();
    const offline = [];
    const recovered = [];
    const held = new Set();
    let nextDue = Infinity;

    for (const key of p.keys) {
      const cam = cams.get(key);
      if (!cam || cam.current === cam.announced) continue;      // net no change
      const due = cam.lastAnnouncedAt + cooldownMs;
      if (cam.lastAnnouncedAt && t < due) {                       // announced recently
        held.add(key);
        nextDue = Math.min(nextDue, due);
        continue;
      }
      cam.announced = cam.current;
      cam.lastAnnouncedAt = t;
      (cam.current ? recovered : offline).push({ key, ...cam.info });
    }

    if (held.size) {
      p.keys = held;
      p.timer = setTimer(() => flush(accountId), Math.max(1000, nextDue - t));
    } else {
      pending.delete(accountId);
    }

    if (!offline.length && !recovered.length) return null;
    const batch = { accountId, offline, recovered, at: t };
    try { onBatch && onBatch(batch); } catch (_) { /* consumer must not break the coalescer */ }
    return batch;
  }

  /** Forget a deleted camera so a recycled id starts clean. */
  function forget(key) {
    cams.delete(key);
    for (const p of pending.values()) p.keys.delete(key);
  }

  function stop() {
    for (const p of pending.values()) if (p.timer) clearTimer(p.timer);
    pending.clear();
  }

  function stateOf(key) {
    const c = cams.get(key);
    return c ? { announced: c.announced, current: c.current } : null;
  }

  return { observe, flush, forget, stop, stateOf, _pending: pending };
}

module.exports = { createCameraStatusCoalescer, isOnlineState, ONLINE_STATES };
