// Multi-tenant isolation for cameras, NVR groups and recordings
// (cameraGroup.controller = /api/groups, shinobi.controller = /api/shinobi).
// Two tenants share one fake database; tenant B asking for tenant A's group,
// camera or recording key must get 404/403 and must not trigger any side
// effect (stream teardown, DB write, presigned URL, disk read).

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/config/redis', () => ({ getBuffer: jest.fn(async () => null), set: jest.fn() }));
jest.mock('../src/events/bus', () => ({ emit: jest.fn(), bus: { emit: jest.fn() }, EVENTS: { CAMERA_DELETED: 'cd', GROUP_DELETED: 'gd' } }));
jest.mock('../src/services/drishyamStreaming.service', () => ({
  listPaths: jest.fn(async () => []),
  pathName: (m) => `cam_${m}`,
  removeCamera: jest.fn(async () => true),
  removeCameraSubStream: jest.fn(async () => true),
  addCamera: jest.fn(async () => true),
}));
jest.mock('../src/services/cameraReachability.service', () => ({ isReachable: () => false }));
jest.mock('../src/services/recordingRetention.service', () => ({
  applyRetention: jest.fn(async () => 7), applyToCameras: jest.fn(async (c) => c.length), resolveGroupRetentionDays: jest.fn(async () => 7),
}));
jest.mock('../src/services/cameraQuota.service', () => ({ assertCameraQuota: jest.fn() }));
jest.mock('../src/services/deviceProbe.service', () => ({}));
jest.mock('../src/services/vendors', () => ({ buildRtspPath: jest.fn() }));
jest.mock('../src/services/s3.service', () => ({
  listRecordings: jest.fn(async () => []),
  getPlaybackUrl: jest.fn(async (k) => `https://s3/${k}?sig`),
  getDownloadUrl: jest.fn(async (k) => `https://s3/${k}?dl`),
}));
jest.mock('../src/services/localRecordings.service', () => {
  const actual = jest.requireActual('../src/services/localRecordings.service');
  return {
    monitorIdFromKey: actual.monitorIdFromKey,
    listGroupRecordings: jest.fn(async () => []),
    listWindows: jest.fn(async () => []),
    getReadStream: jest.fn(),
  };
});
jest.mock('../src/services/shinobi.service', () => ({
  getCameras: jest.fn(async () => null), addCamera: jest.fn(), updateCamera: jest.fn(), deleteCamera: jest.fn(), getRecordings: jest.fn(async () => []),
}));

// ── fake DB: rows filtered by the `where` the controller sends ───────────────
const mockDb = { groups: [], cameras: [], users: [] };
jest.mock('../src/models', () => {
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
  const withInstance = (row) => row && Object.assign(row, {
    update: row.update || jest.fn(async function (v) { Object.assign(this, v); return this; }),
    destroy: row.destroy || jest.fn(async () => 1),
  });
  const Camera = {
    findOne: jest.fn(async ({ where }) => withInstance(mockDb.cameras.find((c) => match(c, where)) || null)),
    findAll: jest.fn(async ({ where }) => mockDb.cameras.filter((c) => match(c, where)).map(withInstance)),
    update: jest.fn(async (_v, { where }) => [mockDb.cameras.filter((c) => match(c, where)).length]),
    destroy: jest.fn(async ({ where }) => mockDb.cameras.filter((c) => match(c, where)).length),
    findOrCreate: jest.fn(async () => [{}, true]),
    create: jest.fn(),
  };
  const groupRow = (g) => withInstance(Object.assign(g, { cameras: mockDb.cameras.filter((c) => c.groupId === g.id).map(withInstance) }));
  const CameraGroup = {
    findOne: jest.fn(async ({ where }) => { const g = mockDb.groups.find((x) => match(x, where)); return g ? groupRow(g) : null; }),
    findAll: jest.fn(async ({ where }) => mockDb.groups.filter((x) => match(x, where)).map(groupRow)),
    findByPk: jest.fn(async (id) => mockDb.groups.find((g) => g.id === id) || null),
  };
  const User = { findByPk: jest.fn(async (id) => mockDb.users.find((u) => u.id === id) || null) };
  return { Camera, CameraGroup, User, Subscription: {}, Plan: {}, sequelize: {} };
});

