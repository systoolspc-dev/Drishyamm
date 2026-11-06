/**
 * The Health page's vocabulary and formatters, in one place.
 *
 * The stream engine reports SEVEN states — healthy, standby, transcoding,
 * starting, wobbling, offline, unknown. An operator scanning two thousand
 * cameras does not need seven; they need to know which cameras are fine and
 * which ones they have to walk over to. So the page groups the seven engine
 * states into FOUR buckets, and every count on the page — the summary strip,
 * the status filter, the "need attention" number — is derived from this one
 * map. They cannot disagree with each other because there is only one of them.
 *
 * The engine state is never thrown away: it is what the row tooltip and the
 * detail line show, so "Online" can still explain itself as "idle, connects
 * when opened" or "converting H.265".
 */

// ── Engine state → what an operator should read ─────────────────────────────
export const ENGINE_STATE = {
  healthy: {
    bucket: 'online',
    label: 'Online',
    headline: 'Streaming well',
    action: 'No action needed',
  },
  standby: {
    bucket: 'online',
    label: 'Online',
    headline: 'Idle — connects when opened',
    action: 'Reachable, streams on demand',
  },
  transcoding: {
    bucket: 'online',
    label: 'Online',
    headline: 'Making stream browser-ready',
    action: 'Normal for H.265 cameras',
  },
  starting: {
    bucket: 'online',
    label: 'Starting',
    headline: 'Camera is warming up',
    action: 'Wait a few seconds',
  },
  wobbling: {
    bucket: 'unstable',
    label: 'Unstable',
    headline: 'Stream keeps dropping',
    action: 'Check network or reconnect',
  },
  offline: {
    bucket: 'offline',
    label: 'Offline',
    headline: 'No video coming in',
    action: 'Check power, cable, NVR or password',
  },
  unknown: {
    bucket: 'setup',
    label: 'Needs setup',
    headline: 'Not registered with the stream engine',
    action: 'Start this stream again',
  },
};

/**
 * The four buckets, in the order the filter list and the table sort use:
 * worst first, so "most important problems are shown first" is a sort, not a
 * hand-wave.
 *
 * `tone` is the product's semantic tone vocabulary (src/core/ui/tone.js), so
 * these pills are the same green and the same red as every other state chip
 * in the app.
 *
 * `meaning` and `fix` are the guide copy. They live here, next to the buckets
 * they describe, so the "How to read this" dialog cannot end up explaining a
 * bucket the page no longer has — or missing one it gained.
 */
export const BUCKETS = [
  {
    id: 'offline', label: 'Offline', tone: 'danger', status: 'offline', attention: true,
    meaning: 'No video is arriving from this camera.',
    fix: 'Check power, cabling, the recorder and the camera password.',
  },
  {
    id: 'unstable', label: 'Unstable', tone: 'warning', status: 'degraded', attention: true,
    meaning: 'Video arrives, but the stream keeps dropping out.',
    fix: 'Check the network path, then reconnect the camera.',
  },
  {
    id: 'setup', label: 'Needs setup', tone: 'neutral', status: 'unknown', attention: true,
    meaning: 'The camera is not registered with the stream engine.',
    fix: 'Start this stream again from Camera Setup.',
  },
  {
    id: 'online', label: 'Online', tone: 'success', status: 'online', attention: false,
    meaning: 'Video is arriving normally, or the camera is idle and will connect when opened.',
    fix: 'No action needed.',
  },
];

/** Filter-list order — the healthy majority first, the way the design reads. */
export const FILTER_BUCKETS = ['online', 'offline', 'unstable', 'setup'];

const BUCKET_BY_ID = Object.fromEntries(BUCKETS.map((b) => [b.id, b]));
const SEVERITY = Object.fromEntries(BUCKETS.map((b, i) => [b.id, i]));

export function engineState(status) {
  return ENGINE_STATE[status] || ENGINE_STATE.unknown;
}

export function bucketOf(camera) {
  return engineState(camera?.status).bucket;
}

export function bucketMeta(id) {
  return BUCKET_BY_ID[id] || BUCKET_BY_ID.setup;
}

/** Lower sorts first. Used for the default "problems first" ordering. */
export function severityOf(camera) {
  return SEVERITY[bucketOf(camera)] ?? 99;
}

/** Does this camera need a human to do something? */
export function needsAttention(camera) {
  return bucketMeta(bucketOf(camera)).attention;
}

// ── Formatters ──────────────────────────────────────────────────────────────

/** A dash, not a zero. A camera with no data has no bitrate — it does not
 *  have a bitrate of nought, and the two must not look the same. */
export const DASH = '—';

export function fmtBps(bps) {
  const n = Number(bps) || 0;
  if (n <= 0) return DASH;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} Mbps`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} Kbps`;
  return `${n} bps`;
}

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function fmtDuration(sec) {
  if (sec == null || sec < 0) return DASH;
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/**
 * Delay, graded. Under 80 ms is smooth, 80–200 ms is noticeable but usable,
 * above that an operator will see the picture stall. A camera that is not
 * sending anything has no delay to report, so it grades as unknown rather
 * than as a perfect 0 ms.
 */
export function gradeDelay(ms, { hasStream = true } = {}) {
  const n = Number(ms) || 0;
  if (!hasStream || !n) return { label: 'No data', tone: 'neutral', text: DASH };
  if (n < 80) return { label: 'Smooth', tone: 'success', text: `${Math.round(n)} ms` };
  if (n < 200) return { label: 'Slight delay', tone: 'warning', text: `${Math.round(n)} ms` };
  return { label: 'High delay', tone: 'danger', text: `${Math.round(n)} ms` };
}

/** True when the camera is actually passing video right now. */
export function isStreaming(camera) {
  return Number(camera?.bpsIn || camera?.meanBps || 0) > 0;
}

/**
 * A timestamp an operator can act on. Today's events show the wall-clock time
 * they are about to compare against their watch; anything older carries its
 * date, so a camera that dropped last Tuesday cannot be misread as one that
 * dropped this morning.
 */
export function fmtTimestamp(iso) {
  if (!iso) return DASH;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return DASH;

  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();

  if (sameDay) {
    return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  return at.toLocaleString([], {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** Full, unambiguous form — for the `title` attribute behind a short label. */
export function fmtTimestampFull(iso) {
  if (!iso) return 'No reading yet';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'No reading yet' : at.toLocaleString();
}

/** The header's "Last updated" stamp: "12 Sep 2026, 11:38 AM". */
export function fmtClock(date) {
  if (!date) return '--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtPercent(part, whole) {
  if (!whole) return '0% of total';
  return `${Math.round((Number(part) / Number(whole)) * 100)}% of total`;
}
