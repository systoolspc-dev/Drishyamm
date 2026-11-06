/**
 * occupancyHysteresis — count-threshold anti-flap for occupancy / capacity
 * alerts (framework §4 M1 + M2, see docs/DETECTION_DECISION_ALERT_FRAMEWORK.md).
 *
 * A raw "count >= N" test flaps: a room hovering at 48↔51 around a cap of 50
 * fires an alert on every up-crossing. This tracker fixes that with two
 * mechanisms:
 *
 *   M1 confirm  — the count must be >= threshold for `confirmPolls` CONSECUTIVE
 *                 samples before it counts as a breach (rejects a 1-frame spike).
 *   M2 deadband — once breached it stays breached until the count drops to
 *                 threshold − `clearMargin` (so 48↔51 never clears at a cap of 50).
 *
 * Pure + synchronous — a Map of tiny state objects, no I/O. Feed it one sample
 * per key per poll via update(); it returns the transition edge or null.
 */
function createOccupancyTracker(opts = {}) {
  const defConfirm = Math.max(1, parseInt(opts.confirmPolls, 10) || 3);
  const defMargin  = Math.max(0, opts.clearMargin == null ? 5 : (parseInt(opts.clearMargin, 10) || 0));
  const state = new Map(); // key -> { breached:boolean, hi:number }

  return {
    /**
     * Feed one occupancy sample for `key`.
     * @param {string} key        stable per-area key (e.g. zone id)
     * @param {number} count      people currently in the area
     * @param {number} threshold  capacity N (<=0 disables tracking for this key)
     * @param {object} [o]        per-call overrides: { confirmPolls, clearMargin }
     * @returns {'breach'|'clear'|null}  the transition edge to act on, else null
     */
    update(key, count, threshold, o = {}) {
      const n = Number(threshold);
      if (!(n > 0)) { state.delete(key); return null; } // capacity disabled
      const confirmPolls = Math.max(1, parseInt(o.confirmPolls, 10) || defConfirm);
      const clearMargin  = Math.max(0, o.clearMargin == null ? defMargin : (parseInt(o.clearMargin, 10) || 0));
      const clearLevel   = Math.max(0, n - clearMargin);
      const c = Number(count) || 0;

      let st = state.get(key);
      if (!st) { st = { breached: false, hi: 0 }; state.set(key, st); }

      if (!st.breached) {
        if (c >= n) {
          st.hi += 1;
          if (st.hi >= confirmPolls) { st.breached = true; st.hi = 0; return 'breach'; }
        } else {
          st.hi = 0; // any dip breaks the consecutive streak (M1)
        }
        return null;
      }
      // Already breached — only clear once we fall through the deadband (M2).
      if (c <= clearLevel) { st.breached = false; st.hi = 0; return 'clear'; }
      return null;
    },

    isBreached(key) { const st = state.get(key); return !!(st && st.breached); },
    reset(key) { state.delete(key); },
    _state: state,
  };
}

module.exports = { createOccupancyTracker };
