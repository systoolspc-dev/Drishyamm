// CORS decides whether the web app can talk to the API AT ALL, and it fails in
// a way that never points at itself: a rejected preflight makes the browser
// block the request, axios reports the generic "Network Error", and the player
// renders "Stream Unavailable". Nothing reaches the route handler, so the
// server log stays silent and the whole thing looks like a broken video
// pipeline. That is exactly how this last presented.
//
// Two rules, both learned the hard way:
//   1. Every loopback spelling is allowed. CORS_ORIGINS listed only
//      `http://localhost:5173`, so opening the app on `http://127.0.0.1:5173`
//      — which people do here, because `localhost` intermittently resolves to
//      a dead IPv6 route — broke every single API call.
//   2. A disallowed origin is DECLINED, never thrown. Passing an Error to the
//      cors callback hands it to Express's error handler, so the preflight
//      answered 500: an opaque server error instead of a CORS diagnostic.

jest.mock('../src/config/env', () => ({
  cors: { origins: ['https://drishyam.example.com'] },
}));

const corsOptions = require('../src/config/cors');

/** Run the configured origin callback and report what cors would do. */
const decide = (origin) =>
  new Promise((resolve, reject) => {
    corsOptions.origin(origin, (err, allow) => (err ? reject(err) : resolve(allow)));
  });

describe('CORS origin policy', () => {
  test.each([
    ['http://localhost:5173',   'Vite dev server'],
    ['http://127.0.0.1:5173',   'the spelling that used to 500'],
    ['http://[::1]:5173',       'IPv6 loopback'],
    ['http://localhost:8081',   'Expo / React Native web'],
    ['http://127.0.0.1:19006',  'Expo web (classic)'],
    ['http://localhost:3000',   'any other dev port'],
    ['https://127.0.0.1:5173',  'https on loopback'],
  ])('allows %s (%s)', async (origin) => {
    await expect(decide(origin)).resolves.toBe(true);
  });

  test('allows a configured deployment origin', async () => {
    await expect(decide('https://drishyam.example.com')).resolves.toBe(true);
  });

  test('allows a request with no origin (curl, native app, server-to-server)', async () => {
    await expect(decide(undefined)).resolves.toBe(true);
  });

  describe('a disallowed origin', () => {
    const evil = 'https://evil.example.com';

    test('is declined, so no CORS headers are sent', async () => {
      await expect(decide(evil)).resolves.toBe(false);
    });

    // The regression: throwing turned a routine rejection into a 500 on the
    // preflight, which is what made this look like a dead API.
    test('does NOT raise — raising becomes a 500 on the preflight', async () => {
      await expect(decide(evil)).resolves.not.toThrow;
      await expect(decide(evil)).resolves.toBeDefined();
    });

    test.each([
      'https://localhost.evil.com',        // suffix trick
      'https://evil.com/?x=http://localhost:5173',
      'http://127.0.0.1.evil.com',         // loopback-looking host, not loopback
      'http://notlocalhost:5173',
    ])('is not fooled by %s', async (origin) => {
      await expect(decide(origin)).resolves.toBe(false);
    });
  });

  test('credentials stay on — the app sends its JWT and MediaMTX session cookie', () => {
    expect(corsOptions.credentials).toBe(true);
    expect(corsOptions.allowedHeaders).toEqual(expect.arrayContaining(['Authorization']));
  });
});
