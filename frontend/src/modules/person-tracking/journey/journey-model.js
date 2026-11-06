/**
 * Journey model — every derivation the flow canvas needs, and no React.
 *
 * A journey is a CHAIN: every sighting has exactly one successor, ordered by
 * time. There is no branching, no layout to solve, no graph. So the whole
 * problem is a fold over an array, which is why it lives here as pure
 * functions instead of inside a component — the cluster rules below are the
 * part that has to be right, and they are testable as a table of inputs and
 * expected node counts rather than asserted against rendered DOM.
 *
 * The one thing worth reading before the rest: a 400-sighting journey is
 * unreadable as 400 cards, and the fix is to collapse contiguous runs through
 * the same zone. But three kinds of stop must NEVER be swallowed by a cluster,
 * because hiding them is the only failure this design cannot survive:
 *
 *   the first stop   — where the subject entered. The anchor the page is opened for.
 *   the last stop    — where they were last seen. The other anchor.
 *   any alert stop   — a restricted-zone entry behind a "12 sightings" label is
 *                      worse than no clustering at all.
 */

// ── Node kinds ──────────────────────────────────────────────────────────────
export const NODE = {
  START: 'anchor-start',
  END: 'anchor-end',
  CLUSTER: 'cluster',
  SIGHTING: 'sighting',
  ALERT: 'alert',
};

/**
 * How long a hole in the coverage has to be before it is worth drawing.
 *
 * A client-side constant, deliberately not a server field: three minutes
 * between two cameras on a campus is someone walking, and the same three
 * minutes inside a data centre is a question. The operator's site decides,
 * not the journey service.
 */
export const GAP_THRESHOLD_MS = 3 * 60_000;

/** A run has to be at least this long before collapsing earns its chrome. */
export const MIN_CLUSTER_RUN = 2;

/** The Route History panel's "long dwell" filter. */
export const LONG_DWELL_MS = 5 * 60_000;

// ── Small helpers ───────────────────────────────────────────────────────────

