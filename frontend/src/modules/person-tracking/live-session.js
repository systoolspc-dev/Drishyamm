/**
 * Live-tracking session store — pure functions, no React.
 *
 * Live mode re-searches a rolling window every few seconds. Showing only the
 * latest window made a sighting vanish the moment it aged out of it, which is
 * exactly when an operator needs it ("where did they go after the gate?").
 * So every poll MERGES its candidates into a per-session store keyed by
 * appearance_id, and the page clusters the whole store. A record, once seen,
 * stays for the session.
 *
 * The store is a Map<appearance_id, candidate>. Every function returns a new
 * Map and never mutates its input.
 */

// Cap on the session store. Past this the oldest records are thinned out.
export const MAX_LIVE_CANDIDATES = 5000;

// Mirrors the journey service's default cluster window (journey/cluster.py,
// _DEFAULT_CLUSTER_WINDOW_SEC). Thinning uses it to find stops the same way
// the server will, so a thinned store clusters into the same stops.
export const CLUSTER_WINDOW_SEC = 30;

export function createStore() {
  return new Map();
}

/**
 * Merge a poll's candidates into the store. Idempotent, never shrinks, dedupes
 * by appearance_id. A record seen again replaces the stored copy (same
 * appearance, possibly fresher fields such as camera_name).
 */
export function mergeCandidates(store, incoming) {
  const next = new Map(store);
  for (const c of incoming || []) {
    if (c?.appearance_id == null) continue;
    next.set(String(c.appearance_id), c);
  }
  return next;
}

const timeOf = (c) => Date.parse(c.occurred_at) || 0;

// Same link rule as journey/cluster.py: consecutive records on one camera are
// one stop when they share a track_id or sit within the cluster window.
function linked(prev, c, windowMs) {
  const sameTrack = prev.track_id != null && c.track_id != null && prev.track_id === c.track_id;
  return sameTrack || timeOf(c) - timeOf(prev) <= windowMs;
}

/** Group candidates into stops: arrays of records, each in time order. */
export function groupStops(candidates, windowSec = CLUSTER_WINDOW_SEC) {
  const windowMs = windowSec * 1000;
  const byCamera = new Map();
  for (const c of candidates) {
    const key = String(c.camera_id);
    if (!byCamera.has(key)) byCamera.set(key, []);
    byCamera.get(key).push(c);
  }
  const stops = [];
  for (const items of byCamera.values()) {
    items.sort((a, b) => timeOf(a) - timeOf(b));
    let stop = [];
    for (const c of items) {
      if (stop.length && linked(stop[stop.length - 1], c, windowMs)) stop.push(c);
      else {
        if (stop.length) stops.push(stop);
        stop = [c];
      }
    }
    if (stop.length) stops.push(stop);
  }
  return stops;
}

/**
 * Bring the store down to `max` records by dropping the oldest ones that are
 * not the first, last or best of their stop.
 *
 * A record is also kept when dropping it would leave a gap its neighbours
 * cannot bridge — otherwise one long visit would split into several stops
 * after thinning. So thinning changes a stop's hit count, never its start,
 * end, best match or the number of stops. When every remaining record is
 * protected the store is left above `max` rather than lose a stop.
 */
export function capStore(store, max = MAX_LIVE_CANDIDATES, windowSec = CLUSTER_WINDOW_SEC) {
  if (store.size <= max) return store;
  const windowMs = windowSec * 1000;

  // Doubly linked list per stop so each drop re-checks the new neighbours.
  const nodes = [];
  for (const stop of groupStops([...store.values()], windowSec)) {
    let best = stop[0];
    for (const c of stop) if ((c.similarity || 0) > (best.similarity || 0)) best = c;
    const list = stop.map((c) => ({ c, prev: null, next: null }));
    list.forEach((n, i) => {
      n.prev = list[i - 1] || null;
      n.next = list[i + 1] || null;
      if (i > 0 && i < list.length - 1 && n.c !== best) nodes.push(n);
    });
  }
  nodes.sort((a, b) => timeOf(a.c) - timeOf(b.c));

  const next = new Map(store);
  for (const n of nodes) {
    if (next.size <= max) break;
    const { prev, next: after } = n;
    if (!linked(prev.c, after.c, windowMs)) continue;
    next.delete(String(n.c.appearance_id));
    prev.next = after;
    after.prev = prev;
  }
  return next;
}

/** Merge + cap in one step — what each live poll does. */
export function accumulate(store, incoming, max = MAX_LIVE_CANDIDATES) {
  return capStore(mergeCandidates(store, incoming), max);
}

/**
 * Seconds since a stop's newest record, or null while it is still inside the
 * live window (i.e. not stale).
 */
export function staleAgeSec(newestIso, nowMs, windowMs) {
  const t = Date.parse(newestIso);
  if (!Number.isFinite(t)) return null;
  const age = nowMs - t;
  return age > windowMs ? Math.round(age / 1000) : null;
}

/** "45s", "12 min", "2h 5m" — for "last seen X ago". */
export function formatAgo(sec) {
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}
