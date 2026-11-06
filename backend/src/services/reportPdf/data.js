'use strict';
/**
 * data.js — the rows a report PDF needs that the saved payload does not have.
 *
 * A saved report freezes its NUMBERS (summary, breakdown, per-camera totals)
 * at generation time and the PDF prints those, so the file agrees with the
 * screen. The event RECORDS, the evidence stills, camera status and the
 * occupancy history are not in the payload — a week of detections is
 * thousands of rows and the payload is a JSON column — so they are read back
 * here with the same period and scope the report was built with. Everything
 * uses reports.service's scope resolution so "all cameras", "one site" and
 * "these three cameras" mean exactly what they meant on screen.
 */

const { QueryTypes, Op } = require('sequelize');
const { sequelize, Camera, CameraGroup, Site, User } = require('../../models');
const reports = require('../reports.service');

const COLS = [
  'e.id', 'e.user_id AS userId', 'e.monitor_id AS monitorId', 'e.event_type AS eventType',
  'e.severity', 'e.ts', 'e.confidence', 'e.bbox', 'e.payload', 'e.snapshot_key AS snapshotKey',
  'e.acknowledged_at AS acknowledgedAt', 'e.acknowledged_by AS acknowledgedBy',
].join(', ');

const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

function parseJson(v) {
  if (v == null || typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function normalise(r) {
  return {
    ...r,
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts),
    confidence: r.confidence == null ? null : Number(r.confidence),
    bbox: parseJson(r.bbox),
    payload: parseJson(r.payload) || {},
    acknowledgedAt: r.acknowledgedAt ? new Date(r.acknowledgedAt) : null,
  };
}

function scopedMonitors(cameras, scope = {}) {
  return (scope.siteId || scope.groupId || (scope.monitorIds || []).length)
    ? cameras.map((c) => String(c.monitorId))
    : null;
}

/**
 * Event rows for the table (newest first, capped), the high-severity rows for
 * the evidence section (its own cap, so a big table never crowds it out), the
 * true totals, and per-camera counts.
 */
async function gatherEvents({ ownerId, type, from, to, scope = {}, maxRows, maxEvidence }) {
  const cameras = await reports.resolveScope(ownerId, scope);
  const scoped = scopedMonitors(cameras, scope);

  const buckets = reports.TYPE_BUCKETS[type];
  const opts = type === 'incident' ? { minSeverity: 'warning' } : {};

  // A typed report is ABOUT its buckets: resolve which event types present in
  // the window belong to them, exactly as the on-screen report does.
  let types = null;
  if (buckets) {
    const base = reports.scopeClause(ownerId, from, to, scoped, opts);
    const present = await q(`SELECT DISTINCT e.event_type AS t FROM ai_events e WHERE ${base.sql}`, base.repl);
    types = present.map((r) => r.t).filter((t) => buckets.includes(reports.bucketOf(t)));
  }
  const where = reports.scopeClause(ownerId, from, to, scoped, { ...opts, types });

  const [totals] = await q(
    `SELECT COUNT(*) AS n, COALESCE(SUM(e.severity = 'critical'), 0) AS high,
            COALESCE(SUM(e.severity IN ('warning','critical')), 0) AS alerts
       FROM ai_events e WHERE ${where.sql}`,
    where.repl,
  );
  const rows = await q(
    `SELECT ${COLS} FROM ai_events e WHERE ${where.sql} ORDER BY e.ts DESC, e.id DESC LIMIT ${Number(maxRows) || 1000}`,
    where.repl,
  );
  const evidence = maxEvidence > 0 ? await q(
    `SELECT ${COLS} FROM ai_events e WHERE ${where.sql} AND e.severity = 'critical'
      ORDER BY e.ts DESC, e.id DESC LIMIT ${Number(maxEvidence)}`,
    where.repl,
  ) : [];
  const perCamera = await q(
    `SELECT e.monitor_id AS monitorId, COUNT(*) AS n,
            COALESCE(SUM(e.severity = 'critical'), 0) AS high,
            COALESCE(SUM(e.severity IN ('warning','critical')), 0) AS alerts,
            MAX(e.ts) AS last
       FROM ai_events e WHERE ${where.sql} GROUP BY e.monitor_id`,
    where.repl,
  );

  return {
    cameras,
    scoped,
    rows: rows.map(normalise),
    evidence: evidence.map(normalise),
    total: Number(totals?.n) || 0,
    totalHigh: Number(totals?.high) || 0,
    totalAlerts: Number(totals?.alerts) || 0,
    perCamera: new Map(perCamera.map((r) => [String(r.monitorId), {
      n: Number(r.n) || 0, high: Number(r.high) || 0, alerts: Number(r.alerts) || 0, last: r.last ? new Date(r.last) : null,
    }])),
  };
}

/**
 * Occupancy history for the period, from the per-camera minute roll-up:
 * per camera (average of measured minutes, peak, when the peak was, how much
 * of the period was measured) and a local-day trend. `count NULL ⟺ unknown`,
 * so averages only ever include measured minutes.
 */
async function occupancyStats({ ownerId, from, to, scoped, tz }) {
  const parts = ['m.user_id = :owner', 'm.ts >= :from', 'm.ts < :to'];
  const repl = { owner: ownerId, from, to, tz };
  if (scoped) {
    if (!scoped.length) parts.push('1 = 0');
    else { parts.push('m.monitor_id IN (:monitors)'); repl.monitors = scoped; }
  }
  const where = parts.join(' AND ');

  const [perCamera, daily] = await Promise.all([
    q(`SELECT m.monitor_id AS monitorId,
              AVG(CASE WHEN m.quality = 'measured' THEN m.count_avg END) AS avgCount,
              MAX(m.count_peak) AS peak,
              SUM(m.quality = 'measured') AS measuredMinutes,
              COUNT(*) AS minutes
         FROM occupancy_camera_minute m WHERE ${where} GROUP BY m.monitor_id`, repl),
    q(`SELECT DATE(CONVERT_TZ(m.ts, '+00:00', :tz)) AS day,
              MAX(m.count_peak) AS peak,
              AVG(CASE WHEN m.quality = 'measured' THEN m.count_avg END) AS avgCount,
              SUM(m.quality = 'measured') AS measuredMinutes
         FROM occupancy_camera_minute m WHERE ${where}
        GROUP BY day ORDER BY day`, repl),
  ]);

  // When each camera peaked (first minute at its peak).
  let peakAt = new Map();
  try {
    const rows = await q(
      `SELECT monitorId, ts FROM (
          SELECT m.monitor_id AS monitorId, m.ts,
                 ROW_NUMBER() OVER (PARTITION BY m.monitor_id ORDER BY m.count_peak DESC, m.ts ASC) AS rn
            FROM occupancy_camera_minute m WHERE ${where} AND m.count_peak IS NOT NULL) t
        WHERE rn = 1`, repl,
    );
    peakAt = new Map(rows.map((r) => [String(r.monitorId), new Date(r.ts)]));
  } catch { /* older MySQL without window functions: no peak times */ }

  const periodMinutes = Math.max(1, Math.round((new Date(to) - new Date(from)) / 60000));
  return {
    periodMinutes,
    perCamera: perCamera.map((r) => ({
      monitorId: String(r.monitorId),
      avg: r.avgCount == null ? null : Number(r.avgCount),
      peak: r.peak == null ? null : Number(r.peak),
      peakAt: peakAt.get(String(r.monitorId)) || null,
      measuredMinutes: Number(r.measuredMinutes) || 0,
      minutes: Number(r.minutes) || 0,
    })),
    daily: daily.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      peak: r.peak == null ? null : Number(r.peak),
      avg: r.avgCount == null ? null : Number(r.avgCount),
      measuredMinutes: Number(r.measuredMinutes) || 0,
    })),
  };
}

