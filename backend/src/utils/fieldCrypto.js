/**
 * fieldCrypto — transparent AES-256-GCM for sensitive DB columns (camera creds).
 *
 * Encrypts on write, decrypts on read, via Sequelize get/set. Design goals:
 *   - Fail-open MIGRATION window: when CAMERA_CRED_KEY is UNSET, encrypt() is a
 *     passthrough and decrypt() returns the value as-is, so existing plaintext
 *     rows keep working and enabling the key is a gradual rollout (new writes
 *     encrypt; old rows re-encrypt the next time they're saved).
 *   - Tagged ciphertext (`enc:v1:`) so a value is self-describing: decrypt() can
 *     tell an encrypted value from a legacy plaintext one and only decrypts the
 *     former. A tagged value with the key unset THROWS (don't return scrambled).
 *   - AES-256-GCM (authenticated) so tampering is detected, not silently decoded.
 *
 * Key: CAMERA_CRED_KEY = base64 of exactly 32 random bytes.
 *   generate:  openssl rand -base64 32
 * Mirrors smart-cam-ai/vms_face/core/crypto.py so both stores use the same scheme.
 */
const crypto = require('node:crypto');
const logger = require('../config/logger');

const PREFIX = 'enc:v1:';
const NONCE_LEN = 12;

let _key = null;
let _resolved = false;

function key() {
  if (_resolved) return _key;
  _resolved = true;
  const raw = process.env.CAMERA_CRED_KEY;
  if (!raw) { _key = null; return _key; }
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      logger.error('fieldCrypto: CAMERA_CRED_KEY must decode to 32 bytes; encryption DISABLED', { got: buf.length });
      _key = null;
    } else {
      _key = buf;
    }
  } catch (e) {
    logger.error('fieldCrypto: CAMERA_CRED_KEY not valid base64; encryption DISABLED', { error: e.message });
    _key = null;
  }
  return _key;
}

/** True when a usable key is configured (new writes will be encrypted). */
function enabled() {
  return key() !== null;
}

/** Encrypt a plaintext string. Passthrough for null/empty or when no key is set. */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  const k = key();
  if (!k) return plaintext;                       // migration window: store plaintext
  if (typeof plaintext === 'string' && plaintext.startsWith(PREFIX)) return plaintext; // already encrypted
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, nonce);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([nonce, ct, tag]).toString('base64');
}

/** Decrypt a value. Legacy plaintext (no prefix) is returned unchanged. */
function decrypt(value) {
  if (value == null || value === '') return value;
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value; // legacy plaintext
  const k = key();
  if (!k) throw new Error('fieldCrypto: encrypted value encountered but CAMERA_CRED_KEY is unset');
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  if (raw.length <= NONCE_LEN + 16) throw new Error('fieldCrypto: ciphertext too short');
  const nonce = raw.subarray(0, NONCE_LEN);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(NONCE_LEN, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, enabled, PREFIX };
