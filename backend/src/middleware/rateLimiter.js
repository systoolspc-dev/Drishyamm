const rateLimit = require('express-rate-limit');

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
    // Skip rate limiting for localhost in development
    if (process.env.NODE_ENV !== 'production') {
      const ip = req.ip || req.connection.remoteAddress;
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
    return false;
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
    // Skip rate limiting for localhost in development
    if (process.env.NODE_ENV !== 'production') {
      const ip = req.ip || req.connection.remoteAddress;
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
    return false;
  },
});

module.exports = { apiLimiter, authLimiter };
