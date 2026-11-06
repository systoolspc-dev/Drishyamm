const asyncHandler = require('../middleware/asyncHandler');
const { User } = require('../models');
const paymentService = require('../services/payment.service');
const { GATEWAY } = require('../utils/constants');

const createCheckout = asyncHandler(async (req, res) => {
  const { planId, successUrl, cancelUrl, gateway } = req.body;

  const user = await User.findByPk(req.user.id);
  const result = await paymentService.createCheckout(user, planId, successUrl, cancelUrl, gateway);

  res.json({ success: true, ...result });
});

const verify = asyncHandler(async (req, res) => {
  const { sessionId, gateway } = req.body;

  const result = await paymentService.verifySession(sessionId, gateway);
  res.json({ success: true, ...result });
});

/**
 * Webhook handler — receives raw body for signature verification.
 * Gateway is determined by request headers.
 */
const webhook = asyncHandler(async (req, res) => {
  const stripeSignature = req.headers['stripe-signature'];
  const razorpaySignature = req.headers['x-razorpay-signature'];

  if (stripeSignature) {
    await paymentService.handleStripeWebhook(req.body, stripeSignature);
  } else if (razorpaySignature) {
    // For Razorpay, body is parsed JSON (raw was used for stripe)
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    await paymentService.handleRazorpayWebhook(body, razorpaySignature);
  } else {
    return res.status(400).json({ success: false, message: 'Unknown payment gateway.' });
  }

  res.json({ received: true });
});

module.exports = { createCheckout, verify, webhook };
