/**
 * occupancyAggregator.service — turns 5-second occupancy ticks into durable
 * minute rows, and minute rows into report-ready rollups.
 *
 * Why this exists: before it, occupancy lived only in a 30-second Redis gauge —
 * "how many people were in the cafeteria at 2pm yesterday?" was unanswerable.
 * This is the history behind capacity-compliance proof, utilization reports and
 * peak analytics (docs/OCCUPANCY_LOGIC.md).
 *
 * Cadence:
 *   every 60s  flush(): Redis minute accumulators → occupancy_camera_minute
 *   every 5min rollup(): camera-minute rows       → occupancy_space_rollup
 *
 * THE INVARIANT: a minute with no trustworthy sample is written with NULL counts
 * and quality='unknown' — never 0. A dead camera must never read as an empty
 * room. Averages divide by measured_sec, so blind time simply doesn't count.
 *
 * Single-writer: guarded by a Redis lock so multiple backend replicas don't
 * double-write (fails open to "this instance runs it" when Redis is absent —
 * a duplicate UPSERT is idempotent anyway).
 */
const { Op, QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { getClient } = require('../config/redis');
const logger = require('../config/logger');

const FLUSH_MS  = parseInt(process.env.OCCUPANCY_FLUSH_MS  || '60000', 10);
const ROLLUP_MS = parseInt(process.env.OCCUPANCY_ROLLUP_MS || '300000', 10);
// A tick every 5s ⇒ 12/minute. Used to convert samples → seconds.
const TICK_SEC  = parseFloat(process.env.OCCUPANCY_TICK_SEC || '5');

let timers = [];

/**
 * Best-effort single-writer lock, held only for the DURATION of the work.
 *
 * It must be RELEASED on completion, not left to expire: an interval-length TTL
 * makes every scheduled tick race its own expiry, and silently skips any manual
 * or catch-up run. Returns a release() to call in `finally`. Fails open when
 * Redis is absent (the UPSERTs are idempotent, so a duplicate run is harmless).
 */
async function claimLeader(name, ttlSec) {
  const redis = getClient();
  if (!redis) return async () => {};
  try {
    const r = await redis.set(`occ:leader:${name}`, process.pid, 'EX', ttlSec, 'NX');
    if (r !== 'OK' && r !== true) return null;          // someone else is running it
    return async () => { try { await redis.del(`occ:leader:${name}`); } catch { /* expires anyway */ } };
  } catch { return async () => {}; }
}

/**
 * Flush completed minute accumulators (`occ:acc:<cameraId>:<minuteMs>`) into
 * occupancy_camera_minute. Only minutes strictly in the past are flushed, so we
 * never write a half-filled bucket.
 */
async function flush() {
  const redis = getClient();
  if (!redis) return 0;
  const release = await claimLeader('flush', 120);
  if (!release) return 0;

  try {
  const currentMinute = Math.floor(Date.now() / 60000) * 60000;
  let keys = [];
  try {
    keys = await redis.keys('occ:acc:*');
  } catch { return 0; }

  let written = 0;
  for (const key of keys) {
    const [, , cameraId, minuteStr] = key.split(':');
    const minute = Number(minuteStr);
    if (!cameraId || !Number.isFinite(minute) || minute >= currentMinute) continue; // still filling

    let h;
    try { h = await redis.hgetall(key); } catch { continue; }
    if (!h || !h.samples) { await redis.del(key).catch(() => {}); continue; }

    const samples   = Number(h.samples) || 0;
    const measured  = Number(h.samples_measured) || 0;
    const sum       = Number(h.sum) || 0;
    const hasCounts = measured > 0;

    // NULL counts + 'unknown' when nothing was measurable this minute.
    const row = {
      camera_id: cameraId,
      ts: new Date(minute),
      user_id: h.user_id || null,
      monitor_id: h.monitor_id || '',
      count_avg:  hasCounts ? Math.round(sum / measured) : null,
      count_peak: hasCounts && h.peak !== undefined ? Number(h.peak) : null,
      count_min:  hasCounts && h.min !== undefined ? Number(h.min) : null,
      samples,
      samples_measured: measured,
      quality: hasCounts ? 'measured' : 'unknown',
      degraded: Number(h.degraded) > 0 ? 1 : 0,
    };
    if (!row.user_id) { await redis.del(key).catch(() => {}); continue; }

    try {
      await sequelize.query(
        `INSERT INTO occupancy_camera_minute
           (camera_id, ts, user_id, monitor_id, count_avg, count_peak, count_min,
            samples, samples_measured, quality, degraded, created_at)
         VALUES (:camera_id, :ts, :user_id, :monitor_id, :count_avg, :count_peak,
                 :count_min, :samples, :samples_measured, :quality, :degraded, NOW())
         ON DUPLICATE KEY UPDATE
           count_avg = VALUES(count_avg), count_peak = VALUES(count_peak),
           count_min = VALUES(count_min), samples = VALUES(samples),
           samples_measured = VALUES(samples_measured), quality = VALUES(quality),
           degraded = VALUES(degraded)`,
        { replacements: row, type: QueryTypes.INSERT },
      );
      written += 1;
      await redis.del(key).catch(() => {});
    } catch (e) {
      logger.warn('occupancy flush failed for minute', { cameraId, error: e.message });
    }
  }
  if (written) logger.debug('occupancy: minutes flushed', { written });
  return written;
  } finally { await release(); }
}

/**
 * Roll camera-minute rows into 15m/1h/1d buckets.
 *
 * P0 note: one camera == one "space" (space_id = camera_id) until the Space
 * model lands in P1; the rollup shape is already space-keyed so P1 only changes
 * the source of the grouping, not this table.
 *
 * measured_sec is the honest denominator: minutes we could actually see. A blind
 * hour contributes 0 measured_sec and therefore never dilutes an average toward 0.
 */
async function rollup(bucket = '15m', spanMinutes = 15, lookbackHours = 3) {
  const release = await claimLeader(`rollup:${bucket}`, 120);
  if (!release) return 0;
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000);
  const secPerSample = TICK_SEC;

  try {
    const [res] = await sequelize.query(
      `INSERT INTO occupancy_space_rollup
         (space_id, bucket, ts, user_id, count_avg, count_peak, count_min,
          measured_sec, occupied_sec, over_cap_sec, person_sec, capacity,
          created_at, updated_at)
       SELECT
         m.camera_id                              AS space_id,
         :bucket                                  AS bucket,
         FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(m.ts) / :span) * :span) AS ts,
         m.user_id,
         AVG(m.count_avg)                         AS count_avg,
         MAX(m.count_peak)                        AS count_peak,
         MIN(m.count_min)                         AS count_min,
         SUM(m.samples_measured) * :secPerSample  AS measured_sec,
         SUM(CASE WHEN m.count_avg > 0 THEN m.samples_measured ELSE 0 END) * :secPerSample AS occupied_sec,
         0                                        AS over_cap_sec,
         SUM(COALESCE(m.count_avg,0) * m.samples_measured) * :secPerSample AS person_sec,
         NULL                                     AS capacity,
         NOW(), NOW()
       FROM occupancy_camera_minute m
       WHERE m.ts >= :since AND m.quality = 'measured'
       GROUP BY m.camera_id, m.user_id,
                FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(m.ts) / :span) * :span)
       ON DUPLICATE KEY UPDATE
         count_avg = VALUES(count_avg), count_peak = VALUES(count_peak),
         count_min = VALUES(count_min), measured_sec = VALUES(measured_sec),
         occupied_sec = VALUES(occupied_sec), person_sec = VALUES(person_sec),
         updated_at = NOW()`,
      {
        replacements: { bucket, span: spanMinutes * 60, since, secPerSample },
        type: QueryTypes.INSERT,
      },
    );
    return res || 0;
  } catch (e) {
    logger.warn('occupancy rollup failed', { bucket, error: e.message });
    return 0;
  } finally { await release(); }
}

