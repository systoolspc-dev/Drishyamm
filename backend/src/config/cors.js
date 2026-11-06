const config = require('./env');

// Local development origins are always allowed in addition to CORS_ORIGINS.
// These are loopback-only (a browser tab on the developer's own machine — Vite
// on 5173, Expo web / Metro on 8081/19006), so allowing them cannot expose the
// API to a third-party site: no public page can ever have a loopback origin.
//
// This used to be a hand-listed set, and it silently did NOT include the one
// port that matters most — Vite's 5173 — nor the `127.0.0.1` spelling of
// anything. CORS_ORIGINS lists only `http://localhost:5173`, so opening the app
// on `http://127.0.0.1:5173` (which people do on this box, because `localhost`
// intermittently resolves to a dead IPv6 route) made EVERY api call fail: the
// preflight was rejected, so the browser blocked the request and axios reported
// the opaque "Network Error" that surfaces in the player as "Stream
// Unavailable". Match loopback by shape instead, so all three spellings and any
// dev port are covered.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const allowed = new Set(config.cors.origins);

function isAllowedOrigin(origin) {
  return allowed.has(origin) || LOOPBACK_ORIGIN.test(origin);
}

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (native mobile apps, curl, server-to-server).
    if (!origin) return callback(null, true);

    // Reject by declining the origin, NOT by raising. Passing an Error here
    // hands it to Express's error handler, so a disallowed origin answered the
    // *preflight* with 500 — which reads like a crashed API and tells the
    // browser nothing. `false` just omits the CORS headers, which is what the
    // spec expects and what makes the browser print a real CORS diagnostic.
    callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['X-Total-Count'],
  // How long the browser may cache this preflight decision. This was 24 h,
  // which is a trap: a browser that cached a FAILING preflight kept blocking
  // every API call without re-asking the server, so the fix above appeared to
  // do nothing and the server log stayed empty (no preflight ever arrived) —
  // the request just died as "CORS error" in the console. Chrome caps the
  // preflight cache at 2 h anyway, so the long value bought little. Ten minutes
  // still removes essentially all preflight chatter while letting an origin
  // change take effect on its own.
  maxAge: 600,
};

module.exports = corsOptions;
