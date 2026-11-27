/**
 * Zone configuration — persistence.
 *
 * Three stores, because three different systems enforce three parts of a zone,
 * and pretending otherwise is how a rule ends up armed in one place and not the
 * other:
 *
 *   max capacity + boundary -> the CAMERA.  `PUT /ai/cameras/:id/headcount` is
 *       what the head-count detector alarms on and counts inside. If the limit
 *       lived anywhere else, the page and the engine would disagree about when
 *       a room is full.
 *
 *   boundary + access rules -> the SERVER.  `/restricted-zones` is what the
 *       intrusion pipeline filters on: the polygon, whether the zone alarms on
 *       entry, which roles are authorised, the armed window and the alert
 *       delay. A whitelist that never reached this endpoint would be
 *       decoration.
 *
 *   everything else         -> this BROWSER. Profile, minimum staffing, the
 *       loitering ceiling, privacy mode and the individual whitelist have no
 *       field on either service yet.
 *
 * localStorage is therefore a CACHE and an offline fallback, not the truth:
 * `loadRooms()` reads it synchronously so the UI can render immediately, and
 * `syncRooms()` folds the server's copy over it. A save writes the cache first
 * so nothing is ever lost to a failed request, then reports which halves
 * actually landed — the panel shows that, because an operator who believes a
 * whitelist is enforced when it is not is worse off than one who knows.
 *
 * Records are keyed by ZONE id, not camera (see zone-model.js). Zones saved
 * before that change keep their monitorId as their id, so nothing already
 * stored, bookmarked or linked moves. Because one camera can now carry several
 * zones, a save rewrites every camera the zone touches -- and every camera it
 * was just taken off -- from the full set of zones on it, never from the one
 * zone being saved.
 */
import { aiService } from '@/core/services/ai';
import { isConsentRefusal } from '@/core/services/aiConsent';
import { FULL_PCT, PROFILE_BY_ID, ROOM_PROFILES } from './occupancy-data';
import { cameraFailures, partialNote } from './room-messages';
import { boundaryOn, cameraPayload, normalizeZone, normalizeZones } from './zone-model';
import { alarmOnlyZone, defaultAccess } from './zone-setup/access-data';
import { deleteZone, listZones, putZone } from './zone-setup/restricted-zones-api';

const KEY = 'drishyam.occupancy.rooms.v1';

/**
 * A new zone's record. `zone` is a region zone from the dashboard (its
 * `cameraIds` say which views feed it) or a bare `{ id, cameraIds }` for a zone
 * being created in Zone Setup.
 */
export function defaultRoom(zone) {
  const profile = ROOM_PROFILES[0];
  const cameras = zone?.cameraIds?.length
    ? [...zone.cameraIds]
    : [zone?.monitorId || zone?.id].filter(Boolean);
  return {
    id: zone?.id || cameras[0] || '',
    monitorId: cameras[0] || '',
    cameraId: zone?.cameraId || null,
    // Assigned by the server on first save. Its presence is what makes the
    // next save an update rather than a duplicate zone.
    zoneId: null,
    name: zone?.label || '',
    floor: zone?.floor || '',
    profile: profile.id,
    ...profile.defaults,
    // How bad an intrusion here is. One vocabulary with the breach log and the
    // congestion banner -- critical / warn / info -- rather than a second
    // four-level scale that has to be mentally converted every time.
    severity: 'critical',
    // Seconds a person must be inside before an intrusion fires. NOT the same
    // thing as `maxDwellMin`, which is the loitering ceiling: this one is a
    // debounce so brushing past a doorway does not alarm, that one is "they
    // have been in here too long". Folding them into one number would silently
    // delete one of the two behaviours, so they keep separate names.
    alertAfterSec: 5,
    // The loitering limit is optional. Rooms saved before this switch existed
    // had one in force, so a missing value reads as on (see buildRegionZones).
    dwellEnabled: true,
    // The early-warning line, as a percentage of max capacity. Held on this
    // browser: the camera only knows the limit itself.
    warnEnabled: true,
    warnPct: FULL_PCT,
    cameras,
    boundaries: Object.fromEntries(cameras.map((m) => [m, []])),
    boundary: [],
    access: defaultAccess(),
    // The camera may already carry a threshold an operator set from Head Count.
    // Opening this panel must not propose a different number than the one
    // currently alarming, so the existing limit wins over the profile's guess.
    ...(zone?.capacity > 0 ? { maxCapacity: zone.capacity } : null),
  };
}

