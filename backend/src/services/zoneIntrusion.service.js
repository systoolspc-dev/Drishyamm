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

function isArmed(zone) {
  if (!zone.enabled) return false;
  if (!zone.armWindow || zone.schedule === 'always') return true;
  try {
    const now = new Date().toLocaleTimeString('en-GB', {
      hour12: false, hour: '2-digit', minute: '2-digit',
      timeZone: process.env.ALERT_TIMEZONE || 'Asia/Kolkata',
    });
    const { from, to } = zone.armWindow;
    if (!from || !to) return true;
    return from <= to ? (now >= from && now <= to) : (now >= from || now <= to);
  } catch { return true; }
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

async function fireAlert(userId, monitorId, zone, count, snapB64, kind = 'intrusion') {
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
      for (const box of boxes) {
        if (!Array.isArray(box.bbox) || box.bbox.length < 4) continue;
        const xPct = (((box.bbox[0] + box.bbox[2]) / 2) / frame.frameW) * 100;
        const yPct = (box.bbox[3] / frame.frameH) * 100; // feet / bottom-centre
        if (!inZone(zone, xPct, yPct)) continue;
        total += 1;
        if (box.name && allowed.includes(String(box.name).toLowerCase())) continue; // authorized → occupies space, not an intruder
        count += 1;
        if (!snap && box.snap) snap = box.snap;
      }

      // Capacity/occupancy-threshold mode (framework §6 row g): a zone with a
      // maxOccupancy alerts when the HEAD COUNT crosses the cap (K-of-N confirmed)
      // and stays quiet until it falls below cap − margin (deadband) — no
      // flapping. Capacity zones don't also fire intrusion alerts.
      const cap = Number(zone.maxOccupancy) || 0;
      if (cap > 0) {
        if (capacityTracker.update(zone.id, total, cap) === 'breach') {
          fireAlert(userId, frame.monitorId, zone, total, snap, 'capacity');
        }
        continue;
      }

      let st = zoneOcc.get(zone.id);
      if (!st) { st = { present: false, firstInside: 0, lastInside: 0, lastAlert: 0 }; zoneOcc.set(zone.id, st); }

      if (count > 0) {
        st.lastInside = now;
        if (!st.firstInside) st.firstInside = now;
        const dwellMs = Math.max(CONFIRM_MS, Number(zone.dwellSec ?? 0) * 1000);
        if (!st.present) {
          if (now - st.firstInside >= dwellMs) {          // ENTER (confirmed)
            st.present = true; st.lastAlert = now;
            fireAlert(userId, frame.monitorId, zone, count, snap);
          }
        } else if (now - st.lastAlert >= ZONE_REALERT_MS) { // STAY heartbeat
          st.lastAlert = now;
          fireAlert(userId, frame.monitorId, zone, count, snap);
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

module.exports = { init };
