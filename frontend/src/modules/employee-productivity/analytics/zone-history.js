import { ZONE_COVERAGE, ZONE_HOURS_LABELS, ZONE_INCIDENTS } from '../pages-data';
import { shiftIsoDate } from '../break-idle';
import { toMinutes } from '../shifts';

// Zone coverage history for Analytics › Zone Coverage & Trends.
//
// FRONTEND-ONLY. Today comes from the same ZONE_COVERAGE / ZONE_INCIDENTS the
// rest of the module reads; earlier days are generated deterministically from
// each zone's today profile, so a range always renders the same numbers.
// When the backend lands this file becomes one call:
//   GET /activity/zone-coverage?store&from&to → { days[], hours[], cells[][][] }
//   GET /activity/zone-incidents?store&from&to
// and everything below `zoneHistory` (matrix, shifts, incidents) is derived
// from it exactly as here.

// Trading hours, one column per hour (retail 10:00–22:00).
export const HISTORY_HOURS = Array.from({ length: 12 }, (_, i) => `${String(10 + i).padStart(2, '0')}:00`);

function hash(str) {
  let x = 0;
  for (const ch of str) x = (x * 31 + ch.charCodeAt(0)) & 0xffff;
  return x;
}

// One day's staffed % for a zone, hour by hour. null = not yet happened.
function dayCells(zone, iso, today, nowHHMM) {
  if (iso === today) {
    const nowMin = toMinutes(nowHHMM);
    return HISTORY_HOURS.map((h) => {
      const i = ZONE_HOURS_LABELS.indexOf(h);
      if (i >= 0) return zone.hours[i];
      return toMinutes(h) < nowMin ? 100 : null; // hour in progress reads as covered so far
    });
  }
  const base = zone.hours.reduce((s, v) => s + v, 0) / zone.hours.length;
  return HISTORY_HOURS.map((h) => {
    const n = hash(`${zone.zone}|${iso}|${h}`) % 100;
    // Mostly small wobble; now and then a real gap (lunch cover, a no-show).
    const dip = n < 8 ? 45 + (n * 5) : n < 22 ? 18 : 0;
    const v = Math.round(base + ((n % 13) - 4) - dip);
    return Math.max(0, Math.min(100, v));
  });
}

/** ISO dates from `from` to `to` inclusive, capped at 31 days. */
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 31; d = shiftIsoDate(d, 1)) out.push(d);
  return out;
}

/** "2026-07-15" → "15 Jul". */
export function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// The crews to report compliance for: every shift that does not simply span
// another one (retail's Full Day 10–22 is an umbrella over Morning + Evening).
function reportShifts(shifts = []) {
  const span = (s) => [toMinutes(s.start), toMinutes(s.end)];
  const leaves = shifts.filter((s) => {
    const [a, b] = span(s);
    return !shifts.some((o) => o !== s && span(o)[0] >= a && span(o)[1] <= b);
  });
  return leaves.length ? leaves : shifts;
}

/**
 * Everything the Zone Coverage & Trends tab draws, for one date range.
 *
 * @returns {{
 *   days: string[],
 *   matrix: Array<{ zone: string, kind: string, hours: Array<number|null> }>,
 *   shifts: Array<{ id: string, label: string, start: string, end: string }>,
 *   compliance: Array<{ day: string, [shiftLabel: string]: number|null }>,
 *   incidents: Array<{ id, date, zone, type, from, duration, active }>,
 * }}
 */
export function zoneHistory({ from, to, today, now, shifts: allShifts, targetPct }) {
  const days = daysBetween(from, to);
  const shifts = reportShifts(allShifts);

  // cells[zoneIndex][dayIndex][hourIndex]
  const cells = ZONE_COVERAGE.map((z) => days.map((iso) => dayCells(z, iso, today, now)));

  // Matrix: mean staffed % per zone-hour across the range (a single day is itself).
  const matrix = ZONE_COVERAGE.map((z, zi) => ({
    zone: z.zone,
    kind: z.kind,
    hours: HISTORY_HOURS.map((_, hi) => {
      const vals = cells[zi].map((d) => d[hi]).filter((v) => v != null);
      return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
    }),
  }));

  // Shift compliance: share of zone-hours in the shift at or above target.
  const compliance = days.map((iso, di) => {
    const row = { day: dayLabel(iso) };
    for (const s of shifts) {
      const [a, b] = [toMinutes(s.start), toMinutes(s.end)];
      const his = HISTORY_HOURS.map((h, i) => [toMinutes(h), i]).filter(([m]) => m >= a && m < b).map(([, i]) => i);
      const vals = cells.flatMap((zc) => his.map((hi) => zc[di][hi])).filter((v) => v != null);
      row[s.label] = vals.length ? Math.round((vals.filter((v) => v >= targetPct).length / vals.length) * 100) : null;
    }
    return row;
  });

  // Incidents: today's real log; earlier days get one per badly-staffed hour
  // (< 50%), so the log and the matrix tell the same story.
  const incidents = days.flatMap((iso, di) => {
    if (iso === today) return ZONE_INCIDENTS.map((i) => ({ ...i, date: iso }));
    return ZONE_COVERAGE.flatMap((z, zi) => cells[zi][di]
      .map((pct, hi) => ({ pct, hi }))
      .filter(({ pct }) => pct != null && pct < 50)
      .map(({ pct, hi }) => ({
        id: `${iso}-${zi}-${hi}`,
        date: iso,
        zone: z.zone,
        type: z.kind === 'counter' ? 'Counter unattended' : 'Low staff activity',
        from: `${HISTORY_HOURS[hi].slice(0, 3)}${String(hash(`${iso}${zi}${hi}`) % 50).padStart(2, '0')}`,
        duration: `${Math.round(((100 - pct) / 100) * 60)}m`,
        active: false,
      })));
  }).sort((a, b) => b.date.localeCompare(a.date) || b.from.localeCompare(a.from));

  return { days, matrix, shifts, compliance, incidents };
}
