// Server + media URL handling.
//
// DEFAULT_SERVER_URL is the production API the app ships with — users just enter
// email + password (like Hik-Connect / CP Plus). The login "Advanced" option
// lets dev / self-hosted / LAN point somewhere else (e.g. 192.168.1.50:5000).
//
// This is the SAME backend the production console (https://demo.indyatools.com)
// talks to: that SPA uses a relative `/api` base (same origin), so the API
// lives at https://demo.indyatools.com/api. The mobile client appends `/api`
// itself (see client.js), so the server URL is the bare origin below.
// Verified live: GET https://demo.indyatools.com/api/health → {"status":"ok"}.
export const DEFAULT_SERVER_URL = 'https://demo.indyatools.com';

// ── STREAM CONCURRENCY BUDGET ────────────────────────────────────────────────
// The single number every screen budgets against. The demo NVR tolerates
// ~6-7 concurrent pulls TOTAL across all clients, and phones can only decode a
// few HLS streams smoothly. Exceeding it doesn't degrade gracefully — cameras
// start dropping for EVERY client, not just this phone.
//
// Every per-screen constant below is derived from this and must not exceed it.
// Screens also focus-gate (useIsFocused) so only the visible one holds pulls,
// and stagger connects so a page never hits the recorder as a herd.
export const MAX_CONCURRENT_STREAMS = 6;

// Home overview: group cards share this budget across all their preview strips.
// Doubles as Home's grid SIZE (OVERVIEW_TILES), so changing it reshapes that
// screen's layout — which is why the Cameras page has its own constant below.
export const MAX_LIVE_TILES = 4;

// Cameras page: how many tiles may stream at once on the full device grid.
//
// ⚠️ DELIBERATELY UNCAPPED — set above MAX_CONCURRENT_STREAMS on purpose, by
// product decision, so every ONLINE camera on the Cameras page streams. This is
// the one number in this file that knowingly exceeds the recorder's ceiling.
//
// What to expect, and what to check before blaming the app:
//   · The recorder tolerates ~6-7 pulls TOTAL ACROSS ALL CLIENTS. Above that it
//     sheds pulls, so tiles flip to NO SIGNAL at random — and so does the web
//     console and every other client on the same NVR.
//   · Each tile is a separate HLS decode. Mid-range Android stutters or drops
//     the app somewhere around 6-8 simultaneous decoders regardless of server.
//   · streamBudget logs a warning naming every holder each time the ceiling is
//     crossed. That log is the evidence — read it before changing anything.
//
// TO REVERT: set this back to 6. CamerasScreen then automatically resumes
// rationing slots to the tiles actually on screen (see its `liveIds`), so no
// other code has to change.
export const GRID_LIVE_TILES = Infinity;

// Live tab: ONE hero player + this many grid previews, i.e. a 2×2 grid under
// the hero. 1 + 4 = 5 concurrent — inside the ceiling, but with only one slot
// of headroom, so the Home→Live transition is the case to watch. streamBudget
// reports it if the two screens ever overlap for longer than a teardown.
export const LIVE_TAB_TILES = 4;

// Live Wall page size — one screen shows a fixed 8-tile grid (2×4 portrait,
// 4×2 landscape), VMS style. ⚠️ THE ONE DOCUMENTED EXCEPTION to
// MAX_CONCURRENT_STREAMS: 8 is above the observed ceiling. Mitigations:
// sub-streams only, staggered connects, and only the focused page of the
// focused screen streams. If cameras start dropping while the wall is open,
// dial this back to 6. Kept as-is because it is existing, shipped behaviour —
// changing it is a product decision, not a refactor.
export const WALL_LIVE_TILES = 8;

// Media URLs must always come from GET /api/stream/start — never built by hand
// (they may point at transcoded _h264 or sub paths depending on codec).
//
// The backend currently returns them RELATIVE ("/hls/cam_x/index.m3u8"), which
// is the good shape: joined onto the API origin they ride the same host, port
// and TLS that already work. Older/self-hosted builds return them absolute with
// a server-local host ("http://localhost:8898/…"); "localhost" on a phone is
// the phone, so that host gets swapped. rewriteMediaUrl handles both.
//
// NOTE for self-hosted deployments behind Cloudflare: the proxy only forwards
// HTTPS on 443, 2053, 2083, 2087, 2096 and 8443. An absolute media URL on 8898
// will be silently unreachable while the API on 443 works perfectly — the
// "camera list loads, preview never does" signature. lib/log.js warns about it.

export function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  // strip trailing slashes and a trailing /api if the user pasted it
  s = s.replace(/\/+$/, '').replace(/\/api$/i, '');
  return s;
}

// Everything below is deliberately STRING-ONLY — no `new URL()`.
//
// React Native ships a partial URL polyfill (Libraries/Blob/URL.js) with
// GETTERS BUT NO SETTERS. The previous implementation did `m.hostname = h`,
// which throws TypeError in strict mode (modules are strict), landed in the
// catch, and returned the URL untouched — so the localhost rewrite silently
// never ran. The same polyfill also throws on a relative path, which is how
// "/hls/cam_x/index.m3u8" reached the player verbatim and was opened as a
// LOCAL FILE: `FileNotFoundException … ENOENT`.
const ABSOLUTE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** Hostname of a server URL, without scheme, userinfo or port. '' if unparseable. */
export function serverHost(serverUrl) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(serverUrl || ''));
  if (!m) return '';
  const authority = m[1].slice(m[1].lastIndexOf('@') + 1); // drop user:pass@
  return authority.replace(/:\d+$/, '');                   // drop :port
}

/**
 * Turn whatever the backend hands back into something this device can fetch.
 *
 * Two shapes arrive in practice:
 *   1. RELATIVE — "/hls/cam_x/index.m3u8". Current backend behaviour. Joined
 *      onto the server we authenticated against, so it rides the same origin
 *      and port as the API (and therefore the same TLS/proxy that already works).
 *   2. ABSOLUTE with a server-local host — "http://localhost:8898/…", built
 *      from the SERVER's env. "localhost" on a phone is the phone, so the host
 *      is swapped for the one we're talking to. Port is preserved.
 */
export function rewriteMediaUrl(mediaUrl, serverUrl) {
  if (mediaUrl == null) return null;
  const raw = String(mediaUrl).trim();
  if (!raw) return null;

  if (!ABSOLUTE_RE.test(raw)) {
    const base = String(serverUrl || '').replace(/\/+$/, '');
    if (!base) return null; // no server yet — a bare path is unusable
    return `${base}/${raw.replace(/^\/+/, '')}`;
  }

  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]+)/i, (full, scheme, authority) => {
    const at = authority.lastIndexOf('@');
    const creds = at >= 0 ? authority.slice(0, at + 1) : '';
    const hostPort = authority.slice(creds.length);
    const portM = /:\d+$/.exec(hostPort);
    const port = portM ? portM[0] : '';
    const host = port ? hostPort.slice(0, -port.length) : hostPort;
    if (!LOCAL_HOSTS.has(host.toLowerCase())) return full;
    const target = serverHost(serverUrl);
    return target ? `${scheme}${creds}${target}${port}` : full;
  });
}
