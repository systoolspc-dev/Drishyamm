const Razorpay = require('razorpay');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const AppError = require('../utils/AppError');

const razorpay = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
});

const razorpayService = {
  /**
   * Create a Razorpay subscription
   */
  async createCheckoutSession({ plan, user, successUrl, cancelUrl }) {
    try {
      const subscription = await razorpay.subscriptions.create({
        plan_id: plan.razorpayPlanId,
        total_count: 12, // 12 billing cycles
        notes: {
          userId: user.id,
          planId: plan.id,
          email: user.email,
        },
      });

      return {
        checkoutUrl: null, // Razorpay uses client-side SDK
        subscriptionId: subscription.id,
        razorpayKeyId: config.razorpay.keyId,
        successUrl,
        cancelUrl,
      };
    } catch (error) {
      logger.error('Razorpay createCheckoutSession failed', { error: error.message });
      throw new AppError('Failed to create payment session.', 500);
    }
  },

  /**
   * Verify Razorpay webhook signature
   */
  verifyWebhookSignature(body, signature) {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', config.razorpay.webhookSecret)
        .update(JSON.stringify(body))
        .digest('hex');

      if (expectedSignature !== signature) {
        throw new Error('Signature mismatch');
      }

      return body;
    } catch (error) {
      logger.error('Razorpay webhook verification failed', { error: error.message });
      throw new AppError('Invalid webhook signature.', 400);
    }
  },

  /**
   * Verify Razorpay payment signature (after client-side checkout)
   */
  verifyPaymentSignature({ razorpay_payment_id, razorpay_subscription_id, razorpay_signature }) {
    const generatedSignature = crypto
      .createHmac('sha256', config.razorpay.keySecret)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    return generatedSignature === razorpay_signature;
  },
};

module.exports = razorpayService;
