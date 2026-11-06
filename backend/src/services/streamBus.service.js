/**
 * streamBus.service.js
 *
 * Cross-process event bus on Redis Streams.
 *
 * The in-process EventEmitter (events/bus.js) handles same-instance fan-out;
 * THIS service mirrors selected events to a Redis Stream so other processes
 * (additional backend instances, the smart-cam-ai worker, the WS gateway, the
 * admin dashboard backend) can subscribe to camera lifecycle and AI events
 * without polling the database.
 *
 * Why Redis Streams and not Pub/Sub?
 *   - Pub/Sub drops messages when no subscriber is online; that's unacceptable
 *     for camera state changes that drive alerting.
 *   - Streams persist (capped via XADD MAXLEN ~) so a worker that restarts can
 *     resume from its last delivered ID with XREAD.
 *   - Consumer groups (XREADGROUP) give us at-least-once delivery + horizontal
 *     fan-out across multiple worker replicas without duplicate processing.
 *
 * Stream layout
 *   drisyam:events:camera   — camera + stream lifecycle (CAMERA_*, STREAM_*)
 *   drisyam:events:ai       — AI detections + alerts (AI_*)
 *   drisyam:events:recording — recording sync events (RECORDING_*)
 *
 * Each entry is a single field/value pair: ["event", JSON.stringify({type, payload})]
 * Keeping the schema flat means consumers in any language only need to
 * JSON.parse one field.
 *
 * Bridging — start() wires every EVENTS.* emitted on the local EventEmitter
 * onto the corresponding stream. Producers can also call publish() directly
 * without going through the EventEmitter (used by streamSupervisor).
 */

const Redis = require('ioredis');

const config = require('../config/env');
const logger = require('../config/logger');
const { bus, EVENTS } = require('../events/bus');

const STREAMS = Object.freeze({
  CAMERA:    'drisyam:events:camera',
  AI:        'drisyam:events:ai',
  RECORDING: 'drisyam:events:recording',
});

const MAX_STREAM_LEN = parseInt(process.env.STREAM_BUS_MAXLEN || '50000', 10);

// Map every EVENTS.* to its stream key
const EVENT_TO_STREAM = {
  [EVENTS.CAMERA_CREATED]:     STREAMS.CAMERA,
  [EVENTS.CAMERA_UPDATED]:     STREAMS.CAMERA,
  [EVENTS.CAMERA_DELETED]:     STREAMS.CAMERA,
  [EVENTS.GROUP_CREATED]:      STREAMS.CAMERA,
  [EVENTS.GROUP_DELETED]:      STREAMS.CAMERA,
  [EVENTS.STREAM_READY]:       STREAMS.CAMERA,
  [EVENTS.STREAM_OFFLINE]:     STREAMS.CAMERA,
  [EVENTS.RECORDING_SYNCED]:   STREAMS.RECORDING,
  [EVENTS.AI_EVENT_DETECTED]:  STREAMS.AI,
  [EVENTS.AI_ALERT_TRIGGERED]: STREAMS.AI,
};

let _redis      = null;
let _bridged    = false;
let _consumers  = []; // active background readers, closed on stop()

// ── Connect ───────────────────────────────────────────────────────────────────

async function getClient() {
  if (_redis) return _redis;
  if (!config.redisUrl) return null;

  _redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  try {
    await _redis.connect();
    await _redis.ping();
    return _redis;
  } catch (err) {
    logger.warn('streamBus: Redis unavailable — cross-process events disabled', {
      error: err.message,
    });
    try { await _redis.quit(); } catch (_) { /* swallow */ }
    _redis = null;
    return null;
  }
}

// ── Producer ──────────────────────────────────────────────────────────────────

/**
 * Publish a single event to its stream. Best-effort: returns false if Redis is
 * down. Idempotency is the consumer's job (use message id or a content hash).
 *
 * The event id can later be retrieved via XRANGE / XREAD.
 */
async function publish(eventType, payload) {
  const stream = EVENT_TO_STREAM[eventType];
  if (!stream) {
    logger.debug('streamBus: no stream mapping for event', { eventType });
    return false;
  }
  const r = await getClient();
  if (!r) return false;
  try {
    await r.xadd(
      stream,
      'MAXLEN', '~', MAX_STREAM_LEN,        // approximate trim — cheap on the server
      '*',                                   // server-assigned id
      'event', JSON.stringify({
        type: eventType,
        ts:   Date.now(),
        payload,
      }),
    );
    return true;
  } catch (err) {
    logger.warn('streamBus: publish failed', { stream, eventType, error: err.message });
    return false;
  }
}

