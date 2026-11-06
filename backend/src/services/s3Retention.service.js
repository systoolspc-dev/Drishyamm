/**
 * s3Retention.service — enforce recording retention on the DURABLE 10pb copy.
 *
 * Recordings are uploaded to 10pb object storage and the local NAS copy is
 * deleted (recordingSync). Stream Service `recordDeleteAfter` only bounds the LOCAL
 * NAS — nothing deleted old objects on 10pb, so the durable copy grew forever
 * and the per-camera retention the operator configured was never enforced on it.
 * This sweep deletes 10pb recordings older than each camera's resolved retention
 * (Camera → Group → Site → DEFAULT_RETENTION_DAYS).
 *
 * ── SAFETY (this deletes surveillance evidence — treat as high-stakes) ────────
 *   - OFF unless   S3_RETENTION_ENABLED=1
 *   - DRY-RUN unless S3_RETENTION_DELETE=1  — logs what WOULD be deleted
 *   - GRACE margin: only deletes objects older than retention + grace days
 *   - Never touches a key whose date segment doesn't strictly parse
 *   - retentionDays <= 0 → keep forever (camera skipped)
 *   - Per-run deletion cap as a circuit breaker
 *   - Leader-only, daily
 *
 * S3 key shape: recordings/{userId}/{group}/{camera}/{YYYY-MM-DD}/{filename}
 */
const s3Service       = require('./s3.service');
const recordingRetention = require('./recordingRetention.service');
const logger          = require('../config/logger');

const ENABLED      = process.env.S3_RETENTION_ENABLED === '1';
const DO_DELETE    = process.env.S3_RETENTION_DELETE === '1';     // else dry-run
const GRACE_DAYS   = Math.max(0, parseInt(process.env.S3_RETENTION_GRACE_DAYS || '1', 10));
const INTERVAL_MS  = parseInt(process.env.S3_RETENTION_INTERVAL_MS || `${24 * 60 * 60 * 1000}`, 10);
const MAX_DELETE_PER_RUN = parseInt(process.env.S3_RETENTION_MAX_DELETE_PER_RUN || '20000', 10);
const DAY_MS = 24 * 60 * 60 * 1000;

let _timer = null;
let _running = false;
let _models = null;
const loadModels = () => (_models ||= require('../models'));

const slug = (s) => String(s || '').toLowerCase().replace(/\s+/g, '-');

// ── Pure, heavily-tested helpers (a bug here = deleted evidence) ──────────────

/** Strictly parse the {YYYY-MM-DD} date segment (index 4) of a recording key.
 *  Returns the UTC-midnight epoch ms, or null if it isn't a real calendar date
 *  in the exact position — callers must NEVER delete a key that returns null. */
function keyDateMs(key) {
  const parts = String(key || '').split('/');
  if (parts[0] !== 'recordings' || parts.length < 6) return null;
  const d = parts[4];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  // Reject invalid calendar dates (e.g. 2026-13-40 that Date.parse might coerce).
  if (new Date(ms).toISOString().slice(0, 10) !== d) return null;
  return ms;
}

/** Cutoff epoch ms: anything strictly older is eligible for deletion. */
function cutoffMs(retentionDays, nowMs = Date.now()) {
  return nowMs - (retentionDays + GRACE_DAYS) * DAY_MS;
}

/** Is this key's recording older than the cutoff (and safely parseable)? */
function isExpiredKey(key, cutoff) {
  const ms = keyDateMs(key);
  return ms !== null && ms < cutoff;
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

async function sweepCamera(camera, group, user, stats) {
  const retentionDays = await recordingRetention.resolveRetentionDays(camera);
  if (!retentionDays || retentionDays <= 0) return; // keep forever

  const cutoff = cutoffMs(retentionDays);
  const prefix = `recordings/${user.id}/${slug(group.name)}/${slug(camera.name)}/`;

  let objects;
  try { objects = await s3Service.listObjects(prefix); }
  catch (err) { logger.warn('s3Retention: list failed (skipping camera)', { prefix, error: err.message }); return; }

  const expired = objects.filter((o) => isExpiredKey(o.Key, cutoff));
  if (!expired.length) return;

  stats.eligible += expired.length;
  logger.info('s3Retention: camera has expired recordings', {
    camera: camera.name, retentionDays, graceDays: GRACE_DAYS,
    cutoff: new Date(cutoff).toISOString().slice(0, 10),
    expired: expired.length, mode: DO_DELETE ? 'DELETE' : 'DRY-RUN',
  });

  if (!DO_DELETE) return; // dry-run: reported, delete nothing

  for (const o of expired) {
    if (stats.deleted >= MAX_DELETE_PER_RUN) {
      logger.warn('s3Retention: per-run delete cap reached; stopping', { cap: MAX_DELETE_PER_RUN });
      return;
    }
    try { await s3Service.deleteRecording(o.Key); stats.deleted += 1; }
    catch (err) { logger.warn('s3Retention: delete failed', { key: o.Key, error: err.message }); }
  }
}

async function sweep() {
  if (_running) return;
  if (!ENABLED) return;
  _running = true;
  const stats = { eligible: 0, deleted: 0 };
  try {
    const { Camera, CameraGroup, User } = loadModels();
    const cameras = await Camera.findAll({});
    const groupIds = [...new Set(cameras.map((c) => c.groupId).filter(Boolean))];
    const userIds  = [...new Set(cameras.map((c) => c.userId).filter(Boolean))];
    const [groups, users] = await Promise.all([
      CameraGroup.findAll({ where: { id: groupIds } }),
      User.findAll({ where: { id: userIds }, attributes: ['id'] }),
    ]);
    const groupMap = new Map(groups.map((g) => [g.id, g]));
    const userMap  = new Map(users.map((u) => [u.id, u]));

    for (const camera of cameras) {
      const group = groupMap.get(camera.groupId);
      const user  = userMap.get(camera.userId);
      if (!group || !user) continue;
      await sweepCamera(camera, group, user, stats);
    }
    logger.info('s3Retention: sweep complete', { eligible: stats.eligible, deleted: stats.deleted, mode: DO_DELETE ? 'DELETE' : 'DRY-RUN' });
  } catch (err) {
    logger.error('s3Retention: sweep error', { error: err.message });
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return;
  if (!ENABLED) { logger.info('s3Retention: disabled (set S3_RETENTION_ENABLED=1 to enable; runs dry-run until S3_RETENTION_DELETE=1)'); return; }
  const loop = async () => {
    try {
      let leader = true;
      try { leader = require('./streamSupervisor.service').isLeader(); } catch (_) { /* default true */ }
      if (leader) await sweep();
    } catch (err) { logger.warn('s3Retention: loop error', { error: err.message }); }
    finally { if (_timer) { _timer = setTimeout(loop, INTERVAL_MS); _timer.unref?.(); } }
  };
  _timer = setTimeout(loop, 5 * 60 * 1000); // first pass 5 min after boot
  _timer.unref?.();
  logger.info('s3Retention: started', { intervalMs: INTERVAL_MS, mode: DO_DELETE ? 'DELETE' : 'DRY-RUN', graceDays: GRACE_DAYS });
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { start, stop, sweep };
// Exposed for unit tests.
module.exports._internals = { keyDateMs, cutoffMs, isExpiredKey, GRACE_DAYS };
