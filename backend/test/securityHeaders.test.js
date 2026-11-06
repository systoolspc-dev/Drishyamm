const http = require('node:http');
const express = require('express');
const securityHeaders = require('../src/config/securityHeaders');

// Boot a minimal app with ONLY the real security-headers middleware, so the
// test asserts the actual production policy (not a copy of it).
function bootApp() {
  const app = express();
  app.use(securityHeaders);
  app.get('/', (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

describe('security headers policy', () => {
  let ctx, headers;

  beforeAll(async () => {
    ctx = await bootApp();
    const res = await fetch(`http://127.0.0.1:${ctx.port}/`);
    headers = res.headers;
  });

  afterAll(() => ctx.server.close());

  test('HSTS is set for a year with subdomains + preload', () => {
    const hsts = headers.get('strict-transport-security');
    expect(hsts).toMatch(/max-age=31536000/);
    expect(hsts).toMatch(/includeSubDomains/);
    expect(hsts).toMatch(/preload/);
  });

  test('a strict CSP locks scripts/framing down for the API', () => {
    const csp = headers.get('content-security-policy');
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/base-uri 'none'/);
  });

  test('clickjacking + sniffing + referrer protections are present', () => {
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN'); // helmet default; CSP frame-ancestors is the real gate
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('X-Powered-By is stripped (no framework fingerprint)', () => {
    expect(headers.get('x-powered-by')).toBeNull();
  });
});