/** Apply a profile's defaults without discarding the room's identity fields. */
export function applyProfile(room, profileId) {
  const profile = PROFILE_BY_ID[profileId];
  if (!profile) return { ...room, profile: profileId };
  return { ...room, profile: profileId, ...profile.defaults };
}

/** The cached map, keyed by zone id and normalised. Synchronous, and never throws. */
export function loadRooms() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? normalizeZones(parsed) : {};
  } catch {
    // A private window, cleared site data, or storage blocked entirely. No
    // saved zones is a valid state -- it falls back to the per-camera
    // thresholds -- so this is not worth surfacing as an error.
    return {};
  }
}

function writeRooms(rooms) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rooms));
    return true;
  } catch {
    return false;
  }
}

/**
 * One merged record: server wins its own fields, local keeps the rest.
 *
 * The server holds ONE camera and ONE polygon per zone. So its polygon lands
 * on that camera's slot only, and its camera becomes the primary without
 * dropping the other cameras this browser knows the zone spans.
 */
function merge(local, remote) {
  const base = local || {};
  const m = remote.monitorId || base.cameras?.[0];
  const others = (base.cameras || []).filter((c) => c !== m);
  const out = {
    ...base,
    ...remote,
    cameras: [m, ...others].filter(Boolean),
    boundaries: { ...(base.boundaries || {}), ...(m ? { [m]: remote.boundary || [] } : null) },
  };
  out.access = {
    ...defaultAccess(),
    ...(base.access || {}),
    ...(remote.access || {}),
    // The individual whitelist has no server field, so it can only ever come
    // from here. Taking it from `remote` would blank it on every sync.
    people: base.access?.people || [],
  };
  return out;
}

/**
 * Fold the server's zones over the cache and return the merged map.
 *
 * That ordering is what lets a zone created on another device open here
 * complete, while a whitelist typed on this browser is not wiped by a sync
 * that could never have carried it.
 *
 * Server zones are matched by their server id first, then -- for zones saved
 * before ids were tracked -- by a local record still keyed by its camera.
 * Anything unmatched is new to this browser and gets a key of its own.
 *
 * Never throws: a server that is down leaves the operator with the cache,
 * which is the whole reason the cache exists. `online` says which happened,
 * so the UI can be honest about it.
 */
export async function syncRooms() {
  const local = loadRooms();
  try {
    const remote = await listZones();
    const merged = { ...local };
    const byServerId = Object.fromEntries(
      Object.values(local).filter((z) => z.zoneId).map((z) => [z.zoneId, z.id]),
    );
    for (const zone of remote) {
      const legacy = merged[zone.monitorId] && !merged[zone.monitorId].zoneId ? zone.monitorId : null;
      const key = byServerId[zone.zoneId] || legacy
        || (merged[zone.monitorId] ? `srv-${zone.zoneId}` : zone.monitorId);
      const next = normalizeZone(key, { ...merge(merged[key], zone), id: key });
      if (next) merged[key] = next;
    }
    writeRooms(merged);
    return { rooms: merged, online: true };
  } catch {
    return { rooms: local, online: false };
  }
}

