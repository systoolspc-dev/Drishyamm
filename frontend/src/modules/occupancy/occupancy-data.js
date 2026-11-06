/**
 * Footfall & Occupancy — the derivation layer.
 *
 * Pure functions only. Everything here turns the three live feeds the platform
 * already has into the one model the page renders:
 *
 *   footfall service   -> LINE zones   (a doorway: IN, OUT, net INSIDE)
 *   head-count service -> REGION zones (a room: count against a capacity)
 *   room behaviour settings -> the thresholds both are judged against
 *
 * The line/region split is not cosmetic. A gate has no capacity — counting
 * crossings is the whole measurement — and a room has no direction. Giving them
 * one card shape would mean inventing a number for whichever half does not have
 * it, so they stay two shapes sharing one status vocabulary.
 */
import { countOn, normalizeZones } from './zone-model.js';
import { directionFromCamera, lineFromCamera } from './gate-model.js';

// ── Status vocabulary ───────────────────────────────────────────────────────
// One ramp, used by the cards, the chips, the metric bar and the heatmap alike.
//   ok     under 75% of capacity
//   busy   75-90%   (the amber band)
//   full   90-100%  (the rose band, before the breach) — 90 is the default;
//          each zone can move it, or switch it off, with its warn threshold
//   breach at or over capacity
//   under  below the minimum required headcount (an under-staffed room)
//   idle   nothing counted / camera offline
export const STATUS_LABEL = {
  ok: 'Normal', busy: 'Filling', full: 'Near capacity',
  breach: 'Over capacity', under: 'Under-staffed', idle: 'No data',
};

export const STATUS_CHIP = {
  ok:     'bg-success-soft text-success-ink ring-success-line',
  busy:   'bg-warning-soft text-warning-ink ring-warning-line',
  full:   'bg-warning-soft text-warning-ink ring-warning-line',
  breach: 'bg-danger-soft  text-danger-ink  ring-danger-line',
  under:  'bg-info-soft    text-info-ink    ring-info-line',
  idle:   'bg-surface-muted text-fg-muted   ring-line',
};

// The fill of the capacity bar. The brief asked for emerald / amber / rose;
// these are the tokens that carry those roles, so the bar follows the theme
// instead of staying one hue in both modes.
export const STATUS_BAR = {
  ok: 'var(--success)', busy: 'var(--warning)', full: 'var(--warning)',
  breach: 'var(--danger)', under: 'var(--info)', idle: 'var(--line-strong)',
};

/**
 * The fill for a capacity bar, by how full the space is: emerald under 70%,
 * amber from 70 to 90%, red above 90%. Deliberately literal hues rather than the
 * status tokens — this is a gauge, and a gauge reads the same in either theme.
 */
