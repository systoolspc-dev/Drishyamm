/**
 * Phase 3 — transcode toggle per camera.
 *
 *   PATCH /api/admin/cameras/:id/transcode    { enabled, bitrateKbps? }
 *
 * Side effects:
 *   1. Persists camera.settings.transcode = { enabled, bitrateKbps?, updatedAt }
 *   2. Fires the matching call to smart-cam-transcoder:
 *        enabled  true  → POST /transcoders/<monitor_id>
 *        enabled  false → DELETE /transcoders/<monitor_id>
 *   3. Returns the persisted state so the admin UI re-renders cleanly.
 *
 * Restartability: smart-cam-transcoder keeps state in-process (see
 * smart-cam-transcoder/docs/ARCHITECTURE.md). If it restarts, every
 * Camera row with settings.transcode.enabled needs a re-issue of the
 * POST. A 2-second supervisor loop watches for that drift in
 * streamSupervisor.service.js (a separate change).
 */
const axios = require('axios');

const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');
const { Camera } = require('../models');

const TRANSCODER_URL =
  process.env.SMART_CAM_TRANSCODER_URL || 'http://smart-cam-transcoder:8004';

async function callTranscoder(method, path, data) {
  const url = `${TRANSCODER_URL}${path}`;
  try {
    const { data: resp } = await axios({
      method, url, data, timeout: 10_000,
      // Accept 4xx as response — the controller decides whether to
      // bubble or swallow. 404 on DELETE is fine; 503 on POST means
      // out of encoder slots.
      validateStatus: () => true,
    });
    return resp;
  } catch (err) {
    logger.warn('transcoder call failed', { method, path, err: err.message });
    throw new AppError(`transcoder service unreachable: ${err.message}`, 502);
  }
}

const setTranscode = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { enabled, bitrateKbps } = req.body || {};

  if (typeof enabled !== 'boolean') {
    throw new AppError('body.enabled must be boolean', 400);
  }
  if (bitrateKbps != null && (typeof bitrateKbps !== 'number' || bitrateKbps < 500 || bitrateKbps > 50_000)) {
    throw new AppError('body.bitrateKbps must be a number in [500, 50000]', 400);
  }

  // Scope to the caller's account — an authenticated user must not be able to
  // start/stop transcoding on another tenant's camera by guessing its id.
  const camera = await Camera.findOne({ where: { id, userId: req.user.id } });
  if (!camera) throw new AppError('camera not found', 404);
  if (!camera.monitorId) throw new AppError('camera has no monitor_id; cannot transcode', 422);

  // 1. Persist intent on the Camera row. Operators can read this back
  //    from the listing; the streamSupervisor uses it to reconcile.
  const settings = { ...(camera.settings || {}) };
  settings.transcode = {
    enabled,
    ...(bitrateKbps != null ? { bitrateKbps } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: req.user?.id || null,
  };
  camera.settings = settings;
  await camera.save();

  // 2. Issue the matching call to the transcoder. Failures here DON'T
  //    revert the DB write — operator intent is preserved; the
  //    supervisor will keep retrying.
  let transcoder = null;
  if (enabled) {
    const resp = await callTranscoder(
      'POST',
      `/transcoders/${encodeURIComponent(camera.monitorId)}`,
      bitrateKbps != null ? { bitrate_kbps: bitrateKbps } : {},
    );
    transcoder = resp;
  } else {
    const resp = await callTranscoder(
      'DELETE',
      `/transcoders/${encodeURIComponent(camera.monitorId)}`,
    );
    transcoder = resp;
  }

  res.json({
    success: true,
    camera: { id: camera.id, name: camera.name, settings: camera.settings },
    transcoder,
  });
});

const listTranscoders = asyncHandler(async (req, res) => {
  // Roll-up of "what does the transcoder think is running" vs "what do
  // the Camera rows say is desired". A drift here = supervisor work.
  const desired = await Camera.findAll({
    where: { /* full table */ },
    attributes: ['id', 'name', 'monitorId', 'settings'],
  });
  const desiredEnabled = desired.filter((c) => c.settings?.transcode?.enabled);

  let live = [];
  try {
    const resp = await callTranscoder('GET', '/transcoders');
    live = Array.isArray(resp) ? resp : [];
  } catch (_err) {
    // Surface as empty live set — the UI shows a warning banner via
    // /api/admin/cameras' separate health probes.
  }
  res.json({
    success: true,
    desired: desiredEnabled.map((c) => ({
      cameraId: c.id, name: c.name, monitorId: c.monitorId,
      settings: c.settings.transcode,
    })),
    live,
  });
});

module.exports = { setTranscode, listTranscoders };
