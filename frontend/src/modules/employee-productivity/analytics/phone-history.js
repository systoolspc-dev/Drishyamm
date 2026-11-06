import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useModuleData } from '../useModuleData';
import { useActivityParams } from '../useCaseStore';
import { shiftIsoDate } from '../break-idle';
import { dayLabel } from './zone-history';

// Phone usage history for Analytics › Phone Usage, over a date range.
//
// FRONTEND-ONLY. Days that PHONE_EVENTS covers (today, yesterday) use those
// detections as-is; every other day is generated deterministically from each
// person's weekly rate (PHONE_WEEKLY), so a range always renders the same
// numbers. When the backend lands this becomes one call:
//   GET /activity/phone-events?store&from&to
// and everything below `phoneHistory` (per-person totals, trend buckets, the
// export rows) is derived from it exactly as here.
//
// The range lives in the URL (?startDate=&endDate=) so a copied link, a
// reload or the back button keep it. No params = the default, Last 7 days.

export const PHONE_PRESETS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
];
export const DEFAULT_PRESET = '7d';
/** Longest range a custom pick may span. */
export const MAX_RANGE_DAYS = 366;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (s) => !!s && ISO.test(s) && shiftIsoDate(s, 0) === s;

/** Whole days from `a` to `b` (b ≥ a gives ≥ 0). */
export function dayDiff(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function presetRange(key, today) {
  const p = PHONE_PRESETS.find((x) => x.key === key) || PHONE_PRESETS.find((x) => x.key === DEFAULT_PRESET);
  return { from: shiftIsoDate(today, -(p.days - 1)), to: today };
}

/**
 * The page's date range, read from and written to the URL. Bad or missing
 * params fall back to the default; the end is clamped to today, a reversed
 * pair is swapped, and a span past MAX_RANGE_DAYS keeps its end date.
 */
export function usePhoneRange() {
  const { TODAY } = useModuleData();
  const [search, setSearch] = useSearchParams();
  const rawFrom = search.get('startDate');
  const rawTo = search.get('endDate');

  const range = useMemo(() => {
    if (!validIso(rawFrom) || !validIso(rawTo)) return presetRange(DEFAULT_PRESET, TODAY);
    let [from, to] = rawFrom <= rawTo ? [rawFrom, rawTo] : [rawTo, rawFrom];
    if (to > TODAY) to = TODAY;
    if (from > to) from = to;
    if (dayDiff(from, to) >= MAX_RANGE_DAYS) from = shiftIsoDate(to, -(MAX_RANGE_DAYS - 1));
    return { from, to };
  }, [rawFrom, rawTo, TODAY]);

  const preset = PHONE_PRESETS.find((p) => {
    const r = presetRange(p.key, TODAY);
    return r.from === range.from && r.to === range.to;
  })?.key || 'custom';

  const setRange = useCallback(({ from, to }) => {
    const next = new URLSearchParams(search);
    next.set('startDate', from);
    next.set('endDate', to);
    setSearch(next, { replace: true });
  }, [search, setSearch]);

  return { ...range, preset, today: TODAY, setRange };
}

/** "15 Jul – 21 Jul 2026 (7 days)" / "16 Jul 2026". */
export function rangeLabel(from, to) {
  const year = to.slice(0, 4);
  const n = dayDiff(from, to) + 1;
  if (n === 1) return `${dayLabel(from)} ${year}`;
  const head = from.slice(0, 4) === year ? dayLabel(from) : `${dayLabel(from)} ${from.slice(0, 4)}`;
  return `${head} – ${dayLabel(to)} ${year} (${n} days)`;
}

// ── generation ──────────────────────────────────────────────────────────────

function hash(str) {
  let x = 2166136261;
  for (const ch of str) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return x >>> 0;
}

const pad = (n) => String(n).padStart(2, '0');

// One generated day of detections for everyone on the roster.
function syntheticDay(iso, people, locationsByName, fallbackLocs) {
  const out = [];
  for (const p of people) {
    const rate = p.total / 7;
    // floor(rate + U[0,1)) averages exactly `rate` per day.
    const k = Math.floor(rate + (hash(`${p.name}|${iso}`) % 1000) / 1000);
    const locs = locationsByName.get(p.name) || fallbackLocs;
    for (let i = 0; i < k; i += 1) {
      const h = hash(`${p.name}|${iso}|${i}`);
      const loc = locs[h % locs.length];
      const hh = 10 + (h % 12);
      const mm = (h >>> 4) % 60;
      const ss = (h >>> 10) % 60;
      out.push({
        id: `g-${iso}-${p.name}-${i}`,
        date: iso,
        ts: `${pad(hh)}:${pad(mm)}:${pad(ss)}`,
        employee: p.name,
        camera: loc.camera,
        zone: loc.zone,
        location: loc.location,
        area: loc.area,
        holdSec: 8 + ((h >>> 16) % 110),
        confidence: 0.84 + ((h >>> 20) % 14) / 100,
      });
    }
  }
  return out;
}

/** Every detection from `from` to `to` inclusive, oldest first. */
export function phoneEvents({ from, to, events, weekly }) {
  const realDates = new Set(events.map((e) => e.date));
  const locationsByName = new Map();
  for (const e of events) {
    const list = locationsByName.get(e.employee) || [];
    if (!list.some((l) => l.location === e.location)) list.push(e);
    locationsByName.set(e.employee, list);
  }
  const fallbackLocs = events.length ? events : [{ camera: '—', zone: '—', location: 'Unknown', area: 'floor' }];

  const out = [];
  for (let d = from; d <= to; d = shiftIsoDate(d, 1)) {
    if (realDates.has(d)) out.push(...events.filter((e) => e.date === d).sort((a, b) => a.ts.localeCompare(b.ts)));
    else out.push(...syntheticDay(d, weekly, locationsByName, fallbackLocs).sort((a, b) => a.ts.localeCompare(b.ts)));
  }
  return out;
}

// ── aggregation ─────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

/**
 * The trend chart's grain follows the span: hours for one day, days up to a
 * month, weeks up to six months, months beyond.
 */
export function trendGrain(days) {
  if (days <= 1) return 'hour';
  if (days <= 31) return 'day';
  if (days <= 186) return 'week';
  return 'month';
}

const GRAIN_TEXT = { hour: 'per hour', day: 'per day', week: 'per week', month: 'per month' };

function trendBuckets(list, from, to, grain) {
  if (grain === 'hour') {
    const hours = Array.from({ length: 12 }, (_, i) => ({ d: `${pad(10 + i)}:00`, n: 0 }));
    for (const e of list) {
      const i = Number(e.ts.slice(0, 2)) - 10;
      hours[Math.max(0, Math.min(11, i))].n += 1;
    }
    return hours;
  }

  const buckets = [];
  const index = new Map();
  const keyOf = (iso) => {
    if (grain === 'day') return iso;
    if (grain === 'month') return iso.slice(0, 7);
    // Weeks are 7-day blocks counted from `from`, so the first and last
    // buckets are never partial at the start.
    return shiftIsoDate(from, Math.floor(dayDiff(from, iso) / 7) * 7);
  };
  const labelOf = (key) => {
    if (grain === 'day') return dayDiff(from, to) < 7 ? `${weekday(key)} ${Number(key.slice(8))}` : dayLabel(key);
    if (grain === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
    return dayLabel(key);
  };
  for (let d = from; d <= to; d = shiftIsoDate(d, 1)) {
    const key = keyOf(d);
    if (!index.has(key)) {
      index.set(key, buckets.length);
      const end = grain === 'week' ? [shiftIsoDate(key, 6), to].sort()[0] : null;
      buckets.push({ key, d: labelOf(key), n: 0, range: end ? `${dayLabel(key)} – ${dayLabel(end)}` : null });
    }
  }
  for (const e of list) buckets[index.get(keyOf(e.date))].n += 1;
  return buckets;
}

/**
 * Everything Analytics › Phone Usage draws for one range: per-person totals
 * (with the direction against the previous period of the same length), the
 * trend series at a grain that fits the span, and the detection rows.
 */
export function phoneHistory({ from, to, events, weekly, violationSec = 30 }) {
  const days = dayDiff(from, to) + 1;
  const list = phoneEvents({ from, to, events, weekly })
    .map((e) => ({ ...e, severity: e.holdSec > violationSec ? 'violation' : 'brief' }));
  const prev = phoneEvents({ from: shiftIsoDate(from, -days), to: shiftIsoDate(from, -1), events, weekly });

  const count = (arr) => arr.reduce((m, e) => m.set(e.employee, (m.get(e.employee) || 0) + 1), new Map());
  const now = count(list);
  const before = count(prev);
  const byEmployee = [...new Set([...weekly.map((p) => p.name), ...now.keys()])]
    .map((name) => {
      const total = now.get(name) || 0;
      const prior = before.get(name) || 0;
      const flagged = list.filter((e) => e.employee === name && e.severity === 'violation').length;
      return { name, total, prior, flagged, trend: total > prior ? 'up' : total < prior ? 'down' : 'flat' };
    })
    .filter((p) => p.total > 0 || p.prior > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const grain = trendGrain(days);
  return {
    days,
    grain,
    grainText: GRAIN_TEXT[grain],
    total: list.length,
    flagged: list.filter((e) => e.severity === 'violation').length,
    priorTotal: prev.length,
    byEmployee,
    trend: trendBuckets(list, from, to, grain),
    rows: list,
  };
}

/** The range from the URL plus the history for it, for the active vertical. */
export function usePhoneHistory() {
  const range = usePhoneRange();
  const { PHONE_EVENTS, PHONE_WEEKLY } = useModuleData();
  const { params } = useActivityParams();
  const violationSec = params.phone?.violationSec ?? 30;
  const data = useMemo(
    () => phoneHistory({ from: range.from, to: range.to, events: PHONE_EVENTS, weekly: PHONE_WEEKLY, violationSec }),
    [range.from, range.to, PHONE_EVENTS, PHONE_WEEKLY, violationSec],
  );
  return { range, data, violationSec };
}
