/**
 * The rows "By zone" lists -- every zone that EXISTS, not every zone that is
 * being counted.
 *
 * This list used to be built straight from `regionZones`, the dashboard's
 * cards. That array is live-only ON PURPOSE: buildRegionZones drops a zone
 * whose cameras have no head-count stream, because the site tiles sum `count`
 * and `capacity` across it (buildMacro) and a zone that can never fill would
 * add capacity nothing occupies and drag site utilisation down. Right for the
 * panel it was written for; wrong as an answer to "what zones are there".
 *
 * So a zone drawn, named, saved and armed on a camera nobody is counting --
 * which is exactly what a server room under a lockout looks like -- was
 * missing from "By zone", while "By camera" (reading `saved` through
 * zonesOnCamera) had been showing it all along. One page, two tabs, two
 * answers to whether the zone exists. The zones most likely to go missing
 * were the ones that matter most.
 *
 * The list is built here instead, from three sources merged by id:
 *
 *   saved        every stored zone. The spine of the list.
 *   regionZones  the live count, and the label / capacity / lock of a zone
 *                that has one -- plus the whole-view card buildRegionZones
 *                emits for a camera that is counting with no zone drawn on it
 *                yet. Those are rows in this list too, and always have been.
 *   draft        the zone just created and not yet saved, which no store
 *                knows about.
 *
 * A row with no live card carries `count: null`, never 0. The two are opposite
 * claims -- "nobody is in there" against "nothing is watching" -- and the rail
 * prints the second as "Not counting", the words gates already use
 * (GATE_STATUS_LABEL in occupancy-data.js).
 *
 * buildRegionZones, the Zone headcount panel and every site total are
 * deliberately untouched: that panel is right to count only what counts.
 *
 * Pure, so it runs under `node --test`.
 */
import { PROFILE_BY_ID, withinHours } from '../occupancy-data.js';
import { BROKEN_LABEL } from '../zone-model.js';
import { ACCESS_MODE_BY_ID } from './access-data.js';
// Relative, not '@/', for the same reason the rest of this file is pure: it
// has to run under `node --test`. zoneDetector has no imports of its own.
import { faceProducing, bodyProducing } from '../../../core/services/zoneDetector.js';
import { aiOn } from '../../../core/services/aiConsent.js';

/**
 * WHY a zone is not working, or null when it is -- and whether the operator
 * can do anything about it.
 *
 * THE ORDER IS THE DESIGN. Several of these can be true at once, and only one
 * is worth saying: the first thing that stands in the way. Said in the wrong
 * order, a customer who has not bought restricted zones is told to switch on
 * a camera that would still not alarm, which is a worse answer than silence.
 *
 *   plan     the account does not include this feature. NO FIX LINK -- there
 *            is nothing the operator can switch on, and offering a button
 *            that cannot work is the defect this whole page has been losing.
 *   ai-off   the camera's master AI switch is off. Fixable, and the link goes
 *            to the one panel where it is switched on.
 *   no-eyes  armed, but neither detector is producing boxes on this camera,
 *            so it watches nothing. Fixable in the same panel, which is also
 *            where the detector is chosen.
 *
 * "Not counting" is deliberately NOT here. It is not a fault and not fixable
 * by a switch -- it means no head-count stream right now -- and the rail
 * already says it in the subtitle.
 *
 * @param cams   the zone's monitorIds
 * @param byMon  monitorId -> `GET /ai/cameras` row
 * @param plan   { headcount, restricted_zone } from the account's features
 * @param needs  what this zone needs to work: 'restricted' or 'counting'
 */
function blockedBy(cams, byMon, plan, needs) {
  if (needs === 'restricted' && plan.restricted_zone === false) {
    return { code: 'plan', label: 'Not in your plan', cameraId: null };
  }
  if (needs === 'counting' && plan.headcount === false) {
    return { code: 'plan', label: 'Not in your plan', cameraId: null };
  }
  // The FIRST camera with the problem, not a tally. A zone spans cameras and
  // the operator fixes them one at a time; a count would say how much is
  // wrong without saying where to start.
  const rows = cams.map((m) => byMon?.[m]).filter(Boolean);
  if (!rows.length) return null;            // nothing known yet; say nothing

  // `aiOn`, not `enabled !== true`: the master switch is enabled AND a mode
  // that is not 'off', which is what the backend means by isAiEnabled. Read
  // the flag alone and a camera parked at mode 'off' reports "nothing is
  // detecting here" -- a true sentence that sends the operator to the wrong
  // switch -- or, on a counting zone, reports nothing at all.
  const off = rows.find((c) => !aiOn(c));
  if (off) return { code: 'ai-off', label: 'AI is off', cameraId: off.id || null };

  if (needs === 'restricted') {
    const blind = rows.find((c) => !faceProducing(c) && !bodyProducing(c));
    if (blind) {
      return { code: 'no-eyes', label: 'Nothing is detecting here', cameraId: blind.id || null };
    }
  }
  return null;
}

