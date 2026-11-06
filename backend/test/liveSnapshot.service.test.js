// Stills for the Monitor Wall editor must never become a recorder flood: a
// live path is reused for free, a direct grab is one-at-a-time per NVR host,
// and a cached still is shared instead of re-grabbed.

const mockSpawned = [];
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    mockSpawned.push(proc);
    return proc;
  }),
}));

const mockReady = new Set();
jest.mock('../src/services/drishyamStreaming.service', () => ({
  api: {
    get: jest.fn(async (url) => ({ data: { ready: mockReady.has(url.split('/').pop()) } })),
  },
  pathName: (id) => `cam_${id}`,
  subPathName: (id) => `cam_${id}_sub`,
  getRtspEgressUrl: (id, sub) => `rtsp://stream-service:8554/cam_${id}${sub ? '_sub' : ''}`,
  deriveSubPath: (p) => (p === '/Streaming/Channels/101' ? '/Streaming/Channels/102' : null),
  buildRtspUrl: ({ host, port, path, username, password }) => `rtsp://${username}:${password}@${host}:${port}${path}`,
}));

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const snapshots = require('../src/services/liveSnapshot.service');
const { pickSource, scrub, cache } = snapshots._internals;

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const finish = (proc) => { proc.stdout.emit('data', Buffer.from('jpeg')); proc.emit('close', 0); };

const cam = (id, extra = {}) => ({
  monitorId: id, host: '10.0.0.9', port: 554, path: '/Streaming/Channels/101',
  username: 'admin', password: 'p@ss', status: 'online', ...extra,
});

beforeEach(() => { mockSpawned.length = 0; mockReady.clear(); cache.clear(); });

describe('pickSource', () => {
  test('reads the live sub-stream from Stream Service when someone is already watching', async () => {
    mockReady.add('cam_a_sub');
    expect(await pickSource(cam('a'))).toEqual({ kind: 'live', url: 'rtsp://stream-service:8554/cam_a_sub' });
  });

  test('falls back to the live main path when only that is ready', async () => {
    mockReady.add('cam_a');
    expect((await pickSource(cam('a'))).url).toBe('rtsp://stream-service:8554/cam_a');
  });

  test('otherwise goes direct to the camera sub-stream, not through Stream Service', async () => {
    const src = await pickSource(cam('a'));
    expect(src.kind).toBe('direct');
    expect(src.host).toBe('10.0.0.9');
    expect(src.url).toBe('rtsp://admin:p@ss@10.0.0.9:554/Streaming/Channels/102');
  });

  test('uses the main path when the vendor has no sub-stream', async () => {
    const src = await pickSource(cam('a', { path: '/live' }));
    expect(src.url).toMatch(/\/live$/);
  });
});

test('scrub removes credentials from anything headed for a log, even a raw @ in the password', () => {
  expect(scrub('rtsp://admin:p@ss@10.0.0.9:554/x: Connection refused')).toBe('rtsp://***@10.0.0.9:554/x: Connection refused');
  expect(scrub('rtsp://admin:p%40ss@10.0.0.9:554/Streaming/Channels/102')).toBe('rtsp://***@10.0.0.9:554/Streaming/Channels/102');
});

describe('getSnapshot', () => {
  test('shares one grab between simultaneous requests and serves the cache after', async () => {
    const first = snapshots.getSnapshot(cam('a'));
    const second = snapshots.getSnapshot(cam('a'));
    await flush();
    expect(mockSpawned).toHaveLength(1);
    finish(mockSpawned[0]);
    const [a, b] = await Promise.all([first, second]);
    expect(a.jpeg.toString()).toBe('jpeg');
    expect(b.stale).toBe(false);

    await snapshots.getSnapshot(cam('a'));
    expect(mockSpawned).toHaveLength(1);
  });

  test('decodes from a keyframe, so a still is never a grey half-frame', async () => {
    const p = snapshots.getSnapshot(cam('k'));
    await flush();
    const args = require('child_process').spawn.mock.calls.at(-1)[1];
    const beforeInput = args.slice(0, args.indexOf('-i'));
    expect(beforeInput).toEqual(expect.arrayContaining(['-skip_frame', 'nokey']));
    finish(mockSpawned.at(-1));
    await p;
  });

  test('never runs two direct grabs against the same recorder at once', async () => {
    const one = snapshots.getSnapshot(cam('a'));
    const two = snapshots.getSnapshot(cam('b'));
    await flush();
    expect(mockSpawned).toHaveLength(1);
    finish(mockSpawned[0]);
    await one;
    await flush();
    expect(mockSpawned).toHaveLength(2);
    finish(mockSpawned[1]);
    await two;
  });

  test('grabs from different recorders in parallel', async () => {
    const one = snapshots.getSnapshot(cam('a'));
    const two = snapshots.getSnapshot(cam('b', { host: '10.0.0.10' }));
    await flush();
    expect(mockSpawned).toHaveLength(2);
    mockSpawned.forEach(finish);
    await Promise.all([one, two]);
  });

  test('does not try an offline camera, and serves an older still when it has one', async () => {
    await expect(snapshots.getSnapshot(cam('a', { status: 'offline' }))).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(mockSpawned).toHaveLength(0);

    cache.set('a', { jpeg: Buffer.from('old'), at: Date.now() - 5 * 60 * 1000, source: 'direct' });
    const shot = await snapshots.getSnapshot(cam('a', { status: 'offline' }));
    expect(shot.stale).toBe(true);
    expect(shot.jpeg.toString()).toBe('old');
  });

  test('falls back to the older still when a grab fails', async () => {
    cache.set('a', { jpeg: Buffer.from('old'), at: Date.now() - 5 * 60 * 1000, source: 'direct' });
    const p = snapshots.getSnapshot(cam('a'));
    await flush();
    mockSpawned[0].emit('close', 1);
    const shot = await p;
    expect(shot.stale).toBe(true);
  });
});
