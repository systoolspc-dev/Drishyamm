export const FACE_WATCHLIST_STORAGE_KEY = 'drishyam-face-watchlist-entries';

export function loadStoredFaceWatchlistEntries() {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(FACE_WATCHLIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveStoredFaceWatchlistEntries(entries) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FACE_WATCHLIST_STORAGE_KEY, JSON.stringify(entries));
}

export function upsertStoredFaceWatchlistEntry(entry) {
  const current = loadStoredFaceWatchlistEntries();
  const next = [entry, ...current.filter((item) => item.id !== entry.id)];
  saveStoredFaceWatchlistEntries(next);
  return next;
}

export function makeFaceWatchlistId(seed = Date.now()) {
  return `WL-VH-${String(seed).slice(-6)}`;
}