/** Drop aged raw data. Rollups are small and kept far longer (see the doc). */
async function retention() {
  const release = await claimLeader('retention', 300);
  if (!release) return;
  const camDays = parseInt(process.env.OCCUPANCY_CAMERA_MINUTE_RETENTION_DAYS || '7', 10);
  const spcDays = parseInt(process.env.OCCUPANCY_MINUTE_RETENTION_DAYS || '90', 10);
  const cut = (d) => new Date(Date.now() - d * 86400 * 1000);
  try {
    await sequelize.query('DELETE FROM occupancy_camera_minute WHERE ts < :cut',
      { replacements: { cut: cut(camDays) }, type: QueryTypes.DELETE });
    await sequelize.query('DELETE FROM occupancy_space_minute WHERE ts < :cut',
      { replacements: { cut: cut(spcDays) }, type: QueryTypes.DELETE });
  } catch (e) {
    logger.warn('occupancy retention sweep failed', { error: e.message });
  } finally { await release(); }
}

function start() {
  stop();
  timers.push(setInterval(() => flush().catch(() => {}), FLUSH_MS));
  timers.push(setInterval(() => {
    rollup('15m', 15, 3).catch(() => {});
    rollup('1h', 60, 26).catch(() => {});
    rollup('1d', 1440, 24 * 8).catch(() => {});
  }, ROLLUP_MS));
  timers.push(setInterval(() => retention().catch(() => {}), 6 * 3600 * 1000));
  timers.forEach((t) => t.unref && t.unref());
  logger.info('occupancy aggregator started', { flushMs: FLUSH_MS, rollupMs: ROLLUP_MS });
}

function stop() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = { start, stop, flush, rollup, retention, _internals: { claimLeader } };
