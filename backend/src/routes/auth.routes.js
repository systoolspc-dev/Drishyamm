const { Router } = require('express');
const authController = require('../controllers/auth.controller');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimiter');
const authValidation = require('../validations/auth.validation');

const router = Router();

// Public auth
router.post('/register', authLimiter, validate(authValidation.register), authController.register);
router.post('/login', authLimiter, validate(authValidation.login), authController.login);
router.post('/refresh-token', authLimiter, validate(authValidation.refreshToken), authController.refreshToken);

// Password reset (public, rate-limited)
router.post('/forgot-password', authLimiter, validate(authValidation.forgotPassword), authController.forgotPassword);
router.post('/reset-password', authLimiter, validate(authValidation.resetPassword), authController.resetPassword);

// Authenticated routes
router.get('/me', authenticate, authController.me);
router.put('/profile', authenticate, validate(authValidation.updateProfile), authController.updateProfile);
router.put('/change-password', authenticate, validate(authValidation.changePassword), authController.changePassword);
router.post('/logout', authenticate, authController.logout);

module.exports = router;
