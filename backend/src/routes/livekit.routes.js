const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const livekit = require('../controllers/livekit.controller');

const router = Router();

// Operator-scoped — anonymous JWT issuance would let a stranger join
// any room. LiveKit's server has no per-token expiry check beyond the
// `exp` claim we set, so issuance discipline matters.
router.use(authenticate);

router.post('/token', livekit.issueToken);

module.exports = router;
