const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const cameraHealth = require('../controllers/cameraHealth.controller');
const streamHeal = require('../controllers/streamHeal.controller');
const talkback = require('../controllers/talkback.controller');

const router = Router();

router.use(authenticate);

router.get('/health', cameraHealth.getHealth);

// Per-camera quality + active healing controls
router.get ('/:monitorId/quality',  streamHeal.quality);
router.post('/:monitorId/heal',     streamHeal.heal);
router.post('/:monitorId/keyframe', streamHeal.keyframe);

// Two-way audio (push-to-talk). /audio takes raw bytes; mounted *without* a
// JSON parser so the controller can read the request stream directly.
router.get ('/:monitorId/talk/status', talkback.status);
router.post('/:monitorId/talk/open',   talkback.open);
router.post('/:monitorId/talk/audio',  talkback.audio);
router.post('/:monitorId/talk/close',  talkback.close);

module.exports = router;
