// Auth/session state (zustand). Tokens + user persist via SecureStore.
// hydrate() runs once at app boot before any navigation decision.
import { create } from 'zustand';
import * as storage from './storage';
import { KEYS } from './storage';
import { normalizeServerUrl, DEFAULT_SERVER_URL } from './config';

export const useAuth = create((set, get) => ({
  hydrated:   false,
  serverUrl:  '',
  token:      null,   // access token (short-lived)
  refresh:    null,   // refresh token (SINGLE-USE — rotated on every refresh)
  user:       null,

  hydrate: async () => {
    const [serverUrl, token, refresh, userJson] = await Promise.all([
      storage.getItem(KEYS.SERVER_URL),
      storage.getItem(KEYS.ACCESS_TOKEN),
      storage.getItem(KEYS.REFRESH_TOKEN),
      storage.getItem(KEYS.USER_JSON),
    ]);
    let user = null;
    try { user = userJson ? JSON.parse(userJson) : null; } catch {}
    // Fall back to the built-in production API so users never have to type a URL.
    set({ hydrated: true, serverUrl: serverUrl || DEFAULT_SERVER_URL, token, refresh, user });
  },

  setServerUrl: async (url) => {
    const clean = normalizeServerUrl(url);
    await storage.setItem(KEYS.SERVER_URL, clean);
    set({ serverUrl: clean });
  },

  setSession: async ({ token, refresh, user }) => {
    await Promise.all([
      storage.setItem(KEYS.ACCESS_TOKEN, token),
      storage.setItem(KEYS.REFRESH_TOKEN, refresh),
      user ? storage.setItem(KEYS.USER_JSON, JSON.stringify(user)) : Promise.resolve(),
    ]);
    set({ token, refresh, ...(user ? { user } : {}) });
  },

  clearSession: async () => {
    await Promise.all([
      storage.deleteItem(KEYS.ACCESS_TOKEN),
      storage.deleteItem(KEYS.REFRESH_TOKEN),
      storage.deleteItem(KEYS.USER_JSON),
    ]);
    set({ token: null, refresh: null, user: null });
  },
}));
