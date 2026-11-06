// ─────────────────────────────────────────────────────────────────────────────
// Peak Occupancy — the time windows and utilization bands behind the drill-in.
//
// The modal asks one question: in THIS window, when was the floor busiest and
// which zones carried it. These helpers turn the Time Window choice into a
// bucket range over the hour buckets the page already uses, and grade a zone's
// utilization. Pure (no React, no '@/' imports) so `npm test` can check it.
// ─────────────────────────────────────────────────────────────────────────────

import { runningShifts, toMinutes } from '../shifts.js';

// ── Utilization bands ────────────────────────────────────────────────────────
//   below 80%              Normal
//   80% up to the limit    Nearing Limit   (the limit itself is still "at", not over)
//   above the limit        Capacity Exceeded
// `limit` is the vertical's breachPct — 100 unless configured otherwise.
export const NEARING_PCT = 80;

export function utilizationLevel(pct, limit = 100) {
  if (pct > limit) return { id: 'exceeded', label: 'Capacity Exceeded' };
  if (pct >= NEARING_PCT) return { id: 'nearing', label: 'Nearing Limit' };
  return { id: 'normal', label: 'Normal' };
}

// ── Buckets ──────────────────────────────────────────────────────────────────
// Buckets are "HH:00" labels (see buildBuckets). A bucket's span runs to the
// next label; the last one runs one step past itself.
function stepMinutes(buckets) {
  if (buckets.length < 2) return 60;
  // Modulo a day, so a round-the-clock vertical's 22:00 → 00:00 is 120, not −1320.
  const d = (toMinutes(buckets[1]) - toMinutes(buckets[0]) + 1440) % 1440;
  return d || 60;
}

const hhmm = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** "15:00" for the bucket starting "14:00". */
export function bucketEnd(buckets, i) {
  if (i + 1 < buckets.length) return buckets[i + 1];
  return hhmm(toMinutes(buckets[i]) + stepMinutes(buckets));
}

/** Inclusive bucket range whose starts fall in [start, end), or null. */
export function bucketRange(buckets, start, end) {
  const s = toMinutes(start);
  let e = toMinutes(end);
  if (e <= s) e += 1440; // overnight
  const idx = buckets
    .map((b, i) => ({ i, m: toMinutes(b) < s ? toMinutes(b) + 1440 : toMinutes(b) }))
    .filter(({ m }) => m >= s && m < e)
    .map(({ i }) => i);
  return idx.length ? { from: idx[0], to: idx[idx.length - 1] } : null;
}

/**
 * The shift on at `nowHHMM`: the only one running, or — when rosters overlap
 * (Full Day + Early + Late) — the one that started most recently, which is the
 * crew that just came on. Null outside every shift.
 */
export function shiftAt(shifts, nowHHMM) {
  const running = runningShifts(shifts, nowHHMM);
  if (!running.length) return null;
  return running.slice().sort((a, b) => toMinutes(b.start) - toMinutes(a.start))[0];
}

// ── Time windows ─────────────────────────────────────────────────────────────
export const TIME_WINDOWS = ['today', 'yesterday', 'shift', 'peak', 'custom'];

/**
 * The bucket window for a Time Window choice, or null for "the whole day".
 * @param {string} id  one of TIME_WINDOWS
 * @param {{ buckets: string[], shift?: {start:string,end:string}|null,
 *           peakIdx?: number, custom?: {from:number,to:number} }} o
 */
export function windowFor(id, { buckets, shift = null, peakIdx = 0, custom = null }) {
  const last = buckets.length - 1;
  if (id === 'shift') return shift ? bucketRange(buckets, shift.start, shift.end) : null;
  if (id === 'peak') return { from: peakIdx, to: peakIdx };
  if (id === 'custom' && custom) {
    const from = Math.max(0, Math.min(custom.from, last));
    return { from, to: Math.max(from, Math.min(custom.to, last)) };
  }
  return null;
}
