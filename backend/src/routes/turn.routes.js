const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const turn = require('../controllers/turn.controller');

const router = Router();

// Operator-scoped: only logged-in users get TURN creds. coturn is in our
// control + costs us bandwidth, so anonymous issuance would let a stranger
// relay arbitrary UDP through our server.
router.use(authenticate);

router.get('/credentials', turn.getCredentials);

module.exports = router;
