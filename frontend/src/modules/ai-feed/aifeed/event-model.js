/**
 * event-model.js — the one vocabulary the unified AI Feed speaks.
 *
 * The backend emits `eventType` slugs from several detectors (face worker,
 * zone guard, occupancy evaluator, stampede, head-count, ANPR…). This file
 * folds every slug into ONE shape the page can group, filter, colour and
 * describe without knowing which detector produced it:
 *
 *   {
 *     id, ts, monitorId,
 *     type,        canonical slug ('zone.intrusion', 'vehicle.lpr', …)
 *     category,    'perimeter' | 'crowd' | 'faces' | 'vehicles' | 'more'
 *     severity,    'high' | 'medium' | 'info'            ← drives colour
 *     tone,        'danger' | 'warning' | 'neutral'   ← derived from severity only
 *     title,       'Restricted Zone Entry'
 *     detail,      'DL-01-MJ-8821' | '14 people detected' | 'Aastha · 94%'
 *     model,       'Restricted Zone Detection'
 *     iconName,    lucide icon NAME (resolved by the component)
 *     bbox,        [x1,y1,x2,y2] on the inference frame, or null
 *     frame,       { w, h } of that frame, when known
 *     snapshot,    { src } | null  — image URL the thumbnail can crop
 *     subject,     person name / plate / count, when there is one
 *     confidence,  0..100 or null
 *     raw,         the backend row, for the drawer's actions
 *   }
 *
 * Colour is SEVERITY, never category, and only two severities carry one: HIGH
 * is red and MEDIUM is amber. Everything informational stays in the neutral
 * greys of the Drishyam palette, with orange reserved for the brand, selection
 * and active controls — so a page full of ordinary detections stays calm.
 */

import { aiService } from '@/core/services/ai';

// ── Categories — the filter tabs ─────────────────────────────────────────────
export const CATEGORIES = [
  { id: 'all',       label: 'All Events' },
  { id: 'perimeter', label: 'Perimeter & Safety' },
  { id: 'crowd',     label: 'Crowd & Count' },
  { id: 'faces',     label: 'Faces' },
  { id: 'vehicles',  label: 'Vehicles / ANPR' },
];

// The "More AI" dropdown. Each entry is a sub-filter on the `more` category
// (or, for tracking, on the faces category) keyed by the model that produced
// the event.
export const MORE_AI = [
  { id: 'weapon',     label: 'Weapon Detection' },
  { id: 'aggression', label: 'Aggression Detection' },
  { id: 'ppe',        label: 'PPE Detection' },
  { id: 'object',     label: 'Object Left Behind' },
  { id: 'tracking',   label: 'Person Tracking' },
  { id: 'other',      label: 'Other AI Events' },
];

export const SEVERITIES = [
  { id: 'high',   label: 'High',   tone: 'danger'  },
  { id: 'medium', label: 'Medium', tone: 'warning' },
  { id: 'info',   label: 'Info',   tone: 'neutral' },
];

export const SEVERITY_RANK = { high: 3, medium: 2, info: 1 };
export const SEVERITY_TONE = { high: 'danger', medium: 'warning', info: 'neutral' };

// ── Type registry ────────────────────────────────────────────────────────────
// One row per backend slug. `more` is the sub-filter id for the More AI menu.
// Severity here is the DEFAULT; the backend's own `severity: critical` still
// upgrades an event to high (see normalizeEvent).
const T = (category, severity, title, model, iconName, extra = {}) => ({
  category, severity, title, model, iconName, ...extra,
});

