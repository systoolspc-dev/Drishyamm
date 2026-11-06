/**
 * The one data hook for the vehicle hub.
 *
 * Every tab reads this. The events service has no dedicated ANPR endpoint, so
 * plate reads are `/ai/events` filtered to the two types that carry one, joined
 * to the camera registry for human names and to the watchlist for hits.
 *
 * Polled at 5s. A plate read is an event, not a continuous measurement — the
 * live tab needs to feel immediate, and the other four are looking at history
 * where a five-second lag is invisible.
 *
 * Manual corrections live here too. The service has no endpoint to write an OCR
 * fix back to, so a correction is held on this browser and folded over the read
 * it belongs to — the review tab says so rather than implying the model learned
 * anything.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { aiService } from '@/core/services/ai';
import { useGroups } from '@/core/hooks/useQueries';
import { blacklistedVehicles } from '@/ai-analytics/data/ANPR';
import { READ_TYPES, indexWatchlist, normaliseRead } from './vehicle-data';

const POLL_MS = 5_000;
const LIMIT = 500;

const CORRECTIONS_KEY = 'drishyam.anpr.corrections.v1';
const LOCAL_STATE_KEY = 'drishyam.anpr.localState.v1';

/** Default registering state treated as "local". Editable from the Outside tab. */
export const DEFAULT_LOCAL_STATE = 'GJ';

export function loadCorrections() {
  try {
    const raw = localStorage.getItem(CORRECTIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function loadLocalState() {
  try {
    return localStorage.getItem(LOCAL_STATE_KEY) || DEFAULT_LOCAL_STATE;
  } catch {
    return DEFAULT_LOCAL_STATE;
  }
}

export function useVehicleReads({ live = true } = {}) {
  const { data: groups = [] } = useGroups({ refetchInterval: 60_000 });

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [corrections, setCorrections] = useState(loadCorrections);
  const [localState, setLocalStateValue] = useState(loadLocalState);

  const load = useCallback(async () => {
    try {
      const res = await aiService.listEvents({ limit: LIMIT });
      const list = Array.isArray(res) ? res
        : Array.isArray(res?.data) ? res.data
          : Array.isArray(res?.events) ? res.events
            : Array.isArray(res?.items) ? res.items : [];
      setEvents(list);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(err?.response?.status === 401
        ? 'Session expired — log in again.'
        : 'The events service is not responding.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [live, load]);

  // monitorId -> camera, so a read names a place rather than printing a hex id
  // no operator can find on a floor plan.
  const cameras = useMemo(() => {
    const out = {};
    for (const g of groups) {
      for (const c of g.cameras || []) out[c.monitorId] = { name: c.name, groupName: g.name };
    }
    return out;
  }, [groups]);

  const cameraOptions = useMemo(
    () => Object.entries(cameras)
      .map(([id, c]) => ({ id, label: c.groupName ? `${c.groupName} · ${c.name || 'Camera'}` : c.name || id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [cameras],
  );

  // The same list the vehicle watchlist page reads. Editing it there does not
  // persist anywhere today, so there is no second store to drift from -- but
  // there is also nothing here to write to, which is why the hub only reads.
  const watchIndex = useMemo(() => indexWatchlist(blacklistedVehicles), []);

  const reads = useMemo(
    () => events
      .filter((e) => READ_TYPES.has(e.eventType || e.kind || e.action || ''))
      .map((e) => normaliseRead(e, cameras, corrections))
      .filter(Boolean)
      .sort((a, b) => b.at - a.at),
    [events, cameras, corrections],
  );

  const correct = useCallback((readId, plate) => {
    setCorrections((prev) => {
      const next = { ...prev };
      if (!plate) delete next[readId];
      else next[readId] = { plate, by: 'operator', at: Date.now() };
      try { localStorage.setItem(CORRECTIONS_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
      return next;
    });
  }, []);

  const setLocalState = useCallback((code) => {
    const value = String(code || '').toUpperCase().slice(0, 2);
    setLocalStateValue(value);
    try { localStorage.setItem(LOCAL_STATE_KEY, value); } catch { /* storage blocked */ }
  }, []);

  return {
    reads,
    cameras,
    cameraOptions,
    watchIndex,
    watchlist: blacklistedVehicles,
    corrections,
    correct,
    localState,
    setLocalState,
    loading,
    error,
    updatedAt,
    refresh: load,
  };
}
