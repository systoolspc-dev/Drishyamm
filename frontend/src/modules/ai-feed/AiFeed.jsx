/**
 * AI Feed — the unified, multi-model event monitor.
 *
 * One page for everything the AI sees: restricted-zone entries, line
 * crossings, crowd density, occupancy, faces, plates, PPE, weapons, objects
 * left behind. It used to be a face-recognition console with a detection
 * timeline bolted on; now the face pipeline is one category among several and
 * the page answers the operator's questions in order —
 *
 *   1. what is happening right now         → the event stream, newest first
 *   2. on which camera                      → click an event, the tile lights
 *   3. is it critical                       → HIGH / MEDIUM / INFO badges
 *   4. which AI saw it                      → category icon + model name
 *   5. what do I do next                    → the detail drawer's actions
 *
 * Layout: header · category filter bar · camera grid (70%) + event stream
 * (30%). Below `xl` the stream folds into a button and opens as a sheet, so
 * it never squeezes the video.
 *
 * Data: cameras from /groups, per-camera AI state from /ai/cameras, live
 * boxes from the AI service, events from /ai/events plus the `ai.event`
 * socket. `?demo=1` swaps all of that for a realistic sample estate so the
 * layout can be reviewed on an empty account — flagged in the header.
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Brain, ChevronDown, Cctv, LayoutGrid, List, MapPinned, MoreHorizontal, Map as MapIcon,
  Plus, Radio, RefreshCw, Rss, ScanFace, Upload, X,
} from 'lucide-react';
import { useGroups } from '@/core/hooks/useQueries';
import { siteService } from '@/core/services/site';
import { aiService } from '@/core/services/ai';
import { on as onSocket, connectSocket } from '@/core/services/socket';
import { AI_BASE, AI_WS } from '@/core/config/endpoints';
import { cn } from '@/core/lib/utils';
import { toneClass } from '@/core/ui/tone';
import { EmptyState } from '@/core/ui/states';
import { Button } from '@/core/ui/button';
import { RequireCameras } from '@/core/components/RequireCameras';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/core/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/core/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/core/ui/sheet';
import { OperationsPage, PageHeader, PageContent } from '@/core/layout/OperationsPage';

import { EMPTY_DETECTIONS, clamp01, lineInsideNormal, normalizeDetections } from './aifeed/detection-utils';
import ZoneEditorModal from './aifeed/ZoneEditorModal';
import AiCameraCard from './aifeed/AiCameraCard';
import EventStream from './aifeed/EventStream';
import EventDetailDrawer from './aifeed/EventDetailDrawer';
import CameraDetailDrawer from './aifeed/CameraDetailDrawer';
import { CountPill } from './aifeed/chips';
import {
  CATEGORIES, GROUP_MODES, MORE_AI, TIME_RANGES,
  countByFilter, countBySeverity, matchesFilter, normalizeEvent, summarizeCamera,
} from './aifeed/event-model';
import { SAMPLE_CAMERAS, SAMPLE_SITES, nextSampleEvent, sampleEvents } from './aifeed/sample-data';

const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const MORE_LABEL = Object.fromEntries(MORE_AI.map((m) => [m.id, m.label]));

// ── Small header pieces ──────────────────────────────────────────────────────

function FilterTab({ label, count, active, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-small transition',
        active
          ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink'
          : 'border-transparent font-medium text-fg-muted hover:bg-surface-sunken hover:text-fg',
      )}
    >
      {label}
      <CountPill value={count} active={active} />
    </button>
  );
}

function ViewToggle({ value, onChange }) {
  return (
    <div className="inline-flex h-9 items-center rounded-lg border border-line bg-surface p-0.5">
      {[{ id: 'grid', icon: LayoutGrid, label: 'Grid' }, { id: 'list', icon: List, label: 'List' }].map(({ id, icon, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          title={label}
          onClick={() => onChange(id)}
          className={cn(
            'grid h-7 w-8 place-items-center rounded-md transition',
            value === id ? 'bg-brand-soft text-brand-ink' : 'text-fg-muted hover:text-fg',
          )}
        >
          {createElement(icon, { className: "h-3.5 w-3.5", strokeWidth: value === id ? 2.3 : 1.9 })}
        </button>
      ))}
    </div>
  );
}

function LiveStatus({ connected, aiCameras, demo }) {
  const ok = demo || connected;
  return (
    <div className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-3">
      <span className="relative grid h-2 w-2 place-items-center">
        {ok ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" /> : null}
        <span className={cn('relative h-2 w-2 rounded-full', ok ? 'bg-success' : 'bg-warning')} />
      </span>
      <span className="text-small font-semibold text-fg-secondary">{ok ? 'Live' : 'Reconnecting'}</span>
      <span className="text-fg-disabled">·</span>
      <span className="text-caption font-medium text-fg-muted">
        <span className="font-semibold tabular-nums text-fg">{aiCameras}</span> AI cameras
      </span>
      {demo ? <span className="rounded border border-line bg-surface-muted px-1.5 py-0.5 text-micro font-bold text-fg-muted">SAMPLE DATA</span> : null}
    </div>
  );
}

function GroupHeading({ label, count, tone }) {
  return (
    <div className="col-span-full flex items-center gap-2 pt-1 first:pt-0">
      {tone ? <span className={cn('h-1.5 w-1.5 rounded-full', toneClass(tone, 'dot'))} /> : null}
      <p className="text-micro font-semibold uppercase tracking-[0.12em] text-fg-subtle">{label}</p>
      <CountPill value={count} />
      <span className="h-px flex-1 bg-line-subtle" />
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AiFeed() {
  const [searchParams, setSearchParams] = useSearchParams();
  const demo = searchParams.get('demo') === '1';

  // ── Cameras & sites ──────────────────────────────────────────────────────
  const { data: groups = [] } = useGroups({ enabled: !demo });
  const { data: sitesRaw } = useQuery({ queryKey: ['sites'], queryFn: () => siteService.list(), staleTime: 60_000, enabled: !demo });
  const sites = useMemo(() => {
    if (demo) return SAMPLE_SITES;
    const list = Array.isArray(sitesRaw) ? sitesRaw : (sitesRaw?.data ?? []);
    return list.map((s) => ({ id: s.id, name: s.name }));
  }, [demo, sitesRaw]);
  const siteName = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s.name])), [sites]);

  const cameras = useMemo(() => {
    if (demo) return SAMPLE_CAMERAS.map((c) => ({ ...c, siteName: siteName[c.siteId] || '' }));
    return groups.flatMap((g) => (g.cameras ?? []).map((c) => ({
      ...c,
      location: g.name || '',
      groupId: g.id,
      siteId: g.siteId || null,
      siteName: siteName[g.siteId] || '',
    })));
  }, [demo, groups, siteName]);
  const cameraIndex = useMemo(() => {
    const out = {};
    for (const c of cameras) out[c.monitorId] = { name: c.name, location: c.location, siteId: c.siteId };
    return out;
  }, [cameras]);

  // ── Per-camera AI state (which models run, zones, runtime) ───────────────
  const [aiRows, setAiRows] = useState([]);
  const loadAiRows = useCallback(async () => {
    if (demo) return;
    try {
      const payload = await aiService.listCameraAiSettings();
      setAiRows(payload.data || []);
    } catch { /* transient */ }
  }, [demo]);
  useEffect(() => {
    loadAiRows();
    const t = setInterval(loadAiRows, 8000);
    return () => clearInterval(t);
  }, [loadAiRows]);
  const aiByMonitor = useMemo(() => {
    const map = new Map();
    aiRows.forEach((row) => map.set(row.monitorId, row));
    return map;
  }, [aiRows]);

  const modelsFor = useCallback((cam) => {
    if (demo) return cam.models || [];
    const row = aiByMonitor.get(cam.monitorId);
    const out = [];
    if (row?.ai?.enabled) out.push('Face Recognition');
    if (row?.ai?.enabled && row?.ai?.journeyMapping !== false) out.push('Person Tracking');
    if (row?.headcount?.enabled) out.push('Head Count');
    if (row?.ai?.detectionZones?.length) out.push(row.ai.detectionZones.some((z) => z.shape === 'line') ? 'Line Crossing' : 'Detection Zones');
    return out;
  }, [aiByMonitor, demo]);

  // ── Live detections (boxes) ──────────────────────────────────────────────
  const [detectionsByMonitor, setDetectionsByMonitor] = useState({});
  const setCameraDetections = useCallback((monitorId, next) => {
    if (!monitorId) return;
    setDetectionsByMonitor((prev) => ({ ...prev, [monitorId]: normalizeDetections(next) }));
  }, []);

  const [selectedId, setSelectedId] = useState('');
  const [engineStatus, setEngineStatus] = useState({ running: false, detecting: false, error: null });
  const wsRef = useRef(null);
  const switchSeqRef = useRef(0);
  const ensuringRef = useRef(false);
  const ensuringAllRef = useRef(false);
  const autoSelectedRef = useRef(false);

  // WebSocket for the selected camera — the fastest path for its boxes.
  useEffect(() => {
    if (!selectedId || demo) return undefined;
    let ws; let retryT; let closed = false;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${AI_WS}?camera_id=${encodeURIComponent(selectedId)}`);
      wsRef.current = ws;
      ws.onmessage = (e) => { try { setCameraDetections(selectedId, JSON.parse(e.data)); } catch { /* ignore */ } };
      ws.onclose = () => { if (!closed) retryT = setTimeout(connect, 3000); };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retryT);
      ws?.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [selectedId, demo, setCameraDetections]);

  // Fast poll for the selected camera, slower sweep for every AI-enabled one.
  useEffect(() => {
    if (!selectedId || demo) return undefined;
    const poll = async () => {
      try {
        const r = await fetch(`${AI_BASE}/api/detections/${encodeURIComponent(selectedId)}`);
        if (r.ok) setCameraDetections(selectedId, await r.json());
      } catch { /* transient */ }
    };
    poll();
    const t = setInterval(poll, 350);
    return () => clearInterval(t);
  }, [selectedId, demo, setCameraDetections]);

  useEffect(() => {
    if (demo) return undefined;
    const enabled = aiRows.filter((row) => row.ai?.enabled && row.monitorId).map((row) => row.monitorId);
    if (!enabled.length) return undefined;
    const poll = async () => {
      await Promise.allSettled(enabled.map(async (monitorId) => {
        const r = await fetch(`${AI_BASE}/api/detections/${encodeURIComponent(monitorId)}`);
        if (r.ok) setCameraDetections(monitorId, await r.json());
      }));
    };
    poll();
    const t = setInterval(poll, 1200);
    return () => clearInterval(t);
  }, [aiRows, demo, setCameraDetections]);

  useEffect(() => {
    if (!selectedId || demo) { setEngineStatus({ running: false, detecting: false, error: null }); return undefined; }
    const poll = async () => {
      try {
        const r = await fetch(`${AI_BASE}/status`);
        if (!r.ok) return;
        const data = await r.json();
        const cameraStatus = data.cameras?.[selectedId];
        setEngineStatus({
          running: cameraStatus ? cameraStatus.running === true : data.running === true,
          detecting: cameraStatus ? cameraStatus.running === true && !cameraStatus.error : data.detecting === true,
          error: cameraStatus?.error || data.error || null,
        });
      } catch { /* transient */ }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [selectedId, demo]);

  // ── AI lifecycle (start/keep the model running on a camera) ──────────────
  const lifecyclePayload = (camera, ai, enabled) => ({
    enabled,
    mode: 'continuous',
    fps: ai.fps || 8,
    detectionInputSize: ai.detectionInputSize || 960,
    detectionZones: ai.detectionZones || [],
    purpose: ai.purpose || camera.name || 'AI Feed',
    priority: ai.priority || 'normal',
    unknownAlerts: ai.unknownAlerts !== false,
    watchlistAlerts: ai.watchlistAlerts !== false,
    journeyMapping: ai.journeyMapping !== false,
  });

  const ensureCameraLifecycle = useCallback(async (monitorId) => {
    const camera = cameras.find((item) => item.monitorId === monitorId);
    const ai = aiByMonitor.get(monitorId)?.ai || {};
    if (demo || !camera?.id || ai.enabled !== true) return null;
    const response = await aiService.updateCameraAiLifecycle(camera.id, lifecyclePayload(camera, ai, true));
    await loadAiRows();
    if (response.reconcile && response.reconcile.ok === false) {
      throw new Error(response.reconcile.error || 'AI service did not start this camera.');
    }
    return response;
  }, [aiByMonitor, cameras, demo, loadAiRows]);

  const handleSelect = useCallback(async (monitorId) => {
    if (!monitorId) return;
    const seq = ++switchSeqRef.current;
    wsRef.current?.close();
    wsRef.current = null;
    setSelectedId(monitorId);
    if (demo) return;
    setDetectionsByMonitor((prev) => ({ ...prev, [monitorId]: prev[monitorId] || EMPTY_DETECTIONS }));
    try {
      await ensureCameraLifecycle(monitorId);
      if (seq !== switchSeqRef.current) return;
      setEngineStatus((prev) => ({ ...prev, error: null }));
    } catch (e) {
      if (seq !== switchSeqRef.current) return;
      setEngineStatus({ running: false, detecting: false, error: e.message || 'AI start failed' });
    }
  }, [demo, ensureCameraLifecycle]);

  const handleEnableAi = useCallback(async (cam) => {
    const monitorId = cam?.monitorId;
    if (!monitorId || demo) return;
    const camera = cameras.find((item) => item.monitorId === monitorId);
    if (!camera?.id) return;
    const ai = aiByMonitor.get(monitorId)?.ai || {};
    setSelectedId(monitorId);
    try {
      const response = await aiService.updateCameraAiLifecycle(camera.id, lifecyclePayload(camera, ai, true));
      await loadAiRows();
      if (response.reconcile && response.reconcile.ok === false) {
        throw new Error(response.reconcile.error || 'AI service did not start this camera.');
      }
      setEngineStatus((prev) => ({ ...prev, error: null }));
    } catch (e) {
      setEngineStatus({ running: false, detecting: false, error: e.message || 'AI start failed' });
    }
  }, [aiByMonitor, cameras, demo, loadAiRows]);

  // Keep the selected camera's model alive, and sweep the rest every 15 s.
  useEffect(() => {
    if (demo || !selectedId || !aiByMonitor.get(selectedId)?.ai?.enabled) return undefined;
    const tick = async () => {
      if (ensuringRef.current) return;
      if (engineStatus.running && !engineStatus.error) return;
      ensuringRef.current = true;
      try { await ensureCameraLifecycle(selectedId); } catch { /* backend retries */ } finally { ensuringRef.current = false; }
    };
    const t = setInterval(tick, 15000);
    tick();
    return () => clearInterval(t);
  }, [demo, selectedId, aiByMonitor, engineStatus.running, engineStatus.error, ensureCameraLifecycle]);

  useEffect(() => {
    if (demo) return undefined;
    const enabledRows = aiRows.filter((row) => row.ai?.enabled && row.monitorId);
    if (!enabledRows.length) return undefined;
    const tick = async () => {
      if (ensuringAllRef.current) return;
      ensuringAllRef.current = true;
      try {
        for (const row of enabledRows) {
          if (row.runtime?.running === true) continue;
          await ensureCameraLifecycle(row.monitorId).catch(() => null);
        }
      } finally { ensuringAllRef.current = false; }
    };
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [aiRows, demo, ensureCameraLifecycle]);

  // First load: focus the most recently configured AI camera (no drawer).
  useEffect(() => {
    if (selectedId || autoSelectedRef.current || cameras.length === 0) return;
    const configured = cameras
      .filter((camera) => demo || aiByMonitor.get(camera.monitorId)?.ai?.enabled)
      .sort((a, b) => (Date.parse(aiByMonitor.get(b.monitorId)?.ai?.updatedAt || '') || 0) - (Date.parse(aiByMonitor.get(a.monitorId)?.ai?.updatedAt || '') || 0))[0];
    const first = configured ?? cameras.find((camera) => camera.status === 'online') ?? cameras[0];
    if (!first?.monitorId) return;
    autoSelectedRef.current = true;
    handleSelect(first.monitorId);
  }, [cameras, aiByMonitor, selectedId, demo, handleSelect]);

  // ── Events: history + live socket (+ sample ticker) ──────────────────────
  const [rawEvents, setRawEvents] = useState([]);
  const [socketOk, setSocketOk] = useState(false);
  const [clearedAt, setClearedAt] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (demo) {
      setRawEvents(sampleEvents());
      return undefined;
    }
    aiService.listEvents({ limit: 200 })
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res) ? res
          : Array.isArray(res?.data) ? res.data
            : Array.isArray(res?.events) ? res.events
              : Array.isArray(res?.items) ? res.items : [];
        setRawEvents(list);
      })
      .catch(() => { if (!cancelled) setRawEvents([]); });
    return () => { cancelled = true; };
  }, [demo]);

  useEffect(() => {
    if (demo) return undefined;
    const s = connectSocket();
    if (!s) return undefined;
    const onOk = () => setSocketOk(true);
    const onOff = () => setSocketOk(false);
    s.on('connect', onOk);
    s.on('disconnect', onOff);
    setSocketOk(s.connected);
    const off = onSocket('ai.event', (evt) => {
      setRawEvents((prev) => [evt, ...prev].slice(0, 400));
    });
    return () => { s.off('connect', onOk); s.off('disconnect', onOff); off(); };
  }, [demo]);

  useEffect(() => {
    if (!demo) return undefined;
    let t;
    const tick = () => {
      setRawEvents((prev) => [nextSampleEvent(), ...prev].slice(0, 400));
      t = setTimeout(tick, 7000 + Math.random() * 8000);
    };
    t = setTimeout(tick, 6000);
    return () => clearTimeout(t);
  }, [demo]);

  // A slowly moving "now" so the time window slides and relative times age.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // ── Filters ──────────────────────────────────────────────────────────────
  const [site, setSite] = useState('all');
  const [rangeId, setRangeId] = useState('1h');
  const [category, setCategory] = useState('all');
  const [groupBy, setGroupBy] = useState('recent');
  const [layout, setLayout] = useState('grid');
  const range = TIME_RANGES.find((r) => r.id === rangeId) || TIME_RANGES[1];

  const events = useMemo(() => {
    const out = [];
    for (const raw of rawEvents) {
      const e = normalizeEvent(raw, cameraIndex);
      if (e) out.push(e);
    }
    out.sort((a, b) => b.ts.getTime() - a.ts.getTime());
    return out;
  }, [rawEvents, cameraIndex]);

  const siteCameras = useMemo(
    () => (site === 'all' ? cameras : cameras.filter((c) => c.siteId === site)),
    [cameras, site],
  );
  const siteMonitorIds = useMemo(() => new Set(siteCameras.map((c) => c.monitorId)), [siteCameras]);

  const windowEvents = useMemo(() => {
    const since = now - range.ms;
    return events.filter((e) => {
      const t = e.ts.getTime();
      if (t < since || t <= clearedAt) return false;
      if (site !== 'all' && !siteMonitorIds.has(e.monitorId)) return false;
      return true;
    });
  }, [events, now, range.ms, clearedAt, site, siteMonitorIds]);

  const filterCounts = useMemo(() => countByFilter(windowEvents), [windowEvents]);
  const severityCounts = useMemo(() => countBySeverity(windowEvents), [windowEvents]);
  const categoryEvents = useMemo(() => windowEvents.filter((e) => matchesFilter(e, category)), [windowEvents, category]);

  const eventsByCamera = useMemo(() => {
    const map = new Map();
    for (const e of categoryEvents) {
      if (!map.has(e.monitorId)) map.set(e.monitorId, []);
      map.get(e.monitorId).push(e);
    }
    return map;
  }, [categoryEvents]);
  const summaries = useMemo(() => {
    const map = new Map();
    for (const [monitorId, list] of eventsByCamera) map.set(monitorId, summarizeCamera(list));
    return map;
  }, [eventsByCamera]);

  // ── Grouping ─────────────────────────────────────────────────────────────
  const cameraGroups = useMemo(() => {
    const byRecency = (a, b) => {
      const ta = summaries.get(a.monitorId)?.lastTs?.getTime() || 0;
      const tb = summaries.get(b.monitorId)?.lastTs?.getTime() || 0;
      if (tb !== ta) return tb - ta;
      return (a.channel || 0) - (b.channel || 0) || String(a.name).localeCompare(String(b.name));
    };
    const cams = siteCameras.slice().sort(byRecency);
    const bucket = (keyOf, order, toneOf) => {
      const map = new Map();
      for (const c of cams) {
        const key = keyOf(c);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(c);
      }
      const keys = order ? order.filter((k) => map.has(k)).concat([...map.keys()].filter((k) => !order.includes(k))) : [...map.keys()];
      return keys.map((k) => ({ key: k, label: k, tone: toneOf?.(k) || null, cams: map.get(k) }));
    };
    if (groupBy === 'location') {
      return bucket((c) => c.location || 'Unassigned').sort((a, b) => a.label.localeCompare(b.label));
    }
    if (groupBy === 'threat') {
      const label = { high: 'High', medium: 'Medium', info: 'Informational', none: 'No events' };
      const tone = { high: 'danger', medium: 'warning', info: 'neutral' };
      return bucket((c) => label[summaries.get(c.monitorId)?.severity || 'none'], ['High', 'Medium', 'Informational', 'No events'], (k) => tone[Object.keys(label).find((x) => label[x] === k)]);
    }
    if (groupBy === 'aitype') {
      const labelOf = (c) => {
        const s = summaries.get(c.monitorId);
        if (!s) return 'No events';
        const e = s.headline;
        return e.category === 'more' ? (MORE_LABEL[e.more] || 'Other AI') : CATEGORY_LABEL[e.category] || 'Other AI';
      };
      return bucket(labelOf, [...CATEGORIES.slice(1).map((c) => c.label), ...MORE_AI.map((m) => m.label), 'No events']);
    }
    // recent
    const labelOf = (c) => {
      const s = summaries.get(c.monitorId);
      if (!s) return 'Quiet';
      return now - s.lastTs.getTime() < 2 * 60_000 ? 'Active now' : 'Recent';
    };
    return bucket(labelOf, ['Active now', 'Recent', 'Quiet'], (k) => (k === 'Active now' ? 'brand' : null));
  }, [siteCameras, summaries, groupBy, now]);

  // ── Selection & interactions ─────────────────────────────────────────────
  const [openEvent, setOpenEvent] = useState(null);
  const [openCameraId, setOpenCameraId] = useState('');
  const [focus, setFocus] = useState({});          // monitorId → event (box shown on the tile)
  const [highlightId, setHighlightId] = useState('');
  const [streamOpen, setStreamOpen] = useState(false);
  const [zoneEditorOpen, setZoneEditorOpen] = useState(false);
  const [savingZones, setSavingZones] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerName, setRegisterName] = useState('');
  const cardRefs = useRef(new Map());
  const timersRef = useRef({});

  const registerRef = useCallback((monitorId, el) => {
    if (el) cardRefs.current.set(monitorId, el);
    else cardRefs.current.delete(monitorId);
  }, []);

  useEffect(() => () => Object.values(timersRef.current).forEach(clearTimeout), []);

  const selectEvent = useCallback((evt) => {
    setOpenEvent(evt);
    setOpenCameraId('');
    setStreamOpen(false);
    if (!evt?.monitorId) return;
    handleSelect(evt.monitorId);
    setFocus((prev) => ({ ...prev, [evt.monitorId]: evt }));
    setHighlightId(evt.monitorId);
    clearTimeout(timersRef.current.highlight);
    clearTimeout(timersRef.current[`focus-${evt.monitorId}`]);
    timersRef.current.highlight = setTimeout(() => setHighlightId(''), 2600);
    timersRef.current[`focus-${evt.monitorId}`] = setTimeout(() => {
      setFocus((prev) => { const next = { ...prev }; delete next[evt.monitorId]; return next; });
    }, 10_000);
    requestAnimationFrame(() => {
      cardRefs.current.get(evt.monitorId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [handleSelect]);

  const openCamera = useCallback((cam) => {
    handleSelect(cam.monitorId);
    setOpenEvent(null);
    setOpenCameraId(cam.monitorId);
  }, [handleSelect]);

  const selectedCam = cameras.find((c) => c.monitorId === selectedId) || null;
  const openCam = cameras.find((c) => c.monitorId === openCameraId) || null;
  const selectedAiRow = selectedId ? aiByMonitor.get(selectedId) : null;
  const selectedZones = selectedAiRow?.ai?.detectionZones || [];

  const handleSaveZones = async (zones) => {
    if (!selectedCam?.id || demo) return;
    const ai = selectedAiRow?.ai || {};
    setSavingZones(true);
    try {
      const response = await aiService.updateCameraAiLifecycle(selectedCam.id, {
        ...lifecyclePayload(selectedCam, ai, ai.enabled === true),
        mode: ai.mode || (ai.enabled ? 'continuous' : 'off'),
        detectionZones: zones,
      });
      if (response.reconcile && response.reconcile.ok === false) {
        throw new Error(response.reconcile.error || 'AI service did not apply this area.');
      }
      await loadAiRows();
      // Mirror the in/out line to the attendance watcher (see ZoneEditorModal).
      try {
        const lineZone = (zones || []).find((z) => z.shape === 'line' && Array.isArray(z.points) && z.points.length >= 2);
        if (lineZone) {
          const [a, b] = lineZone.points;
          const n = lineInsideNormal(a, b, lineZone.side);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          await aiService.activitySetLine({
            camera: selectedCam.monitorId,
            line: { x1: a.x, y1: a.y, x2: b.x, y2: b.y, inside_x: clamp01(mid.x + n.x * 0.12), inside_y: clamp01(mid.y + n.y * 0.12) },
          });
        } else {
          await aiService.activitySetLine({ camera: selectedCam.monitorId, line: null });
        }
      } catch { /* attendance line is best-effort */ }
      setZoneEditorOpen(false);
    } catch (error) {
      setEngineStatus((prev) => ({ ...prev, error: error.message || 'Detection area save failed' }));
    } finally {
      setSavingZones(false);
    }
  };

  const openRegister = (name = '') => {
    setRegisterName(name);
    setRegisterOpen(true);
  };

  const enterDemo = () => setSearchParams((p) => { const n = new URLSearchParams(p); n.set('demo', '1'); return n; });
  const exitDemo = () => setSearchParams((p) => { const n = new URLSearchParams(p); n.delete('demo'); return n; });

  // ── Derived for the header ───────────────────────────────────────────────
  const aiCameraCount = demo
    ? cameras.filter((c) => c.status === 'online').length
    : aiRows.filter((r) => r.ai?.enabled || r.headcount?.enabled).length;
  const onlineCount = siteCameras.filter((c) => c.status === 'online').length;
  const activeMore = MORE_AI.find((m) => m.id === category);
  const emptyReason = !siteCameras.length || !onlineCount ? 'nocams'
    : windowEvents.length && !categoryEvents.length ? 'filter'
      : 'none';

  const stream = (
    <EventStream
      events={categoryEvents}
      rangeLabel={range.label}
      selectedId={openEvent?.id}
      onSelect={selectEvent}
      paused={paused}
      onTogglePause={() => setPaused((p) => !p)}
      onClear={() => setClearedAt(Date.now())}
      emptyReason={emptyReason}
      onClearFilters={() => { setCategory('all'); setSite('all'); }}
      onPreviewSample={!demo && !cameras.length ? enterDemo : null}
      now={now}
      className="h-full"
    />
  );

  return (
    <OperationsPage>
      <PageHeader
        icon={Rss}
        title="Live detections"
        description="Real-time AI detections across your cameras and sites."
        actions={(
          <>
            <Select value={site} onValueChange={setSite}>
              <SelectTrigger className="h-9 w-[190px] border-line bg-surface text-small font-semibold text-fg-secondary">
                <MapPinned className="h-3.5 w-3.5 shrink-0 text-brand" strokeWidth={2.1} />
                <SelectValue placeholder="All sites" />
              </SelectTrigger>
              <SelectContent position="popper" className="z-[200]">
                <SelectItem value="all">All sites</SelectItem>
                {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={rangeId} onValueChange={setRangeId}>
              <SelectTrigger className="h-9 w-[150px] border-line bg-surface text-small font-semibold text-fg-secondary">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" className="z-[200]">
                {TIME_RANGES.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <LiveStatus connected={socketOk} aiCameras={aiCameraCount} demo={demo} />
            <Link
              to="/map"
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken"
            >
              <MapIcon className="h-3.5 w-3.5 text-brand" strokeWidth={2.1} />
              View on Map
            </Link>
            <ViewToggle value={layout} onChange={setLayout} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="More actions"
                  className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-surface text-fg-muted transition hover:bg-surface-sunken hover:text-fg"
                >
                  <MoreHorizontal className="h-4 w-4" strokeWidth={2.1} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[200] w-56">
                <DropdownMenuLabel>AI Feed</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => openRegister('')} disabled={demo}>
                  <Plus className="h-4 w-4" /> Register a face
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setZoneEditorOpen(true)} disabled={demo || !selectedCam}>
                  <MapPinned className="h-4 w-4" /> Detection area{selectedCam ? ` · ${selectedCam.name}` : ''}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => selectedId && handleSelect(selectedId)} disabled={demo || !selectedId}>
                  <RefreshCw className="h-4 w-4" /> Reconnect AI
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {demo
                  ? <DropdownMenuItem onSelect={exitDemo}><X className="h-4 w-4" /> Leave sample data</DropdownMenuItem>
                  : <DropdownMenuItem onSelect={enterDemo}><Brain className="h-4 w-4" /> Preview with sample data</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      />

      {/* No cameras on the account → the shared onboarding. Sample mode brings
          its own cameras, so it skips the check. */}
      <RequireCameras
        enabled={!demo}
        description="Add cameras under Camera Setup and enable an AI model on them. Detections will appear here as they happen."
        secondaryAction={(
          <Button variant="outline" size="lg" onClick={enterDemo}>
            <Brain /> Preview with sample data
          </Button>
        )}
      >
      {/* ── Category filter bar + summary strip + grouping ───────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line bg-surface px-2 py-1.5 shadow-sm">
        <div role="tablist" className="flex min-w-0 flex-wrap items-center gap-1">
          {CATEGORIES.map((c) => (
            <FilterTab key={c.id} label={c.label} count={filterCounts[c.id] || 0} active={category === c.id} onClick={() => setCategory(c.id)} />
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 text-small transition',
                  activeMore
                    ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink'
                    : 'border-transparent font-medium text-fg-muted hover:bg-surface-sunken hover:text-fg',
                )}
              >
                {activeMore ? activeMore.label : 'More AI'}
                {activeMore ? <CountPill value={filterCounts[activeMore.id] || 0} active /> : null}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="z-[200] w-60">
              {MORE_AI.map((m) => (
                <DropdownMenuItem key={m.id} onSelect={() => setCategory(m.id)} className="justify-between">
                  <span className={category === m.id ? 'font-semibold text-brand-ink' : ''}>{m.label}</span>
                  <CountPill value={filterCounts[m.id] || 0} active={category === m.id} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="hidden shrink-0 items-center gap-1.5 text-caption font-medium text-fg-muted lg:flex">
          <span className="font-semibold tabular-nums text-fg">{windowEvents.length}</span> active events
          <span className="text-fg-disabled">·</span>
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-danger" /><span className="font-semibold tabular-nums text-fg">{severityCounts.high}</span> critical</span>
          <span className="text-fg-disabled">·</span>
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-warning" /><span className="font-semibold tabular-nums text-fg">{severityCounts.medium}</span> warnings</span>
          <span className="text-fg-disabled">·</span>
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-neutral" /><span className="font-semibold tabular-nums text-fg">{severityCounts.info}</span> informational</span>
        </p>

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-micro font-semibold uppercase tracking-[0.1em] text-fg-subtle">Group by</span>
          <Select value={groupBy} onValueChange={setGroupBy}>
            <SelectTrigger className="h-8 w-[150px] border-line bg-surface text-small font-semibold text-fg-secondary">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="z-[200]">
              {GROUP_MODES.map((g) => <SelectItem key={g.id} value={g.id}>{g.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => setStreamOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken xl:hidden"
          >
            <Radio className="h-3.5 w-3.5 text-brand" strokeWidth={2.1} />
            Events
            <CountPill value={categoryEvents.length} />
          </button>
        </div>
        </div>
      </div>

      {engineStatus.error && !demo ? (
        <div className="flex shrink-0 items-center gap-2 rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-small font-medium text-warning-ink">
          <ScanFace className="h-3.5 w-3.5 shrink-0" strokeWidth={2.1} />
          <span className="min-w-0 flex-1 truncate">{engineStatus.error}</span>
          <button type="button" onClick={() => selectedId && handleSelect(selectedId)} className="shrink-0 font-semibold underline underline-offset-2">Retry</button>
        </div>
      ) : null}

      {/* ── Workspace: camera grid (left) + event stream (right) ──────────── */}
      <PageContent className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(300px,3fr)]">
        <div className="min-h-0 overflow-y-auto pr-1">
          {!siteCameras.length ? (
            <EmptyState
              icon={Cctv}
              title={cameras.length ? 'No cameras at this site' : 'No cameras yet'}
              description={cameras.length
                ? 'Pick another site, or add cameras to this one under Camera Setup.'
                : 'Add a camera group under Camera Setup and enable an AI model on it. Detections will appear here as they happen.'}
              action={(
                <div className="flex items-center gap-2">
                  <Link to="/camera-setup" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 text-small font-semibold text-white transition hover:bg-brand-hover">
                    <Plus className="h-3.5 w-3.5" strokeWidth={2.2} /> Add cameras
                  </Link>
                  {!demo ? (
                    <button type="button" onClick={enterDemo} className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken">
                      Preview with sample data
                    </button>
                  ) : null}
                </div>
              )}
              className="h-full rounded-xl border border-dashed border-line"
            />
          ) : (
            <>
              {!onlineCount ? (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-small font-medium text-danger-ink">
                  <Cctv className="h-3.5 w-3.5 shrink-0" strokeWidth={2.1} />
                  No cameras online{site !== 'all' ? ' at this site' : ''}. Streams and AI detections resume automatically when a device reconnects.
                  <Link to="/health" className="ml-auto shrink-0 font-semibold underline underline-offset-2">Camera Health</Link>
                </div>
              ) : null}
              <div className={cn(
                'grid gap-3',
                layout === 'list' ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2 2xl:grid-cols-3',
              )}>
                {cameraGroups.map((g) => (
                  <div key={g.key} className="contents">
                    {cameraGroups.length > 1 ? <GroupHeading label={g.label} count={g.cams.length} tone={g.tone} /> : null}
                    {g.cams.map((cam) => {
                      const row = aiByMonitor.get(cam.monitorId);
                      const aiEnabled = demo ? cam.status === 'online' : row?.ai?.enabled === true;
                      return (
                        <AiCameraCard
                          key={cam.monitorId}
                          cam={cam}
                          models={modelsFor(cam)}
                          aiEnabled={aiEnabled}
                          aiRunning={demo ? aiEnabled : row?.runtime?.running === true}
                          detections={detectionsByMonitor[cam.monitorId] || EMPTY_DETECTIONS}
                          zones={row?.ai?.detectionZones || []}
                          summary={summaries.get(cam.monitorId) || null}
                          selected={cam.monitorId === selectedId}
                          highlighted={cam.monitorId === highlightId}
                          focusEvent={focus[cam.monitorId] || null}
                          demo={demo}
                          demoEvents={(eventsByCamera.get(cam.monitorId) || []).slice(0, 2)}
                          layout={layout}
                          onOpen={openCamera}
                          onEnableAi={handleEnableAi}
                          registerRef={registerRef}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <aside className="hidden min-h-0 xl:block">{stream}</aside>
      </PageContent>
      </RequireCameras>

      {/* Below xl the stream is a sheet, so the grid keeps its width. */}
      <Sheet open={streamOpen} onOpenChange={setStreamOpen}>
        <SheetContent side="right" className="w-[400px] max-w-[calc(var(--app-vw)*0.92)] p-2" showCloseButton={false} aria-describedby={undefined}>
          <SheetTitle className="sr-only">Latest AI events</SheetTitle>
          {stream}
        </SheetContent>
      </Sheet>

      <EventDetailDrawer
        event={openEvent}
        open={Boolean(openEvent)}
        onOpenChange={(v) => { if (!v) setOpenEvent(null); }}
        onViewCamera={(monitorId) => {
          const cam = cameras.find((c) => c.monitorId === monitorId);
          if (cam) openCamera(cam);
        }}
        onAddToWatchlist={() => { setOpenEvent(null); openRegister(''); }}
        demo={demo}
      />

      <CameraDetailDrawer
        cam={openCam}
        models={openCam ? modelsFor(openCam) : []}
        aiEnabled={openCam ? (demo ? openCam.status === 'online' : aiByMonitor.get(openCam.monitorId)?.ai?.enabled === true) : false}
        aiRunning={openCam ? (demo ? openCam.status === 'online' : aiByMonitor.get(openCam.monitorId)?.runtime?.running === true) : false}
        detections={openCam ? (detectionsByMonitor[openCam.monitorId] || EMPTY_DETECTIONS) : EMPTY_DETECTIONS}
        zones={openCam ? (aiByMonitor.get(openCam.monitorId)?.ai?.detectionZones || []) : []}
        events={openCam ? (eventsByCamera.get(openCam.monitorId) || []) : []}
        open={Boolean(openCam)}
        onOpenChange={(v) => { if (!v) setOpenCameraId(''); }}
        onSelectEvent={selectEvent}
        onEnableAi={handleEnableAi}
        onOpenZones={() => { setOpenCameraId(''); setZoneEditorOpen(true); }}
        onRegisterFace={() => { setOpenCameraId(''); openRegister(''); }}
        demo={demo}
        now={now}
        hasLine={(openCam ? (aiByMonitor.get(openCam.monitorId)?.ai?.detectionZones || []) : []).some((z) => z?.shape === 'line' && Array.isArray(z.points) && z.points.length >= 2)}
      />

      <ZoneEditorModal
        open={zoneEditorOpen}
        camera={selectedCam}
        zones={selectedZones}
        groups={groups}
        saving={savingZones}
        onClose={() => setZoneEditorOpen(false)}
        onSave={handleSaveZones}
        onSelectCamera={handleSelect}
      />

      <RegisterFaceDialog open={registerOpen} onOpenChange={setRegisterOpen} initialName={registerName} />
    </OperationsPage>
  );
}

// ── Register a face (was the inline upload form) ─────────────────────────────

function RegisterFaceDialog({ open, onOpenChange, initialName = '' }) {
  const [name, setName] = useState(initialName);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (open) { setName(initialName); setFile(null); setResult(null); }
  }, [open, initialName]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !file) return;
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('name', name.trim());
      fd.append('file', file);
      const r = await fetch(`${AI_BASE}/upload`, { method: 'POST', body: fd });
      setResult(r.ok ? 'ok' : 'fail');
      if (r.ok) { setName(''); setFile(null); if (fileRef.current) fileRef.current.value = ''; }
    } catch {
      setResult('fail');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-brand" strokeWidth={2.1} /> Register a face
          </DialogTitle>
          <DialogDescription>Add a person to the recognition gallery. A clear, front-facing photo works best.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-micro font-semibold uppercase tracking-[0.1em] text-fg-subtle">Person name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Aastha Sharma"
              className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-body text-fg placeholder:text-fg-subtle outline-none focus:border-line-strong"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-micro font-semibold uppercase tracking-[0.1em] text-fg-subtle">Photo</span>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="h-10 w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-2 text-small text-fg-secondary file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-surface-muted file:px-2.5 file:py-1 file:text-caption file:font-semibold file:text-fg-secondary hover:file:bg-line"
            />
          </label>
          {result === 'ok' ? <p className="text-caption font-semibold text-success-ink">Face saved. Recognition will pick it up shortly.</p> : null}
          {result === 'fail' ? <p className="text-caption font-semibold text-danger-ink">Upload failed. Check the AI service is running.</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => onOpenChange(false)} className="h-9 rounded-lg border border-line bg-surface px-4 text-small font-semibold text-fg-secondary transition hover:bg-surface-sunken">
              Close
            </button>
            <button type="submit" disabled={!name.trim() || !file || busy} className="h-9 rounded-lg bg-brand px-4 text-small font-semibold text-white transition hover:bg-brand-hover disabled:opacity-40">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