/**
 * Tell every camera in `monitorIds` about the zones now on it.
 *
 * `registry` is monitorId -> camera row (it carries the camera's own id and
 * its counting switch). The `zones` field is sent when there is a shape to
 * send, when nothing is left on the camera, or when the operator cleared a
 * shape on purpose (`clear`). Otherwise it is left off: an empty list also
 * means "the shape had not loaded yet", and must not wipe the camera's area.
 *
 * Returns the three failures SEPARATELY, because they are different events and
 * only one of them is the camera's fault:
 *
 *   unknown  the registry has no row for this monitor, so there is no camera
 *            id to write to and nothing was ever sent. The save silently did
 *            not switch counting on there -- which is the one thing the
 *            operator needs told, by name, since nothing on screen shows it.
 *   needsAi  the write was sent and refused because the camera's master AI
 *            switch is off (409 AI_CONSENT_REQUIRED).
 *   failed   the write was sent and refused for some other reason -- a dead
 *            backend, a camera deleted elsewhere. What is left once the causes
 *            that can be named have been taken out of it.
 *
 * `needsAi` IS A BACKSTOP, NOT THE PRIMARY PATH. DO NOT "SIMPLIFY" IT AWAY.
 * ------------------------------------------------------------------------
 * The primary path is `zoneEntry` in core/services/zoneDetector.js: it asks
 * which detector should watch a camera BEFORE a shape is drawn on it, and a
 * camera whose AI it switched on never reaches this refusal at all. So in
 * normal use this bucket stays empty, and a reader who finds it empty will be
 * tempted to delete it. It is still reachable, because the gate can be got
 * round:
 *
 *   - a registry row polled before someone switched that camera's AI off
 *   - a second tab that switched it off after the dialog was answered
 *   - a zone whose camera list changed between the dialog and the save
 *   - a caller written next year that does not know the gate exists
 *
 * In every one of those the operator has already drawn real work, and a save
 * that reports "1 of 3 cameras could not be updated" tells them nothing they
 * can act on. The two are not duplicates of each other: one PREVENTS the
 * refusal, this one EXPLAINS it when it happens anyway.
 *
 * It does not retry with consent, and must not learn to. `enableAi: true`
 * would make the 409 disappear and hollow out the rule the endpoint exists to
 * enforce -- that switching a camera's AI on is always something a person
 * chose. This screen never asked, so it does not get to answer.
 */
async function pushCameras(rooms, monitorIds, registry, { clear = [], enable = [] } = {}) {
  const failed = [];
  const unknown = [];
  const needsAi = [];
  for (const m of monitorIds) {
    const cam = registry[m];
    if (!cam?.id) { unknown.push(m); continue; }
    const { threshold, zones, zoneCount } = cameraPayload(rooms, m);
    // Every write carries `enabled`. A camera the saved zone is drawn on is
    // switched ON -- a zone on a camera that is not counting would never show
    // a number, and saving it is the operator asking for one. Any other camera
    // keeps the switch as Head Count left it.
    const body = { enabled: enable.includes(m) ? true : (cam.headcount?.enabled ?? true), threshold };
    if (zones.length || zoneCount === 0 || clear.includes(m)) body.zones = zones;
    try {
      await aiService.setHeadcount(cam.id, body);
    } catch (err) {
      // Asked of the one module that knows what the refusal means, never
      // re-read from the status code or the body here: a second, looser
      // reading of the same 409 is how a page comes to disagree with the
      // service that refused it.
      if (isConsentRefusal(err)) needsAi.push(m);
      else failed.push(m);
    }
  }
  return { failed, unknown, needsAi };
}

/** The single-camera registry older callers can still describe with two fields. */
function fallbackRegistry(monitorId, cameraId, enabled) {
  return monitorId && cameraId ? { [monitorId]: { id: cameraId, headcount: { enabled } } } : {};
}

/**
 * Save one zone.
 *
 * The cache is written first and unconditionally: losing an operator's work to
 * a 502 would be worse than a record whose halves are momentarily out of step,
 * and the next save reconciles them.
 *
 * `opts.registry` is monitorId -> camera row, covering every camera the zone
 * touches now or touched before this save. `opts.clearBoundary` says the
 * operator removed a shape on purpose, so an empty boundary goes out as "count
 * the whole view" rather than being left off. `opts.cameraName` turns a
 * monitorId into the name the operator knows it by, so a camera this save
 * could not reach can be named rather than counted -- pass the same resolver
 * the page's own lists use (see ZoneSetup's `nameOf`).
 *
 * Returns `{ rooms, engineSaved, serverSaved, error }` — `error` is a sentence
 * naming which half did not land, not a stack trace.
 */
