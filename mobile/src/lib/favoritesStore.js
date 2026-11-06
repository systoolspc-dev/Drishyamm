// Favourite cameras (zustand, persisted).
//
// Deliberately DEVICE-LOCAL: the backend exposes no favourites endpoint (see
// src/lib/api.js), so rather than ship a control that silently does nothing,
// this persists to the same SecureStore the rest of the app uses. It is a real,
// working feature — it just doesn't sync across devices. When a server-side
// endpoint lands, only this file changes.
//
// Keyed by `monitorId`, which is the stable camera identity everywhere else in
// the app (streams, recordings, events all resolve against it).
import { create } from 'zustand';
import * as storage from './storage';

const KEY = 'drishyam.favorites';

export const useFavorites = create((set, get) => ({
  // Array rather than a Set so it serialises directly. Camera counts are in
  // the tens, so membership scans are irrelevant next to a render.
  ids: [],
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await storage.getItem(KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (Array.isArray(saved)) set({ ids: saved.filter((v) => v != null) });
    } catch {}
    finally { set({ hydrated: true }); }
  },

  toggle: (id) => {
    if (id == null) return;
    const { ids } = get();
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    set({ ids: next });
    storage.setItem(KEY, JSON.stringify(next));
  },

  clear: () => { set({ ids: [] }); storage.setItem(KEY, JSON.stringify([])); },
}));

// Subscribe to ONE camera's flag. Returns a boolean, so the component
// re-renders only when that specific camera's state flips — not whenever any
// other favourite changes.
export const useIsFavorite = (id) => useFavorites((s) => id != null && s.ids.includes(id));
