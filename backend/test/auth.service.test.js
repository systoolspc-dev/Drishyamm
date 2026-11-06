// Mock the RefreshToken model so token generation needs no DB.
jest.mock('../src/models', () => ({
  RefreshToken: { create: jest.fn().mockResolvedValue({}) },
}));

const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const models = require('../src/models');
const authService = require('../src/services/auth.service');

const USER = { id: 'user-123', email: 'op@drishyam.ai', role: 'user' };

describe('auth.service.generateTokenPair', () => {
  test('returns a decodable access token bound to the user', async () => {
    const { accessToken, refreshToken } = await authService.generateTokenPair(USER);
    expect(typeof accessToken).toBe('string');
    expect(typeof refreshToken).toBe('string');

    const decoded = jwt.verify(accessToken, config.jwt.secret);
    expect(decoded.id).toBe(USER.id);
    expect(decoded.email).toBe(USER.email);
    expect(decoded.role).toBe(USER.role);
  });

  test('persists the refresh token (so it can be revoked on logout)', async () => {
    await authService.generateTokenPair(USER);
    expect(models.RefreshToken.create).toHaveBeenCalled();
    const arg = models.RefreshToken.create.mock.calls.at(-1)[0];
    expect(arg).toHaveProperty('userId', USER.id);
  });

  test('the access token carries an expiry (exp claim)', async () => {
    const { accessToken } = await authService.generateTokenPair(USER);
    const decoded = jwt.decode(accessToken);
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
