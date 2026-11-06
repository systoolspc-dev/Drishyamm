const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const site = require('../controllers/site.controller');

const router = Router();
router.use(authenticate);

// Reading sites is shared (Home, Live View, Map); changing them is Camera
// Setup, behind the Add & edit cameras switch.
const setup = requireFeature('camera_setup');

router.get   ('/',              site.listSites);
router.post  ('/',              setup, site.createSite);
router.get   ('/:id',           site.getSite);
router.put   ('/:id',           setup, site.updateSite);
router.delete('/:id',           setup, site.deleteSite);
router.post  ('/:id/archive',   setup, site.archiveSite);
router.post  ('/:id/restore',   setup, site.restoreSite);

module.exports = router;
