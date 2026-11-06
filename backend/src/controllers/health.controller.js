/**
 * health.controller.js
 *
 * Three liveness/readiness endpoints used by load balancers, Kubernetes,
 * Docker healthchecks, and on-call dashboards. The split mirrors industry
 * standard liveness vs readiness semantics:
 *
 *   GET /api/health/live     — process is alive (no deps checked)
 *   GET /api/health/ready    — all dependencies are reachable; safe to send traffic
 *   GET /api/health/full     — deep diagnostic for ops; never used for routing
 *
 * Why three endpoints?
 *   - liveness probes must be CHEAP (run every few seconds) and never fail on
 *     downstream issues — they should only fail if the process is wedged.
 *   - readiness probes can be more expensive and SHOULD fail when Stream Service or
 *     the DB is unreachable, so the LB removes the instance from rotation.
 *   - full is the on-call view: returns 200 with a per-component status doc
 *     even when components are degraded. This is what Grafana and the admin
 *     dashboard hit; it never causes traffic redirection.
 */

const axios = require('axios');

const config       = require('../config/env');
const logger       = require('../config/logger');
const { sequelize } = require('../models');

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  if (!config.redisUrl) return null;
  try {
    const Redis = require('ioredis');
    _redis = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      connectTimeout: 1500,
      retryStrategy: () => null,
    });
  } catch (_) { _redis = null; }
  return _redis;
}

const HEALTH_VERSION = process.env.GIT_SHA || process.env.npm_package_version || 'dev';

// ── Component checks ─────────────────────────────────────────────────────────

async function checkDb() {
  const t0 = Date.now();
  try {
    await sequelize.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err.message };
  }
}

async function checkRedis() {
  const r = getRedis();
  if (!r) return { ok: false, error: 'redis not configured' };
  const t0 = Date.now();
  try {
    if (r.status !== 'ready' && r.status !== 'connecting') await r.connect().catch(() => {});
    const reply = await r.ping();
    return { ok: reply === 'PONG', latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err.message };
  }
}

async function checkStreamServers() {
  const { StreamServer } = require('../models');
  let servers = [];
  try {
    servers = await StreamServer.findAll({ where: { status: ['online', 'draining'] } });
  } catch (err) {
    return [{ name: 'lookup', ok: false, error: err.message }];
  }
  if (!servers.length) {
    // Fallback to env-configured single server
    return [await probeMediamtxApi('default', config.streamService.apiUrl, config.streamService.apiUser, config.streamService.apiPass)];
  }
  return Promise.all(servers.map((s) => probeMediamtxApi(s.name, s.apiUrl, s.apiUser, s.apiPass)));
}

async function probeMediamtxApi(name, baseURL, user, pass) {
  const t0 = Date.now();
  try {
    const resp = await axios.get(`${baseURL}/v3/paths/list`, {
      timeout: 2500,
      auth: user ? { username: user, password: pass || '' } : undefined,
    });
    return { name, ok: true, latencyMs: Date.now() - t0, paths: resp.data?.items?.length || 0 };
  } catch (err) {
    return { name, ok: false, latencyMs: Date.now() - t0, error: err.message };
  }
}

async function checkAiService() {
  if (!config.aiServiceUrl) return { ok: false, error: 'AI_SERVICE_URL not set' };
  const t0 = Date.now();
  // The smart-cam-ai service exposes /status (200) — it has NO /health route,
  // so probing /health always 404'd and falsely reported the AI engine down.
  try {
    const resp = await axios.get(`${config.aiServiceUrl}/status`, { timeout: 2500 });
    return { ok: resp.status === 200, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err.message };
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function live(_req, res) {
  res.json({
    status:  'alive',
    version: HEALTH_VERSION,
    uptime:  Math.round(process.uptime()),
    pid:     process.pid,
    ts:      new Date().toISOString(),
  });
}

async function ready(_req, res) {
  // Strict: any failure = 503. Used by LB / k8s readiness probe.
  const [db, redis, mtxList] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkStreamServers(),
  ]);
  const mtxOk = mtxList.some((m) => m.ok); // at least one Stream Service up

  const ok = db.ok && redis.ok && mtxOk;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ready' : 'not_ready',
    components: { db, redis, mediamtx: mtxList },
    ts: new Date().toISOString(),
  });
}

async function full(_req, res) {
  const t0 = Date.now();
  const [db, redis, mtxList, ai] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkStreamServers(),
    checkAiService(),
  ]);

  const mem = process.memoryUsage();
  const result = {
    status:  'ok',           // never 5xx — this is a diagnostic
    version: HEALTH_VERSION,
    uptime:  Math.round(process.uptime()),
    elapsedMs: Date.now() - t0,
    ts:      new Date().toISOString(),
    process: {
      pid: process.pid,
      node: process.version,
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      rssMb:      Math.round(mem.rss / 1024 / 1024),
    },
    components: {
      db,
      redis,
      mediamtx: mtxList,
      aiService: ai,
    },
  };
  res.json(result);
}

module.exports = {
  live, ready, full,
  // Reused by platformEvents.service's service-health monitor (service.down/up).
  checks: { checkDb, checkRedis, checkStreamServers, checkAiService },
};
