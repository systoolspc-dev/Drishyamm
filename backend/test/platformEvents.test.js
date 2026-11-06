// Platform activity: camera-status coalescing, failed sign-in bursts, the
// operator-only socket room, and the event catalog.
const mockCreate = jest.fn();
const mockFindByPk = jest.fn();
const mockCamFindAll = jest.fn();
const mockGroupFindAll = jest.fn();
jest.mock('../src/models', () => ({
  PlatformEvent: { create: (...a) => mockCreate(...a) },
  User: { findByPk: (...a) => mockFindByPk(...a) },
  Camera: { findAll: (...a) => mockCamFindAll(...a) },
  CameraGroup: { findAll: (...a) => mockGroupFindAll(...a) },
}));
const mockChecks = { db: { ok: true }, redis: { ok: true }, mtx: [{ ok: true }], ai: { ok: true } };
jest.mock('../src/controllers/health.controller', () => ({
  checks: {
    checkDb: async () => mockChecks.db,
    checkRedis: async () => mockChecks.redis,
    checkStreamServers: async () => mockChecks.mtx,
    checkAiService: async () => mockChecks.ai,
  },
}));
const mockToOps = jest.fn();
jest.mock('../src/services/ws.service', () => ({ toOps: (...a) => mockToOps(...a), opsCount: () => 0 }));

const { createCameraStatusCoalescer } = require('../src/services/platformEvents/cameraStatusCoalescer');
const { CATEGORIES, TYPE_CATEGORY, ALL_TYPES, hostOf, nameList } = require('../src/services/platformEvents/catalog');
const platformEvents = require('../src/services/platformEvents.service');

/** A coalescer on a fake clock with manual timers. */
function rig(opts = {}) {
  let t = 1_000_000;
  const timers = [];
  const batches = [];
  const c = createCameraStatusCoalescer({
    onBatch: (b) => batches.push(b),
    bootGraceMs: 0,
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, done: false }; timers.push(h); return h; },
    clearTimer: (h) => { h.done = true; },
    ...opts,
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((h) => !h.done && h.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at;
      due.done = true;
      due.fn();
    }
    t = end;
  };
  return { c, batches, advance, now: () => t };
}