const ms = (value) => {
  if (value == null) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * What a stop is grouped by.
 *
 * `zone` is the payload's own field and the right key. When it is missing the
 * fallback is the CAMERA, not a shared "unknown" bucket — lumping unrelated
 * cameras into one card would claim a route through a place that does not
 * exist. Degrading to per-camera grouping just means fewer, smaller clusters.
 */
export const clusterKeyOf = (stop) => stop?.zone || stop?.label || stop?.camera_code || '∅';

/** Stable across refetches: the same sighting keys the same node. */
export const stopKeyOf = (stop) => `${stop?.monitor_id || stop?.camera_code || stop?.label || 'cam'}-${stop?.first_seen_at || ''}`;

const isAlertStop = (stop) => stop?.type === 'alert' || Boolean(stop?.alert);

/**
 * The alert an operator needs to read.
 *
 * The payload does not carry a structured `alert` object yet, so this falls
 * back to the `note` the feed does send. `structured: false` is how the UI
 * knows to present it as the camera's own wording rather than as a policy
 * name it can link to.
 */
export function alertOf(stop) {
  if (!isAlertStop(stop)) return null;
  if (stop.alert && typeof stop.alert === 'object') {
    return {
      policy: stop.alert.policy || null,
      severity: stop.alert.severity || 'critical',
      message: stop.alert.message || stop.note || 'Policy violation',
      structured: true,
    };
  }
  return {
    policy: null,
    severity: 'critical',
    message: stop.note || 'Policy violation',
    structured: false,
  };
}

// ── clusterStops ────────────────────────────────────────────────────────────

function nodeFromRun(run, kind) {
  const first = run[0];
  const last = run[run.length - 1];
  const firstSeenMs = ms(first.first_seen_at);
  const lastSeenMs = ms(last.last_seen_at || last.first_seen_at) ?? firstSeenMs;
  const alert = run.map(alertOf).find(Boolean) || null;

  return {
    id: stopKeyOf(first),
    kind,
    zone: first.zone || null,
    floor: first.floor || first.level || null,
    // A cluster is named by its zone because that is what it IS; a single
    // sighting is named by its camera because that is where it happened.
    label: kind === NODE.CLUSTER ? clusterKeyOf(first) : (first.label || clusterKeyOf(first)),
    firstSeenMs,
    lastSeenMs,
    // Time spent inside this node. For a cluster that is first-entry to
    // last-exit across the whole run, which is the number an investigator
    // reads off the card.
    dwellMs: Math.max(0, (lastSeenMs ?? 0) - (firstSeenMs ?? 0)),
    count: run.length,
    stops: run,
    hasAlert: Boolean(alert),
    alert,
    gapBeforeMs: null,
  };
}

/**
 * stops[] -> nodes[].
 *
 * Walks the chain once. Anchors and alerts are emitted atomically; everything
 * between them accumulates into runs of one cluster key, and a run is flushed
 * when the key changes, when a gap opens inside it, or when an atomic stop
 * interrupts it.
 */
export function clusterStops(stops, { gapThresholdMs = GAP_THRESHOLD_MS, minRun = MIN_CLUSTER_RUN } = {}) {
  const list = (Array.isArray(stops) ? stops : [])
    .filter((s) => s && ms(s.first_seen_at) != null)
    // Defensive: the canvas draws in array order, so a feed that ever returns
    // out of order would draw a route that goes backwards in time.
    .slice()
    .sort((a, b) => ms(a.first_seen_at) - ms(b.first_seen_at));

  if (!list.length) return [];

  const lastIndex = list.length - 1;
  const nodes = [];
  let run = [];

  const flush = () => {
    if (!run.length) return;
    nodes.push(nodeFromRun(run, run.length >= minRun ? NODE.CLUSTER : NODE.SIGHTING));
    run = [];
  };

  for (let i = 0; i < list.length; i += 1) {
    const stop = list[i];
    const atomicKind = i === 0 ? NODE.START
      : i === lastIndex ? NODE.END
        : isAlertStop(stop) ? NODE.ALERT
          : null;

    if (atomicKind) {
      flush();
      nodes.push(nodeFromRun([stop], atomicKind));
      continue;
    }

    if (run.length) {
      const prev = run[run.length - 1];
      const sameZone = clusterKeyOf(prev) === clusterKeyOf(stop);
      const gap = (ms(stop.first_seen_at) ?? 0) - (ms(prev.last_seen_at || prev.first_seen_at) ?? 0);
      // Twelve sightings either side of a fifteen-minute hole is two visits to
      // the same corridor, not one — so a gap splits the run even when the
      // zone has not changed.
      if (!sameZone || gap > gapThresholdMs) flush();
    }

    run.push(stop);
  }

  flush();
  return nodes;
}

// ── detectGaps ──────────────────────────────────────────────────────────────

/**
 * Annotate each node with the unmonitored time before it.
 *
 * Returns new objects; idempotent, so it can run after any re-cluster. A gap
 * under the threshold is `null` rather than a small number, because the
 * connector renders dashed on presence — "there was 40 seconds between these
 * cameras" is not a finding.
 */
export function detectGaps(nodes, thresholdMs = GAP_THRESHOLD_MS) {
  return (Array.isArray(nodes) ? nodes : []).map((node, i, all) => {
    if (i === 0) return { ...node, gapBeforeMs: null };
    const prev = all[i - 1];
    const gap = (node.firstSeenMs ?? 0) - (prev.lastSeenMs ?? 0);
    return { ...node, gapBeforeMs: gap > thresholdMs ? gap : null };
  });
}

/** The two together, which is how every caller wants them. */
export function buildNodes(stops, opts = {}) {
  const threshold = opts.gapThresholdMs ?? GAP_THRESHOLD_MS;
  return detectGaps(clusterStops(stops, { ...opts, gapThresholdMs: threshold }), threshold);
}

// ── buildTimeAxis ───────────────────────────────────────────────────────────

// Tick intervals the scrubber may use, smallest first. Chosen so a label always
// lands on a round clock time — 10:15, not 10:17.
const TICK_STEPS_MS = [
  60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  60 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000,
];

/**
 * The scrubber's axis.
 *
 * Bounds come from the nodes, not from the summary: the two must not be able to
 * disagree about where the journey starts, and the nodes are what is drawn.
 * Padding is deliberate — a first node sitting exactly on the left edge reads
 * as clipped rather than as the beginning.
 */
export function buildTimeAxis(nodes, { maxTicks = 8 } = {}) {
  const list = Array.isArray(nodes) ? nodes.filter((n) => n.firstSeenMs != null) : [];
  if (!list.length) return { startMs: null, endMs: null, spanMs: 0, ticks: [] };

  const rawStart = Math.min(...list.map((n) => n.firstSeenMs));
  const rawEnd = Math.max(...list.map((n) => n.lastSeenMs ?? n.firstSeenMs));
  const rawSpan = Math.max(rawEnd - rawStart, 60_000);
  const pad = Math.round(rawSpan * 0.04);
  const startMs = rawStart - pad;
  const endMs = rawEnd + pad;
  const spanMs = endMs - startMs;

  const step = TICK_STEPS_MS.find((s) => spanMs / s <= maxTicks) || TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  const ticks = [];
  for (let t = Math.ceil(startMs / step) * step; t <= endMs; t += step) {
    ticks.push({ ms: t, pct: ((t - startMs) / spanMs) * 100 });
  }

  return { startMs, endMs, spanMs, ticks };
}

/** Where a moment sits on that axis, 0..100. */
export const pctOfAxis = (axis, msValue) => (
  axis?.spanMs ? Math.min(100, Math.max(0, ((msValue - axis.startMs) / axis.spanMs) * 100)) : 0
);

// ── nodeStateAt ─────────────────────────────────────────────────────────────

/**
 * A node's relationship to the scrubber.
 *
 * `cursorMs == null` means nobody is scrubbing, and the honest answer then is
 * that the whole journey has already happened — so everything is 'past' and
 * the canvas draws it at full strength rather than dimming a page nobody has
 * touched.
 */
export function nodeStateAt(node, cursorMs) {
  if (cursorMs == null || node?.firstSeenMs == null) return 'past';
  const end = node.lastSeenMs ?? node.firstSeenMs;
  if (cursorMs < node.firstSeenMs) return 'future';
  if (cursorMs > end) return 'past';
  return 'active';
}

/** The node the scrubber is inside, or the last one it has passed. */
export function nodeAt(nodes, cursorMs) {
  if (cursorMs == null) return null;
  const list = Array.isArray(nodes) ? nodes : [];
  let best = null;
  for (const n of list) {
    if (nodeStateAt(n, cursorMs) === 'active') return n;
    if ((n.firstSeenMs ?? 0) <= cursorMs) best = n;
  }
  return best;
}

// ── Playlist (the Route Flow player) ────────────────────────────────────────

/**
 * Where a sighting's footage lives, or null.
 *
 * The journey service does not send clips yet, so this reads the field names
 * it is expected to grow (`clip_url`, `video_url`, or a `clip` object) and
 * returns null otherwise -- the player then holds on the snapshot instead of
 * inventing a URL. `startSec`/`endSec` bound the sighting inside a longer
 * recording; without them the whole file is the sighting.
 */
export function clipOf(stop) {
  const src = stop?.clip_url || stop?.video_url || stop?.clip?.url || null;
  // An s3:// URI is not playable by a <video>, and there is no signing
  // endpoint for video the way there is for snapshots.
  if (!src || String(src).startsWith('s3://')) return null;
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    src: String(src),
    startSec: Math.max(0, num(stop.clip_start_sec ?? stop.clip?.start_sec) ?? 0),
    endSec: num(stop.clip_end_sec ?? stop.clip?.end_sec),
    // Wall-clock time of the clip's second zero, when the feed knows it. With
    // it the timeline follows the footage exactly; without it, progress
    // through the clip is spread proportionally across the sighting.
    startedMs: ms(stop.clip_started_at ?? stop.clip?.started_at),
  };
}

