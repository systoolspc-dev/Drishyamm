/**
 * Vehicle & ANPR — the derivation layer.
 *
 * Pure functions. One thing worth reading first: every tab in this hub is a
 * different question asked of ONE list — the plate reads the events service has
 * recorded. Find & Track asks "where did this plate go", Live asks "what just
 * came through", Outside asks "who is not from here", Records asks "what
 * happened", Check Reads asks "what did we probably get wrong". Building five
 * feeds for five tabs would have let them disagree about the same read.
 *
 * The reads come from `/ai/events`, types `vehicle.lpr` and `vehicle.detected`.
 * The service has no dedicated ANPR endpoint, and the plate lives in a payload
 * whose exact field name varies by producer, so `normaliseRead` is deliberately
 * tolerant about where it looks and honest when it finds nothing.
 */

// ── Plates ──────────────────────────────────────────────────────────────────

// Indian plates: 2 letters, 1-2 digits, 0-3 letters, 1-4 digits. Same shape the
// dashboard's quick search already recognises, so a string that is a plate in
// one place is a plate in the other.
const PLATE_RE = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;

export const normalisePlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const looksLikePlate = (s) => {
  const p = normalisePlate(s);
  return p.length >= 6 && PLATE_RE.test(p);
};

/** The registering state — the first two letters. `null` when unreadable. */
export const stateOf = (plate) => {
  const p = normalisePlate(plate);
  return /^[A-Z]{2}/.test(p) ? p.slice(0, 2) : null;
};

/** Group plates for display: MH12AB1234 -> MH 12 AB 1234. */
export function prettyPlate(plate) {
  const p = normalisePlate(plate);
  const m = p.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ') : p || '—';
}

/**
 * Wildcard plate search: `*` is any run of characters, `?` is exactly one.
 *
 * An operator with a partial plate off a witness statement has holes in known
 * positions — "MH12??1234" is a different question from "MH12*1234", and a
 * plain substring search cannot express either. Anything without a wildcard
 * falls back to a substring match, so the box still works when typed into
 * casually.
 */
