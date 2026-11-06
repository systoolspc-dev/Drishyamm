const helmet = require('helmet');

// Security headers for an API-only service (JSON + a static openapi.yaml).
// The two cross-origin policies stay OFF because the SPA consumes stream and
// thumbnail bytes across origins; leaving them on would block it. Everything
// else is locked down. Exported (not inlined in app.js) so the policy is unit
// testable against the real middleware.
const securityHeaders = helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  // Force HTTPS for a year once the browser has seen the site over TLS
  // (nginx terminates TLS in production).
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // Nothing served here should ever execute script or be framed. default-src
  // 'none' is safe for a JSON API and blunts reflected-content / clickjacking.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
});

module.exports = securityHeaders;
