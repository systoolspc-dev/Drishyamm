/**
 * metrics.routes.js — Prometheus scrape endpoint.
 *
 * Mounted at /api/metrics.  Unauthenticated by default — production
 * deployments restrict access at the NGINX layer (allow Prometheus IP only).
 *
 * The endpoint serializes the global registry from metrics.service.js;
 * adding new metrics anywhere in the codebase auto-exposes them here.
 */
const { Router } = require('express');
const metrics = require('../services/metrics.service');

const router = Router();

router.get('/', async (_req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  } catch (err) {
    res.status(500).end(`# metrics error: ${err.message}`);
  }
});

module.exports = router;
