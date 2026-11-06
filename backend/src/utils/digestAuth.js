/**
 * Minimal HTTP Digest auth client.
 *
 * Hikvision ISAPI and Dahua CGI both default to Digest, not Basic. axios has no
 * built-in Digest support, so we do the two-roundtrip dance ourselves:
 *
 *   1. Send the request without auth → 401 with WWW-Authenticate: Digest ...
 *   2. Parse the challenge, compute response, retry with Authorization: Digest
 *
 * Supports MD5 and MD5-sess algorithms with auth qop. That covers every NVR /
 * IPC firmware we've seen in the field; SHA-256 (RFC 7616) is rare on cameras
 * and can be added if/when a device shows up that requires it.
 */

const crypto = require('node:crypto');
const axios  = require('axios');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseChallenge(headerValue) {
  if (!headerValue) return null;
  const value = String(headerValue).trim();
  if (!/^digest\s/i.test(value)) return null;
  const params = {};
  // Match key=value or key="value" pairs allowing for whitespace
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]+))/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  }
  return params;
}

function buildAuthHeader({ method, path, username, password, challenge }) {
  const realm  = challenge.realm  || '';
  const nonce  = challenge.nonce  || '';
  const opaque = challenge.opaque;
  const algo   = (challenge.algorithm || 'MD5').toUpperCase();
  const qopRaw = challenge.qop || '';
  const qop    = qopRaw.split(',').map((q) => q.trim()).find((q) => q === 'auth') || '';

  // ha1
  let ha1 = md5(`${username}:${realm}:${password}`);
  if (algo === 'MD5-SESS') {
    const cnonce = crypto.randomBytes(8).toString('hex');
    ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  }
  const ha2 = md5(`${method}:${path}`);

  let response;
  let nc = '00000001';
  let cnonce = crypto.randomBytes(8).toString('hex');
  if (qop) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${path}"`,
    `algorithm=${algo}`,
    `response="${response}"`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${nc}`);
    parts.push(`cnonce="${cnonce}"`);
  }
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

/**
 * Send a request that may be challenged with HTTP Digest. Falls back to Basic
 * if the device doesn't require auth. Both 401 (auth required) and 200 (no
 * auth required) outcomes return the final response.
 *
 * Options:
 *   url        full URL
 *   method     'GET' (default) or 'POST'
 *   data       request body
 *   timeout    ms (default 5000)
 *   headers    extra headers
 *   username   credentials
 *   password
 *   responseType  'text' (default) | 'arraybuffer' | 'json'
 */
async function digestRequest({
  url,
  method = 'GET',
  data,
  timeout = 5000,
  headers = {},
  username,
  password,
  responseType = 'text',
} = {}) {
  const u = new URL(url);
  const path = `${u.pathname}${u.search}`;
  const baseConfig = {
    url, method, data, timeout, headers,
    responseType: responseType === 'text' ? 'text' : responseType,
    transformResponse: [(d) => d],     // never auto-parse JSON
    validateStatus: () => true,        // we want to see 401s, not throw
  };

  // First request: no Authorization header
  const first = await axios(baseConfig);
  if (first.status !== 401) return first;

  const challenge = parseChallenge(first.headers['www-authenticate']);
  if (!challenge) {
    // Server returned 401 without a Digest challenge — try Basic as fallback
    const basicHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    return axios({
      ...baseConfig,
      headers: { ...headers, Authorization: basicHeader },
    });
  }

  const auth = buildAuthHeader({ method, path, username, password, challenge });
  return axios({
    ...baseConfig,
    headers: { ...headers, Authorization: auth },
  });
}

module.exports = { digestRequest };