export function capacityBarClass(pct) {
  if (pct > 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export const BUSY_PCT = 75;     // emerald -> amber
export const FULL_PCT = 90;     // amber   -> rose
export const SURGE_HEADS = 6;   // heads added inside the window below = a surge
export const SURGE_WINDOW_MS = 90_000;

/**
 * Where a room sits on the ramp. A `capacity` of 0 means "no limit set".
 *
 * `warnPct` is the zone's own early-warning line; 0 switches the warning off,
 * so the room goes straight from Filling to Over capacity. The breach itself
 * is not optional — that is what the limit is for.
 */
export function regionStatus({ count, capacity, minCapacity, warnPct = FULL_PCT }) {
  if (capacity > 0 && count >= capacity) return 'breach';
  if (minCapacity > 0 && count < minCapacity) return 'under';
  if (!capacity) return count > 0 ? 'ok' : 'idle';
  const pct = (count / capacity) * 100;
  if (warnPct > 0 && pct >= warnPct) return 'full';
  if (pct >= BUSY_PCT) return 'busy';
  return count > 0 ? 'ok' : 'idle';
}

export const utilization = (count, capacity) =>
  capacity > 0 ? Math.round((count / capacity) * 100) : 0;

// ── Room profiles ───────────────────────────────────────────────────────────
// Picking a profile is the fast path through the settings panel: it seeds every
// threshold with a value that is right far more often than a blank field is.
// Each one stays fully editable — the profile is a starting point, not a lock.
export const ROOM_PROFILES = [
  {
    id: 'workplace', label: 'Workplace',
    blurb: 'Desks and open-plan floors. Long dwell is normal; emptiness during hours is the signal.',
    defaults: { maxCapacity: 60, minCapacity: 4, maxDwellMin: 240, hours: ['09:00', '18:00'], offHoursLock: false, privacy: 'identified' },
  },
  {
    id: 'meeting', label: 'Meeting Room',
    blurb: 'Bookable rooms. A hard seat count, and dwell bounded by the booking slot.',
    defaults: { maxCapacity: 12, minCapacity: 0, maxDwellMin: 90, hours: ['08:00', '20:00'], offHoursLock: false, privacy: 'anonymous' },
  },
  {
    id: 'dining', label: 'Cafeteria / Dining',
    blurb: 'Peaky by nature. High capacity, short dwell — queue build-up is what to catch.',
    defaults: { maxCapacity: 150, minCapacity: 0, maxDwellMin: 45, hours: ['07:00', '22:00'], offHoursLock: false, privacy: 'anonymous' },
  },
  {
    id: 'restricted', label: 'Restricted / Secure Zone',
    blurb: 'Anyone unaccompanied is an event. Tight capacity, short dwell, locked outside hours.',
    defaults: { maxCapacity: 3, minCapacity: 0, maxDwellMin: 20, hours: ['09:00', '18:00'], offHoursLock: true, privacy: 'identified' },
  },
  {
    id: 'transit', label: 'Transit / Lobby',
    blurb: 'People should be moving through. Standing still here matters more than the count.',
    defaults: { maxCapacity: 80, minCapacity: 0, maxDwellMin: 10, hours: ['00:00', '23:59'], offHoursLock: false, privacy: 'anonymous' },
  },
];

export const PROFILE_BY_ID = Object.fromEntries(ROOM_PROFILES.map((p) => [p.id, p]));

export const PRIVACY_MODES = [
  { id: 'anonymous',  label: 'Anonymous counting only',       blurb: 'Heads are counted. No face is matched or stored for this room.' },
  { id: 'identified', label: 'Identified',                    blurb: 'Counts are reconciled against the enrolled gallery — who, not just how many.' },
  { id: 'ratio',      label: 'Identified / unidentified',     blurb: 'Reports the split without naming anyone: the reconciliation signal, minus the identities.' },
];

// ── Operating schedule ──────────────────────────────────────────────────────
const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
};

/** True when `at` falls inside the room's operating window (wraps past midnight). */
export function withinHours(room, at = new Date()) {
  const start = toMinutes(room?.hours?.[0]);
  const end   = toMinutes(room?.hours?.[1]);
  if (start == null || end == null) return true;
  const now = at.getHours() * 60 + at.getMinutes();
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

/**
 * The capacity actually in force right now.
 *
 * Off-Hours Security Lock is why this is a function and not a field: outside
 * operating hours a locked room's allowed occupancy is zero, so one person
 * inside is a breach — without anyone re-entering a number at 6pm and again at
 * 9am the next morning.
 */
export function effectiveCapacity(room, at = new Date()) {
  if (!room) return 0;
  if (room.offHoursLock && !withinHours(room, at)) return 0;
  return Number(room.maxCapacity) || 0;
}

// ── Feeds -> model ──────────────────────────────────────────────────────────

const isHexId = (s) => typeof s === 'string' && /^[0-9a-f]{24}$/i.test(s.trim());

/**
 * Footfall cameras -> line zones. `names` maps monitorId to a human label; the
 * AI service often only knows the raw monitor hex, and that is never something
 * an operator should have to read off a card.
 */
export function buildLineZones(footfall, names = {}) {
  const cams = footfall?.cameras || [];
  return cams
    .filter((c) => c.footfall_enabled)
    .map((c) => {
      const named = names[c.camera_code];
      const label = named?.name
        || (named?.groupName && named?.channelLabel ? `${named.groupName} · ${named.channelLabel}` : null)
        || (c.camera_name && !isHexId(c.camera_name) ? c.camera_name : null)
        || 'Unnamed gate';
      const inCount  = Number(c.today?.in)  || 0;
      const outCount = Number(c.today?.out) || 0;
      const line = lineFromCamera(c);
      return {
        id: c.camera_id,
        monitorId: c.camera_code,
        label,
        area: named?.groupName || 'Unassigned',
        in: inCount,
        out: outCount,
        inside: Math.max(0, inCount - outCount),
        line,
        direction: directionFromCamera(c, line),
      };
    })
    .sort((a, b) => b.in - a.in);
}

/**
 * Head-count streams + camera registry + zone settings -> region zones.
 *
 * One card per configured zone, whichever cameras feed it, plus one per camera
 * nobody has drawn a zone on yet -- that camera's whole view, as before, so a
 * newly counting camera still shows up before anyone has configured it. A
 * camera that belongs to a zone does NOT also get a whole-view card: its
 * people are already in that zone's number.
 *
 * Zone settings, once saved, win over the camera's own threshold -- Zone Setup
 * is where capacity is meant to be edited, so it has to be the value that
 * counts.
 */
export function buildRegionZones(streams, camByMonitor = {}, rooms = {}, at = new Date()) {
  const byId = Object.fromEntries((streams || []).map((s) => [s.id, s]));
  const zones = normalizeZones(rooms);
  const covered = new Set();
  const out = [];

  for (const zone of Object.values(zones)) {
    const live = zone.cameras.filter((m) => byId[m]);
    // A zone whose cameras have all stopped counting has nothing to show.
    if (!live.length) continue;
    live.forEach((m) => covered.add(m));
    const count = live.reduce((n, m) => n + countOn(byId[m], zone, zones), 0);
    out.push(regionZone({
      id: zone.id,
      room: zone,
      count,
      cameraIds: zone.cameras,
      streams: live.map((m) => byId[m]),
      camByMonitor,
      at,
    }));
  }

  for (const s of streams || []) {
    if (covered.has(s.id)) continue;
    out.push(regionZone({
      id: s.id,
      room: null,
      count: Number(s?.counts?.heads) || 0,
      cameraIds: [s.id],
      streams: [s],
      camByMonitor,
      at,
    }));
  }

  return out.sort((a, b) => b.utilization - a.utilization || b.count - a.count);
}

function regionZone({ id, room, count, cameraIds, streams, camByMonitor, at }) {
  const primary = cameraIds[0];
  const cam = camByMonitor[primary];
  const capacity = room
    ? effectiveCapacity(room, at)
    : Number(cam?.headcount?.threshold) || 0;
  const minCapacity = Number(room?.minCapacity) || 0;
  // Rooms saved before the warning was configurable carry no field, and read
  // as the default line they were already being judged against.
  const warnPct = room?.warnEnabled === false ? 0 : Number(room?.warnPct) || FULL_PCT;
  // Offline only when every camera feeding it is: one live view of a hall is
  // still a live count of part of it.
  const offline = streams.every((s) => s.status !== 'online');
  const locked = Boolean(room?.offHoursLock) && !withinHours(room, at);
  const camName = (m) => camByMonitor[m]?.name || streams.find((s) => s.id === m)?.name || m;
  return {
    id,
    // The primary camera: where the quick editor pushes the limit, and what
    // the server's intrusion record is attached to.
    monitorId: primary,
    cameraIds,
    cameraId: cam?.id || null,
    // The counting switch as Head Count left it, so a zone save can pass it
    // back unchanged. Undefined when the registry has not loaded.
    cameraEnabled: cam?.headcount?.enabled,
    label: room?.name || cam?.name || streams[0]?.name || 'Unnamed space',
    floor: room?.floor || cam?.groupName || '',
    profile: room?.profile || null,
    count,
    capacity,
    minCapacity,
    utilization: utilization(count, capacity),
    warnPct,
    status: offline ? 'idle' : regionStatus({ count, capacity, minCapacity, warnPct }),
    offline,
    locked,
    // 0 is "no limit" everywhere downstream, so a switched-off rule reads the same.
    maxDwellMin: room?.dwellEnabled === false ? 0 : Number(room?.maxDwellMin) || 0,
    privacy: room?.privacy || 'anonymous',
    cameras: cameraIds.map(camName).filter(Boolean),
    configured: Boolean(room),
  };
}

/**
 * Congestion: the things worth interrupting an operator for.
 *
 * Two kinds, deliberately separated. A BREACH is a standing fact — this room is
 * over its limit right now. A SURGE is a rate — this room gained a crowd's
 * worth of people in the last ninety seconds, which is what a bottleneck or a
 * sudden gathering looks like well before the count itself is alarming.
 */
export function buildCongestion(regions, history) {
  const out = [];
  for (const z of regions) {
    if (z.locked && z.count > 0) {
      out.push({ id: `${z.id}:lock`, zone: z, kind: 'lock', severity: 'critical',
        text: `${z.count} inside ${z.label} outside operating hours — security lock is on` });
    } else if (z.status === 'breach') {
      out.push({ id: `${z.id}:breach`, zone: z, kind: 'breach', severity: 'critical',
        text: `${z.label} is at ${z.count} of ${z.capacity} — over its limit` });
    } else if (z.status === 'full') {
      out.push({ id: `${z.id}:full`, zone: z, kind: 'full', severity: 'warn',
        text: `${z.label} is at ${z.utilization}% of capacity` });
    } else if (z.status === 'under') {
      out.push({ id: `${z.id}:under`, zone: z, kind: 'under', severity: 'info',
        text: `${z.label} has ${z.count} present, below the ${z.minCapacity} required` });
    }
    const surge = surgeIn(history?.[z.id]);
    if (surge >= SURGE_HEADS) {
      out.push({ id: `${z.id}:surge`, zone: z, kind: 'surge', severity: 'warn',
        text: `${z.label} gained ${surge} people in the last ${Math.round(SURGE_WINDOW_MS / 1000)}s` });
    }
  }
  const rank = { critical: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Heads gained across the surge window of one zone's rolling sample series. */
export function surgeIn(series) {
  if (!series?.length) return 0;
  const cutoff = Date.now() - SURGE_WINDOW_MS;
  const window = series.filter((p) => p.t >= cutoff);
  if (window.length < 2) return 0;
  return window[window.length - 1].v - Math.min(...window.map((p) => p.v));
}

/** The four numbers in the top bar. */
export function buildMacro({ lineZones, regionZones, congestion, footfall }) {
  const live     = regionZones.reduce((n, z) => n + z.count, 0);
  const capacity = regionZones.reduce((n, z) => n + z.capacity, 0);
  const totals   = footfall?.totals_today || {};
  const dailyIn  = Number(totals.in)  || lineZones.reduce((n, z) => n + z.in, 0);
  const dailyOut = Number(totals.out) || lineZones.reduce((n, z) => n + z.out, 0);
  return {
    live,
    capacity,
    utilization: utilization(live, capacity),
    dailyIn,
    dailyOut,
    net: dailyIn - dailyOut,
    breaches: congestion.filter((c) => c.severity === 'critical').length,
    warnings: congestion.filter((c) => c.severity === 'warn').length,
    // Already sorted by utilisation, so the first zone that is online and has
    // anyone in it IS the busiest. A zone with no capacity set sorts at 0% and
    // cannot win the tile, which is right: "busiest" is a ratio, not a count.
    busiest: regionZones.find((z) => !z.offline && z.count > 0) || null,
    camerasTracking: Number(totals.cameras_tracking) || lineZones.length,
    camerasTotal: Number(totals.cameras_total) || lineZones.length,
  };
}

// ── Analytics (tab 2) ───────────────────────────────────────────────────────

/**
 * Hourly footfall points -> the timeline the building chart draws.
 *
 * `inside` is cumulative: occupancy at the end of each hour is everyone who has
 * entered minus everyone who has left, floored at zero. That floor matters — an
 * unpaired OUT early in the day (someone who stayed overnight, a camera that
 * came online late) would otherwise drag the whole curve negative.
 */
export function buildTimeline(points = []) {
  let running = 0;
  return points.map((p) => {
    const inC  = Number(p.in_count)  || 0;
    const outC = Number(p.out_count) || 0;
    running = Math.max(0, running + inC - outC);
    const d = new Date(p.bucket);
    return {
      bucket: p.bucket,
      hour: Number.isNaN(d.getTime()) ? String(p.bucket) : `${String(d.getHours()).padStart(2, '0')}:00`,
      in: inC,
      out: outC,
      net: inC - outC,
      inside: running,
    };
  });
}

export const HEAT_RAMP = ['var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)', 'var(--heat-5)'];
export const HEAT_EMPTY = 'var(--heat-0)';

export function heatColor(pct) {
  if (pct == null || pct <= 0) return HEAT_EMPTY;
  const i = Math.min(HEAT_RAMP.length - 1, Math.floor((pct / 100) * HEAT_RAMP.length));
  return HEAT_RAMP[i];
}

/** Fallback operational window when no room has operating hours configured. */
export const DEFAULT_OPERATIONAL_HOURS = [9, 17];

/**
 * The hours the heatmap has columns for.
 *
 * Derived from the rooms rather than fixed, because "operational hours" is
 * already a thing an operator configured per space — a campus that opens its
 * cafeteria at 07:00 should get an 07 column without editing this file. The
 * window is the union of every configured room's schedule; with none
 * configured it falls back to 09-17.
 *
 * Capped at MAX_COLUMNS so a single 24-hour room (a lobby set 00:00-23:59)
 * cannot squeeze the grid down to unreadable slivers. When the cap bites, the
 * window is centred on the busiest part of the day rather than truncated from
 * midnight, so the columns kept are the ones anybody looks at.
 */
const MAX_COLUMNS = 14;

export function operationalHours(rooms = {}) {
  const configured = Object.values(rooms).filter((r) => r?.hours?.length === 2);
  let [start, end] = DEFAULT_OPERATIONAL_HOURS;

  if (configured.length) {
    const starts = [];
    const ends = [];
    for (const r of configured) {
      const s = Number(String(r.hours[0]).split(':')[0]);
      const e = Number(String(r.hours[1]).split(':')[0]);
      if (Number.isFinite(s)) starts.push(s);
      if (Number.isFinite(e)) ends.push(e);
    }
    if (starts.length && ends.length) {
      start = Math.min(...starts);
      end = Math.max(...ends);
    }
  }

  if (end < start) end = start;
  if (end - start + 1 > MAX_COLUMNS) {
    const mid = Math.round((DEFAULT_OPERATIONAL_HOURS[0] + DEFAULT_OPERATIONAL_HOURS[1]) / 2);
    start = Math.max(start, mid - Math.floor(MAX_COLUMNS / 2));
    end = start + MAX_COLUMNS - 1;
  }

  const hours = [];
  for (let h = start; h <= end; h += 1) hours.push(h);
  return hours;
}

/**
 * Zone x hour utilisation matrix.
 *
 * Built from the rolling samples this page has collected since it was opened,
 * bucketed by hour and reduced to each hour's peak — peak rather than average
 * because a room that hit capacity for ten minutes breached, and an average
 * would hide exactly the hour worth planning around.
 *
 * Hours the page never observed carry `pct: null`, not zero, and render as an
 * outline. A room nobody watched is not an empty room, and colouring it as one
 * would be a lie an operator could act on.
 */
export function buildHeatmap(regions, history, rooms = {}) {
  const hours = operationalHours(rooms);

  const rows = regions.slice(0, 12).map((z) => {
    const byHour = new Map();
    for (const p of history?.[z.id] || []) {
      const h = new Date(p.t).getHours();
      const cur = byHour.get(h);
      if (cur == null || p.v > cur) byHour.set(h, p.v);
    }
    return {
      id: z.id,
      label: z.label,
      capacity: z.capacity,
      cells: hours.map((h) => {
        const v = byHour.get(h);
        if (v == null) return { hour: h, count: null, pct: null, exact: null };
        return {
          hour: h,
          count: v,
          // `pct` drives the colour step and stays a whole number, matching
          // every other percentage on the page. `exact` is for the tooltip,
          // where one decimal is the difference between "97%" and "97.5% —
          // two seats left".
          pct: utilization(v, z.capacity),
          exact: z.capacity > 0 ? Math.round((v / z.capacity) * 1000) / 10 : null,
        };
      }),
    };
  });

  return { hours, labels: hours.map((h) => `${String(h).padStart(2, '0')}:00`), rows };
}

export const nfmt = (n) => new Intl.NumberFormat('en-IN').format(Math.round(Number(n) || 0));
