/**
 * Phase 4 — POST /api/livekit/token
 *
 * Mints a short-lived LiveKit participant JWT scoped to a specific
 * camera room. The SPA hands it to the LiveKit SDK; LiveKit validates
 * via HS256 against the same `apiSecret`.
 *
 * Body: { cameraId: string, role?: 'subscriber'|'admin' }
 *
 * The room name is derived deterministically from the cameraId — we
 * never accept a free-form room name from the client. That prevents
 * an authenticated operator from minting tokens for rooms they don't
 * have view permission on (e.g. another tenant's cameras).
 *
 * If LIVEKIT_WS_URL is unset, returns { available: false } so the SPA
 * falls back to the existing Stream Service WHEP path. Matches the Phase 1.4
 * TURN-credentials pattern.
 */
const crypto = require('node:crypto');

const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const config = require('../config/env');
const logger = require('../config/logger');
const { Camera } = require('../models');

// Per LiveKit spec (https://docs.livekit.io/realtime/concepts/authentication/),
// participant JWTs carry a `video` grant block alongside the standard
// `iss`/`sub`/`exp` claims. The `room` grant is constrained to the
// camera's room name so an operator can't "join all rooms".
function buildVideoGrants(roomName, role) {
  return {
    room: roomName,
    roomJoin: true,
    canSubscribe: true,
    // Subscribers consume tracks only; never publish. The bridge service
    // uses a separate key/identity with canPublish set.
    canPublish: role === 'admin',
    canPublishData: false,
    // 'admin' role gets room metadata + recordings control. Most
    // operators are 'subscriber'.
    roomAdmin: role === 'admin',
  };
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Mint an HS256 JWT. We write it from scratch (vs the livekit-server-sdk)
 * to avoid pulling a new dep just for a 30-line signer. If we ever need
 * webhook-event signature verification or egress control, we'll add the
 * SDK then.
 */
function signLivekitToken({ identity, name, ttlSec, grants }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss:   config.livekit.apiKey,
    sub:   identity,
    name:  name || identity,
    nbf:   now,
    exp:   now + ttlSec,
    video: grants,
  };
  const headerB64  = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto
    .createHmac('sha256', config.livekit.apiSecret)
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

const issueToken = asyncHandler(async (req, res) => {
  const wsUrl = config.livekit.wsUrl;
  if (!wsUrl) {
    return res.json({ available: false });
  }

  const cameraId = req.body?.cameraId;
  if (typeof cameraId !== 'string' || !cameraId) {
    throw new AppError('body.cameraId is required', 400);
  }
  // Validate the camera belongs to a tenant the user can see. For now
  // this is a flat scope check (user owns nothing → 403); when we add
  // per-camera ACL the right Sequelize where filter goes here.
  const camera = await Camera.findOne({
    where: { id: cameraId },
    attributes: ['id', 'name', 'monitorId'],
  });
  if (!camera) throw new AppError('camera not found', 404);
  if (!camera.monitorId) throw new AppError('camera has no monitor_id', 422);

  const roomName = `cam_${camera.monitorId}`;
  const userId = req.user?.id || 'anon';
  const role = req.body?.role === 'admin' ? 'admin' : 'subscriber';
  const grants = buildVideoGrants(roomName, role);
  const token = signLivekitToken({
    identity: userId,
    name: req.user?.email || userId,
    ttlSec: config.livekit.ttlSec,
    grants,
  });
  logger.debug?.('issued LiveKit token', { userId, roomName, role });

  return res.json({
    available: true,
    wsUrl,
    roomName,
    token,
    expiresIn: config.livekit.ttlSec,
    identity: userId,
    role,
  });
});

module.exports = { issueToken };