export const EVENT_TYPES = {
  // Perimeter & safety
  'zone.intrusion':   T('perimeter', 'high', 'Restricted Zone Entry',    'Restricted Zone Detection', 'ShieldAlert'),
  'zone.entry':       T('perimeter', 'high', 'Restricted Zone Entry',    'Restricted Zone Detection', 'ShieldAlert'),
  'perimeter.breach': T('perimeter', 'high', 'Perimeter Intrusion',      'Perimeter Intrusion',       'Fence'),
  'line.cross':       T('perimeter', 'high', 'Perimeter Line Crossing',  'Line Crossing',             'GitBranch'),
  'tripwire.entry':   T('perimeter', 'info', 'Line Crossed · In',        'Line Crossing',             'LogIn'),
  'tripwire.exit':    T('perimeter', 'info', 'Line Crossed · Out',       'Line Crossing',             'LogOut'),
  'loitering':        T('perimeter', 'medium', 'Loitering',                'Loitering Detection',       'Clock'),
  'weapon.detected':  T('more', 'high', 'Weapon Detected',          'Weapon Detection',          'Crosshair',   { more: 'weapon' }),
  'aggression':       T('more', 'high', 'Aggression Detected',      'Aggression Detection',      'Swords',      { more: 'aggression' }),
  'fire.detected':    T('more', 'high', 'Fire Detected',            'Fire & Smoke Detection',    'Flame',       { more: 'other' }),
  'ppe.violation':    T('more', 'medium', 'PPE Violation',            'PPE Compliance',            'HardHat',     { more: 'ppe' }),
  'object.left':      T('more', 'medium', 'Object Left Behind',       'Abandoned Object',          'PackageSearch', { more: 'object' }),
  'object.removed':   T('more', 'medium', 'Object Removed',           'Object Removal',            'PackageX',    { more: 'object' }),

  // Crowd & count — medium when it is a threshold, info when it is a count
  'crowd.density':       T('crowd', 'medium', 'High Crowd Density',   'Crowd Density',      'UsersRound'),
  'crowd.formed':        T('crowd', 'medium', 'Crowd Forming',        'Crowd Density',      'UsersRound'),
  'crowd.stampede':      T('crowd', 'high', 'Crowd Surge',          'Stampede Detection', 'UsersRound'),
  // The third field names the MODEL that raised the event, not the navigation
  // module. So these three keep "Occupancy & Flow" although the sidebar group
  // is now "Footfall & Occupancy": they sit beside "Crowd Density", "Head
  // Count" and "Line Crossing", which are detectors too. Renaming them to
  // match the nav would make this column mean two different things.
  'occupancy.threshold': T('crowd', 'medium', 'Occupancy Exceeded',   'Occupancy & Flow',   'Users'),
  'occupancy.warning':   T('crowd', 'medium', 'Nearing Capacity',     'Occupancy & Flow',   'Users'),
  'occupancy.cleared':   T('crowd', 'info', 'Back Under Capacity',  'Occupancy & Flow',   'Users'),
  'person.headcount':    T('crowd', 'info', 'Person Headcount',     'Head Count',         'Users'),
  'person.detected':     T('crowd', 'info', 'Person Detected',      'Person Detection',   'PersonStanding'),

  // Faces — info, except the watchlist hit
  'person.match':    T('faces', 'info', 'Recognized Face',   'Face Recognition', 'UserCheck'),
  'match':           T('faces', 'info', 'Recognized Face',   'Face Recognition', 'UserCheck'),
  'person.unknown':  T('faces', 'info', 'Face Detected',     'Face Detection',   'ScanFace'),
  'unknown':         T('faces', 'info', 'Face Detected',     'Face Detection',   'ScanFace'),
  'face.detected':   T('faces', 'info', 'Face Detected',     'Face Detection',   'ScanFace'),
  'person.alert':    T('faces', 'high', 'Watchlist Match',   'Face Recognition', 'ShieldAlert'),
  'alert':           T('faces', 'high', 'Watchlist Match',   'Face Recognition', 'ShieldAlert'),
  'person.tracked':  T('faces', 'info', 'Person Tracked',    'Person Tracking',  'Footprints', { more: 'tracking' }),

  // Vehicles
  'vehicle.detected': T('vehicles', 'info', 'Vehicle Detected', 'Vehicle Detection', 'Car'),
  'vehicle.lpr':      T('vehicles', 'info', 'ANPR Detected',    'ANPR / Licence Plate', 'CarFront'),
  'anpr.plate':       T('vehicles', 'info', 'ANPR Detected',    'ANPR / Licence Plate', 'CarFront'),

  // Attendance + policy alerts from the activity-monitor service. That service
  // speaks {kind, type} ("attendance"/"in", "alert"/"after_hours") rather than
  // event slugs; the Event Log page mints these when it folds its timeline in
  // (modules/event-log/eventlog/log-model.js). They live here, not there,
  // because one vocabulary for "what the AI saw" is the whole point of this
  // file — a second registry is how the two pages start disagreeing.
  'attendance.in':        T('faces', 'info',   'Attendance · In',          'Attendance (Line Crossing)', 'LogIn'),
  'attendance.out':       T('faces', 'info',   'Attendance · Out',         'Attendance (Line Crossing)', 'LogOut'),
  'activity.watchlist':   T('faces', 'high',   'Watchlist Match',          'Activity Monitoring', 'ShieldAlert'),
  'activity.stranger':    T('faces', 'medium', 'Unknown Person Dwelling',  'Activity Monitoring', 'ScanFace'),
  'activity.after_hours': T('more', 'medium',  'After-Hours Presence',     'Activity Monitoring', 'Clock', { more: 'other' }),
  // Store-floor policy alerts (retail / corporate): staffing, coverage, queues.
  'activity.late_arrival':       T('more', 'medium', 'Late Arrival',        'Activity Monitoring', 'Clock',      { more: 'other' }),
  'activity.phone_use':          T('more', 'medium', 'Phone Use on Floor',  'Activity Monitoring', 'Smartphone', { more: 'other' }),
  'activity.break_overstay':     T('more', 'medium', 'Break Overstayed',    'Activity Monitoring', 'Coffee',     { more: 'other' }),
  'activity.counter_unattended': T('more', 'high',   'Counter Unattended',  'Activity Monitoring', 'MonitorX',   { more: 'other' }),
  'activity.low_activity':       T('more', 'medium', 'Low Staff Activity',  'Activity Monitoring', 'EyeOff',     { more: 'other' }),
  'activity.group_gathering':    T('more', 'medium', 'Staff Group Gathering', 'Activity Monitoring', 'UsersRound', { more: 'other' }),
  'activity.loitering':          T('more', 'medium', 'Staff Loitering',     'Activity Monitoring', 'Clock',      { more: 'other' }),
  'activity.queue_exceeded':     T('crowd', 'high',  'Queue Limit Exceeded', 'Activity Monitoring', 'UsersRound'),

  // System facts
  'camera.offline': T('more', 'medium', 'Camera Offline', 'Stream Supervisor', 'WifiOff', { more: 'other' }),
  'camera.online':  T('more', 'info', 'Camera Online',  'Stream Supervisor', 'Wifi',    { more: 'other' }),
};