export async function saveRoom(room, opts = {}) {
  const rooms = loadRooms();
  const zone = normalizeZone(room.id || room.monitorId, { boundaries: {}, ...room });
  const prev = rooms[zone.id];
  const next = { ...rooms, [zone.id]: { ...zone, updatedAt: Date.now() } };
  const stored = writeRooms(next);

  const failures = [];
  if (!stored) failures.push('this browser is not storing settings (private window, or storage disabled)');

  // ── the cameras: what the detector counts and alarms on ─────────────────
  const registry = opts.registry || fallbackRegistry(zone.cameras[0], room.cameraId, opts.cameraEnabled);
  const touched = [...new Set([...zone.cameras, ...(prev?.cameras || [])])];
  // A NO-ENTRY zone does not count anybody, so saving one must not switch
  // head counting on for its cameras.
  //
  // `enable` was every camera the zone is drawn on, whatever kind of zone it
  // was. The reasoning held for a counting area -- a zone that is not
  // counting would never show a number, so saving it is the operator asking
  // for one -- and was simply carried over to a kind of zone it was never
  // about. Converting a counting area into a strict lockout therefore left
  // head counting switched on, holding one of the detector's eight slots for
  // a number nobody would ever read.
  //
  // It is NOT switched off either, and that restraint is deliberate. Head
  // counting may be on because of another zone, or because somebody ticked
  // it on the Head Count page. Turning it off here would be the same mistake
  // in the other direction: this save deciding something it was not asked
  // about. The operator is told instead, and the Head Count page is where
  // they act on it.
  const alarmOnly = alarmOnlyZone(zone);
  const { failed, unknown, needsAi } = await pushCameras(next, touched, registry, {
    clear: opts.clearBoundary ? zone.cameras : [],
    enable: alarmOnly ? [] : zone.cameras,
  });
  // A camera with no registry row was never asked at all, so it is named
  // rather than counted -- see room-messages.js for why that distinction is
  // the whole message. A camera that refused for want of AI is named too, and
  // for the same reason: it has a cause, and a cause the operator can act on.
  // `engineSaved` keeps its meaning -- the detector got ALL of it -- so a
  // refusal of any kind still makes it false.
  const engineSaved = failed.length === 0 && unknown.length === 0 && needsAi.length === 0;
  failures.push(...cameraFailures({
    unknown, failed, needsAi, touched, cameraName: opts.cameraName,
  }));

  // ── the server: what the intrusion pipeline enforces ────────────────────
  // It holds one camera per zone, so it is given the primary and the shape on
  // it. The other cameras count toward the zone here, but intrusions are only
  // raised from the primary's view.
  let serverSaved = false;
  let saved = next[zone.id];
  try {
    const back = await putZone(
      { ...saved, monitorId: saved.cameras[0], boundary: boundaryOn(saved, saved.cameras[0]) },
      { cameraName: saved.name },
    );
    saved = normalizeZone(zone.id, { ...merge(saved, back || {}), id: zone.id });
    serverSaved = true;
  } catch {
    failures.push('the access rules could not be saved to the server, so they are armed on this browser only');
  }

  const final = { ...next, [zone.id]: { ...saved, updatedAt: Date.now() } };
  writeRooms(final);

  return {
    rooms: final,
    engineSaved,
    serverSaved,
    error: partialNote('Saved on this browser, but', failures),
  };
}

/**
 * Delete a zone: here, on the server, and from every camera it was drawn on.
 * Each camera is rewritten with the zones it has left; one with none left goes
 * back to counting its whole view with nothing to alarm on -- which is what
 * "no zone" means everywhere else. Returns the remaining rooms and what did
 * not land.
 */
export async function removeRoom(id, opts = {}) {
  const rooms = loadRooms();
  const zone = rooms[id];
  const failures = [];
  try {
    if (zone?.zoneId) await deleteZone(zone.zoneId);
  } catch {
    // A stale server zone is the lesser evil: the operator asked for it gone
    // from here, and the next save of this zone will overwrite it anyway.
    failures.push('the access rule could not be removed from the server');
  }
  delete rooms[id];
  writeRooms(rooms);

  const cameras = zone?.cameras || [];
  const registry = opts.registry || fallbackRegistry(cameras[0], opts.cameraId, opts.cameraEnabled);
  const { failed, unknown, needsAi } = await pushCameras(rooms, cameras, registry);
  // All three are one sentence HERE, deliberately. On a delete the action the
  // save path offers -- "switch this camera's AI on, then save again" -- is the
  // wrong thing to ask: the operator is removing the zone, not arming it, and
  // nobody should switch a camera to AI to finish taking a zone off it. What
  // they need to know is only that a stale boundary is still on a camera.
  if (failed.length || unknown.length || needsAi.length) {
    failures.push('a camera still has the old boundary and limit');
  }

  return {
    rooms,
    error: partialNote('Deleted here, but', failures),
  };
}

/** Cache-only removal, for callers that must stay synchronous. */
export function deleteRoom(id) {
  const rooms = loadRooms();
  delete rooms[id];
  writeRooms(rooms);
  return rooms;
}
