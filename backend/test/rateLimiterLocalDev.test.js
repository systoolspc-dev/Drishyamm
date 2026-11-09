// The dev skip must cover Docker's bridge address only when explicitly opted
// in: production runs NODE_ENV=development too, behind a private proxy address.
const load = (env) => {
  jest.resetModules();
  Object.assign(process.env, { NODE_ENV: 'development', RATE_LIMIT_SKIP_PRIVATE: '' }, env);
  return require('../src/middleware/rateLimiter')._isLocalDev;
};
const req = (ip) => ({ ip, connection: {} });

test('loopback is always skipped outside production', () => {
  const f = load({});
  expect(f(req('127.0.0.1'))).toBe(true);
  expect(f(req('::1'))).toBe(true);
});

test('docker / private addresses are NOT skipped unless opted in', () => {
  const f = load({});
  expect(f(req('172.20.0.1'))).toBe(false);
  expect(f(req('192.168.1.5'))).toBe(false);
});

test('opted in: docker bridge and private ranges are skipped, public ones are not', () => {
  const f = load({ RATE_LIMIT_SKIP_PRIVATE: '1' });
  for (const ip of ['172.20.0.1', '::ffff:172.18.0.1', '10.0.0.4', '192.168.0.114', 'fd00::1']) expect(f(req(ip))).toBe(true);
  for (const ip of ['103.109.7.36', '172.32.0.1', '111.125.141.20', '8.8.8.8']) expect(f(req(ip))).toBe(false);
});

test('NODE_ENV=production never skips', () => {
  const f = load({ NODE_ENV: 'production', RATE_LIMIT_SKIP_PRIVATE: '1' });
  expect(f(req('127.0.0.1'))).toBe(false);
  expect(f(req('172.20.0.1'))).toBe(false);
});
