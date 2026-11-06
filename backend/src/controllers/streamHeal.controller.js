/**
 * streamHeal.controller.js
 *
 * Operator-facing endpoints for active stream interventions. The supervisor
 * + streamQuality already heal automatically; these are the manual buttons
 * the on-call operator clicks when the heal budget is exhausted or they want
 * to short-circuit the cooldown.
 *
 *   POST /api/cameras/:monitorId/heal
 *     Force-reconnect a camera path. Equivalent to a stale-RTSP-session reset.
 *
 *   POST /api/cameras/:monitorId/keyframe
 *     Request the source send an immediate I-frame. Implementation depends on
 *     the egress: WebRTC readers receive a fresh PLI naturally on (re)connect,
 *     so this endpoint disconnects and reconnects the path config (cheap PATCH)
 *     and lets Stream Service issue PLI to the camera. For HLS, the next segment
 *     boundary will pick up the new IDR.
 *
 *   GET /api/cameras/:monitorId/quality
 *     Diagnostic snapshot — current jitter, FIE rate, reader count, heal log.
 */

const AppError      = require('../utils/AppError');
const streamQuality = require('../services/streamQuality.service');
const streamSupervisor = require('../services/streamSupervisor.service');
const { Camera } = require('../models');

async function ownsCameraOr403(req, monitorId) {
  const cam = await Camera.findOne({ where: { monitorId } });
  if (!cam) throw new AppError('Camera not found', 404);
  // Admins can heal any camera; users only their own
  if (req.user.role !== 'admin' && cam.userId !== req.user.id) {
    throw new AppError('Forbidden', 403);
  }
  return cam;
}

async function heal(req, res) {
  const { monitorId } = req.params;
  await ownsCameraOr403(req, monitorId);
  const result = await streamQuality.manualHeal(monitorId);
  res.status(result.healed ? 200 : 409).json({ success: result.healed, ...result });
}

async function keyframe(req, res) {
  const { monitorId } = req.params;
  await ownsCameraOr403(req, monitorId);
  // Same mechanism — PATCH the path; on re-init Stream Service requests an IDR
  // from the source via PLI/FIR. Functionally identical to heal() at the
  // RTSP layer, but the metric label tells us why the operator pressed it.
  const result = await streamQuality.manualHeal(monitorId);
  res.status(result.healed ? 200 : 409).json({
    success: result.healed,
    intent: 'keyframe',
    ...result,
  });
}

async function quality(req, res) {
  const { monitorId } = req.params;
  const cam = await ownsCameraOr403(req, monitorId);
  const all = streamQuality.snapshot();
  const supervisor = streamSupervisor.snapshot();
  const supervisorEntry = supervisor.cameras.find((c) => c.monitorId === monitorId);
  res.json({
    success:   true,
    monitorId,
    cameraId:  cam.id,
    groupId:   cam.groupId,                  // panels need this for the Boost action
    quality:    all[monitorId] || null,
    supervisor: supervisorEntry || null,
  });
}

module.exports = { heal, keyframe, quality };
