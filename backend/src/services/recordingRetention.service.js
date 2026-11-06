/**
 * recordingRetention.service.js
 *
 * Per-camera / per-location recording retention.
 *
 * Effective retention resolves down the hierarchy:
 *   Camera.retentionDays  →  Group.retentionDays  →  Site.settings.retentionDays
 *   →  DEFAULT_RETENTION_DAYS (env, default 30)
 *
 * It is enforced via Stream Service's native `recordDeleteAfter` on each camera's
 * path (Go duration; no 'd' unit, so days are expressed as hours). Stream Service
 * then auto-purges recordings older than that — and because the NAS is the
 * recordings directory on-prem, this manages NAS retention with no extra cron.
 */

const logger = require('../config/logger');

let _models = null;
const loadModels = () => {
  if (_models) return _models;
  _models = require('../models');
  return _models;
};

const DEFAULT_RETENTION_DAYS = parseInt(process.env.DEFAULT_RETENTION_DAYS, 10) || 30;

/** Resolve the effective retention (in days) for a camera, walking the hierarchy. */
async function resolveRetentionDays(camera) {
  if (camera == null) return DEFAULT_RETENTION_DAYS;
  if (camera.retentionDays != null) return Number(camera.retentionDays);

  const { CameraGroup, Site } = loadModels();

  if (camera.groupId) {
    const group = await CameraGroup.findByPk(camera.groupId, {
      attributes: ['retentionDays', 'siteId'], raw: true,
    }).catch(() => null);
    if (group) {
      if (group.retentionDays != null) return Number(group.retentionDays);
      if (group.siteId) {
        const site = await Site.findByPk(group.siteId, { attributes: ['settings'], raw: true }).catch(() => null);
        const r = site?.settings?.retentionDays;
        if (r != null) return Number(r);
      }
    }
  }
  return DEFAULT_RETENTION_DAYS;
}

/**
 * Resolve the effective retention for a GROUP (no per-camera lookup): the
 * group's own value, else the site default, else the global default. Lets
 * callers resolve once and apply that value to many inheriting cameras instead
 * of re-walking the hierarchy per camera.
 */
async function resolveGroupRetentionDays(group) {
  if (group == null) return DEFAULT_RETENTION_DAYS;
  if (group.retentionDays != null) return Number(group.retentionDays);
  if (group.siteId) {
    const { Site } = loadModels();
    const site = await Site.findByPk(group.siteId, { attributes: ['settings'], raw: true }).catch(() => null);
    const r = site?.settings?.retentionDays;
    if (r != null) return Number(r);
  }
  return DEFAULT_RETENTION_DAYS;
}

/** Convert a retention in days to a Stream Service `recordDeleteAfter` string. */
function retentionToMediamtx(days) {
  const d = Math.max(1, parseInt(days, 10) || DEFAULT_RETENTION_DAYS);
  return `${d * 24}h`;   // Go duration has no 'd' unit → express days as hours
}

/**
 * Resolve (unless `days` is supplied) + push the effective retention onto a
 * camera's Stream Service path (recordDeleteAfter). Best-effort: a Stream Service hiccup
 * never throws. Pass `days` to skip the hierarchy lookup when the caller has
 * already resolved a shared value for a batch. Returns the day count.
 */
const APPLY_RETRIES   = parseInt(process.env.RETENTION_APPLY_RETRIES, 10)  || 3;
const APPLY_BACKOFF_MS = parseInt(process.env.RETENTION_APPLY_BACKOFF_MS, 10) || 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function applyRetention(camera, { days } = {}) {
  const resolved = days != null ? Number(days) : await resolveRetentionDays(camera);
  const value    = retentionToMediamtx(resolved);
  const streamRouter = require('./streamRouter.service');

  // Retry-with-backoff: a transient Stream Service blip self-heals in ~1s instead of
  // waiting for the next reconcile pass. Best-effort — never throws to callers.
  for (let attempt = 1; attempt <= APPLY_RETRIES; attempt += 1) {
    try {
      await streamRouter.patchPath(camera, { recordDeleteAfter: value });
      return resolved;
    } catch (err) {
      if (attempt === APPLY_RETRIES) {
        logger.warn('retention: apply failed after retries (reconcile will retry)', {
          monitor: camera.monitorId, days: resolved, attempts: attempt, error: err.message,
        });
      } else {
        await sleep(APPLY_BACKOFF_MS * attempt);
      }
    }
  }
  return resolved;
}

/** Bounded-concurrency map — keeps fan-out sane at thousands of cameras. */
async function mapWithConcurrency(items, limit, fn) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(runners);
}

/**
 * Apply retention to many cameras in parallel (bounded). Pass `days` to apply a
 * single shared value (group default / bulk override) without per-camera
 * resolution — the scalable path for hundreds/thousands of cameras.
 */
async function applyToCameras(cameras, { days, concurrency } = {}) {
  if (!cameras || !cameras.length) return 0;
  const limit = concurrency || parseInt(process.env.RETENTION_APPLY_CONCURRENCY, 10) || 8;
  await mapWithConcurrency(cameras, limit, (cam) => applyRetention(cam, { days }));
  logger.info('retention: applied to batch', { count: cameras.length, days: days ?? 'resolved', concurrency: limit });
  return cameras.length;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  resolveRetentionDays,
  resolveGroupRetentionDays,
  retentionToMediamtx,
  applyRetention,
  applyToCameras,
  mapWithConcurrency,
};
