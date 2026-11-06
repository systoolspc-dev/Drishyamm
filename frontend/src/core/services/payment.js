import api from './api';

export const paymentService = {
  createCheckout: async (planId) => {
    const response = await api.post('/payment/create-checkout', {
      planId,
      successUrl: `${window.location.origin}/payment/success`,
      cancelUrl: `${window.location.origin}/pricing`,
    });

    // Redirect to Stripe/Razorpay
    window.location.href = response.data.checkoutUrl;
  },

  verifyPayment: async (sessionId) => {
    const response = await api.post('/payment/verify', { sessionId });
    return response.data;
  },

  getSubscriptionStatus: async () => {
    const response = await api.get('/subscription/status');
    return response.data;
  },
};
