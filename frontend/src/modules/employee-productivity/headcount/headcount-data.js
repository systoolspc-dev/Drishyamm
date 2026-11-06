// Zone Headcount — data layer.
//
// FRONTEND-ONLY, like the rest of Activity Monitoring. The zone *config* is real
// (it lives in each preset's params.headcount); the live *counts* below are mock,
// derived deterministically from the zone id so the numbers hold still across
// re-renders instead of jittering on every keystroke.
//
// Future backend — thin aggregations over the existing footfall counter
// (aiService.footfall*, /api/ai/footfall/*) plus a camera→zone map, NOT a new
// pipeline:
//   GET  /headcount/zones?site&area&type          → live count per zone
//   GET  /headcount/timeseries?zone&range         → occupancy over time
//   GET  /headcount/flow?zone&range               → line-crossing in/out
//   GET  /headcount/heatmap?range                 → zone × hour utilization
//   GET  /headcount/reconcile?zone                → { count, identified, delta }
//   GET  /headcount/breaches?range                → threshold violations
//   GET  /headcount/peak?site&area&type&date&bucket&basis
//                                                 → when + where the peak happened
//
// STORAGE NOTE for whoever builds /headcount/peak. The rollup table must carry
// max_count, not just avg_count:
//   occupancy_bucket(zone_id, bucket_start, granularity, avg_count, max_count,
//                    capacity_snapshot)
// An hourly average can never be un-averaged back into a peak — a room that hit
// 120% for eleven minutes reads as a calm 70% for the hour. Roll 1-minute rows up
// with MAX(max_count), and keep capacity_snapshot per bucket so a capacity change
// last March does not rewrite last March's utilization.
//
// Fast Refresh: this is a .js module on purpose — constants and helpers must not
// live beside components in a .jsx file.

import { ZONE_KINDS } from '@/use-cases/headcount.params';

// ── deterministic pseudo-random ────────────────────────────────────────────
// Same zone id → same numbers, every render. Replaced wholesale by the API.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// The seed identifies the DATA WINDOW, never the control used to pick it.
// 'today' and 'date' are the same window — one calendar day anchored at
// scope.date — reached by two different widgets, so they must key identically.
// Keying them apart made "Today" and a date picker pointed at today report
// different peaks for the same day. 'live' (an instant) and '24h' (rolling) are
// genuinely different windows and keep their own keys.
function scopeKey(scope = {}) {
  const range = scope.range === 'today' ? 'date' : scope.range || 'date';
  // Branch is part of the window too — two stores never report the same day.
  const site = scope.site ? `${scope.site}-` : '';
  // A custom range is anchored at both ends; `date` is its last day.
  const from = scope.from ? `${scope.from}~` : '';
  return `${site}${range}-${from}${scope.date || 'today'}-${scope.granularity || 'hour'}`;
}

