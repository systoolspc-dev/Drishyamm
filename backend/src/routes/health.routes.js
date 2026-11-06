/**
 * health.routes.js — liveness, readiness, deep diagnostic.
 * Mounted at /api/health.  All endpoints are unauthenticated by design;
 * production deployments restrict /full and /metrics at the NGINX layer
 * (allow only ops + monitoring CIDRs).
 */
const { Router } = require('express');
const health = require('../controllers/health.controller');

const router = Router();

router.get('/live',  health.live);
router.get('/ready', health.ready);
router.get('/full',  health.full);

module.exports = router;
