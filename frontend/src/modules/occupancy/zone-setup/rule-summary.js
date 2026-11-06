/**
 * What a zone's rules currently say, in words.
 *
 * Its own module rather than a helper inside RuleSections.jsx. It was built
 * for two readers -- the collapsed accordion headers, and a summary line on
 * the drawer's trigger -- and the trigger line has since been cut for being
 * too long for a header button, so `summaries()` is down to one caller.
 * It stays here anyway: `parts()` below is the single description of what a
 * rule SAYS, and the next surface that needs to render a rule in words (a
 * zone list, an export, a diff against saved) should build on it rather than
 * writing a second set of sentences that can drift from these.
 *
 * Plain `.js` rather than a helper inside RuleSections.jsx: a non-component
 * export in a `.jsx` component file fails `react-refresh/only-export-components`,
 * and strings with no JSX in them have no business in a component file anyway.
 */
import { FULL_PCT } from '../occupancy-data';

/** A duration in minutes as an operator would say it: 90 -> `1h 30m`, 45 -> `45 min`. */
export const fmtDwell = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m} min`);

/**
 * The raw parts, per section. `staffing[1]` is null when no dwell ceiling is
 * in force -- the two readers want different things from that absence, so it
 * is left as absence here and answered by each of them below.
 */
function parts(draft, lockedOut) {
  const cap = Number(draft.maxCapacity) || 0;
  const access = draft.access || {};
  const people = access.people?.length || 0;
  const roles = access.roles?.length || 0;
  return {
    capacity: [
      lockedOut ? 'Locked out (0)' : cap > 0 ? `Max ${cap}` : 'No limit',
      draft.warnEnabled !== false && cap > 0 && !lockedOut ? `warn at ${Number(draft.warnPct) || FULL_PCT}%` : null,
    ],
    schedule: [
      draft.hours?.length === 2 ? `${draft.hours[0]}–${draft.hours[1]}` : null,
      draft.offHoursLock ? 'locked off-hours' : null,
    ],
    staffing: [
      Number(draft.minCapacity) > 0 ? `min ${draft.minCapacity} staff` : null,
      draft.dwellEnabled !== false && Number(draft.maxDwellMin) > 0 ? `dwell ${fmtDwell(Number(draft.maxDwellMin))}` : null,
    ],
    access: [
      access.mode === 'lockout' ? 'Strict lockout'
        : access.mode === 'restricted' ? `Restricted · ${roles} role${roles === 1 ? '' : 's'}, ${people} ${people === 1 ? 'person' : 'people'}`
          : 'Public',
    ],
  };
}

/**
 * One summary per section, for the closed accordion headers.
 *
 * A closed "Staffing & dwell" says "no dwell limit" rather than going blank:
 * inside a section header the question is "what does this hold", and "nothing"
 * is an answer worth printing.
 */
export function summaries(draft, lockedOut) {
  const p = parts(draft, lockedOut);
  return { ...p, staffing: [p.staffing[0], p.staffing[1] || 'no dwell limit'] };
}
