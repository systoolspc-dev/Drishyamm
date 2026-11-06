/**
 * talkback.controller.js
 *
 * Two-way audio HTTP API.
 *
 *   POST /api/cameras/:monitorId/talk/open       — open a session, returns ok
 *   POST /api/cameras/:monitorId/talk/audio      — append a chunk (raw bytes)
 *   POST /api/cameras/:monitorId/talk/close      — close the session
 *
 * Wire format for /audio:
 *   Content-Type: application/octet-stream
 *   Body: raw G.711 µ-law audio bytes, 8 kHz mono. The frontend converts
 *         48 kHz Float32 PCM → 8 kHz µ-law before posting.
 *
 * The audio endpoint accepts up to 32 KB per chunk to keep latency low; the
 * frontend should post every 100–200 ms.
 *
 * Authorization: same JWT as every other /api/cameras/:id endpoint.
 */

const AppError = require('../utils/AppError');
const asyncHandler = require('../middleware/asyncHandler');
const logger   = require('../config/logger');
const talkback = require('../services/talkback.service');
const { Camera, CameraGroup } = require('../models');

async function _resolveCameraOr403(req) {
  const { monitorId } = req.params;
  const cam = await Camera.findOne({ where: { monitorId } });
  if (!cam) throw new AppError('Camera not found', 404);
  if (req.user.role !== 'admin' && cam.userId !== req.user.id) {
    throw new AppError('Forbidden', 403);
  }
  if (!cam.groupId) throw new AppError('Camera has no group; talkback requires group credentials', 409);
  const group = await CameraGroup.findByPk(cam.groupId);
  if (!group) throw new AppError('Camera group missing', 404);
  return { cam, group };
}

async function open(req, res) {
  const { cam, group } = await _resolveCameraOr403(req);
  const result = await talkback.open(cam.monitorId, group, cam.channel || 1);
  if (!result.ok) {
    const code = result.reason === 'already-open' ? 409 : 502;
    return res.status(code).json({ success: false, ...result });
  }
  logger.info('[Talkback] open via API', { monitorId: cam.monitorId, vendor: result.vendor });
  res.json({ success: true, ...result });
}

/**
 * Append an audio chunk. We collect raw bytes from the request body — Express
 * doesn't parse octet-streams by default, so we accumulate manually with a
 * small chunk-size cap to prevent abuse.
 */
async function audio(req, res, next) {
  const { cam } = await _resolveCameraOr403(req);
  if (!talkback.isOpen(cam.monitorId)) {
    return res.status(409).json({ success: false, reason: 'no-session' });
  }
  const MAX = 32 * 1024;
  const chunks = [];
  let total = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    total += c.length;
    if (total > MAX) {
      aborted = true;
      res.status(413).json({ success: false, reason: 'chunk-too-large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    const ok = talkback.write(cam.monitorId, buf);
    res.json({ success: ok, bytes: buf.length });
  });
  req.on('error', (err) => {
    if (!aborted) next(err);
  });
}

async function close(req, res) {
  const { cam } = await _resolveCameraOr403(req);
  const result = await talkback.close(cam.monitorId);
  res.json({ success: result.ok, ...result });
}

async function status(req, res) {
  const { cam } = await _resolveCameraOr403(req);
  res.json({ success: true, open: talkback.isOpen(cam.monitorId) });
}

// Wrap every handler so a rejected promise (e.g. _resolveCameraOr403 throwing
// an AppError or a DB error) reaches the Express error handler instead of
// surfacing as an unhandled rejection that crashes the process.
module.exports = {
  open:   asyncHandler(open),
  audio:  asyncHandler(audio),
  close:  asyncHandler(close),
  status: asyncHandler(status),
};
