const { audit, actorFrom, _auditLogger } = require('../src/utils/audit');

describe('audit — actor extraction', () => {
  test('pulls principal + request fingerprint off the request', () => {
    const req = {
      user: { id: 7, email: 'admin@x.io', role: 'admin' },
      ip: '10.0.0.9',
      headers: { 'user-agent': 'jest' },
    };
    expect(actorFrom(req)).toEqual({
      userId: 7, email: 'admin@x.io', role: 'admin', ip: '10.0.0.9', userAgent: 'jest',
    });
  });

  test('handles unauthenticated / malformed requests without throwing', () => {
    expect(actorFrom(undefined)).toEqual({ userId: null, email: null, role: null, ip: null, userAgent: null });
    expect(actorFrom({})).toEqual({ userId: null, email: null, role: null, ip: null, userAgent: null });
  });

  test('accepts the alternate userId shape (u.userId)', () => {
    expect(actorFrom({ user: { userId: 42 } }).userId).toBe(42);
  });
});

describe('audit — emits a structured entry', () => {
  let captured;
  let spy;

  beforeEach(() => {
    captured = [];
    spy = jest.spyOn(_auditLogger, 'info').mockImplementation((info) => { captured.push(info); });
  });
  afterEach(() => spy.mockRestore());

  test('records action, actor, target, outcome and extra meta', () => {
    audit('user.status.toggled', {
      req: { user: { id: 1, email: 'a@b.c', role: 'admin' }, ip: '1.2.3.4', headers: {} },
      targetType: 'user',
      targetId: 99,
      meta: { status: 'suspended' },
    });
    expect(captured).toHaveLength(1);
    const e = captured[0];
    expect(e.action).toBe('user.status.toggled');
    expect(e.actor.userId).toBe(1);
    expect(e.target).toEqual({ type: 'user', id: '99' }); // id coerced to string
    expect(e.outcome).toBe('success'); // default
    expect(e.status).toBe('suspended');
  });

  test('defaults outcome to success and stringifies null target id safely', () => {
    audit('user.password.changed', { req: {} });
    expect(captured[0].outcome).toBe('success');
    expect(captured[0].target).toEqual({ type: null, id: null });
  });
});

describe('audit — must never break the request path', () => {
  test('swallows a logger failure instead of throwing', () => {
    const spy = jest.spyOn(_auditLogger, 'info').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => audit('anything', { req: {} })).not.toThrow();
    spy.mockRestore();
  });

  test('does not throw on completely empty options', () => {
    expect(() => audit('x')).not.toThrow();
  });
});
