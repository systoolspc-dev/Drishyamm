// Typed-ish API layer — response shapes verified against the backend source
// (see CONTEXT.md §6 and smart-cam-backend/docs/FRONTEND_INTEGRATION.md).
import { api } from './client';
import { useAuth } from './authStore';
import { rewriteMediaUrl } from './config';
import { log, checkMediaUrl } from './log';

// ── Auth ─────────────────────────────────────────────────────────────────────
// login → { success, user, token, refreshToken }
export async function login(email, password) {
  const { data } = await api.post('/auth/login', { email, password });
  return data;
}

export async function logout() {
  const { refresh } = useAuth.getState();
  try { await api.post('/auth/logout', { refreshToken: refresh }); } catch {}
}

export async function me() {
  const { data } = await api.get('/auth/me');
  return data.user ?? data;
}

// ── Cameras / groups ─────────────────────────────────────────────────────────
// listGroups → { success, data: [ group { id, name, host, status, cameras: [...] } ] }
export async function listGroups() {
  const { data } = await api.get('/groups');
  return data.data || [];
}

// ── Streaming ────────────────────────────────────────────────────────────────
// startStream → { ok, webrtcUrl, hlsUrl, hlsSubUrl, codec, transcoded, ... }
// Media hosts are rewritten so "localhost" from the server env works on-device.
export async function startStream(monitorId) {
  const { serverUrl } = useAuth.getState();
  const { data } = await api.get(`/stream/start/${monitorId}`, { timeout: 30000 });
  const out = {
    ...data,
    webrtcUrl: rewriteMediaUrl(data.webrtcUrl, serverUrl),
    hlsUrl:    rewriteMediaUrl(data.hlsUrl, serverUrl),
    hlsSubUrl: rewriteMediaUrl(data.hlsSubUrl, serverUrl),
    masterUrl: rewriteMediaUrl(data.masterUrl, serverUrl),
  };
  // The media URLs come back built from the SERVER's env and are then rewritten
  // onto the host the app is talking to — so this is the first moment anyone
  // can see what the player will actually be asked to fetch. Log it, and check
  // the port is one a proxy will forward (see checkMediaUrl).
  log('stream', `start ${monitorId}`, {
    codec: data.codec, transcoded: data.transcoded,
    hlsUrl: out.hlsUrl, hlsSubUrl: out.hlsSubUrl,
  });
  checkMediaUrl(`camera ${monitorId} hlsUrl`, out.hlsUrl);
  checkMediaUrl(`camera ${monitorId} hlsSubUrl`, out.hlsSubUrl);
  return out;
}

export async function stopStream(monitorId) {
  try { await api.get(`/stream/stop/${monitorId}`); } catch {}
}

// ── Recordings / playback ────────────────────────────────────────────────────
// list → { success, data: [{ key, cameraName, monitorId, date, filename, size, lastModified }] }
export async function listRecordings(groupId, monitorId, date) {
  const { data } = await api.get(`/groups/${groupId}/cameras/${monitorId}/recordings`, { params: date ? { date } : {} });
  return data.data || [];
}

// play → { success, playbackUrl } — either a presigned absolute URL or a
// relative /api/...stream proxy path (needs ?token= since <video> can't send headers)
export async function getPlaybackUrl(groupId, key) {
  const { serverUrl, token } = useAuth.getState();
  const { data } = await api.get(`/groups/${groupId}/recordings/play`, { params: { key } });
  let url = data.playbackUrl;
  if (url && url.startsWith('/')) {
    url = `${serverUrl}${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }
  return rewriteMediaUrl(url, serverUrl);
}

// first-frame JPEG for a clip (auth via ?token= — used directly as an Image uri)
export function recordingThumbUrl(groupId, key) {
  const { serverUrl, token } = useAuth.getState();
  return `${serverUrl}/api/groups/${groupId}/recordings/thumbnail?key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
}

// evidence JPEG for an AI event → { success, url } (presigned, ~1h; null if none)
export async function getEventSnapshotUrl(eventId) {
  const { serverUrl } = useAuth.getState();
  const { data } = await api.get(`/ai/events/${eventId}/snapshot`);
  return data.url ? rewriteMediaUrl(data.url, serverUrl) : null;
}

// ── AI alarms ────────────────────────────────────────────────────────────────
// listEvents → { success, data: [event], pagination }
export async function listAiEvents({ limit = 50, severity } = {}) {
  const params = { limit };
  if (severity) params.severity = severity;
  const { data } = await api.get('/ai/events', { params });
  return data.data || [];
}

// ── Push notifications ─────────────────────────────────────────────────────
// Register this device's Expo push token so the backend can alert it even when
// the app is backgrounded/killed. Idempotent server-side (upsert by token).
export async function registerPushToken({ token, platform, deviceName }) {
  const { data } = await api.post('/notifications/register', { token, platform, deviceName });
  return data;
}

export async function unregisterPushToken(token) {
  try { await api.post('/notifications/unregister', { token }); } catch {}
}

// ── Admin: users & roles ─────────────────────────────────────────────────────
// ADMIN ONLY. Server-side the whole /admin router is `router.use(authenticate,
// adminAuth)` and adminAuth throws 403 unless `req.user.role === 'admin'`, so
// every call here fails for anyone else. Callers must gate the UI on the
// SESSION role rather than discovering it through a rejected request.
//
// These wrap routes that already exist on the backend — nothing new was added
// there. The admin API exposes exactly three user operations: list, read one,
// and flip active/suspended. There is NO create, NO update and NO
// password-reset route, which is why the app offers no such actions.

/** GET /admin/users → [{ id, name, email, role, isActive, status, joined,
 *  cameras, plan, mrr, emailVerified }] */
export async function listUsers() {
  const { data } = await api.get('/admin/users');
  return data.users || [];
}

/** GET /admin/users/:id → { user, cameras[], subscription|null }.
 *  `cameras` carry their group, which is the only source of a user's SITES. */
export async function getUserDetail(id) {
  const { data } = await api.get(`/admin/users/${id}`);
  return { user: data.user || null, cameras: data.cameras || [], subscription: data.subscription || null };
}

/** PUT /admin/users/:id/toggle-status → { id, isActive, status }.
 *  A TOGGLE, not a setter: it flips whatever the server currently holds. The
 *  server refuses to suspend another admin (403) — surface that message rather
 *  than reporting a success the account never had. */
export async function toggleUserStatus(id) {
  const { data } = await api.put(`/admin/users/${id}/toggle-status`);
  return data.user;
}

// Health ping — used by the login screen's "test connection".
export async function pingServer() {
  const { data } = await api.get('/health', { timeout: 6000 });
  return data?.status === 'ok';
}
