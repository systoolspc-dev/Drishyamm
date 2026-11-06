// Break & Idle — per-employee event log for the staff profile.
//
// ONE derivation from a day's presence segments (DAY_TIMELINES[id] for today,
// mockDaySegments() for earlier days), read by everything on the profile: the
// header's live status + policy badges + time summary, and every row of the
// log. Because they all project the same result they cannot disagree.
//
// Segment kinds: floor = active, break = break (bt: 'tea' | 'lunch'),
// away = unplanned idle / station absence.
//
// Compliance is PER EVENT, against the vertical's params:
//   breaks.teaMaxSec / breaks.lunchMaxSec   limit for a tea / lunch break
//   idleAlertSec                            limit for one idle stretch
//   breaks.overstayGraceSec                 grace past a limit
// Each event is:
//   ok       — within its limit                              ("Within limits")
//   over     — past the limit, inside the grace              ("Overstayed +Xm")
//   flagged  — past limit + grace: the automatic alert fires ("Flagged +Xm")
//
// Future backend: GET /activity/employees/:id/breaks?from&to → the same rows,
// so this stays the single place the rules are applied.
//
// Plain .js so the components that render it keep Fast Refresh.

import { toMinutes } from './shifts';

export const ACTIVITY = {
  tea:        { label: 'Tea break',          short: 'Tea' },
  lunch:      { label: 'Lunch break',        short: 'Lunch' },
  idle:       { label: 'Unplanned idle',     short: 'Idle' },
  // Point-in-time rows the staff profile folds into the same log, so flags
  // live next to the activity that raised them rather than in a second list.
  arrival:    { label: 'Clock-in',           short: 'Clock-in' },
  unattended: { label: 'Station unattended', short: 'Unattended' },
  phone:      { label: 'Phone usage',        short: 'Phone' },
};

