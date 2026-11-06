import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import api from '@/core/services/api';
import { aiService } from '@/core/services/ai';
import { useGroups } from '@/core/hooks/useQueries';

/**
 * useDashboardStats — derives the Dashboard's headline numbers + chart data
 * from the live REST API instead of hard-coded mock values.
 *
 * Returns:
 *   sites           — number of groups (each group ≈ a physical NVR/site)
 *   sitesOnline     — groups whose status is 'online'
 *   cameras         — total cameras across all groups
 *   online          — cameras with status === 'online'
 *   offline         — cameras with status === 'offline'
 *   eventsToday     — AI events with occurred_at >= 00:00 local
 *   alertsActive    — today's distinct unacknowledged warning/critical alerts
 *   detectionMix    — { matched, unknown, alert } counts for the donut chart
 *   recentEvents    — last 8 AI events (for the activity feed)
 *   recentAlerts    — 6 latest distinct warning/critical alerts (side panel)
 *   events          — the normalized event list (shape-agnostic), so a panel
 *                      that needs a different slice (e.g. the Activity by
 *                      Hour card switching to "Yesterday") can bucket it
 *                      itself without a second /ai/events fetch
 *   loading, error
 *
 * The hook is the single source of truth — every Dashboard panel reads from
 * the same shape so we don't double-fetch /ai/events from multiple places.
 */
// What counts as an "alert".
//
// The pipeline never writes an event type literally named "alert" — it writes
// `person.unknown`, `zone.intrusion`, `occupancy.threshold`, `crowd.stampede`.
// So the old substring test (kind/eventType contains "alert") matched nothing,
// and this dashboard reported "All clear" while the Alerts page listed
// thousands of events. Use the same rule the backend uses to decide an event
// is worth waking someone up for: severity warning|critical
// (PUSH_SEVERITIES in services/alertEngine.js).
const ALERT_SEVERITIES = new Set(['warning', 'critical']);

function isAlertEvent(e) {
  if (ALERT_SEVERITIES.has(String(e?.severity || '').toLowerCase())) return true;
  // Watchlist hits pushed over the socket can arrive before the backend has
  // stamped a severity — they still name themselves "alert".
  return String(e?.kind || e?.action || e?.eventType || '').toLowerCase().includes('alert');
}

function isUnacked(e) {
  return !e.acknowledgedAt && !e.acknowledged_at && !e.ackAt;
}

// Roll-up key — the same one the toast host dedups on (type + subject + camera).
// One unknown face standing in front of a camera writes an event every few
// seconds; listing each one turns the card into six copies of one row and
// buries every other alert behind it. Group them and count the repeats.
function alertKey(e) {
  const p = e.payload || {};
  const named = p.matchedName || p.personId || e.name || e.person_name;
  const subject = named && String(named).toLowerCase() !== 'unknown' ? `id:${named}` : 'unknown';
  return `${e.eventType || e.kind || e.action || 'evt'}:${subject}:${e.monitorId || e.camera_code || '-'}`;
}

