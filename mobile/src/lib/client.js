// Axios client for the Drishyam backend.
//
// - baseURL is dynamic (per-request) from the auth store's serverUrl → `${server}/api`
// - attaches Authorization: Bearer <access token>
// - on 401: single-flight refresh (POST /auth/refresh-token) then retry once.
//   IMPORTANT: the backend ROTATES refresh tokens (single-use). Concurrent 401s
//   must share ONE refresh call — a second refresh with the old token would be
//   rejected and nuke the session. `refreshing` below is that single flight.
import axios from 'axios';
import { useAuth } from './authStore';
import { logError } from './log';

export const api = axios.create({ timeout: 15000 });

api.interceptors.request.use((cfg) => {
  const { serverUrl, token } = useAuth.getState();
  if (!cfg.baseURL) cfg.baseURL = `${serverUrl}/api`;
  if (token && !cfg.headers.Authorization) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

let refreshing = null;

async function doRefresh() {
  const { serverUrl, refresh, setSession, clearSession } = useAuth.getState();
  if (!refresh) throw new Error('no refresh token');
  try {
    // raw axios — must NOT go through our interceptors
    const { data } = await axios.post(
      `${serverUrl}/api/auth/refresh-token`,
      { refreshToken: refresh },
      { timeout: 15000 }
    );
    // backend shape: { success, token, refreshToken } (rotated pair)
    await setSession({ token: data.token, refresh: data.refreshToken });
    return data.token;
  } catch (e) {
    await clearSession(); // refresh dead → force re-login
    throw e;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config || {};
    const status = error.response?.status;
    // Log EVERY failed request. A 401 that is about to be retried is logged too
    // — a refresh loop is exactly the kind of thing that is invisible otherwise.
    logError('api', `${(original.method || 'get').toUpperCase()} ${original.url || '?'} failed`, error);
    if (status === 401 && !original._retried && useAuth.getState().refresh) {
      original._retried = true;
      refreshing = refreshing || doRefresh().finally(() => { refreshing = null; });
      const newToken = await refreshing; // throws if refresh failed (session cleared)
      original.headers = { ...(original.headers || {}), Authorization: `Bearer ${newToken}` };
      return api(original);
    }
    return Promise.reject(error);
  }
);

/** Human message from an API error (backend shape: {success:false, message}). */
export function apiErrorMessage(e, fallback = 'Something went wrong') {
  // Timed out
  if (e?.code === 'ECONNABORTED') {
    return 'Server took too long to respond. Check the address in Advanced settings.';
  }
  // No HTTP response at all → network / DNS / wrong address
  if (!e?.response) {
    return 'Cannot reach the server. Check your network and the server address (Advanced).';
  }
  const status = e.response.status;
  // Cloudflare / reverse-proxy "origin down" family (530 = tunnel down)
  if ([502, 503, 504, 520, 521, 522, 523, 524, 530].includes(status)) {
    return 'Server is unreachable right now (gateway error). Try again shortly, or set your local server in Advanced.';
  }
  // 404 with no API JSON body → reached a server, but not the Drishyam API
  // (classic: pointed at the web app :5173 instead of the API :5000).
  if (status === 404 && !e.response.data?.message) {
    return 'This address is not the Drishyam API. Check the server and port in Advanced (the API port is usually :5000, not the web app :5173).';
  }
  // Backend's own JSON error message wins when present
  return e.response.data?.message || `Request failed (HTTP ${status})`;
}
