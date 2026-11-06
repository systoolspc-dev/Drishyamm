// Secure persistence for auth/session values.
// Native: expo-secure-store (Keychain / Android Keystore).
// Web (Expo web preview): falls back to localStorage — dev convenience only.
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const canSecure = Platform.OS !== 'web';

export async function getItem(key) {
  try {
    if (canSecure) return await SecureStore.getItemAsync(key);
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch { return null; }
}

export async function setItem(key, value) {
  try {
    if (value == null) return deleteItem(key);
    if (canSecure) return await SecureStore.setItemAsync(key, String(value));
    globalThis.localStorage?.setItem(key, String(value));
  } catch {}
}

export async function deleteItem(key) {
  try {
    if (canSecure) return await SecureStore.deleteItemAsync(key);
    globalThis.localStorage?.removeItem(key);
  } catch {}
}

export const KEYS = {
  SERVER_URL:    'drishyam.serverUrl',
  ACCESS_TOKEN:  'drishyam.accessToken',
  REFRESH_TOKEN: 'drishyam.refreshToken',
  USER_JSON:     'drishyam.user',
};
