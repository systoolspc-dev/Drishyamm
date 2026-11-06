import { create } from 'zustand';

// "Recent investigations" on the dashboard — a local trail of what this operator
// last did: a search they ran, a quick action they opened, a camera they
// watched. Kept in localStorage because there is no server-side history API;
// same pattern as dashboard.pinnedCameras / dashboard.cameraViews.
const KEY = 'dashboard.recentInvestigations';
const MAX = 8;

// An earlier build wrote a different record shape to this same key
// (label/meta/at instead of kind/detail/ts). Reading those raw produced rows
// with every field undefined — blank text, a broken timestamp, and a React key
// of "undefined-undefined-undefined" that collided across every stale row. Map
// the old field names across, then drop anything still missing the parts a row
// needs, so an upgrading operator keeps their history instead of seeing junk.
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind ?? raw.label;
  const to = raw.to;
  const ts = Number(raw.ts ?? raw.at);
  if (!kind || !to || !Number.isFinite(ts)) return null;
  return { key: raw.key ?? raw.iconKey ?? '', kind, detail: raw.detail ?? raw.meta ?? '', to, ts };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(normalize).filter(Boolean).slice(0, MAX);
  } catch { return []; }
}
function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota */ }
}

export const useInvestigationStore = create((set) => ({
  items: load(),

  // key    — which quick action it was, so the row can pick its icon
  // kind   — what was done ("Vehicle Search")
  // detail — what it was done on ("DL01AB1234", a camera name)
  // to     — where to go to repeat it
  record: ({ key, kind, detail = '', to }) => set((s) => {
    // Re-opening the same thing moves it back to the top rather than stacking
    // four identical rows.
    const rest = s.items.filter((i) => !(i.kind === kind && i.detail === detail));
    const list = [{ key, kind, detail, to, ts: Date.now() }, ...rest].slice(0, MAX);
    save(list);
    return { items: list };
  }),

  clear: () => {
    save([]);
    set({ items: [] });
  },
}));
