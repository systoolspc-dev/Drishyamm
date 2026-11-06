/**
 * Playback page model: time helpers, the timeline's layer vocabulary, event
 * categorisation, and the small per-browser stores (bookmarks, camera
 * thumbnails). Pure apart from the storage helpers, which never throw.
 *
 * Every time value is epoch ms; every label is in the viewer's local time.
 */
import { Activity, Bookmark, Car, Footprints, PersonStanding, TriangleAlert } from 'lucide-react';
import { EVENT_META, describe } from '@/core/services/ai';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Playback starts this far before an event, so the moment itself is seen. */
export const PREROLL_MS = 3000;
/** One replay session's cap (playback.controller MAX_RANGE_MS). */
export const SESSION_MAX_MS = 6 * HOUR;
/** One exported clip's cap (playback.controller MAX_EXPORT_MS). */
export const EXPORT_MAX_MS = 30 * MINUTE;

const p2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const iso = (ms) => new Date(ms).toISOString();

/** Local calendar day of `ms` as YYYY-MM-DD (the <input type="date"> format). */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const ymd = (key) => key.split('-').map(Number);

/** Local midnight that starts the day `key`. */
export function dayStart(key) {
  const [y, m, d] = ymd(key);
  return new Date(y, m - 1, d).getTime();
}

/** Local midnight that ends the day `key`. */
export function dayEnd(key) {
  const [y, m, d] = ymd(key);
  return new Date(y, m - 1, d + 1).getTime();
}

/** 'HH:MM' or 'HH:MM:SS' on the day `key`, as epoch ms. */
export function atTime(key, hms) {
  const [y, m, d] = ymd(key);
  const [h = 0, mi = 0, s = 0] = String(hms || '').split(':').map(Number);
  return new Date(y, m - 1, d, h, mi, s).getTime();
}

/** Time of day for a time input: 'HH:MM', or 'HH:MM:SS' with `seconds`. */
export function timeValue(ms, seconds = false) {
  const d = new Date(ms);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return seconds ? `${hm}:${p2(d.getSeconds())}` : hm;
}

