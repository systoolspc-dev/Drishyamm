/**
 * zoneIntrusion.service — L3 restricted-zone engine (occupancy model).
 *
 * Fed by person boxes on the AI_LIVE_OVERLAY channel (from the zone-guard's YOLO
 * person detector, and/or face boxes). For each zone it tracks OCCUPANCY, not
 * individual tracks — because detector track-ids churn when people are briefly
 * occluded, which used to cause an alert flood. Policy:
 *
 *   • ENTER  — zone goes empty → occupied (a person confirmed inside for the
 *     zone's dwell) → ONE alert ("N person(s) in restricted zone") + snapshot.
 *   • STAY   — while it remains occupied, stay quiet, except a slow heartbeat
 *     re-alert at most once per ZONE_REALERT_MS (people lingering long).
 *   • CLEAR  — no one inside for ZONE_CLEAR_MS → reset, so the next entry alerts.
 *
 * Authorized identities (matched name ∈ zone.allowed) don't count as intruders.
 * See docs/DETECTION_LOGGING_ALERTING_POLICY.md.
 */

const { on, emit, EVENTS } = require('../events/bus');
const logger = require('../config/logger');
const { createOccupancyTracker } = require('./occupancyHysteresis');
// The arm window moved out so the camera SELECTOR can ask the same question:
// zone-guard was watching a 09:00-17:00 zone around the clock and this engine
// was discarding the boxes. See zoneArming.js.
const { isArmed } = require('./zoneArming');

// Local MinIO (the AI's snapshot store) — zone crops go HERE, in the same
// `vms-snapshots` bucket the AI uses, so the existing retrieval paths (the
// /person-tracker/snapshot proxy for the card, and alertEngine for the email,
// both resolve payload.snapshotUri via the AI's /journey/snapshot) just work.
let _minio = null;
function minioClient() {
  if (!_minio) {
    const { S3Client } = require('@aws-sdk/client-s3');
    _minio = new S3Client({
      endpoint: process.env.AI_MINIO_ENDPOINT || 'http://minio:9000',
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.AI_MINIO_KEY || 'minioadmin',
        secretAccessKey: process.env.AI_MINIO_SECRET || 'minioadmin',
      },
      forcePathStyle: true,
    });
  }
  return _minio;
}
async function uploadZoneCrop(monitorId, buf) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = process.env.AI_MINIO_BUCKET || 'vms-snapshots';
  const key = `zone/${monitorId}/${Date.now()}_${Math.round(Math.random() * 1e6)}.jpg`;
  await minioClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: 'image/jpeg' }));
  return `s3://${bucket}/${key}`;
}

const ZONE_RELOAD_MS  = 60_000;    // zones cache refresh
const CONFIRM_MS      = 800;       // must be seen inside this long before "entered" (anti-flicker), min
const ZONE_CLEAR_MS   = 8_000;     // empty this long → zone cleared (re-entry re-alerts)
const ZONE_REALERT_MS = 300_000;   // while still occupied, re-alert at most every 5 min
const OCC_TTL_MS      = 600_000;   // drop occupancy state for zones not seen in 10 min

// userId → { at, zonesByMonitor: Map<monitorId, zone[]> }
const zoneCache = new Map();
// zoneId → { present, firstInside, lastInside, lastAlert }
const zoneOcc = new Map();

// Occupancy-threshold (capacity) anti-flap — framework §4 M1+M2. Used ONLY for
// zones that set maxOccupancy; plain intrusion zones are unaffected.
const OCC_CONFIRM_POLLS = parseInt(process.env.OCCUPANCY_CONFIRM_POLLS || '3', 10);
const OCC_CLEAR_MARGIN  = parseInt(process.env.OCCUPANCY_CLEAR_MARGIN || '5', 10);
const capacityTracker = createOccupancyTracker({ confirmPolls: OCC_CONFIRM_POLLS, clearMargin: OCC_CLEAR_MARGIN });

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function inZone(zone, xPct, yPct) {
  if (zone.shape === 'rectangle' && zone.rect) {
    const r = zone.rect;
    return xPct >= r.x && xPct <= r.x + r.w && yPct >= r.y && yPct <= r.y + r.h;
  }
  if (Array.isArray(zone.points) && zone.points.length >= 3) return pointInPolygon(xPct, yPct, zone.points);
  return false;
}


