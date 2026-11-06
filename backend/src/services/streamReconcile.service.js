/**
 * streamReconcile.service.js
 *
 * Continuous DB → Stream Service config sync (a reconciliation controller).
 *
 * WHY
 * ---
 * Our database is the source of truth for recording retention, but Stream Service
 * keeps its OWN config state. They drift: an applyRetention() PATCH can fail
 * while Stream Service is briefly unreachable, a Stream Service restart can reload stale
 * config, or a site-level default can change without touching each camera. The
 * API path applies changes immediately (real-time for user actions); THIS loop
 * is the safety net that continuously re-converges Stream Service to the DB.
 *
 * HOW (efficient at thousands of cameras)
 *   1. Resolve desired retention for ALL cameras with batch map lookups
 *      (cameras + groups + sites loaded once — no per-camera queries).
 *   2. Fetch observed recordDeleteAfter for every path in ONE config call per
 *      Stream Service server.
 *   3. Diff by absolute duration (unit-agnostic: Stream Service may store "30d" where
 *      we sent "720h") and PATCH only the drifted paths, bounded-concurrency.
 *
 * Idempotent — safe to run on an interval; a no-drift cycle issues zero writes.
 */

const axios  = require('axios');
const config = require('../config/env');
const logger = require('../config/logger');
const recordingRetention = require('./recordingRetention.service');

let _models = null;
const loadModels = () => {
  if (_models) return _models;
  _models = require('../models');
  return _models;
};

const INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS, 10) || 60_000;
const CONCURRENCY = parseInt(process.env.RECONCILE_CONCURRENCY, 10) || 8;
const ENABLED     = process.env.RECONCILE_ENABLED !== '0';

let _timer   = null;
let _running = false;
let _inCycle = false;

// ── Duration parsing (Stream Service/Go-ish: 30d, 720h, 90m, 0s …) → seconds ────────
const UNIT_SEC = { d: 86400, h: 3600, m: 60, s: 1 };
function durationToSeconds(str) {
  if (!str || str === '0s') return 0;
  let total = 0; let m;
  const re = /(\d+)(d|h|m|s)/g;
  while ((m = re.exec(str))) total += parseInt(m[1], 10) * UNIT_SEC[m[2]];
  return total;
}

// ── Stream Service servers to query (pool, else the env-default single instance) ────
async function serverList() {
  const { StreamServer } = loadModels();
  let servers = [];
  try {
    servers = await StreamServer.findAll({ where: { status: ['online', 'draining'] }, raw: true });
  } catch (_) { /* table may be empty / absent */ }
  if (servers.length) {
    return servers.map((s) => ({ apiUrl: s.apiUrl, apiUser: s.apiUser, apiPass: s.apiPass }));
  }
  return [{ apiUrl: config.streamService.apiUrl, apiUser: config.streamService.apiUser, apiPass: config.streamService.apiPass }];
}

/** observed: pathName → recordDeleteAfter string, across all servers. */
async function fetchObserved() {
  const servers = await serverList();
  const map = new Map();
  for (const s of servers) {
    const auth = s.apiUser ? { username: s.apiUser, password: s.apiPass || '' } : undefined;
    let page = 0;
    for (;;) {
      const { data } = await axios.get(`${s.apiUrl}/v3/config/paths/list`, {
        params: { page, itemsPerPage: 1000 }, auth, timeout: 8000,
      });
      for (const it of (data.items || [])) map.set(it.name, it.recordDeleteAfter ?? '');
      const pageCount = data.pageCount || 1;
      if (page >= pageCount - 1) break;
      page += 1;
    }
  }
  return map;
}

/** desired: [{ monitorId, mediamtxServerId, days }] resolved via batch maps. */
async function resolveDesired() {
  const { Camera, CameraGroup, Site } = loadModels();
  const [cameras, groups, sites] = await Promise.all([
    Camera.findAll({ attributes: ['monitorId', 'mediamtxServerId', 'groupId', 'retentionDays'], raw: true }),
    CameraGroup.findAll({ attributes: ['id', 'retentionDays', 'siteId'], raw: true }),
    Site.findAll({ attributes: ['id', 'settings'], raw: true }).catch(() => []),
  ]);
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const siteMap  = new Map(sites.map((s) => [s.id, s]));
  const DEFAULT  = recordingRetention.DEFAULT_RETENTION_DAYS;

  return cameras.map((cam) => {
    let days = cam.retentionDays;
    if (days == null) {
      const g = cam.groupId ? groupMap.get(cam.groupId) : null;
      if (g && g.retentionDays != null) days = g.retentionDays;
      else if (g && g.siteId) {
        const r = siteMap.get(g.siteId)?.settings?.retentionDays;
        if (r != null) days = r;
      }
    }
    return { monitorId: cam.monitorId, mediamtxServerId: cam.mediamtxServerId, days: Number(days ?? DEFAULT) };
  });
}

