/**
 * Zones and cameras as a many-to-many relation.
 *
 * A zone used to BE a camera: records were keyed by monitorId and carried one
 * boundary. That cannot describe either shape a real site has --
 *
 *   one camera, many zones    a wide shot over a lobby AND the queue beside it
 *   one zone, many cameras    a hall too large for any single view
 *
 * -- so a zone now has its own id, a list of cameras, and a boundary PER
 * camera. The boundary has to be per camera: a polygon is drawn in one view's
 * pixel space and means nothing laid over another's.
 *
 *   {
 *     id:         'zone-k3x9' | <monitorId for zones saved before this model>
 *     cameras:    [monitorId, ...]        first one is the primary
 *     boundaries: { [monitorId]: [[x,y], ...] }
 *     monitorId:  cameras[0]              kept for the server and older readers
 *     boundary:   boundaries[cameras[0]]  ditto
 *     ...rules    capacity, dwell, schedule, access -- one set per zone
 *   }
 *
 * A zone's live count is the sum of its per-camera counts. That is only right
 * if the parts do not overlap on the floor, which is what drawing a boundary on
 * each camera is for: each view outlines its own slice of the room.
 *
 * Pure, with no imports, so it runs under `node --test` and can be shared by
 * the data layer, the persistence layer and the editor without a cycle.
 */

/** Fewer corners than this is not a shape. Mirrors headcount/zone-geometry. */
export const MIN_CORNERS = 3;

/**
 * Stroke colours for zones sharing one camera view. Literal hues on purpose:
 * they are drawn over video, where theme tokens have no say over contrast, and
 * each has to stand apart from the others and from a typical scene.
 */
export const ZONE_COLORS = ['#4CC9F0', '#F72585', '#FFB703', '#80ED99', '#B388FF', '#FF7F50', '#00F5D4', '#F4F1BB'];

export const hasShape = (pts) => Array.isArray(pts) && pts.length >= MIN_CORNERS;

/** A fresh, URL-safe zone id. Never a 24-hex string, so it cannot pass for a monitorId. */
export function newZoneId() {
  return `zone-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

/**
 * Bring any stored record to the current shape.
 *
 * Records saved before this model are keyed by their camera and may list extra
 * cameras. Those extras never contributed to the count -- only the primary's
 * stream was read -- so they are dropped rather than suddenly summed in, which
 * would change the numbers an operator has been watching without them touching
 * anything.
 */
export function normalizeZone(key, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const legacy = !raw.boundaries;
  const cameras = legacy
    ? [raw.monitorId || key].filter(Boolean)
    : (Array.isArray(raw.cameras) ? raw.cameras : []).filter(Boolean);
  if (!cameras.length) return null;
  const boundaries = legacy
    ? { [cameras[0]]: Array.isArray(raw.boundary) ? raw.boundary : [] }
    : { ...raw.boundaries };
  return {
    ...raw,
    id: raw.id || key,
    cameras,
    boundaries,
    monitorId: cameras[0],
    boundary: boundaries[cameras[0]] || [],
  };
}

/** Every stored record, normalised, keyed by zone id. Unreadable records drop out. */
export function normalizeZones(rooms = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(rooms || {})) {
    const z = normalizeZone(key, raw);
    if (z) out[z.id] = z;
  }
  return out;
}

export const boundaryOn = (zone, monitorId) => zone?.boundaries?.[monitorId] || [];

/**
 * The zones drawn on one camera, in a STABLE order (by id) so a zone keeps its
 * colour while it is renamed, and the tree, chips and canvas all agree on it.
 */
export function zonesOnCamera(zones, monitorId) {
  return Object.values(zones || {})
    .filter((z) => z?.cameras?.includes(monitorId))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** zoneId -> colour, for the zones on one camera. */
export function colorsOnCamera(zones, monitorId) {
  const out = {};
  zonesOnCamera(zones, monitorId).forEach((z, i) => { out[z.id] = ZONE_COLORS[i % ZONE_COLORS.length]; });
  return out;
}

/**
 * What one camera should be told: every polygon on it, and a limit.
 *
 * The camera has ONE threshold, so it can only enforce a zone's capacity when
 * that zone is the only one on it and lives on no other camera. Anywhere else
 * the number the camera sees is not the zone's number, and arming it would
 * alarm on the wrong count -- so the limit goes to 0 and the dashboard judges
 * the zone from the per-zone counts instead.
 */
export function cameraPayload(zones, monitorId) {
  const on = zonesOnCamera(zones, monitorId);
  const polygons = on
    .filter((z) => hasShape(boundaryOn(z, monitorId)))
    .map((z) => ({ id: z.id, name: z.name || 'Zone', enabled: true, points: boundaryOn(z, monitorId) }));
  const solo = on.length === 1 && on[0].cameras.length === 1;
  return {
    threshold: solo ? Number(on[0].maxCapacity) || 0 : 0,
    zones: polygons,
    zoneCount: on.length,
  };
}

/**
 * One zone's count on one camera's stream.
 *
 * With a single zone and no shape the zone IS the whole view, so the stream's
 * head count is its count. Otherwise the detector's per-zone breakdown is the
 * only honest source; it is keyed by the name the zone was pushed with, and
 * zones pushed before ids existed may be keyed by name only.
 */
export function countOn(stream, zone, zones) {
  if (!stream) return 0;
  const m = stream.id;
  const shared = zonesOnCamera(zones, m).length > 1;
  const heads = Number(stream?.counts?.heads) || 0;
  if (!shared && !hasShape(boundaryOn(zone, m))) return heads;
  const zc = stream.zone_counts || {};
  const v = zc[zone.id] ?? zc[zone.name];
  if (v != null) return Number(v) || 0;
  // One shape, no breakdown: the camera counts inside its only polygon, so its
  // head count is still this zone's. Shared, with no breakdown, it is not.
  return shared ? 0 : heads;
}

/**
 * Why a zone cannot be saved as drawn, or [] if it can.
 *
 * `zones` is every OTHER saved zone. The checks are the ones that would
 * otherwise produce a silently wrong count:
 *   - two zones with one name on a camera share one entry in its breakdown
 *   - on a shared camera, a zone with no shape claims the whole view, and the
 *     people in it would be counted twice
 */
export function zoneProblems(draft, zones = {}, cameraName = (m) => m) {
  const problems = [];
  const name = String(draft?.name || '').trim();
  if (!name) problems.push('Give the zone a name.');
  const others = Object.values(zones).filter((z) => z.id !== draft.id);

  for (const m of draft.cameras || []) {
    const onCam = others.filter((z) => z.cameras.includes(m));
    if (!onCam.length) continue;
    if (name && onCam.some((z) => String(z.name || '').trim().toLowerCase() === name.toLowerCase())) {
      problems.push(`Another zone on ${cameraName(m)} is already called "${name}". Zones sharing a camera need different names.`);
    }
    if (!hasShape(boundaryOn(draft, m))) {
      problems.push(`${cameraName(m)} is shared with ${onCam.length === 1 ? 'another zone' : `${onCam.length} other zones`} — draw this zone's boundary on it.`);
    }
    for (const z of onCam) {
      if (!hasShape(boundaryOn(z, m))) {
        problems.push(`"${z.name || 'Unnamed zone'}" covers the whole of ${cameraName(m)}. Draw its boundary before adding another zone to that camera.`);
      }
    }
  }
  return problems;
}