/**
 * Every camera carrying an ENABLED restricted zone, for any user.
 *
 * This engine's only input is the ephemeral overlay channel, and the face
 * service does not POST to it for cameras nobody is watching in a browser
 * (backend_forwarder.py: `if gating and monitor_id not in watched: continue`).
 * So a zone on an unwatched camera sees nothing at all -- it is armed only
 * while somebody has that camera's live view open, and blind overnight, which
 * is the hour it was drawn for. /ai/viewers is what the AI service asks, and
 * these cameras need their boxes whether or not a person is looking.
 *
 * Cached on the same clock as zonesFor: /ai/viewers is polled every couple of
 * seconds by every AI shard, so this must not become a query per poll.
 *
 * Entitlements are deliberately NOT applied here, unlike zonesFor. This is the
 * cheap, wide answer to "keep the boxes flowing"; the entitlement is still
 * checked before any alert is raised. Including a camera whose account has
 * restricted zones switched off costs a little overlay traffic. Excluding one
 * wrongly silences a security control, and the two mistakes are not the same
 * size.
 */
let armedCache = { at: 0, ids: [] };

async function armedMonitorIds() {
  if (armedCache.at && Date.now() - armedCache.at <= ZONE_RELOAD_MS) return armedCache.ids;
  const { RestrictedZone } = require('../models');
  const rows = await RestrictedZone.findAll({
    where: { enabled: true },
    attributes: ['monitorId'],
  });
  // De-duplicated in JS rather than with GROUP BY: a camera can carry several
  // zones, and the column list is short enough that the grouping is not worth
  // a dialect-specific query.
  const ids = [...new Set(rows.map((r) => r && r.monitorId).filter(Boolean))];
  armedCache = { at: Date.now(), ids };
  return ids;
}

let armedWarned = false;

/**
 * Whose overlay boxes does somebody need? The browsers drawing them, plus the
 * cameras above. This is the whole answer /ai/viewers gives.
 *
 * Fails to the browser set, never to an empty one. The AI side reads an empty
 * list as "nobody needs anything" and stops posting for every camera, so a
 * database blip here would silence the live overlay across the deployment on
 * top of the zones. Logged once per failure streak, because the endpoint is
 * polled every couple of seconds and a line per poll is a line nobody reads.
 */
async function overlayNeededMonitorIds(watched = []) {
  const out = new Set(Array.isArray(watched) ? watched.filter(Boolean) : []);
  try {
    for (const id of await armedMonitorIds()) out.add(id);
    armedWarned = false;
  } catch (err) {
    if (!armedWarned) {
      armedWarned = true;
      logger.warn('zoneIntrusion: could not list armed zones for /ai/viewers -- a zone on a camera nobody is watching will not fire until this clears', { error: err.message });
    }
  }
  return [...out];
}


async function zonesFor(userId, monitorId) {
  let entry = zoneCache.get(userId);
  if (!entry || Date.now() - entry.at > ZONE_RELOAD_MS) {
    const { RestrictedZone } = require('../models');
    const { getEntitlements, allowsAny } = require('./entitlements.service');
    // An account whose admin switched restricted zones off stops alerting on
    // the zones it already drew (they are kept, not deleted, for a re-enable).
    const ent = await getEntitlements(userId).catch(() => null);
    const rows = (ent && !allowsAny(ent, ['restricted_zone']))
      ? []
      : await RestrictedZone.findAll({ where: { userId, enabled: true } });
    const byMon = new Map();
    for (const z of rows) {
      const list = byMon.get(z.monitorId) || [];
      list.push(z.toJSON());
      byMon.set(z.monitorId, list);
    }
    entry = { at: Date.now(), zonesByMonitor: byMon };
    zoneCache.set(userId, entry);
  }
  return entry.zonesByMonitor.get(monitorId) || [];
}

/**
 * @param {object|null} people  intrusion only: `{ names, unidentified }` as
 *   recognised IN THE FRAME that triggered this alert. Omitted for a capacity
 *   breach, whose count is everyone inside — including the authorised people,
 *   whose names are deliberately not collected.
 */