/** 380 → "6h 20m", 35 → "35m", 0 → "0m". */
export function formatMin(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/** The vertical's limits in minutes, defaults matching the base params. */
export function policyLimits(params = {}) {
  const b = params.breaks || {};
  return {
    teaMin: Math.round((b.teaMaxSec ?? 900) / 60),
    lunchMin: Math.round((b.lunchMaxSec ?? 2700) / 60),
    idleMin: Math.round((params.idleAlertSec ?? 600) / 60),
    graceMin: Math.round((b.overstayGraceSec ?? 300) / 60),
  };
}

// "Staff Room · CAM-04" → { location: 'Staff Room', cameraId: 'CAM-04' }
function splitAt(at) {
  if (!at) return { location: '—', cameraId: null };
  const [location, cam] = at.split(' · ');
  return { location, cameraId: cam && /^CAM-/i.test(cam) ? cam.toUpperCase() : null };
}

/**
 * @param {object} o
 * @param {Array<{s,e,k,bt?,at?,note?}>} o.segments  one day, chronological
 * @param {string} o.date     ISO day the segments belong to
 * @param {string} [o.now]    dataset clock "HH:MM" — only for today (ongoing rows)
 * @param {object} o.limits   policyLimits(params)
 */
export function summarizeDay({ segments = [], date, now, limits }) {
  const nowMin = now ? toMinutes(now) : Infinity;
  let activeMin = 0, breakMin = 0, idleMin = 0;
  const events = [];

  segments.forEach((sg, i) => {
    const dur = toMinutes(sg.e) - toMinutes(sg.s);
    if (sg.k === 'floor') { activeMin += dur; return; }
    const type = sg.k === 'away' ? 'idle' : (sg.bt === 'lunch' ? 'lunch' : 'tea');
    if (type === 'idle') idleMin += dur; else breakMin += dur;

    const limit = type === 'idle' ? limits.idleMin : type === 'lunch' ? limits.lunchMin : limits.teaMin;
    const overMin = Math.max(0, dur - limit);
    const compliance = overMin === 0 ? 'ok' : overMin <= limits.graceMin ? 'over' : 'flagged';
    const ongoing = i === segments.length - 1 && toMinutes(sg.e) >= nowMin;
    const { location, cameraId } = splitAt(sg.at);

    events.push({
      id: `${date}-${sg.s}`, date, type, start: sg.s, end: ongoing ? null : sg.e, ongoing,
      durationMin: dur, limitMin: limit, overMin, compliance,
      location, cameraId, note: sg.note || '',
    });
  });

  // Live status: the last segment, if it runs up to now (today only).
  const last = segments[segments.length - 1];
  const lastEvent = events[events.length - 1];
  const live = last && now && toMinutes(last.e) >= nowMin;
  let status;
  if (!last) status = { key: 'absent', label: 'Not arrived', tone: 'neutral' };
  else if (!live) status = { key: 'left', label: 'Left site', tone: 'neutral', since: last.e };
  else if (last.k === 'floor') status = { key: 'active', label: 'On floor', tone: 'success', since: last.s };
  else if (last.k === 'break') {
    status = lastEvent.compliance === 'flagged'
      ? { key: 'break-flag', label: 'Break overstay alert', tone: 'danger', since: last.s }
      : { key: 'break', label: 'In breakroom', tone: 'warning', since: last.s };
  } else {
    status = lastEvent.compliance === 'flagged'
      ? { key: 'idle-alert', label: 'Excessive idle alert', tone: 'danger', since: last.s }
      : { key: 'idle', label: 'Idle / away', tone: 'warning', since: last.s };
  }

  return {
    events, status, activeMin, breakMin, idleMin,
    exceptions: events.filter((e) => e.compliance !== 'ok').length,
    alerts: events.filter((e) => e.compliance === 'flagged').length,
  };
}

// ── mock history ────────────────────────────────────────────────────────────
// Earlier days for the Yesterday / Date-range views. Deterministic per
// (employee, date) so a day reads the same every time it is opened. Replaced
// wholesale by the API. Locations reuse the employee's own break room and last
// post from today where known, so the history looks like the same person.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function mockDaySegments({ empId, date, shift, todaySegments = [], fallbackPost = 'Floor' }) {
  const rnd = seeded(hash(`${empId}-${date}`));
  if (rnd() < 0.08) return [];                                   // day off / absent
  const start = toMinutes(shift?.start || '09:00');
  let end = toMinutes(shift?.end || '18:00');
  if (end <= start) end += 24 * 60;
  const breakAt = todaySegments.find((s) => s.k === 'break')?.at || 'Staff Room · CAM-04';
  const postAt = todaySegments.find((s) => s.k === 'away')?.at || `${fallbackPost} · CAM-0${1 + Math.floor(rnd() * 8)}`;

  const plan = [];
  const clockIn = start + Math.floor(rnd() * 12) - 4;
  const tea = { at: start + 90 + Math.floor(rnd() * 40), dur: 9 + Math.floor(rnd() * 12), k: 'break', bt: 'tea', where: breakAt, note: 'Scheduled break' };
  const lunch = { at: start + Math.round((end - start) * 0.45) + Math.floor(rnd() * 30), dur: 30 + Math.floor(rnd() * 24), k: 'break', bt: 'lunch', where: breakAt, note: 'Scheduled break' };
  plan.push(tea, lunch);
  if (rnd() < 0.55) {
    plan.push({ at: lunch.at + lunch.dur + 40 + Math.floor(rnd() * 60), dur: 4 + Math.floor(rnd() * 22), k: 'away', where: postAt, note: 'Away from post — not seen on any camera' });
  }
  plan.sort((a, b) => a.at - b.at);

  const segs = [];
  let t = clockIn;
  for (const p of plan) {
    if (p.at > t) segs.push({ s: hhmm(t), e: hhmm(p.at), k: 'floor' });
    segs.push({ s: hhmm(p.at), e: hhmm(p.at + p.dur), k: p.k, ...(p.bt ? { bt: p.bt } : {}), at: p.where, note: p.note });
    t = p.at + p.dur;
  }
  if (end > t) segs.push({ s: hhmm(t), e: hhmm(end), k: 'floor' });
  return segs;
}

/** ISO date ± days, local calendar (no timezone drift). */
export function shiftIsoDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}


