/**
 * streamRouter.service.js
 *
 * Pool-aware wrapper over the existing single-instance streamService.shim.
 * Where streamService.shim.js talks to ONE Stream Service (the env-configured one),
 * this router knows about the whole `mediamtx_servers` table and:
 *
 *   - picks the right server when a camera is created
 *   - proxies addCamera / removeCamera / getPath calls to the server that
 *     actually hosts each camera
 *   - maintains the `current_cams` counter so capacity-aware routing works
 *   - falls back to the default server (site_id NULL) when a site has no
 *     dedicated server
 *
 * Existing `cameraGroup.controller.js` calls `streamingService.addCamera(...)`
 * directly. New call sites should use this router instead. Old calls keep
 * working — they just always hit the default server.
 *
 * Multi-instance API basics: every server in the table has its own apiUrl,
 * apiUser, apiPass. We build a per-call axios client on demand (cheap).
 */

const axios   = require('axios');
const logger  = require('../config/logger');
const AppError = require('../utils/AppError');
const vendors = require('./vendors');

let _models = null;
const loadModels = () => {
  if (_models) return _models;
  _models = require('../models');
  return _models;
};

// ── Per-server axios builder ──────────────────────────────────────────────────

function clientFor(server) {
  return axios.create({
    baseURL: server.apiUrl,
    timeout: 10_000,
    headers: { 'Content-Type': 'application/json' },
    auth: server.apiUser ? { username: server.apiUser, password: server.apiPass || '' } : undefined,
  });
}

// ── Path naming (mirrors streamService.shim.js — keep them in sync!) ───────────

function pathName(monitorId)    { return `cam_${monitorId}`; }
function subPathName(monitorId) { return `cam_${monitorId}_sub`; }

// Delegates to the vendor registry so this and streamService.shim.js share one
// sub-stream convention table and can no longer drift.
function deriveSubPath(mainPath) {
  return vendors.deriveSubPath(mainPath);
}

function buildRtspUrl({ host, port, path, username, password }) {
  const encodedPass = password ? encodeURIComponent(password) : '';
  const auth        = username ? `${username}:${encodedPass}@` : '';
  const safePath    = path ? (path.startsWith('/') ? path : `/${path}`) : '/';
  return `rtsp://${auth}${host}:${port || 554}${safePath}`;
}

// ── Recording config (kept in one place so per-server overrides are easy) ────

function recordConfig() {
  const config = require('../config/env');
  return {
    record:                true,
    recordPath:            '/recordings/%path/%Y-%m-%d/%H-%M-%S-%f',
    recordSegmentDuration: config.streamService.segmentDuration || '10m0s',
    recordDeleteAfter:     '0s',
  };
}

// ── Server selection ──────────────────────────────────────────────────────────

/**
 * Pick the best server for a new camera in `siteId`.
 *
 * Strategy:
 *   1. Online server in the same site with most headroom
 *   2. Online global (siteId=NULL) server with most headroom
 *   3. Throw — no server available
 *
 * Returns a StreamServer model instance (or throws).
 */
async function pickServerForSite(siteId) {
  const { StreamServer } = loadModels();

  // First try site-bound servers
  const siteServers = siteId
    ? await StreamServer.findAll({
        where: { siteId, status: 'online' },
        order: [['current_cams', 'ASC']],
      })
    : [];

  for (const s of siteServers) {
    if (s.headroom() > 0) return s;
  }

  // Fall back to the global pool
  const globalServers = await StreamServer.findAll({
    where: { siteId: null, status: 'online' },
    order: [['current_cams', 'ASC']],
  });

  for (const s of globalServers) {
    if (s.headroom() > 0) return s;
  }

  throw new AppError(
    'No Stream Service server with available capacity. Provision a new server or raise capacity on existing ones.',
    503,
  );
}

/**
 * Resolve the server for an existing camera.
 * Falls back to the default global server if mediamtxServerId is null
 * (legacy data) — that matches the env-configured default.
 */
async function getServerForCamera(camera) {
  const { StreamServer } = loadModels();
  if (camera.mediamtxServerId) {
    const s = await StreamServer.findByPk(camera.mediamtxServerId);
    if (s) return s;
  }
  // Legacy / default: any global server, pick the first online one.
  const fallback = await StreamServer.findOne({
    where: { siteId: null, status: 'online' },
  });
  if (!fallback) {
    throw new AppError('No default Stream Service server configured.', 503);
  }
  return fallback;
}

