const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const validate = require('../middleware/validate');
const { layout } = require('../validators/wallLayout.validation');
const ctrl = require('../controllers/wallLayout.controller');

// Saved Monitor Wall layouts, shared across the account. See the controller.
const router = Router();
router.use(authenticate);
router.use(requireFeature('monitor_wall')); // Video wall switch (Account control); only the wall pages call this API

router.get   ('/',    ctrl.listLayouts);
router.post  ('/',    validate(layout), ctrl.createLayout);
router.get   ('/:id', ctrl.getLayout);
router.put   ('/:id', validate(layout), ctrl.updateLayout);
router.delete('/:id', ctrl.deleteLayout);

module.exports = router;
