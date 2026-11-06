/**
 * ai.js — REST client + view-model helpers for the Drishyam AI features.
 *
 * The "view model" half (EVENT_META, describe(), severity helpers) is what the
 * UI uses to talk about events in plain English instead of in eventType slugs.
 * The Alerts page, AI Feed timeline, and Dashboard Recent Activity all share
 * this so a "tripwire.entry" event always reads the same way wherever it
 * appears on screen.
 *
 * Pairs with services/socket.js for real-time event delivery (`ai.event`,
 * `ai.alert` channels).
 */

import api from '@/core/services/api';
import { API_BASE } from '@/core/config/endpoints';

// ── REST surface ─────────────────────────────────────────────────────────────

export const aiService = {
  listEvents(params = {}) {
    return api.get('/ai/events', { params }).then((r) => r.data);
  },
  // One camera's event counts per time bucket and type: the Playback
  // timeline's markers, which must cover a whole day the list can't page through.
  eventHistogram(params = {}) {
    return api.get('/ai/events/histogram', { params }).then((r) => r.data);
  },

  // Activity / productivity monitor (per-person phone-usage + time-in-state).
  // Proxied by the backend to the activity-monitor service.
  activityPeople() {
    return api.get('/ai/activity/people').then((r) => r.data);
  },
  activitySessions(params = {}) {
    return api.get('/ai/activity/sessions', { params }).then((r) => r.data);
  },
  activityStreams() {
    return api.get('/ai/activity/streams').then((r) => r.data);
  },
  activityHistory(days = 7) {
    return api.get('/ai/activity/history', { params: { days } }).then((r) => r.data);
  },
  // In/out attendance (line crossing)
  activityAttendance() {
    return api.get('/ai/activity/attendance').then((r) => r.data);
  },
  activityCrossings(params = {}) {
    return api.get('/ai/activity/crossings', { params }).then((r) => r.data);
  },
  // Policy alerts (watchlist / stranger / after-hours) + today's counts.
  activityAlerts(params = {}) {
    return api.get('/ai/activity/alerts', { params }).then((r) => r.data);
  },
  activityAckAlert(id) {
    return api.post(`/ai/activity/alerts/${id}/ack`).then((r) => r.data);
  },
  // Detection-funnel health: dedup ratio, recognition rate per camera, session sanity.
  activityMetrics(date) {
    return api.get('/ai/activity/metrics', { params: date ? { date } : {} }).then((r) => r.data);
  },
  // Unified event log — attendance + alerts merged, newest-first, filterable.
  activityEvents(params = {}) {
    return api.get('/ai/activity/events', { params }).then((r) => r.data);
  },
  // Real-time person tracker — who is where right now + hop-by-hop trail.
  trackLive(name) {
    return api.get(name ? `/ai/track/live/${encodeURIComponent(name)}` : '/ai/track/live').then((r) => r.data);
  },
  trackGraph() {
    return api.get('/ai/track/graph').then((r) => r.data);
  },
  trackReset() {
    return api.post('/ai/track/reset').then((r) => r.data);
  },
  activityGetLine(stream) {
    return api.get('/ai/activity/line', { params: { stream } }).then((r) => r.data);
  },
  activitySetLine(payload) {
    return api.put('/ai/activity/line', payload).then((r) => r.data);
  },
  // Latest annotated JPEG as a Blob (fetched authed, shown via object URL).
  activitySnapshotBlob(streamId) {
    return api
      .get(`/ai/activity/snapshot/${encodeURIComponent(streamId)}`, { responseType: 'blob' })
      .then((r) => r.data);
  },
  getSnapshotUrl(eventId) {
    return api.get(`/ai/events/${eventId}/snapshot`).then((r) => r.data);
  },
  // Direct browser <img src> for a detection's face crop. vms_face events store
  // the crop in the AI's MinIO (s3://vms-snapshots/…) and are NOT rows in the
  // backend's ai_events table, so /events/:id/snapshot 404s for them. We instead
  // stream the bytes through the backend byte-relay (the proven proxy the
  // PersonTracker page uses). The JWT rides as ?token= because an <img> tag
  // can't send an Authorization header. Returns null for non-MinIO uris so the
  // caller can fall back to the presigned getSnapshotUrl() path.
  snapshotSrc(uri) {
    if (!uri || !String(uri).startsWith('s3://')) return null;
    const token = localStorage.getItem('auth_token') || '';
    return `${API_BASE}/api/person-tracker/snapshot?uri=${encodeURIComponent(uri)}&token=${encodeURIComponent(token)}`;
  },
  acknowledge(eventId) {
    return api.post(`/ai/events/${eventId}/ack`).then((r) => r.data);
  },

  listCameraAiSettings() {
    return api.get('/ai/cameras').then((r) => r.data);
  },

  /**
   * Turn cameras ON/OFF for person tracking (checked = ON). Enabling sets AI
   * detection + journey mapping on so the camera produces appearances and is
   * included in person-tracker / journey search.
   */
  setPersonTrackerCameras(cameraIds, enabled = true) {
    return api.post('/ai/person-tracker-cameras', { cameraIds, enabled }).then((r) => r.data);
  },

  /**
   * Which cameras run phone-usage / activity monitoring (per-camera, whole
   * product). GET returns { enabled:[{id,monitorId,name,group}], live:[…status] }.
   */
  getActivityCameras() {
    return api.get('/ai/activity-cameras').then((r) => r.data?.data || r.data);
  },
  /** Turn activity/phone-usage monitoring ON/OFF for the given camera ids. */
  setActivityCameras(cameraIds, enabled = true) {
    return api.post('/ai/activity-cameras', { cameraIds, enabled }).then((r) => r.data);
  },

  /**
   * Building-wide + per-camera people count.
   * Returns the data shape from smart-cam-ai's /api/people-count:
   *   { running_cameras, total, known, unknown, smoothed_total,
   *     cameras: [{ camera_id, monitor_id, code, total, known, unknown,
   *                 smoothed_total, running }, ...] }
   * Smoothed totals are 2 s rolling-max — safe to render directly in
   * dashboard tiles without extra debouncing.
   */
  peopleCount() {
    return api.get('/ai/people-count').then((r) => r.data?.data ?? null);
  },

  // ── Footfall (customer-counter) ─────────────────────────────────────────
  // The AI service exposes the live + persisted counts; the Node backend
  // proxies under /ai/footfall/*. Shapes match the AI side verbatim, so any
  // future Postgres schema change there only needs a one-line update here.
  footfallCameras() {
    return api.get('/ai/footfall/cameras').then((r) => r.data?.data ?? null);
  },
  // Aggregated security report for a date range (SQL-side; covers all events).
  report(params = {}) {
    return api.get('/ai/reports', { params }).then((r) => r.data ?? null);
  },
  // `params` keys map to query-string args understood by the AI route:
  //   granularity: 'minute' | 'hour' | 'day'
  //   from: ISO8601 (defaults to "now - 24h")
  //   to:   ISO8601 (defaults to "now")
  //   camera_id: UUID filter (optional)
  footfallTimeseries(params = {}) {
    return api.get('/ai/footfall/timeseries', { params }).then((r) => r.data?.data ?? null);
  },
  footfallGetConfig(cameraId) {
    return api
      .get(`/ai/footfall/cameras/${encodeURIComponent(cameraId)}/config`)
      .then((r) => r.data?.data ?? null);
  },
  // Body fields are all optional; the AI side merges with the current
  // config and sanitises ranges. `line` is { a: [x, y], b: [x, y] } in 0..1
  // (any angle; refused with 422 when shorter than 3% of the frame) and
  // `direction` is "right_is_in" / "left_is_in" relative to a->b. See
  // modules/occupancy/gate-model.js.
  footfallPutConfig(cameraId, body) {
    return api
      .put(`/ai/footfall/cameras/${encodeURIComponent(cameraId)}/config`, body || {})
      .then((r) => r.data?.data ?? null);
  },
  // CSV is best as a direct browser download (so the browser handles
  // the file-save dialog). Caller renders this URL inside a <a download>.
  footfallExportCsvUrl(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const base = api.defaults?.baseURL || '';
    const sep  = qs.toString() ? `?${qs}` : '';
    return `${base}/ai/footfall/export.csv${sep}`;
  },

  // ── Face reconstruction (CodeFormer + Real-ESRGAN) ──────────────────
  // Server takes the image as a multipart file. We accept either a Blob
  // or a File and post it to the Node proxy at /ai/enhance. Returns the
  // upstream JSON verbatim — { triage, before, after, mode, ... } —
  // where before/after are base64 PNGs ready to drop into <img src=...>.
  //
  // fidelityWeight (0..1):
  //   0.0 = maximum AI restoration (may invent features)
  //   0.5 = balanced (recommended default)
  //   1.0 = maximum identity preservation (less cleanup)
  enhanceFace(blob, { fidelityWeight = 0.5, onUploadProgress } = {}) {
    const fd = new FormData();
    fd.append('file', blob, blob.name || 'face.jpg');
    fd.append('fidelity_weight', String(fidelityWeight));
    return api.post('/ai/enhance', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress,
      timeout: 35_000,
    }).then((r) => r.data?.data ?? null);
  },

  updateCameraAiLifecycle(cameraId, payload) {
    return api.patch(`/ai/cameras/${cameraId}/lifecycle`, payload).then((r) => r.data);
  },

  uploadFace(name, file, options = {}) {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('file', file);
    return api.post('/ai/watchlist', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: options.onUploadProgress,
    }).then((r) => r.data);
  },
  deleteFace(name) {
    return api.delete(`/ai/watchlist/${encodeURIComponent(name)}`).then((r) => r.data);
  },

  updateCameraSettings(cameraId, ai) {
    return api.put(`/ai/cameras/${cameraId}/settings`, { ai }).then((r) => r.data);
  },

  /**
   * Per-camera head counting (user chooses which cameras). enabled turns the
   * head-count model on for this camera; threshold (>0) arms an occupancy alert
   * when that many people are counted (with hysteresis, so it doesn't flap).
   */
  setHeadcount(cameraId, { enabled, threshold, zones, imgsz } = {}) {
    // `zones` is only sent when supplied — the backend preserves the existing
    // ones otherwise, so toggling a camera on/off never wipes the counting area
    // an operator drew.
    const body = { enabled, threshold };
    if (zones !== undefined) body.zones = zones;
    if (imgsz !== undefined) body.imgsz = imgsz;
    return api.put(`/ai/cameras/${cameraId}/headcount`, body).then((r) => r.data);
  },
};