const { Camera, CameraGroup } = require('../src/models');
const streaming = require('../src/services/drishyamStreaming.service');
const s3 = require('../src/services/s3.service');
const localRecordings = require('../src/services/localRecordings.service');
const recordingRetention = require('../src/services/recordingRetention.service');
const { emit, bus } = require('../src/events/bus');
const ctrl = require('../src/controllers/cameraGroup.controller');
const shinobi = require('../src/controllers/shinobi.controller');

const A = 'tenant-a';
const B = 'tenant-b';
const MID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // 24 hex, tenant A's camera
const MID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const run = (handler, req) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); },
    writeHead(c, h) { this.statusCode = c; this.headers = h; return this; },
    end(b) { resolve({ status: this.statusCode, body: b }); },
    set() { return this; },
  };
  handler({ params: {}, query: {}, body: {}, headers: {}, on: () => {}, ...req }, res, (err) => resolve({ err }));
});

beforeEach(() => {
  mockDb.groups = [
    { id: 'g-a', userId: A, name: 'A NVR', host: '10.0.0.1', username: 'admin', password: 'nvr-secret-A', totalChannels: 1 },
    { id: 'g-b', userId: B, name: 'B NVR', host: '10.0.0.2', username: 'admin', password: 'nvr-secret-B', totalChannels: 1 },
  ];
  mockDb.cameras = [
    { id: 'c-a', userId: A, groupId: 'g-a', monitorId: MID_A, name: 'Gate', host: '10.0.0.1', port: 554, path: '/ch1', username: 'admin', password: 'cam-secret-A', status: 'offline' },
    { id: 'c-b', userId: B, groupId: 'g-b', monitorId: MID_B, name: 'Lobby', host: '10.0.0.2', port: 554, path: '/ch1', username: 'admin', password: 'cam-secret-B', status: 'offline' },
  ];
  mockDb.users = [{ id: A, groupKey: null }, { id: B, groupKey: 'gk-b' }];
});

const asB = (extra = {}) => ({ user: { id: B, role: 'admin' }, ...extra });

