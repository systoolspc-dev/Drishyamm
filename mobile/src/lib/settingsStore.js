// App settings (zustand, persisted). `quality` is the GLOBAL stream-quality
// preference — it applies to every camera's player on this server connection:
//   'auto' → HD on Wi-Fi, SD on cellular · 'main' → always HD · 'sub' → always SD
// Toggling HD/SD inside any player writes back here, so one choice covers all
// cameras. `buzz` gates the vibration+toast on new alarms (AlertWatcher).
// `theme` is the appearance preference read by ThemeProvider:
//   'system' → follow the device · 'light' / 'dark' → explicit user choice.
// It lives here rather than in its own store so it shares the one persisted
// blob and the one hydrate() the app already awaits before first paint.
import { create } from 'zustand';
import * as storage from './storage';

const KEY = 'drishyam.settings';
const THEMES = ['system', 'light', 'dark'];

export const useSettings = create((set, get) => ({
  quality: 'auto', // 'auto' | 'main' | 'sub'
  buzz: true,
  theme: 'system', // 'system' | 'light' | 'dark'

  // App.jsx holds the native splash until this flips, so the restored theme is
  // applied BEFORE the first frame — there is no window in which a light UI
  // could be painted for a dark-mode user.
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await storage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        set({
          quality: ['auto', 'main', 'sub'].includes(saved.quality) ? saved.quality : 'auto',
          buzz: saved.buzz !== false,
          theme: THEMES.includes(saved.theme) ? saved.theme : 'system',
        });
      }
    } catch {}
    // Always release the splash, even if storage is unreadable — falling back
    // to defaults beats hanging on the splash screen forever.
    finally { set({ hydrated: true }); }
  },
  setQuality: (quality) => { set({ quality }); persist(get); },
  setBuzz: (buzz) => { set({ buzz }); persist(get); },
  setTheme: (theme) => {
    if (!THEMES.includes(theme)) return;
    set({ theme });
    persist(get);
  },
}));

function persist(get) {
  const { quality, buzz, theme } = get();
  storage.setItem(KEY, JSON.stringify({ quality, buzz, theme }));
}

// Resolve the preference to a concrete stream for THIS moment/network.
export function resolveQuality(pref, netType) {
  if (pref === 'main' || pref === 'sub') return pref;
  return netType === 'wifi' || netType === 'ethernet' || netType == null ? 'main' : 'sub';
}
