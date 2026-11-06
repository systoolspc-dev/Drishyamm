const { Router } = require('express');
const express = require('express');
const paymentController = require('../controllers/payment.controller');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const paymentValidation = require('../validations/payment.validation');

const router = Router();

router.post('/create-checkout', authenticate, validate(paymentValidation.createCheckout), paymentController.createCheckout);
router.post('/verify', authenticate, validate(paymentValidation.verify), paymentController.verify);

// Webhook — uses raw body for signature verification (no JSON parsing)
router.post('/webhook', express.raw({ type: 'application/json' }), paymentController.webhook);

module.exports = router;
