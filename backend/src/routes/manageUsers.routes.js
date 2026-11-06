const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireCapability = require('../middleware/requireCapability');
const requireFeature = require('../middleware/requireFeature');
const { CAPABILITIES } = require('../utils/constants');
const ctrl = require('../controllers/manageUsers.controller');
const roles = require('../controllers/manageRoles.controller');

const router = Router();

// Every route: authenticated + MANAGE_USERS capability (admins only). The
// middleware also hydrates req.dbUser so the controller can scope to the account.
router.use(authenticate, requireCapability(CAPABILITIES.MANAGE_USERS));
// Users & roles switch (Account control). Only Settings › Users calls this.
router.use(requireFeature('user_management'));

router.get('/users',                 ctrl.listUsers);
router.get('/users/options',         ctrl.options);
router.post('/users',                ctrl.createUser);
router.put('/users/:id',             ctrl.updateUser);
router.put('/users/:id/password',    ctrl.resetPassword);
router.delete('/users/:id',          ctrl.deleteUser);

// Custom roles (name + assigned features)
router.get('/roles',                 roles.listRoles);
router.get('/roles/capabilities',    roles.capabilities);
router.post('/roles',                roles.createRole);
router.put('/roles/:id',             roles.updateRole);
router.delete('/roles/:id',          roles.deleteRole);

module.exports = router;
