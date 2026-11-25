// Core access control: role guard (authorize), platform-operator guard
// (adminAuth), capability guard (requireCapability) and the role→capability
// table they rely on. Every deny test asserts the exact status AND that the
// request never reached the handler (next() without an error).

const mockFindByPk = jest.fn();
jest.mock('../src/models', () => ({
  User: { findByPk: (...a) => mockFindByPk(...a) },
  Role: {},
}));

const { runMw } = require('./helpers/mw');
const authorize = require('../src/middleware/authorize');
const adminAuth = require('../src/middleware/adminAuth');
const requireCapability = require('../src/middleware/requireCapability');
const {
  ROLES, CAPABILITIES, ROLE_CAPABILITIES, ASSIGNABLE_ROLES, roleCan, resolveCapabilities, userCan,
} = require('../src/utils/constants');

const C = CAPABILITIES;

describe('authorize(...roles)', () => {
  test('a request with no signed-in user is refused with 401 and never reaches the handler', async () => {
    const out = await runMw(authorize('admin'), {});
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(401);
  });

  test('a user whose role is not in the allowed list is refused with 403', async () => {
    const out = await runMw(authorize('admin'), { user: { id: 'u1', role: 'viewer' } });
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(403);
  });

  test('a user whose role is in the allowed list passes', async () => {
    const out = await runMw(authorize('admin', 'manager'), { user: { id: 'u1', role: 'manager' } });
    expect(out.passed).toBe(true);
  });

  test('a missing role is refused, never treated as allowed', async () => {
    const out = await runMw(authorize('admin'), { user: { id: 'u1' } });
    expect(out.err.statusCode).toBe(403);
  });

  test('role matching is exact: "Admin" (wrong case) is not "admin"', async () => {
    const out = await runMw(authorize('admin'), { user: { id: 'u1', role: 'Admin' } });
    expect(out.err.statusCode).toBe(403);
  });

  test('authorize() with no roles allows nobody', async () => {
    const out = await runMw(authorize(), { user: { id: 'u1', role: 'admin' } });
    expect(out.err.statusCode).toBe(403);
  });
});

describe('adminAuth (platform operator only)', () => {
  test('a customer account owner (role admin) without the operator claim is refused with 403', async () => {
    const out = await runMw(adminAuth, { user: { id: 'u1', role: 'admin' } });
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(403);
    expect(out.err.message).toMatch(/platform operator/i);
  });

  test('isPlatformAdmin:false is refused', async () => {
    const out = await runMw(adminAuth, { user: { id: 'u1', role: 'admin', isPlatformAdmin: false } });
    expect(out.err.statusCode).toBe(403);
  });

  test('any falsy operator claim (0, empty, null, missing) is refused', async () => {
    for (const v of [0, '', null, undefined]) {
      const out = await runMw(adminAuth, { user: { id: 'u1', isPlatformAdmin: v } });
      expect(out.err.statusCode).toBe(403);
    }
  });

  test('no user at all is refused with 403', async () => {
    const out = await runMw(adminAuth, {});
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(403);
  });

  test('a body or header claiming operator status is ignored: only req.user counts', async () => {
    const out = await runMw(adminAuth, {
      user: { id: 'u1', role: 'admin' },
      body: { isPlatformAdmin: true },
      headers: { 'x-platform-admin': 'true' },
      query: { isPlatformAdmin: 'true' },
    });
    expect(out.err.statusCode).toBe(403);
  });

  test('a token carrying isPlatformAdmin:true passes', async () => {
    const out = await runMw(adminAuth, { user: { id: 'ops', role: 'admin', isPlatformAdmin: true } });
    expect(out.passed).toBe(true);
  });

  test('the operator claim comes from the token minted by auth.service, which sets it only from the DB flag', () => {
    const jwt = require('jsonwebtoken');
    jest.isolateModules(() => {
      jest.doMock('../src/models', () => ({ RefreshToken: { create: jest.fn() } }));
      const authService = require('../src/services/auth.service');
      const plain = jwt.decode(authService.generateAccessToken({ id: 'u1', email: 'a@b.c', role: 'admin' }));
      expect(plain.isPlatformAdmin).toBe(false);
      const truthyNotTrue = jwt.decode(authService.generateAccessToken({ id: 'u1', role: 'admin', isPlatformAdmin: 'yes' }));
      expect(truthyNotTrue.isPlatformAdmin).toBe(false);
      const ops = jwt.decode(authService.generateAccessToken({ id: 'u1', role: 'admin', isPlatformAdmin: true }));
      expect(ops.isPlatformAdmin).toBe(true);
    });
  });
});

