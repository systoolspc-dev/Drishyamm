// entitlements.service: what one customer account may use, resolved to the
// ACCOUNT OWNER, from the owner's live (active/trialing) subscription. Plus the
// two route gates built on it (requireFeature, requireAiCapability).
//
// The Subscription/User fakes below honour the `where` the service sends, so a
// change in the query (e.g. dropping the status filter) breaks these tests.

const mockDb = { users: [], subs: [], cameras: [], zones: [] };
const mockCalls = { subFindOne: 0, userFindByPk: 0 };

jest.mock('../src/models', () => {
  const { Op: SOp } = require('sequelize');
  const inOrEq = (cond, v) => (cond && typeof cond === 'object' && cond[SOp.in] ? cond[SOp.in].includes(v) : cond === v);
  return {
    User: {
      findByPk: async (id) => { mockCalls.userFindByPk += 1; return mockDb.users.find((u) => u.id === id) || null; },
      findAll: async ({ where }) => mockDb.users.filter((u) => u.parentUserId === where.parentUserId),
    },
    Subscription: {
      findOne: async ({ where }) => {
        mockCalls.subFindOne += 1;
        const rows = mockDb.subs
          .filter((s) => s.userId === where.userId && inOrEq(where.status, s.status))
          .sort((a, b) => b.createdAt - a.createdAt);
        return rows[0] || null;
      },
      findAll: async ({ where, include }) => mockDb.subs.filter((s) => inOrEq(where.status, s.status)
        && (!include?.[0]?.where?.aiEnabled || s.plan?.aiEnabled === true)),
    },
    Plan: {},
    Camera: { findAll: async ({ where }) => mockDb.cameras.filter((c) => where.userId[SOp.in].includes(c.userId)) },
    RestrictedZone: {
      findAll: async ({ where }) => mockDb.zones.filter((z) => where.userId[SOp.in].includes(z.userId) && z.enabled === where.enabled),
    },
  };
});

const ent = require('../src/services/entitlements.service');
const requireFeature = require('../src/middleware/requireFeature');
const requireAiCapability = require('../src/middleware/requireAiCapability');
const { OPT_IN_KEYS, DEMO_KEYS } = require('../src/utils/featureCatalog');
const { runMw } = require('./helpers/mw');

const AI_PLAN = { aiEnabled: true, name: 'AI+VMS' };
const BASIC_PLAN = { aiEnabled: false, name: 'Basic VMS' };
const sub = (userId, over = {}) => ({ userId, status: 'active', plan: AI_PLAN, features: null, featureLimits: {}, createdAt: 1, ...over });

beforeEach(() => {
  mockDb.users = [
    { id: 'owner', parentUserId: null },
    { id: 'member', parentUserId: 'owner' },
    { id: 'basic-owner', parentUserId: null },
    { id: 'nosub', parentUserId: null },
  ];
  mockDb.subs = [];
  mockDb.cameras = [];
  mockDb.zones = [];
  mockCalls.subFindOne = 0;
  mockCalls.userFindByPk = 0;
  ent.clearEntitlementCache();
  jest.useRealTimers();
});

describe('resolving the account owner', () => {
  test('a sub-user resolves to its parent; an owner to itself', async () => {
    expect(await ent.resolveOwnerId('member')).toBe('owner');
    expect(await ent.resolveOwnerId('owner')).toBe('owner');
  });

  test('an unknown user id resolves to itself (it then has no subscription → nothing)', async () => {
    expect(await ent.resolveOwnerId('ghost')).toBe('ghost');
  });

  test('a sub-user inherits the PARENT\'s plan and features, not an empty account of its own', async () => {
    mockDb.subs = [sub('owner', { features: ['headcount'] })];
    const e = await ent.getEntitlements('member');
    expect(e.ownerId).toBe('owner');
    expect(e.aiEnabled).toBe(true);
    expect(e.features).toEqual(['headcount']);
    expect(e.hasSubscription).toBe(true);
  });

  test('accountUserIds lists the owner and every sub-user', async () => {
    expect(await ent.accountUserIds('owner')).toEqual(['owner', 'member']);
  });
});