/** "Main Gate - CAM 01" -> { location: 'Main Gate', camera: 'CAM 01' }. */
export function cameraOf(stop) {
  const label = String(stop?.label || '');
  const m = label.match(/^(.*?)\s*[-–—]\s*(CAM[\s_-]*[\w]+)\s*$/i);
  return {
    location: (m ? m[1] : label) || stop?.zone || 'Unknown location',
    camera: (m ? m[2].toUpperCase() : null)
      || stop?.camera_code
      || (stop?.monitor_id != null ? String(stop.monitor_id) : null)
      || 'CAM',
  };
}

/**
 * nodes[] -> one playable segment per SIGHTING, in time order.
 *
 * Per sighting rather than per node, because a cluster of twelve is twelve
 * clips. Each segment keeps its `nodeId` so the history panel can highlight
 * the card it belongs to. The gap is carried only on the first sighting of a
 * node: clusters are split on gaps, so a hole can never sit inside one, and
 * reusing the node's own `gapBeforeMs` means the player, the history panel and
 * the timeline agree about which transitions were unmonitored.
 */
export function buildPlaylist(nodes) {
  const out = [];
  (Array.isArray(nodes) ? nodes : []).forEach((node, nodeIndex) => {
    (node.stops || []).forEach((stop, i) => {
      const firstSeenMs = ms(stop.first_seen_at);
      if (firstSeenMs == null) return;
      const lastSeenMs = Math.max(firstSeenMs, ms(stop.last_seen_at || stop.first_seen_at) ?? firstSeenMs);
      out.push({
        key: stopKeyOf(stop),
        index: out.length,
        nodeId: node.id,
        nodeIndex,
        stopIndex: i,
        stopCount: node.stops.length,
        kind: node.kind,
        stop,
        ...cameraOf(stop),
        zone: stop.zone || null,
        firstSeenMs,
        lastSeenMs,
        alert: alertOf(stop),
        clip: clipOf(stop),
        snapshot: stop.snapshot_uri || stop.snapshot || null,
        gapBeforeMs: i === 0 ? node.gapBeforeMs ?? null : null,
      });
    });
  });
  return out;
}

