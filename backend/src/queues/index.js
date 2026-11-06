/**
 * queues/index.js — BullMQ queue + worker registry.
 *
 * Why BullMQ over setInterval / in-memory state?
 *   - Durable across crashes & redeploys (jobs persisted in Redis)
 *   - Safe under multiple backend instances (no double-uploads)
 *   - Built-in retries with exponential backoff
 *   - Repeatable jobs replace setInterval cleanly
 *   - Bull Board can render the dashboard later without code changes
 *
 * If Redis is unavailable, queues silently no-op (graceful degradation):
 *   we still have an existing Redis fallback pattern in config/redis.js, and
 *   the recording sync watchdog falls back to its legacy setInterval mode.
 *
 * Queue conventions:
 *   - One queue per job type. Concurrency tuned per worker file.
 *   - Job IDs deduplicate where applicable (e.g. one S3 sync per camera segment).
 *   - All payloads are small JSON — never include buffers; reference S3 keys instead.
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const config = require('../config/env');
const logger = require('../config/logger');

// ── Connection ──────────────────────────────────────────────────────────────
// BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false`
// for blocking commands used by workers.

function buildConnection() {
  return {
    // ioredis URL parsing — the same REDIS_URL we already validate in env.js
    connection: {
      // Allow `redis://[:pass@]host:port[/db]` and `rediss://...` URLs
      url: config.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379',
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
    },
  };
}

// ── Queue registry ──────────────────────────────────────────────────────────
// Add new queues here. Names are also used as the BullMQ key prefix in Redis,
// so changing a name is a breaking change — keep them stable.

// BullMQ disallows ':' in queue names (it uses ':' internally as a Redis key
// separator). Stick to letters, digits, '-' and '_'.
const QUEUE_NAMES = Object.freeze({
  S3_SYNC:           'drishyam-s3-sync',
  WATCHDOG:          'drishyam-watchdog',
  AI_EVENT_INGEST:   'drishyam-ai-events',
  ALERT_DISPATCH:    'drishyam-alert-dispatch',
  SNAPSHOT:          'drishyam-snapshot',
  TRANSCODE:         'drishyam-transcode',
});

const _queues = new Map();
const _workers = new Map();
const _queueEvents = new Map();

// ── Enabled flag ──────────────────────────────────────────────────────────────
// Producers (e.g. transcoder.requestTranscode) consult this to decide whether to
// enqueue or run inline. workers.start() sets it true ONLY after a successful
// Redis PING + worker registration, so when Redis is down every producer falls
// back to its legacy in-process path instead of enqueuing into the void.
let _enabled = false;
function setEnabled(v) { _enabled = !!v; }
function isEnabled()   { return _enabled; }

/**
 * Lazily create (and cache) a QueueEvents stream for a queue. Required by
 * `job.waitUntilFinished(queueEvents)` so a producer can await a job's result
 * (e.g. the live-view path needs the transcoder's {spawned,reason} back).
 */
function getQueueEvents(name) {
  if (_queueEvents.has(name)) return _queueEvents.get(name);
  const qe = new QueueEvents(name, buildConnection());
  qe.on('error', () => { /* connection blips are handled by callers' fallback */ });
  _queueEvents.set(name, qe);
  return qe;
}

/** Get or lazily create a Queue. */
function getQueue(name) {
  if (_queues.has(name)) return _queues.get(name);
  const q = new Queue(name, {
    ...buildConnection(),
    defaultJobOptions: {
      attempts:     3,
      backoff:      { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600,  count: 1_000 },
      removeOnFail:     { age: 86400, count:   500 },
    },
  });
  _queues.set(name, q);
  return q;
}

/**
 * Register a worker for a queue. Pass an async `processor(job)` and an optional
 * concurrency. Returns the Worker so callers can attach extra listeners.
 */
function registerWorker(name, processor, { concurrency = 4 } = {}) {
  if (_workers.has(name)) return _workers.get(name);

  const worker = new Worker(name, processor, {
    ...buildConnection(),
    concurrency,
  });

  worker.on('failed', (job, err) => {
    logger.warn('queue job failed', {
      queue:    name,
      jobId:    job?.id,
      attempts: job?.attemptsMade,
      error:    err?.message,
    });
  });

  worker.on('error', (err) => {
    // Connection-level error; don't crash, just log
    logger.warn('queue worker error', { queue: name, error: err.message });
  });

  _workers.set(name, worker);
  logger.info(`queue worker registered: ${name} (concurrency=${concurrency})`);
  return worker;
}

/**
 * Schedule a repeatable job. Replaces setInterval — runs even if the process
 * was down at the scheduled time (catch-up behavior is BullMQ default).
 *
 * @param {string} name      — queue name
 * @param {string} jobName   — job type
 * @param {object} data      — payload
 * @param {number} everyMs   — interval in milliseconds
 */
async function scheduleRepeatable(name, jobName, data, everyMs) {
  const q = getQueue(name);
  await q.add(jobName, data, {
    repeat: { every: everyMs },
    jobId:  `repeat:${jobName}`,           // stable id avoids duplicate scheduling
  });
  logger.info(`queue scheduled: ${jobName} every ${everyMs}ms`);
}

/** Graceful shutdown — close all queues, workers and event streams. */
async function shutdown() {
  for (const w of _workers.values()) {
    try { await w.close(); } catch (_) {}
  }
  for (const qe of _queueEvents.values()) {
    try { await qe.close(); } catch (_) {}
  }
  for (const q of _queues.values()) {
    try { await q.close(); } catch (_) {}
  }
}

module.exports = {
  QUEUE_NAMES,
  getQueue,
  getQueueEvents,
  registerWorker,
  scheduleRepeatable,
  setEnabled,
  isEnabled,
  shutdown,
};
