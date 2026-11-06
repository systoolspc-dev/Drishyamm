const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const authenticate = require('../src/middleware/authenticate');

const secret = config.jwt.secret;
const mkReq = (o = {}) => ({ headers: {}, query: {}, ...o });

describe('authenticate middleware (the JWT gate on every protected route)', () => {
  test('a valid Bearer token sets req.user and calls next()', () => {
    const token = jwt.sign({ id: 'u1', email: 'a@b.c', role: 'user' }, secret, { expiresIn: '5m' });
    const req = mkReq({ headers: { authorization: `Bearer ${token}` } });
    const next = jest.fn();
    authenticate(req, {}, next);
    expect(req.user.id).toBe('u1');
    expect(req.user.role).toBe('user');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('accepts a token via ?token= query param (for <video> src)', () => {
    const token = jwt.sign({ id: 'u2' }, secret, { expiresIn: '5m' });
    const req = mkReq({ query: { token } });
    const next = jest.fn();
    authenticate(req, {}, next);
    expect(req.user.id).toBe('u2');
    expect(next).toHaveBeenCalled();
  });

  test('no token → 401', () => {
    let err;
    try { authenticate(mkReq(), {}, jest.fn()); } catch (e) { err = e; }
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/No token/);
  });

  test('an expired token → 401 (expired)', () => {
    const token = jwt.sign({ id: 'u3' }, secret, { expiresIn: -10 });
    const req = mkReq({ headers: { authorization: `Bearer ${token}` } });
    let err;
    try { authenticate(req, {}, jest.fn()); } catch (e) { err = e; }
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/expired/i);
  });

  test('a token signed with the wrong secret → 401 (invalid)', () => {
    const token = jwt.sign({ id: 'u4' }, 'not-the-real-secret', { expiresIn: '5m' });
    const req = mkReq({ headers: { authorization: `Bearer ${token}` } });
    let err;
    try { authenticate(req, {}, jest.fn()); } catch (e) { err = e; }
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/Invalid token/);
  });

  test('a malformed Authorization header (no Bearer) is treated as no token', () => {
    const req = mkReq({ headers: { authorization: 'Basic abc' } });
    let err;
    try { authenticate(req, {}, jest.fn()); } catch (e) { err = e; }
    expect(err.statusCode).toBe(401);
  });
});