const FALLBACK_TYPE = T('more', 'info', 'AI Event', 'AI Detection', 'Activity', { more: 'other' });

const BACKEND_SEVERITY = { critical: 'high', warning: 'medium', info: 'info' };

function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readBbox(evt) {
  const b = evt.bbox || evt.payload?.bbox || null;
  if (Array.isArray(b) && b.length >= 4) return b.slice(0, 4).map(Number);
  if (b && typeof b === 'object') {
    const arr = [b.x1 ?? b.left, b.y1 ?? b.top, b.x2 ?? b.right, b.y2 ?? b.bottom].map(Number);
    if (arr.every(Number.isFinite)) return arr;
  }
  return null;
}

function readFrame(evt) {
  const p = evt.payload || {};
  const w = num(p.frame_w ?? p.frameW ?? evt.frame_w);
  const h = num(p.frame_h ?? p.frameH ?? evt.frame_h);
  return w && h ? { w, h } : null;
}

function readSnapshot(evt) {
  // vms_face mirrors ship an s3:// crop (already the face); backend rows have
  // an S3 key that needs a signed URL, resolved lazily by the thumbnail.
  const uri = evt.snapshot_uri || evt.payload?.snapshotUri || null;
  if (uri) {
    const src = aiService.snapshotSrc(uri);
    if (src) return { src, cropped: true };
  }
  if (evt.snapshotUrl) return { src: evt.snapshotUrl, cropped: false };
  if (evt.snapshotKey && evt.id) return { src: null, eventId: evt.id, cropped: false };
  return null;
}

/**
 * Fold one backend row into the unified shape. `cameras` is a monitorId →
 * { name, location, siteId } index used for labels.
 */
export function normalizeEvent(evt, cameras = {}) {
  if (!evt) return null;
  const rawType = String(evt.eventType || evt.kind || evt.action || '').toLowerCase();
  const meta = EVENT_TYPES[rawType] || FALLBACK_TYPE;
  const monitorId = evt.monitorId || evt.camera_code || evt.cameraCode || evt.camera_id || '';
  const cam = cameras[monitorId] || null;
  const p = evt.payload || {};

  // The backend's own grading wins upward only — a detector may escalate a
  // default-info event, never demote a high one.
  const backendSeverity = BACKEND_SEVERITY[String(evt.severity || '').toLowerCase()] || null;
  const severity = backendSeverity && SEVERITY_RANK[backendSeverity] > SEVERITY_RANK[meta.severity]
    ? backendSeverity
    : meta.severity;
  const tone = SEVERITY_TONE[severity];

  const matched = p.matchedName ?? evt.person_name ?? evt.name ?? evt.full_name ?? null;
  const isUnknown = !matched || /^unknown$/i.test(String(matched));
  const plate = p.plate ?? p.licensePlate ?? p.license_plate ?? evt.plate ?? null;
  const count = num(p.count ?? p.people ?? p.persons ?? p.total ?? evt.count);
  const confidence = pct(evt.confidence ?? evt.similarity ?? p.confidence);

  let subject = null;
  let detail = '';
  if (meta.category === 'faces') {
    subject = isUnknown ? 'Unknown person' : String(matched);
    detail = confidence != null ? `${subject} · ${confidence}%` : subject;
  } else if (meta.category === 'vehicles') {
    subject = plate ? String(plate).toUpperCase() : (p.vehicleType || 'Vehicle');
    detail = plate ? String(plate).toUpperCase() : (p.vehicleType ? `${p.vehicleType} detected` : 'Vehicle detected');
  } else if (meta.category === 'crowd') {
    subject = count != null ? `${count} people` : null;
    detail = count != null
      ? `${count} people${p.capacity ? ` · capacity ${p.capacity}` : ''}`
      : (p.zoneName || p.spaceName || '');
  } else {
    subject = p.zoneName || p.zone_name || p.label || null;
    detail = p.zoneName || p.zone_name
      ? `Zone · ${p.zoneName || p.zone_name}`
      : (p.description || p.className || p.label || '');
  }

  const ts = new Date(evt.ts || evt.occurred_at || evt.timestamp || evt.createdAt || Date.now());

  return {
    id: String(evt.id || `${monitorId}-${ts.getTime()}-${rawType}`),
    ts,
    monitorId,
    cameraName: cam?.name || evt.camera_name || p.camera_name || 'Unnamed camera',
    location: cam?.location || evt.groupName || '',
    siteId: cam?.siteId || null,
    type: rawType || 'ai.event',
    category: meta.category,
    more: meta.more || null,
    severity,
    tone,
    title: meta.title,
    detail,
    model: meta.model,
    iconName: meta.iconName,
    bbox: readBbox(evt),
    frame: readFrame(evt),
    snapshot: readSnapshot(evt),
    subject,
    isUnknown,
    plate: plate ? String(plate).toUpperCase() : null,
    count,
    confidence,
    zoneName: p.zoneName || p.zone_name || null,
    trackId: evt.trackId || evt.track_id || null,
    acknowledged: Boolean(evt.acknowledgedAt),
    raw: evt,
  };
}

