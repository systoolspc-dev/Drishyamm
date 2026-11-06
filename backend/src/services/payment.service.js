const { Plan, Subscription, Payment, User } = require('../models');
const stripeService = require('./stripe.service');
const razorpayService = require('./razorpay.service');
const shinobiService = require('./shinobi.service');
const logger = require('../config/logger');
const AppError = require('../utils/AppError');
const { GATEWAY, PAYMENT_STATUS, SUBSCRIPTION_STATUS } = require('../utils/constants');

const paymentService = {
  /**
   * Create checkout session (auto-selects gateway)
   */
  async createCheckout(user, planId, successUrl, cancelUrl, gateway = GATEWAY.RAZORPAY) {
    const plan = await Plan.findByPk(planId);
    if (!plan || !plan.isActive) {
      throw new AppError('Plan not found or inactive.', 404);
    }

    if (parseFloat(plan.price) === 0) {
      // Free plan — create subscription directly
      return this._activateFreePlan(user, plan);
    }

    const service = gateway === GATEWAY.STRIPE ? stripeService : razorpayService;
    const result = await service.createCheckoutSession({
      plan,
      user,
      successUrl,
      cancelUrl,
    });

    // Create pending payment record
    await Payment.create({
      userId: user.id,
      amount: plan.price,
      currency: gateway === GATEWAY.STRIPE ? 'USD' : 'INR',
      gateway,
      status: PAYMENT_STATUS.PENDING,
    });

    return { ...result, gateway };
  },

  /**
   * Handle webhook events from payment gateways
   */
  async handleStripeWebhook(payload, signature) {
    const event = stripeService.verifyWebhookSignature(payload, signature);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await this._handleCheckoutComplete(
          session.metadata.userId,
          session.metadata.planId,
          session.subscription,
          session.id,
          GATEWAY.STRIPE
        );
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object;
        // Renewal payment
        if (invoice.subscription) {
          await this._handleRenewal(invoice.subscription, GATEWAY.STRIPE);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await this._handleCancellation(subscription.id, GATEWAY.STRIPE);
        break;
      }
      default:
        logger.info(`Unhandled Stripe event: ${event.type}`);
    }
  },

  async handleRazorpayWebhook(body, signature) {
    razorpayService.verifyWebhookSignature(body, signature);

    const event = body.event;
    const payload = body.payload;

    switch (event) {
      case 'subscription.activated': {
        const sub = payload.subscription.entity;
        const notes = sub.notes || {};
        await this._handleCheckoutComplete(
          notes.userId,
          notes.planId,
          sub.id,
          sub.id,
          GATEWAY.RAZORPAY
        );
        break;
      }
      case 'payment.captured': {
        // Payment successful
        const payment = payload.payment.entity;
        await this._updatePaymentStatus(payment.id, PAYMENT_STATUS.COMPLETED, GATEWAY.RAZORPAY);
        break;
      }
      case 'subscription.cancelled': {
        const sub = payload.subscription.entity;
        await this._handleCancellation(sub.id, GATEWAY.RAZORPAY);
        break;
      }
      default:
        logger.info(`Unhandled Razorpay event: ${event}`);
    }
  },

  /**
   * Verify a checkout session
   */
  async verifySession(sessionId, gateway = GATEWAY.STRIPE) {
    if (gateway === GATEWAY.STRIPE) {
      const session = await stripeService.getSession(sessionId);
      return {
        success: session.payment_status === 'paid',
        subscriptionId: session.subscription,
      };
    }

    // Razorpay verification
    return { success: true, subscriptionId: sessionId };
  },

  // --- Internal methods ---

  async _activateFreePlan(user, plan) {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setFullYear(periodEnd.getFullYear() + 100); // Free plan doesn't expire

    await Subscription.create({
      userId: user.id,
      planId: plan.id,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    });

    // Provision Shinobi if not already done
    if (!user.groupKey) {
      const { groupKey, apiKey } = await shinobiService.provisionUser(user.email);
      await User.update({ groupKey, apiKey }, { where: { id: user.id } });
    }

    return { checkoutUrl: null, message: 'Free plan activated successfully.' };
  },

  async _handleCheckoutComplete(userId, planId, gatewaySubId, gatewayPaymentId, gateway) {
    // Idempotency: check if already processed
    const existing = await Payment.findOne({
      where: { gatewayPaymentId, status: PAYMENT_STATUS.COMPLETED },
    });
    if (existing) return;

    const plan = await Plan.findByPk(planId);
    const user = await User.findByPk(userId);

    if (!plan || !user) {
      logger.error('Webhook: User or Plan not found', { userId, planId });
      return;
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + (plan.billingCycle === 'yearly' ? 12 : 1));

    // Create subscription
    const subData = {
      userId,
      planId,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    };

    if (gateway === GATEWAY.STRIPE) {
      subData.stripeSubscriptionId = gatewaySubId;
    } else {
      subData.razorpaySubscriptionId = gatewaySubId;
    }

    const subscription = await Subscription.create(subData);

    // Update payment record
    await Payment.update(
      {
        subscriptionId: subscription.id,
        gatewayPaymentId,
        status: PAYMENT_STATUS.COMPLETED,
      },
      {
        where: { userId, status: PAYMENT_STATUS.PENDING, gateway },
        limit: 1,
      }
    );

    // Provision Shinobi account if first payment
    if (!user.groupKey) {
      const { groupKey, apiKey } = await shinobiService.provisionUser(user.email);
      await user.update({ groupKey, apiKey });
    }

    logger.info('Payment completed & subscription activated', { userId, planId, gateway });
    require('./platformEvents.service').record('payment.completed', {
      accountId: user.parentUserId || user.id,
      actor: { kind: user.parentUserId ? 'member' : 'owner', id: user.id, label: user.name || user.email },
      summary: `Payment received: ${plan.name} (${plan.billingCycle || 'monthly'}) via ${gateway}`,
      data: { planId, planName: plan.name, gateway, gatewayPaymentId, price: plan.price },
    });
  },

  async _handleRenewal(gatewaySubId, gateway) {
    const field = gateway === GATEWAY.STRIPE ? 'stripeSubscriptionId' : 'razorpaySubscriptionId';
    const subscription = await Subscription.findOne({ where: { [field]: gatewaySubId } });

    if (subscription) {
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      await subscription.update({
        status: SUBSCRIPTION_STATUS.ACTIVE,
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
      });
    }
  },

  async _handleCancellation(gatewaySubId, gateway) {
    const field = gateway === GATEWAY.STRIPE ? 'stripeSubscriptionId' : 'razorpaySubscriptionId';
    const subscription = await Subscription.findOne({ where: { [field]: gatewaySubId } });

    if (subscription) {
      await subscription.update({ status: SUBSCRIPTION_STATUS.CANCELLED });
      logger.info('Subscription cancelled', { subscriptionId: subscription.id, gateway });
      const pe = require('./platformEvents.service');
      pe.accountOfUser(subscription.userId).then((accountId) => pe.record('subscription.cancelled', {
        severity: 'warning',
        accountId,
        actor: 'system',
        summary: `Subscription cancelled at ${gateway}`,
        data: { subscriptionId: subscription.id, gateway },
      })).catch(() => {});
    }
  },

  async _updatePaymentStatus(gatewayPaymentId, status, gateway) {
    await Payment.update(
      { status },
      { where: { gatewayPaymentId, gateway } }
    );
  },
};

module.exports = paymentService;
