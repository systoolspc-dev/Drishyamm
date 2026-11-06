// Staff Quality & Performance — expected vs actual, for the Staff Performance
// page's Insights popover.
//
// Reads the SAME per-event derivation as the Breaks & Idle log and the staff
// profile (./break-idle.js): today from DAY_TIMELINES, earlier days from the
// deterministic mock history, each event checked against the vertical's
// limits. So an overstay counted here is a row in those logs, and the
// minor / critical split is their "Overstayed" / "Flagged":
//   minor    — past the limit, inside breaks.overstayGraceSec
//   critical — past limit + grace (the automatic alert fired)
//
// Metrics (all over the shift-days in range; days off are skipped):
//   Break adherence   tea + lunch breaks within their limit ÷ all breaks
//   Station coverage  on-post time ÷ time owed to the post, where breaks
//                     within limit are excused and idle + break overstay
//                     minutes count as the post left uncovered
//   Avg idle / event  mean length of one unplanned idle stretch
//   Punctuality       shifts clocked in inside the late grace ÷ all shifts
//
// Future backend: GET /activity/insights?store&from&to → the same shape.
// Plain .js so the popover keeps Fast Refresh.

import { useMemo } from 'react';
import { useActivityParams } from './useCaseStore';
import { useModuleData } from './useModuleData';
import { toMinutes } from './shifts';
import {
  formatIsoDate, mockDaySegments, policyLimits, retentionCutoff, shiftIsoDate, summarizeDay,
} from './break-idle';

export const INSIGHT_RANGES = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 Days' },
  { key: 'custom', label: 'Custom Range' },
];

/**
 * { key, from?, to? } → { from, to, dates (newest first), label }, clipped to
 * the plan's retention window and never past the dataset's today.
 */
export function resolveInsightRange(range, today, retentionDays = 30) {
  const cutoff = retentionCutoff(today, retentionDays);
  let from; let to;
  if (range.key === 'today') { from = today; to = today; }
  else if (range.key === 'yesterday') { from = shiftIsoDate(today, -1); to = from; }
  else if (range.key === '7d') { from = shiftIsoDate(today, -6); to = today; }
  else { from = range.from || today; to = range.to || today; }
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;
  if (from < cutoff) from = cutoff;

  const dates = [];
  for (let d = to; d >= from; d = shiftIsoDate(d, -1)) dates.push(d);
  const preset = INSIGHT_RANGES.find((r) => r.key === range.key && r.key !== 'custom');
  const label = preset ? preset.label : from === to ? formatIsoDate(from) : `${formatIsoDate(from)} – ${formatIsoDate(to)}`;
  return { from, to, dates, cutoff, label };
}

// ── benchmarks ──────────────────────────────────────────────────────────────
// `minorBand` = how far past the target still reads as a minor delta (yellow)
// rather than a severe violation (red). Idle's benchmark is the vertical's
// per-event idle limit; the rest are fixed service targets.
export function insightTargets(params = {}) {
  const idle = policyLimits(params).idleMin;
  return [
    { key: 'breakAdherence', label: 'Break Policy Adherence', unit: '%', target: 95, better: 'higher', minorBand: 10, max: 100 },
    { key: 'coverage', label: 'Station Coverage / Availability', unit: '%', target: 90, better: 'higher', minorBand: 5, max: 100 },
    { key: 'idleAvg', label: 'Avg. Idle Duration per Event', unit: 'min', target: idle, better: 'lower', minorBand: Math.max(1, Math.round(idle * 0.25)), max: null },
    { key: 'punctuality', label: 'Schedule / Shift Punctuality', unit: '%', target: 100, better: 'higher', minorBand: 10, max: 100 },
  ];
}