describe('camera status coalescer', () => {
  test('20 transitions of one camera in 10 s → one event', () => {
    const { c, batches, advance } = rig();
    // learn: streaming
    c.observe({ key: 'cam1', accountId: 'acc', fromState: 'pending', toState: 'streaming' });
    for (let i = 0; i < 20; i += 1) {
      const down = i % 2 === 0;
      c.observe({ key: 'cam1', accountId: 'acc', fromState: down ? 'streaming' : 'offline', toState: down ? 'offline' : 'streaming' });
      advance(500); // 20 × 0.5 s = 10 s
    }
    // ends online → same as announced → nothing to say
    advance(60_000);
    expect(batches).toHaveLength(0);

    // one more drop that sticks → exactly one batch
    c.observe({ key: 'cam1', accountId: 'acc', fromState: 'streaming', toState: 'offline' });
    advance(60_000);
    expect(batches).toHaveLength(1);
    expect(batches[0].offline.map((x) => x.key)).toEqual(['cam1']);
  });

  test('20 transitions across 5 cameras in 10 s → one batch for the account', () => {
    const { c, batches, advance } = rig();
    const cams = ['a', 'b', 'c', 'd', 'e'];
    for (const k of cams) c.observe({ key: k, accountId: 'acc', fromState: 'pending', toState: 'standby' });
    for (let i = 0; i < 20; i += 1) {
      const k = cams[i % 5];
      const down = Math.floor(i / 5) % 2 === 0; // rounds: down, up, down, up → ends… see below
      c.observe({ key: k, accountId: 'acc', fromState: down ? 'standby' : 'offline', toState: down ? 'offline' : 'standby' });
      advance(500);
    }
    // 4 rounds: down, up, down, up → net online: nothing
    advance(60_000);
    expect(batches).toHaveLength(0);

    for (const k of cams) c.observe({ key: k, accountId: 'acc', fromState: 'standby', toState: 'offline' });
    advance(60_000);
    expect(batches).toHaveLength(1);
    expect(batches[0].offline).toHaveLength(5);
    expect(batches[0].recovered).toHaveLength(0);
  });

  test('a flapping camera is announced at most once per cooldown', () => {
    const { c, batches, advance } = rig({ windowMs: 60_000, cooldownMs: 5 * 60_000 });
    c.observe({ key: 'x', accountId: 'acc', fromState: 'pending', toState: 'streaming' });
    c.observe({ key: 'x', accountId: 'acc', fromState: 'streaming', toState: 'offline' });
    advance(61_000);
    expect(batches).toHaveLength(1);                 // offline announced
    c.observe({ key: 'x', accountId: 'acc', fromState: 'offline', toState: 'streaming' });
    advance(61_000);
    expect(batches).toHaveLength(1);                 // recovery held by cooldown
    advance(4 * 60_000);
    expect(batches).toHaveLength(2);                 // released once the cooldown ends
    expect(batches[1].recovered.map((r) => r.key)).toEqual(['x']);
  });

  test('first sighting out of pending, and the boot grace, are silent', () => {
    const { c, batches, advance } = rig({ bootGraceMs: 90_000 });
    c.observe({ key: 'y', accountId: 'acc', fromState: 'pending', toState: 'offline' });
    c.observe({ key: 'y', accountId: 'acc', fromState: 'offline', toState: 'standby' }); // inside grace
    advance(120_000);
    expect(batches).toHaveLength(0);
    expect(c.stateOf('y')).toEqual({ announced: true, current: true });
  });

  test('separate accounts get separate batches', () => {
    const { c, batches, advance } = rig();
    c.observe({ key: 'p', accountId: 'A', fromState: 'streaming', toState: 'offline' });
    c.observe({ key: 'q', accountId: 'B', fromState: 'streaming', toState: 'offline' });
    advance(60_000);
    expect(batches.map((b) => b.accountId).sort()).toEqual(['A', 'B']);
  });
});

describe('failed sign-in bursts', () => {
  beforeEach(() => {
    platformEvents._internal._loginFails.clear();
    mockCreate.mockImplementation(async (row) => ({ ...row, id: 1, get: () => ({ ...row, id: 1 }) }));
  });

  test('five failures in 10 min → one warning; more failures stay quiet', async () => {
    const now = 5_000_000;
    const raised = [];
    for (let i = 0; i < 9; i += 1) {
      raised.push(platformEvents.noteLoginFailure('Who@Example.com', { req: { headers: {}, ip: '10.0.0.9' }, now: now + i * 30_000 }));
    }
    expect(raised.filter(Boolean)).toHaveLength(1);
    expect(raised.indexOf(true)).toBe(4); // the fifth
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const row = mockCreate.mock.calls[0][0];
    expect(row.type).toBe('account.login_failed');
    expect(row.severity).toBe('warning');
    expect(row.summary).toMatch(/5 failed sign-ins for who@example\.com/);
    expect(mockToOps).toHaveBeenCalledWith('platform.event', expect.objectContaining({ type: 'account.login_failed' }));
  });

  test('failures spread over more than 10 min never alert', () => {
    let any = false;
    for (let i = 0; i < 8; i += 1) any = platformEvents.noteLoginFailure('slow@example.com', { now: 9_000_000 + i * 3 * 60_000 }) || any;
    expect(any).toBe(false);
  });
});

