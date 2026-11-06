const Joi = require('joi');

const createCheckout = Joi.object({
  planId: Joi.string().uuid().required(),
  successUrl: Joi.string().uri().required(),
  cancelUrl: Joi.string().uri().required(),
  gateway: Joi.string().valid('stripe', 'razorpay').default('razorpay'),
});

const verify = Joi.object({
  sessionId: Joi.string().required(),
  gateway: Joi.string().valid('stripe', 'razorpay').default('stripe'),
});

module.exports = { createCheckout, verify };