// ── Bridge: every in-process emit also publishes to Redis ─────────────────────

function startBridge() {
  if (_bridged) return;
  _bridged = true;
  for (const [evt, stream] of Object.entries(EVENT_TO_STREAM)) {
    bus.on(evt, async (payload) => {
      try { await publish(evt, payload); }
      catch (err) {
        logger.debug('streamBus: bridge emit failed', { evt, stream, error: err.message });
      }
    });
  }
}

// ── Consumer (consumer-group) ────────────────────────────────────────────────

/**
 * Subscribe to a stream as part of a named consumer group. Multiple replicas
 * sharing a group name get partitioned automatically by Redis (each entry
 * delivered to exactly one replica). Different groups all see every entry.
 *
 *   subscribe(STREAMS.AI, 'alert-dispatcher', 'replica-1', async (id, evt) => {...})
 *
 * The handler MUST resolve to acknowledge delivery (XACK). Throwing leaves the
 * entry in the pending-entries-list (PEL) so a sibling consumer can take it
 * after the visibility timeout — this is the key durability guarantee over
 * pub/sub.
 *
 * Returns a stop() function.
 */
async function subscribe(stream, groupName, consumerName, handler, {
  blockMs = 5000,
  count   = 50,
  startId = '$',           // '$' = only new entries, '0' = full history
  visibilityTimeoutMs = 30000,
} = {}) {
  const r = await getClient();
  if (!r) return () => {};

  // Idempotently create the group. MKSTREAM lets us create-on-empty.
  try {
    await r.xgroup('CREATE', stream, groupName, startId, 'MKSTREAM');
  } catch (err) {
    if (!String(err?.message || '').includes('BUSYGROUP')) {
      logger.warn('streamBus: xgroup create failed', { stream, groupName, error: err.message });
    }
  }

  let stopped = false;
  let _periodicReclaim = null;

  // Periodic claim of stale pending entries from dead consumers in our group
  if (visibilityTimeoutMs > 0) {
    _periodicReclaim = setInterval(async () => {
      if (stopped) return;
      try {
        await r.xautoclaim(
          stream, groupName, consumerName,
          visibilityTimeoutMs, '0-0', 'COUNT', 50,
        );
      } catch (_) { /* ignore — older Redis versions or empty PEL */ }
    }, Math.max(visibilityTimeoutMs, 5000));
  }

  // Main read loop. Long-blocking XREADGROUP keeps Redis happy with no busy-spin.
  (async function loop() {
    while (!stopped) {
      try {
        const res = await r.xreadgroup(
          'GROUP', groupName, consumerName,
          'COUNT', count,
          'BLOCK', blockMs,
          'STREAMS', stream, '>',
        );
        if (!res) continue;

        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            // fields = ['event', '<json>'] — flat schema enforced on publish
            const idx = fields.indexOf('event');
            if (idx < 0 || idx + 1 >= fields.length) continue;
            let parsed;
            try { parsed = JSON.parse(fields[idx + 1]); }
            catch (_) {
              await r.xack(stream, groupName, id).catch(() => {});
              continue;
            }
            try {
              await handler(id, parsed);
              await r.xack(stream, groupName, id).catch(() => {});
            } catch (err) {
              // Don't ACK — let visibility timeout deliver to another consumer
              logger.warn('streamBus: handler threw, leaving entry pending', {
                stream, groupName, id, error: err.message,
              });
            }
          }
        }
      } catch (err) {
        if (stopped) break;
        logger.warn('streamBus: xreadgroup error', { stream, groupName, error: err.message });
        await new Promise((res) => setTimeout(res, 1000));
      }
    }
  })();

  const stopFn = async () => {
    stopped = true;
    if (_periodicReclaim) clearInterval(_periodicReclaim);
  };
  _consumers.push(stopFn);
  return stopFn;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

async function start() {
  // Probe and bridge — bridge is no-op if Redis is unreachable
  await getClient();
  if (_redis) startBridge();
  return !!_redis;
}

async function stop() {
  for (const s of _consumers) {
    try { await s(); } catch (_) { /* swallow */ }
  }
  _consumers = [];
  if (_redis) {
    try { await _redis.quit(); } catch (_) { /* swallow */ }
    _redis = null;
  }
  _bridged = false;
}

module.exports = {
  STREAMS,
  publish,
  subscribe,
  start,
  stop,
};
