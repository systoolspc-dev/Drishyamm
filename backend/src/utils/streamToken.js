/**
 * streamToken — signed, short-lived, PER-CAMERA access tokens for the media
 * plane (HLS segments + WebRTC), so the anonymous Stream Service read path can be
 * gated without a per-request DB lookup.
 *
 * The problem (audit H9): Stream Service serves reads anonymously and nginx doesn't
 * gate /hls//live/, so anyone with a `cam_<monitorId>` URL can watch forever.
 * The API layer already checks OWNERSHIP at issuance (Camera.findOne by userId),
 * but that's defeated once a URL leaks. These tokens carry that authorization
 * down to the media layer: only a token minted for THIS camera (and, when a
 * user is bound, THIS user) verifies — and it expires.
 *
 * Scheme: HMAC-SHA256 over `monitorId:userId:expires` with STREAM_URL_SECRET.
 * Enabled only when STREAM_URL_SECRET is set (else verify() is a no-op that
 * returns false and callers keep current behavior — safe rollout).
 *
 * Intended wiring (see docs/STREAM_SECURITY.md):
 *   - stream-start mints a token bound to the camera + user, delivered as a
 *     short-lived path-scoped cookie.
 *   - nginx `auth_request` (or secure_link) validates it before proxying media.
 */
const crypto = require('node:crypto');

const SECRET      = process.env.STREAM_URL_SECRET || '';
const DEFAULT_TTL = parseInt(process.env.STREAM_URL_TTL_SEC || '3600', 10); // 1h

/** True when token signing/verification is configured. */
function enabled() {
  return SECRET.length >= 16;
}

function _hmac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

function _safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function _nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a token authorizing access to `monitorId` for `ttlSec` seconds,
 * optionally bound to a `userId`. Returns null when signing isn't configured.
 * @returns {{token:string, expires:number, userId:string}|null}
 */
function sign(monitorId, { ttlSec = DEFAULT_TTL, userId = '' } = {}) {
  if (!enabled() || !monitorId) return null;
  const expires = _nowSec() + Math.max(1, ttlSec);
  return { token: _hmac(`${monitorId}:${userId}:${expires}`), expires, userId };
}

/**
 * Verify a token for `monitorId`. Fails closed (false) on any mismatch,
 * expiry, or when signing isn't configured. Constant-time comparison.
 */
function verify(monitorId, token, expires, userId = '') {
  if (!enabled() || !monitorId || !token || !expires) return false;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || _nowSec() > exp) return false;
  return _safeEqual(token, _hmac(`${monitorId}:${userId}:${exp}`));
}

/** Extract `cam_<monitorId>` → monitorId from a media request path. */
function monitorIdFromPath(p) {
  const m = String(p || '').match(/cam_([a-f0-9]{8,})/i);
  return m ? m[1] : null;
}

module.exports = { enabled, sign, verify, monitorIdFromPath, DEFAULT_TTL };
