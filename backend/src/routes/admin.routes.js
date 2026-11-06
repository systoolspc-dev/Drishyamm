const { Router } = require('express');
const ctrl = require('../controllers/admin.controller');
const cameraHealth = require('../controllers/cameraHealth.controller');
const healthCtrl = require('../controllers/health.controller');
const streamCtrl = require('../controllers/stream.controller');
const billing = require('../controllers/billing.controller');
const license = require('../controllers/license.controller');
const transcode = require('../controllers/transcode.controller');
const mailConfig = require('../controllers/mailConfig.controller');
const accountControl = require('../controllers/accountControl.controller');
const accounts = require('../controllers/adminAccounts.controller');
const activity = require('../controllers/platformActivity.controller');
const authenticate = require('../middleware/authenticate');
const adminAuth = require('../middleware/adminAuth');

const router = Router();

// All admin routes require auth + admin role
router.use(authenticate, adminAuth);

router.get('/stats', ctrl.getStats);
router.get('/users', ctrl.getUsers);
router.get('/users/:id', ctrl.getUser);
router.put('/users/:id/toggle-status', ctrl.toggleUserStatus);
router.get('/cameras', ctrl.getCameras);
router.get('/events', ctrl.getEvents);

// ── Live monitoring (advanced ops view for a client installation) ─────
// Infra health (services up/down) + per-customer live camera-stream health.
router.get('/system-health', healthCtrl.full);
router.get('/customers/:userId/camera-health', cameraHealth.getHealthForUser);
router.get('/customers/:userId/ops-metrics', ctrl.getOpsMetrics);
router.get('/cameras/:monitorId/stream-start', streamCtrl.adminStartStream);
router.get('/datasets', ctrl.getAllDatasets);
router.get('/datasets/download', ctrl.getDatasetDownload);

// ── Billing / licensing ──────────────────────────────────────────────
router.get('/pricing-catalog',         billing.getCatalog);
router.put('/pricing-catalog/:id',     billing.updateCatalogItem);
router.post('/quotes/calculate',       billing.calculateQuote);

router.get('/licenses',                license.listLicenses);
router.get('/licenses/:id',            license.getLicense);
router.post('/licenses',               license.createLicense);
router.put('/licenses/:id/status',     license.setLicenseStatus);
router.post('/quotes',                 license.saveQuote);

// ── Accounts list + account hub (owners only; health from camera-health) ──
router.get ('/accounts',                                     accounts.listAccounts);
router.get ('/accounts/:userId/hub',                         accounts.getHub);
router.get ('/accounts/:userId/events',                      accounts.listAccountEvents);
router.put ('/accounts/:userId/status',                      accounts.setAccountStatus);
router.post('/accounts/:userId/users/:memberId/password-reset', accounts.sendPasswordReset);
router.get ('/accounts/:userId/cameras/:cameraId/snapshot',  accounts.getCameraSnapshot);
router.get ('/audit',                                        accounts.listAudit);

// ── Live platform activity (history + reconnect backfill; live via socket 'platform-ops') ──
router.get('/activity',          activity.listActivity);
router.get('/activity/counters', activity.getCounters);

// ── Account control (one customer: plan, licences, feature switches) ──
router.get('/accounts/:userId/control',  accountControl.getControl);
router.put('/accounts/:userId/plan',     accountControl.setPlan);
router.put('/accounts/:userId/licences', accountControl.setLicences);
router.put('/accounts/:userId/features', accountControl.setFeatures);

// ── Email / SMTP settings (platform-wide outbound mail) ──────────────
router.get ('/mail-config',      mailConfig.get);
router.put ('/mail-config',      mailConfig.save);
router.post('/mail-config/test', mailConfig.test);

// ── Phase 3 — per-camera NVENC transcode toggle ──────────────────────
// Body: { enabled: boolean, bitrateKbps?: number }
router.patch('/cameras/:id/transcode', transcode.setTranscode);
// Roll-up of "desired" (DB) vs "live" (transcoder service) state.
router.get  ('/transcoders',           transcode.listTranscoders);

module.exports = router;