/** 24-hour clock with seconds, for the video overlay and the timeline. */
export function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '--:--:--';
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** Locale time with seconds ("10:42:16 AM"), for list rows. */
export function fmtTimeLong(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "11 Sep 2026". Built by hand: locales disagree on "Sep" vs "Sept". */
export function fmtDate(ms) {
  const d = new Date(ms);
  return `${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  if (m) return sec ? `${m} min ${sec} s` : `${m} min`;
  return `${sec} s`;
}

// ── Windows ─────────────────────────────────────────────────────────────────

export const PRESETS = [
  { id: '30m', label: '30 min', ms: 30 * MINUTE },
  { id: '1h', label: '1 hr', ms: HOUR },
  { id: '6h', label: '6 hr', ms: 6 * HOUR },
  { id: 'today', label: 'Today' },
];

/** The window a quick-range button means right now. */
export function presetWindow(id, now = Date.now()) {
  if (id === 'today') return { start: dayStart(dayKey(now)), end: now };
  const preset = PRESETS.find((p) => p.id === id) || PRESETS[1];
  return { start: now - preset.ms, end: now };
}

const parseWhen = (v) => {
  if (!v) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.parse(v);
};

/**
 * Deep-link window. ?from=&to= (ISO or epoch ms) is used as given; a single
 * ?t= moment (what Alerts and Journey Map send) opens 30 s before it and two
 * minutes after, capped at now.
 */
export function linkWindow(from, to, t, now = Date.now()) {
  const f = parseWhen(from);
  if (Number.isFinite(f)) {
    const e = parseWhen(to);
    return { start: f, end: Number.isFinite(e) && e > f ? e : Math.min(f + 5 * MINUTE, now) };
  }
  const m = parseWhen(t);
  if (Number.isFinite(m)) return { start: m - 30_000, end: Math.min(m + 2 * MINUTE, now) };
  return null;
}

/** Default export range around a moment: 45 s before, two minutes after. */
export function clipAround(t, now = Date.now()) {
  const start = Math.min(t - 45_000, now - 60_000);
  return { start, end: Math.min(start + 165_000, now) };
}

// ── Timeline ticks ──────────────────────────────────────────────────────────

const TICK_STEPS = [
  10_000, 30_000, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE,
  30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR,
];

/** Clock-aligned tick times across a visible range, about `maxTicks` of them. */
export function timeTicks(start, end, maxTicks = 9) {
  const span = end - start;
  const step = TICK_STEPS.find((s) => span / s <= maxTicks) || TICK_STEPS[TICK_STEPS.length - 1];
  // Aligned to local midnight so ticks land on :00 / :15 / :30, not on the
  // window's arbitrary start second.
  const origin = dayStart(dayKey(start));
  const ticks = [];
  for (let t = origin + Math.ceil((start - origin) / step) * step; t <= end; t += step) ticks.push(t);
  return { step, ticks };
}

export function tickLabel(ms, step) {
  const d = new Date(ms);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return step < MINUTE ? `${hm}:${p2(d.getSeconds())}` : hm;
}

// ── Layers & events ─────────────────────────────────────────────────────────

/** The timeline's layers in legend order. `tone` is a core/ui/tone key. */
export const LAYERS = [
  { id: 'recording', label: 'Recording', tone: 'brand' },
  { id: 'motion', label: 'Motion', tone: 'success', Icon: Footprints },
  { id: 'person', label: 'Person', tone: 'ai', Icon: PersonStanding },
  { id: 'vehicle', label: 'Vehicle', tone: 'info', Icon: Car },
  { id: 'alarm', label: 'Alarm', tone: 'danger', Icon: TriangleAlert },
  { id: 'bookmark', label: 'Bookmark', tone: 'warning', Icon: Bookmark },
];
/** Events that fit no layer: listed and marked, but not in the legend. */
export const OTHER_LAYER = { id: 'other', label: 'Other', tone: 'neutral', Icon: Activity };
const LAYER_BY_ID = Object.fromEntries(LAYERS.map((l) => [l.id, l]));
export const layerOf = (id) => LAYER_BY_ID[id] || OTHER_LAYER;
/** The event categories the Events filter offers. */
export const EVENT_CATEGORIES = ['person', 'vehicle', 'motion', 'alarm', 'other'];

const VEHICLE = /vehicle|lpr|anpr|plate/;
const MOTION = /motion/;
const ALARM = /alert|intrusion|zone|weapon|fire|smoke|tamper|stampede|removed|offline|occupancy\.(threshold|warning)/;
const PERSON = /person|face|match|unknown|tripwire|line|loiter|crowd|people|human/;

/** Which timeline layer an AI event belongs to. */
export function categorize(evt) {
  const type = String(evt?.eventType || evt?.kind || evt?.action || '').toLowerCase();
  if (VEHICLE.test(type)) return 'vehicle';
  if (MOTION.test(type)) return 'motion';
  if (ALARM.test(type) || evt?.severity === 'critical') return 'alarm';
  if (PERSON.test(type)) return 'person';
  return 'other';
}

export function eventTime(evt) {
  const t = new Date(evt?.ts || evt?.occurred_at || evt?.timestamp || evt?.createdAt || NaN).getTime();
  return Number.isFinite(t) ? t : null;
}

const DEFAULT_TITLE = {
  person: 'Person detected',
  vehicle: 'Vehicle detected',
  motion: 'Motion detected',
  alarm: 'Alarm',
  other: 'Event',
};

/** The words for an event or a histogram bin: its EVENT_META phrase, else its layer's. */
export function titleFor(evt, category = categorize(evt)) {
  const type = evt?.eventType || evt?.kind || evt?.action || '';
  const known = EVENT_META[type] || EVENT_META[String(type).toLowerCase()];
  return known ? known.nounWhen : DEFAULT_TITLE[category];
}

/** An AI event as this page draws it: time, layer, and the words for its row. */
export function toPlaybackEvent(evt) {
  const t = eventTime(evt);
  if (t == null) return null;
  const category = categorize(evt);
  const d = describe(evt);
  return {
    id: `${evt.source || 'db'}-${evt.id}`,
    t,
    category,
    title: titleFor(evt, category),
    // A recognised name is the most useful second line; anonymous detections
    // fall back to the camera name.
    who: d.isUnknown ? null : d.subject,
    raw: evt,
  };
}

/** A histogram bin (/ai/events/histogram) as a timeline marker standing for `count` events. */
export function binToMarker(bin) {
  const t = Date.parse(bin?.first);
  if (!Number.isFinite(t)) return null;
  const category = categorize(bin);
  return { t, last: Date.parse(bin.last) || t, category, count: bin.count || 1, title: titleFor(bin, category) };
}

/**
 * Collapse markers that would draw on top of each other: one per layer per
 * slot of the visible range, keeping the earliest time (a click plays from
 * the first of them) and a count. An item may already stand for several
 * events (`count`, from the histogram); counts add up.
 */
export function bucketMarkers(items, start, end, slots = 40) {
  const width = (end - start) / slots;
  if (!(width > 0)) return [];
  const buckets = new Map();
  for (const it of items) {
    if (it.t < start || it.t > end) continue;
    const key = `${it.category}:${Math.floor((it.t - start) / width)}`;
    const n = it.count || 1;
    const b = buckets.get(key);
    if (b) {
      b.count += n;
      b.last = Math.max(b.last, it.last ?? it.t);
      b.t = Math.min(b.t, it.t);
    } else {
      buckets.set(key, { key, category: it.category, t: it.t, last: it.last ?? it.t, count: n, title: it.title });
    }
  }
  return [...buckets.values()];
}

// ── Cameras ─────────────────────────────────────────────────────────────────

// Standby is "reachable, idle until someone watches": as good as online for
// replaying what the NVR already recorded.
const ONLINE = new Set(['healthy', 'transcoding', 'streaming', 'standby', 'starting']);

export function cameraState(status) {
  if (ONLINE.has(status)) return { tone: 'success', label: 'Online' };
  if (status === 'wobbling') return { tone: 'warning', label: 'Unstable' };
  if (status === 'offline') return { tone: 'danger', label: 'Offline' };
  return { tone: 'neutral', label: 'Unknown' };
}

export const cameraPlace = (c) => c?.siteName || c?.groupName || '';

// ── Per-browser stores ──────────────────────────────────────────────────────

const storage = (kind) => {
  try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch { return null; }
};
function readJson(kind, key) {
  try { return JSON.parse(storage(kind)?.getItem(key) || '{}') || {}; } catch { return {}; }
}
function writeJson(kind, key, value) {
  try { storage(kind)?.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota */ }
}

const BOOKMARKS_KEY = 'playback.bookmarks.v1';

/** This browser's bookmarks for a camera, oldest first. */
export function loadBookmarks(monitorId) {
  const list = readJson('local', BOOKMARKS_KEY)[monitorId];
  return Array.isArray(list) ? list.filter((b) => Number.isFinite(b?.t)).sort((a, b) => a.t - b.t) : [];
}

export function saveBookmarks(monitorId, list) {
  const all = readJson('local', BOOKMARKS_KEY);
  if (list.length) all[monitorId] = list;
  else delete all[monitorId];
  writeJson('local', BOOKMARKS_KEY, all);
}

// A frame grabbed from the camera's last replay, for the picker. There is no
// server-side still for a camera, so this is the only thumbnail there is.
const THUMBS_KEY = 'playback.thumbs.v1';
const THUMBS_MAX = 40;

export function loadThumbs() {
  return readJson('session', THUMBS_KEY);
}

export function saveThumb(monitorId, dataUrl) {
  const all = readJson('session', THUMBS_KEY);
  delete all[monitorId];
  all[monitorId] = dataUrl;          // re-inserted, so the oldest is first
  const keys = Object.keys(all);
  while (keys.length > THUMBS_MAX) delete all[keys.shift()];
  writeJson('session', THUMBS_KEY, all);
}