describe('camera groups: another tenant\'s group id is "not found"', () => {
  test('list only queries the caller\'s own groups', async () => {
    const out = await run(ctrl.listGroups, asB());
    expect(CameraGroup.findAll.mock.calls[0][0].where).toEqual({ userId: B });
    expect(out.body.data.map((g) => g.id)).toEqual(['g-b']);
  });

  test('GET a foreign group → 404', async () => {
    const out = await run(ctrl.getGroup, asB({ params: { groupId: 'g-a' } }));
    expect(out.err.statusCode).toBe(404);
  });

  test('PUT a foreign group → 404, and nothing is written', async () => {
    const out = await run(ctrl.updateGroup, asB({ params: { groupId: 'g-a' }, body: { name: 'pwned', password: 'x' } }));
    expect(out.err.statusCode).toBe(404);
    expect(mockDb.groups[0].name).toBe('A NVR');
    expect(Camera.update).not.toHaveBeenCalled();
  });

  test('DELETE a foreign group → 404: no stream is torn down and no camera row is deleted', async () => {
    const out = await run(ctrl.deleteGroup, asB({ params: { groupId: 'g-a' } }));
    expect(out.err.statusCode).toBe(404);
    expect(streaming.removeCamera).not.toHaveBeenCalled();
    expect(streaming.removeCameraSubStream).not.toHaveBeenCalled();
    expect(Camera.destroy).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  test('DELETE own group removes exactly its own cameras\' streams', async () => {
    const out = await run(ctrl.deleteGroup, asB({ params: { groupId: 'g-b' } }));
    expect(out.body.success).toBe(true);
    expect(streaming.removeCamera.mock.calls.map((c) => c[0])).toEqual([MID_B]);
    expect(Camera.destroy).toHaveBeenCalledWith({ where: { groupId: 'g-b' } });
  });

  test('sync / reconfigure a foreign group → 404, and its cameras are not re-pushed to the media engine', async () => {
    expect((await run(ctrl.syncGroup, asB({ params: { groupId: 'g-a' } }))).err.statusCode).toBe(404);
    expect((await run(ctrl.reconfigureGroup, asB({ params: { groupId: 'g-a' } }))).err.statusCode).toBe(404);
    expect(streaming.addCamera).not.toHaveBeenCalled();
  });

  test('reconfigure response lists cameras without their credentials', async () => {
    const out = await run(ctrl.reconfigureGroup, asB({ params: { groupId: 'g-b' } }));
    expect(JSON.stringify(out.body)).not.toContain('cam-secret-B');
  });
});

describe('single cameras inside a group', () => {
  test('DELETE a foreign camera (even naming its real group) → 404, stream untouched', async () => {
    const out = await run(ctrl.deleteCameraFromGroup, asB({ params: { groupId: 'g-a', monitorId: MID_A } }));
    expect(out.err.statusCode).toBe(404);
    expect(streaming.removeCamera).not.toHaveBeenCalled();
    expect(Camera.findOne.mock.calls[0][0].where).toMatchObject({ userId: B, monitorId: MID_A, groupId: 'g-a' });
  });

  test('DELETE a foreign camera through MY group id → 404 (camera must be in that group)', async () => {
    const out = await run(ctrl.deleteCameraFromGroup, asB({ params: { groupId: 'g-b', monitorId: MID_A } }));
    expect(out.err.statusCode).toBe(404);
  });

  test('retention / quality on a foreign camera → 404 and no update', async () => {
    let out = await run(ctrl.setCameraRetention, asB({ params: { groupId: 'g-a', monitorId: MID_A }, body: { retentionDays: 1 } }));
    expect(out.err.statusCode).toBe(404);
    out = await run(ctrl.setCameraQuality, asB({ params: { groupId: 'g-a', monitorId: MID_A }, body: { streamQuality: 'sub' } }));
    expect(out.err.statusCode).toBe(404);
    expect(recordingRetention.applyRetention).not.toHaveBeenCalled();
    expect(mockDb.cameras[0].streamQuality).toBeUndefined();
  });

  test('group-level retention / quality on a foreign group → 404', async () => {
    expect((await run(ctrl.setGroupRetention, asB({ params: { groupId: 'g-a' }, body: { retentionDays: 1 } }))).err.statusCode).toBe(404);
    expect((await run(ctrl.setGroupQuality, asB({ params: { groupId: 'g-a' }, body: { streamQuality: 'sub' } }))).err.statusCode).toBe(404);
  });

  test('bulk quality only ever updates the caller\'s cameras (userId in the WHERE)', async () => {
    const out = await run(ctrl.setCamerasQualityBulk, asB({ params: { groupId: 'g-a' }, body: { monitorIds: [MID_A, MID_B], streamQuality: 'main' } }));
    expect(Camera.update.mock.calls[0][1].where).toEqual({ groupId: 'g-a', userId: B, monitorId: [MID_A, MID_B] });
    expect(out.body.count).toBe(0);
  });

  test('bulk retention with only foreign monitor ids → 404, nothing applied', async () => {
    const out = await run(ctrl.setCamerasRetentionBulk, asB({ params: { groupId: 'g-a' }, body: { monitorIds: [MID_A], retentionDays: 3 } }));
    expect(out.err.statusCode).toBe(404);
    expect(Camera.update).not.toHaveBeenCalled();
  });

  test('invalid retention / quality values are refused with 400', async () => {
    for (const bad of [0, -1, 'abc']) {
      const out = await run(ctrl.setCameraRetention, asB({ params: { groupId: 'g-b', monitorId: MID_B }, body: { retentionDays: bad } }));
      expect(out.err.statusCode).toBe(400);
    }
    const out = await run(ctrl.setCameraQuality, asB({ params: { groupId: 'g-b', monitorId: MID_B }, body: { streamQuality: '4k' } }));
    expect(out.err.statusCode).toBe(400);
  });

  test('bulk endpoints need a non-empty monitorIds array (400)', async () => {
    expect((await run(ctrl.setCamerasQualityBulk, asB({ params: { groupId: 'g-b' }, body: { monitorIds: [] } }))).err.statusCode).toBe(400);
    expect((await run(ctrl.setCamerasRetentionBulk, asB({ params: { groupId: 'g-b' }, body: { monitorIds: 'x' } }))).err.statusCode).toBe(400);
  });
});

describe('recordings: keys are authorised against the caller', () => {
  const localKeyA = `cam_${MID_A}/2026-11-25/10-00-00-000000.mp4`;

  test('listing a foreign camera\'s recordings → 404', async () => {
    expect((await run(ctrl.getCameraRecordings, asB({ params: { groupId: 'g-a', monitorId: MID_A } }))).err.statusCode).toBe(404);
    expect((await run(ctrl.getCameraRecordings, asB({ params: { groupId: 'g-b', monitorId: MID_A } }))).err.statusCode).toBe(404);
    expect((await run(ctrl.getGroupRecordings, asB({ params: { groupId: 'g-a' } }))).err.statusCode).toBe(404);
  });

  test('cloud listing is asked for the caller\'s own prefix only', async () => {
    await run(ctrl.getCameraRecordings, asB({ params: { groupId: 'g-b', monitorId: MID_B } }));
    expect(s3.listRecordings.mock.calls[0][0]).toBe(B);
  });

  test.each([
    ['play URL', 'getRecordingPlayUrl'],
    ['download URL', 'getRecordingDownloadUrl'],
    ['stream', 'streamRecording'],
    ['thumbnail', 'getThumbnailForRecording'],
  ])('%s: another tenant\'s cloud key → 403, no presigned URL', async (_l, fn) => {
    const out = await run(ctrl[fn], asB({ params: { groupId: 'g-b' }, query: { key: `recordings/${A}/A NVR/Gate/2026-11-25/x.mp4` } }));
    expect(out.err.statusCode).toBe(403);
    expect(s3.getPlaybackUrl).not.toHaveBeenCalled();
    expect(s3.getDownloadUrl).not.toHaveBeenCalled();
  });

  test.each([
    ['play URL', 'getRecordingPlayUrl'],
    ['download URL', 'getRecordingDownloadUrl'],
    ['stream', 'streamRecording'],
    ['thumbnail', 'getThumbnailForRecording'],
  ])('%s: another tenant\'s LOCAL key → 403, file never opened', async (_l, fn) => {
    const out = await run(ctrl[fn], asB({ params: { groupId: 'g-b' }, query: { key: localKeyA } }));
    expect(out.err.statusCode).toBe(403);
    expect(localRecordings.getReadStream).not.toHaveBeenCalled();
  });

  test('a cloud key that merely CONTAINS my id (not as the prefix) is refused', async () => {
    const out = await run(ctrl.getRecordingPlayUrl, asB({ query: { key: `recordings/${A}/${B}/x.mp4` } }));
    expect(out.err.statusCode).toBe(403);
    const out2 = await run(ctrl.getRecordingPlayUrl, asB({ query: { key: `recordings/${B}x/x.mp4` } }));
    expect(out2.err.statusCode).toBe(403);
  });

  test('a local key without a 24-hex monitor id is refused', async () => {
    for (const key of ['cam_/x.mp4', 'cam_../../etc/passwd', `cam_${MID_B.slice(0, 23)}/x.mp4`]) {
      const out = await run(ctrl.getRecordingPlayUrl, asB({ query: { key } }));
      expect(out.err.statusCode).toBe(403);
    }
  });

  test('a missing key is a 400', async () => {
    for (const fn of ['getRecordingPlayUrl', 'getRecordingDownloadUrl', 'streamRecording', 'getThumbnailForRecording']) {
      expect((await run(ctrl[fn], asB({ query: {} }))).err.statusCode).toBe(400);
    }
  });

  test('my own cloud key gets a presigned URL with a short (≤ 4 h default) lifetime', async () => {
    const out = await run(ctrl.getRecordingPlayUrl, asB({ query: { key: `recordings/${B}/B NVR/Lobby/2026-11-25/x.mp4` } }));
    expect(out.body.success).toBe(true);
    expect(s3.getPlaybackUrl).toHaveBeenCalledWith(`recordings/${B}/B NVR/Lobby/2026-11-25/x.mp4`, 14400);
  });

  test('my own local key gets a same-origin proxy URL, not a file path', async () => {
    const key = `cam_${MID_B}/2026-11-25/10-00-00-000000.mp4`;
    const out = await run(ctrl.getRecordingPlayUrl, asB({ params: { groupId: 'g-b' }, query: { key } }));
    expect(out.body.playbackUrl).toBe(`/api/groups/g-b/recordings/stream?key=${encodeURIComponent(key)}`);
  });

  test('download filename is sanitised: no path separators or quotes reach Content-Disposition', async () => {
    const out = await run(ctrl.getRecordingDownloadUrl, asB({ query: { key: `recordings/${B}/x/y.mp4`, name: '../../evil"name\\:*.mp4' } }));
    expect(out.body.filename).not.toMatch(/[/\\"*:]/);
    expect(out.body.filename).toMatch(/\.mp4$/);
  });

  test('export of a foreign group → 404; a camera not in my group → 404', async () => {
    const now = Date.now();
    expect((await run(ctrl.exportRecordingRange, asB({ params: { groupId: 'g-a' }, query: { monitorId: MID_A, start: now - 60000, end: now } }))).err.statusCode).toBe(404);
    expect((await run(ctrl.exportRecordingRange, asB({ params: { groupId: 'g-b' }, query: { monitorId: MID_A, start: now - 60000, end: now } }))).err.statusCode).toBe(404);
  });
});

describe('legacy /api/shinobi cameras', () => {
  test('GET one camera of another tenant → 404', async () => {
    const out = await run(shinobi.getCamera, asB({ params: { monitorId: MID_A } }));
    expect(out.err.statusCode).toBe(404);
  });

  test('the list holds only the caller\'s cameras and never their RTSP username/password', async () => {
    const out = await run(shinobi.getCameras, asB());
    expect(out.body.map((c) => c.mid)).toEqual([MID_B]);
    for (const c of out.body) {
      expect(c).not.toHaveProperty('password');
      expect(c).not.toHaveProperty('username');
    }
    expect(JSON.stringify(out.body)).not.toContain('cam-secret');
  });

  test('a single camera response never carries its credentials', async () => {
    const out = await run(shinobi.getCamera, asB({ params: { monitorId: MID_B } }));
    expect(out.body.mid).toBe(MID_B);
    expect(JSON.stringify(out.body)).not.toContain('cam-secret');
  });

  test('a user with a group key must present the matching one (403 otherwise)', async () => {
    const out = await run(shinobi.getCameras, asB({ query: { groupKey: 'someone-elses' } }));
    expect(out.err.statusCode).toBe(403);
  });

  test('a token for a user that no longer exists → 404', async () => {
    const out = await run(shinobi.getCameras, { user: { id: 'ghost' }, query: {} });
    expect(out.err.statusCode).toBe(404);
  });

  test('DELETE scopes the DB delete to the caller', async () => {
    await run(shinobi.deleteCamera, asB({ params: { monitorId: MID_A } }));
    expect(Camera.destroy).toHaveBeenCalledWith({ where: { userId: B, monitorId: MID_A } });
    expect(bus.emit).not.toHaveBeenCalled();
  });

  test('PUT scopes the DB update to the caller', async () => {
    await run(shinobi.updateCamera, asB({ params: { monitorId: MID_B }, body: { name: 'New' } }));
    expect(Camera.update.mock.calls[0][1]).toEqual({ where: { userId: B, monitorId: MID_B } });
  });
});
