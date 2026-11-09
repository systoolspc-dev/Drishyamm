/**
 * Timelapse model: the interval vocabulary, and how a day of cloud recordings
 * (getCameraRecordings) becomes a time-ordered run of clips the timelapse
 * player can walk through.
 *
 * Every time value is epoch ms, in the viewer's local time (same as model.js).
 */
import { DAY, HOUR, MINUTE, atTime } from './model';

/**
 * How much footage one second of timelapse covers. "1 min" plays a minute of
 * recording per second of timelapse — 60× real time.
 */
export const INTERVALS = [
  { id: '10s', label: '10 sec', ratio: 10 },
  { id: '30s', label: '30 sec', ratio: 30 },
  { id: '1m', label: '1 min', ratio: 60 },
  { id: '5m', label: '5 min', ratio: 300 },
  { id: '10m', label: '10 min', ratio: 600 },
];
export const DEFAULT_INTERVAL = '1m';
export const intervalOf = (id) => INTERVALS.find((i) => i.id === id) || INTERVALS[2];

/** Viewer speed on top of the interval: 2× on a 60× timelapse plays at 120×. */
export const SPEEDS = [0.5, 1, 2, 4];

// A clip's length is only known once its metadata loads. Until then it is
// assumed to run to the next clip (continuous recording), or this long when
// the next clip is far away or there is none.
const CLIP_FALLBACK_MS = 15 * MINUTE;
const CLIP_MAX_GAP_MS = HOUR;

// Date-prefixed form (legacy): 2026-02-16T09-41-24.mp4
const FILENAME_TIME = /(\d{4}-\d{2}-\d{2})[T_ ](\d{2})[-:](\d{2})[-:](\d{2})/;
// Leading wall-clock time, no date (the live formats): the stitched clip
// "17-48-57_to_17-50-00_1m.mp4" and the raw segment "17-48-57-123456.mp4".
// The calendar day for these comes from the record's own `date` field.
const FILENAME_HMS = /^(\d{2})-(\d{2})-(\d{2})/;
// The end time a stitched clip carries: "..._to_17-50-00_...".
const FILENAME_TO = /_to_(\d{2})-(\d{2})-(\d{2})/;

/** When a recording starts: from its filename (local/IST wall-clock), else its upload time. */
export function clipStart(rec) {
  const dt = rec?.filename?.match(FILENAME_TIME);
  if (dt) return atTime(dt[1], `${dt[2]}:${dt[3]}:${dt[4]}`);
  const hms = rec?.filename?.match(FILENAME_HMS);
  if (hms && rec?.date) return atTime(rec.date, `${hms[1]}:${hms[2]}:${hms[3]}`);
  const uploaded = Date.parse(rec?.lastModified);
  return Number.isFinite(uploaded) ? uploaded - CLIP_FALLBACK_MS : null;
}

/** A stitched clip's exact end (absolute epoch ms) from its "_to_HH-MM-SS", else null. */
export function clipEnd(rec, start) {
  const m = rec?.filename?.match(FILENAME_TO);
  if (!m || !rec?.date || start == null) return null;
  let end = atTime(rec.date, `${m[1]}:${m[2]}:${m[3]}`);
  if (end < start) end += DAY; // clip crossed midnight
  return end;
}

/**
 * Recordings as time-ordered clips { key, rec, start, end }. `durations` maps
 * a recording key to its measured length in ms and replaces the estimate.
 */
export function buildClips(recs, durations = {}) {
  const timed = (recs || [])
    .map((rec) => ({ rec, start: clipStart(rec) }))
    .filter((c) => c.start != null && c.rec?.key)
    .sort((a, b) => a.start - b.start);
  return timed.map((c, i) => {
    const gap = timed[i + 1] ? timed[i + 1].start - c.start : Infinity;
    const estimate = gap > 0 && gap <= CLIP_MAX_GAP_MS ? gap : CLIP_FALLBACK_MS;
    const measured = durations[c.rec.key];           // real length once the video metadata loads (ms)
    const exactEnd = clipEnd(c.rec, c.start);         // exact end from the filename (absolute ms)
    const end = measured != null ? c.start + measured
      : exactEnd != null ? exactEnd
      : c.start + estimate;
    return { key: c.rec.key, rec: c.rec, start: c.start, end };
  });
}

export const clipsInRange = (clips, start, end) => clips.filter((c) => c.end > start && c.start < end);

/**
 * The clip that plays at `t`, and the time it actually plays from: a moment
 * in a gap between recordings moves on to the next recording.
 */
export function locate(clips, t) {
  for (let i = 0; i < clips.length; i += 1) {
    if (t < clips[i].end) return { clip: clips[i], t: Math.max(t, clips[i].start) };
  }
  return null;
}

/** Motion-triggered recordings mark the timeline's Motion layer. */
export function recordingTrigger(rec) {
  const raw = rec?.recordingType || rec?.trigger || rec?.type;
  return typeof raw === 'string' ? raw.toLowerCase() : null;
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** The zone every time on this page is shown in. */
export function viewerTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '—'; } catch { return '—'; }
}
