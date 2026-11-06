// Stills for the Monitor Wall editor's tiles.
//
// One cache for the whole app session, shared by every tile and every mount,
// so paging through the wall or coming back to the page doesn't re-grab. The
// server also caches (60 s) and never runs more than one grab per recorder
// at a time; this side only caps requests in flight and paces refreshes.

import { useEffect, useSyncExternalStore } from 'react';
import api from '@/core/services/api';

const REFRESH_MS = 120_000;
const MAX_IN_FLIGHT = 3;

const cache = new Map();      // monitorId → { url, at: Date, stale, fetchedAt, error }
const pending = new Set();
const queue = [];
const listeners = new Set();
let active = 0;

const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function pump() {
  while (active < MAX_IN_FLIGHT && queue.length) {
    const id = queue.shift();
    active += 1;
    api.get(`/stream/snapshot/${encodeURIComponent(id)}`, { responseType: 'blob', timeout: 30_000 })
      .then((res) => {
        const prev = cache.get(id);
        if (prev?.url) URL.revokeObjectURL(prev.url);
        cache.set(id, {
          url: URL.createObjectURL(res.data),
          at: new Date(res.headers['x-snapshot-at'] || Date.now()),
          stale: res.headers['x-snapshot-stale'] === '1',
          fetchedAt: Date.now(),
          error: null,
        });
      })
      .catch((err) => {
        cache.set(id, { ...(cache.get(id) || {}), fetchedAt: Date.now(), error: err?.response?.status || 'network' });
      })
      .finally(() => {
        active -= 1;
        pending.delete(id);
        emit();
        pump();
      });
  }
}

export function requestSnapshot(monitorId, { force = false } = {}) {
  if (!monitorId || pending.has(monitorId)) return;
  const hit = cache.get(monitorId);
  if (!force && hit && Date.now() - hit.fetchedAt < REFRESH_MS) return;
  pending.add(monitorId);
  queue.push(monitorId);
  pump();
}

// The latest still for a camera, fetched on mount and refreshed every two
// minutes while the tab is visible. Returns null until the first one lands.
export function useSnapshot(monitorId, enabled = true) {
  const snap = useSyncExternalStore(subscribe, () => (monitorId ? cache.get(monitorId) : undefined));
  useEffect(() => {
    if (!enabled || !monitorId) return undefined;
    requestSnapshot(monitorId);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') requestSnapshot(monitorId);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [monitorId, enabled]);
  return snap || null;
}
