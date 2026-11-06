const SECRET = 'test-stream-secret-at-least-16-chars';

function load(withSecret, ttl) {
  jest.resetModules();
  if (withSecret) process.env.STREAM_URL_SECRET = SECRET; else delete process.env.STREAM_URL_SECRET;
  if (ttl != null) process.env.STREAM_URL_TTL_SEC = String(ttl); else delete process.env.STREAM_URL_TTL_SEC;
  return require('../src/utils/streamToken');
}

describe('streamToken with a secret', () => {
  let st;
  beforeAll(() => { st = load(true); });
  afterAll(() => { delete process.env.STREAM_URL_SECRET; });

  test('enabled() is true', () => expect(st.enabled()).toBe(true));

  test('a freshly signed token verifies for its camera', () => {
    const { token, expires } = st.sign('abc123def456', { userId: 'u1' });
    expect(st.verify('abc123def456', token, expires, 'u1')).toBe(true);
  });

  test('a token for one camera does NOT verify for another', () => {
    const { token, expires } = st.sign('cameraA', { userId: 'u1' });
    expect(st.verify('cameraB', token, expires, 'u1')).toBe(false);
  });

  test('a token bound to one user does NOT verify for another (cross-account)', () => {
    const { token, expires } = st.sign('cam1', { userId: 'alice' });
    expect(st.verify('cam1', token, expires, 'bob')).toBe(false);
  });

  test('an expired token is rejected', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = require('node:crypto').createHmac('sha256', SECRET).update(`cam1::${past}`).digest('base64url');
    expect(st.verify('cam1', token, past)).toBe(false);
  });

  test('a tampered token is rejected', () => {
    const { token, expires } = st.sign('cam1');
    expect(st.verify('cam1', `${token}x`, expires)).toBe(false);
  });

  test('monitorIdFromPath extracts the id', () => {
    expect(st.monitorIdFromPath('/hls/cam_abc123def456/index.m3u8')).toBe('abc123def456');
    expect(st.monitorIdFromPath('/live/cam_deadbeef00/whep')).toBe('deadbeef00');
    expect(st.monitorIdFromPath('/hls/all_others/x')).toBeNull();
  });
});

describe('streamToken with NO secret (disabled)', () => {
  let st;
  beforeAll(() => { st = load(false); });

  test('enabled() is false, sign() returns null, verify() is false', () => {
    expect(st.enabled()).toBe(false);
    expect(st.sign('cam1')).toBeNull();
    expect(st.verify('cam1', 'x', Date.now() / 1000 + 100)).toBe(false);
  });
});