// ── Event view-model ─────────────────────────────────────────────────────────
//
// The backend emits event types like `tripwire.entry`, `person.unknown`,
// `match`, `alert`. Operators don't think in those terms — they think
// "Aastha walked in", "stranger at the gate", "watchlist hit". This map
// translates each technical type into:
//   verb       — the action, present tense ("entered", "left", "was seen")
//   nounWhen   — short "what happened" line ("Entry detected", "Watchlist match")
//   tone       — visual tone: "good" | "warn" | "critical" | "neutral"
//   icon       — lucide-react icon NAME (lazy-resolved by the page)
//
// To add a new event type, add one row here. The describe() helper below will
// pick the row based on type, kind, OR matched-name (in that order).

const EVENT_META = {
  // Tripwire / behavioural
  'tripwire.entry':  { verb: 'entered',   nounWhen: 'Entry detected',     tone: 'neutral',  icon: 'LogIn'      },
  'tripwire.exit':   { verb: 'left',      nounWhen: 'Exit detected',      tone: 'neutral',  icon: 'LogOut'     },
  'crowd.formed':    { verb: 'gathered',  nounWhen: 'Crowd forming',      tone: 'warn',     icon: 'UsersRound' },
  'object.removed':  { verb: 'removed',   nounWhen: 'Object removed',     tone: 'warn',     icon: 'PackageX'   },
  'line.cross':      { verb: 'crossed',   nounWhen: 'Line crossed',       tone: 'warn',     icon: 'GitBranch'  },
  'loitering':       { verb: 'loitered',  nounWhen: 'Loitering',          tone: 'warn',     icon: 'Clock'      },

  // Identity-driven (face recognition outputs)
  'person.match':    { verb: 'was seen',  nounWhen: 'Recognised',         tone: 'good',     icon: 'UserCheck'  },
  'person.unknown':  { verb: 'was seen',  nounWhen: 'Unrecognised face',  tone: 'warn',     icon: 'UserX'      },
  'person.alert':    { verb: 'was seen',  nounWhen: 'Watchlist alert',    tone: 'critical', icon: 'ShieldAlert'},

  // The vms_face worker writes these as event "kind" not eventType — same map
  match:             { verb: 'was seen',  nounWhen: 'Recognised',         tone: 'good',     icon: 'UserCheck'  },
  unknown:           { verb: 'was seen',  nounWhen: 'Unrecognised face',  tone: 'warn',     icon: 'UserX'      },
  alert:             { verb: 'was seen',  nounWhen: 'Watchlist alert',    tone: 'critical', icon: 'ShieldAlert'},

  // Occupancy / restricted zones. Tone stays 'warn' on purpose: the backend
  // already grades these per zone priority, and describe() upgrades anything
  // it marked `severity: critical`.
  'occupancy.threshold': { verb: 'went over capacity', nounWhen: 'Over capacity',        tone: 'warn',    icon: 'Users'      },
  'occupancy.warning':   { verb: 'neared capacity',    nounWhen: 'Nearing capacity',     tone: 'warn',    icon: 'Users'      },
  'occupancy.cleared':   { verb: 'cleared',            nounWhen: 'Back under capacity',  tone: 'good',    icon: 'UserCheck'  },
  'zone.intrusion':      { verb: 'entered a restricted zone', nounWhen: 'Restricted zone entry', tone: 'warn', icon: 'ShieldAlert' },
  'crowd.stampede':      { verb: 'surged',             nounWhen: 'Crowd surge',          tone: 'warn',    icon: 'UsersRound' },

  // Vehicle & system events
  'vehicle.detected':{ verb: 'arrived',   nounWhen: 'Vehicle detected',   tone: 'neutral',  icon: 'Car'        },
  'vehicle.lpr':     { verb: 'arrived',   nounWhen: 'Plate recognised',   tone: 'neutral',  icon: 'CarFront'   },
  'camera.offline':  { verb: 'went offline', nounWhen: 'Camera offline',  tone: 'critical', icon: 'WifiOff'    },
  'camera.online':   { verb: 'came online', nounWhen: 'Camera online',    tone: 'good',     icon: 'Wifi'       },
};