describe('subscription state', () => {
  test.each(['active', 'trialing'])('a %s subscription counts', async (status) => {
    mockDb.subs = [sub('owner', { status })];
    expect((await ent.getEntitlements('owner')).hasSubscription).toBe(true);
    expect(await ent.getAiEntitlement('owner')).toBe(true);
  });

  test.each(['expired', 'cancelled', 'past_due'])('a %s subscription grants nothing (no AI, hasSubscription false)', async (status) => {
    mockDb.subs = [sub('owner', { status })];
    const e = await ent.getEntitlements('owner');
    expect(e.hasSubscription).toBe(false);
    expect(e.aiEnabled).toBe(false);
    expect(e.featureLimits).toEqual({});
  });

  test('the most recent live subscription wins over an older one', async () => {
    mockDb.subs = [
      sub('owner', { plan: AI_PLAN, createdAt: 1 }),
      sub('owner', { plan: BASIC_PLAN, createdAt: 2 }),
    ];
    expect(await ent.getAiEntitlement('owner')).toBe(false);
  });

  test('an expired AI subscription does not shadow a live Basic one', async () => {
    mockDb.subs = [
      sub('owner', { plan: AI_PLAN, status: 'expired', createdAt: 5 }),
      sub('owner', { plan: BASIC_PLAN, status: 'active', createdAt: 1 }),
    ];
    const e = await ent.getEntitlements('owner');
    expect(e.hasSubscription).toBe(true);
    expect(e.aiEnabled).toBe(false);
  });

  test('aiEnabled must be exactly true on the plan (truthy strings do not count)', async () => {
    mockDb.subs = [sub('owner', { plan: { aiEnabled: 'true' } })];
    expect(await ent.getAiEntitlement('owner')).toBe(false);
  });

  test('a subscription with no plan row has no AI', async () => {
    mockDb.subs = [sub('owner', { plan: null })];
    expect(await ent.getAiEntitlement('owner')).toBe(false);
  });
});

describe('features value', () => {
  test('NULL and [] both mean a full account (features null)', async () => {
    mockDb.subs = [sub('owner', { features: [] })];
    expect((await ent.getEntitlements('owner')).features).toBeNull();
    ent.clearEntitlementCache();
    mockDb.subs = [sub('owner', { features: null })];
    expect((await ent.getEntitlements('owner')).features).toBeNull();
  });

  test('a non-array features value is treated as a full account, not a crash', async () => {
    mockDb.subs = [sub('owner', { features: 'headcount' })];
    expect((await ent.getEntitlements('owner')).features).toBeNull();
  });

  test('a non-object featureLimits is replaced by {}', async () => {
    mockDb.subs = [sub('owner', { featureLimits: 'garbage' })];
    expect((await ent.getEntitlements('owner')).featureLimits).toEqual({});
  });
});

describe('cache', () => {
  test('a second lookup within 5 s does not hit the database again', async () => {
    mockDb.subs = [sub('owner')];
    await ent.getEntitlements('owner');
    await ent.getEntitlements('owner');
    expect(mockCalls.subFindOne).toBe(1);
  });

  test('clearEntitlementCache makes an admin change take effect at once', async () => {
    mockDb.subs = [sub('owner', { plan: AI_PLAN })];
    expect(await ent.getAiEntitlement('owner')).toBe(true);
    mockDb.subs = [sub('owner', { plan: BASIC_PLAN })];
    expect(await ent.getAiEntitlement('owner')).toBe(true); // still cached
    ent.clearEntitlementCache();
    expect(await ent.getAiEntitlement('owner')).toBe(false);
  });

  test('the cache expires after 5 s on its own', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockDb.subs = [sub('owner', { plan: AI_PLAN })];
    expect(await ent.getAiEntitlement('owner')).toBe(true);
    mockDb.subs = [sub('owner', { plan: BASIC_PLAN })];
    jest.setSystemTime(1_000_000 + 4999);
    expect(await ent.getAiEntitlement('owner')).toBe(true);
    jest.setSystemTime(1_000_000 + 5001);
    expect(await ent.getAiEntitlement('owner')).toBe(false);
  });

  test('the cache is per user: one account\'s answer never leaks into another', async () => {
    mockDb.subs = [sub('owner', { plan: AI_PLAN }), sub('basic-owner', { plan: BASIC_PLAN })];
    expect(await ent.getAiEntitlement('owner')).toBe(true);
    expect(await ent.getAiEntitlement('basic-owner')).toBe(false);
  });
});

