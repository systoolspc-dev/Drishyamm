/**
 * occupancy.routes — the head-count history & reports API.
 *
 *   GET /api/occupancy/history   minute/bucket series for a camera (P1: space)
 *   GET /api/occupancy/summary   the report KPIs for a period
 *
 * Every response distinguishes "0 people" from "we couldn't see" — samples with
 * quality='unknown' return `count: null`, and the frontend must draw a GAP, not
 * a zero (docs/OCCUPANCY_LOGIC.md §2.2). Averages divide by measured time only.
 */
const { Router } = require('express');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const asyncHandler = require('../middleware/asyncHandler');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');

const router = Router();
router.use(authenticate);
router.use(requireFeature('headcount')); // Head Count & Flow (account switch)

const BUCKETS = new Set(['15m', '1h', '1d']);

/**
 * GET /api/occupancy/history?cameraId=&from=&to=&bucket=
 * bucket omitted → raw minutes (max 7d retention); otherwise a rollup series.
 */
router.get('/history', asyncHandler(async (req, res) => {
  const { cameraId, bucket } = req.query;
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - 24 * 3600 * 1000);

  if (bucket && !BUCKETS.has(String(bucket))) {
    return res.status(400).json({ success: false, message: 'bucket must be 15m, 1h or 1d' });
  }

  const rows = bucket
    ? await sequelize.query(
      `SELECT ts, count_avg, count_peak, count_min, measured_sec, occupied_sec, person_sec
         FROM occupancy_space_rollup
        WHERE user_id = :userId AND bucket = :bucket AND ts BETWEEN :from AND :to
          ${cameraId ? 'AND space_id = :cameraId' : ''}
        ORDER BY ts ASC LIMIT 5000`,
      { replacements: { userId: req.user.id, bucket, from, to, cameraId }, type: QueryTypes.SELECT },
    )
    : await sequelize.query(
      `SELECT ts, count_avg, count_peak, count_min, quality, samples, samples_measured
         FROM occupancy_camera_minute
        WHERE user_id = :userId AND ts BETWEEN :from AND :to
          ${cameraId ? 'AND camera_id = :cameraId' : ''}
        ORDER BY ts ASC LIMIT 5000`,
      { replacements: { userId: req.user.id, from, to, cameraId }, type: QueryTypes.SELECT },
    );

  // count === null ⇒ we could not see. The chart MUST break the line here.
  const points = rows.map((r) => ({
    ts: r.ts,
    count: r.count_avg === null || r.count_avg === undefined ? null : Number(r.count_avg),
    peak: r.count_peak === null || r.count_peak === undefined ? null : Number(r.count_peak),
    quality: r.quality || (Number(r.measured_sec) > 0 ? 'measured' : 'unknown'),
  }));

  res.json({
    success: true,
    data: {
      from, to, bucket: bucket || 'minute', cameraId: cameraId || null,
      points,
      // How much of the window we could actually see — the honesty metric.
      knownPct: points.length
        ? Math.round((100 * points.filter((p) => p.count !== null).length) / points.length)
        : 0,
    },
  });
}));

/**
 * GET /api/occupancy/summary?cameraId=&from=&to=
 * The report KPIs: peak, average (measured-only), utilization, person-hours.
 */
router.get('/summary', asyncHandler(async (req, res) => {
  const { cameraId } = req.query;
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - 7 * 24 * 3600 * 1000);

  const [agg] = await sequelize.query(
    `SELECT MAX(count_peak)        AS peak,
            SUM(person_sec)        AS person_sec,
            SUM(measured_sec)      AS measured_sec,
            SUM(occupied_sec)      AS occupied_sec,
            SUM(over_cap_sec)      AS over_cap_sec
       FROM occupancy_space_rollup
      WHERE user_id = :userId AND bucket = '1h' AND ts BETWEEN :from AND :to
        ${cameraId ? 'AND space_id = :cameraId' : ''}`,
    { replacements: { userId: req.user.id, from, to, cameraId }, type: QueryTypes.SELECT },
  );

  const measured = Number(agg?.measured_sec) || 0;
  const occupied = Number(agg?.occupied_sec) || 0;
  const personSec = Number(agg?.person_sec) || 0;

  // Busiest hour-of-day, averaged across the period.
  const busiest = await sequelize.query(
    `SELECT HOUR(ts) AS hour, AVG(count_avg) AS avg_count
       FROM occupancy_space_rollup
      WHERE user_id = :userId AND bucket = '1h' AND ts BETWEEN :from AND :to
        AND measured_sec > 0 ${cameraId ? 'AND space_id = :cameraId' : ''}
      GROUP BY HOUR(ts) ORDER BY avg_count DESC LIMIT 1`,
    { replacements: { userId: req.user.id, from, to, cameraId }, type: QueryTypes.SELECT },
  );

  res.json({
    success: true,
    data: {
      from, to,
      peak: agg?.peak === null || agg?.peak === undefined ? null : Number(agg.peak),
      // Average over time we could SEE — never diluted by blind periods.
      averageOccupancy: measured > 0 ? +(personSec / measured).toFixed(2) : null,
      // Share of measured time with at least one person present.
      utilizationPct: measured > 0 ? Math.round((100 * occupied) / measured) : null,
      personHours: +(personSec / 3600).toFixed(1),
      timeOverCapacityMin: Math.round((Number(agg?.over_cap_sec) || 0) / 60),
      measuredHours: +(measured / 3600).toFixed(1),
      busiestHour: busiest.length ? Number(busiest[0].hour) : null,
    },
  });
}));

module.exports = router;