/** Does the event fall inside the category tab / More AI sub-filter? */
export function matchesFilter(evt, filter) {
  if (!filter || filter === 'all') return true;
  if (CATEGORIES.some((c) => c.id === filter)) return evt.category === filter;
  // More AI sub-filters
  if (filter === 'tracking') return evt.more === 'tracking';
  if (filter === 'other') return evt.category === 'more' && (!evt.more || evt.more === 'other');
  return evt.more === filter;
}

/** Counts for every filter tab and menu entry, from one pass. */
export function countByFilter(events) {
  const counts = { all: events.length };
  for (const c of CATEGORIES) if (c.id !== 'all') counts[c.id] = 0;
  for (const m of MORE_AI) counts[m.id] = 0;
  for (const e of events) {
    if (counts[e.category] != null) counts[e.category] += 1;
    if (e.more && counts[e.more] != null) counts[e.more] += 1;
    else if (e.category === 'more') counts.other += 1;
  }
  return counts;
}

export function countBySeverity(events) {
  const out = { high: 0, medium: 0, info: 0 };
  for (const e of events) out[e.severity] = (out[e.severity] || 0) + 1;
  return out;
}

/**
 * Per-camera roll-up for the grid: the latest event, the distinct AI types
 * seen, the highest severity and the count inside the window. The card shows
 * ONE headline chip and "N AI events" instead of one chip per detection.
 */
export function summarizeCamera(events) {
  if (!events.length) return null;
  const latest = events[0];
  let top = latest;
  const types = new Map();
  for (const e of events) {
    if (SEVERITY_RANK[e.severity] > SEVERITY_RANK[top.severity]) top = e;
    if (!types.has(e.title)) types.set(e.title, e);
  }
  return {
    latest,
    headline: SEVERITY_RANK[top.severity] > SEVERITY_RANK[latest.severity] ? top : latest,
    severity: top.severity,
    types: Array.from(types.values()),
    count: events.length,
    lastTs: latest.ts,
  };
}

/** Time-range options for the header. `ms` is the lookback window. */
export const TIME_RANGES = [
  { id: '15m', label: 'Last 15 min', ms: 15 * 60_000 },
  { id: '1h',  label: 'Last hour',   ms: 60 * 60_000 },
  { id: '4h',  label: 'Last 4 hours', ms: 4 * 60 * 60_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
];

export const GROUP_MODES = [
  { id: 'recent',   label: 'Recent Activity' },
  { id: 'location', label: 'Location' },
  { id: 'threat',   label: 'Threat Level' },
  { id: 'aitype',   label: 'AI Type' },
];

/**
 * The location line under a camera name — unless the name already says it
 * ("Main Gate - Entrance" under "Main Gate" reads twice), in which case
 * nothing, so the row stays one line shorter.
 */
export function locationLabel(name, location) {
  if (!location) return '';
  const n = String(name || '').toLowerCase();
  const l = String(location).toLowerCase();
  return n.includes(l) ? '' : location;
}

export function fmtClock(date) {
  try {
    return new Date(date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toUpperCase();
  } catch {
    return '—';
  }
}

export function fmtRelative(date, now = Date.now()) {
  const d = (now - new Date(date).getTime()) / 1000;
  if (d < 5) return 'just now';
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
