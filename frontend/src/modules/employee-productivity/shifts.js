// Shift resolution for the Activity Monitoring header.
//
// Shifts are an OPERATOR setting, not a viewer filter: they are configured in
// the use-case params (src/use-cases/<vertical>/index.js → 'employee-
// productivity'.shifts, defaults in ../use-cases/employee-productivity.params)
// and, once the roster API exists, come from store.shifts[]. A realtime page
// therefore does not ask which shift to look at — it works out which ones are
// running and says so.
//
// Times are IST 24h "HH:MM" strings, matching the rest of the module.

/** "16:30" → 990. Returns NaN for anything unparseable, which callers drop. */
export function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return NaN;
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

const DAY = 24 * 60;

// Length of a shift window, counting an end-before-start as crossing midnight.
function span(shift) {
  const a = toMinutes(shift.start);
  const b = toMinutes(shift.end);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return b > a ? b - a : DAY - a + b;
}

// Minutes from the shift's start to `now`, wrapping across midnight. Only
// meaningful for a shift that contains `now`.
function offsetInto(shift, now) {
  const a = toMinutes(shift.start);
  return now >= a ? now - a : DAY - a + now;
}

function contains(shift, now) {
  const a = toMinutes(shift.start);
  const b = toMinutes(shift.end);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return b > a ? now >= a && now < b : now >= a || now < b; // overnight-safe
}

// True when `outer` covers every minute of `inner` — i.e. `outer` is an
// umbrella like retail's "Full Day 10:00–22:00" over "Morning 10:00–16:00".
function coversFully(outer, inner, now) {
  return span(outer) > span(inner)
    && offsetInto(outer, now) >= offsetInto(inner, now)
    && span(outer) - offsetInto(outer, now) >= span(inner) - offsetInto(inner, now);
}

/**
 * Every shift running at `nowHHMM`, umbrella spans removed.
 *
 * A vertical usually defines one all-day window plus the narrower crews inside
 * it. Reporting "Full Day" while the Morning crew is on the floor is the less
 * useful of the two answers, so a window that entirely covers another running
 * one is dropped. Genuinely overlapping crews (an office's Early and Flexi)
 * both survive, because both really are on.
 *
 * @param {Array<{id:string,label:string,start:string,end:string}>} shifts
 * @param {string} nowHHMM
 * @returns {Array<{id:string,label:string,start:string,end:string}>}
 */
export function runningShifts(shifts, nowHHMM) {
  const now = toMinutes(nowHHMM);
  if (Number.isNaN(now) || !Array.isArray(shifts)) return [];

  const open = shifts.filter((s) => contains(s, now));
  const narrowed = open.filter((s) => !open.some((other) => coversFully(s, other, now)));
  return narrowed.length ? narrowed : open;
}

/** The single shift to name, or null when several (or none) are running. */
export function currentShift(shifts, nowHHMM) {
  const running = runningShifts(shifts, nowHHMM);
  return running.length === 1 ? running[0] : null;
}

/**
 * Header text: "Morning shift · 10:00–16:00", or an honest summary when the
 * config has several crews on at once, or a closed note when none is.
 */
export function shiftSummary(shifts, nowHHMM) {
  const running = runningShifts(shifts, nowHHMM);
  if (!running.length) return 'Outside shift hours';
  if (running.length === 1) {
    const [s] = running;
    return `${s.label} shift · ${s.start}–${s.end}`;
  }
  return `${running.length} shifts running · ${running.map((s) => s.label).join(', ')}`;
}
