const path = require('node:path');
const express = require('express');
const securityHeaders = require('./config/securityHeaders');
const cors = require('cors');
const corsOptions = require('./config/cors');
const { apiLimiter } = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');
const AppError = require('./utils/AppError');
const routes = require('./routes');
const metrics = require('./services/metrics.service');

const app = express();

// Trust Nginx reverse proxy (required for express-rate-limit behind Nginx)
app.set('trust proxy', 1);

// Security headers (see config/securityHeaders.js for the policy + rationale).
app.use(securityHeaders);

// CORS
app.use(cors(corsOptions));

// Body parsing — webhook route needs raw body, so we handle it specially.
// /api/internal/* installs its own larger JSON parser inside the router.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payment/webhook') {
    return next(); // Skip JSON parsing for webhook
  }
  if (req.originalUrl.startsWith('/api/internal/')) {
    return next(); // internal router has its own json({ limit: '2mb' })
  }
  // Two-way audio chunks are raw bytes (G.711 µ-law). The talkback controller
  // reads the stream directly. Skip both JSON and url-encoded parsers.
  if (/\/api\/cameras\/[^/]+\/talk\/audio$/.test(req.originalUrl)) {
    return next();
  }
  // Person-tracker sightings/stitch payloads carry the full candidate +
  // sightings arrays in JSON — at low similarity thresholds those can
  // exceed the default 100KB. Bumping the limit for those paths only;
  // every other operator route stays at 10KB to limit attack surface.
  if (req.originalUrl.startsWith('/api/person-tracker/')) {
    return express.json({ limit: '5mb' })(req, res, next);
  }
  express.json({ limit: '10kb' })(req, res, next);
});
app.use((req, res, next) => {
  if (/\/api\/cameras\/[^/]+\/talk\/audio$/.test(req.originalUrl)) return next();
  express.urlencoded({ extended: true, limit: '10kb' })(req, res, next);
});

// Rate limiting
app.use('/api', apiLimiter);

// Prometheus HTTP metrics — must come before routes so it can wrap res.on('finish')
app.use('/api', metrics.httpMiddleware());

// OpenAPI spec (curated core contract) — served raw so any viewer / Postman /
// Swagger Editor can load it. No extra dependency, no auth.
app.get('/api/openapi.yaml', (req, res) => {
  res.type('application/yaml').sendFile(path.join(__dirname, '..', 'docs', 'openapi.yaml'));
});

// API routes
app.use('/api', routes);

// 404 handler
app.use((req, res, next) => {
  next(new AppError(`Route ${req.originalUrl} not found.`, 404));
});

// Centralized error handler
app.use(errorHandler);

module.exports = app;
