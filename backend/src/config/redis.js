/**
 * redis.js — shared Redis client with graceful degradation.
 *
 * If REDIS_URL is not set, or if Redis is unreachable, every cache operation
 * returns null / is silently skipped. The application continues to work
 * correctly — just without the performance benefit of caching.
 *
 * TTL constants (seconds):
 *   THUMB_TTL          = 7 days   — thumbnails never change once recorded
 *   RECORDINGS_TTL     = 5 min    — matches S3 sync interval (runs every 5 min);
 *                                   new recordings appear within one sync cycle
 */

const Redis  = require('ioredis');
const logger = require('./logger');

const THUMB_TTL      = 7 * 24 * 60 * 60;   // 7 days
const RECORDINGS_TTL = 5 * 60;              // 5 minutes (matches sync interval)

let _client = null;
let _failed = false;  // Don't keep retrying if Redis is absent

function getClient() {
  if (_failed) return null;
  if (_client) return _client;

  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  _client = new Redis(url, {
    lazyConnect:          true,   // don't connect until first command
    connectTimeout:       3000,   // give up quickly if Redis isn't there
    maxRetriesPerRequest: 1,      // one retry per command, then throw
    enableReadyCheck:     false,
    retryStrategy:        (times) => {
      // Give up after 3 connect attempts to avoid spamming logs
      if (times >= 3) {
        _failed = true;
        _client  = null;
        logger.warn('Redis: giving up after 3 connection attempts — running without cache');
        return null; // stop retrying
      }
      return Math.min(times * 500, 2000);
    },
  });

  _client.on('connect', () => {
    logger.info('Redis: connected');
    _failed = false;
  });

  _client.on('error', (err) => {
    // Suppress repeated ECONNREFUSED noise after the first warning
    if (!_failed) {
      logger.warn('Redis: connection error', { error: err.message });
    }
  });

  return _client;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get a cached Buffer from Redis. Returns null on miss or error.
 */
async function getBuffer(key) {
  const client = getClient();
  if (!client) return null;
  try {
    return await client.getBuffer(key);
  } catch {
    return null;
  }
}

/**
 * Store a Buffer in Redis with a TTL. Silently ignores errors.
 */
async function setBuffer(key, value, ttlSeconds) {
  const client = getClient();
  if (!client || !value || value.length === 0) return;
  try {
    await client.setex(key, ttlSeconds, value);
  } catch {
    // Ignore — cache is non-critical
  }
}

/**
 * Get a cached JSON object. Returns null on miss or error.
 */
async function getJSON(key) {
  const client = getClient();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Store a JSON-serialisable value with a TTL. Silently ignores errors.
 */
async function setJSON(key, value, ttlSeconds) {
  const client = getClient();
  if (!client) return;
  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value));
  } catch {
    // Ignore
  }
}

/**
 * Delete one or more keys (e.g. to invalidate a cached recording list).
 */
async function del(...keys) {
  const client = getClient();
  if (!client || keys.length === 0) return;
  try {
    await client.del(...keys);
  } catch {
    // Ignore
  }
}

module.exports = {
  getClient,
  getBuffer,
  setBuffer,
  getJSON,
  setJSON,
  del,
  THUMB_TTL,
  RECORDINGS_TTL,
};