/** monitorId → { name, location, groupName, site, status, lastSeenAt, retentionDays } for every camera on the account. */
async function cameraDirectory(ownerId) {
  const cams = await Camera.findAll({
    where: { userId: ownerId },
    attributes: ['monitorId', 'name', 'groupId', 'status', 'lastSeenAt', 'retentionDays'],
    include: [{
      model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location', 'siteId'], required: false,
      include: [{ model: Site, as: 'site', attributes: ['id', 'name'], required: false }],
    }],
  });
  const dir = new Map();
  for (const c of cams) {
    dir.set(String(c.monitorId), {
      name: c.name || String(c.monitorId),
      location: c.group?.location || c.group?.name || null,
      groupName: c.group?.name || null,
      site: c.group?.site?.name || null,
      status: c.status || null,
      lastSeenAt: c.lastSeenAt ? new Date(c.lastSeenAt) : null,
      retentionDays: c.retentionDays == null ? null : Number(c.retentionDays),
    });
  }
  return dir;
}

async function userNames(ids) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  const users = await User.findAll({ where: { id: { [Op.in]: uniq } }, attributes: ['id', 'name', 'email'] });
  return new Map(users.map((u) => [String(u.id), u.name || u.email || 'Operator']));
}

async function accountInfo(ownerId) {
  const u = await User.findByPk(ownerId, { attributes: ['id', 'name', 'email'] });
  return { id: ownerId, name: u?.name || u?.email || 'Drishyam account' };
}

async function groupName(groupId) {
  if (!groupId) return null;
  const g = await CameraGroup.findByPk(groupId, { attributes: ['name'] });
  return g?.name || null;
}

module.exports = { gatherEvents, occupancyStats, cameraDirectory, userNames, accountInfo, groupName, scopedMonitors };