/** 'meets' | 'minor' | 'severe' for one metric's actual against its target. */
export function targetStatus(t, actual) {
  if (actual == null) return null;
  const gap = t.better === 'higher' ? t.target - actual : actual - t.target;
  if (gap <= 0) return 'meets';
  return gap <= t.minorBand ? 'minor' : 'severe';
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// ── derivation ──────────────────────────────────────────────────────────────

/** Every employee's shift-days in `dates`, as break/idle events + a clock-in. */
function collectDays({ EMPLOYEES, DAY_TIMELINES, NOW_IST, TODAY, params, limits, dates }) {
  const graceMin = Math.round((params.lateGraceSec ?? 900) / 60);
  const shiftOf = (emp) => (params.shifts || []).find((s) => s.label === emp.shift);
  const days = [];

  for (const emp of EMPLOYEES) {
    const shift = shiftOf(emp);
    const todaySegments = DAY_TIMELINES[emp.id] || [];
    const fallbackPost = ['Off-floor', '—'].includes(emp.zone) ? 'Floor' : emp.zone;
    for (const date of dates) {
      const isToday = date === TODAY;
      const segments = isToday
        ? todaySegments
        : mockDaySegments({ empId: emp.id, date, shift, todaySegments, fallbackPost });
      if (!segments.length) continue;                      // day off / not arrived
      const day = summarizeDay({ segments, date, now: isToday ? NOW_IST : undefined, limits });
      // Lateness follows the staff profile: today from the roster's lateBy,
      // earlier days from the first sighting against the shift start + grace.
      const lateMin = isToday
        ? parseInt(String(emp.lateBy || '').replace(/\D/g, ''), 10) || 0
        : shift ? Math.max(0, toMinutes(segments[0].s) - toMinutes(shift.start) - graceMin) : 0;
      days.push({ emp, date, day, lateMin });
    }
  }
  return days;
}

export function computeInsights(src) {
  const limits = policyLimits(src.params);
  const days = collectDays({ ...src, limits });
  const events = days.flatMap(({ emp, day }) => day.events.map((e) => ({ ...e, employeeId: emp.id, employeeName: emp.name })));

  const breaks = events.filter((e) => e.type !== 'idle');
  const idles = events.filter((e) => e.type === 'idle');

  // Coverage: excused = breaks within limit; uncovered = idle + break overstay.
  let onPost = 0; let owed = 0;
  for (const { day } of days) {
    const breakOver = day.events.filter((e) => e.type !== 'idle').reduce((s, e) => s + e.overMin, 0);
    onPost += day.activeMin;
    owed += day.activeMin + day.idleMin + breakOver;
  }

  const actual = {
    breakAdherence: pct(breaks.filter((e) => e.compliance === 'ok').length, breaks.length),
    coverage: pct(onPost, owed),
    idleAvg: idles.length ? Math.round((idles.reduce((s, e) => s + e.durationMin, 0) / idles.length) * 10) / 10 : null,
    punctuality: pct(days.filter((d) => !d.lateMin).length, days.length),
  };

  const breakdown = ['lunch', 'tea', 'idle'].map((type) => {
    const list = events.filter((e) => e.type === type);
    const limit = type === 'idle' ? limits.idleMin : type === 'lunch' ? limits.lunchMin : limits.teaMin;
    return {
      type,
      limit,
      count: list.length,
      totalMin: list.reduce((s, e) => s + e.durationMin, 0),
      avgMin: list.length ? Math.round(list.reduce((s, e) => s + e.durationMin, 0) / list.length) : 0,
      minor: list.filter((e) => e.compliance === 'over').length,
      critical: list.filter((e) => e.compliance === 'flagged').length,
    };
  });

  const over = events.filter((e) => e.compliance !== 'ok');
  // Worst offenders by total overstay minutes — the callout's "who to talk to".
  const byEmp = new Map();
  for (const e of over) {
    const p = byEmp.get(e.employeeId) || { id: e.employeeId, name: e.employeeName, overMin: 0, critical: 0, minor: 0 };
    p.overMin += e.overMin;
    p[e.compliance === 'flagged' ? 'critical' : 'minor'] += 1;
    byEmp.set(e.employeeId, p);
  }
  const lateDays = days.filter((d) => d.lateMin > 0);

  // Flagged = any overstay or late clock-in in range: what the table narrows to.
  const flaggedIds = [...new Set([...byEmp.keys(), ...lateDays.map((d) => d.emp.id)])];

  return {
    limits,
    actual,
    breakdown,
    overstays: {
      critical: over.filter((e) => e.compliance === 'flagged').length,
      minor: over.filter((e) => e.compliance === 'over').length,
      overMin: over.reduce((s, e) => s + e.overMin, 0),
      late: lateDays.length,
      top: [...byEmp.values()].sort((a, b) => b.critical - a.critical || b.overMin - a.overMin).slice(0, 3),
    },
    flaggedIds,
    shiftDays: days.length,
    staff: new Set(days.map((d) => d.emp.id)).size,
    eventCount: events.length,
  };
}

/** Insights for a resolved range, from the active vertical's data and policy. */
export function useStaffInsights(dates) {
  const { EMPLOYEES, DAY_TIMELINES, NOW_IST, TODAY } = useModuleData();
  const { params } = useActivityParams();
  return useMemo(
    () => computeInsights({ EMPLOYEES, DAY_TIMELINES, NOW_IST, TODAY, params, dates }),
    [EMPLOYEES, DAY_TIMELINES, NOW_IST, TODAY, params, dates],
  );
}