export function plateMatcher(query) {
  const q = normalisePlate(query);
  if (!q) return () => true;
  if (!/[*?]/.test(query)) return (plate) => normalisePlate(plate).includes(q);
  const rx = new RegExp(`^${q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return (plate) => rx.test(normalisePlate(plate));
}

// ── Confidence ──────────────────────────────────────────────────────────────

/** The threshold below which a read goes to human review. */
export const REVIEW_BELOW = 80;

/**
 * Producers disagree about scale: some emit 0..1, some 0..100. A 0.96 treated
 * as 96% is right; treated as 1% it would send every good read to the review
 * queue, so the scale is inferred rather than assumed.
 */
export function toPercent(value) {
  // Guarded before Number(), because Number(null) is 0 and Number('') is 0 --
  // an event that carried no confidence at all would have scored a hard zero
  // and been queued for review as if the model had been certain it was wrong.
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 1) return Math.round(n * 1000) / 10;
  return Math.round(n * 10) / 10;
}

export const confidenceTone = (pct) => {
  if (pct == null) return 'idle';
  if (pct < REVIEW_BELOW) return 'warn';
  if (pct < 92) return 'ok';
  return 'good';
};

// ── One read ────────────────────────────────────────────────────────────────

const firstOf = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

/**
 * One event -> one plate read.
 *
 * `plate` is null when the event carried no readable plate. That is a real
 * state — a vehicle detection without OCR — and the UI shows it as "no plate
 * read" rather than inventing a placeholder that would sort and search as if
 * it were a registration.
 */
export function normaliseRead(evt, cameras = {}, corrections = {}) {
  if (!evt) return null;
  const payload = evt.payload || {};
  const id = evt.id || evt._id || `${evt.monitorId}-${evt.ts || evt.timestamp}`;

  const rawPlate = firstOf(payload, ['plate', 'plateNumber', 'plate_number', 'lp', 'licensePlate', 'text', 'ocr'])
    ?? firstOf(evt, ['plate', 'plateNumber', 'plate_number']);
  const plate = rawPlate ? normalisePlate(rawPlate) : null;

  const monitorId = evt.monitorId || evt.camera_code || evt.cameraCode || evt.camera_id || '';
  const cam = cameras[monitorId];
  const at = new Date(evt.ts || evt.timestamp || evt.createdAt || Date.now());

  const correction = corrections[id];

  return {
    id,
    raw: evt,
    plate: correction?.plate || plate,
    // Kept separately so the review queue can show what the AI actually said
    // next to what a human replaced it with.
    aiPlate: plate,
    corrected: Boolean(correction),
    correctedBy: correction?.by || null,
    confidence: toPercent(firstOf(payload, ['confidence', 'conf', 'score', 'ocr_confidence'])),
    at,
    monitorId,
    cameraLabel: cam ? (cam.groupName ? `${cam.groupName} · ${cam.name || 'Camera'}` : cam.name || 'Unnamed camera') : 'Unnamed camera',
    snapshot: firstOf(payload, ['snapshot', 'snapshotUri', 'image', 'crop', 'plateCrop']),
    vehicleType: firstOf(payload, ['vehicleType', 'type', 'class']),
    colour: firstOf(payload, ['color', 'colour']),
  };
}

/** The event types that carry a plate read. */
export const READ_TYPES = new Set(['vehicle.lpr', 'vehicle.detected']);

export const isToday = (d) => {
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
};

// ── Watchlist ───────────────────────────────────────────────────────────────

/** Index a watchlist by normalised plate so a read can be judged in O(1). */
export function indexWatchlist(list = []) {
  const out = {};
  for (const v of list) {
    const p = normalisePlate(v.plate);
    if (p) out[p] = v;
  }
  return out;
}

/**
 * The brief's Critical/High toggle over the watchlist's own vocabulary.
 * `riskLevel` in the existing list is critical | warning, so `high` reads the
 * warning tier rather than pretending a third level exists.
 */
export const SEVERITIES = [
  { id: 'critical', label: 'Critical', match: (v) => v.riskLevel === 'critical' },
  { id: 'high', label: 'High', match: (v) => v.riskLevel !== 'critical' },
];

export function hitOf(read, watchIndex, severities = null) {
  if (!read.plate) return null;
  const hit = watchIndex[read.plate];
  if (!hit) return null;
  if (!severities?.length) return hit;
  const on = SEVERITIES.filter((s) => severities.includes(s.id));
  return on.some((s) => s.match(hit)) ? hit : null;
}

// ── Derivations per tab ─────────────────────────────────────────────────────

/** The four numbers in the header. */
export function buildKpis({ reads, watchIndex, localState, streamOnline }) {
  const today = reads.filter((r) => isToday(r.at));
  const plates = today.filter((r) => r.plate);
  const hits = today.filter((r) => hitOf(r, watchIndex));
  const outside = plates.filter((r) => {
    const st = stateOf(r.plate);
    return st && st !== localState;
  });
  return {
    reads: today.length,
    withPlate: plates.length,
    hits: hits.length,
    outside: outside.length,
    outsidePct: plates.length ? Math.round((outside.length / plates.length) * 100) : 0,
    streamOnline,
    lowConfidence: today.filter((r) => r.confidence != null && r.confidence < REVIEW_BELOW).length,
  };
}

/**
 * One plate's movement, oldest first.
 *
 * Consecutive reads on the SAME camera collapse into one stop with a first and
 * last seen. A car idling at a gate produces a read a second; drawing forty
 * nodes on top of each other would say "it moved forty times" when it never
 * left. The hop between two stops is what the map draws.
 */
export function buildTrack(reads, plate) {
  const p = normalisePlate(plate);
  if (!p) return [];
  const mine = reads
    .filter((r) => r.plate === p)
    .sort((a, b) => a.at - b.at);

  const stops = [];
  for (const r of mine) {
    const last = stops[stops.length - 1];
    if (last && last.monitorId === r.monitorId) {
      last.lastSeen = r.at;
      last.count += 1;
      last.reads.push(r);
      if ((r.confidence ?? 0) > (last.confidence ?? 0)) last.confidence = r.confidence;
      continue;
    }
    stops.push({
      monitorId: r.monitorId,
      cameraLabel: r.cameraLabel,
      firstSeen: r.at,
      lastSeen: r.at,
      count: 1,
      confidence: r.confidence,
      snapshot: r.snapshot,
      reads: [r],
    });
  }

  return stops.map((s, i) => ({
    ...s,
    index: i,
    // Time since leaving the previous camera. The gap is the part an
    // investigator reads: a four-minute hop between two gates is a car
    // driving, forty minutes is a car that stopped somewhere unwatched.
    gapMs: i === 0 ? null : s.firstSeen - stops[i - 1].lastSeen,
    dwellMs: s.lastSeen - s.firstSeen,
  }));
}

export const fmtGap = (ms) => {
  if (ms == null) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const fmtTime = (d) => (d instanceof Date && !Number.isNaN(d.getTime())
  ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  : '—');

export const fmtDateTime = (d) => (d instanceof Date && !Number.isNaN(d.getTime())
  ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

/**
 * Non-local vehicles, grouped by plate rather than listed per read.
 *
 * The question on this tab is about VEHICLES — how long has that truck been on
 * site, how often does it come back — and a per-read table answers neither. So
 * reads fold into one row per plate carrying first seen, last seen, the entry
 * camera and a visit count.
 */
export function buildOutside(reads, localState, { minVisitsForFrequent = 3 } = {}) {
  const byPlate = new Map();
  for (const r of reads) {
    if (!r.plate) continue;
    const st = stateOf(r.plate);
    if (!st || st === localState) continue;
    const cur = byPlate.get(r.plate);
    if (!cur) {
      byPlate.set(r.plate, {
        plate: r.plate, state: st, first: r.at, last: r.at, reads: 1,
        entryCamera: r.cameraLabel, entryMonitorId: r.monitorId, snapshot: r.snapshot,
        days: new Set([r.at.toDateString()]),
      });
      continue;
    }
    if (r.at < cur.first) {
      cur.first = r.at;
      cur.entryCamera = r.cameraLabel;
      cur.entryMonitorId = r.monitorId;
    }
    if (r.at > cur.last) cur.last = r.at;
    cur.reads += 1;
    cur.days.add(r.at.toDateString());
  }

  return [...byPlate.values()]
    .map((v) => ({
      ...v,
      visits: v.days.size,
      // Time on site, from first sighting to last. Not a parking duration --
      // nothing here proves the vehicle never left between two reads -- so it
      // is labelled "on site" and not "parked".
      stayMs: v.last - v.first,
      frequent: v.days.size >= minVisitsForFrequent,
    }))
    .sort((a, b) => b.last - a.last);
}

export const fmtStay = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};

/** CSV of whatever the records table is currently showing. */
export function readsToCsv(rows) {
  const head = ['Plate', 'Confidence %', 'Camera', 'When', 'Type', 'Corrected'];
  const body = rows.map((r) => [
    r.plate || '',
    r.confidence ?? '',
    r.cameraLabel,
    r.at.toISOString(),
    r.raw?.eventType || r.raw?.kind || '',
    r.corrected ? 'yes' : '',
  ]);
  return [head, ...body]
    .map((line) => line.map((cell) => {
      const s = String(cell ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\n');
}