async function fireAlert(userId, monitorId, zone, count, snapB64, kind = 'intrusion', people = null) {
  const { AIEvent } = require('../models');
  const alertEngine = require('./alertEngine');
  const isCapacity = kind === 'capacity';
  const cap = Number(zone.maxOccupancy) || 0;

  // Upload the person crop to the local MinIO (vms-snapshots) → snapshotUri, so
  // the alert card + email show who was in the zone (same store/paths as faces).
  let snapshotUri = null;
  if (snapB64) {
    try {
      snapshotUri = await uploadZoneCrop(monitorId, Buffer.from(snapB64, 'base64'));
    } catch (e) { logger.warn('zone snapshot upload failed', { error: e.message }); }
  }
  try {
    const row = await AIEvent.create({
      userId,
      cameraId: null,
      monitorId,
      eventType: isCapacity ? 'occupancy.threshold' : 'zone.intrusion',
      severity: zone.priority === 'low' ? 'warning' : 'critical',
      ts: new Date(),
      confidence: null,
      snapshotKey: null,
      payload: {
        zoneId: zone.id,
        zoneName: zone.name,
        count,
        // Who, when the detector knew. `names` is absent on a capacity row and
        // on every row written before this shipped, which is how the log and
        // the CSV tell "nobody was recognised" from "we did not record it" and
        // fall back to the count. Undefined keys are dropped by JSON.
        names: people ? people.names : undefined,
        unidentified: people ? people.unidentified : undefined,
        capacity: isCapacity ? cap : undefined,
        snapshotUri,                     // card + email resolve this via /journey/snapshot
        snapshot_uri: snapshotUri,       // (alias the UI's field too)
        // Dedup subject = the ZONE, so the alertEngine treats a lingering
        // occupancy as one identity (no per-person-per-frame spam).
        personId: `zone:${zone.id}`,
        matchedName: isCapacity
          ? `${count} in ${zone.name} (limit ${cap})`
          : `${count} person${count === 1 ? '' : 's'}`,
      },
    });
    const pushed = row.toJSON();
    emit(EVENTS.AI_EVENT_DETECTED, { event: pushed, userId });
    alertEngine.maybeAlert(pushed).catch(() => {});
    logger.warn(isCapacity ? 'ZONE OVER CAPACITY' : 'ZONE INTRUSION',
      { zone: zone.name, monitorId, count, cap: isCapacity ? cap : undefined });
  } catch (err) {
    logger.error('zoneIntrusion: alert emit failed', { error: err.message });
  }
}

