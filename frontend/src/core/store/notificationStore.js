import { create } from 'zustand';

// Persistent notification centre — camera offline/online + AI alerts land here so
// they survive past the ephemeral toast, and the bell shows a history + unread count.
const KEY = 'drishyam.notifications';
const MAX = 60;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* quota */ }
}

export const useNotificationStore = create((set) => ({
  notifications: load(),

  add: (n) => set((s) => {
    const item = {
      id: n.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      read: false,
      ts: n.ts || Date.now(),
      ...n,
    };
    const list = [item, ...s.notifications].slice(0, MAX);
    save(list);
    return { notifications: list };
  }),

  markAllRead: () => set((s) => {
    const list = s.notifications.map((x) => (x.read ? x : { ...x, read: true }));
    save(list);
    return { notifications: list };
  }),

  remove: (id) => set((s) => {
    const list = s.notifications.filter((x) => x.id !== id);
    save(list);
    return { notifications: list };
  }),

  clear: () => { save([]); set({ notifications: [] }); },
}));
