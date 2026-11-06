// Suspended accounts: the in-memory block list and the authenticate gate.
const mockFindAll = jest.fn();
jest.mock('../src/models', () => ({ User: { findAll: (...a) => mockFindAll(...a) } }));

const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const accountStatus = require('../src/services/accountStatus.service');
const authenticate = require('../src/middleware/authenticate');

const tokenFor = (id) => jwt.sign({ id, role: 'admin' }, config.jwt.secret, { expiresIn: '5m' });
const reqFor = (id) => ({ headers: { authorization: `Bearer ${tokenFor(id)}` }, query: {} });

afterEach(() => accountStatus.setBlocked(['owner-1', 'member-1', 'solo'], false));

test('reload blocks an inactive owner AND every sub-user of it', async () => {
  mockFindAll
    .mockResolvedValueOnce([{ id: 'owner-1', parentUserId: null }, { id: 'solo', parentUserId: 'x' }])
    .mockResolvedValueOnce([{ id: 'member-1' }]);
  await accountStatus.reload();
  expect(accountStatus.isBlocked('owner-1')).toBe(true);
  expect(accountStatus.isBlocked('member-1')).toBe(true);
  expect(accountStatus.isBlocked('solo')).toBe(true); // an inactive sub-user itself
  expect(accountStatus.isBlocked('someone-else')).toBe(false);
});

test('authenticate refuses a still-valid token of a suspended account with 401', () => {
  accountStatus.setBlocked(['owner-1'], true);
  let err;
  try { authenticate(reqFor('owner-1'), {}, jest.fn()); } catch (e) { err = e; }
  expect(err.statusCode).toBe(401);
  expect(err.message).toMatch(/suspended/i);
});

test('reactivation lets the same token through again', () => {
  accountStatus.setBlocked(['owner-1'], true);
  accountStatus.setBlocked(['owner-1'], false);
  const next = jest.fn();
  authenticate(reqFor('owner-1'), {}, next);
  expect(next).toHaveBeenCalledTimes(1);
});