/** Progress through a segment (0..1) -> the wall-clock moment it shows. */
export function wallAt(segment, fraction, clipTimeSec = null) {
  if (!segment) return null;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  if (segment.clip?.startedMs != null && clipTimeSec != null) {
    const t = segment.clip.startedMs + clipTimeSec * 1000;
    return Math.min(segment.lastSeenMs, Math.max(segment.firstSeenMs, t));
  }
  return segment.firstSeenMs + f * (segment.lastSeenMs - segment.firstSeenMs);
}

/**
 * A wall-clock moment -> which segment shows it, and how far in.
 *
 * A moment inside an unmonitored gap resolves to the START of the sighting
 * after it: there is no footage of the gap, and the next thing anyone saw is
 * the honest answer to "show me 10:16".
 */
export function locateInPlaylist(playlist, msValue) {
  const list = Array.isArray(playlist) ? playlist : [];
  if (!list.length || msValue == null) return null;
  for (const seg of list) {
    if (msValue < seg.firstSeenMs) return { index: seg.index, fraction: 0 };
    if (msValue <= seg.lastSeenMs) {
      const span = seg.lastSeenMs - seg.firstSeenMs;
      return { index: seg.index, fraction: span ? (msValue - seg.firstSeenMs) / span : 0 };
    }
  }
  return { index: list[list.length - 1].index, fraction: 0 };
}

// ── Route history filters ───────────────────────────────────────────────────

