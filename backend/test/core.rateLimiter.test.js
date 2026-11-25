// Rate limits: the auth limiter (brute-force guard on login/register/refresh)
// and the general API limiter, driven through the real express-rate-limit
// middleware with an in-memory store. Keyed per client IP.

// NODE_ENV is read both at load (auth budget) and per request (local-dev
// skip), so it stays set for the whole test and is restored afterwards.
const SAVED = { NODE_ENV: process.env.NODE_ENV, RATE_LIMIT_SKIP_PRIVATE: process.env.RATE_LIMIT_SKIP_PRIVATE };
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const loadLimiters = (env = {}) => {
  let mod;
  Object.assign(process.env, { RATE_LIMIT_SKIP_PRIVATE: '' }, env);
  jest.isolateModules(() => { mod = require('../src/middleware/rateLimiter'); });
  return mod;
};

const hit = (mw, { ip = '203.0.113.7', path = '/auth/login', method = 'POST' } = {}) => new Promise((resolve) => {
  const headers = {};
  const req = {
    ip, method, path, url: path, originalUrl: path, headers: {}, app: { get: () => false },
    connection: { remoteAddress: ip }, socket: { remoteAddress: ip },
  };
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    append(k, v) { headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    send(b) { resolve({ limited: true, status: this.statusCode, body: b, headers }); },
    json(b) { resolve({ limited: true, status: this.statusCode, body: b, headers }); },
    end(b) { resolve({ limited: true, status: this.statusCode, body: b, headers }); },
    on() {},
  };
  mw(req, res, (err) => resolve({ limited: false, err, headers }));
});

async function hitN(mw, n, opts) {
  let last;
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await hit(mw, opts);
    if (last.limited) return { at: i + 1, last };
  }
  return { at: null, last };
}

describe('authLimiter', () => {
  test('production: the 11th auth attempt from one IP in the window is refused with 429', async () => {
    const { authLimiter } = loadLimiters({ NODE_ENV: 'production' });
    const r = await hitN(authLimiter, 11);
    expect(r.at).toBe(11);
    expect(r.last.status).toBe(429);
    expect(r.last.body).toMatchObject({ success: false, message: expect.stringMatching(/Too many login attempts/) });
  });

  test('production: loopback is NOT exempt (no localhost bypass in production)', async () => {
    const { authLimiter } = loadLimiters({ NODE_ENV: 'production' });
    const r = await hitN(authLimiter, 11, { ip: '127.0.0.1' });
    expect(r.at).toBe(11);
  });

  test('outside production the auth budget is 100 per IP per window', async () => {
    const { authLimiter } = loadLimiters({ NODE_ENV: 'development' });
    const r = await hitN(authLimiter, 101);
    expect(r.at).toBe(101);
  });

  test('the bucket is per IP: one client being limited does not lock out another', async () => {
    const { authLimiter } = loadLimiters({ NODE_ENV: 'production' });
    await hitN(authLimiter, 11, { ip: '203.0.113.7' });
    const other = await hit(authLimiter, { ip: '198.51.100.9' });
    expect(other.limited).toBe(false);
    const again = await hit(authLimiter, { ip: '203.0.113.7' });
    expect(again.limited).toBe(true);
  });

  test('the 15-minute window is advertised in the standard RateLimit headers', async () => {
    const { authLimiter } = loadLimiters({ NODE_ENV: 'production' });
    const r = await hit(authLimiter);
    const policy = r.headers['ratelimit-policy'] || '';
    expect(policy).toMatch(/10;w=900/);
    expect(r.headers['x-ratelimit-limit']).toBeUndefined(); // legacy headers off
  });

  test('outside production, loopback is exempt (local development)', async () => {
    const { authLimiter } = loadLimiters({ NODE_ENV: 'development' });
    const r = await hitN(authLimiter, 105, { ip: '127.0.0.1' });
    expect(r.at).toBeNull();
  });
});

describe('apiLimiter', () => {
  test('/internal/* service calls are never counted', async () => {
    const { apiLimiter } = loadLimiters({ NODE_ENV: 'production' });
    const r = await hit(apiLimiter, { path: '/internal/ai/events' });
    expect(r.limited).toBe(false);
    expect(r.headers['ratelimit-policy']).toBeUndefined(); // skipped before counting
  });

  test('GET snapshot / thumbnail image reads are not counted; other GETs are', async () => {
    const { apiLimiter } = loadLimiters({ NODE_ENV: 'production' });
    expect((await hit(apiLimiter, { method: 'GET', path: '/ai/events/1/snapshot' })).headers['ratelimit-policy']).toBeUndefined();
    expect((await hit(apiLimiter, { method: 'GET', path: '/groups/g/recordings/thumbnail' })).headers['ratelimit-policy']).toBeUndefined();
    expect((await hit(apiLimiter, { method: 'GET', path: '/groups' })).headers['ratelimit-policy']).toMatch(/5000;w=900/);
  });

  test('a POST to a snapshot path is counted (only GET image reads are free)', async () => {
    const { apiLimiter } = loadLimiters({ NODE_ENV: 'production' });
    expect((await hit(apiLimiter, { method: 'POST', path: '/stream/snapshot' })).headers['ratelimit-policy']).toMatch(/5000/);
  });

  test('the general budget is 5000 requests per IP per 15 minutes', async () => {
    const { apiLimiter } = loadLimiters({ NODE_ENV: 'production' });
    const r = await hitN(apiLimiter, 5001, { method: 'GET', path: '/groups' });
    expect(r.at).toBe(5001);
    expect(r.last.status).toBe(429);
  });
});
