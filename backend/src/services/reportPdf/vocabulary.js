'use strict';
/**
 * vocabulary.js — how an ai_events row is WORDED on paper.
 *
 * The event log, the AI feed and the reports page each carry a copy of this
 * mapping in the frontend; the PDF cannot reach those, so the labels live here
 * too. Keep the wording in step with smart-cam-app/src/modules/ai-feed/aifeed/
 * event-model.js when a new detector arrives.
 */

const EVENT_LABELS = {
  'zone.intrusion': 'Restricted Area Entry',
  'zone.entry': 'Restricted Area Entry',
  'perimeter.breach': 'Perimeter Intrusion',
  'line.cross': 'Line Crossing',
  'tripwire.entry': 'Line Crossed · In',
  'tripwire.exit': 'Line Crossed · Out',
  'weapon.detected': 'Weapon Detection',
  'fire.detected': 'Fire / Smoke Detection',
  'ppe.violation': 'PPE Violation',
  'object.left': 'Object Left Behind',
  'object.removed': 'Object Removed',
  'crowd.density': 'Crowd Density',
  'crowd.formed': 'Crowd Forming',
  'crowd.stampede': 'Crowd Surge',
  'occupancy.threshold': 'Occupancy Threshold',
  'occupancy.warning': 'Nearing Capacity',
  'occupancy.cleared': 'Back Under Capacity',
  'person.headcount': 'Head Count',
  'person.detected': 'Person Detection',
  'person.match': 'Face Recognised',
  'person.known': 'Face Recognised',
  'person.unknown': 'Unrecognised Face',
  'face.detected': 'Face Detection',
  'person.alert': 'Face Watchlist Match',
  'person.tracked': 'Person Tracking',
  'vehicle.detected': 'Vehicle Detection',
  'vehicle.lpr': 'Number Plate Read',
  'anpr.plate': 'Number Plate Read',
  'attendance.in': 'Attendance · In',
  'attendance.out': 'Attendance · Out',
  'activity.watchlist': 'Face Watchlist Match',
  'activity.stranger': 'Unknown Person Dwelling',
  'activity.after_hours': 'After-Hours Presence',
  'camera.offline': 'Camera Offline',
  'camera.online': 'Camera Online',
};

