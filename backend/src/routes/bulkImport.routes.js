const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const bulk = require('../controllers/bulkImport.controller');

// Mounted under /api/sites in the router index — these resolve as
// /api/sites/:siteId/import/...
const router = Router({ mergeParams: true });
router.use(authenticate);
router.use(requireFeature('camera_setup')); // CSV import = adding cameras

router.post('/preview', ...bulk.previewImport);
router.post('/commit',   bulk.commitImport);
router.get ('/template', bulk.csvTemplate);

module.exports = router;
