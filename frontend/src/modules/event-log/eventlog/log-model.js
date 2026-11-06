/**
 * log-model.js — what the Event Log knows that the AI Feed does not.
 *
 * The AI Feed answers "what is happening right now"; this page answers "what
 * happened, and can I prove it". Same events, different job — so it reuses the
 * AI vocabulary wholesale (event-model.js: title, model, severity, icon) and
 * adds only the three things a RECORD needs and a live monitor does not:
 *
 *   SOURCE   which part of the system emitted the row — AI, Security, a user's
 *            action, or the platform itself. This is the tab strip.
 *   STATUS   has a human dealt with it yet.
 *   EXPORT   the CSV shape, so a log can leave the product as evidence.
 *
 * Only the AI source has data today. User Activity and System Events are
 * declared here, and shown as tabs, because the page is built around all four
 * from the start — but each carries an honest empty state naming what has to
 * exist for it to fill, rather than a plausible-looking fake row:
 *
 *   User Activity  needs a tenant audit table. `utils/audit.js` writes a
 *                  winston JSON FILE today, from four call sites, which no UI
 *                  can page or filter.
 *   System Events  needs camera status TRANSITIONS to be persisted. Camera
 *                  carries a current state only; offline/online is a toast and
 *                  a push, never a row. (reports.service.js already wants this
 *                  table for its uptime numbers.)
 */

import { normalizeEvent } from '@/modules/ai-feed/aifeed/event-model';

// ── Sources — the tab strip ──────────────────────────────────────────────────
export const SOURCES = [
  { id: 'all',    label: 'All Activity' },
  { id: 'ai',     label: 'AI & Security' },
  { id: 'user',   label: 'User Activity' },
  { id: 'system', label: 'System Events' },
];

/** Sources with no data yet get a tab, a zero, and a reason. */
export const SOURCE_META = {
  ai: {
    label: 'AI',
    available: true,
  },
  user: {
    label: 'User',
    available: false,
    emptyTitle: 'User activity is not recorded yet',
    emptyDescription:
      'Sign-ins, camera changes and user administration are audited to a log file today, not to a table this page can search. They appear here once the audit trail moves into the database.',
  },
  system: {
    label: 'System',
    available: false,
    emptyTitle: 'System events are not recorded yet',
    emptyDescription:
      'Cameras report their current state, but the moment they go offline or come back is only a live notification — it is never stored. Recording those transitions will fill this tab.',
  },
};

/**
 * Which source a normalized event belongs to, read off its type.
 *
 * Deliberately not a constant: the AI pipeline can already emit `camera.*`
 * rows, and the moment anything writes one it should land under System Events
 * without this page needing a change.
 */
export function sourceOf(evt) {
  const t = String(evt?.type || '');
  if (t.startsWith('camera.') || t.startsWith('system.') || t.startsWith('stream.')) return 'system';
  if (t.startsWith('user.') || t.startsWith('auth.') || t.startsWith('report.')) return 'user';
  return 'ai';
}

// ── Status ───────────────────────────────────────────────────────────────────
// Two states, because two is what the data supports: `acknowledgedAt` is set
// or it is not. A five-state triage workflow (new → acknowledged → reviewed →
// closed, with notes) needs columns that do not exist yet; inventing them in
// the UI would mean every status but "New" silently resetting on reload.
export const STATUSES = [
  { id: 'new',          label: 'New',          tone: 'neutral' },
  { id: 'acknowledged', label: 'Acknowledged', tone: 'success' },
];

export const STATUS_META = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

export function statusOf(evt) {
  return evt?.acknowledged ? 'acknowledged' : 'new';
}

// ── The activity service's timeline, in this page's shape ────────────────────
// `/ai/activity/events` merges attendance crossings and policy alerts, and it
// speaks {ts, kind, type, subject, camera, severity, detail} — epoch SECONDS,
// no slugs. Rather than teach the table a second row shape, each row is dressed
// as a backend event and run through the one normalizer, so an attendance entry
// and a zone breach are the same object by the time they reach the UI.
const ACTIVITY_SLUG = {
  'attendance:in':       'attendance.in',
  'attendance:out':      'attendance.out',
  'alert:watchlist':     'activity.watchlist',
  'alert:stranger':      'activity.stranger',
  'alert:after_hours':   'activity.after_hours',
  // Store-floor policy alerts (see pages-data.js EVENT_TEMPLATE for the shape).
  'alert:late_arrival':       'activity.late_arrival',
  'alert:phone_use':          'activity.phone_use',
  'alert:break_overstay':     'activity.break_overstay',
  'alert:long_break':         'activity.break_overstay',
  'alert:counter_unattended': 'activity.counter_unattended',
  'alert:low_activity':       'activity.low_activity',
  'alert:coverage_low':       'activity.low_activity',
  'alert:queue_exceeded':     'activity.queue_exceeded',
};

