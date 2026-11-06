/**
 * log-query.js — the Event Log's URL contract, and the operational categories.
 *
 * Other pages deep-link into /event-logs already scoped (the Activity
 * Monitoring dashboard's "View all in Event Log", Zone Coverage's status
 * badges, the omnibox, module dashboards). This file is the one place that
 * contract is written down, in both directions: `eventLogHref` builds a link,
 * `parseLogParams` reads one.
 *
 *   ?siteId=  (alias ?site=)  camera-group id — what this page calls a site
 *   ?zoneId=  floor zone or counter, by name ("Apparel", "Billing 3")
 *   ?eventType= UNATTENDED | QUEUE | PHONE | LATE | BREAK | LOW_ACTIVITY
 *               (or a raw slug, e.g. activity.counter_unattended)
 *   ?status=  ACTIVE | UNACKNOWLEDGED | ACKNOWLEDGED
 *   ?category= COVERAGE | QUEUE | STAFF | SYSTEM
 *   ?view=    VIOLATIONS | QUEUE | SYSTEM      the quick-filter pill
 *   ?violation= PHONE | UNATTENDED | IDLE | GATHERING
 *   ?severity= HIGH | MEDIUM | LOW   (LOW is this log's "info")
 *   ?date= YYYY-MM-DD   ?camera= monitorId   ?q= free text
 *
 * Params are case-insensitive, and anything unrecognised reads as "all" — a
 * stale or hand-edited link must widen the view, never empty it silently.
 * Pure (no React, no '@/' imports) so `npm test` can check it.
 */