// ── incidents ───────────────────────────────────────────────────────────────
// One severity flag per log row, or null. The log's "Flagged only" tab, its
// row badges and the profile's Flagged Incidents card all read this, so the
// count on the card is always the number of rows the tab shows.
//   high   (red)   — late arrival, unattended station
//   medium (amber) — over-break, idle past its limit, phone usage
export function incidentFlag(e) {
  if (e.type === 'arrival') return e.overMin > 0 ? { severity: 'high', label: `Late Arrival +${e.overMin}m` } : null;
  if (e.type === 'unattended' || (e.type === 'idle' && (e.unattended || e.compliance === 'flagged'))) {
    return { severity: 'high', label: 'Unattended Station' };
  }
  // Phone: the Activity Log's rows carry their hold time and the vertical's
  // phone.violationSec, so a brief glance reads as a warning and continuous
  // use past the limit as a violation — the Minor / Flagged split the Phone
  // Usage page made. Rows without those fields (the live feed's alerts) keep
  // the old single tier.
  if (e.type === 'phone') {
    if (e.holdSec == null || e.limitSec == null) return { severity: 'medium', label: 'Phone Usage' };
    return e.holdSec > e.limitSec
      ? { severity: 'high', label: `Phone Violation ${e.holdSec}s` }
      : { severity: 'medium', label: `Phone ${e.holdSec}s` };
  }
  if (e.compliance === 'ok') return null;
  return e.type === 'idle'
    ? { severity: 'medium', label: `Idle +${e.overMin}m` }
    : { severity: 'medium', label: `Over-break +${e.overMin}m` };
}

/**
 * A day's clock-in as a log row. `lateMin` null/0 = on time. Instant rows have
 * no duration; the log prints their time alone.
 */
export function arrivalEvent({ date, time, lateMin = 0, at = 'Entrance · CAM-01' }) {
  const { location, cameraId } = splitAt(at);
  const late = Math.max(0, lateMin || 0);
  return {
    id: `${date}-arrival`, date, type: 'arrival', instant: true,
    start: time, end: time, ongoing: false, durationMin: 0, limitMin: 0,
    overMin: late, compliance: late ? 'flagged' : 'ok',
    location, cameraId, note: late ? `Clocked in ${late} min past the shift's grace cutoff` : 'Clocked in on time',
  };
}

// ── timeframe & retention ───────────────────────────────────────────────────
// The profile's global range: Today / 7D / 30D / Custom, clipped to the plan's
// retention window (params.retentionDays). Nothing older than
// today − retentionDays exists server-side, so it is never requested.

export const TIMEFRAMES = [
  { key: 'today',  label: 'Today', days: 1 },
  { key: '7d',     label: '7D',    days: 7 },
  { key: '30d',    label: '30D',   days: 30 },
  { key: 'custom', label: 'Custom' },
];

/** Oldest date still held under the plan. */
export const retentionCutoff = (today, retentionDays) => shiftIsoDate(today, -retentionDays);

/**
 * @param {{ key: string, from?: string, to?: string }} tf
 * @returns {{ from, to, dates: string[], expired: boolean, cutoff: string, label: string }}
 *   dates — the retained days in range, newest first; expired — some of the
 *   asked-for range falls before the cutoff (and was dropped).
 */
export function resolveTimeframe(tf, today, retentionDays) {
  const cutoff = retentionCutoff(today, retentionDays);
  const preset = TIMEFRAMES.find((t) => t.key === tf.key && t.days);
  let from = preset ? shiftIsoDate(today, -(preset.days - 1)) : (tf.from || today);
  let to = preset ? today : (tf.to || today);
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;

  const expired = from < cutoff;
  const dates = [];
  for (let d = to; d >= from && d >= cutoff; d = shiftIsoDate(d, -1)) dates.push(d);

  const label = tf.key === 'today' ? 'Today'
    : preset ? `Last ${preset.days} days`
    : from === to ? formatIsoDate(from) : `${formatIsoDate(from)} – ${formatIsoDate(to)}`;
  return { from, to, dates, expired, cutoff, label };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-07-16" → "16 Jul 2026". */
export function formatIsoDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return m ? `${d} ${MONTHS[m - 1]} ${y}` : '—';
}

/** "2026-07-10" … "2026-07-16" → "10 Jul – 16 Jul 2026"; one day → "16 Jul 2026". */
export function customRangeLabel(from, to) {
  if (!from || !to) return 'Custom range';
  if (from === to) return formatIsoDate(from);
  const a = formatIsoDate(from);
  const b = formatIsoDate(to);
  // Same year → say it once, at the end.
  return from.slice(0, 4) === to.slice(0, 4) ? `${a.slice(0, -5)} – ${b}` : `${a} – ${b}`;
}

/** A custom range is usable once both ends are set and in order. */
export const customRangeValid = (from, to) => Boolean(from && to && from <= to);
