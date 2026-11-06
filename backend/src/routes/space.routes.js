/** Spaces (rooms) — occupancy analytics. See docs/OCCUPANCY_LOGIC.md */
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const c = require('../controllers/space.controller');

const router = Router();
router.use(authenticate);
router.use(requireFeature('headcount')); // rooms are part of Head Count & Flow

router.get('/live', c.liveOccupancy);   // before /:id so it isn't captured
router.get('/', c.listSpaces);
router.post('/', c.createSpace);
router.put('/:id', c.updateSpace);
router.delete('/:id', c.deleteSpace);

module.exports = router;