function handleFrame({ userId, frame }) {
  if (!frame || !frame.frameW || !frame.frameH) return;
  const boxes = Array.isArray(frame.boxes) ? frame.boxes : [];
  if (!boxes.length) return;
  zonesFor(userId, frame.monitorId).then((zones) => {
    if (!zones.length) return;
    const now = Date.now();
    for (const zone of zones) {
      if (!isArmed(zone)) continue;
      const allowed = Array.isArray(zone.allowed) ? zone.allowed.map((s) => String(s).toLowerCase()) : [];
      let count = 0;   // unauthorized intruders (intrusion mode)
      let total = 0;   // everyone inside the zone (capacity mode)
      let snap = null;
      // Who the intruders were, when the detector could say. The box already
      // carries the name for the allow-list check below; it used to be thrown
      // away, so an alert could only ever report "1 person" and an operator had
      // to open the snapshot to learn who walked into the switch room.
      //
      // ONLY this frame's own recognition. A name is never carried over from
      // another camera or an earlier sighting: those would be inferences, and
      // an inferred name in a security record is worse than no name.
      const names = new Set();
      let unidentified = 0;
      for (const box of boxes) {
        if (!Array.isArray(box.bbox) || box.bbox.length < 4) continue;
        const xPct = (((box.bbox[0] + box.bbox[2]) / 2) / frame.frameW) * 100;
        const yPct = (box.bbox[3] / frame.frameH) * 100; // feet / bottom-centre
        if (!inZone(zone, xPct, yPct)) continue;
        total += 1;
        const name = typeof box.name === 'string' ? box.name.trim() : '';
        if (name && allowed.includes(name.toLowerCase())) continue; // authorized → occupies space, not an intruder
        count += 1;
        // "Unknown" is what the face stage emits for a detection it could not
        // match — a label, not a person, so it counts as unidentified.
        if (name && !/^unknown$/i.test(name)) names.add(name); else unidentified += 1;
        if (!snap && box.snap) snap = box.snap;
      }

      // Capacity/occupancy-threshold (framework §6 row g): a zone with a
      // maxOccupancy alerts when the HEAD COUNT crosses the cap (K-of-N
      // confirmed) and stays quiet until it falls below cap − margin
      // (deadband) — no flapping.
      //
      // THE TWO RULES ARE INDEPENDENT, and this used to `continue`.
      //
      // A capacity limit answered "how many may be in here"; entry alerting
      // answers "may anyone be in here at all". They are different questions
      // and a zone can need both — but a `continue` here meant any capacity
      // at all CANCELLED the entry alarm, silently. So a no-entry zone that
      // had once been a counting area with a limit of 4 kept the 4, took this
      // branch for ever, and logged `occupancy.threshold` while the operator
      // watched the no-entry log stay empty. Nothing said the limit had
      // switched the alarm off, because nothing knew it had.
      //
      // Both now run. They cannot double-report the same thing: capacity
      // counts EVERYONE inside against the limit and is tracked by
      // capacityTracker; entry counts only people the allow-list does not
      // excuse and is tracked by zoneOcc. Separate state, separate cooldowns,
      // separate event types, and a public zone is still stopped from
      // alarming on entry by the `alertOnEntry` check below.
      const cap = Number(zone.maxOccupancy) || 0;
      if (cap > 0 && capacityTracker.update(zone.id, total, cap) === 'breach') {
        fireAlert(userId, frame.monitorId, zone, total, snap, 'capacity');
      }

      // A PUBLIC zone does not alarm on entry. `alertOnEntry` is what the zone
      // editor writes for that choice (`restricted-zones-api.js` toApi:
      // `alertOnEntry: access.mode !== 'public'`), the controller stores it and
      // the model has carried it from the start — and until now nothing read it
      // back, so a zone an operator had explicitly marked public raised a
      // `zone.intrusion` for every person who walked through it. Checked AFTER
      // the capacity branch on purpose: a public zone WITH a capacity rule is
      // still meant to alert when it is over its limit, which is the whole
      // point of making it public rather than deleting it.
      if (zone.alertOnEntry === false) continue;

      let st = zoneOcc.get(zone.id);
      if (!st) { st = { present: false, firstInside: 0, lastInside: 0, lastAlert: 0 }; zoneOcc.set(zone.id, st); }

      if (count > 0) {
        st.lastInside = now;
        if (!st.firstInside) st.firstInside = now;
        const dwellMs = Math.max(CONFIRM_MS, Number(zone.dwellSec ?? 0) * 1000);
        const people = { names: [...names], unidentified };
        if (!st.present) {
          if (now - st.firstInside >= dwellMs) {          // ENTER (confirmed)
            st.present = true; st.lastAlert = now;
            fireAlert(userId, frame.monitorId, zone, count, snap, 'intrusion', people);
          }
        } else if (now - st.lastAlert >= ZONE_REALERT_MS) { // STAY heartbeat
          st.lastAlert = now;
          fireAlert(userId, frame.monitorId, zone, count, snap, 'intrusion', people);
        }
      } else {
        st.firstInside = 0;
        if (st.present && now - st.lastInside > ZONE_CLEAR_MS) st.present = false; // CLEAR
      }
    }
  }).catch((err) => logger.warn('zoneIntrusion: zone eval failed', { error: err.message }));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, st] of zoneOcc) {
    if (now - st.lastInside > OCC_TTL_MS && !st.present) { zoneOcc.delete(k); capacityTracker.reset(k); }
  }
}, 60_000).unref();

function init() {
  on(EVENTS.AI_LIVE_OVERLAY, handleFrame);
  logger.info('zoneIntrusion engine armed (occupancy model: enter/stay-heartbeat/clear)');
}

module.exports = {
  init,
  // Read by internal.routes.js's /ai/viewers. Exported from here, rather than
  // the route querying zones itself, so that what a zone needs stays with the
  // engine that needs it.
  overlayNeededMonitorIds,
  armedMonitorIds,
  _internals: {
    resetArmedCache: () => { armedCache = { at: 0, ids: [] }; armedWarned = false; },
  },
};
