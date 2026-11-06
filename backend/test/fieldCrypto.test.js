const KEY = 'ANPwLJ93nQHkPEKtTr+9a37RxHUt729LsDGO8ThiqKE='; // test-only 32-byte b64

describe('fieldCrypto with a key set', () => {
  let fc;
  beforeAll(() => {
    jest.resetModules();
    process.env.CAMERA_CRED_KEY = KEY;
    fc = require('../src/utils/fieldCrypto');
  });
  afterAll(() => { delete process.env.CAMERA_CRED_KEY; });

  test('round-trips a value and tags the ciphertext', () => {
    const enc = fc.encrypt('admin$ecret!');
    expect(enc.startsWith(fc.PREFIX)).toBe(true);
    expect(enc).not.toContain('admin$ecret!');
    expect(fc.decrypt(enc)).toBe('admin$ecret!');
  });

  test('enabled() is true', () => expect(fc.enabled()).toBe(true));

  test('passes through null/empty', () => {
    expect(fc.encrypt('')).toBe('');
    expect(fc.encrypt(null)).toBeNull();
    expect(fc.decrypt(null)).toBeNull();
  });

  test('legacy plaintext (no prefix) decrypts to itself', () => {
    expect(fc.decrypt('oldPlainPassword')).toBe('oldPlainPassword');
  });

  test('does not double-encrypt an already-encrypted value', () => {
    const once = fc.encrypt('p');
    expect(fc.encrypt(once)).toBe(once);
  });

  test('detects tampering (auth tag)', () => {
    const enc = fc.encrypt('secret');
    const tampered = `${enc.slice(0, -4)}AAAA`;
    expect(() => fc.decrypt(tampered)).toThrow();
  });
});

describe('fieldCrypto with NO key (migration window)', () => {
  let fc;
  beforeAll(() => {
    jest.resetModules();
    delete process.env.CAMERA_CRED_KEY;
    fc = require('../src/utils/fieldCrypto');
  });

  test('enabled() is false and encrypt is a passthrough', () => {
    expect(fc.enabled()).toBe(false);
    expect(fc.encrypt('plain')).toBe('plain');
  });

  test('legacy plaintext still reads', () => {
    expect(fc.decrypt('plain')).toBe('plain');
  });

  test('a tagged value with no key throws (never returns scrambled)', () => {
    expect(() => fc.decrypt('enc:v1:AAAA')).toThrow(/CAMERA_CRED_KEY is unset/);
  });
});