describe('record()', () => {
  test('never throws into the caller and still pushes live when the insert fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('db down'));
    const ev = await platformEvents.record('service.down', { actor: 'system', severity: 'critical', summary: 'Database is down' });
    expect(ev).toEqual(expect.objectContaining({ type: 'service.down', severity: 'critical', category: 'system', id: null }));
    expect(mockToOps).toHaveBeenCalledWith('platform.event', expect.objectContaining({ summary: 'Database is down' }));
  });
});

describe('status batch → camera.offline / nvr.down', () => {
  const flushAll = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
  beforeEach(() => {
    platformEvents._internal._nvrDown.clear();
    mockCreate.mockImplementation(async (row) => ({ ...row, id: 7, get: () => ({ ...row, id: 7 }) }));
    mockFindByPk.mockResolvedValue({ id: 'owner', name: 'Acme', get: () => ({ id: 'owner', name: 'Acme', parentUserId: null }) });
    mockGroupFindAll.mockResolvedValue([{ id: 'g1', name: 'Office' }]);
  });

  test('some cameras of an NVR → one camera.offline warning naming the NVR', async () => {
    mockCamFindAll
      .mockResolvedValueOnce([{ monitorId: 'm1', name: 'Lobby', groupId: 'g1' }, { monitorId: 'm2', name: 'Gate', groupId: 'g1' }])
      .mockResolvedValueOnce([{ groupId: 'g1', status: 'offline' }, { groupId: 'g1', status: 'offline' }, { groupId: 'g1', status: 'online' }]);
    await platformEvents._internal.onStatusBatch({ accountId: 'owner-x', offline: [{ key: 'm1' }, { key: 'm2' }], recovered: [] });
    await flushAll();
    const types = mockCreate.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['camera.offline']);
    expect(mockCreate.mock.calls[0][0].summary).toBe('2 cameras at Office went offline');
    expect(mockCreate.mock.calls[0][0].severity).toBe('warning');
  });

  test('every camera of an NVR offline → one nvr.down (critical), and the tail is not repeated', async () => {
    const all = [{ groupId: 'g1', status: 'offline' }, { groupId: 'g1', status: 'offline' }, { groupId: 'g1', status: 'offline' }];
    mockCamFindAll
      .mockResolvedValueOnce([{ monitorId: 'm1', name: 'Lobby', groupId: 'g1' }, { monitorId: 'm2', name: 'Gate', groupId: 'g1' }])
      .mockResolvedValueOnce(all)
      .mockResolvedValueOnce([{ monitorId: 'm3', name: 'Yard', groupId: 'g1' }])
      .mockResolvedValueOnce(all);
    await platformEvents._internal.onStatusBatch({ accountId: 'owner', offline: [{ key: 'm1' }, { key: 'm2' }], recovered: [] });
    await platformEvents._internal.onStatusBatch({ accountId: 'owner', offline: [{ key: 'm3' }], recovered: [] });
    await flushAll();
    const rows = mockCreate.mock.calls.map((c) => c[0]);
    expect(rows.map((r) => r.type)).toEqual(['nvr.down']);
    expect(rows[0].severity).toBe('critical');
    expect(rows[0].summary).toBe('NVR Office is down: all 3 cameras offline');
  });
});

describe('platform services', () => {
  test('down needs two failed checks in a row; one blip says nothing; recovery is announced once', async () => {
    platformEvents._internal._svc.clear();
    mockCreate.mockImplementation(async (row) => ({ ...row, id: 9, get: () => ({ ...row, id: 9 }) }));
    const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r)); };
    const run = async () => { await platformEvents._internal.checkServices(); await flush(); };
    const types = () => mockCreate.mock.calls.map((c) => `${c[0].type}:${c[0].data.service}`);

    await run();                                   // all up: silent
    mockChecks.ai = { ok: false, error: 'ECONNREFUSED' };
    await run();                                   // one failure: still silent
    mockChecks.ai = { ok: true };
    await run();                                   // blip over
    expect(types()).toEqual([]);

    mockChecks.ai = { ok: false, error: 'ECONNREFUSED' };
    await run(); await run(); await run();         // 3 failures → one service.down
    expect(types()).toEqual(['service.down:ai']);
    expect(mockCreate.mock.calls[0][0].summary).toBe('AI engine is down');
    mockChecks.ai = { ok: true };
    await run(); await run();
    expect(types()).toEqual(['service.down:ai', 'service.up:ai']);

    mockChecks.redis = { ok: false, error: 'redis not configured' };
    await run(); await run();                      // not configured is not an outage
    expect(types()).toHaveLength(2);
    mockChecks.redis = { ok: true };
  });
});