// ── Categories — the operational view of an event ─────────────────────────────
// The same four buckets the Activity Monitoring dashboard sorts its "Needs
// Attention" alerts into, so a link from a filtered card lands on the same set.
// AI detections with no operational bucket (faces, vehicles, perimeter) have
// no category: they show under "All" and drop out when a category is chosen.
export const CATEGORIES = [
  { id: 'coverage', label: 'Coverage' },
  { id: 'queue',    label: 'Queue' },
  { id: 'staff',    label: 'Staff' },
  { id: 'system',   label: 'System' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

const CATEGORY_OF_TYPE = {
  'activity.counter_unattended': 'coverage',
  'activity.low_activity':       'coverage',
  'activity.queue_exceeded':     'queue',
  'activity.late_arrival':       'staff',
  'activity.phone_use':          'staff',
  'activity.break_overstay':     'staff',
  'activity.group_gathering':    'staff',
  'activity.loitering':          'staff',
  'attendance.in':               'staff',
  'attendance.out':              'staff',
};

/** The operational category of a normalized event, or null. */
export function categoryOf(evt) {
  const t = String(evt?.type || '');
  if (CATEGORY_OF_TYPE[t]) return CATEGORY_OF_TYPE[t];
  if (t.startsWith('camera.') || t.startsWith('system.') || t.startsWith('stream.')) return 'system';
  return null;
}

// ── Staff violations — the four things a floor manager acts on ───────────────
// The detectors speak slugs (`activity.break_overstay`); a manager thinks in
// four kinds of lapse. Each kind names the lapse the way it is said out loud,
// and each slug carries the short badge the table shows beside the event.
//
// Tone is the badge colour, and follows what the lapse costs: an UNATTENDED
// station is a customer nobody is serving (red, and the detector already
// grades it high); the others are conduct to raise with the person (amber).
//
// Late arrival and clock-in/out are staff events but not violations on the
// floor, so they stay out of this list and show under All Activity.
export const VIOLATIONS = [
  { id: 'phone',      label: 'Phone Usage on Floor',        tone: 'warning' },
  { id: 'unattended', label: 'Unattended Counter / Desk',   tone: 'danger' },
  { id: 'idle',       label: 'Over-Break / Excessive Idle', tone: 'warning' },
  { id: 'gathering',  label: 'Group Gathering / Loitering', tone: 'warning' },
];
const VIOLATION_KIND = Object.fromEntries(VIOLATIONS.map((v) => [v.id, v]));

const VIOLATION_OF_TYPE = {
  'activity.phone_use':          { kind: 'phone',      badge: 'Phone Usage' },
  'activity.counter_unattended': { kind: 'unattended', badge: 'Unattended Station' },
  'activity.break_overstay':     { kind: 'idle',       badge: 'Over-Break' },
  'activity.low_activity':       { kind: 'idle',       badge: 'Excessive Idle' },
  'activity.group_gathering':    { kind: 'gathering',  badge: 'Group Gathering' },
  'activity.loitering':          { kind: 'gathering',  badge: 'Loitering' },
};

/**
 * The staff violation a normalized event represents, or null:
 * `{ kind, label, badge, tone }` — `label` is the filter's name for the kind,
 * `badge` the short word for this particular event.
 */
export function violationOf(evt) {
  const hit = VIOLATION_OF_TYPE[String(evt?.type || '')];
  if (!hit) return null;
  const kind = VIOLATION_KIND[hit.kind];
  return { kind: hit.kind, label: kind.label, badge: hit.badge, tone: kind.tone };
}

// ── Quick views — the pill row over the log ──────────────────────────────────
// Four answers to "what am I here to look at". A view narrows on top of every
// other filter, so the pill counts and the table always agree.
export const VIEWS = [
  { id: 'all',        label: 'All Activity' },
  { id: 'violations', label: 'Staff Violations' },
  { id: 'queue',      label: 'Queue Alerts' },
  { id: 'system',     label: 'System Events' },
];
const VIEW_IDS = new Set(VIEWS.map((v) => v.id));

export function viewMatches(evt, view) {
  switch (view) {
    case 'violations': return violationOf(evt) !== null;
    case 'queue':      return categoryOf(evt) === 'queue';
    case 'system':     return categoryOf(evt) === 'system';
    default:           return true;
  }
}

// ── Event type — the short name a LINK uses ──────────────────────────────────
// A deep link should read `?eventType=UNATTENDED`, not
// `?eventType=activity.counter_unattended`: the first survives being pasted
// into a ticket, and it is the word the operator would say out loud. The slug
// stays canonical inside the app; this is only the spelling on the wire.
//
// A raw slug is still accepted, so any type the detector vocabulary gains
// links correctly on the day it ships, without an entry here.
const EVENT_TYPE_IN = {
  UNATTENDED:         'activity.counter_unattended',
  COUNTER_UNATTENDED: 'activity.counter_unattended',
  ZONE_UNATTENDED:    'activity.counter_unattended',
  LOW_ACTIVITY:       'activity.low_activity',
  COVERAGE_LOW:       'activity.low_activity',
  QUEUE:              'activity.queue_exceeded',
  QUEUE_EXCEEDED:     'activity.queue_exceeded',
  PHONE:              'activity.phone_use',
  PHONE_USE:          'activity.phone_use',
  LATE:               'activity.late_arrival',
  LATE_ARRIVAL:       'activity.late_arrival',
  BREAK:              'activity.break_overstay',
  BREAK_OVERSTAY:     'activity.break_overstay',
};

const EVENT_TYPE_OUT = Object.fromEntries(
  // First alias wins, so the shortest spelling is the one a link carries.
  Object.entries(EVENT_TYPE_IN).reverse().map(([word, slug]) => [slug, word]),
);

// Slug → the words a person reads. The table gets its labels from the events
// themselves (each normalized event carries a `title`), so this is only needed
// where there is no event to read them off: a chip or a dropdown describing a
// type that a LINK asked for but the current day happens not to contain.
// Without it those surfaces printed the raw slug at the operator.
const EVENT_TYPE_LABELS = {
  'activity.counter_unattended': 'Counter Unattended',
  'activity.low_activity':       'Low Staff Activity',
  'activity.queue_exceeded':     'Queue Exceeded',
  'activity.phone_use':          'Phone Use',
  'activity.late_arrival':       'Late Arrival',
  'activity.break_overstay':     'Break Overstay',
  'activity.group_gathering':    'Staff Group Gathering',
  'activity.loitering':          'Staff Loitering',
  'attendance.in':              'Clock-in',
  'attendance.out':              'Clock-out',
};

/**
 * A readable name for a type slug. An unlisted slug is prettified rather than
 * printed raw, so a detector added to the vocabulary tomorrow still reads as
 * "Zone intrusion" here and not as "zone.intrusion".
 */
export function eventTypeLabel(slug) {
  if (!slug || slug === 'all') return 'All Event Types';
  if (EVENT_TYPE_LABELS[slug]) return EVENT_TYPE_LABELS[slug];
  const tail = String(slug).split('.').pop().replace(/_/g, ' ').trim();
  return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : String(slug);
}

/** URL spelling → canonical type slug. Unknown reads as 'all'. */
export function parseEventType(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.toLowerCase() === 'all') return 'all';
  // A dotted value is already a slug — pass it through untouched.
  if (raw.includes('.')) return raw;
  return EVENT_TYPE_IN[raw.toUpperCase().replace(/[\s-]+/g, '_')] || 'all';
}

// ── Zone — the place, not the camera ─────────────────────────────────────────
/**
 * The zone a normalized event happened in.
 *
 * `zoneName` is the real field (event-model reads it off `payload.zoneName`),
 * and it is what an exact match should use. Until every emitter stamps it,
 * the fall-backs are the other fields that name a place: the camera's group,
 * the camera's own name (cameras are usually named for where they point), and
 * the detail sentence, which for store-floor alerts reads "Billing 3
 * unattended — no staff detected".
 *
 * The fall-backs are why matching is a case-insensitive SUBSTRING and not an
 * equality test: "Apparel" has to find "Apparel Zone" and "Phone in hand 48s —
 * Apparel". It is deliberately generous, because the alternative for a zone
 * link is returning nothing and looking broken.
 */
export function zoneOf(evt) {
  return evt?.zoneName || evt?.location || evt?.cameraName || '';
}

export function zoneMatches(evt, zone) {
  const want = String(zone || '').trim().toLowerCase();
  if (!want || want === 'all') return true;
  if (evt?.zoneName) return String(evt.zoneName).toLowerCase().includes(want);
  return [evt?.location, evt?.cameraName, evt?.detail, evt?.title]
    .some((field) => field && String(field).toLowerCase().includes(want));
}

// ── URL → filter state ───────────────────────────────────────────────────────
// ACTIVE is the word the operational pages use for "still open" — Zone
// Coverage calls an incident active, this page calls the row unacknowledged.
// Same state, two vocabularies, mapped here rather than at each call site.
const STATUS_IN = {
  UNACKNOWLEDGED: 'new', NEW: 'new', OPEN: 'new', ACTIVE: 'new', UNRESOLVED: 'new',
  ACKNOWLEDGED: 'acknowledged', ACKED: 'acknowledged', RESOLVED: 'acknowledged',
};
const SEVERITY_IN = { HIGH: 'high', CRITICAL: 'high', MEDIUM: 'medium', WARNING: 'medium', LOW: 'info', INFO: 'info' };
const VIOLATION_IDS = new Set(VIOLATIONS.map((v) => v.id));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filter state seeded from a URL. `today` is the fallback day (YYYY-MM-DD) —
 * a malformed ?date= must not become a 1970-to-now query.
 * @param {URLSearchParams} params
 */
export function parseLogParams(params, today) {
  const up = (k) => String(params.get(k) || '').trim().toUpperCase();
  const category = String(params.get('category') || '').trim().toLowerCase();
  const violation = String(params.get('violation') || '').trim().toLowerCase();
  const view = String(params.get('view') || '').trim().toLowerCase();
  const date = params.get('date') || '';
  return {
    date: DAY.test(date) ? date : today,
    site: params.get('siteId') || params.get('site') || 'all',
    camera: params.get('camera') || 'all',
    zone: (params.get('zoneId') || params.get('zone') || '').trim() || 'all',
    type: parseEventType(params.get('eventType') || params.get('type')),
    query: params.get('q') || '',
    status: STATUS_IN[up('status')] || 'all',
    category: CATEGORY_IDS.has(category) ? category : 'all',
    severity: SEVERITY_IN[up('severity')] || 'all',
    violation: VIOLATION_IDS.has(violation) ? violation : 'all',
    // A violation kind is only reachable under Staff Violations, so a link
    // naming one opens that view even when it does not say so.
    view: VIOLATION_IDS.has(violation) ? 'violations' : (VIEW_IDS.has(view) ? view : 'all'),
  };
}

// ── Filter state → URL ───────────────────────────────────────────────────────
const STATUS_OUT = { new: 'UNACKNOWLEDGED', acknowledged: 'ACKNOWLEDGED' };
const SEVERITY_OUT = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'LOW' };

