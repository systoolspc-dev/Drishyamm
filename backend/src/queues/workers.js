/**
 * queues/workers.js — register all BullMQ workers + repeatable jobs.
 *
 * Called once from server.js after the HTTP server is up. Failures here are
 * non-fatal: we log and let the process keep serving REST traffic.
 *
 * Repeatable jobs registered:
 *   - s3-sync:run       every 5 min   → recordingSync.runSync()
 *   - watchdog:run      every 2 min   → recordingSync.runWatchdog()
 *
 * On-demand queues registered:
 *   - alert-dispatch:send       (one job per alert)
 *   - ai-events:ingest          (used when ingest needs heavy post-processing)
 *   - snapshot:generate         (ffmpeg snapshot for an event/recording)
 */

const Redis  = require('ioredis');

const config = require('../config/env');
const logger = require('../config/logger');
const {
  QUEUE_NAMES,
  registerWorker,
  scheduleRepeatable,
  getQueue,
  setEnabled,
} = require('./index');

const recordingSync = require('../services/recordingSync.service');
const transcoder    = require('../services/transcoder.service');

// Transcode worker concurrency. Deliberately set ABOVE the transcoder's own
// MAX_CONCURRENT cap so the queue is NOT the limiter — each job runs the
// idempotent ensure* immediately, and ensurePathTranscoder still does the fast
// capacity reject (returns {spawned:false, reason:'capacity'}) exactly as
// before. This preserves behavior; A2 will replace that cap with GPU-aware
// scheduling and make this concurrency the real per-node session budget.
const TRANSCODE_CONCURRENCY = parseInt(process.env.TRANSCODER_QUEUE_CONCURRENCY, 10) || 32;

/**
 * Probe Redis with a short connect timeout. We do this before BullMQ touches
 * Redis because BullMQ's reconnect loop spams the log when Redis is down.
 * Returns true only when we successfully PING the server.
 */
async function probeRedis() {
  const url = config.redisUrl || 'redis://localhost:6379';
  const client = new Redis(url, {
    lazyConnect:           true,
    connectTimeout:        2_000,
    maxRetriesPerRequest:  0,
    enableReadyCheck:      false,
    retryStrategy:         () => null,   // do not retry — fail fast
  });
  try {
    await client.connect();
    const reply = await client.ping();
    await client.quit();
    return reply === 'PONG';
  } catch (err) {
    try { await client.quit(); } catch (_) {}
    return false;
  }
}

const FIVE_MIN = 5 * 60 * 1_000;
const TWO_MIN  = 2 * 60 * 1_000;

async function start() {
  // Probe Redis once. If it's not there, don't register workers — they would
  // otherwise spam the log with reconnect attempts. The legacy setInterval
  // fallback in server.js takes over instead.
  const redisOk = await probeRedis();
  if (!redisOk) {
    setEnabled(false);
    logger.info('Redis unreachable — BullMQ disabled, using legacy in-process intervals');
    return false;
  }
  logger.info('Redis OK — registering BullMQ workers');

  try {
    // ── S3 sync: runs the same logic as the legacy setInterval loop, but durable
    registerWorker(
      QUEUE_NAMES.S3_SYNC,
      async (job) => {
        if (job.name === 'run') {
          await recordingSync.runSync();
        }
      },
      { concurrency: 1 },   // never run two syncs concurrently
    );

    // ── Watchdog: reconciles Stream Service configured paths against DB cameras
    registerWorker(
      QUEUE_NAMES.WATCHDOG,
      async (job) => {
        if (job.name === 'run') {
          await recordingSync.runWatchdog();
        }
      },
      { concurrency: 1 },
    );

    // ── Alert dispatch: SMS / email / push fan-out (Phase 5)
    registerWorker(
      QUEUE_NAMES.ALERT_DISPATCH,
      async (job) => {
        // Stub — handler will be implemented in Phase 5 of the AI plan.
        logger.debug('alert-dispatch job (stub)', { jobId: job.id, data: job.data });
      },
      { concurrency: 8 },
    );

    // ── AI event ingest: when post-processing (face match, thumbnail) is heavy
    registerWorker(
      QUEUE_NAMES.AI_EVENT_INGEST,
      async (job) => {
        logger.debug('ai-event ingest job (stub)', { jobId: job.id });
      },
      { concurrency: 4 },
    );

    // ── Snapshot generator
    registerWorker(
      QUEUE_NAMES.SNAPSHOT,
      async (job) => {
        logger.debug('snapshot job (stub)', { jobId: job.id });
      },
      { concurrency: 2 },   // ffmpeg is CPU-heavy; keep concurrency low
    );

    // ── Transcode: ensure an H.265→H.264 transcoder for a camera/variant.
    // The processor just calls the existing idempotent ensure* functions, so
    // this is behavior-parity with the old in-process call — it only adds
    // durability, dedup (one job per cam+variant), and a control seam. The job
    // RETURNS {spawned,reason} so a producer using wait:true gets it back.
    registerWorker(
      QUEUE_NAMES.TRANSCODE,
      async (job) => {
        const { monitorId, variant = 'main' } = job.data || {};
        if (!monitorId) return { spawned: false, reason: 'no-monitor' };
        if (variant === 'sub') return transcoder.ensureSubTranscoder(monitorId);
        if (variant === 'low') return transcoder.ensureLowTranscoder(monitorId);
        return transcoder.ensureTranscoder(monitorId);
      },
      { concurrency: TRANSCODE_CONCURRENCY },
    );

    // ── Repeatable schedules ────────────────────────────────────────────────
    // jobId in scheduleRepeatable() ensures we don't end up with N copies after
    // multiple boots.
    await scheduleRepeatable(QUEUE_NAMES.S3_SYNC,  'run', {}, FIVE_MIN);
    await scheduleRepeatable(QUEUE_NAMES.WATCHDOG, 'run', {}, TWO_MIN);

    // First-run kick: BullMQ won't fire the repeatable until `every` elapses;
    // we want one immediate sync on boot.
    await getQueue(QUEUE_NAMES.S3_SYNC).add('run', {}, { delay: 30_000 });
    await getQueue(QUEUE_NAMES.WATCHDOG).add('run', {}, { delay: 60_000 });

    setEnabled(true);
    logger.info('BullMQ workers + repeatable jobs registered');
    return true;
  } catch (err) {
    setEnabled(false);
    logger.warn('BullMQ startup failed — falling back to in-process intervals', {
      error: err.message,
    });
    return false;
  }
}

module.exports = { start };
