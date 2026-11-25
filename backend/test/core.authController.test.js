// Auth controller + the Joi schemas in front of it: register / login /
// refresh / logout / password reset / profile. The rules protected here are
// the ones an attacker probes first: mass assignment at signup, suspended
// accounts, wrong passwords, single-use refresh tokens, email enumeration.

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendPasswordResetEmail: jest.fn() }));
jest.mock('../src/services/platformEvents.service', () => ({
  record: jest.fn(), noteLogin: jest.fn(), noteLoginFailure: jest.fn(), planLabel: (n) => n,
}));
jest.mock('../src/services/platformEvents/catalog', () => ({ hostOf: () => null }));
jest.mock('../src/services/entitlements.service', () => ({
  getEntitlements: jest.fn(),
  getAiEntitlement: jest.fn(),
}));
jest.mock('../src/services/auth.service', () => ({
  generateTokenPair: jest.fn(),
  verifyRefreshToken: jest.fn(),
  revokeRefreshToken: jest.fn(),
  revokeAllUserTokens: jest.fn(),
}));
jest.mock('../src/models', () => ({
  User: { findOne: jest.fn(), create: jest.fn(), findByPk: jest.fn() },
  Subscription: { create: jest.fn() },
  Plan: { findOne: jest.fn() },
  PasswordReset: { findOne: jest.fn(), create: jest.fn(), update: jest.fn(), generateToken: jest.fn(() => 'reset-tok') },
  Role: {},
  RefreshToken: { findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
}));

const { Op } = require('sequelize');
const models = require('../src/models');
const authService = require('../src/services/auth.service');
const { getEntitlements } = require('../src/services/entitlements.service');
const platformEvents = require('../src/services/platformEvents.service');
const emailService = require('../src/services/email.service');
const ctrl = require('../src/controllers/auth.controller');
const validate = require('../src/middleware/validate');
const schemas = require('../src/validations/auth.validation');

const { User, Subscription, Plan, PasswordReset } = models;

const run = (handler, req) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { resolve({ status: this.statusCode, body: b }); },
  };
  handler({ headers: {}, body: {}, ...req }, res, (err) => resolve({ err }));
});

const fakeUser = (over = {}) => {
  const u = {
    id: 'u1', name: 'Asha', email: 'asha@example.com', role: 'admin', isActive: true, parentUserId: null,
    password: 'HASHED',
    validatePassword: jest.fn(async (p) => p === 'Correct1pass'),
    update: jest.fn(async function (v) { Object.assign(this, v); return this; }),
    toSafeJSON() { const { password, validatePassword, update, toSafeJSON, toJSON, ...rest } = this; return rest; },
    ...over,
  };
  u.toJSON = () => ({ ...u.toSafeJSON(), password: u.password });
  return u;
};

beforeEach(() => {
  authService.generateTokenPair.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT-new' });
  getEntitlements.mockResolvedValue({ aiEnabled: true, features: null });
  User.findOne.mockResolvedValue(null);
  User.findByPk.mockResolvedValue(null);
  User.create.mockImplementation(async (v) => fakeUser({ id: 'new-id', ...v }));
  Plan.findOne.mockResolvedValue(null);
});

