// Diagnostic log.
//
// WHY THIS EXISTS: every failure in the streaming path was being swallowed.
// `player.replaceAsync(uri).catch(() => {})` appeared in six places, and
// expo-video's `statusChange` event carries a `PlayerError` that nothing read.
// The result was a tile that said "No preview" and an operator with no way to
// find out why — on a device with no debugger attached, in a building with a
// recorder that may or may not be reachable.
//
// Everything lands in the console AND in a small ring buffer, so a failure that
// happened 30 seconds ago is still recoverable via getLog() rather than needing
// to be reproduced with Metro open.

const MAX_ENTRIES = 200;
const ring = [];

function push(level, scope, message, data) {
  const entry = { at: new Date().toISOString(), level, scope, message, data };
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) ring.shift();

  const tag = `[${scope}]`;
  if (level === 'error') console.warn(tag, message, data ?? '');
  else console.log(tag, message, data ?? '');
  return entry;
}

export const log = (scope, message, data) => push('info', scope, message, data);
export const warn = (scope, message, data) => push('warn', scope, message, data);

/** Newest first — for an in-app diagnostics view or a bug report. */
export const getLog = () => [...ring].reverse();
export const clearLog = () => { ring.length = 0; };

// Pull the useful parts out of whatever was thrown. Axios errors hide the
// interesting bit three levels down; expo-video's PlayerError only has
// `message`; a bare network failure has neither.
export function describeError(e) {
  if (!e) return { message: 'unknown error' };

  // axios
  if (e.isAxiosError || e.config) {
    const res = e.response;
    return {
      kind: 'http',
      method: (e.config?.method || 'get').toUpperCase(),
      url: `${e.config?.baseURL || ''}${e.config?.url || ''}`,
      status: res?.status ?? null,
      // A 5xx from a proxy is usually plain text, not the backend's JSON shape
      body: typeof res?.data === 'string' ? res.data.slice(0, 200) : res?.data?.message ?? null,
      code: e.code || null,
      message: e.message,
    };
  }

  return { kind: 'error', message: e.message || String(e), name: e.name || null };
}

export function logError(scope, message, e) {
  return push('error', scope, message, describeError(e));
}

// ── media URL sanity ─────────────────────────────────────────────────────────
// Cloudflare's proxy only forwards HTTPS on 443, 2053, 2083, 2087, 2096 and
// 8443. The backend hands back media URLs on 8898 (HLS) / 8889 (WHEP), so a
// deployment fronted by Cloudflare silently drops EVERY stream while the API
// itself works perfectly — the exact "camera list loads, preview never does"
// signature. This is a deployment fault, not a bug in the app, and it is
// invisible unless something says so out loud.
const CF_HTTPS_PORTS = new Set(['443', '2053', '2083', '2087', '2096', '8443']);

export function checkMediaUrl(label, url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (u.protocol === 'https:' && !CF_HTTPS_PORTS.has(port)) {
      warn('stream', `${label} uses https port ${port} — blocked if this host is behind a Cloudflare proxy`, { url });
      return { ok: false, reason: 'non-proxiable-port', port, url };
    }
    return { ok: true, port, url };
  } catch {
    warn('stream', `${label} is not a valid URL`, { url });
    return { ok: false, reason: 'unparseable', url };
  }
}