describe('role → capability table', () => {
  test('admin and the legacy "user" role have every capability', () => {
    for (const cap of Object.values(C)) {
      expect(roleCan(ROLES.ADMIN, cap)).toBe(true);
      expect(roleCan(ROLES.USER, cap)).toBe(true);
    }
  });

  test('manager can manage cameras and use AI but cannot manage users or billing/settings', () => {
    expect(roleCan('manager', C.MANAGE_CAMERAS)).toBe(true);
    expect(roleCan('manager', C.USE_AI)).toBe(true);
    expect(roleCan('manager', C.MANAGE_USERS)).toBe(false);
    expect(roleCan('manager', C.MANAGE_SETTINGS)).toBe(false);
  });

  test('operator can watch, play back and acknowledge alerts, nothing more', () => {
    expect([...ROLE_CAPABILITIES.operator].sort()).toEqual([C.ACK_ALERTS, C.VIEW_LIVE, C.VIEW_PLAYBACK].sort());
  });

  test('viewer is read-only: live and playback only', () => {
    expect([...ROLE_CAPABILITIES.viewer].sort()).toEqual([C.VIEW_LIVE, C.VIEW_PLAYBACK].sort());
    expect(roleCan('viewer', C.ACK_ALERTS)).toBe(false);
  });

  test('an unknown role has no capabilities at all', () => {
    expect(resolveCapabilities({ role: 'superuser' })).toEqual([]);
    expect(resolveCapabilities(null)).toEqual([]);
    expect(roleCan('root', C.VIEW_LIVE)).toBe(false);
  });

  test('the legacy "user" role cannot be handed out through Manage Users', () => {
    expect(ASSIGNABLE_ROLES).not.toContain('user');
    expect(ASSIGNABLE_ROLES).toEqual(expect.arrayContaining(['admin', 'manager', 'operator', 'viewer']));
  });

  test('a custom role overrides the built-in tier, in both directions', () => {
    expect(userCan({ role: 'admin', customRole: { capabilities: [C.VIEW_LIVE] } }, C.MANAGE_USERS)).toBe(false);
    expect(userCan({ role: 'viewer', customRole: { capabilities: [C.MANAGE_CAMERAS] } }, C.MANAGE_CAMERAS)).toBe(true);
  });

  test('a custom role without a capabilities array falls back to the built-in tier', () => {
    expect(userCan({ role: 'viewer', customRole: { capabilities: null } }, C.MANAGE_USERS)).toBe(false);
    expect(userCan({ role: 'admin', customRole: {} }, C.MANAGE_USERS)).toBe(true);
  });
});

describe('requireCapability(capability)', () => {
  const mw = requireCapability(C.MANAGE_USERS);

  test('loads the FRESH user by the token id (not the JWT role) before deciding', async () => {
    mockFindByPk.mockResolvedValue({ id: 'u1', role: 'viewer', isActive: true });
    // the token still says admin, the database says viewer: database wins
    const out = await runMw(mw, { user: { id: 'u1', role: 'admin' } });
    expect(mockFindByPk).toHaveBeenCalledWith('u1', expect.any(Object));
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(403);
  });

  test('a user that no longer exists is refused with 401', async () => {
    mockFindByPk.mockResolvedValue(null);
    const out = await runMw(mw, { user: { id: 'gone', role: 'admin' } });
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(401);
  });

  test('a deactivated user is refused with 403 even when their role has the capability', async () => {
    mockFindByPk.mockResolvedValue({ id: 'u1', role: 'admin', isActive: false });
    const out = await runMw(mw, { user: { id: 'u1', role: 'admin' } });
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(403);
    expect(out.err.message).toMatch(/deactivated/i);
  });

  test('an active user with the capability passes and req.dbUser is the fresh record', async () => {
    const dbUser = { id: 'u1', role: 'admin', isActive: true };
    mockFindByPk.mockResolvedValue(dbUser);
    const out = await runMw(mw, { user: { id: 'u1', role: 'viewer' } });
    expect(out.passed).toBe(true);
    expect(out.req.dbUser).toBe(dbUser);
  });

  test('a custom role that removes the capability is refused', async () => {
    mockFindByPk.mockResolvedValue({ id: 'u1', role: 'admin', isActive: true, customRole: { capabilities: [C.VIEW_LIVE] } });
    const out = await runMw(mw, { user: { id: 'u1' } });
    expect(out.err.statusCode).toBe(403);
  });

  test('a custom role that grants the capability passes', async () => {
    mockFindByPk.mockResolvedValue({ id: 'u1', role: 'viewer', isActive: true, customRole: { capabilities: [C.MANAGE_USERS] } });
    const out = await runMw(mw, { user: { id: 'u1' } });
    expect(out.passed).toBe(true);
  });

  test('a database error is passed on as an error, never as an allow', async () => {
    mockFindByPk.mockRejectedValue(new Error('db down'));
    const out = await runMw(mw, { user: { id: 'u1' } });
    expect(out.passed).toBe(false);
    expect(out.err.message).toBe('db down');
  });
});