const TONE_THEME = {
  good:     { bg: 'bg-success-soft',  border: 'border-success-line',  fg: 'text-success-ink',  hex: '#10b981' },
  warn:     { bg: 'bg-warning-soft',    border: 'border-warning-line',    fg: 'text-warning-ink',    hex: '#f59e0b' },
  critical: { bg: 'bg-danger-soft',     border: 'border-danger-line',     fg: 'text-danger-ink',     hex: '#ef4444' },
  neutral:  { bg: 'bg-surface-sunken',    border: 'border-line',    fg: 'text-fg-secondary',    hex: '#64748b' },
};

const TONE_BY_SEVERITY = {
  critical: 'critical',
  warning:  'warn',
  info:     'neutral',
};

/**
 * Build the user-facing description of an event. Returns:
 *   {
 *     title:        "Aastha · entered"  | "Stranger · entry detected" | "Watchlist alert: Aastha"
 *     subject:      "Aastha" | "Unrecognised person"
 *     verb:         "entered" | "was seen" | …
 *     nounWhen:     "Entry detected" | "Watchlist alert" | …
 *     tone:         "good" | "warn" | "critical" | "neutral"
 *     theme:        { bg, border, fg, hex }
 *     iconName:     lucide-react icon NAME (caller imports it dynamically)
 *     when:         Date object
 *     cameraLabel:  human label ("Office 12 · Camera 02") if cameras provided, else short id
 *     confidencePct number 0-100, or null
 *     isAlert:      true for watchlist alerts (any tone === critical)
 *     isUnknown:    matched name is null/Unknown
 *   }
 *
 * @param {object}   evt
 * @param {object?}  cameras      monitorId -> { name, groupName } map for nice labels
 */
