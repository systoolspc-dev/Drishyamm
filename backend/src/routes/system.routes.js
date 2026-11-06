/**
 * system.routes.js — host-level system stats (disk, etc).
 * Authenticated; cheap (cached) so the dashboard can poll it.
 */

const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const system = require('../controllers/system.controller');

const router = Router();
router.use(authenticate);

router.get('/storage', system.storage);

module.exports = router;
