// Express routes for the person-tracker proxy. Every route is
// authenticated; the JWT middleware runs before the controller forwards
// upstream. Matches the surface area documented in
// person-tracker/docs/API.md.
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireAiCapability = require('../middleware/requireAiCapability');
const requireFeature = require('../middleware/requireFeature');
const pt = require('../controllers/personTracker.controller');

const router = Router();

router.use(authenticate);
router.use(requireAiCapability);   // PersonTracker is an AI+VMS feature (Basic VMS → 403)
// ...and one of the search/track pages must be switched on for the account.
router.use(requireFeature('person_search', 'person_tracker', 'journey_map'));

router.post  ('/search',                   pt.search);
router.post  ('/sightings/cluster',        pt.clusterSightings);
router.post  ('/stitch',                   pt.createStitchJob);
router.get   ('/stitch/:jobId',            pt.getStitchJobStatus);
router.get   ('/stitch/:jobId/video',      pt.downloadVideo);
router.get   ('/stitch/:jobId/report.pdf', pt.downloadReport);
router.get   ('/stitch/:jobId/map.json',   pt.getMap);
router.get   ('/snapshot',                 pt.getSnapshot);

module.exports = router;
