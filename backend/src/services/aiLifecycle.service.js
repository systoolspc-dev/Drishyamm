const axios = require('axios');

const config = require('../config/env');
const logger = require('../config/logger');
const { Camera } = require('../models');
const { getAiEntitledUserIds } = require('./entitlements.service');
const { recordAiClock } = require('./aiClockSkew');

const RECONCILE_INTERVAL_MS = Number(process.env.AI_LIFECYCLE_RECONCILE_MS || 15000);

let _timer = null;
let _running = false;

function isAiEnabled(camera) {
  const ai = camera.settings?.ai || {};
  return ai.enabled === true && ai.mode !== 'off';
}

async function getRuntime() {
  try {
    const sentAt = Date.now();
    const { data, headers } = await axios.get(`${config.aiServiceUrl}/status`, { timeout: 5000 });
    // A clock reading off the poll we already make; it must never cost the
    // reconcile, so a bad header is simply skipped.
    try { recordAiClock(headers?.date, sentAt, Date.now()); } catch { /* measurement only */ }
    return data?.cameras || {};
  } catch (err) {
    logger.warn('aiLifecycle: AI status unavailable', { error: err.message });
    return null;
  }
}

async function postAiForm(path, monitorId) {
  const body = new URLSearchParams({ monitor_id: monitorId });
  const { data } = await axios.post(`${config.aiServiceUrl}${path}`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 12000,
  });
  return data;
}

async function reconcile({ stopUnselected = true } = {}) {
  if (_running) return;
  _running = true;
  try {
    const runtime = await getRuntime();
    if (!runtime) return;

    // Owners whose current plan includes AI. A Basic-VMS / downgraded / expired
    // account is absent here, so its cameras are treated as AI-off below.
    const aiUserIds = await getAiEntitledUserIds();

    const cameras = await Camera.findAll({
      attributes: ['id', 'monitorId', 'name', 'settings', 'userId'],
      order: [['createdAt', 'ASC']],
    });

    let started = 0;
    let stopped = 0;

    for (const camera of cameras) {
      // Detection runs only when the per-camera AI flag is on AND the owner's
      // plan includes AI. A downgrade to Basic drops the owner from aiUserIds,
      // so this loop /stop-camera's their orchestrators within one reconcile
      // even if settings.ai.enabled is still stale-true.
      const enabled = isAiEnabled(camera) && aiUserIds.has(camera.userId);
      const isRunning = runtime[camera.monitorId]?.running === true;
      try {
        if (enabled && !isRunning) {
          await postAiForm('/set-camera', camera.monitorId);
          started += 1;
        } else if (!enabled && isRunning && stopUnselected) {
          await postAiForm('/stop-camera', camera.monitorId);
          stopped += 1;
        }
      } catch (err) {
        logger.warn('aiLifecycle: camera reconcile failed', {
          monitorId: camera.monitorId,
          enabled,
          error: err.message,
        });
      }
    }

    if (started || stopped) {
      logger.info('aiLifecycle: reconciled camera runtime', { started, stopped });
    }
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return;
  const tick = () => reconcile({ stopUnselected: true }).catch((err) => {
    logger.warn('aiLifecycle: reconcile loop failed', { error: err.message });
  });
  _timer = setInterval(tick, RECONCILE_INTERVAL_MS);
  setTimeout(tick, 1000);
  setTimeout(tick, 8000);
  logger.info('aiLifecycle: started', { intervalMs: RECONCILE_INTERVAL_MS });
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = {
  reconcile,
  start,
  stop,
};
