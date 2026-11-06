/**
 * The one data hook for /occupancy.
 *
 * Three feeds, three different cadences, deliberately not merged into one
 * interval:
 *
 *   head-count streams   1.5s  — it is the live number on screen
 *   footfall cameras     5s    — daily totals, they move slowly
 *   camera registry     30s    — names and thresholds, they barely move
 *   hourly timeseries   60s    — a chart of whole hours
 *
 * Polling the registry at 1.5s to keep one label fresh would be four times the
 * request volume for nothing.
 *
 * The hook also keeps a short rolling series per region zone. That series is
 * what makes surge detection and the hour heatmap possible at all: neither the
 * head-count service nor the footfall service stores per-room history, so the
 * page remembers what it has seen since it was opened and says so rather than
 * inventing the hours it missed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiService } from '@/core/services/ai';
import { useGroups } from '@/core/hooks/useQueries';
import {
  buildCongestion, buildHeatmap, buildLineZones, buildMacro,
  buildRegionZones, buildTimeline,
} from './occupancy-data';
import { gatesByMonitor } from './gate-model';
import { loadRooms, syncRooms } from './room-settings';

const HC = import.meta.env.VITE_HEADCOUNT_BASE
  || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:8020' : '/headcount');

const POLL_HEADS_MS  = 1_500;
const POLL_FOOTFALL_MS = 5_000;
const POLL_REGISTRY_MS = 30_000;
const POLL_SERIES_MS = 60_000;

// Roughly the last three hours at the head-count poll rate. Bounded because a
// control-room browser leaves this page open all shift.
const SERIES_MAX = 7_200;

const isHexId = (s) => typeof s === 'string' && /^[0-9a-f]{24}$/i.test(s.trim());

export function useOccupancy({ live = true } = {}) {
  const { data: groups = [] } = useGroups({ refetchInterval: POLL_REGISTRY_MS });

  const [streams, setStreams]   = useState([]);
  const [health, setHealth]     = useState(null);
  const [footfall, setFootfall] = useState(null);
  const [camList, setCamList]   = useState([]);
  const [points, setPoints]     = useState([]);
  const [rooms, setRooms]       = useState(() => loadRooms());
  const [ready, setReady]       = useState(false);
  const [errors, setErrors]     = useState({});
  const [updatedAt, setUpdatedAt] = useState(null);

  // zoneId -> [{ t, v }]. A ref, not state: it is written on every poll and
  // read only when a memo recomputes, so putting it in state would re-render
  // the whole page twice a second to move a number nothing is showing yet.
  const historyRef = useRef({});
  const [historyTick, setHistoryTick] = useState(0);

  const note = useCallback((key, err) => {
    setErrors((prev) => (Boolean(prev[key]) === Boolean(err) ? prev : { ...prev, [key]: err }));
  }, []);

  const pollHeads = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([
        fetch(`${HC}/health`).then((r) => r.json()),
        fetch(`${HC}/streams`).then((r) => r.json()),
      ]);
      const list = Array.isArray(s?.streams) ? s.streams : [];
      setHealth(h);
      setStreams(list);
      note('heads', null);
      setUpdatedAt(Date.now());
    } catch {
      note('heads', 'The head-count service is not responding.');
    } finally {
      setReady(true);
    }
  }, [note]);

  const pollFootfall = useCallback(async () => {
    try {
      setFootfall(await aiService.footfallCameras());
      note('footfall', null);
    } catch {
      note('footfall', 'The footfall service is not responding.');
    }
  }, [note]);

  const pollRegistry = useCallback(async () => {
    try {
      const r = await aiService.listCameraAiSettings();
      setCamList(Array.isArray(r?.data) ? r.data : []);
    } catch { /* keep the last known registry; names and limits are stable */ }
  }, []);

  const pollSeries = useCallback(async () => {
    try {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const res = await aiService.footfallTimeseries({
        granularity: 'hour',
        from: from.toISOString(),
        to: new Date().toISOString(),
      });
      setPoints(Array.isArray(res?.points) ? res.points : []);
      note('series', null);
    } catch {
      note('series', 'Hourly history is unavailable.');
    }
  }, [note]);

  const refreshAll = useCallback(() => {
    pollHeads(); pollFootfall(); pollRegistry(); pollSeries();
    // The cache renders immediately; the server's copy folds over it when it
    // arrives. A zone created on another device therefore appears here without
    // the page ever showing an empty list first.
    syncRooms().then(({ rooms: next }) => setRooms(next));
  }, [pollHeads, pollFootfall, pollRegistry, pollSeries]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  useEffect(() => {
    if (!live) return undefined;
    const a = setInterval(pollHeads, POLL_HEADS_MS);
    const b = setInterval(pollFootfall, POLL_FOOTFALL_MS);
    const c = setInterval(pollRegistry, POLL_REGISTRY_MS);
    const d = setInterval(pollSeries, POLL_SERIES_MS);
    // The heatmap and the surge banner read the ref, so they need a beat of
    // their own to recompute. Once every ten seconds is far finer than an hour
    // bucket and far cheaper than re-deriving on every 1.5s sample.
    const e = setInterval(() => setHistoryTick((n) => n + 1), 10_000);
    return () => { [a, b, c, d, e].forEach(clearInterval); };
  }, [live, pollHeads, pollFootfall, pollRegistry, pollSeries]);

  // monitorId -> friendly name. Same three-case resolution the rest of the app
  // uses: a real camera name, else group + channel, else nothing — the raw
  // monitor hex is never shown to a human.
  const names = useMemo(() => {
    const out = {};
    for (const g of groups) {
      const cams = (g.cameras || []).slice().sort((a, b) => (a.channel || 0) - (b.channel || 0));
      cams.forEach((c, i) => {
        out[c.monitorId] = {
          name: c.name && !isHexId(c.name) ? c.name : null,
          groupName: g.name || '',
          channelLabel: c.channel != null ? `Cam ${c.channel}` : `Cam ${i + 1}`,
        };
      });
    }
    return out;
  }, [groups]);

  const camByMonitor = useMemo(
    () => Object.fromEntries(camList.filter((c) => c.monitorId).map((c) => [c.monitorId, c])),
    [camList],
  );

  const lineZones   = useMemo(() => buildLineZones(footfall, names), [footfall, names]);
  const gates       = useMemo(() => gatesByMonitor(footfall), [footfall]);
  const regionZones = useMemo(
    () => buildRegionZones(streams, camByMonitor, rooms),
    [streams, camByMonitor, rooms],
  );

  // One sample per zone per poll, keyed by ZONE rather than camera: a zone can
  // span cameras and a camera can hold several zones, so a camera's series is
  // no longer any one zone's. Recorded after the zones are derived, and only
  // once per poll -- a zone edit re-derives them without a new reading.
  useEffect(() => {
    if (!updatedAt) return;
    const hist = historyRef.current;
    for (const z of regionZones) {
      const arr = hist[z.id] || (hist[z.id] = []);
      if (arr[arr.length - 1]?.t === updatedAt) continue;
      arr.push({ t: updatedAt, v: z.count });
      if (arr.length > SERIES_MAX) arr.splice(0, arr.length - SERIES_MAX);
    }
  }, [regionZones, updatedAt]);

  // EVERY camera the site has, for Zone Setup -- not only the ones already
  // counting. Head-count streams exist only for cameras with counting on, so a
  // list built from them hid every other camera, and a zone could never be
  // drawn on a camera before someone had switched it on elsewhere. The camera
  // registry and the groups are the full set (the same one the home page
  // counts); the streams only add whether each is counting right now.
  const cameras = useMemo(() => {
    const byStream = Object.fromEntries(streams.map((s) => [s.id, s]));
    const ids = new Set([...Object.keys(names), ...Object.keys(camByMonitor), ...Object.keys(byStream)]);
    return [...ids].map((id) => {
      const s = byStream[id];
      const cam = camByMonitor[id];
      const named = names[id];
      return {
        id,
        label: cam?.name || named?.name
          || (named ? `${named.groupName} ${named.channelLabel}`.trim() : null)
          || s?.name || id,
        floor: cam?.groupName || named?.groupName || '',
        counting: Boolean(s),
        offline: s ? s.status !== 'online' : false,
        count: Number(s?.counts?.heads) || 0,
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
  }, [streams, camByMonitor, names]);

  const congestion = useMemo(
    () => buildCongestion(regionZones, historyRef.current),
    // historyTick is the dependency that matters here — the ref itself never
    // changes identity, so without it a surge would never surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regionZones, historyTick],
  );

  const macro    = useMemo(() => buildMacro({ lineZones, regionZones, congestion, footfall }), [lineZones, regionZones, congestion, footfall]);
  const timeline = useMemo(() => buildTimeline(points), [points]);
  // `rooms` is a dependency because the heatmap's columns come from the rooms'
  // configured operating hours — editing a schedule reshapes the grid.
  const heatmap = useMemo(
    () => buildHeatmap(regionZones, historyRef.current, rooms),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regionZones, rooms, historyTick],
  );

  return {
    ready, errors, updatedAt, health,
    lineZones, regionZones, congestion, macro, timeline, heatmap,
    rooms, setRooms,
    camByMonitor, cameras,
    // Gates by monitorId -- every camera the footfall service knows, counting
    // or not -- and a way to re-read them after a gate is saved.
    gates,
    refreshGates: pollFootfall,
    refresh: refreshAll,
  };
}
