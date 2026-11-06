const { Router } = require('express');
const shinobiController = require('../controllers/shinobi.controller');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const validate = require('../middleware/validate');
const shinobiValidation = require('../validations/shinobi.validation');

const router = Router();

router.get('/cameras', authenticate, shinobiController.getCameras);
router.get('/cameras/:monitorId', authenticate, shinobiController.getCamera);
// Adding / removing a camera is behind the Add & edit cameras switch. Editing
// stays open: per-camera settings are also saved from other pages.
const setup = requireFeature('camera_setup');
router.post('/cameras', authenticate, setup, validate(shinobiValidation.addCamera), shinobiController.addCamera);
router.put('/cameras/:monitorId', authenticate, validate(shinobiValidation.updateCamera), shinobiController.updateCamera);
router.delete('/cameras/:monitorId', authenticate, setup, shinobiController.deleteCamera);
router.get('/recordings/:monitorId', authenticate, shinobiController.getRecordings);

module.exports = router;
