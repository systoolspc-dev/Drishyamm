const { Router } = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const shinobiRoutes = require('./shinobi.routes');
const cameraGroupRoutes = require('./cameraGroup.routes');
const paymentRoutes = require('./payment.routes');
const subscriptionRoutes = require('./subscription.routes');
const streamRoutes = require('./stream.routes');
const internalRoutes = require('./internal.routes');
const aiRoutes = require('./ai.routes');
const occupancyRoutes = require('./occupancy.routes');
const spaceRoutes = require('./space.routes');
const personTrackerRoutes = require('./personTracker.routes');
const turnRoutes = require('./turn.routes');
const livekitRoutes = require('./livekit.routes');
const siteRoutes = require('./site.routes');
const bulkImportRoutes = require('./bulkImport.routes');
const cameraHealthRoutes = require('./cameraHealth.routes');
const adminRoutes = require('./admin.routes');
const healthRoutes = require('./health.routes');
const metricsRoutes = require('./metrics.routes');
const systemRoutes = require('./system.routes');
const notificationRoutes = require('./notifications.routes');
const manageUsersRoutes = require('./manageUsers.routes');
const restrictedZoneRoutes = require('./restrictedZone.routes');
const playbackRoutes = require('./playback.routes');
const wallLayoutRoutes = require('./wallLayout.routes');
const reportRoutes = require('./reports.routes');
const edgeRoutes = require('./edge.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/user', userRoutes);
router.use('/shinobi', shinobiRoutes);
router.use('/groups', cameraGroupRoutes);
router.use('/payment', paymentRoutes);
router.use('/subscription', subscriptionRoutes);
router.use('/stream', streamRoutes);
router.use('/internal', internalRoutes);
// Site relays (drishyam-site-relay.ps1) asking for NVR replays to push up.
router.use('/edge', edgeRoutes);
router.use('/ai', aiRoutes);
// Head-count history + reports (see docs/OCCUPANCY_LOGIC.md)
router.use('/occupancy', occupancyRoutes);
router.use('/spaces', spaceRoutes);
// Mobile push-token registration (Expo). Alerts fan out from alertEngine.
router.use('/notifications', notificationRoutes);
// person-tracker (separate Python service on :8003) — search-by-photo
// → stitched video / PDF / map. Reverse-proxied; backend handles JWT
// + injects X-Service-Token. See person-tracker/docs/DEPLOYMENT.md.
router.use('/person-tracker', personTrackerRoutes);
// TURN credentials (Phase 1.4) — coturn use-auth-secret REST scheme.
// Returns { available: false } until TURN_URI + TURN_SHARED_SECRET are set.
router.use('/turn', turnRoutes);
// LiveKit (Phase 4 — SFU) — mints per-room subscriber JWTs.
// Returns { available: false } when LIVEKIT_WS_URL is unset.
router.use('/livekit', livekitRoutes);
router.use('/sites', siteRoutes);
router.use('/sites/:siteId/import', bulkImportRoutes);
router.use('/cameras', cameraHealthRoutes);
router.use('/admin', adminRoutes);
// RBAC user administration (Settings → Manage Users) — MANAGE_USERS capability.
router.use('/manage', manageUsersRoutes);
// Restricted zones (drawn no-entry areas per camera).
router.use('/restricted-zones', restrictedZoneRoutes);
// NVR playback (replay the NVR's own recordings).
router.use('/playback', playbackRoutes);
// Saved Monitor Wall layouts, shared across the account.
router.use('/wall-layouts', wallLayoutRoutes);
// Report library — generate, keep, re-run, export (see reports.service.js)
router.use('/reports', reportRoutes);

// Backward-compatible shallow health (existing clients) — declared FIRST so
// /api/health (no subpath) hits this handler and never lands inside the deep
// router which would 404 on a bare /.
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Deep health endpoints — /api/health/{live,ready,full}
router.use('/health', healthRoutes);

// Prometheus scrape — /api/metrics
router.use('/metrics', metricsRoutes);

// Host system stats (storage etc.) — /api/system/storage
router.use('/system', systemRoutes);

module.exports = router;