describe('assertAiEntitled / assertFeature', () => {
  test('a Basic plan is refused AI with 403 and an upgrade message', async () => {
    mockDb.subs = [sub('basic-owner', { plan: BASIC_PLAN })];
    await expect(ent.assertAiEntitled('basic-owner')).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/Upgrade to AI\+VMS/) });
  });

  test('no subscription at all is refused AI', async () => {
    await expect(ent.assertAiEntitled('nosub')).rejects.toMatchObject({ statusCode: 403 });
  });

  test('an AI plan passes assertAiEntitled', async () => {
    mockDb.subs = [sub('owner')];
    await expect(ent.assertAiEntitled('owner')).resolves.toBeUndefined();
  });

  test('an AI key on a Basic plan gets the upgrade message, not "ask your administrator"', async () => {
    mockDb.subs = [sub('basic-owner', { plan: BASIC_PLAN })];
    await expect(ent.assertFeature('basic-owner', ['headcount'])).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/Upgrade/) });
  });

  test('a key switched off on a curated list is refused with its label in the message', async () => {
    mockDb.subs = [sub('owner', { features: ['headcount'] })];
    await expect(ent.assertFeature('owner', ['reports'])).rejects.toMatchObject({
      statusCode: 403, message: expect.stringMatching(/^Reports is not enabled for this account/),
    });
  });

  test('a mixed list passes when any one key is on', async () => {
    mockDb.subs = [sub('basic-owner', { plan: BASIC_PLAN, features: ['reports'] })];
    const e = await ent.assertFeature('basic-owner', ['headcount', 'reports']);
    expect(e.ownerId).toBe('basic-owner');
  });

  test('opt-in keys are off for a FULL account until they are listed', async () => {
    mockDb.subs = [sub('owner', { features: null })];
    for (const k of OPT_IN_KEYS) {
      await expect(ent.assertFeature('owner', [k])).rejects.toMatchObject({ statusCode: 403 });
    }
    ent.clearEntitlementCache();
    mockDb.subs = [sub('owner', { features: [...OPT_IN_KEYS] })];
    for (const k of OPT_IN_KEYS) await expect(ent.assertFeature('owner', [k])).resolves.toBeTruthy();
  });

  test('demo keys are off for a full account until listed', async () => {
    mockDb.subs = [sub('owner', { features: null })];
    for (const k of DEMO_KEYS) {
      await expect(ent.assertFeature('owner', [k])).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  test('a listed AI opt-in key is still refused on a Basic plan', async () => {
    mockDb.subs = [sub('basic-owner', { plan: BASIC_PLAN, features: ['investigate_search'] })];
    await expect(ent.assertFeature('basic-owner', ['investigate_search'])).rejects.toMatchObject({ statusCode: 403 });
  });

  test('a non-AI opt-in key (Cases) needs only to be listed, not the AI tier', async () => {
    mockDb.subs = [sub('basic-owner', { plan: BASIC_PLAN, features: ['investigate_cases'] })];
    await expect(ent.assertFeature('basic-owner', ['investigate_cases'])).resolves.toBeTruthy();
  });

  test('a sub-user is gated by the parent account\'s switches', async () => {
    mockDb.subs = [sub('owner', { features: ['!playback', 'headcount'] })];
    await expect(ent.assertFeature('member', ['playback'])).rejects.toMatchObject({ statusCode: 403 });
    await expect(ent.assertFeature('member', ['headcount'])).resolves.toBeTruthy();
  });
});

describe('requireFeature / requireAiCapability middleware', () => {
  test('requireFeature lets an allowed key through to the handler', async () => {
    mockDb.subs = [sub('owner')];
    const out = await runMw(requireFeature('headcount'), { user: { id: 'owner' } });
    expect(out.passed).toBe(true);
  });

  test('requireFeature refuses a switched-off key with 403 and never calls the handler', async () => {
    mockDb.subs = [sub('owner', { features: ['headcount'] })];
    const out = await runMw(requireFeature('map'), { user: { id: 'owner' } });
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(403);
  });

  test('requireFeature with several keys passes when ANY is on', async () => {
    mockDb.subs = [sub('owner', { features: ['restricted_zone', '!playback'] })];
    const out = await runMw(requireFeature('playback', 'restricted_zone'), { user: { id: 'owner' } });
    expect(out.passed).toBe(true);
  });

  test('requireFeature reads the account from req.user.id only (a body userId cannot borrow another account)', async () => {
    mockDb.subs = [sub('owner'), sub('basic-owner', { plan: BASIC_PLAN })];
    const out = await runMw(requireFeature('headcount'), { user: { id: 'basic-owner' }, body: { userId: 'owner' }, query: { userId: 'owner' } });
    expect(out.err.statusCode).toBe(403);
  });

  test('requireAiCapability refuses a Basic account with 403', async () => {
    mockDb.subs = [sub('basic-owner', { plan: BASIC_PLAN })];
    const out = await runMw(requireAiCapability, { user: { id: 'basic-owner' } });
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(403);
  });

  test('requireAiCapability refuses an account whose AI subscription has expired', async () => {
    mockDb.subs = [sub('owner', { status: 'expired' })];
    const out = await runMw(requireAiCapability, { user: { id: 'owner' } });
    expect(out.err.statusCode).toBe(403);
  });

  test('requireAiCapability lets an AI account (and its sub-user) through', async () => {
    mockDb.subs = [sub('owner')];
    expect((await runMw(requireAiCapability, { user: { id: 'owner' } })).passed).toBe(true);
    expect((await runMw(requireAiCapability, { user: { id: 'member' } })).passed).toBe(true);
  });
});

describe('assertAiLicence (per-camera AI caps)', () => {
  const faceCam = (id, userId) => ({ id, userId, monitorId: `m-${id}`, settings: { ai: { enabled: true } } });

  test('no cap set means no limit', async () => {
    mockDb.subs = [sub('owner', { featureLimits: {} })];
    mockDb.cameras = [faceCam('c1', 'owner'), faceCam('c2', 'owner')];
    await expect(ent.assertAiLicence('owner', 'face', 5)).resolves.toBeUndefined();
  });

  test('switching on beyond the cap is refused with 403 and the counts', async () => {
    mockDb.subs = [sub('owner', { featureLimits: { face: 2 } })];
    mockDb.cameras = [faceCam('c1', 'owner'), faceCam('c2', 'member')];
    await expect(ent.assertAiLicence('owner', 'face', 1)).rejects.toMatchObject({
      statusCode: 403, message: expect.stringMatching(/licensed for 2 cameras \(2 in use, 0 remaining\)/),
    });
  });

  test('cameras of sub-users count against the account\'s cap', async () => {
    mockDb.subs = [sub('owner', { featureLimits: { face: 1 } })];
    mockDb.cameras = [faceCam('c2', 'member')];
    await expect(ent.assertAiLicence('member', 'face', 1)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('another account\'s cameras never count against this cap', async () => {
    mockDb.subs = [sub('owner', { featureLimits: { face: 1 } })];
    mockDb.cameras = [faceCam('x1', 'basic-owner'), faceCam('x2', 'nosub')];
    await expect(ent.assertAiLicence('owner', 'face', 1)).resolves.toBeUndefined();
  });

  test('a camera with face recognition switched off does not hold a face licence', async () => {
    mockDb.subs = [sub('owner', { featureLimits: { face: 1 } })];
    mockDb.cameras = [{ id: 'c1', userId: 'owner', settings: { ai: { enabled: true, faceRecognition: false } } }];
    await expect(ent.assertAiLicence('owner', 'face', 1)).resolves.toBeUndefined();
  });

  test('a cap of 0 refuses the first camera', async () => {
    mockDb.subs = [sub('owner', { featureLimits: { headcount: 0 } })];
    await expect(ent.assertAiLicence('owner', 'headcount', 1)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('the licence also needs the feature itself: a Basic plan is refused before counting', async () => {
    mockDb.subs = [sub('basic-owner', { plan: BASIC_PLAN, featureLimits: { face: 100 } })];
    await expect(ent.assertAiLicence('basic-owner', 'face', 1)).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/Upgrade/) });
  });

  test('switching OFF (adding <= 0) and unknown licence keys are always allowed', async () => {
    await expect(ent.assertAiLicence('nosub', 'face', 0)).resolves.toBeUndefined();
    await expect(ent.assertAiLicence('nosub', 'not-a-licence', 1)).resolves.toBeUndefined();
  });

  test('restricted-zone usage counts only cameras that still exist and have an ARMED zone', async () => {
    mockDb.subs = [sub('owner', { featureLimits: { restricted_zone: 1 } })];
    mockDb.cameras = [{ id: 'c1', userId: 'owner', monitorId: 'm1', settings: {} }];
    mockDb.zones = [
      { userId: 'owner', monitorId: 'gone', enabled: true }, // camera deleted
      { userId: 'owner', monitorId: 'm1', enabled: false }, // disarmed
    ];
    await expect(ent.assertAiLicence('owner', 'restricted_zone', 1)).resolves.toBeUndefined();
    mockDb.zones.push({ userId: 'owner', monitorId: 'm1', enabled: true });
    await expect(ent.assertAiLicence('owner', 'restricted_zone', 1)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('getAiEntitledUserIds (reconcile loop that stops AI for downgraded accounts)', () => {
  test('includes AI accounts with a face-engine feature or a full list; excludes Basic, expired and face-less lists', async () => {
    mockDb.subs = [
      sub('full', { features: null }),
      sub('face', { features: ['person_search'] }),
      sub('countonly', { features: ['headcount'] }),
      sub('basic', { plan: BASIC_PLAN }),
      sub('lapsed', { status: 'expired' }),
      sub('trial', { status: 'trialing', features: [] }),
    ];
    const ids = await ent.getAiEntitledUserIds();
    expect([...ids].sort()).toEqual(['face', 'full', 'trial']);
  });
});

