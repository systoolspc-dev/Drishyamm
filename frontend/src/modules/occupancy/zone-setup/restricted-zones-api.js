/**
 * The `/restricted-zones` adapter.
 *
 * This is the ONLY file that knows the server's shape. Zone Setup works in the
 * app's own vocabulary everywhere else; the translation — including the
 * coordinate change — happens here and nowhere else, so a second reading of a
 * polygon can never disagree with the first.
 *
 * Two models, one zone:
 *
 *   app                          server
 *   ---                          ------
 *   boundary [[x,y]] 0..1        points [{x,y}] 0..100 + rect
 *   access.mode                  alertOnEntry + allowed[]
 *   access.roles                 allowed[]
 *   access.scheduleMode/Hours    schedule + window
 *   severity critical|warn|info  priority critical|high|medium|low
 *   alertAfterSec                dwellSec
 *
 * What does NOT fit, and is kept on the browser alongside: the individual
 * whitelist, the capacity numbers, the loitering ceiling and the privacy mode.
 * The server model has no field for any of them, and inventing keys it will
 * drop would be worse than a split an operator can see — the panel says which
 * half is enforced where.
 */
import api from '@/core/services/api';

// ── Coordinates ─────────────────────────────────────────────────────────────
// The app stores normalised pairs because a zone has to survive the camera
// being re-profiled at a different resolution. The server stores percent
// objects. Neither is wrong; they just have to meet in one place.

const toServerPoints = (boundary = []) =>
  boundary.map(([x, y]) => ({ x: Number((x * 100).toFixed(2)), y: Number((y * 100).toFixed(2)) }));

const toAppBoundary = (points = []) =>
  points
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => [Number((Number(p.x) / 100).toFixed(4)), Number((Number(p.y) / 100).toFixed(4))]);

/** Axis-aligned bounds, which the server stores beside the polygon. */
function boundsOf(points) {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ── Severity ────────────────────────────────────────────────────────────────
// The app has one severity vocabulary — critical / warn / info — used by the
// congestion banner, the breach log and the status chips. The server has a
// four-level priority. Writing is exact; reading folds `high` up and `low`
// down, which is lossy only for zones authored in the editor this replaces.
const SEVERITY_TO_PRIORITY = { critical: 'critical', warn: 'medium', info: 'low' };
const PRIORITY_TO_SEVERITY = { critical: 'critical', high: 'critical', medium: 'warn', low: 'info' };

// ── Schedule ────────────────────────────────────────────────────────────────
// The server's named windows are presets over the same start/end pair the app
// edits, so they read back as explicit hours rather than as a fourth mode the
// UI would have to grow a control for.
const NAMED_WINDOWS = {
  after_hours: ['21:00', '06:00'],
  work_hours: ['09:00', '18:00'],
};

/**
 * One zone, app shape -> server payload.
 *
 * `allowed[]` carries the authorised ROLES. That is the field the backend
 * already filters intrusions on, so reusing it is the difference between a
 * whitelist that is enforced and one that is decoration. The individual
 * whitelist has no counterpart and stays local — see the file header.
 */
export function toApi(room, { cameraName } = {}) {
  const points = toServerPoints(room.boundary);
  const access = room.access || {};
  const scheduled = access.scheduleMode === 'hours';

  return {
    monitorId: room.monitorId,
    cameraName: cameraName || room.name || room.monitorId,
    name: room.name || 'Zone',
    shape: 'polygon',
    points,
    rect: boundsOf(points),
    priority: SEVERITY_TO_PRIORITY[room.severity] || 'critical',
    // A public zone is one that does not alarm on entry. A lockout is a
    // restricted zone whose allow-list is empty — which is exactly what the
    // server already means by "nobody is authorised", so the three app modes
    // round-trip through two server fields without a mode column.
    alertOnEntry: access.mode !== 'public',
    allowed: access.mode === 'lockout' ? [] : (access.roles || []),
    schedule: scheduled ? 'custom' : 'always',
    window: scheduled
      ? { from: access.scheduleHours?.[0] || '09:00', to: access.scheduleHours?.[1] || '17:00' }
      : null,
    dwellSec: Number(room.alertAfterSec) || 0,
  };
}

/**
 * One zone, server payload -> the fields the app owns.
 *
 * Returns a PARTIAL room: only what the server actually stores. The caller
 * merges it over the local record, so the fields the server has no room for
 * are preserved rather than blanked on every sync.
 */
export function fromApi(zone) {
  if (!zone?.monitorId) return null;

  const named = NAMED_WINDOWS[zone.schedule];
  const hours = named
    || (zone.window ? [zone.window.from, zone.window.to] : null);

  const allowed = Array.isArray(zone.allowed) ? zone.allowed : [];
  const mode = zone.alertOnEntry === false ? 'public' : (allowed.length ? 'restricted' : 'lockout');

  return {
    zoneId: zone.id,
    monitorId: zone.monitorId,
    name: zone.name || '',
    boundary: toAppBoundary(zone.points),
    severity: PRIORITY_TO_SEVERITY[zone.priority] || 'critical',
    alertAfterSec: Number(zone.dwellSec) || 0,
    access: {
      mode,
      roles: allowed,
      scheduleMode: zone.schedule === 'always' || !hours ? 'always' : 'hours',
      scheduleHours: hours || ['09:00', '17:00'],
    },
  };
}

// ── Transport ───────────────────────────────────────────────────────────────

/**
 * Every armed zone, as a list. Throws — the caller decides.
 *
 * A list rather than a map keyed by monitorId: one camera can carry several
 * zones, and a map keyed by camera kept only the last of them.
 */
export async function listZones() {
  const { data } = await api.get('/restricted-zones');
  const list = Array.isArray(data?.zones) ? data.zones : Array.isArray(data) ? data : [];
  return list.map(fromApi).filter(Boolean);
}

/**
 * Create or update. `zoneId` decides which, so a zone that already exists on
 * the server is never duplicated by a second save.
 */
export async function putZone(room, opts) {
  const payload = toApi(room, opts);
  const { data } = room.zoneId
    ? await api.put(`/restricted-zones/${room.zoneId}`, payload)
    : await api.post('/restricted-zones', payload);
  return data?.zone ? fromApi(data.zone) : { ...fromApi({ ...payload, id: room.zoneId }), zoneId: room.zoneId };
}

export async function deleteZone(zoneId) {
  if (!zoneId) return;
  await api.delete(`/restricted-zones/${zoneId}`);
}