export function useDashboardStats() {
  const { data: groups = [], isLoading: groupsLoading } = useGroups({ refetchInterval: 30_000 });

  // AI events — pull last 200 across the day to feed every chart at once.
  const eventsQuery = useQuery({
    queryKey: ['dashboard', 'ai-events'],
    queryFn: () => aiService.listEvents({ limit: 200 }).catch(() => ({ events: [], items: [] })),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  // Backend deep health — the /full endpoint includes per-component reachability
  // so we can show "AI offline" or "MediaMTX down" in the corner without
  // cross-cutting code in every panel.
  const healthQuery = useQuery({
    queryKey: ['dashboard', 'health-full'],
    queryFn: () => api.get('/health/full').then((r) => r.data).catch(() => null),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  // Disk + recordings storage stats (cached server-side for 60 s)
  const storageQuery = useQuery({
    queryKey: ['dashboard', 'storage'],
    queryFn: () => api.get('/system/storage').then((r) => r.data).catch(() => null),
    refetchInterval: 60_000,
    staleTime: 50_000,
  });

  return useMemo(() => {
    const allCameras = groups.flatMap((g) => g.cameras || []);
    // monitorId -> { name, groupName }, so panels can print a camera the
    // operator recognises instead of a raw monitor hash.
    const cameraLabels = {};
    for (const g of groups) {
      for (const c of g.cameras || []) {
        cameraLabels[c.monitorId] = { name: c.name || 'Camera', groupName: g.name || '' };
      }
    }
    const online   = allCameras.filter((c) => c.status === 'online').length;
    const offline  = allCameras.length - online;
    const sitesOnline = groups.filter((g) => g.status === 'online').length;

    // Normalize the events shape — depending on backend version /ai/events may
    // return `{events: [...]}`, `{items: [...]}`, or just an array.
    const raw = eventsQuery.data;
    const events = Array.isArray(raw) ? raw
                 : Array.isArray(raw?.data)   ? raw.data
                 : Array.isArray(raw?.events) ? raw.events
                 : Array.isArray(raw?.items)  ? raw.items
                 : [];

    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    const todayEvents = events.filter((e) => {
      const t = new Date(e.ts || e.occurred_at || e.timestamp || e.createdAt || 0).getTime();
      return Number.isFinite(t) && t >= startMs;
    });

    const detectionMix = todayEvents.reduce((acc, e) => {
      const k = (e.kind || e.eventKind || e.action || e.eventType || '').toLowerCase();
      if (k.includes('alert'))           acc.alert  += 1;
      else if (k.includes('match'))      acc.match  += 1;
      else if (k.includes('unknown'))    acc.unknown += 1;
      else                                acc.other  += 1;
      return acc;
    }, { match: 0, unknown: 0, alert: 0, other: 0 });

    const recentEvents = events.slice(0, 8);

    // Alert roll-up. `events` is newest-first (the API sorts by ts DESC), so the
    // row we keep per key is the latest sighting and `repeatCount` says how many
    // times it recurred inside the fetched window.
    const alertRows = [];
    const alertByKey = new Map();
    for (const e of events) {
      if (!isAlertEvent(e)) continue;
      const key = alertKey(e);
      const seen = alertByKey.get(key);
      if (seen) { seen.repeatCount += 1; continue; }
      const row = { ...e, repeatCount: 1 };
      alertByKey.set(key, row);
      alertRows.push(row);
    }

    const recentAlerts = alertRows.slice(0, 6);

    // "Active" = distinct, raised today, nobody has acknowledged it. Distinct
    // matters: 200 sightings of one stranger is one thing to go and look at,
    // and counting the raw rows just pegged this to the fetch limit.
    const alertsActive = alertRows.filter((e) => {
      const t = new Date(e.ts || e.occurred_at || e.timestamp || e.createdAt || 0).getTime();
      return Number.isFinite(t) && t >= startMs && isUnacked(e);
    }).length;

    // Health summary — boolean per dependency
    const h = healthQuery.data?.components || {};
    const componentHealth = {
      db:        !!h.db?.ok,
      redis:     !!h.redis?.ok,
      mediamtx:  Array.isArray(h.mediamtx) ? h.mediamtx.some((m) => m.ok) : !!h.mediamtx?.ok,
      aiService: !!h.aiService?.ok,
    };

    // Storage — pass through whatever the backend reported so the card can
    // render even when usedRatio is 0 (fresh install, no recordings yet).
    const s = storageQuery.data;
    const storage = s ? {
      recordingsBytes: s.recordingsBytes || 0,
      totalBytes:      s.totalBytes      || 0,
      usedBytes:       s.usedBytes       || 0,
      freeBytes:       s.freeBytes       || 0,
      usedRatio:       s.usedRatio       || 0,
      recordingsRatio: s.recordingsRatio || 0,
    } : null;

    return {
      sites:        groups.length,
      sitesOnline,
      cameras:      allCameras.length,
      online,
      offline,
      cameraList:   allCameras,
      cameraLabels,
      eventsToday:  todayEvents.length,
      alertsActive,
      detectionMix,
      recentEvents,
      recentAlerts,
      events,
      componentHealth,
      storage,
      loading:      groupsLoading || eventsQuery.isLoading,
      error:        eventsQuery.error || null,
    };
  }, [groups, groupsLoading, eventsQuery.data, eventsQuery.isLoading, eventsQuery.error, healthQuery.data, storageQuery.data]);
}
