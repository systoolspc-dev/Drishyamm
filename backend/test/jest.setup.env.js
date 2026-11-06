// Hermetic test environment.
//
// Tests must not depend on a developer's local `.env` (CI has none). This runs
// as a jest `setupFiles` entry — BEFORE any test module is required — so that
// when `config/env.js` loads and validates, the required vars are already
// present. `config/env.js` calls dotenv.config(), which does NOT override
// already-set process.env vars, so these dummy values win everywhere and the
// suite is deterministic with or without a local `.env`.

process.env.NODE_ENV = 'test';

// Required by config/env.js Joi schema:
process.env.DB_NAME                 ??= 'test_db';
process.env.DB_USER                 ??= 'test_user';
process.env.DB_PASSWORD             ??= '';
process.env.JWT_SECRET              ??= 'test-jwt-secret-at-least-32-characters-long-000';
process.env.JWT_REFRESH_SECRET      ??= 'test-refresh-secret-at-least-32-characters-diff';
process.env.STRIPE_SECRET_KEY       ??= 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET   ??= 'whsec_dummy';
process.env.RAZORPAY_KEY_ID         ??= 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET     ??= 'dummy_secret';
process.env.RAZORPAY_WEBHOOK_SECRET ??= 'dummy_webhook';
