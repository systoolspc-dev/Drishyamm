const { Router } = require('express');
const ctrl = require('../controllers/cameraGroup.controller');
const probe = require('../controllers/deviceProbe.controller');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const validate = require('../middleware/validate');
const groupSchema = require('../validators/cameraGroup.validation');

const router = Router();

// All routes require login
router.use(authenticate);

// Add & edit cameras switch: only the calls that add or remove a recorder or a
// camera. Listing, sync, quality, retention and recordings are shared with
// Live View, Map, Recordings and the phone app, so they stay open.
const setup = requireFeature('camera_setup');

// ── Device probe (camera-name discovery) ────────────────────────────────────
// POST /api/groups/probe                   → probe a device WITHOUT saving;
//                                            used by frontend "Discover" button
//                                            during the camera-add flow.
// POST /api/groups/:groupId/probe          → probe a saved group, read-only
// POST /api/groups/:groupId/sync-names     → probe + overwrite auto-named cameras
//                                            with the names from the device
router.post('/probe', setup, probe.probeUnsaved);
router.post('/:groupId/probe', probe.probeExisting);
router.post('/:groupId/sync-names', setup, probe.syncNames);
// Keyframe acceleration — set GOP length on the device for fast pop-in
router.post('/:groupId/cameras/:monitorId/keyframe-interval', probe.setKeyframeInterval);
// Full encoder profile — bitrate + GOP + fps. Fixes blurry-stream complaints
// caused by under-configured camera encoders.
router.post('/:groupId/cameras/:monitorId/encoder', probe.setEncoder);
// Diagnostic: return raw encoder XML the device exposes. Used to extend
// firmware schemas when Boost reports "no encoder fields matched".
router.get('/:groupId/cameras/:monitorId/encoder-debug', probe.encoderDebug);

// ── Group CRUD ──────────────────────────────────────────────
// GET    /api/groups              → list all groups (with cameras)
// POST   /api/groups              → create group + auto-provision cameras
// GET    /api/groups/:groupId     → get one group + its cameras
// PUT    /api/groups/:groupId     → update group
// DELETE /api/groups/:groupId     → delete group + all cameras

router.get('/', ctrl.listGroups);
router.post('/', setup, validate(groupSchema.createGroup), ctrl.createGroup);
router.get('/:groupId', ctrl.getGroup);
router.put('/:groupId', ctrl.updateGroup);
router.delete('/:groupId', setup, ctrl.deleteGroup);
// Force-sync camera statuses from Shinobi (frontend "Refresh" button)
router.post('/:groupId/sync', ctrl.syncGroup);
// Remove a single camera channel (e.g. channel that doesn't exist on the physical device)
router.delete('/:groupId/cameras/:monitorId', setup, ctrl.deleteCameraFromGroup);
// Re-apply FFmpeg/Shinobi config to all cameras (use after changing shinobi.service.js settings)
router.post('/:groupId/reconfigure', ctrl.reconfigureGroup);

// ── Recording retention (per-camera / per-location) ──────────────────────────
// POST /api/groups/:groupId/retention                       { retentionDays }  → group/location default
// POST /api/groups/:groupId/cameras/:monitorId/retention    { retentionDays }  → per-camera override (null = inherit)
router.post('/:groupId/retention', ctrl.setGroupRetention);
router.post('/:groupId/cameras/retention', validate(groupSchema.bulkRetention), ctrl.setCamerasRetentionBulk);   // bulk (multi-select)
router.post('/:groupId/cameras/:monitorId/retention', ctrl.setCameraRetention);

// ── Default stream quality (auto/main/sub) — same shape as retention ─────────
router.post('/:groupId/quality', ctrl.setGroupQuality);
router.post('/:groupId/cameras/quality', validate(groupSchema.bulkQuality), ctrl.setCamerasQualityBulk);       // bulk
router.post('/:groupId/cameras/:monitorId/quality', ctrl.setCameraQuality);

// ── S3 Recordings ────────────────────────────────────────────
// GET /api/groups/:groupId/recordings              → all cameras in group
// GET /api/groups/:groupId/cameras/:monitorId/recordings  → single camera

router.get('/:groupId/recordings', ctrl.getGroupRecordings);
router.get('/:groupId/cameras/:monitorId/recordings', ctrl.getCameraRecordings);
// GET /api/groups/:groupId/recordings/play?key=<s3-key>     → fresh 7-day playback URL (called per-video on click)
router.get('/:groupId/recordings/play', ctrl.getRecordingPlayUrl);
// GET /api/groups/:groupId/recordings/stream?key=<s3-key>  → proxy S3 bytes with Range support (used by <video> src)
router.get('/:groupId/recordings/stream', ctrl.streamRecording);
// GET /api/groups/:groupId/recordings/thumbnail?key=<s3-key>  → first-frame JPEG thumbnail (cached 24 h)
router.get('/:groupId/recordings/thumbnail', ctrl.getThumbnailForRecording);
// GET /api/groups/:groupId/recordings/download?key=<s3-key>   → forced-download signed URL
router.get('/:groupId/recordings/download', ctrl.getRecordingDownloadUrl);
// GET /api/groups/:groupId/recordings/export?monitorId=&start=&end=  → cut+concat a single MP4 for [start,end]
router.get('/:groupId/recordings/export', ctrl.exportRecordingRange);

module.exports = router;
