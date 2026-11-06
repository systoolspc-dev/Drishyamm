const { productionSecretProblems } = require('../src/config/prodSecretGuard');

const GOOD = {
  NODE_ENV: 'production',
  JWT_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  MEDIAMTX_API_PASS: 'strong-rotated-pass',
  DB_PASSWORD: 'strong-db-pass',
  STRIPE_SECRET_KEY: 'sk_live_realkey',
};

describe('productionSecretProblems — refuse-to-boot guard', () => {
  test('a fully-rotated prod config has no problems', () => {
    expect(productionSecretProblems(GOOD)).toEqual([]);
  });

  test('is a no-op outside production (dev/test can use sample values)', () => {
    expect(productionSecretProblems({ ...GOOD, NODE_ENV: 'development', JWT_SECRET: 'dev-jwt-secret-...' })).toEqual([]);
    expect(productionSecretProblems({ ...GOOD, NODE_ENV: 'test', DB_PASSWORD: '' })).toEqual([]);
  });

  test('flags dev-default JWT secrets in production', () => {
    const p = productionSecretProblems({ ...GOOD, JWT_SECRET: 'dev-jwt-secret-key-must-be-at-least-32-characters-long' });
    expect(p.some((s) => /JWT_SECRET/.test(s))).toBe(true);
  });

  test('flags identical access + refresh secrets', () => {
    const same = 'x'.repeat(48);
    const p = productionSecretProblems({ ...GOOD, JWT_SECRET: same, JWT_REFRESH_SECRET: same });
    expect(p.some((s) => /must differ/.test(s))).toBe(true);
  });

  test('flags the sample MediaMTX password, empty DB password, placeholder Stripe key', () => {
    expect(productionSecretProblems({ ...GOOD, MEDIAMTX_API_PASS: 'drishyam123' }).some((s) => /MEDIAMTX/.test(s))).toBe(true);
    expect(productionSecretProblems({ ...GOOD, DB_PASSWORD: '' }).some((s) => /DB_PASSWORD/.test(s))).toBe(true);
    expect(productionSecretProblems({ ...GOOD, STRIPE_SECRET_KEY: 'sk_test_placeholder_replace_with_real_key' }).some((s) => /STRIPE/.test(s))).toBe(true);
  });
});
