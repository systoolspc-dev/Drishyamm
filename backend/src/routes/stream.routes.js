const { Router } = require('express');
const router = Router();
const streamController = require('../controllers/stream.controller');
const authenticate = require('../middleware/authenticate');

router.get('/start/:monitorId',  authenticate, streamController.startStream);
router.get('/stop/:monitorId',   authenticate, streamController.stopStream);
router.get('/status/:monitorId', authenticate, streamController.getStreamStatus);
// A still for the Monitor Wall editor's tiles (cached, at most one extra
// session per recorder). See services/liveSnapshot.service.js.
router.get('/snapshot/:monitorId', authenticate, streamController.getSnapshot);
router.post('/watchdog/run',     authenticate, streamController.runWatchdog);

// Adaptive bitrate master playlist — serves a multi-variant HLS playlist
// referencing both main and sub streams as quality tiers.
router.get('/master/:monitorId/index.m3u8', authenticate, streamController.getMasterPlaylist);

// Media-plane auth check for nginx `auth_request` (H9). NO JWT middleware — the
// per-camera stream cookie is the authorization. See docs/STREAM_SECURITY.md.
router.get('/verify', streamController.verifyStreamAccess);

module.exports = router;