function parseIsoDate(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function shortDate(date) {
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(date);
}

// ── status ─────────────────────────────────────────────────────────────────
// One derivation, consumed by the tiles, the heatmap and the breach table so a
// zone can never read "Normal" in one widget and "Over" in another.
export const STATUS_CHIP = {
  ok: 'bg-success-soft text-success-ink ring-success-line',
  busy: 'bg-warning-soft text-warning-ink ring-warning-line',
  over: 'bg-danger-soft text-danger-ink ring-danger-line',
  under: 'bg-danger-soft text-danger-ink ring-danger-line',
  empty: 'bg-neutral-soft text-neutral-ink ring-neutral-line',
  flow: 'bg-neutral-soft text-neutral-ink ring-neutral-line',
};

export const STATUS_LABEL = {
  ok: 'Normal',
  busy: 'Nearing limit',
  over: 'Over capacity',
  under: 'Below minimum',
  empty: 'Empty',
  flow: 'Counting',
};

// Bar/fill colour per status. Kept as hex (not a Tailwind class) because recharts
// and inline widths need the raw value.
export const STATUS_HEX = {
  ok: '#059669',
  busy: '#d97706',
  over: 'var(--danger)',
  under: 'var(--danger)',
  empty: 'var(--neutral)',
  flow: 'var(--neutral)',
};

// The three buckets the status filter offers. `under` is a breach like `over`
// (the threshold is a floor instead of a ceiling), so it files under Exceeded.
export const STATUS_GROUP = {
  ok: 'normal', empty: 'normal', flow: 'normal',
  busy: 'warning',
  over: 'exceeded', under: 'exceeded',
};

// Triage order for the live table: worst first.
export const STATUS_RANK = { over: 0, under: 1, busy: 2, ok: 3, empty: 4, flow: 5 };

// "4m 12s" / "1h 05m". Null-safe for line zones, which have no dwell.
export function formatDwell(sec) {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ── zone types ─────────────────────────────────────────────────────────────
// A vertical's type catalog (params.headcount.zoneTypes), or — for verticals that
// never configured one — every behavioural kind doubling as its own type. Either
// way each entry carries a `kind`, and only the kind is read by the metrics.
export function resolveZoneTypes(cfg) {
  if (cfg?.zoneTypes?.length) return cfg.zoneTypes;
  return Object.entries(ZONE_KINDS).map(([id, label]) => ({ id, label, kind: id }));
}

// Typical stay per kind, seconds — mock baseline for the dwell column.
const DWELL_BASE_SEC = {
  gate: 30, lobby: 240, queue: 210, corridor: 60, service: 540, display: 330,
  secure: 900, work: 3000, office: 3600, meeting: 2700, dining: 1500,
  hall: 3000, classroom: 3000, lab: 3600, library: 2400, sports: 2400,
  leisure: 1800, lounge: 1500,
};

// Posts a zone expects staffed, per kind — mock baseline for the Staff on post
// column. 0 = an unstaffed space (stockroom, meeting room): no post to cover.
// Backend: zone.staff_required from the roster, zone.staff_on_post from the
// same staff-detection feed Zone Coverage reads.
const STAFF_REQUIRED = {
  queue: 1, display: 1, service: 1, work: 2, lobby: 1, dining: 1,
  hall: 1, classroom: 1, lab: 1, library: 1, sports: 1,
};

export function zoneStatus(zone, breachPct = 100) {
  if (zone.mode === 'line') return 'flow';
  // A zone below its floor is a breach even when it looks nearly empty — this is
  // the bank vault / lone-supervisor case, and only a headcount can assert it.
  if (zone.minOccupancy && zone.count > 0 && zone.count < zone.minOccupancy) return 'under';
  if (zone.count === 0) return 'empty';
  if (zone.utilization >= breachPct) return 'over';
  if (zone.utilization >= 75) return 'busy';
  return 'ok';
}

// ── zones ──────────────────────────────────────────────────────────────────
// Attach mock live figures to the configured zones. `identified` is what the face
// pipeline recognised in the same window; count − identified is the reconciliation
// delta, the one number an identity system can never produce on its own.
//
// Every zone also gets `kind` + `typeLabel` resolved from the vertical's type
// catalog. Everything behavioural below keys on `kind`, never on `type`, which
// is what lets a vertical rename or add types without touching this file.
export function buildZones(cfg, scope) {
  const zones = cfg.zones || [];
  const key = scopeKey(scope);
  const types = new Map(resolveZoneTypes(cfg).map((t) => [t.id, t]));
  return zones.map((raw) => {
    const t = types.get(raw.type);
    const z = { ...raw, kind: t?.kind || raw.type, typeLabel: t?.label || raw.type };
    const rnd = seeded(hash(`${z.id}-${z.label}-${key}`));
    if (z.mode === 'line') {
      const inCount = 40 + Math.round(rnd() * 1200);
      const outCount = Math.round(inCount * (0.55 + rnd() * 0.5));
      return { ...z, in: inCount, out: outCount, inside: Math.max(0, inCount - outCount), avgDwellSec: null, maxDwellSec: null, status: 'flow' };
    }
    const cap = z.capacity || 1;
    // Deliberately allow >100% — over-capacity is the state operators care about.
    const count = Math.round(cap * (0.12 + rnd() * 1.02));
    // Anonymous crowds (retail, hotel) recognise poorly; staff areas recognise well.
    const recognisable = z.kind === 'secure' || z.kind === 'office' || z.kind === 'meeting' ? 0.98 : 0.55 + rnd() * 0.42;
    const identified = Math.min(count, Math.round(count * recognisable));
    const utilization = Math.round((count / cap) * 100);
    // Mean time a person currently inside has been there (P3). Drawn last so the
    // counts above keep their existing seeds. Backend: zone.avg_dwell_sec.
    const avgDwellSec = count ? Math.round((DWELL_BASE_SEC[z.kind] || 600) * (0.5 + rnd())) : null;
    // Longest current stay — the one person who has been here the longest.
    // Backend: zone.max_dwell_sec. Drawn after the average to keep its seed.
    const maxDwellSec = avgDwellSec == null ? null : Math.round(avgDwellSec * (1.3 + rnd() * 1.2));
    // Staff on post, drawn after dwell to keep every earlier seed.
    const staffRequired = STAFF_REQUIRED[z.kind] || 0;
    const roll = rnd();
    const staffOnPost = !staffRequired ? 0 : roll < 0.18 ? 0 : roll < 0.34 ? staffRequired - 1 : staffRequired;
    const zone = { ...z, count, identified, utilization, avgDwellSec, maxDwellSec, delta: count - identified, staffRequired, staffOnPost };
    return { ...zone, status: zoneStatus(zone, cfg.breachPct) };
  });
}

// ── hour buckets ───────────────────────────────────────────────────────────
// Derived from the vertical's own businessHours so a school reads 07:00–18:00 and
// a hotel reads round the clock.
export function buildBuckets(businessHours = '09:00-18:00', scope = {}) {
  const anchor = parseIsoDate(scope.date);
  if (scope.granularity === 'day') {
    const days = scope.range === '30d' ? 30 : scope.range === '7d' ? 7 : 1;
    return Array.from({ length: days }, (_, i) => shortDate(addDays(anchor, i - days + 1)));
  }
  if (scope.granularity === 'week') {
    const span = scope.range === '30d' ? 30 : scope.range === '7d' ? 14 : 28;
    const weeks = Math.ceil(span / 7);
    // The earliest bucket is clamped to the range's own first day, so it renders
    // as the partial week it actually is. Five clean 7-day buckets would quietly
    // report 35 days of data under a "Last 30 days" heading.
    const first = addDays(anchor, -(span - 1));
    return Array.from({ length: weeks }, (_, i) => {
      const end = addDays(anchor, (i - weeks + 1) * 7);
      const rawStart = addDays(end, -6);
      const start = rawStart < first ? first : rawStart;
      return `${shortDate(start)}-${shortDate(end)}`;
    });
  }
  const [from, to] = String(businessHours).split('-');
  const start = parseInt(from, 10) || 9;
  let end = parseInt(to, 10) || 18;
  if (end <= start) end = start + 12;      // 00:00-24:00 and overnight windows
  const span = Math.min(12, Math.max(6, end - start));
  const step = Math.max(1, Math.round((end - start) / span));
  const out = [];
  for (let i = 0; i < span; i += 1) {
    out.push(`${String((start + i * step) % 24).padStart(2, '0')}:00`);
  }
  return out;
}

// Bell-shaped day curve peaking just past midday, scaled to `peak`.
function curve(seed, peak, n) {
  const rnd = seeded(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i - n * 0.52) / (n * 0.3);
    out.push(Math.max(0, Math.round(peak * Math.exp(-0.5 * t * t) * (0.8 + rnd() * 0.34))));
  }
  return out;
}

// ── the occupancy matrix ───────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH. One number per (zone, bucket) — everything below is a
// projection of it:
//   sum the columns  → site timeline
//   read it straight → heatmap
//   argmax it        → peak (when + where)
//
// Before this existed each widget rolled its own curve from its own seed, so the
// timeline's busiest hour and the heatmap's darkest cell were unrelated numbers
// and "where was the peak" had no answer. Any future widget that needs occupancy
// over time reads this — it must never generate its own series.
//
// Backend swap: one call, `GET /headcount/timeseries?zone=*&range=…` returning
// rows of (zone_id, bucket, max_count). Same shape, real numbers.
export function buildMatrix(zones, buckets, scope) {
  const key = scopeKey(scope);
  const nowIdx = Math.floor(buckets.length * 0.6);
  const rows = zones
    .filter((z) => z.mode === 'region')
    .map((z) => {
      const capacity = z.capacity || 1;
      const series = curve(hash(`${z.id}-occ-${key}`), Math.round(z.count * 1.3), buckets.length);
      series[nowIdx] = z.count;    // anchor "now" to the live figure on the tiles,
      return {                      // so Σ column[nowIdx] === the Live headcount KPI
        id: z.id, label: z.label, area: z.area, type: z.type, kind: z.kind,
        capacity, minOccupancy: z.minOccupancy, series,
      };
    });
  return { buckets, nowIdx, rows };
}

// ── occupancy over time ────────────────────────────────────────────────────
// `zone` null → the whole site (all region zones summed against total capacity).
export function buildTimeline(matrix, zone) {
  const target = zone && zone.mode === 'region' ? matrix.rows.filter((r) => r.id === zone.id) : matrix.rows;
  const capacity = target.reduce((a, r) => a + r.capacity, 0);
  return {
    capacity,
    nowIdx: matrix.nowIdx,
    rows: matrix.buckets.map((time, i) => ({
      time,
      count: target.reduce((a, r) => a + r.series[i], 0),
      capacity,
    })),
  };
}

// ── peak occupancy — WHEN and WHERE ────────────────────────────────────────
// Two honest answers, not one:
//
//   site.*  argmax over TIME of the column sums. The busiest MOMENT on the
//           filtered floor. `contributors` is every zone AT THAT SAME BUCKET,
//           ranked — that is the "where", and it is a list, because at the
//           2 PM peak the answer is "Atrium 140, Food Court 96, Lobby 71",
//           not a single room.
//   zone.*  argmax over TIME AND ZONE of utilization. The fullest single room
//           of the day. Routinely a different hour from the site peak: the site
//           peaks at lunch, the one undersized meeting room peaks at 10 AM.
//
// Reporting only the first hides undersized spaces; only the second hides the
// staffing hour. The page shows both and `peakBasis` picks the headline.
// `window` = { from, to } inclusive bucket indices. Narrows the search WITHOUT
// re-deriving the underlying numbers, so "peak between 14:00 and 18:00" is the
// same matrix read over fewer columns — the windowed answer can never contradict
// the full-day one, it is a subset of it.
export function buildPeak(matrix, cfg = {}, bucketWindow) {
  const { buckets, rows } = matrix;
  if (!rows.length || !buckets.length) return null;

  const from = Math.max(0, Math.min(bucketWindow?.from ?? 0, buckets.length - 1));
  const to = Math.max(from, Math.min(bucketWindow?.to ?? buckets.length - 1, buckets.length - 1));

  const totals = buckets.map((_, i) => rows.reduce((a, r) => a + r.series[i], 0));
  const capacity = rows.reduce((a, r) => a + r.capacity, 0);

  // Earliest bucket wins a tie — an operator asked "when did it start" means the
  // first time it got that bad, not the last.
  let sIdx = from;
  for (let i = from; i <= to; i += 1) if (totals[i] > totals[sIdx]) sIdx = i;

  const pct = (count, cap) => Math.round((count / (cap || 1)) * 100);

  const contributors = rows
    .map((r) => ({
      id: r.id, label: r.label, area: r.area, type: r.type,
      count: r.series[sIdx], capacity: r.capacity,
      utilization: pct(r.series[sIdx], r.capacity),
      share: totals[sIdx] ? Math.round((r.series[sIdx] / totals[sIdx]) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Each zone's own busiest bucket. Feeds the CSV and answers "when is MY room
  // full" for a zone that never shows up near the site peak.
  const perZone = rows.map((r) => {
    let idx = from;
    for (let i = from; i <= to; i += 1) if (r.series[i] > r.series[idx]) idx = i;
    return {
      id: r.id, label: r.label, area: r.area,
      count: r.series[idx], at: buckets[idx], atIdx: idx,
      capacity: r.capacity, utilization: pct(r.series[idx], r.capacity),
    };
  });

  // Fullest room-moment = highest utilization, not highest headcount. A 9/10
  // interview room is a worse problem than a 200/900 atrium.
  const hottest = perZone.slice().sort((a, b) => b.utilization - a.utilization)[0];

  const site = {
    value: totals[sIdx], at: buckets[sIdx], atIdx: sIdx,
    capacity, utilization: pct(totals[sIdx], capacity),
    topZone: contributors[0] || null,
    contributors,
  };

  const basis = cfg.peakBasis === 'zone' ? 'zone' : 'site';
  const searched = { from, to, fromLabel: buckets[from], toLabel: buckets[to], full: from === 0 && to === buckets.length - 1 };
  const headline = basis === 'zone'
    ? { value: hottest.count, at: hottest.at, atIdx: hottest.atIdx, where: hottest.label, whereId: hottest.id, utilization: hottest.utilization, capacity: hottest.capacity }
    : { value: site.value, at: site.at, atIdx: site.atIdx, where: site.topZone ? site.topZone.label : '—', whereId: site.topZone ? site.topZone.id : null, utilization: site.utilization, capacity };

  return { basis, site, zone: hottest, perZone, headline, window: searched };
}

// Peak of whatever series is on screen — site total, or one zone when the
// operator has drilled in. Keeps the chart marker honest against the axis it is
// drawn on instead of re-plotting the site peak over a single zone's curve.
export function timelinePeak(timeline, bucketWindow) {
  const rows = timeline.rows || [];
  if (!rows.length) return null;
  const from = Math.max(0, Math.min(bucketWindow?.from ?? 0, rows.length - 1));
  const to = Math.max(from, Math.min(bucketWindow?.to ?? rows.length - 1, rows.length - 1));
  let idx = from;
  for (let i = from; i <= to; i += 1) if (rows[i].count > rows[idx].count) idx = i;
  return { ...rows[idx], atIdx: idx };
}

// ── entry / exit flow ──────────────────────────────────────────────────────
export function buildFlow(gate, buckets, scope) {
  if (!gate) return [];
  const key = scopeKey(scope);
  const ins = curve(hash(`${gate.id}in-${key}`), Math.round(gate.in / 5), buckets.length);
  const outs = curve(hash(`${gate.id}out-${key}`), Math.round(gate.out / 5), buckets.length);
  return buckets.map((time, i) => ({ time, in: ins[i], out: outs[i] }));
}

// ── zone × hour utilization ────────────────────────────────────────────────
// Sequential, one hue, light → dark. Five steps of the brand orange.
// Applied as inline `background`, where var() resolves and re-resolves on a
// theme flip — see --heat-* in index.css for why dark needs its own ramp.
export const HEAT_RAMP = ['var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)', 'var(--heat-5)'];
export const HEAT_EMPTY = 'var(--heat-0)';

export function heatColor(pct) {
  if (pct <= 0) return HEAT_EMPTY;
  return HEAT_RAMP[Math.min(HEAT_RAMP.length - 1, Math.floor(pct / 21))];
}

// Reads the matrix — so the darkest cell here IS the peak the KPI card names.
// (It used to seed its own curve, which is why the two disagreed.)
export function buildHeatmap(matrix) {
  return matrix.rows.map((r) => ({
    id: r.id,
    label: r.label,
    cells: r.series.map((count, i) => ({
      time: matrix.buckets[i],
      count,
      pct: Math.round((count / (r.capacity || 1)) * 100),
    })),
  }));
}

// ── threshold breaches ─────────────────────────────────────────────────────
// Every row is one rule firing. The grammar is always the same:
//   <metric> <operator> <value> for <duration> in <zone>
// which is why occupancy belongs in the rules engine as a numeric field rather
// than being hard-coded per vertical.
export function buildBreaches(cfg, zones, scope) {
  const rows = [];
  const rnd = seeded(hash(`${cfg.label?.site || 'site'}-breach-${scopeKey(scope)}`));
  const stamp = () => `${String(9 + Math.floor(rnd() * 8)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`;

  zones.forEach((z) => {
    if (z.status === 'over') {
      rows.push({
        id: `${z.id}-over`, time: stamp(), zone: z.label,
        rule: `occupancy ≥ ${cfg.breachPct}% of capacity`,
        peak: z.count, limit: z.capacity,
        duration: `${2 + Math.floor(rnd() * 26)}m`, status: 'over', state: 'Active',
      });
    }
    if (z.status === 'under') {
      rows.push({
        id: `${z.id}-under`, time: stamp(), zone: z.label,
        rule: `occupancy < minOccupancy (${z.minOccupancy})`,
        peak: z.count, limit: z.minOccupancy,
        duration: `${1 + Math.floor(rnd() * 9)}m`, status: 'under', state: 'Active',
      });
    }
    if (z.kind === 'queue' && z.mode === 'region' && z.utilization >= 80) {
      rows.push({
        id: `${z.id}-dwell`, time: stamp(), zone: z.label,
        rule: `dwell > ${Math.round(cfg.dwellAlertSec / 60)}m`,
        peak: z.count, limit: Math.round((z.capacity || 0) * 0.8),
        duration: `${3 + Math.floor(rnd() * 12)}m`, status: 'busy', state: 'Acknowledged',
      });
    }
    if (z.kind === 'corridor' && z.mode === 'region') {
      rows.push({
        id: `${z.id}-density`, time: stamp(), zone: z.label,
        rule: `density > ${cfg.densityPerM2}/m²`,
        peak: z.count, limit: z.capacity,
        duration: `${2 + Math.floor(rnd() * 6)}m`, status: 'busy', state: 'Cleared',
      });
    }
  });

  return rows.sort((a, b) => a.time.localeCompare(b.time));
}

// ── historical window ──────────────────────────────────────────────────────
// The Historical Headcount & Density view picks a window as Today | Yesterday |
// Last 7 days | Custom. Each resolves to a list of calendar days plus the scope
// the builders above key on. Custom ranges are capped so the per-day compliance
// log stays a readable length.
export const HISTORY_RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 Days' },
  { id: 'custom', label: 'Custom Range' },
];
export const MAX_CUSTOM_DAYS = 31;

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Calendar days (ISO, oldest first) covered by a history window. */
export function historyDays(range, today, custom = {}) {
  const end = parseIsoDate(today);
  if (range === 'yesterday') return [isoOf(addDays(end, -1))];
  if (range === '7d') return Array.from({ length: 7 }, (_, i) => isoOf(addDays(end, i - 6)));
  if (range === 'custom' && custom.from && custom.to) {
    const a = parseIsoDate(custom.from <= custom.to ? custom.from : custom.to);
    const b = parseIsoDate(custom.from <= custom.to ? custom.to : custom.from);
    const n = Math.min(MAX_CUSTOM_DAYS, Math.round((b - a) / 86_400_000) + 1);
    return Array.from({ length: n }, (_, i) => isoOf(addDays(b, i - n + 1)));
  }
  return [today];
}

/**
 * Scope for a history window. Always hourly — the heatmap is hour-of-day, so a
 * multi-day window reads as the typical day across it. One day keys exactly as
 * the Live view's date does; several days key on both ends.
 */
export function historyScope(site, days) {
  const last = days[days.length - 1];
  if (days.length === 1) return { site, range: 'date', date: last, granularity: 'hour' };
  return { site, range: 'span', from: days[0], date: last, granularity: 'hour' };
}

/**
 * Peak traffic & bottleneck summary, one row per region zone: when it peaked,
 * the highest count reached against capacity, typical dwell, and whether it
 * crossed the breach limit (a bottleneck). Read off the same matrix as the
 * heatmap, so the peak hour here is that row's darkest cell.
 */
export function buildZoneSummary(matrix, zones, breachPct = 100) {
  const byId = new Map(zones.map((z) => [z.id, z]));
  return matrix.rows.map((r) => {
    let idx = 0;
    r.series.forEach((v, i) => { if (v > r.series[idx]) idx = i; });
    const max = r.series[idx] || 0;
    const utilization = Math.round((max / (r.capacity || 1)) * 100);
    const z = byId.get(r.id) || {};
    const avg = Math.round(r.series.reduce((a, v) => a + v, 0) / (r.series.length || 1));
    return {
      id: r.id, label: r.label, area: r.area, kind: r.kind, typeLabel: z.typeLabel,
      peakAt: matrix.buckets[idx], max, capacity: r.capacity, utilization, avg,
      avgDwellSec: z.avgDwellSec ?? null, maxDwellSec: z.maxDwellSec ?? null,
      bottleneck: utilization >= breachPct,
    };
  }).sort((a, b) => b.utilization - a.utilization);
}

/**
 * Capacity compliance log across a window: every threshold breach on every day
 * in it, newest first. Each day is built as its own one-day scope, so a day's
 * rows here match that day opened on its own.
 */
export function buildComplianceLog(cfg, site, days, keep = () => true) {
  const rows = [];
  days.forEach((date) => {
    const scope = { site, range: 'date', date, granularity: 'hour' };
    const zones = buildZones(cfg, scope).filter(keep);
    const today = date === days[days.length - 1];
    buildBreaches(cfg, zones, scope).forEach((b) => {
      // Only the newest day can still be open; earlier days are history.
      const state = today ? b.state : b.state === 'Active' ? 'Resolved' : b.state;
      rows.push({ ...b, id: `${date}-${b.id}`, date, state });
    });
  });
  return rows.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}

// ── CSV export ─────────────────────────────────────────────────────────────
// Hand-built Blob, same as the other Activity Monitoring pages.
// `peak` (from buildPeak) is optional — without it the export is the old live
// snapshot. With it every row also carries that zone's own busiest bucket, which
// is the column people actually paste into a capacity review.
/** The live zone table as export rows — shared by the CSV, PDF and Excel exports. */
export function zoneExportRows(zones, peak) {
  const byZone = new Map((peak?.perZone || []).map((p) => [p.id, p]));
  const head = ['Zone', 'Zone ID', 'Type', 'Area', 'Mode', 'Count', 'Capacity', 'Utilization %', 'Dwell time (typical)', 'Longest stay', 'Peak count', 'Peak at', 'Peak util %', 'Identified', 'Unidentified', 'In', 'Out', 'Staff on post', 'Staff required', 'Status'];
  const body = zones.map((z) => {
    const p = byZone.get(z.id);
    return [
      z.label, z.id, z.typeLabel || z.type, z.area, z.mode,
      z.mode === 'line' ? z.inside : z.count,
      z.capacity ?? '', z.mode === 'line' ? '' : z.utilization,
      z.avgDwellSec == null ? '' : formatDwell(z.avgDwellSec),
      z.maxDwellSec == null ? '' : formatDwell(z.maxDwellSec),
      p?.count ?? '', p?.at ?? '', p?.utilization ?? '',
      z.identified ?? '', z.delta ?? '',
      z.in ?? '', z.out ?? '',
      z.staffRequired ? z.staffOnPost : '', z.staffRequired || '',
      STATUS_LABEL[z.status],
    ];
  });
  return { head, body };
}

// ── live table filters ──────────────────────────────────────────────────────
// The applied state of the Live Zone Occupancy filter popover. Kept here (not
// in the .jsx) so the component file exports components only.
export const EMPTY_ZONE_FILTERS = { area: '', types: [], status: 'all', dwell: 'all' };

/** How many filter groups differ from their default. */
export function activeFilterCount(f) {
  return (f.area ? 1 : 0) + (f.types.length ? 1 : 0) + (f.status !== 'all' ? 1 : 0) + (f.dwell !== 'all' ? 1 : 0);
}
