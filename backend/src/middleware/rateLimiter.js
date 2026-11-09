const rateLimit = require('express-rate-limit');

// Local development behind Docker: the browser reaches the backend through
// Docker's port forward, so req.ip is the bridge gateway (e.g. 172.20.0.1), never
// 127.0.0.1, and the localhost skip below never matches. Every tab, poll and
// benchmark on the dev machine then shares ONE 5000/15 min bucket and the whole
// UI goes 429. RATE_LIMIT_SKIP_PRIVATE=1 (set by the dev docker-compose.yml
// only) also skips private / Docker addresses. Opt-in on purpose: production
// also runs NODE_ENV=development, and there every request arrives from a
// private proxy address too, so tying this to NODE_ENV would switch the limit
// off in production.
const SKIP_PRIVATE = process.env.RATE_LIMIT_SKIP_PRIVATE === '1';
const PRIVATE_IP = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd][0-9a-f]{2}:/i;

function isLocalDev(req) {
  if (process.env.NODE_ENV === 'production') return false;
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return SKIP_PRIVATE && PRIVATE_IP.test(ip);
}

// General API rate limiter
// 1000 req/15min per IP — enough for 17 cameras + polling without hitting limits.
// Auth routes use a separate stricter limiter.
const apiLimiter = rateLimit({
  // Raised from 1000: behind Docker/reverse-proxy ALL browser traffic shares one
  // gateway IP (the localhost skip below never matches), so every user + poll
  // shares a single bucket. A gallery of 50+ face events each fetching a snapshot
  // exhausted the old budget → 429 → broken images.
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000,
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Internal service-to-service calls (AI worker, etc.) bypass rate limiting —
    // they authenticate via X-Service-Token and may burst during incidents.
    if (req.path.startsWith('/internal/')) return true;
    // High-volume, harmless image reads (event/face snapshots, recording
    // thumbnails) must never count against the API budget — a face-events page
    // can fire 50+ of these at once.
    if (req.method === 'GET' && (req.path.includes('/snapshot') || req.path.includes('/thumbnail'))) return true;
    // Skip rate limiting for localhost (and, opted in, Docker) in development
    return isLocalDev(req);
  },
});

// Stricter limiter for auth routes (relaxed for development)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 10 : 100, // 100 for dev, 10 for prod
  message: {
    success: false,
    message: 'Too many login attempts, please try again after 15 minutes.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for localhost (and, opted in, Docker) in development
    return isLocalDev(req);
  },
});

module.exports = { apiLimiter, authLimiter, _isLocalDev: isLocalDev };
