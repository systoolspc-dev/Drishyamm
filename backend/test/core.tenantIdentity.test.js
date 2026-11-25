// Multi-tenant identity towards the AI service and the investigation toolkit:
//   - aiTenant: the AI tenant is the ORGANISATION (parent account), derived
//     only from the signed-in user, minted into a short-lived HS256 JWT;
//   - withAccount: a sub-user acts inside their parent organisation.

const mockFindByPk = jest.fn();
jest.mock('../src/models', () => ({ User: { findByPk: (...a) => mockFindByPk(...a) } }));

const jwt = require('jsonwebtoken');
const { v5: uuidv5, validate: uuidValidate, version: uuidVersion } = require('uuid');
const config = require('../src/config/env');
const {
  aiTenantId, mintAiToken, aiAuthHeader, orgRootId, AI_TENANT_NAMESPACE,
} = require('../src/utils/aiTenant');
const withAccount = require('../src/middleware/withAccount');
const { runMw } = require('./helpers/mw');

const SECRET = 'ai-shared-secret-that-is-at-least-32-chars!!';
let savedSecret;
beforeEach(() => { savedSecret = config.aiJwt.secret; config.aiJwt.secret = SECRET; });
afterEach(() => { config.aiJwt.secret = savedSecret; jest.useRealTimers(); });

describe('aiTenantId (tenant = organisation)', () => {
  test('the namespace is frozen: changing it would orphan every enrolled face', () => {
    expect(AI_TENANT_NAMESPACE).toBe('6f9a1c2e-1b3d-5e7f-8a9b-0c1d2e3f4a5b');
  });

  test('is a deterministic UUIDv5 of the org root id', () => {
    const t = aiTenantId({ id: 'owner-1' });
    expect(uuidValidate(t)).toBe(true);
    expect(uuidVersion(t)).toBe(5);
    expect(t).toBe(uuidv5('drisyam-org:owner-1', AI_TENANT_NAMESPACE));
    expect(aiTenantId({ id: 'owner-1' })).toBe(t);
  });

  test('a sub-user gets the SAME tenant as its parent account', () => {
    expect(aiTenantId({ id: 'member-7', parentUserId: 'owner-1' })).toBe(aiTenantId({ id: 'owner-1' }));
    expect(orgRootId({ id: 'member-7', parentUserId: 'owner-1' })).toBe('owner-1');
  });

  test('two different organisations never share a tenant', () => {
    expect(aiTenantId({ id: 'owner-1' })).not.toBe(aiTenantId({ id: 'owner-2' }));
    expect(aiTenantId({ id: 'm', parentUserId: 'owner-1' })).not.toBe(aiTenantId({ id: 'm', parentUserId: 'owner-2' }));
  });

  test('no user / no id gives no tenant (null), never a shared "empty" tenant', () => {
    expect(aiTenantId(null)).toBeNull();
    expect(aiTenantId({})).toBeNull();
    expect(aiTenantId(undefined)).toBeNull();
  });

  test('only id/parentUserId matter: a tenant_id or tid field on the user object is ignored', () => {
    expect(aiTenantId({ id: 'owner-1', tenant_id: 'evil', tid: 'evil' })).toBe(aiTenantId({ id: 'owner-1' }));
  });
});