export function normalizeActivityRow(row, cameraIndex = {}) {
  if (!row || !row.ts) return null;
  const kind = String(row.kind || 'alert');
  const type = String(row.type || '');
  // An alert type not listed above becomes a generic "AI Event" carrying the
  // service's own sentence — labelling it "Unknown Person Dwelling" (the old
  // fallback) put queue breaches and phone use under the wrong name.
  const slug = ACTIVITY_SLUG[`${kind}:${type}`] || (kind === 'attendance' ? 'attendance.in' : `activity.${type || 'alert'}`);

  const evt = normalizeEvent(
    {
      // Stable across refetches so a selected row survives polling: the
      // activity service hands out no id of its own.
      id: `act-${kind}-${type}-${row.camera || row.stream || 'na'}-${row.ts}`,
      eventType: slug,
      ts: new Date(row.ts * 1000).toISOString(),
      monitorId: row.camera || row.stream || '',
      severity: row.severity || 'info',
      payload: { matchedName: row.subject || null, description: row.detail || '' },
    },
    cameraIndex,
  );
  if (!evt) return null;

  // The service writes a better sentence than we can derive ("Entered · 42m
  // on-site"); keep it, and keep the raw row for the detail panel.
  return { ...evt, detail: row.detail || evt.detail, fromActivityService: true, raw: row };
}

// ── Search ───────────────────────────────────────────────────────────────────
/** Free-text match across everything a person would type into the box. */
export function matchesQuery(evt, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [evt.title, evt.detail, evt.subject, evt.cameraName, evt.monitorId, evt.location, evt.model, evt.plate]
    .some((field) => field && String(field).toLowerCase().includes(q));
}

// ── Export ───────────────────────────────────────────────────────────────────
// The report's columns, in the order an auditor reads them. The first six are
// the Event Log Report's table (PDF and CSV alike); the CSV carries the rest
// after them, so nothing the old export had is lost to a spreadsheet user.
export const REPORT_COLUMNS = [
  { id: 'timestamp',  label: 'Timestamp' },
  { id: 'location',   label: 'Site' },
  { id: 'camera',     label: 'Camera' },
  { id: 'event',      label: 'Event Type' },
  { id: 'severity',   label: 'Severity' },
  { id: 'detail',     label: 'Description' },
];
export const CSV_COLUMNS = [
  ...REPORT_COLUMNS,
  { id: 'status',     label: 'Status' },
  { id: 'monitorId',  label: 'Camera ID' },
  { id: 'model',      label: 'AI Model' },
  { id: 'confidence', label: 'Confidence' },
];

/** "info" is what the backend calls the lowest level; people call it Low. */
export function severityLabel(sev) {
  if (!sev) return '';
  return sev === 'info' ? 'Low' : sev[0].toUpperCase() + sev.slice(1);
}

export function csvValue(evt, id) {
  switch (id) {
    case 'timestamp':  return `${fmtDate(evt.ts)} ${fmtTime(evt.ts)}`;
    case 'date':       return fmtDate(evt.ts);
    case 'time':       return fmtTime(evt.ts);
    case 'event':      return evt.title;
    case 'detail':     return evt.detail || '';
    case 'source':     return SOURCE_META[sourceOf(evt)]?.label || 'AI';
    case 'camera':     return evt.cameraName || '';
    case 'monitorId':  return evt.monitorId || '';
    case 'location':   return evt.location || '';
    case 'severity':   return severityLabel(evt.severity);
    case 'status':     return STATUS_META[statusOf(evt)].label;
    case 'model':      return evt.model || '';
    case 'confidence': return evt.confidence != null ? `${evt.confidence}%` : '';
    default:           return '';
  }
}

// ── Dates ────────────────────────────────────────────────────────────────────
// Everything here is LOCAL time on purpose. An operator filtering "yesterday"
// means yesterday where they are standing, and an export they hand to someone
// has to agree with the clock on the wall behind the camera.

/** `<input type="date">` value for a Date. */
export function dayInput(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayInput() {
  return dayInput(new Date());
}

export function yesterdayInput() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayInput(d);
}

/** Local midnight at the start of a `YYYY-MM-DD` day. */
export function startOfDay(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  if (!y || !m || !d) return new Date(0);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** The last millisecond of a `YYYY-MM-DD` day, local. */
export function endOfDay(value) {
  const [y, m, d] = String(value || '').split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

export function fmtDate(date) {
  try {
    return new Date(date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return '—'; }
}

export function fmtTime(date) {
  try {
    return new Date(date).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    }).toUpperCase();
  } catch { return '—'; }
}

export function fmtDateTime(date) {
  return `${fmtDate(date)}, ${fmtTime(date)}`;
}

/** "18 Sep 2026" for one day, "18 Sep – 20 Sep 2026" for a span. */
export function rangeLabel(from, to) {
  if (!from || !to) return 'All time';
  if (from === to) return fmtDate(startOfDay(from));
  return `${fmtDate(startOfDay(from))} – ${fmtDate(startOfDay(to))}`;
}

export const PAGE_SIZES = [10, 25, 50, 100];
/** Page size meaning "no pages — keep loading as the table scrolls". */
export const CONTINUOUS = 0;
/** Rows added each time a continuous table reaches its end. */
export const SCROLL_CHUNK = 50;

/**
 * The server's ceiling, not ours.
 *
 * `GET /ai/events` merges the backend's own rows with the vms_face mirror IN
 * MEMORY and caps the result at 200, so `offset` cannot walk past that and a
 * busy day is TRUNCATED, not paged. The page fetches the ceiling, pages what
 * it gets on the client, and says so in the footer when it hits the cap —
 * silently showing 200 of 4,000 events is how a log stops being evidence.
 */
export const FETCH_LIMIT = 200;