function eventLabel(eventType) {
  const t = String(eventType || '').toLowerCase();
  if (EVENT_LABELS[t]) return EVENT_LABELS[t];
  if (!t) return 'AI Event';
  return t.split(/[._\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Event types whose `payload.matchedName` is a PERSON. Every other producer
// (zone guard, occupancy) reuses that field as a dedup subject — "1 person",
// "5 people (limit 3)" — which must not be printed as an identity.
const FACE_RE = /^(person\.(alert|match|known|unknown|tracked)|face\.|activity\.(watchlist|stranger))/;
const isFaceEvent = (eventType) => FACE_RE.test(String(eventType || '').toLowerCase());

/**
 * Is `payload.matchedName` a person? True for face events, or when a real
 * person id is attached. The zone guard writes personId "zone:<id>" and
 * matchedName "1 person" purely to key its alert dedup.
 */
function isPersonSubject(evt) {
  const p = evt?.payload && typeof evt.payload === 'object' ? evt.payload : {};
  if (isFaceEvent(evt?.eventType)) return true;
  return Boolean(p.personId) && !/^zone:/i.test(String(p.personId)) && !p.zoneName;
}

/** The one-line "what exactly" under the event type: which zone, who, how many. */
function eventDetail(evt) {
  const p = evt?.payload && typeof evt.payload === 'object' ? evt.payload : {};
  const subject = p.matchedName ? String(p.matchedName).trim() : null;
  const person = isPersonSubject(evt);
  const bits = [];
  if (p.zoneName) bits.push(`Zone: ${p.zoneName}`);
  if (subject) {
    bits.push(person && (p.role === 'blacklist' || p.kind === 'alert') ? `${subject} · Watchlist` : subject);
  } else if (p.kind === 'unknown') {
    bits.push('Face not enrolled');
  }
  if (!subject) {
    if (p.count != null && p.capacity != null) bits.push(`${p.count} of ${p.capacity} capacity`);
    else if (p.count != null) bits.push(`${p.count} ${Number(p.count) === 1 ? 'person' : 'people'}`);
  }
  if (p.level) bits.push(`Level ${String(p.level).toUpperCase()}`);
  if (p.plate) bits.push(String(p.plate));
  return bits.length ? bits.join(' · ') : null;
}

// Severity on paper. `info` is informational, not "low risk", so it is grey —
// the product never paints routine traffic green.
const SEVERITY = {
  critical: { key: 'high', label: 'High', dot: '#DC2626', ink: '#B91C1C' },
  warning:  { key: 'medium', label: 'Medium', dot: '#F59E0B', ink: '#B45309' },
  info:     { key: 'info', label: 'Info', dot: '#94A3B8', ink: '#475569' },
};
const severityOf = (s) => SEVERITY[String(s || 'info').toLowerCase()] || SEVERITY.info;

const TYPE_CODE = {
  ai_events: 'AER', face: 'FDR', occupancy: 'COR', restricted_area: 'RAR',
  camera_health: 'CHR', recording: 'RCR', incident: 'INC', custom: 'CUS',
};

/**
 * A report number people can read out loud: DR-AER-20260918-4F2A. Derived from
 * the row, so it is stable across exports and unique enough on one account.
 */
function reportCode(row, tz) {
  const code = TYPE_CODE[row?.type] || 'RPT';
  const d = localParts(row?.createdAt || new Date(), tz);
  const ymd = `${d.year}${String(d.month + 1).padStart(2, '0')}${String(d.day).padStart(2, '0')}`;
  const tail = String(row?.id || '').replace(/-/g, '').slice(0, 4).toUpperCase() || 'PREV';
  return `DR-${code}-${ymd}-${tail}`;
}

/* ───────────────────────────── time ───────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TZ_NAMES = { '+05:30': 'IST', '+04:00': 'GST', '+00:00': 'UTC', '+08:00': 'SGT', '+03:00': 'AST' };

function offsetMinutes(tz) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(tz || '+00:00').trim());
  if (!m) return 0;
  const min = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -min : min;
}

function localParts(d, tz) {
  const t = new Date(d).getTime() + offsetMinutes(tz) * 60000;
  const l = new Date(t);
  return {
    year: l.getUTCFullYear(), month: l.getUTCMonth(), day: l.getUTCDate(),
    hour: l.getUTCHours(), minute: l.getUTCMinutes(), second: l.getUTCSeconds(),
  };
}

function fmtDate(d, tz) {
  if (!d) return '—';
  const p = localParts(d, tz);
  return `${p.day} ${MONTHS[p.month]} ${p.year}`;
}

function fmtTime(d, tz, { seconds = true } = {}) {
  if (!d) return '—';
  const p = localParts(d, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const hh = String(h12).padStart(2, '0');
  const mi = String(p.minute).padStart(2, '0');
  const ss = String(p.second).padStart(2, '0');
  return `${hh}:${mi}${seconds ? `:${ss}` : ''} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

const fmtDateTime = (d, tz, o) => (d ? `${fmtDate(d, tz)}, ${fmtTime(d, tz, o)}` : '—');

function fmtPeriod(from, to, tz) {
  const a = fmtDate(from, tz);
  const b = fmtDate(to, tz);
  return a === b ? a : `${a} – ${b}`;
}

/** "11 Sep 2026" → "11-09-2026 16:03:12" — the CCTV-style burn-in on evidence stills. */
function fmtOsd(d, tz) {
  const p = localParts(d, tz);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(p.day)}-${two(p.month + 1)}-${p.year} ${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

function tzLabel(tz) {
  const norm = /^([+-])(\d{2}):?(\d{2})$/.exec(String(tz || '+00:00').trim());
  const canon = norm ? `${norm[1]}${norm[2]}:${norm[3]}` : '+00:00';
  return TZ_NAMES[canon] ? `${TZ_NAMES[canon]} · UTC ${canon}` : `UTC ${canon}`;
}

const nf = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));

const pct = (v) => (v == null || Number.isNaN(Number(v)) ? null
  : `${Math.round(Number(v) <= 1 ? Number(v) * 100 : Number(v))}%`);

module.exports = {
  EVENT_LABELS, eventLabel, eventDetail, isFaceEvent, isPersonSubject, SEVERITY, severityOf, reportCode,
  offsetMinutes, localParts, fmtDate, fmtTime, fmtDateTime, fmtPeriod, fmtOsd, tzLabel, nf, pct,
};
