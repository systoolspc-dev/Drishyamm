const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const ctrl = require('../controllers/restrictedZone.controller');

const router = Router();
router.use(authenticate); // zones are user-scoped

// Zones are drawn in Zone Setup, which head count shares — so either feature
// may read them; only restricted_zone may create or change one.
const READ  = requireFeature('restricted_zone', 'headcount');
const WRITE = requireFeature('restricted_zone');

router.get('/', READ, ctrl.list);
router.post('/', WRITE, ctrl.create);
router.put('/:id', WRITE, ctrl.update);
router.delete('/:id', WRITE, ctrl.remove);

module.exports = router;