/**
 * A link into the Event Log. Values may be given in either vocabulary
 * ('UNACKNOWLEDGED' or 'new', 'QUEUE' or 'queue'); "all" / empty are omitted.
 *
 * The key order below is the order the query string comes out in, and it is
 * fixed on purpose: two callers asking for the same scope must produce the
 * same string, or the same view arrives under two URLs.
 *
 * @param {{ siteId?: string, zoneId?: string, camera?: string, eventType?: string,
 *           status?: string, category?: string, severity?: string, view?: string,
 *           violation?: string, date?: string, q?: string }} [o]
 */
export function eventLogHref({
  siteId, zoneId, camera, eventType, status, category, severity, view, violation, date, q,
} = {}) {
  const qs = new URLSearchParams();
  const skip = (v) => !v || String(v).toLowerCase() === 'all';
  if (!skip(siteId)) qs.set('siteId', siteId);
  if (!skip(zoneId)) qs.set('zoneId', zoneId);
  if (!skip(camera)) qs.set('camera', camera);
  // A word this file does not know is dropped rather than written through:
  // an unrecognised ?eventType= reads as "all" on arrival, so emitting one
  // would be a link that promises a filter it cannot apply.
  const typeSlug = skip(eventType) ? 'all' : parseEventType(eventType);
  if (typeSlug !== 'all') qs.set('eventType', EVENT_TYPE_OUT[typeSlug] || typeSlug);
  if (!skip(status)) qs.set('status', STATUS_OUT[String(status).toLowerCase()] || String(status).toUpperCase());
  if (!skip(category)) qs.set('category', String(category).toUpperCase());
  if (!skip(severity)) qs.set('severity', SEVERITY_OUT[String(severity).toLowerCase()] || String(severity).toUpperCase());
  // Same rule as eventType: only values this file can read back are written.
  const violationId = String(violation || '').toLowerCase();
  const viewId = VIOLATION_IDS.has(violationId) ? 'violations' : String(view || '').toLowerCase();
  if (VIEW_IDS.has(viewId) && viewId !== 'all') qs.set('view', viewId.toUpperCase());
  if (VIOLATION_IDS.has(violationId)) qs.set('violation', violationId.toUpperCase());
  if (!skip(date)) qs.set('date', date);
  if (q) qs.set('q', q);
  const s = qs.toString();
  return s ? `/event-logs?${s}` : '/event-logs';
}
