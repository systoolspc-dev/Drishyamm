const { Router } = require('express');
const subscriptionController = require('../controllers/subscription.controller');
const authenticate = require('../middleware/authenticate');

const router = Router();

router.get('/status',  authenticate, subscriptionController.getStatus);
router.get('/license', authenticate, subscriptionController.getMyLicense);
router.get('/usage',   authenticate, subscriptionController.getUsage);

module.exports = router;
