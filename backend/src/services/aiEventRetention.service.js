/**
 * aiEventRetention.service — periodic pruning of the backend `ai_events` table.
 *
 * The AI service (vms_face) already prunes its OWN Postgres detection_events /
 * Qdrant / snapshots via its retention_worker. But the backend keeps a SEPARATE
 * MySQL `ai_events` mirror (written by the internal AI-events route and read by
 * the operator UI). Nothing pruned that table, so it grew unbounded — a lakh+
 * rows/day at scale — degrading the (user_id, ts) queries and eventually the
 * disk.
 *
 * This deletes rows older than AI_EVENT_RETENTION_DAYS on a slow interval,
 * in bounded batches so a large backlog can't lock the table in one statement.
 * Set AI_EVENT_RETENTION_DAYS=0 to disable (keep forever).
 */
const { Op } = require('sequelize');
const logger = require('../config/logger');

const RETENTION_DAYS = parseInt(process.env.AI_EVENT_RETENTION_DAYS || '90', 10);
const INTERVAL_MS    = parseInt(process.env.AI_EVENT_RETENTION_INTERVAL_MS || `${6 * 60 * 60 * 1000}`, 10); // 6h
const BATCH_LIMIT    = 5000;   // rows deleted per statement; loop until under cutoff

let _timer = null;
let _running = false;

async function prune() {
  if (_running) return;                 // never overlap ticks
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) return;   // disabled
  _running = true;
  try {
    const { AIEvent } = require('../models');
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let total = 0;
    // Delete in batches so one huge DELETE can't hold a long table lock.
    for (;;) {
      const deleted = await AIEvent.destroy({
        where: { ts: { [Op.lt]: cutoff } },
        limit: BATCH_LIMIT,
      });
      total += deleted;
      if (deleted < BATCH_LIMIT) break;
    }
    if (total > 0) {
      logger.info('ai_events retention: pruned old rows', { deleted: total, olderThanDays: RETENTION_DAYS });
    }
  } catch (err) {
    logger.warn('ai_events retention: prune failed (will retry next interval)', { error: err.message });
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return;
  if (!RETENTION_DAYS || RETENTION_DAYS <= 0) {
    logger.info('ai_events retention: disabled (AI_EVENT_RETENTION_DAYS<=0)');
    return;
  }
  // Run once shortly after boot, then on the interval.
  setTimeout(() => { prune().catch(() => {}); }, 60_000).unref?.();
  _timer = setInterval(() => { prune().catch(() => {}); }, INTERVAL_MS);
  _timer.unref?.();
  logger.info('ai_events retention: started', { olderThanDays: RETENTION_DAYS, intervalMs: INTERVAL_MS });
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, prune };