describe('catalog', () => {
  test('every type has exactly one category', () => {
    const all = Object.values(CATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...ALL_TYPES].sort()).toEqual([...all].sort());
    expect(TYPE_CATEGORY['account.created']).toBe('signups');
    expect(TYPE_CATEGORY['nvr.down']).toBe('cameras');
  });
  test('helpers', () => {
    expect(hostOf('https://app.drishyam.ai/register?x=1')).toBe('app.drishyam.ai');
    expect(nameList(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
    expect(nameList(['A', 'B'])).toBe('A and B');
  });
});

// socket.io-client is a frontend dependency; when this package does not have
// it the test is reported as skipped (the live script covers it end to end).
let hasClient = true;
try { require('socket.io-client'); } catch { hasClient = false; }

describe('operator socket room', () => {
  (hasClient ? test : test.skip)('a customer token is refused from platform-ops; an operator joins', async () => {
    jest.resetModules();
    const jwt = require('jsonwebtoken');
    const config = require('../src/config/env');
    const mockUser = mockFindByPk; // the file-level models mock
    jest.doMock('../src/services/accountStatus.service', () => ({ isBlocked: () => false }));
    jest.doMock('../src/services/platformEvents.service', () => ({ computeCounters: async () => ({ accounts: 3 }) }));
    const http = require('node:http');
    const ws = jest.requireActual('../src/services/ws.service');
    const server = http.createServer();
    ws.init(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const ioClient = require('socket.io-client');
    const connect = (claims) => new Promise((resolve) => {
      const s = ioClient.io(`http://127.0.0.1:${port}`, { path: '/socket.io', transports: ['websocket'], auth: { token: jwt.sign(claims, config.jwt.secret) }, forceNew: true });
      const counters = [];
      s.on('platform.counters', (c) => counters.push(c));
      s.on('connect', () => s.emit('ops.join', {}, (ack) => resolve({ s, ack, counters })));
    });
    // A customer token is refused on its claim alone (no DB lookup needed).
    const cust = await connect({ id: 'cust', role: 'admin', isPlatformAdmin: false });
    expect(cust.ack.ok).toBe(false);
    expect(mockUser).not.toHaveBeenCalled();
    mockUser.mockResolvedValueOnce({ id: 'op', isPlatformAdmin: true, isActive: true });
    const op = await connect({ id: 'op', role: 'admin', isPlatformAdmin: true });
    expect(op.ack).toEqual({ ok: true });
    // forged claim: token says operator, DB says not
    mockUser.mockResolvedValueOnce({ id: 'demoted', isPlatformAdmin: false, isActive: true });
    const forged = await connect({ id: 'demoted', role: 'admin', isPlatformAdmin: true });
    expect(forged.ack.ok).toBe(false);

    const got = { cust: 0, op: 0 };
    cust.s.on('platform.event', () => { got.cust += 1; });
    op.s.on('platform.event', () => { got.op += 1; });
    ws.toOps('platform.event', { type: 'account.created' });
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual({ cust: 0, op: 1 });
    expect(op.counters).toEqual([{ accounts: 3 }]);   // pushed once on join
    expect(cust.counters).toEqual([]);
    expect(ws.opsCount()).toBe(1);
    for (const x of [cust, op, forged]) x.s.close();
    await new Promise((r) => server.close(r));
  });
});
