const { Router } = require('express');
const userController = require('../controllers/user.controller');
const authenticate = require('../middleware/authenticate');

const router = Router();

router.get('/group-key', authenticate, userController.getGroupKey);

module.exports = router;
