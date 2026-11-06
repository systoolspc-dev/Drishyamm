const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const ctrl = require('../controllers/notifications.controller');
const emailCtrl = require('../controllers/alertEmail.controller');

const router = Router();

router.use(authenticate); // notification settings are user-scoped

// Mobile app registers/refreshes its Expo push token here after login.
router.post('/register',   ctrl.registerToken);
router.post('/unregister', ctrl.unregisterToken);

// Email alert recipients — users add addresses to receive security alerts.
// Email alerts switch; alertEngine also stops sending when it is off.
router.use('/emails', requireFeature('email_alerts'));
router.get   ('/emails',          emailCtrl.list);
router.post  ('/emails',          emailCtrl.add);
router.patch ('/emails/:id',      emailCtrl.update);
router.delete('/emails/:id',      emailCtrl.remove);
router.post  ('/emails/:id/test', emailCtrl.test);

module.exports = router;
