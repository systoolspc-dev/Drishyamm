// Scorecard rules shared by the Reports table, its quick-view dialog and the
// exports. Kept out of the .jsx files so they export only components (Fast
// Refresh) and so the table, the dialog and the PDF can't disagree on a band.

export const COACHING_BELOW = 75;
export const BREAK_WARN_MIN = 90;   // break time above this is flagged in the table
export const COUNTER_WARN_MIN = 10; // unattended-counter minutes that read as a problem

export function scoreCls(s) {
  if (s >= 90) return 'text-success-ink';
  if (s >= COACHING_BELOW) return 'text-warning-ink';
  return 'text-danger-ink';
}

export function scoreBar(s) {
  if (s >= 90) return 'bg-success';
  if (s >= COACHING_BELOW) return 'bg-warning';
  return 'bg-danger';
}

export function scoreBand(s) {
  if (s >= 90) return 'Strong';
  if (s >= COACHING_BELOW) return 'On track';
  return 'Needs coaching';
}

export const initials = (name) => name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();

// Deterministic hue per name — the same person gets the same colour on the
// dashboard's Employee Status list, the scorecard and its quick view.
export function nameHue(name = '') {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// Solid initials avatar: pair with `text-white`.
export const avatarStyle = (name) => ({ background: `hsl(${nameHue(name)} 45% 50%)` });

// Tinted chip keyed on the same hue (roles, teams). The style feeds the hue;
// ROLE_CHIP turns it into a soft fill + readable ink in both themes.
export const hueStyle = (key) => ({ '--hue': nameHue(key) });
export const ROLE_CHIP =
  'border-[hsl(var(--hue)_55%_50%/0.3)] bg-[hsl(var(--hue)_70%_50%/0.1)] text-[hsl(var(--hue)_55%_35%)] ' +
  'dark:bg-[hsl(var(--hue)_60%_55%/0.16)] dark:text-[hsl(var(--hue)_70%_75%)]';

// Plain-language reasons a row lost points, in the order a coach would raise them.
export function coachingFlags(r) {
  return [
    r.onTime < 80 && `Punctuality — on time ${r.onTime}% of days`,
    r.breakMin > BREAK_WARN_MIN && `Break overrun — ${r.breakMin}m against a ${BREAK_WARN_MIN}m guideline`,
    r.phone >= 3 && `Phone usage — ${r.phone} flagged incidents`,
    (r.impact?.counterMin ?? 0) >= COUNTER_WARN_MIN && `Counter left unattended — ${r.impact.counterMin}m`,
    (r.impact?.queueBreaches ?? 0) >= 3 && `Queue build-up on their till — ${r.impact.queueBreaches} breaches`,
  ].filter(Boolean);
}

// Expected vs. actual — the Quick Insights chart. Each measure carries its store
// benchmark and a tone rule: 'good' meets it, 'warn' is a minor deviation,
// 'bad' needs coaching / breaches policy. `max` sets the shared bar scale, so a
// zero benchmark still has a track to draw against. `rule` spells out the
// threshold behind "expected", read from the vertical's configured params, so
// the dialog says what the number was measured against.
export const SCORE_BENCHMARK = 85;
const BREAK_MINOR_MIN = Math.round(BREAK_WARN_MIN * 1.2); // up to 20% over the guideline reads as minor

const secToMin = (sec, fallback) => Math.round((sec ?? fallback) / 60);

export function insightMetrics(r, showImpact, params = {}) {
  const counter = r.impact?.counterMin ?? 0;
  const lateGrace = secToMin(params.lateGraceSec, 900);
  const tea = secToMin(params.breaks?.teaMaxSec, 900);
  const lunch = secToMin(params.breaks?.lunchMaxSec, 2700);
  const overstay = secToMin(params.breaks?.overstayGraceSec, 300);
  const phone = params.phone || {};
  return [
    {
      id: 'onTime', label: 'On-time punctuality', unit: '%', expected: 100, expectedText: '100%', actual: r.onTime, max: 100,
      tone: r.onTime >= 90 ? 'good' : r.onTime >= 75 ? 'warn' : 'bad',
      rule: `On time = clock-in within ${lateGrace} min of shift start · below 75% needs coaching`,
    },
    {
      id: 'break', label: 'Break duration', unit: ' mins', expected: BREAK_WARN_MIN, expectedText: `≤ ${BREAK_WARN_MIN} mins`, actual: r.breakMin,
      max: Math.max(BREAK_WARN_MIN * 2, r.breakMin),
      tone: r.breakMin <= BREAK_WARN_MIN ? 'good' : r.breakMin <= BREAK_MINOR_MIN ? 'warn' : 'bad',
      rule: `${BREAK_WARN_MIN} mins/day guideline · per break: tea ${tea}m, lunch ${lunch}m, +${overstay}m grace`,
    },
    {
      id: 'phone', label: 'Phone incidents', unit: '', expected: 0, expectedText: '0', actual: r.phone, max: Math.max(10, r.phone),
      tone: r.phone === 0 ? 'good' : r.phone < 3 ? 'warn' : 'bad',
      rule: `Incident = phone use over ${phone.violationSec ?? 30}s at a stretch · supervisor alerted after ${phone.escalateAfter ?? 3} per shift`,
    },
    showImpact && {
      id: 'counter', label: 'Counter / floor health impact', unit: ' mins', expected: 0, expectedText: '0 mins', actual: counter,
      max: Math.max(COUNTER_WARN_MIN * 2, counter),
      tone: counter === 0 ? 'good' : counter < COUNTER_WARN_MIN ? 'warn' : 'bad',
      rule: `Unattended counter time · ${COUNTER_WARN_MIN}+ mins needs coaching`,
    },
    {
      id: 'score', label: 'Overall staff quality score', unit: '', expected: SCORE_BENCHMARK, expectedText: `≥ ${SCORE_BENCHMARK}`, actual: r.score, max: 100,
      tone: r.score >= SCORE_BENCHMARK ? 'good' : r.score >= COACHING_BELOW ? 'warn' : 'bad',
      rule: `Benchmark ${SCORE_BENCHMARK} · below ${COACHING_BELOW} needs coaching`,
    },
  ].filter(Boolean);
}

// Team average as a pseudo-row, for the header's team-wide insights.
export function teamAverageRow(rows) {
  const avg = (pick) => Math.round(rows.reduce((s, r) => s + (pick(r) ?? 0), 0) / Math.max(rows.length, 1));
  return {
    id: 'team', name: 'Team average', team: true, count: rows.length,
    onTime: avg((r) => r.onTime), breakMin: avg((r) => r.breakMin), phone: avg((r) => r.phone),
    impact: { counterMin: avg((r) => r.impact?.counterMin) }, score: avg((r) => r.score),
  };
}