describe('register', () => {
  test('an email that already exists is refused with 409 and nothing is created', async () => {
    User.findOne.mockResolvedValue(fakeUser());
    const out = await run(ctrl.register, { body: { name: 'X', email: 'asha@example.com', password: 'Correct1pass' } });
    expect(out.err.statusCode).toBe(409);
    expect(User.create).not.toHaveBeenCalled();
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('mass assignment: only name/email/password are taken from the body and role is always admin', async () => {
    await run(ctrl.register, { body: {
      name: 'Eve', email: 'eve@example.com', password: 'Correct1pass',
      role: 'user', isPlatformAdmin: true, parentUserId: 'victim', isActive: true, id: 'chosen-id',
    } });
    expect(User.create).toHaveBeenCalledTimes(1);
    expect(User.create.mock.calls[0][0]).toEqual({ name: 'Eve', email: 'eve@example.com', password: 'Correct1pass', role: 'admin' });
  });

  test('the Joi schema strips role/isPlatformAdmin before the controller sees the body', () => {
    const req = { body: { name: 'Eve', email: 'EVE@Example.com ', password: 'Correct1pass', role: 'admin', isPlatformAdmin: true, parentUserId: 'x' } };
    const next = jest.fn();
    validate(schemas.register)(req, {}, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ name: 'Eve', email: 'eve@example.com', password: 'Correct1pass' });
  });

  test.each([
    ['too short', 'Ab1'],
    ['no uppercase', 'lowercase1'],
    ['no lowercase', 'UPPERCASE1'],
    ['no digit', 'NoDigitsHere'],
    ['too long', `Aa1${'x'.repeat(130)}`],
  ])('a weak password (%s) is refused with 400 at validation', (_label, password) => {
    const next = jest.fn();
    expect(() => validate(schemas.register)({ body: { name: 'Eve', email: 'e@x.com', password } }, {}, next)).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(next).not.toHaveBeenCalled();
  });

  test('an unknown tier and a bad email are refused with 400', () => {
    expect(() => validate(schemas.register)({ body: { name: 'Eve', email: 'e@x.com', password: 'Correct1pass', tier: 'enterprise' } }, {}, jest.fn())).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => validate(schemas.register)({ body: { name: 'Eve', email: 'not-an-email', password: 'Correct1pass' } }, {}, jest.fn())).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  test('tier ai_vms gets the AI+VMS trial plan; no tier gets Basic VMS', async () => {
    Plan.findOne.mockImplementation(async ({ where }) => ({ id: `plan-${where.name}`, name: where.name }));
    await run(ctrl.register, { body: { name: 'A', email: 'a@x.com', password: 'Correct1pass', tier: 'ai_vms' } });
    expect(Plan.findOne.mock.calls[0][0].where.name).toBe('AI+VMS');
    expect(Subscription.create.mock.calls[0][0]).toMatchObject({ userId: 'new-id', planId: 'plan-AI+VMS', status: 'active' });

    Plan.findOne.mockClear(); Subscription.create.mockClear();
    await run(ctrl.register, { body: { name: 'B', email: 'b@x.com', password: 'Correct1pass' } });
    expect(Plan.findOne.mock.calls[0][0].where.name).toBe('Basic VMS');
  });

  test('a missing tier plan falls back to Free; no plan at all still signs up without a subscription', async () => {
    Plan.findOne.mockImplementation(async ({ where }) => (where.name === 'Free' ? { id: 'free', name: 'Free' } : null));
    let out = await run(ctrl.register, { body: { name: 'A', email: 'a@x.com', password: 'Correct1pass' } });
    expect(Subscription.create.mock.calls[0][0].planId).toBe('free');
    expect(out.status).toBe(201);

    Plan.findOne.mockResolvedValue(null); Subscription.create.mockClear();
    out = await run(ctrl.register, { body: { name: 'A', email: 'a2@x.com', password: 'Correct1pass' } });
    expect(Subscription.create).not.toHaveBeenCalled();
    expect(out.status).toBe(201);
  });

  test('responds 201 with tokens and a user object without the password', async () => {
    const out = await run(ctrl.register, { body: { name: 'A', email: 'a@x.com', password: 'Correct1pass' } });
    expect(out.status).toBe(201);
    expect(out.body.token).toBe('AT');
    expect(out.body.refreshToken).toBe('RT-new');
    expect(out.body.user).not.toHaveProperty('password');
  });
});

describe('login', () => {
  test('looks the identifier up as lowercase email OR exact username', async () => {
    await run(ctrl.login, { body: { email: '  Asha@Example.COM ', password: 'x' } });
    const where = User.findOne.mock.calls[0][0].where;
    expect(where[Op.or]).toEqual([{ email: 'asha@example.com' }, { username: 'Asha@Example.COM' }]);
  });

  test('an unknown user is refused with 401, recorded as a failure, and gets no tokens', async () => {
    const out = await run(ctrl.login, { body: { email: 'nobody@x.com', password: 'Correct1pass' } });
    expect(out.err.statusCode).toBe(401);
    expect(platformEvents.noteLoginFailure).toHaveBeenCalledWith('nobody@x.com', expect.objectContaining({ reason: 'unknown_user' }));
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('a wrong password is refused with 401, recorded, and gets no tokens', async () => {
    User.findOne.mockResolvedValue(fakeUser());
    const out = await run(ctrl.login, { body: { email: 'asha@example.com', password: 'Wrong1pass' } });
    expect(out.err.statusCode).toBe(401);
    expect(platformEvents.noteLoginFailure).toHaveBeenCalledWith('asha@example.com', expect.objectContaining({ reason: 'bad_password' }));
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('a missing password is refused (never compared as a match)', async () => {
    User.findOne.mockResolvedValue(fakeUser());
    const out = await run(ctrl.login, { body: { email: 'asha@example.com' } });
    expect(out.err.statusCode).toBe(401);
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('a deactivated (suspended) user is refused with 403 and gets no tokens, even with the right password', async () => {
    User.findOne.mockResolvedValue(fakeUser({ isActive: false }));
    const out = await run(ctrl.login, { body: { email: 'asha@example.com', password: 'Correct1pass' } });
    expect(out.err.statusCode).toBe(403);
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('a sub-user of a suspended account is refused with 403', async () => {
    User.findOne.mockResolvedValue(fakeUser({ id: 'm1', role: 'viewer', parentUserId: 'owner' }));
    User.findByPk.mockResolvedValue({ id: 'owner', isActive: false });
    const out = await run(ctrl.login, { body: { email: 'm1', password: 'Correct1pass' } });
    expect(out.err.statusCode).toBe(403);
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('a sub-user whose owner row is gone is refused with 403', async () => {
    User.findOne.mockResolvedValue(fakeUser({ id: 'm1', parentUserId: 'owner' }));
    User.findByPk.mockResolvedValue(null);
    const out = await run(ctrl.login, { body: { email: 'm1', password: 'Correct1pass' } });
    expect(out.err.statusCode).toBe(403);
  });

  test('a sub-user of an active account signs in', async () => {
    User.findOne.mockResolvedValue(fakeUser({ id: 'm1', role: 'viewer', parentUserId: 'owner' }));
    User.findByPk.mockResolvedValue({ id: 'owner', isActive: true });
    const out = await run(ctrl.login, { body: { email: 'm1', password: 'Correct1pass' } });
    expect(out.status).toBe(200);
    expect(out.body.capabilities.sort()).toEqual(['view_live', 'view_playback']);
  });

  test('right credentials return tokens, the user without password, and record the login', async () => {
    const u = fakeUser();
    User.findOne.mockResolvedValue(u);
    const out = await run(ctrl.login, { body: { email: 'asha@example.com', password: 'Correct1pass' } });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ success: true, token: 'AT', refreshToken: 'RT-new' });
    expect(out.body.user).not.toHaveProperty('password');
    expect(authService.generateTokenPair).toHaveBeenCalledWith(u);
    expect(platformEvents.noteLogin).toHaveBeenCalledWith(u, expect.anything());
  });

  test('on a plan without AI the use_ai capability is stripped from the response', async () => {
    User.findOne.mockResolvedValue(fakeUser());
    getEntitlements.mockResolvedValue({ aiEnabled: false, features: null });
    const out = await run(ctrl.login, { body: { email: 'asha@example.com', password: 'Correct1pass' } });
    expect(out.body.capabilities).not.toContain('use_ai');
    expect(out.body.capabilities).toContain('manage_users');
    expect(out.body.user.aiEnabled).toBe(false);
  });
});

describe('refresh token', () => {
  test('an invalid or revoked refresh token is refused and nothing new is issued', async () => {
    const AppError = require('../src/utils/AppError');
    authService.verifyRefreshToken.mockRejectedValue(new AppError('Refresh token is invalid or has been revoked.', 401));
    const out = await run(ctrl.refreshToken, { body: { refreshToken: 'old' } });
    expect(out.err.statusCode).toBe(401);
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('rotation: the old token is revoked before a new pair is issued', async () => {
    authService.verifyRefreshToken.mockResolvedValue({ id: 'u1' });
    User.findByPk.mockResolvedValue(fakeUser());
    const order = [];
    authService.revokeRefreshToken.mockImplementation(async () => order.push('revoke'));
    authService.generateTokenPair.mockImplementation(async () => { order.push('issue'); return { accessToken: 'AT2', refreshToken: 'RT2' }; });
    const out = await run(ctrl.refreshToken, { body: { refreshToken: 'old' } });
    expect(authService.revokeRefreshToken).toHaveBeenCalledWith('old');
    expect(order).toEqual(['revoke', 'issue']);
    expect(out.body).toEqual({ success: true, token: 'AT2', refreshToken: 'RT2' });
  });

  test('the user is looked up from the verified token id, not from the body', async () => {
    authService.verifyRefreshToken.mockResolvedValue({ id: 'u1' });
    User.findByPk.mockResolvedValue(fakeUser());
    await run(ctrl.refreshToken, { body: { refreshToken: 'old', id: 'someone-else' } });
    expect(User.findByPk).toHaveBeenCalledWith('u1');
  });

  test('a deactivated user cannot refresh (401) and the presented token is still burned', async () => {
    authService.verifyRefreshToken.mockResolvedValue({ id: 'u1' });
    User.findByPk.mockResolvedValue(fakeUser({ isActive: false }));
    const out = await run(ctrl.refreshToken, { body: { refreshToken: 'old' } });
    expect(out.err.statusCode).toBe(401);
    expect(authService.revokeRefreshToken).toHaveBeenCalledWith('old');
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('a sub-user of a suspended account cannot refresh', async () => {
    authService.verifyRefreshToken.mockResolvedValue({ id: 'm1' });
    User.findByPk.mockImplementation(async (id) => (id === 'm1' ? fakeUser({ id: 'm1', parentUserId: 'owner' }) : { id: 'owner', isActive: false }));
    const out = await run(ctrl.refreshToken, { body: { refreshToken: 'old' } });
    expect(out.err.statusCode).toBe(401);
    expect(authService.generateTokenPair).not.toHaveBeenCalled();
  });

  test('a deleted user cannot refresh', async () => {
    authService.verifyRefreshToken.mockResolvedValue({ id: 'u1' });
    User.findByPk.mockResolvedValue(null);
    const out = await run(ctrl.refreshToken, { body: { refreshToken: 'old' } });
    expect(out.err.statusCode).toBe(401);
  });
});

describe('auth.service refresh-token checks (real implementation)', () => {
  const real = jest.requireActual('../src/services/auth.service');
  const jwt = require('jsonwebtoken');
  const config = require('../src/config/env');
  const { RefreshToken } = models;

  test('a refresh token signed with the ACCESS secret is rejected', async () => {
    const forged = jwt.sign({ id: 'u1' }, config.jwt.secret);
    await expect(real.verifyRefreshToken(forged)).rejects.toThrow();
    expect(RefreshToken.findOne).not.toHaveBeenCalled();
  });

  test('a validly signed token that is not stored un-revoked is refused with 401', async () => {
    const tok = jwt.sign({ id: 'u1' }, config.jwt.refreshSecret);
    RefreshToken.findOne.mockResolvedValue(null);
    await expect(real.verifyRefreshToken(tok)).rejects.toMatchObject({ statusCode: 401 });
    expect(RefreshToken.findOne.mock.calls[0][0].where).toEqual({ token: tok, isRevoked: false });
  });

  test('a stored token past its DB expiry is refused with 401 and marked revoked', async () => {
    const tok = jwt.sign({ id: 'u1' }, config.jwt.refreshSecret);
    const row = { expiresAt: new Date(Date.now() - 1000), update: jest.fn() };
    RefreshToken.findOne.mockResolvedValue(row);
    await expect(real.verifyRefreshToken(tok)).rejects.toMatchObject({ statusCode: 401 });
    expect(row.update).toHaveBeenCalledWith({ isRevoked: true });
  });

  test('a stored, unexpired token verifies to its user id', async () => {
    const tok = jwt.sign({ id: 'u1' }, config.jwt.refreshSecret);
    RefreshToken.findOne.mockResolvedValue({ expiresAt: new Date(Date.now() + 60000), update: jest.fn() });
    await expect(real.verifyRefreshToken(tok)).resolves.toMatchObject({ id: 'u1' });
  });

  test('revokeAllUserTokens revokes only that user\'s live tokens', async () => {
    await real.revokeAllUserTokens('u1');
    expect(RefreshToken.update).toHaveBeenCalledWith({ isRevoked: true }, { where: { userId: 'u1', isRevoked: false } });
  });
});

describe('logout', () => {
  test('revokes the presented refresh token', async () => {
    const out = await run(ctrl.logout, { body: { refreshToken: 'RT' } });
    expect(authService.revokeRefreshToken).toHaveBeenCalledWith('RT');
    expect(out.body.success).toBe(true);
  });

  test('without a token it still succeeds and revokes nothing', async () => {
    const out = await run(ctrl.logout, { body: {} });
    expect(authService.revokeRefreshToken).not.toHaveBeenCalled();
    expect(out.body.success).toBe(true);
  });
});

describe('forgot / reset password', () => {
  const GENERIC = 'If an account with that email exists, a password reset link has been sent.';

  test('an unknown email gets the same answer as a known one (no enumeration) and no token is made', async () => {
    const out = await run(ctrl.forgotPassword, { body: { email: 'nobody@x.com' } });
    expect(out.body).toEqual({ success: true, message: GENERIC });
    expect(PasswordReset.create).not.toHaveBeenCalled();
  });

  test('an inactive account gets the generic answer and no token', async () => {
    User.findOne.mockResolvedValue(fakeUser({ isActive: false }));
    const out = await run(ctrl.forgotPassword, { body: { email: 'asha@example.com' } });
    expect(out.body.message).toBe(GENERIC);
    expect(PasswordReset.create).not.toHaveBeenCalled();
  });

  test('a known email invalidates older links, makes a 1-hour token and gets the generic answer', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-25T10:00:00Z') });
    try {
      User.findOne.mockResolvedValue(fakeUser());
      const out = await run(ctrl.forgotPassword, { body: { email: 'asha@example.com' } });
      expect(PasswordReset.update).toHaveBeenCalledWith({ usedAt: expect.any(Date) }, { where: { userId: 'u1', usedAt: null } });
      const created = PasswordReset.create.mock.calls[0][0];
      expect(created).toMatchObject({ userId: 'u1', token: 'reset-tok' });
      expect(created.expiresAt.getTime() - Date.now()).toBe(60 * 60 * 1000);
      expect(out.body.message).toBe(GENERIC);
    } finally { jest.useRealTimers(); }
  });

  test('an email send failure does not change the answer', async () => {
    User.findOne.mockResolvedValue(fakeUser());
    emailService.sendPasswordResetEmail.mockRejectedValue(new Error('smtp down'));
    const out = await run(ctrl.forgotPassword, { body: { email: 'asha@example.com' } });
    expect(out.body).toEqual({ success: true, message: GENERIC });
  });

  test('reset looks only for an unused, unexpired token', async () => {
    PasswordReset.findOne.mockResolvedValue(null);
    const out = await run(ctrl.resetPassword, { body: { token: 't', password: 'NewPass1x' } });
    expect(out.err.statusCode).toBe(400);
    const where = PasswordReset.findOne.mock.calls[0][0].where;
    expect(where.token).toBe('t');
    expect(where.usedAt).toBeNull();
    expect(where.expiresAt[Op.gt]).toBeInstanceOf(Date);
  });

  test('a reset link for a deactivated user is refused with 400 and the password is untouched', async () => {
    const u = fakeUser({ isActive: false });
    PasswordReset.findOne.mockResolvedValue({ user: u, update: jest.fn() });
    const out = await run(ctrl.resetPassword, { body: { token: 't', password: 'NewPass1x' } });
    expect(out.err.statusCode).toBe(400);
    expect(u.update).not.toHaveBeenCalled();
  });

  test('a valid reset sets the password, burns the link and signs out every session', async () => {
    const u = fakeUser();
    const rec = { user: u, update: jest.fn() };
    PasswordReset.findOne.mockResolvedValue(rec);
    const out = await run(ctrl.resetPassword, { body: { token: 't', password: 'NewPass1x' } });
    expect(u.update).toHaveBeenCalledWith({ password: 'NewPass1x' });
    expect(rec.update).toHaveBeenCalledWith({ usedAt: expect.any(Date) });
    expect(authService.revokeAllUserTokens).toHaveBeenCalledWith('u1');
    expect(out.body.success).toBe(true);
  });
});

describe('change password / profile', () => {
  test('a wrong current password is refused with 401 and nothing changes', async () => {
    const u = fakeUser();
    User.findByPk.mockResolvedValue(u);
    const out = await run(ctrl.changePassword, { user: { id: 'u1' }, body: { currentPassword: 'Wrong1pass', newPassword: 'NewPass1x' } });
    expect(out.err.statusCode).toBe(401);
    expect(u.update).not.toHaveBeenCalled();
    expect(authService.revokeAllUserTokens).not.toHaveBeenCalled();
  });

  test('the new password must differ from the current one (400)', async () => {
    User.findByPk.mockResolvedValue(fakeUser());
    const out = await run(ctrl.changePassword, { user: { id: 'u1' }, body: { currentPassword: 'Correct1pass', newPassword: 'Correct1pass' } });
    expect(out.err.statusCode).toBe(400);
  });

  test('a successful change updates the password of the TOKEN user and revokes all refresh tokens', async () => {
    const u = fakeUser();
    User.findByPk.mockResolvedValue(u);
    await run(ctrl.changePassword, { user: { id: 'u1' }, body: { currentPassword: 'Correct1pass', newPassword: 'NewPass1x', userId: 'victim' } });
    expect(User.findByPk).toHaveBeenCalledWith('u1');
    expect(u.update).toHaveBeenCalledWith({ password: 'NewPass1x' });
    expect(authService.revokeAllUserTokens).toHaveBeenCalledWith('u1');
  });

  test('profile update writes only name and email, never role or the operator flag', async () => {
    const u = fakeUser({ role: 'viewer' });
    User.findByPk.mockResolvedValue(u);
    await run(ctrl.updateProfile, { user: { id: 'u1' }, body: { name: 'New', email: 'new@x.com', role: 'admin', isPlatformAdmin: true, parentUserId: null } });
    expect(u.update).toHaveBeenCalledWith({ name: 'New', email: 'new@x.com' });
  });

  test('changing to an email another account uses is refused with 409', async () => {
    User.findByPk.mockResolvedValue(fakeUser());
    User.findOne.mockResolvedValue(fakeUser({ id: 'other' }));
    const out = await run(ctrl.updateProfile, { user: { id: 'u1' }, body: { email: 'taken@x.com' } });
    expect(out.err.statusCode).toBe(409);
  });

  test('the profile schema strips role / isPlatformAdmin and needs at least one field', () => {
    const req = { body: { name: 'New', role: 'admin', isPlatformAdmin: true } };
    validate(schemas.updateProfile)(req, {}, jest.fn());
    expect(req.body).toEqual({ name: 'New' });
    expect(() => validate(schemas.updateProfile)({ body: { role: 'admin' } }, {}, jest.fn())).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  test('GET /me for a user that no longer exists is 404', async () => {
    User.findByPk.mockResolvedValue(null);
    const out = await run(ctrl.me, { user: { id: 'gone' } });
    expect(out.err.statusCode).toBe(404);
  });

  test('GET /me never returns the password hash', async () => {
    User.findByPk.mockResolvedValue(fakeUser());
    const out = await run(ctrl.me, { user: { id: 'u1' } });
    expect(out.body.user).not.toHaveProperty('password');
    expect(User.findByPk.mock.calls[0][1].attributes).toEqual({ exclude: ['password'] });
  });
});