export function describe(evt, cameras = null) {
  if (!evt) {
    return { title: 'Event', subject: '—', verb: '', nounWhen: 'Event', tone: 'neutral',
             theme: TONE_THEME.neutral, iconName: 'Activity',
             when: new Date(), cameraLabel: '—', confidencePct: null,
             isAlert: false, isUnknown: false };
  }

  // Resolve a meta entry. Try eventType first, then kind, then severity.
  const key = evt.eventType || evt.kind || evt.action || '';
  const meta = EVENT_META[key]
            || EVENT_META[String(key).toLowerCase()]
            || { verb: 'was seen', nounWhen: 'Detection', tone: TONE_BY_SEVERITY[evt.severity] || 'neutral', icon: 'Activity' };

  const matched = evt.payload?.matchedName ?? evt.person_name ?? evt.name ?? evt.full_name ?? null;
  const isUnknown = !matched || /^unknown$/i.test(matched);
  const subject   = isUnknown ? 'Unrecognised person' : matched;

  // For watchlist alerts force the critical tone regardless of source map
  const tone  = String(evt.kind || '').toLowerCase().includes('alert') ? 'critical'
              : String(evt.severity || '').toLowerCase() === 'critical' ? 'critical'
              : meta.tone;
  const theme = TONE_THEME[tone] || TONE_THEME.neutral;

  // Camera label resolution. Prefer the human group + camera name from the
  // cameras lookup. We deliberately do NOT fabricate a short-hash placeholder
  // like "Cam 28c7a6" — operators read those as real camera names and try to
  // find them on a floor plan that doesn't have any such camera. When a
  // monitorId has no match in the user's known cameras (event from a deleted
  // camera, or cameras list not loaded yet) we show "Unnamed camera" instead.
  const camId = evt.monitorId || evt.camera_code || evt.cameraCode || evt.camera_id || '';
  let cameraLabel = '—';
  if (camId) {
    const c = cameras && cameras[camId];
    if (c && (c.name || c.groupName)) {
      cameraLabel = c.groupName ? `${c.groupName} · ${c.name || 'Camera'}` : (c.name || 'Unnamed camera');
    } else {
      cameraLabel = 'Unnamed camera';
    }
  }

  // Title — short, scannable: "Aastha · entered" / "Watchlist alert: Aastha".
  // Only genuine identity alerts get the watchlist wording. Keying it off tone
  // instead labelled every critical event a watchlist hit, so a restricted-zone
  // entry or an offline camera read as "Watchlist alert" — the one phrase that
  // makes an operator go and check the gallery.
  const isWatchlist = String(evt.kind || evt.action || evt.eventType || '').toLowerCase().includes('alert');
  let title;
  if (isWatchlist && !isUnknown)  title = `Watchlist alert: ${subject}`;
  else if (isWatchlist)           title = 'Watchlist alert';
  else if (isUnknown)             title = `${meta.nounWhen} · stranger`;
  else                            title = `${subject} · ${meta.verb}`;

  const conf = Number(evt.confidence ?? evt.similarity ?? 0);
  const confidencePct = Number.isFinite(conf) && conf > 0 && conf <= 1
    ? Math.round(conf * 100)
    : (Number.isFinite(conf) && conf > 1 ? Math.round(conf) : null);

  const when = new Date(evt.ts || evt.occurred_at || evt.timestamp || evt.createdAt || Date.now());

  return {
    title, subject,
    verb: meta.verb, nounWhen: meta.nounWhen,
    tone, theme, iconName: meta.icon,
    when, cameraLabel,
    confidencePct,
    isAlert: tone === 'critical',
    isUnknown,
  };
}

// ── Backward-compat (some pages still call eventLabel/eventColor) ───────────

export function eventLabel(evt)  { return describe(evt).nounWhen; }
export function eventColor(evt)  {
  const t = describe(evt).tone;
  return t === 'good'     ? 'emerald'
       : t === 'warn'     ? 'amber'
       : t === 'critical' ? 'rose'
       : 'slate';
}
export const SEVERITY_COLOR = { info: 'sky', warning: 'amber', critical: 'rose' };
export { EVENT_META, TONE_THEME };
