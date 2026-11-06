'use strict';

/**
 * Return a list of human-readable problems with production secret config.
 * Pure — no side effects — so env.js can decide whether to refuse boot and
 * tests can assert the logic without triggering process.exit.
 *
 * A no-op outside production: dev/test are free to use the sample .env values.
 */
function productionSecretProblems(e) {
  if (e.NODE_ENV !== 'production') return [];
  const problems = [];
  const looksDev = (s) =>
    typeof s === 'string' && /^dev-|change-me|placeholder|xxxx|secret-key-must-be/i.test(s);

  if (looksDev(e.JWT_SECRET))
    problems.push('JWT_SECRET is a dev/default value — set a random 32+ byte secret.');
  if (looksDev(e.JWT_REFRESH_SECRET))
    problems.push('JWT_REFRESH_SECRET is a dev/default value — set a random 32+ byte secret.');
  if (e.JWT_SECRET && e.JWT_SECRET === e.JWT_REFRESH_SECRET)
    problems.push('JWT_SECRET and JWT_REFRESH_SECRET must differ.');
  if (e.MEDIAMTX_API_PASS === 'drishyam123')
    problems.push('MEDIAMTX_API_PASS is the sample password — rotate it.');
  if (!e.DB_PASSWORD)
    problems.push('DB_PASSWORD is empty — set a strong MySQL password in production.');
  if (/placeholder|replace_with/i.test(e.STRIPE_SECRET_KEY || ''))
    problems.push('STRIPE_SECRET_KEY is a placeholder.');

  return problems;
}

module.exports = { productionSecretProblems };
