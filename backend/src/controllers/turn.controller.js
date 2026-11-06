/**
 * GET /api/turn/credentials — issue short-lived TURN creds for a logged-in
 * operator.
 *
 * Uses coturn's `use-auth-secret` REST scheme. The username is an
 * expiry-bound string the client passes verbatim to coturn:
 *
 *   username  = "<unix-expiry>:<userId>"
 *   credential = HMAC_SHA1(secret, username), base64
 *
 * coturn validates by computing the same HMAC against its `static-auth-secret`
 * and checking the expiry hasn't passed. The user-id segment is informational
 * only (we use req.user.id so the coturn logs map back to operators); coturn
 * doesn't validate it.
 *
 * If TURN_URI + TURN_SHARED_SECRET are both empty, this endpoint returns
 * `{ available: false }` so the SPA falls back to STUN-only behaviour —
 * matching how everything works today before coturn is deployed.
 */
const crypto = require('node:crypto');

const asyncHandler = require('../middleware/asyncHandler');
const config = require('../config/env');
const logger = require('../config/logger');

function makeCredentialsForUser(userId) {
  const { uri, uriTls, secret, ttlSec } = config.turn;

  // Coturn not configured — the SPA's streamRegistry treats this as "no
  // TURN available" and uses STUN only. Same behaviour as before Phase 1.4.
  if (!uri || !secret) {
    return { available: false };
  }

  // 1-hour default lifetime. coturn's own `--user-quota`-style limits are
  // separate; ttl here is only the validity of THIS cred, not a session cap.
  const expiry = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expiry}:${userId}`;
  const credential = crypto
    .createHmac('sha1', secret)
    .update(username)
    .digest('base64');

  const urls = [uri];
  if (uriTls) urls.push(uriTls);

  return {
    available: true,
    iceServers: [
      // Public STUN — keep as fallback so we can still negotiate when TURN
      // is misconfigured or DDoS'd. Costs nothing.
      { urls: 'stun:stun.l.google.com:19302' },
      { urls, username, credential },
    ],
    // Mirrored for logging / observability without re-deriving from the
    // iceServers array on the client side.
    username,
    expiresAt: new Date(expiry * 1000).toISOString(),
  };
}

const getCredentials = asyncHandler(async (req, res) => {
  const userId = req.user?.id || 'anonymous';
  const creds = makeCredentialsForUser(userId);
  if (!creds.available) {
    // 200, not 204 — 204 is "no content" which axios + fetch handle oddly
    // on the SPA side (response.data === ''). 200 with explicit shape is
    // friendlier for clients.
    return res.json({ available: false });
  }
  logger.debug?.('issued TURN creds', { userId, expiresAt: creds.expiresAt });
  return res.json(creds);
});

module.exports = { getCredentials };
