import { create } from 'zustand';

// Which hostel the Hostel vertical is viewing (boys | girls), persisted.
// Replaces the standalone app's HostelContext; every widget reads
// HOSTEL_DATA[hostel] / *_DATA[hostel].
export const useHostelStore = create((set) => ({
  hostel: (() => { try { return localStorage.getItem('hostel-select') || 'boys'; } catch { return 'boys'; } })(),
  setHostel: (h) => {
    try { localStorage.setItem('hostel-select', h); } catch { /* private mode */ }
    set({ hostel: h });
  },
}));