describe('mintAiToken', () => {
  test('carries the org tenant in tid, the user in sub, and the configured iss/aud, signed HS256', () => {
    const tok = mintAiToken({ id: 'member-7', parentUserId: 'owner-1', role: 'viewer' });
    const decoded = jwt.verify(tok, SECRET, { algorithms: ['HS256'], audience: config.aiJwt.audience, issuer: config.aiJwt.issuer });
    expect(decoded.tid).toBe(aiTenantId({ id: 'owner-1' }));
    expect(decoded.sub).toBe('member-7');
    expect(jwt.decode(tok, { complete: true }).header.alg).toBe('HS256');
  });

  test('a token signed with another secret does not verify (the AI will refuse it)', () => {
    const tok = mintAiToken({ id: 'owner-1' });
    expect(() => jwt.verify(tok, 'some-other-secret-of-sufficient-length-0000')).toThrow();
  });

  test('no token is minted when the secret is missing or shorter than 32 characters', () => {
    for (const s of [undefined, '', 'x'.repeat(31)]) {
      config.aiJwt.secret = s;
      expect(mintAiToken({ id: 'owner-1' })).toBeNull();
      expect(aiAuthHeader({ id: 'owner-1' })).toEqual({});
    }
  });

  test('a 32-character secret is enough', () => {
    config.aiJwt.secret = 'y'.repeat(32);
    expect(typeof mintAiToken({ id: 'owner-1' })).toBe('string');
  });

  test('no token is minted for a user without an id', () => {
    expect(mintAiToken({})).toBeNull();
    expect(aiAuthHeader(null)).toEqual({});
  });

  test('role is "admin" only for an admin; every other role (and a forged one) is "operator"', () => {
    const roleOf = (role) => jwt.decode(mintAiToken({ id: 'u', role })).role;
    expect(roleOf('admin')).toBe('admin');
    for (const r of ['manager', 'operator', 'viewer', 'user', 'superadmin', undefined]) expect(roleOf(r)).toBe('operator');
  });

  test('scopes are fixed: persons read/write and events read, nothing else', () => {
    expect(jwt.decode(mintAiToken({ id: 'u' })).scopes).toEqual(['persons:write', 'persons:read', 'events:read']);
  });

  test('exp = now + ttl, iat backdated 120 s for clock skew', () => {
    jest.useFakeTimers({ now: new Date('2026-11-25T10:00:00Z') });
    const now = Math.floor(Date.now() / 1000);
    const d = jwt.decode(mintAiToken({ id: 'u' }));
    expect(d.exp).toBe(now + 3600);
    expect(d.iat).toBe(now - 120);
    expect(jwt.decode(mintAiToken({ id: 'u' }, { ttlSec: 300 })).exp).toBe(now + 300);
  });

  test('ttl is floored at 60 s so a tiny or negative ttl cannot mint an already-dead token', () => {
    jest.useFakeTimers({ now: new Date('2026-11-25T10:00:00Z') });
    const now = Math.floor(Date.now() / 1000);
    expect(jwt.decode(mintAiToken({ id: 'u' }, { ttlSec: 1 })).exp).toBe(now + 60);
    expect(jwt.decode(mintAiToken({ id: 'u' }, { ttlSec: -500 })).exp).toBe(now + 60);
  });

  test('aiAuthHeader wraps the minted token as a Bearer header', () => {
    const h = aiAuthHeader({ id: 'owner-1' });
    expect(h.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(jwt.verify(h.Authorization.slice(7), SECRET, { audience: config.aiJwt.audience }).tid).toBe(aiTenantId({ id: 'owner-1' }));
  });
});

describe('withAccount (sub-users act inside their organisation)', () => {
  test('no signed-in user is refused with 401 and never reaches the handler', async () => {
    const out = await runMw(withAccount, {});
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(401);
    expect(mockFindByPk).not.toHaveBeenCalled();
  });

  test('a token for a user that no longer exists is refused with 401', async () => {
    mockFindByPk.mockResolvedValue(null);
    const out = await runMw(withAccount, { user: { id: 'gone' } });
    expect(out.passed).toBe(false);
    expect(out.err.statusCode).toBe(401);
  });

  test('a sub-user gets parentUserId from the DATABASE, so its AI tenant is the parent org', async () => {
    mockFindByPk.mockResolvedValue({ id: 'member-7', parentUserId: 'owner-1', name: 'Asha' });
    const out = await runMw(withAccount, { user: { id: 'member-7', role: 'viewer' } });
    expect(out.passed).toBe(true);
    expect(mockFindByPk).toHaveBeenCalledWith('member-7', expect.any(Object));
    expect(out.req.user.parentUserId).toBe('owner-1');
    expect(out.req.user.id).toBe('member-7');
    expect(out.req.user.role).toBe('viewer');
    expect(aiTenantId(out.req.user)).toBe(aiTenantId({ id: 'owner-1' }));
  });

  test('an account owner gets parentUserId null and stays its own organisation', async () => {
    mockFindByPk.mockResolvedValue({ id: 'owner-1', parentUserId: undefined, name: 'Owner' });
    const out = await runMw(withAccount, { user: { id: 'owner-1' } });
    expect(out.req.user.parentUserId).toBeNull();
    expect(aiTenantId(out.req.user)).toBe(aiTenantId({ id: 'owner-1' }));
  });

  test('a parentUserId sent in the body, query or headers is ignored; only the user record decides', async () => {
    mockFindByPk.mockResolvedValue({ id: 'member-7', parentUserId: 'owner-1', name: 'Asha' });
    const out = await runMw(withAccount, {
      user: { id: 'member-7' },
      body: { parentUserId: 'victim-org', tenant_id: 'victim' },
      query: { parentUserId: 'victim-org' },
      headers: { 'x-parent-user-id': 'victim-org', 'x-tenant-id': 'victim' },
    });
    expect(out.req.user.parentUserId).toBe('owner-1');
  });

  test('display name falls back name → username → email → id', async () => {
    const cases = [
      [{ id: 'u', name: 'N', username: 'un', email: 'e@x' }, 'N'],
      [{ id: 'u', username: 'un', email: 'e@x' }, 'un'],
      [{ id: 'u', email: 'e@x' }, 'e@x'],
      [{ id: 42 }, '42'],
    ];
    for (const [row, expected] of cases) {
      mockFindByPk.mockResolvedValueOnce(row);
      const out = await runMw(withAccount, { user: { id: row.id } });
      expect(out.req.user.name).toBe(expected);
    }
  });

  test('a name already on req.user is kept', async () => {
    mockFindByPk.mockResolvedValue({ id: 'u', name: 'From DB' });
    const out = await runMw(withAccount, { user: { id: 'u', name: 'Already' } });
    expect(out.req.user.name).toBe('Already');
  });

  test('when parentUserId is already resolved on req.user (earlier middleware), the DB is not asked again', async () => {
    const out = await runMw(withAccount, { user: { id: 'member-7', parentUserId: 'owner-1' } });
    expect(out.passed).toBe(true);
    expect(mockFindByPk).not.toHaveBeenCalled();
  });

  test('the JWT authenticate mints never carries parentUserId, so the DB lookup always runs for real requests', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/models', () => ({ RefreshToken: { create: jest.fn() } }));
      const authService = require('../src/services/auth.service');
      const tok = authService.generateAccessToken({ id: 'member-7', email: 'a@b.c', role: 'viewer', parentUserId: 'owner-1' });
      expect(jwt.decode(tok)).not.toHaveProperty('parentUserId');
    });
  });
});
