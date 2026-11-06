const { Router }  = require('express');
const authenticate = require('../middleware/authenticate');
const requireAiCapability = require('../middleware/requireAiCapability');
const requireFeature = require('../middleware/requireFeature');
const ai          = require('../controllers/ai.controller');

// Per-feature gates (the account's switches in the admin console). Any one key
// is enough. Events, people-count and the camera lists are shared by Alerts,
// the dashboard and Camera Setup, so they stay on the tier gate alone.
const FACE         = requireFeature('face_watchlist', 'face_detection');
const FACE_READ    = requireFeature('face_watchlist', 'face_detection', 'person_search',
  'person_tracker', 'journey_map', 'activity');
const TRACKING     = requireFeature('person_search', 'person_tracker', 'journey_map');
const LIVE_TRACKER = requireFeature('person_tracker');
const ACTIVITY     = requireFeature('activity');
const HEADCOUNT    = requireFeature('headcount');

const router = Router();

router.use(authenticate);          // every AI route is user-scoped
router.use(requireAiCapability);   // ...and gated to AI+VMS plans (Basic VMS → 403)

// Events
router.get   ('/events',                   ai.listEvents);
router.get   ('/events/histogram',         ai.eventHistogram);   // Playback timeline markers
router.get   ('/reports',                  ai.getReport);
router.get   ('/events/:id/snapshot',      ai.getSnapshotUrl);
router.post  ('/events/:id/ack',           ai.acknowledgeEvent);

// Watchlist — individual face (proxy → smart-cam-ai)
router.get   ('/watchlist',                FACE_READ, ai.listWatchlist);
router.post  ('/watchlist',                FACE, ai.uploadFace);
router.delete('/watchlist/:name',          FACE, ai.deleteFace);

// Watchlist — bulk dataset ZIP upload for model training
router.post  ('/watchlist/dataset',        FACE, ai.handleUploadDataset);
// Chunked variant — for archives larger than the edge's per-request body limit.
router.post  ('/watchlist/dataset/chunk/init',     FACE, ai.initChunkedDataset);
router.post  ('/watchlist/dataset/chunk',          FACE, ai.uploadDatasetChunk);
router.post  ('/watchlist/dataset/chunk/complete', FACE, ai.completeChunkedDataset);
router.get   ('/watchlist/datasets',       FACE, ai.listDatasets);

router.get   ('/face-learning/samples',             FACE, ai.listFaceLearningSamples);
router.get   ('/face-learning/samples/:id/snapshot', FACE, ai.getFaceLearningSnapshot);
router.post  ('/face-learning/samples/:id/approve', FACE, ai.approveFaceLearningSample);
router.post  ('/face-learning/samples/:id/reject',  FACE, ai.rejectFaceLearningSample);

// Live people-count aggregate (building-wide + per-camera). Polled by
// Dashboard tiles and AiFeed header KPIs at ~2s.
router.get   ('/people-count',          ai.peopleCount);

// Activity / productivity (per-person phone-usage + time-in-state) — proxied
// to the activity-monitor service.
router.get   ('/activity/people',            ACTIVITY, ai.activityPeople);
router.get   ('/activity/sessions',          ACTIVITY, ai.activitySessions);
router.get   ('/activity/history',           ACTIVITY, ai.activityHistory);
router.get   ('/activity/attendance',        ACTIVITY, ai.activityAttendance);
router.get   ('/activity/crossings',         ACTIVITY, ai.activityCrossings);
router.get   ('/activity/alerts',            ACTIVITY, ai.activityAlerts);
router.post  ('/activity/alerts/:id/ack',    ACTIVITY, ai.activityAckAlert);
router.get   ('/activity/metrics',           ACTIVITY, ai.activityMetrics);
router.get   ('/activity/events',            ACTIVITY, ai.activityEvents);
// Real-time person tracker (LiveTracker in activity-monitor)
router.get   ('/track/live',                 LIVE_TRACKER, ai.trackLive);
router.get   ('/track/live/:name',           LIVE_TRACKER, ai.trackLive);
router.get   ('/track/graph',                LIVE_TRACKER, ai.trackGraph);
router.post  ('/track/reset',                LIVE_TRACKER, ai.trackReset);
// Which cameras run phone-usage / activity monitoring (per-camera, like person-tracking).
router.get   ('/activity-cameras',           ACTIVITY, ai.getActivityCameras);
router.post  ('/activity-cameras',           ACTIVITY, ai.setActivityCameras);
router.post  ('/notify/test-camera-offline', ai.notifyTestCameraOffline);
router.get   ('/activity/line',              ACTIVITY, ai.activityGetLine);
router.put   ('/activity/line',              ACTIVITY, ai.activitySetLine);
router.get   ('/activity/streams',           ACTIVITY, ai.activityStreams);
router.get   ('/activity/snapshot/:streamId', ACTIVITY, ai.activitySnapshot);

// Customer-footfall counter. The AI service owns the state; these are
// thin authenticated proxies so the frontend doesn't have to talk to a
// second origin. The `:id` path param is the AI service's camera UUID
// (from /footfall/cameras response), NOT smart-cam-backend's monitor_id.
router.get   ('/footfall/cameras',                HEADCOUNT, ai.footfallCameras);
router.get   ('/footfall/timeseries',             HEADCOUNT, ai.footfallTimeseries);
router.get   ('/footfall/cameras/:id/config',     HEADCOUNT, ai.footfallGetConfig);
router.put   ('/footfall/cameras/:id/config',     HEADCOUNT, ai.footfallPutConfig);
router.get   ('/footfall/export.csv',             HEADCOUNT, ai.footfallExportCsv);

// Face reconstruction (CodeFormer + Real-ESRGAN). Multipart upload of
// the face crop; upstream returns base64 before/after + a triage report.
// See controller for body shape.
router.post  ('/enhance',                FACE, ai.enhanceFace);

// Per-camera AI settings
router.get   ('/camera-mapping',        ai.listCameraMapping);
router.patch ('/cameras/:id/mapping',   ai.updateCameraMapping);
router.get   ('/cameras',               ai.listCameraAiSettings);
router.patch ('/cameras/:id/lifecycle', ai.updateCameraAiLifecycle);
router.put   ('/cameras/:id/settings',     ai.updateCameraSettings);
// Per-camera head-count toggle (user chooses which cameras get head counting).
router.put   ('/cameras/:id/headcount',    HEADCOUNT, ai.setCameraHeadcount);
// Turn cameras on/off for person tracking (checked in the Person Tracker dropdown).
router.post  ('/person-tracker-cameras',   TRACKING, ai.setPersonTrackerCameras);

module.exports = router;