/** One row, from whichever of the two sources know this id. */
function row(id, live, room, at, byMon, plan) {
  // A zone synced from the server carries no profile -- that field has no
  // column there -- so the subtitle degrades to the next most useful fact
  // rather than printing "Not configured" beside a green tick.
  const profile = PROFILE_BY_ID[room?.profile];
  const mode = ACCESS_MODE_BY_ID[room?.access?.mode];
  // A stored record normalizeZone could not make work -- today, one with no
  // camera left on it. It is listed so it can be seen and deleted, and it
  // says what is wrong instead of a profile that no longer means anything.
  const broken = room?.broken || null;
  // A zone that ALARMS on entry, rather than one that merely counts. The
  // access mode has been computed here all along and only ever reached the
  // subtitle, as a fallback behind the profile -- so the zones that matter
  // most were the ones least likely to say what they were.
  const restricted = Boolean(room?.access?.mode) && room.access.mode !== 'public';
  const cameras = live?.cameraIds || room?.cameras || [];
  return {
    id,
    label: live?.label || room?.name || 'Unnamed zone',
    restricted,
    blocked: blockedBy(cameras, byMon, plan, restricted ? 'restricted' : 'counting'),
    // Monitor ids, as the rail's row click, camera count and delete payload
    // all expect. (`live.cameras` is camera NAMES -- not this.)
    cameras,
    // null, not 0: see the note at the top of this file.
    count: live ? live.count : null,
    // The stored limit wins over the live card's, as it always has here:
    // effectiveCapacity reports 0 for a zone inside its off-hours lock, and
    // this rail is where the limit is edited, so it has to show the number
    // being edited rather than the one in force at this minute.
    capacity: Number(room?.maxCapacity) || live?.capacity || 0,
    // Derived for a zone with no live card, rather than left undefined: a
    // lockout over a whole uncounted view is the case this list was losing,
    // and dropping its lock would be losing it a second way. Same expression
    // regionZone uses.
    locked: live ? live.locked : Boolean(room?.offHoursLock) && !withinHours(room, at),
    broken,
    // A broken zone is stored but not working, so it does NOT take the green
    // tick -- and it lands where the sort already puts anything unconfigured,
    // at the top, which is where something needing attention belongs.
    configured: Boolean(room) && !broken,
    subtitle: broken
      ? (BROKEN_LABEL[broken] || 'Needs attention')
      : profile?.label || (room ? (mode?.label || 'Configured') : 'Not configured'),
  };
}

/**
 * The "By zone" list, searched and ordered exactly as it was before: anything
 * unconfigured first (Number(false) sorts ahead of Number(true)), then by
 * name.
 *
 * A zone sorts by what it IS, never by a count -- so a zone nothing is
 * counting cannot fall in among the empty ones.
 */
export function zoneRows({
  saved = {}, regionZones = [], draft = null, query = '', at = new Date(),
  // monitorId -> `GET /ai/cameras` row, and the account's features. Both
  // OPTIONAL and both default to "do not claim anything": with no registry
  // there is nothing to diagnose, and an absent plan flag means unknown
  // rather than missing, so a page that has not loaded them yet says nothing
  // instead of telling every customer they have not bought the feature.
  camByMonitor = null, plan = {},
} = {}) {
  const live = new Map((regionZones || []).map((z) => [z.id, z]));
  const rows = [];
  const seen = new Set();
  const add = (r) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    rows.push(r);
  };

  // Live cards first, in the order the dashboard sorted them, so nothing that
  // was already listed moves relative to a row with the same name.
  for (const z of regionZones || []) add(row(z.id, z, saved?.[z.id], at, camByMonitor, plan));
  // Then every stored zone none of those covered: the rows this list lost.
  for (const [id, room] of Object.entries(saved || {})) add(row(id, live.get(id), room, at, camByMonitor, plan));
  // And the zone being drafted, if no store has it yet -- a zone that vanished
  // from the rail the moment it was created would read as a failed click. Once
  // saved it is already above, under its stored name, so this cannot double it.
  if (draft?.id && !saved?.[draft.id]) {
    add({
      id: draft.id,
      label: draft.name || 'New zone',
      // A draft has no stored access mode yet, so it is not called restricted
      // and carries no diagnosis: nothing is wrong with a zone still being
      // drawn, and saying so would be the page complaining about itself.
      restricted: false,
      blocked: null,
      cameras: draft.cameras || [],
      count: null,
      capacity: Number(draft.maxCapacity) || 0,
      locked: false,
      broken: null,
      configured: false,
      subtitle: 'Not configured',
    });
  }

  const q = String(query || '').trim().toLowerCase();
  return rows
    .filter((z) => !q || z.label.toLowerCase().includes(q))
    .sort((a, b) => Number(a.configured) - Number(b.configured) || a.label.localeCompare(b.label));
}