// ── Capacity counter maintenance ──────────────────────────────────────────────

async function incrementServerLoad(server, by = 1) {
  // Atomic increment via raw SQL — avoids race conditions when two cameras
  // are added concurrently
  const { sequelize } = loadModels();
  await sequelize.query(
    'UPDATE mediamtx_servers SET current_cams = GREATEST(0, current_cams + :by) WHERE id = :id',
    { replacements: { by, id: server.id } },
  );
}

/** Symmetric decrement (clamped at 0). Kept for callers that know the server. */
async function decrementServerLoad(server, by = 1) {
  return incrementServerLoad(server, -Math.abs(by));
}

/**
 * Recompute every server's current_cams from GROUND TRUTH (the actual camera
 * row count per mediamtxServerId). The increment/decrement counters drift —
 * only some create paths increment, deletes historically didn't decrement — so
 * this authoritative recompute is the real fix: run it periodically and the
 * capacity tracker is always correct regardless of what the deltas did.
 * Returns the number of servers whose counter was corrected.
 */
async function reconcileServerLoads() {
  const { sequelize, Camera, StreamServer } = loadModels();
  try {
    const counts = await Camera.findAll({
      attributes: ['mediamtxServerId', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
      group: ['mediamtxServerId'],
      raw: true,
    });
    const actualByServer = new Map(
      counts.filter((c) => c.mediamtxServerId).map((c) => [c.mediamtxServerId, Number(c.n)]),
    );
    const servers = await StreamServer.findAll({ attributes: ['id', 'currentCams'], raw: true });
    let fixed = 0;
    for (const s of servers) {
      const actual = actualByServer.get(s.id) || 0;
      if (Number(s.currentCams) !== actual) {
        await sequelize.query(
          'UPDATE mediamtx_servers SET current_cams = :n WHERE id = :id',
          { replacements: { n: actual, id: s.id } },
        );
        fixed += 1;
      }
    }
    if (fixed) logger.info('streamRouter: server load reconciled', { serversCorrected: fixed });
    return fixed;
  } catch (err) {
    logger.warn('streamRouter: reconcileServerLoads failed (non-fatal)', { error: err.message });
    return 0;
  }
}

// ── Camera path management (the actual Stream Service API calls) ───────────────────

async function addCamera(camera, camConfig, server = null) {
  // Caller passes the server when it has it (e.g. immediately after pickServerForSite)
  const target = server || await getServerForCamera(camera);
  const name   = pathName(camera.monitorId);
  const rtsp   = buildRtspUrl(camConfig);

  // Keep in lockstep with streamService.shim.js addCamera(): default to on-demand
  // (pull the NVR only while a camera is actually being viewed) so a bulk import
  // routed through this pool-aware path can't silently re-assert the always-on,
  // 24/7-recording behaviour that saturates remote NVRs/uplinks. Set
  // RECORD_CONTINUOUS=1 to opt back into always-on + recording per deployment.
  const continuous = process.env.RECORD_CONTINUOUS === '1';
  // SOURCE_ALWAYS_ON = always-on streaming without forcing recording (see
  // streamService.shim.js). RECORD_CONTINUOUS = always-on AND 24/7 recording.
  const alwaysOn = continuous || process.env.SOURCE_ALWAYS_ON === '1';
  // Per-camera/location retention → recordDeleteAfter. Set even when record is
  // off (harmless, ready when recording turns on); overrides recordConfig()'s
  // legacy '0s'. Lazy-require avoids a load-time cycle with recordingRetention.
  const recordingRetention = require('./recordingRetention.service');
  const retentionDays = await recordingRetention.resolveRetentionDays(camera);
  const pathConfig = {
    source:         rtsp,
    sourceOnDemand: !alwaysOn,
    sourceProtocol: 'tcp',
    ...(continuous ? recordConfig() : { record: false }),
    recordDeleteAfter: recordingRetention.retentionToMediamtx(retentionDays),
  };

  const api = clientFor(target);
  try {
    await api.post(`/v3/config/paths/add/${name}`, pathConfig);
    logger.info('streamRouter: path added', { server: target.name, monitor: camera.monitorId });
  } catch (err) {
    if (err.response?.status === 400 || err.response?.status === 409) {
      // Already exists — patch instead (idempotent)
      try {
        await api.patch(`/v3/config/paths/patch/${name}`, pathConfig);
        return target;
      } catch (patchErr) {
        logger.error('streamRouter: addCamera patch failed', {
          server: target.name, monitor: camera.monitorId, error: patchErr.message,
        });
        throw new AppError('Failed to configure camera in media engine.', 502);
      }
    }
    logger.error('streamRouter: addCamera failed', {
      server: target.name, monitor: camera.monitorId, error: err.message,
    });
    throw new AppError('Failed to add camera to media engine.', 502);
  }

  // Sub-stream (best-effort, never blocks main path success)
  const subRtspPath = deriveSubPath(camConfig.path);
  if (subRtspPath) {
    const subRtsp = buildRtspUrl({ ...camConfig, path: subRtspPath });
    api.post(`/v3/config/paths/add/${subPathName(camera.monitorId)}`, {
      source: subRtsp,
      sourceOnDemand: true,
      record: false,
    }).catch(() => api.patch(`/v3/config/paths/patch/${subPathName(camera.monitorId)}`, {
      source: subRtsp,
      sourceOnDemand: true,
      record: false,
    }).catch(() => {}));
  }

  return target;
}

// Synthetic env-default server, used when the mediamtx_servers pool table is
// empty (single Stream Service configured purely from env) — mirrors the same
// fallback in streamSupervisor / streamService.shim.
function envDefaultServer() {
  const config = require('../config/env');
  return {
    id:      '__env_default__',
    name:    'env-default',
    apiUrl:  config.streamService.apiUrl,
    apiUser: config.streamService.apiUser,
    apiPass: config.streamService.apiPass,
  };
}

/**
 * Patch a single field-set on a camera's Stream Service path (on whichever server
 * hosts it). Used e.g. by recordingRetention to push recordDeleteAfter when a
 * camera/group retention changes — without rebuilding the whole path config.
 * Falls back to the env-default Stream Service when the server pool isn't populated.
 */
async function patchPath(camera, patch) {
  let target;
  try {
    target = await getServerForCamera(camera);
  } catch (_) {
    target = envDefaultServer();
  }
  const name = pathName(camera.monitorId);
  await clientFor(target).patch(`/v3/config/paths/patch/${name}`, patch);
}

async function removeCamera(camera) {
  const target = await getServerForCamera(camera).catch(() => null);
  if (!target) return;
  const api = clientFor(target);
  await Promise.all([
    api.delete(`/v3/config/paths/delete/${pathName(camera.monitorId)}`).catch((e) => {
      if (e.response?.status !== 404) logger.warn('streamRouter: removeCamera failed', { error: e.message });
    }),
    api.delete(`/v3/config/paths/delete/${subPathName(camera.monitorId)}`).catch(() => {}),
  ]);
}

// ── URL builders for the frontend ────────────────────────────────────────────

function getWebrtcUrl(server, monitorId) {
  return `${server.webrtcUrl}/${pathName(monitorId)}`;
}

function getHlsUrl(server, monitorId) {
  return `${server.hlsUrl}/${pathName(monitorId)}/index.m3u8`;
}

function getHlsSubUrl(server, monitorId) {
  return `${server.hlsUrl}/${subPathName(monitorId)}/index.m3u8`;
}

function getRtspEgressUrl(server, monitorId, sub = false) {
  const name = sub ? subPathName(monitorId) : pathName(monitorId);
  return `rtsp://${server.rtspInternalHost}:${server.rtspInternalPort || 8554}/${name}`;
}

module.exports = {
  pickServerForSite,
  getServerForCamera,
  incrementServerLoad,
  decrementServerLoad,
  reconcileServerLoads,
  addCamera,
  patchPath,
  removeCamera,
  getWebrtcUrl,
  getHlsUrl,
  getHlsSubUrl,
  getRtspEgressUrl,
  pathName,
  subPathName,
  deriveSubPath,
  buildRtspUrl,
};
