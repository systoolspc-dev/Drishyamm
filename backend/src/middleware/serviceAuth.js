/**
 * serviceAuth.js — middleware for service-to-service auth on /api/internal/*.
 *
 * Used by:
 *   - AI worker → POST /api/internal/ai/events
 *   - Future: any sidecar that needs to call our backend without a user JWT
 *
 * Token comes from the env var SERVICE_TOKEN. We accept it as either:
 *   - X-Service-Token: <token>          (preferred)
 *   - Authorization: Bearer <token>     (works too, but reserve for user JWTs)
 *
 * Comparison is constant-time to avoid timing attacks.
 */

const crypto = require('node:crypto');
const config = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

function constantTimeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = function serviceAuth(req, _res, next) {
  const expected = config.serviceToken;

  // Misconfiguration is a 500 — fail closed rather than silently allowing access.
  if (!expected) {
    logger.error('serviceAuth: SERVICE_TOKEN env var not set — internal routes disabled');
    return next(new AppError('Internal API not configured.', 500));
  }

  const headerToken = req.get('X-Service-Token');
  const bearer      = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  const provided    = headerToken || bearer;

  if (!provided || !constantTimeEqual(provided, expected)) {
    return next(new AppError('Unauthorized', 401));
  }

  // Tag the request so downstream handlers can distinguish user vs. service calls.
  req.isServiceCall = true;
  next();
};