export const HISTORY_FILTERS = [
  { id: 'all', label: 'All stops' },
  { id: 'restricted', label: 'Restricted only' },
  { id: 'longDwell', label: 'Long dwell > 5m' },
];

export function filterHistory(nodes, filter) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (filter === 'restricted') return list.filter((n) => n.hasAlert);
  if (filter === 'longDwell') return list.filter((n) => n.dwellMs > LONG_DWELL_MS);
  return list;
}

// ── View order ──────────────────────────────────────────────────────────────

/**
 * How the Route History list is READ. Presentation only.
 *
 * The model itself stays strictly ascending, everywhere, because three things
 * depend on it: `clusterStops` names index 0 START and the last index END,
 * `detectGaps` reads "before" as *earlier in time*, and the playlist plays
 * forward. Reversing upstream would make the last-seen stop the journey's
 * "Start" and turn every gap label into a lie. So order is applied once, at
 * render, and never to the data the axis and the player read.
 */
export const ORDER = { NEWEST_FIRST: 'desc', OLDEST_FIRST: 'asc' };

/**
 * nodes[] -> nodes[] in reading order.
 *
 * Returns a NEW array. `Array.prototype.reverse` mutates, and these nodes are
 * shared with `buildTimeAxis` and `buildPlaylist` — reversing in place would
 * flip the scrubber's axis and play the route backwards.
 */
export function orderNodes(nodes, order = ORDER.OLDEST_FIRST) {
  const list = Array.isArray(nodes) ? nodes : [];
  return order === ORDER.NEWEST_FIRST ? list.slice().reverse() : list;
}

/**
 * The journey's two anchors, BY TIME: `{ first, last }`.
 *
 * Read off the timestamps, never off array position, so "jump to first seen"
 * is still the earliest stop while the list is being read newest-first. Both
 * are null for an empty journey, and the same node for a single-stop one.
 */
export function terminalNodes(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n?.firstSeenMs != null);
  if (!list.length) return { first: null, last: null };
  const endOf = (n) => n.lastSeenMs ?? n.firstSeenMs;
  let first = list[0];
  let last = list[0];
  for (const n of list) {
    if (n.firstSeenMs < first.firstSeenMs) first = n;
    if (endOf(n) >= endOf(last)) last = n;
  }
  return { first, last };
}

/**
 * Did the service cut this journey short at the WRONG end?
 *
 * `/journey/map` caps at `limit` **events** and keeps the OLDEST ones, so a
 * truncated journey is missing its most recent sightings — and the newest
 * card is then not the latest sighting. The response carries no total, so
 * `raw_event_count === limit` is the only signal available: it means "probably
 * truncated", and the page has to say so rather than present a partial route
 * as a whole one. Drop this once the service orders DESC before limiting.
 */
export function isTruncated(payload, limit) {
  const seen = Number(payload?.raw_event_count ?? payload?.summary?.events);
  const cap = Number(limit);
  return Number.isFinite(seen) && cap > 0 && seen >= cap;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const fmtClock = (msValue) => (msValue == null ? '--' : new Date(msValue).toLocaleTimeString([], {
  hour: '2-digit', minute: '2-digit',
}));

export const fmtClockSec = (msValue) => (msValue == null ? '--' : new Date(msValue).toLocaleTimeString([], {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}));

export const fmtDateTime = (msValue) => (msValue == null ? '--' : new Date(msValue).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
}));

/** Durations read as an operator says them: 34s, 4m, 1h 12m. */
export function fmtDuration(msValue) {
  if (msValue == null) return '--';
  const s = Math.max(0, Math.round(msValue / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** One line summarising what clustering achieved, for the toolbar. */
export function describeClustering(stops, nodes) {
  const sightings = Array.isArray(stops) ? stops.length : 0;
  const cards = Array.isArray(nodes) ? nodes.length : 0;
  if (!sightings) return null;
  return { sightings, cards, collapsed: Math.max(0, sightings - cards) };
}
