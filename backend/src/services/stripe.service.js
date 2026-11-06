const Stripe = require('stripe');
const config = require('../config/env');
const logger = require('../config/logger');
const AppError = require('../utils/AppError');

const stripe = new Stripe(config.stripe.secretKey);

const stripeService = {
  /**
   * Create a Stripe Checkout Session for subscription
   */
  async createCheckoutSession({ plan, user, successUrl, cancelUrl }) {
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: plan.stripePriceId,
            quantity: 1,
          },
        ],
        customer_email: user.email,
        metadata: {
          userId: user.id,
          planId: plan.id,
        },
        success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,
      });

      return {
        checkoutUrl: session.url,
        sessionId: session.id,
      };
    } catch (error) {
      logger.error('Stripe createCheckoutSession failed', { error: error.message });
      throw new AppError('Failed to create payment session.', 500);
    }
  },

  /**
   * Verify Stripe webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    try {
      return stripe.webhooks.constructEvent(
        payload,
        signature,
        config.stripe.webhookSecret
      );
    } catch (error) {
      logger.error('Stripe webhook verification failed', { error: error.message });
      throw new AppError('Invalid webhook signature.', 400);
    }
  },

  /**
   * Retrieve a checkout session
   */
  async getSession(sessionId) {
    try {
      return await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['subscription', 'customer'],
      });
    } catch (error) {
      logger.error('Stripe getSession failed', { sessionId, error: error.message });
      throw new AppError('Failed to retrieve payment session.', 500);
    }
  },
};

module.exports = stripeService;
