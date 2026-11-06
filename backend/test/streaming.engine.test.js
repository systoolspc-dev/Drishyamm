const MediaMTXEngine = require('../src/services/streaming/MediaMTXEngine');

/** Fresh engine per test with real backoff stubbed out (no waiting). */
function engine() {
  const e = new MediaMTXEngine();
  e._sleep = () => Promise.resolve();
  return e;
}

describe('path naming + URL building', () => {
  const e = engine();

  test('pathName / subPathName follow the cam_ convention', () => {
    expect(e.pathName('abc')).toBe('cam_abc');
    expect(e.subPathName('abc')).toBe('cam_abc_sub');
  });

  test('monitorIdFromPath is the inverse of pathName', () => {
    expect(e.monitorIdFromPath('cam_abc')).toBe('abc');
    expect(e.monitorIdFromPath('all_others')).toBeNull();
  });

  test('buildRtspUrl URI-encodes the password and defaults the port', () => {
    expect(e.buildRtspUrl({ host: '10.0.0.1', username: 'u', password: 'p@ss', path: '/s1' }))
      .toBe('rtsp://u:p%40ss@10.0.0.1:554/s1');
  });

  test('buildRtspUrl handles no-auth and normalizes a missing leading slash', () => {
    expect(e.buildRtspUrl({ host: 'h', port: 8554, path: 'stream' }))
      .toBe('rtsp://h:8554/stream');
  });
});

describe('_isTransient — what is worth retrying', () => {
  const e = engine();
  test('a network error (no HTTP response) is transient', () => expect(e._isTransient({})).toBe(true));
  test('a 5xx is transient', () => expect(e._isTransient({ response: { status: 503 } })).toBe(true));
  test('a 404 is definitive', () => expect(e._isTransient({ response: { status: 404 } })).toBe(false));
  test('a 400 is definitive', () => expect(e._isTransient({ response: { status: 400 } })).toBe(false));
});

describe('_deletePath — retry + confirmation semantics', () => {
  test('recovers after transient blips and reports gone', async () => {
    const e = engine();
    let n = 0;
    e.api = { delete: jest.fn(async () => { n += 1; if (n < 3) throw new Error('ECONNREFUSED'); return {}; }) };
    await expect(e._deletePath('cam_x')).resolves.toBe(true);
    expect(n).toBe(3);
  });

  test('treats 404 as already-gone with no retry', async () => {
    const e = engine();
    const err = new Error('nf'); err.response = { status: 404 };
    e.api = { delete: jest.fn(async () => { throw err; }) };
    await expect(e._deletePath('cam_x')).resolves.toBe(true);
    expect(e.api.delete).toHaveBeenCalledTimes(1);
  });

  test('gives up after the cap and reports NOT gone', async () => {
    const e = engine();
    e.api = { delete: jest.fn(async () => { throw new Error('timeout'); }) };
    await expect(e._deletePath('cam_x')).resolves.toBe(false);
    expect(e.api.delete).toHaveBeenCalledTimes(4); // ENGINE_RETRIES(3) + 1
  });

  test('does not retry a definitive 4xx', async () => {
    const e = engine();
    const err = new Error('bad'); err.response = { status: 400 };
    e.api = { delete: jest.fn(async () => { throw err; }) };
    await expect(e._deletePath('cam_x')).resolves.toBe(false);
    expect(e.api.delete).toHaveBeenCalledTimes(1);
  });
});

describe('_putPath — idempotent add/patch', () => {
  test('a plain POST success returns true and does not patch', async () => {
    const e = engine();
    e.api = { post: jest.fn(async () => ({})), patch: jest.fn() };
    await expect(e._putPath('cam_x', {})).resolves.toBe(true);
    expect(e.api.post).toHaveBeenCalledTimes(1);
    expect(e.api.patch).not.toHaveBeenCalled();
  });

  test('409 (already exists) falls back to PATCH — idempotent', async () => {
    const e = engine();
    const conflict = new Error('exists'); conflict.response = { status: 409 };
    e.api = { post: jest.fn(async () => { throw conflict; }), patch: jest.fn(async () => ({})) };
    await expect(e._putPath('cam_x', {})).resolves.toBe(true);
    expect(e.api.patch).toHaveBeenCalledTimes(1);
  });

  test('fatal:true throws AppError(502) on hard failure', async () => {
    const e = engine();
    e.api = { post: jest.fn(async () => { throw new Error('down'); }), patch: jest.fn() };
    await expect(e._putPath('cam_x', {}, { fatal: true })).rejects.toMatchObject({ statusCode: 502 });
  });

  test('fatal:false returns false without throwing (best-effort sub-stream)', async () => {
    const e = engine();
    e.api = { post: jest.fn(async () => { throw new Error('down'); }), patch: jest.fn() };
    await expect(e._putPath('cam_x', {}, { fatal: false })).resolves.toBe(false);
  });
});