/** One reconcile pass. Returns { checked, drifted }. */
async function reconcileRetention() {
  if (_inCycle) return { checked: 0, drifted: 0, skipped: true };
  _inCycle = true;
  try {
    let observed;
    try { observed = await fetchObserved(); }
    catch (err) {
      logger.warn('reconcile: fetch Stream Service config failed', { error: err.message });
      return { checked: 0, drifted: 0 };
    }

    const desired = await resolveDesired();
    const drift = [];
    for (const c of desired) {
      const name = `cam_${c.monitorId}`;
      if (!observed.has(name)) continue;                 // path not configured yet — watchdog owns adds
      if (durationToSeconds(observed.get(name)) !== c.days * 86400) drift.push(c);
    }

    if (drift.length) {
      await recordingRetention.mapWithConcurrency(drift, CONCURRENCY,
        (c) => recordingRetention.applyRetention(c, { days: c.days }));
      logger.info('reconcile: retention drift corrected', { checked: desired.length, drifted: drift.length });
    }
    return { checked: desired.length, drifted: drift.length };
  } finally {
    _inCycle = false;
  }
}

// ── Event-driven trigger (debounced) ──────────────────────────────────────────
// Lets other parts of the system request an IMMEDIATE re-sync — e.g. the
// watchdog after it re-adds paths (a likely Stream Service restart) — instead of
// waiting up to a full interval. Multiple calls within DEBOUNCE_MS coalesce
// into a single pass, so a restart that re-adds 2000 paths triggers ONE
// reconcile, not 2000.
const DEBOUNCE_MS = parseInt(process.env.RECONCILE_DEBOUNCE_MS, 10) || 1500;
let _debounce = null;

function requestReconcile(reason) {
  if (!ENABLED || _debounce) return;   // already scheduled → coalesce
  _debounce = setTimeout(async () => {
    _debounce = null;
    try {
      const res = await reconcileRetention();
      if (res.drifted) logger.info('reconcile: event-triggered', { reason, ...res });
    } catch (err) {
      logger.warn('reconcile: triggered cycle error', { reason, error: err.message });
    }
  }, DEBOUNCE_MS);
  if (_debounce.unref) _debounce.unref();
}

function start() {
  if (_running) return;
  if (!ENABLED) { logger.info('reconcile: disabled (RECONCILE_ENABLED=0)'); return; }
  _running = true;
  const loop = async () => {
    try {
      // Only the cluster leader runs the periodic backstop (single-instance =
      // always leader). Event-triggered passes are not gated.
      let leader = true;
      try { leader = require('./streamSupervisor.service').isLeader(); } catch (_) { /* default true */ }
      if (leader) {
        await reconcileRetention();
        // Self-heal the per-server capacity counter from ground-truth camera
        // counts (add/delete deltas drift; this recompute keeps routing honest).
        try { await require('./streamRouter.service').reconcileServerLoads(); } catch (_) { /* non-fatal */ }
      }
    } catch (err) { logger.warn('reconcile: cycle error', { error: err.message }); }
    finally {
      if (_running) { _timer = setTimeout(loop, INTERVAL_MS); if (_timer.unref) _timer.unref(); }
    }
  };
  _timer = setTimeout(loop, 15_000);   // first pass shortly after boot
  if (_timer.unref) _timer.unref();
  logger.info('reconcile: started', { intervalMs: INTERVAL_MS, concurrency: CONCURRENCY, debounceMs: DEBOUNCE_MS });
}

function stop() {
  _running = false;
  if (_timer) clearTimeout(_timer);
  _timer = null;
  if (_debounce) { clearTimeout(_debounce); _debounce = null; }
}

module.exports = { start, stop, reconcileRetention, requestReconcile };
