const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const ctrl = require('../controllers/playback.controller');

const router = Router();
router.use(authenticate); // playback is user-scoped
// Recordings switch. No-entry breaches replay their evidence clip through the
// same NVR endpoints, so an account with restricted zones keeps them.
router.use(requireFeature('playback', 'restricted_zone'));

// NVR playback (replay the NVR's own recordings over RTSP → HLS/WebRTC).
router.post('/nvr/start', ctrl.startNvrPlayback);
router.post('/nvr/stop', ctrl.stopNvrPlayback);
// Where the NVR has footage (the Playback timeline's Recording track).
router.get('/nvr/recordings', ctrl.searchNvrRecordings);
// MP4 download of a range. Loaded by the browser directly (?token=).
router.get('/nvr/export', ctrl.exportNvrClip);

module.exports = router;
