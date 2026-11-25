// Service-to-service auth on /api/internal/* (AI worker → backend). Fail
// closed when the token is not configured; constant-time compare; only an
// exact match passes.

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// config/env is frozen; serve serviceToken from a test-controlled value.
const mockState = { token: null };
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return { ...actual, get serviceToken() { return mockState.token; } };
});

const crypto = require('node:crypto');
const config = require('../src/config/env');
const logger = require('../src/config/logger');
const serviceAuth = require('../src/middleware/serviceAuth');
const { runMw } = require('./helpers/mw');

const TOKEN = 'svc-token-0123456789abcdef0123456789abcdef';

const reqWith = (headers = {}) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: h, get: (name) => h[String(name).toLowerCase()] };
};

beforeEach(() => { mockState.token = TOKEN; });
afterEach(() => { jest.restoreAllMocks(); });

test('no SERVICE_TOKEN configured: every call is refused with 500 (fail closed), even one with a token', async () => {
  mockState.token = null;
  const out = await runMw(serviceAuth, reqWith({ 'X-Service-Token': TOKEN }));
  expect(out.passed).toBe(false);
  expect(out.err.statusCode).toBe(500);
  expect(out.req.isServiceCall).toBeUndefined();
  expect(logger.error).toHaveBeenCalled();
});

test('an empty SERVICE_TOKEN is treated as not configured, so an empty header cannot match it', async () => {
  mockState.token = '';
  const out = await runMw(serviceAuth, reqWith({ 'X-Service-Token': '' }));
  expect(out.err.statusCode).toBe(500);
});

test('no token in the request is refused with 401', async () => {
  const out = await runMw(serviceAuth, reqWith({}));
  expect(out.passed).toBe(false);
  expect(out.err.statusCode).toBe(401);
  expect(out.req.isServiceCall).toBeUndefined();
});

test('a wrong token of the same length is refused with 401', async () => {
  const wrong = TOKEN.slice(0, -1) + (TOKEN.endsWith('f') ? 'e' : 'f');
  const out = await runMw(serviceAuth, reqWith({ 'X-Service-Token': wrong }));
  expect(out.err.statusCode).toBe(401);
});

test('a prefix of the token, or the token plus extra characters, is refused', async () => {
  for (const t of [TOKEN.slice(0, 10), `${TOKEN}x`, ` ${TOKEN}`]) {
    const out = await runMw(serviceAuth, reqWith({ 'X-Service-Token': t }));
    expect(out.err.statusCode).toBe(401);
  }
});

test('the exact token in X-Service-Token passes and tags the request as a service call', async () => {
  const out = await runMw(serviceAuth, reqWith({ 'X-Service-Token': TOKEN }));
  expect(out.passed).toBe(true);
  expect(out.req.isServiceCall).toBe(true);
});

test('the exact token as "Authorization: Bearer" passes too (scheme is case-insensitive)', async () => {
  for (const h of [`Bearer ${TOKEN}`, `bearer ${TOKEN}`]) {
    const out = await runMw(serviceAuth, reqWith({ Authorization: h }));
    expect(out.passed).toBe(true);
  }
});

test('a user JWT in Authorization is not a service token', async () => {
  const jwt = require('jsonwebtoken');
  const userJwt = jwt.sign({ id: 'u1', role: 'admin' }, config.jwt.secret);
  const out = await runMw(serviceAuth, reqWith({ Authorization: `Bearer ${userJwt}` }));
  expect(out.err.statusCode).toBe(401);
});

test('X-Service-Token wins over Authorization: a wrong X-Service-Token is refused even with a right bearer', async () => {
  const out = await runMw(serviceAuth, reqWith({ 'X-Service-Token': 'nope', Authorization: `Bearer ${TOKEN}` }));
  expect(out.err.statusCode).toBe(401);
});

test('comparison of equal-length tokens goes through crypto.timingSafeEqual (constant time)', async () => {
  const spy = jest.spyOn(crypto, 'timingSafeEqual');
  await runMw(serviceAuth, reqWith({ 'X-Service-Token': TOKEN }));
  expect(spy).toHaveBeenCalledTimes(1);
});

test('a multi-byte token whose UTF-8 length differs is refused without throwing', async () => {
  // Same JS string length, different byte length: must not crash timingSafeEqual.
  const sneaky = 'é'.repeat(TOKEN.length);
  const out = await runMw(serviceAuth, reqWith({ 'X-Service-Token': sneaky }));
  expect(out.thrown).toBeUndefined();
  expect(out.err.statusCode).toBe(401);
});
