// errorHandler: the one place every backend error becomes a response.
//
// The rule it must keep: a 5xx never shows its message (it can carry SQL,
// hostnames, upstream detail), except fixed text marked for the user with
// AppError.public() ("Smart Search isn't switched on…"). 4xx messages are
// written for the user and pass through. The stack never leaves the server.
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
const logger = require('../src/config/logger');
const errorHandler = require('../src/middleware/errorHandler');
const AppError = require('../src/utils/AppError');

function reply(err, req = {}) {
  const res = {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const next = jest.fn();
  errorHandler(err, { method: 'GET', originalUrl: '/api/x', ip: '1.2.3.4', ...req }, res, next);
  return { ...res, next };
}

beforeEach(() => jest.clearAllMocks());

describe('AppError.public', () => {
  test('defaults to 503 and is marked for display', () => {
    const e = AppError.public('Smart Search is still starting up.');
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(Error);
    expect(e.statusCode).toBe(503);
    expect(e.expose).toBe(true);
    expect(e.isOperational).toBe(true);
    expect(e.message).toBe('Smart Search is still starting up.');
  });

  test('takes an explicit status', () => {
    expect(AppError.public('x', 502).statusCode).toBe(502);
  });

  test('a plain AppError is not marked for display', () => {
    expect(new AppError('x', 503).expose).toBeUndefined();
  });
});

describe('5xx: hidden unless public', () => {
  test.each([500, 502, 503, 504])('a public %i keeps its message', (code) => {
    const r = reply(AppError.public('The search index is switched off.', code));
    expect(r.statusCode).toBe(code);
    expect(r.body).toEqual({ success: false, message: 'The search index is switched off.' });
  });

  test.each([500, 502, 503, 504])('an ordinary AppError %i is hidden', (code) => {
    const r = reply(new AppError('upstream said: postgres at 10.0.0.5 refused', code));
    expect(r.statusCode).toBe(code);
    expect(r.body.message).toBe('Internal Server Error');
  });

  test('a thrown Error (no status) becomes a hidden 500', () => {
    const r = reply(new Error('Cannot read properties of undefined (reading "id")'));
    expect(r.statusCode).toBe(500);
    expect(r.body.message).toBe('Internal Server Error');
  });

  test('a plain Error carrying expose: true is still hidden (only AppError.public counts)', () => {
    const e = Object.assign(new Error('SELECT * FROM users WHERE ...'), { statusCode: 500, expose: true });
    expect(reply(e).body.message).toBe('Internal Server Error');
  });

  test('an AppError with expose set to something other than true is hidden', () => {
    const e = Object.assign(new AppError('internal detail', 500), { expose: 'yes' });
    expect(reply(e).body.message).toBe('Internal Server Error');
  });

  test('an object that only looks like an AppError is hidden', () => {
    const fake = { statusCode: 503, expose: true, isOperational: true, message: 'leaked detail' };
    expect(reply(fake).body.message).toBe('Internal Server Error');
  });

  test('a database error with raw SQL is hidden', () => {
    const e = Object.assign(new Error("ER_BAD_FIELD_ERROR: Unknown column 'x' in 'SELECT password FROM users'"),
      { name: 'SequelizeDatabaseError' });
    const r = reply(e);
    expect(r.statusCode).toBe(500);
    expect(r.body.message).toBe('Internal Server Error');
  });
});

describe('the body never carries more than success + message', () => {
  test.each([
    ['public 5xx', AppError.public('fixed text', 503)],
    ['hidden 5xx', new AppError('secret', 500)],
    ['4xx', new AppError('Camera not found.', 404)],
    ['thrown error', new Error('boom')],
  ])('%s', (_label, err) => {
    const r = reply(err);
    expect(Object.keys(r.body).sort()).toEqual(['message', 'success']);
    expect(r.body.success).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(/at .+\.js:\d+/); // no stack frames
  });
});

describe('4xx and known error types', () => {
  test('a 4xx AppError keeps its message', () => {
    const r = reply(new AppError('Camera not found.', 404));
    expect(r.statusCode).toBe(404);
    expect(r.body.message).toBe('Camera not found.');
  });

  test('Sequelize validation errors become one 400 with every message', () => {
    const e = { name: 'SequelizeValidationError', errors: [{ message: 'name is required' }, { message: 'email is invalid' }] };
    const r = reply(e);
    expect(r.statusCode).toBe(400);
    expect(r.body.message).toBe('name is required, email is invalid');
  });

  test('a unique constraint becomes a 409 naming the field', () => {
    const r = reply({ name: 'SequelizeUniqueConstraintError', errors: [{ path: 'email' }] });
    expect(r.statusCode).toBe(409);
    expect(r.body.message).toBe('A record with this email already exists');
  });

  test('a unique constraint without a path still reads sensibly', () => {
    expect(reply({ name: 'SequelizeUniqueConstraintError', errors: [] }).body.message)
      .toBe('A record with this field already exists');
  });

  test('a bad JWT is a 401 "Invalid token"', () => {
    const r = reply({ name: 'JsonWebTokenError', message: 'jwt malformed' });
    expect(r.statusCode).toBe(401);
    expect(r.body.message).toBe('Invalid token');
  });

  test('an expired JWT is a 401 "Token expired"', () => {
    const r = reply({ name: 'TokenExpiredError', message: 'jwt expired' });
    expect(r.statusCode).toBe(401);
    expect(r.body.message).toBe('Token expired');
  });
});

describe('logging', () => {
  test('a 5xx is logged as an error with the stack and the user, even when public', () => {
    const e = AppError.public('fixed text', 503);
    reply(e, { user: { id: 'u7' }, originalUrl: '/api/investigate/search' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [line, meta] = logger.error.mock.calls[0];
    expect(line).toBe('503 - fixed text');
    expect(meta).toMatchObject({ url: '/api/investigate/search', userId: 'u7' });
    expect(meta.error).toEqual(expect.stringContaining('AppError'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a hidden 5xx still logs its real message server-side', () => {
    reply(new AppError('upstream detail', 502));
    expect(logger.error.mock.calls[0][0]).toBe('502 - upstream detail');
  });

  test('a 4xx is a warning, without the stack', () => {
    reply(new AppError('Camera not found.', 404));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).not.toHaveProperty('error');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('it answers the request and never calls next', () => {
    expect(reply(new Error('x')).next).not.toHaveBeenCalled();
  });
});
