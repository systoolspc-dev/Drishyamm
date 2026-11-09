import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import {
  AlertTriangle, ArrowRight, Bookmark, Camera as CameraIcon, CalendarDays, Check, ChevronDown, CirclePlay,
  Clock, Loader2, Maximize, Pause, Play, RotateCcw, RotateCw, Video, VolumeX,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { PageCard } from '@/core/layout/OperationsPage';
import { cameraHealthService } from '@/core/services/cameraHealth';
import { aiService } from '@/core/services/ai';
import { playbackService } from '@/core/services/playback';
import { relaySupported } from '@/core/services/liveRelay';
import { canDecodeHevc } from '@/core/services/codecSupport';
import { API_BASE } from '@/core/config/endpoints';
import CameraPicker from '@/core/pages/playback/CameraPicker';
import PlaybackTimeline from '@/core/pages/playback/PlaybackTimeline';
import EventsPanel from '@/core/pages/playback/EventsPanel';
import ClipExport from '@/core/pages/playback/ClipExport';
import {
  DAY, EVENT_CATEGORIES, MINUTE, PRESETS, PREROLL_MS, SESSION_MAX_MS, atTime, binToMarker, cameraState, clamp, clipAround,
  dayEnd, dayKey, dayStart, fmtClock, fmtDate, fmtDuration, iso, linkWindow, loadBookmarks, loadThumbs,
  presetWindow, saveBookmarks, saveThumb, timeValue, toPlaybackEvent,
} from '@/core/pages/playback/model';

const SPEEDS = [0.5, 1, 1.5, 2, 4];
const DEFAULT_PRESET = '1h';
const EVENTS_PAGE = 100;
const LAST_CAMERA_KEY = 'playback.lastCamera';
const END_GRACE_MS = 3000;          // slack between the NVR's end of footage and our clock
const STALL_MS = 20_000;            // no new video for this long while playing = the replay died
const RESUME_RESTART_MS = 20_000;   // the NVR keeps replaying while paused; past this, resume re-asks from the paused moment
const HLS_CONFIG = {
  startPosition: 0,                 // from the first second the NVR sent, not the live edge
  backBufferLength: 180,            // keep 3 min behind the playhead for instant rewind
  manifestLoadingMaxRetry: 6,
  manifestLoadingRetryDelay: 1500,
  levelLoadingMaxRetry: 3,
  fragLoadingMaxRetry: 6,
  // The Stream Service hands out its HLS session as a `cookieCheck` cookie on
  // the master playlist (via a 302) and 401s the variant playlist / segments
  // that arrive without it — which Chrome surfaces as the far less obvious
  // `net::ERR_BLOCKED_BY_ORB`. hls.js sends no credentials cross-origin by
  // default, so the cookie never came back. Same fix as the live player's
  // streamCache.js.
  xhrSetup: (xhr) => { xhr.withCredentials = true; },
};

const draftOf = (w) => ({ day: dayKey(w.start), from: timeValue(w.start), to: timeValue(w.end) });
const readLastCamera = () => { try { return localStorage.getItem(LAST_CAMERA_KEY) || ''; } catch { return ''; } };
const saveLastCamera = (id) => { try { localStorage.setItem(LAST_CAMERA_KEY, id); } catch { /* private mode */ } };
const openPicker = (input) => { try { input?.showPicker(); } catch { input?.focus(); } };

/**
 * Playback: review a camera's footage from the NVR.
 *
 * Toolbar picks camera, day and range; the player replays from the NVR (the
 * backend transcodes an RTSP playback session to HLS on demand); the timeline
 * shows where the NVR has footage, the range's AI events and bookmarks, and
 * seeks on click; the events panel lists the same events; Clip Export
 * downloads an MP4 of a sub-range.
 *
 * Seeking inside what's already buffered moves the video; anywhere else asks
 * the NVR for a new session starting at that moment, which is how RTSP
 * playback works. The on-screen clock is the session start plus media time,
 * good to a few seconds; the NVR's burned-in timestamp is the evidence clock.
 */
export default function NvrPlayback() {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const linkMonitor = params.get('monitor') || params.get('camera') || '';
  const linkFrom = params.get('from') || '';
  const linkTo = params.get('to') || '';
  const linkT = params.get('t') || params.get('at') || '';

  // ── Cameras ───────────────────────────────────────────────────────────────
  const camerasQuery = useQuery({
    queryKey: ['playback', 'cameras'],
    queryFn: () => cameraHealthService.list(),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => (camerasQuery.data?.cameras || []).map((c) => ({
    monitorId: c.monitorId, name: c.name, status: c.status, siteName: c.siteName, groupName: c.groupName,
  })), [camerasQuery.data]);

  const [monitorId, setMonitorId] = useState('');
  const [lastCamera] = useState(readLastCamera);
  if (!monitorId && cameras.length) {
    // First camera: the deep link's, then the last one used here, then the first online one.
    const pick = cameras.find((c) => c.monitorId === linkMonitor)
      || cameras.find((c) => c.monitorId === lastCamera)
      || cameras.find((c) => cameraState(c.status).tone === 'success')
      || cameras[0];
    setMonitorId(pick.monitorId);
  }
  const camera = cameras.find((c) => c.monitorId === monitorId) || null;

  // ── Range ─────────────────────────────────────────────────────────────────
  const [win, setWin] = useState(() => presetWindow(DEFAULT_PRESET));
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [draft, setDraft] = useState(() => draftOf(win));
  const [rangeError, setRangeError] = useState(null);
  const [viewMode, setViewMode] = useState('range');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const day = dayKey(win.start);
  const span = useMemo(
    () => (viewMode === 'day' ? { start: dayStart(day), end: dayEnd(day) } : win),
    [viewMode, day, win],
  );

  // ── Player state ──────────────────────────────────────────────────────────
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const speedRef = useRef(null);
  const dateInputRef = useRef(null);
  const fromInputRef = useRef(null);
  const hlsRef = useRef(null);
  // Fast path: the NVR's own stream over the live relay (see attachRelay).
  const relayRef = useRef(null);
  const relayOffRef = useRef(false);   // this browser couldn't play it: HLS from now on
  const fallbackRef = useRef(null);
  const sessionRef = useRef(null);    // { gen, monitorId, startMs, endMs, limit, pathName, mediaBase, played, thumbed, restarts }
  const genRef = useRef(0);           // bumps on every new session; stale async work checks it
  const winRef = useRef(win);
  const monitorRef = useRef(monitorId);
  const phaseRef = useRef('idle');
  const rateRef = useRef(1);
  const wallRef = useRef(null);       // playhead wall clock, updated on every timeupdate
  const pausedAtRef = useRef(null);
  const startRef = useRef(null);
  const lostRef = useRef(null);
  const hideTimer = useRef(null);
  const toastTimer = useRef(null);
  const exportTouchedRef = useRef(false);

  const [phase, setPhaseState] = useState('idle');   // idle | loading | playing | ended | error
  const [error, setError] = useState(null);
  const [wallMs, setWallMs] = useState(null);
  const [bufferedMs, setBufferedMs] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [uiVisible, setUiVisible] = useState(true);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [thumbs, setThumbs] = useState(loadThumbs);
  const [bookmarkVersion, setBookmarkVersion] = useState(0);
  const [hidden, setHidden] = useState(() => new Set());
  const [exportRange, setExportRange] = useState(() => clipAround(win.start + 45_000));
  const [exportNotice, setExportNotice] = useState(null);

  useEffect(() => { winRef.current = win; }, [win]);
  useEffect(() => { monitorRef.current = monitorId; }, [monitorId]);

  const setPhase = useCallback((p) => { phaseRef.current = p; setPhaseState(p); }, []);

  // ── Data ──────────────────────────────────────────────────────────────────
  const eventsQuery = useInfiniteQuery({
    queryKey: ['playback', 'events', monitorId, span.start, span.end],
    enabled: Boolean(monitorId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => aiService.listEvents({
      monitorId, since: iso(span.start), until: iso(span.end), order: 'asc', limit: EVENTS_PAGE, offset: pageParam,
    }),
    getNextPageParam: (last, pages) => (
      last?.pagination?.hasMore ? pages.reduce((n, p) => n + (p?.data?.length || 0), 0) : undefined
    ),
    staleTime: 30_000,
    refetchInterval: span.end > now ? 60_000 : false,
    retry: (n, err) => err?.response?.status !== 403 && n < 2,
  });
  const events = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const page of eventsQuery.data?.pages || []) {
      for (const raw of page?.data || []) {
        const e = toPlaybackEvent(raw);
        if (e && !seen.has(e.id)) { seen.add(e.id); out.push(e); }
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }, [eventsQuery.data]);
  const eventsTotal = eventsQuery.data?.pages?.[0]?.pagination?.total ?? 0;

  const recQuery = useQuery({
    queryKey: ['playback', 'recordings', monitorId, span.start, span.end],
    enabled: Boolean(monitorId),
    queryFn: () => playbackService.recordings({
      monitorId, start: iso(span.start), end: iso(Math.min(span.end, Date.now())),
    }),
    staleTime: 60_000,
    retry: false,
  });
  const recordings = useMemo(() => {
    if (!monitorId) return { status: 'idle', segments: [] };
    if (recQuery.isPending) return { status: 'loading', segments: [] };
    if (recQuery.isError) {
      return { status: 'error', segments: [], message: recQuery.error?.response?.data?.message || 'could not reach the NVR.' };
    }
    if (recQuery.data?.supported === false) return { status: 'unsupported', segments: [], message: recQuery.data.reason };
    return {
      status: 'ok',
      segments: (recQuery.data?.segments || []).map((s) => ({ start: Date.parse(s.start), end: Date.parse(s.end), kind: s.kind })),
    };
  }, [monitorId, recQuery.isPending, recQuery.isError, recQuery.error, recQuery.data]);

  const bookmarks = useMemo(
    () => (monitorId ? loadBookmarks(monitorId) : []),
    // bookmarkVersion re-reads the store after a change.
    [monitorId, bookmarkVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Timeline markers come from the histogram, which covers the whole range;
  // the list's loaded events stand in until it answers (or if it can't).
  const histQuery = useQuery({
    queryKey: ['playback', 'histogram', monitorId, span.start, span.end],
    enabled: Boolean(monitorId),
    queryFn: () => aiService.eventHistogram({ monitorId, since: iso(span.start), until: iso(span.end), buckets: 240 }),
    staleTime: 30_000,
    refetchInterval: span.end > now ? 60_000 : false,
    retry: (n, err) => err?.response?.status !== 403 && n < 2,
  });
  // AI routes answer 403 on plans without AI; that is a plan fact, not a fault.
  const eventsUnavailable = eventsQuery.error?.response?.status === 403
    ? "AI events aren't part of this account's plan. Playback, the timeline and clip export still work."
    : null;

  const markers = useMemo(() => {
    const bins = histQuery.data?.bins;
    const out = bins
      ? bins.map(binToMarker).filter(Boolean)
      : events.map((e) => ({ t: e.t, category: e.category, title: e.title }));
    for (const s of recordings.segments) {
      if (s.kind === 'motion') out.push({ t: s.start, category: 'motion', title: 'Motion recording' });
      else if (s.kind === 'alarm') out.push({ t: s.start, category: 'alarm', title: 'Alarm recording' });
    }
    for (const b of bookmarks) out.push({ t: b.t, category: 'bookmark', title: b.note || 'Bookmark' });
    return out;
  }, [histQuery.data, events, recordings, bookmarks]);

  // The event the playhead is on: the latest one that started within the last 10 s.
  const activeId = useMemo(() => {
    if (wallMs == null) return null;
    let id = null;
    for (const e of events) {
      if (e.t > wallMs + 1000) break;
      if (e.t >= wallMs - 10_000) id = e.id;
    }
    return id;
  }, [events, wallMs]);

  // ── Session ───────────────────────────────────────────────────────────────
  const flash = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  const pokeUi = useCallback(() => {
    setUiVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) { setUiVisible(false); setSpeedOpen(false); }
    }, 2800);
  }, []);

  const teardown = useCallback(() => {
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch { /* ignore */ }
      hlsRef.current = null;
    }
    const r = relayRef.current;
    relayRef.current = null;
    if (r) {
      r.dead = true;
      try { r.ws.close(); } catch { /* closed */ }
      if (r.url) { try { URL.revokeObjectURL(r.url); } catch { /* ignore */ } }
    }
    const v = videoRef.current;
    if (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
    }
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s?.pathName) playbackService.stop(s.pathName).catch(() => {});
  }, []);

  const goIdle = useCallback(() => {
    genRef.current += 1;
    teardown();
    wallRef.current = null;
    setWallMs(null);
    setBufferedMs(null);
    setPlaying(false);
    setError(null);
    setPhase('idle');
  }, [setPhase, teardown]);

  const attach = useCallback((url, gen) => {
    const video = videoRef.current;
    if (!video) return;
    let retries = 0;
    const run = () => {
      if (gen !== genRef.current) return;
      if (Hls.isSupported()) {
        const hls = new Hls(HLS_CONFIG);
        hlsRef.current = hls;
        hls.on(Hls.Events.LEVEL_LOADED, (_e, d) => {
          const s = sessionRef.current;
          if (s?.gen === gen && s.mediaBase == null) s.mediaBase = d?.details?.fragments?.[0]?.start ?? 0;
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (gen !== genRef.current) return;
          setPhase('playing');
          video.playbackRate = rateRef.current;
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d?.fatal || gen !== genRef.current) return;
          try { hls.destroy(); } catch { /* ignore */ }
          if (hlsRef.current === hls) hlsRef.current = null;
          if (sessionRef.current?.played) { lostRef.current?.(gen); return; }
          // Still warming up: the NVR session takes a few seconds to publish.
          if (retries < 6) { retries += 1; setTimeout(run, 2500); return; }
          setPhase('error');
          setError('No footage for this moment, or the NVR returned no playback. Try another time, and check that RTSP playback is enabled on the NVR.');
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        const s = sessionRef.current;
        if (s?.gen === gen) s.mediaBase = 0;
        video.src = url;
        video.addEventListener('loadedmetadata', () => {
          if (gen !== genRef.current) return;
          setPhase('playing');
          video.playbackRate = rateRef.current;
          video.play().catch(() => {});
        }, { once: true });
        video.addEventListener('error', () => {
          if (gen !== genRef.current) return;
          if (sessionRef.current?.played) lostRef.current?.(gen);
          else { setPhase('error'); setError('Playback is unavailable in this browser.'); }
        }, { once: true });
      } else {
        setPhase('error');
        setError('This browser cannot play the stream.');
      }
    };
    run();
  }, [setPhase]);

  // Fast path: the NVR's own stream (H.265 as recorded, no server transcode)
  // over the backend live relay WebSocket into MediaSource. Every frame is
  // appended in order (this is a recording, never skip ahead like live view).
  // If the browser can't decode it, or nothing arrives, replay the HLS way.
  const attachRelay = useCallback((ticket, gen) => {
    const video = videoRef.current;
    if (!video) return;
    const MSE = window.ManagedMediaSource || window.MediaSource;
    const wsBase = /^https?:/.test(API_BASE)
      ? API_BASE.replace(/^http/, 'ws')
      : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${API_BASE}`;
    const ws = new WebSocket(`${wsBase}/api/stream/live?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = 'arraybuffer';
    const r = { ws, ms: null, sb: null, url: null, queue: [], mime: null, expectInit: false, started: false, dead: false, lastTrim: 0 };
    relayRef.current = r;

    const trim = (force) => {
      if (!r.sb || r.sb.updating || !video.buffered.length) return;
      const now = performance.now();
      if (!force && now - r.lastTrim < 10_000) return;
      r.lastTrim = now;
      const cut = video.currentTime - 120;           // keep 2 min behind for instant rewind
      if (cut > video.buffered.start(0) + 1) { try { r.sb.remove(video.buffered.start(0), cut); } catch { /* ignore */ } }
    };
    const pump = () => {
      if (r.dead || !r.sb || r.sb.updating || !r.queue.length) return;
      const next = r.queue.shift();
      try { r.sb.appendBuffer(next); } catch (err) {
        if (err?.name === 'QuotaExceededError') { r.queue.unshift(next); trim(true); }
      }
    };
    const onUpdateEnd = () => {
      if (r.dead || gen !== genRef.current) return;
      if (!r.started && video.buffered.length) {
        r.started = true;
        const s = sessionRef.current;
        if (s?.gen === gen) s.mediaBase = video.buffered.start(0);
        video.currentTime = video.buffered.start(0);
        setPhase('playing');
        video.playbackRate = rateRef.current;
        video.play().catch(() => {});
      }
      trim(false);
      pump();
    };
    ws.onmessage = (e) => {
      if (r.dead || gen !== genRef.current) return;
      if (typeof e.data === 'string') {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'init') {
          if (!MSE || !MSE.isTypeSupported(msg.mime)) {
            relayOffRef.current = true;
            r.dead = true;
            try { ws.close(); } catch { /* closed */ }
            fallbackRef.current?.(gen);
            return;
          }
          r.mime = msg.mime;
          r.expectInit = !r.ms;                    // a second init (never sent for a replay) is ignored
        }
        return;
      }
      const u8 = new Uint8Array(e.data);
      if (r.expectInit) {
        r.expectInit = false;
        r.ms = new MSE();
        if (window.ManagedMediaSource && r.ms instanceof window.ManagedMediaSource) video.disableRemotePlayback = true;
        r.url = URL.createObjectURL(r.ms);
        video.removeAttribute('src');
        video.src = r.url;
        r.queue.push(u8);
        r.ms.addEventListener('sourceopen', () => {
          if (r.dead) return;
          try {
            r.sb = r.ms.addSourceBuffer(r.mime);
            r.sb.mode = 'segments';
            r.sb.addEventListener('updateend', onUpdateEnd);
            pump();
          } catch {
            relayOffRef.current = true;
            r.dead = true;
            try { ws.close(); } catch { /* closed */ }
            fallbackRef.current?.(gen);
          }
        }, { once: true });
        return;
      }
      if (!r.ms) return;
      r.queue.push(u8);
      pump();
    };
    ws.onclose = () => {
      if (r.dead || gen !== genRef.current) return;
      // Closed before a single frame: the NVR had nothing, or refused. Let the
      // HLS path try (it reports "no footage" properly). After playing, the
      // stall check sees the end and carries on from there.
      if (!r.started) fallbackRef.current?.(gen);
    };
  }, [setPhase]);

  // Replay from `target` (epoch ms). Inside the range it plays to the range's
  // end; outside it (day view) to the end of that day. Sessions are cut into
  // the backend's 6-hour slices and continue on their own.
  const startSession = useCallback(async (target, opts = {}) => {
    const mon = opts.monitor || monitorRef.current;
    if (!mon) return;
    const w = opts.window || winRef.current;
    const nowMs = Date.now();
    const startMs = Math.round(Math.min(target, nowMs - 5000));
    const limit = startMs >= w.start && startMs < w.end ? w.end : Math.min(dayEnd(dayKey(startMs)), nowMs);
    const endMs = Math.min(limit, startMs + SESSION_MAX_MS, nowMs);

    const gen = ++genRef.current;
    teardown();
    setSpeedOpen(false);
    wallRef.current = startMs;
    setWallMs(startMs);
    setBufferedMs(null);
    setPlaying(false);
    if (endMs - startMs < 2000) {
      setPhase('error');
      setError('The NVR has not written this moment yet. Pick an earlier time.');
      return;
    }
    sessionRef.current = {
      gen, monitorId: mon, startMs, endMs, limit,
      pathName: null, mediaBase: null, played: false, thumbed: false, restarts: opts.restarts || 0,
    };
    pausedAtRef.current = null;
    setError(null);
    setPhase('loading');
    if (!exportTouchedRef.current) setExportRange(clipAround(startMs));
    try {
      // The server picks: H.265 NVRs only for browsers that decode it, H.264
      // site relays for every browser. The init check below catches the rest.
      const relay = !opts.noRelay && !relayOffRef.current && relaySupported();
      const data = await playbackService.start({ monitorId: mon, start: iso(startMs), end: iso(endMs), relay, hevc: canDecodeHevc() });
      if (gen !== genRef.current) { playbackService.stop(data.pathName).catch(() => {}); return; }
      sessionRef.current.pathName = data.pathName;
      if (data.mode === 'relay' && data.ticket) attachRelay(data.ticket, gen);
      else attach(data.hlsUrl, gen);
    } catch (e) {
      if (gen !== genRef.current) return;
      setPhase('error');
      setError(e?.response?.data?.message || 'Could not start NVR playback.');
    }
  }, [attach, attachRelay, setPhase, teardown]);

  const onStreamLost = useCallback((gen) => {
    const s = sessionRef.current;
    if (!s || s.gen !== gen) return;
    const at = wallRef.current ?? s.startMs;
    const restarts = at - s.startMs > 5000 ? 0 : s.restarts + 1;
    if (restarts > 2) {
      teardown();
      setPlaying(false);
      setPhase('error');
      setError('The NVR keeps dropping this playback. Try again in a moment.');
      return;
    }
    // Cut short (the 30-minute session cap, an NVR hiccup): carry on from here.
    if (at < s.endMs - END_GRACE_MS) { startRef.current?.(at, { restarts }); return; }
    // Finished one 6-hour slice of a longer range: start the next.
    if (s.endMs < s.limit - END_GRACE_MS) { startRef.current?.(s.endMs); return; }
    teardown();
    setPlaying(false);
    setPhase('ended');
  }, [setPhase, teardown]);

  useEffect(() => {
    startRef.current = startSession;
    lostRef.current = onStreamLost;
    // Fast path failed before playing: same moment again, the HLS way.
    fallbackRef.current = (gen) => {
      const s = sessionRef.current;
      if (!s || s.gen !== gen) return;
      startSession(s.startMs, { noRelay: true, restarts: s.restarts });
    };
  }, [startSession, onStreamLost]);

  // A replay can die without an error (the NVR stops sending): no new video
  // for STALL_MS while playing is treated as the stream ending.
  useEffect(() => {
    if (phase !== 'playing') return undefined;
    let lastEnd = -1;
    let lastChange = Date.now();
    const id = setInterval(() => {
      const v = videoRef.current;
      const s = sessionRef.current;
      if (!v || !s || v.paused || !s.played) { lastChange = Date.now(); return; }
      let end = 0;
      try { end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; } catch { /* ignore */ }
      if (end > lastEnd + 0.1) { lastEnd = end; lastChange = Date.now(); return; }
      if (Date.now() - lastChange > STALL_MS && v.currentTime >= end - 0.5) lostRef.current?.(s.gen);
    }, 2000);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => () => { genRef.current += 1; teardown(); }, [teardown]);
  useEffect(() => {
    const onHide = () => {
      const s = sessionRef.current;
      if (s?.pathName) playbackService.stopBeacon(s.pathName);
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  const grabThumb = useCallback((s) => {
    const v = videoRef.current;
    if (!v?.videoWidth || sessionRef.current !== s) return;
    try {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 90;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      saveThumb(s.monitorId, c.toDataURL('image/jpeg', 0.7));
      setThumbs(loadThumbs());
    } catch { /* a cross-origin stream taints the canvas: keep the icon */ }
  }, []);

  const onTimeUpdate = () => {
    const v = videoRef.current;
    const s = sessionRef.current;
    if (!v || !s) return;
    const base = s.mediaBase ?? 0;
    const wall = s.startMs + Math.max(0, v.currentTime - base) * 1000;
    wallRef.current = wall;
    // Re-render once a second, not on every timeupdate.
    setWallMs((prev) => (prev != null && Math.floor(prev / 1000) === Math.floor(wall / 1000) ? prev : wall));
    try {
      if (v.buffered.length) {
        const end = s.startMs + Math.max(0, v.buffered.end(v.buffered.length - 1) - base) * 1000;
        setBufferedMs((prev) => (prev != null && Math.abs(prev - end) < 1000 ? prev : end));
      }
    } catch { /* ignore */ }
  };
  const onPlay = () => { setPlaying(true); pausedAtRef.current = null; pokeUi(); };
  const onPlaying = () => {
    const s = sessionRef.current;
    if (!s) return;
    s.played = true;
    if (!s.thumbed) { s.thumbed = true; setTimeout(() => grabThumb(s), 1200); }
  };
  const onPause = () => { setPlaying(false); setUiVisible(true); pausedAtRef.current = Date.now(); };

  // ── Controls ──────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const ph = phaseRef.current;
    if (ph === 'idle' || ph === 'error') { startRef.current?.(wallRef.current ?? winRef.current.start); return; }
    if (ph === 'ended') { startRef.current?.(winRef.current.start); return; }
    const v = videoRef.current;
    if (ph !== 'playing' || !v) return;
    if (!v.paused) { v.pause(); return; }
    if (pausedAtRef.current && Date.now() - pausedAtRef.current > RESUME_RESTART_MS) {
      startRef.current?.(wallRef.current ?? winRef.current.start);
      return;
    }
    v.play().catch(() => {});
  }, []);

  const seekTo = useCallback((target, { preroll = false } = {}) => {
    const t = Math.min(target - (preroll ? PREROLL_MS : 0), Date.now() - 5000);
    const v = videoRef.current;
    const s = sessionRef.current;
    if (v && s && (hlsRef.current || relayRef.current) && s.mediaBase != null && phaseRef.current === 'playing' && t >= s.startMs && t <= s.endMs) {
      const pos = s.mediaBase + (t - s.startMs) / 1000;
      for (let i = 0; i < v.buffered.length; i += 1) {
        if (pos >= v.buffered.start(i) && pos <= v.buffered.end(i) - 0.5) {
          v.currentTime = pos;
          if (v.paused) v.play().catch(() => {});
          return;
        }
      }
    }
    startRef.current?.(t);
  }, []);

  const nudge = useCallback((sec) => {
    seekTo((wallRef.current ?? winRef.current.start) + sec * 1000);
    pokeUi();
  }, [seekTo, pokeUi]);

  const setSpeed = useCallback((r) => {
    rateRef.current = r;
    setRateState(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
    setSpeedOpen(false);
  }, []);
  const stepSpeed = useCallback((dir) => {
    const i = SPEEDS.indexOf(rateRef.current);
    setSpeed(SPEEDS[clamp(i + dir, 0, SPEEDS.length - 1)]);
  }, [setSpeed]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) stageRef.current?.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }, []);

  const addBookmarkAt = useCallback((t, note = '') => {
    const mon = monitorRef.current;
    if (!mon || !Number.isFinite(t)) return;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    saveBookmarks(mon, [...loadBookmarks(mon), { id, t: Math.round(t), note }]);
    setBookmarkVersion((n) => n + 1);
    flash(`Bookmark added · ${fmtClock(t)}`);
  }, [flash]);
  const addBookmark = useCallback(() => addBookmarkAt(wallRef.current ?? winRef.current.start), [addBookmarkAt]);
  const bookmarkEvent = useCallback((e) => addBookmarkAt(e.t, e.title), [addBookmarkAt]);
  const deleteBookmark = useCallback((id) => {
    const mon = monitorRef.current;
    if (!mon) return;
    saveBookmarks(mon, loadBookmarks(mon).filter((b) => b.id !== id));
    setBookmarkVersion((n) => n + 1);
  }, []);
  const renameBookmark = useCallback((id, note) => {
    const mon = monitorRef.current;
    if (!mon) return;
    saveBookmarks(mon, loadBookmarks(mon).map((b) => (b.id === id ? { ...b, note } : b)));
    setBookmarkVersion((n) => n + 1);
  }, []);

  const snapshot = useCallback(() => {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    const t = wallRef.current ?? winRef.current.start;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const a = document.createElement('a');
      a.href = c.toDataURL('image/jpeg', 0.92);
      a.download = `${(camera?.name || 'camera').replace(/[^\w.-]+/g, '_')}_${dayKey(t)}_${timeValue(t, true).replace(/:/g, '-')}.jpg`;
      a.click();
      flash(`Snapshot saved · ${fmtClock(t)}`);
    } catch {
      flash('Snapshot unavailable for this stream');
    }
  }, [camera, flash]);

  // ── Range & camera changes ────────────────────────────────────────────────
  const applyWindow = useCallback((w, { play = false, presetId = null } = {}) => {
    winRef.current = w;
    setWin(w);
    setPreset(presetId);
    setDraft(draftOf(w));
    setRangeError(null);
    exportTouchedRef.current = false;
    setExportRange(clipAround(w.start + 45_000));
    const ph = phaseRef.current;
    if (play || ph === 'playing' || ph === 'loading') startRef.current?.(w.start, { window: w });
    else goIdle();          // idle, ended or failed: the new range waits for Play
  }, [goIdle]);

  const selectCamera = useCallback((id) => {
    if (!id || id === monitorRef.current) return;
    monitorRef.current = id;
    setMonitorId(id);
    saveLastCamera(id);
    const ph = phaseRef.current;
    // Watching: the same moment on the other camera. Otherwise wait for Play.
    if (ph === 'playing' || ph === 'loading') startRef.current?.(wallRef.current ?? winRef.current.start, { monitor: id });
    else goIdle();
  }, [goIdle]);

  const applyPreset = (id) => applyWindow(presetWindow(id), { presetId: id });

  const rangeFromDraft = (d) => {
    if (!d.from || !d.to) return { problem: 'Enter a start and an end time.' };
    const start = atTime(d.day, d.from);
    let end = atTime(d.day, d.to);
    if (end <= start) end += DAY;           // 22:00 → 02:00 runs past midnight
    const nowMs = Date.now();
    if (start >= nowMs - MINUTE) return { problem: `${fmtDate(start)}, ${d.from} hasn't happened yet. Pick an earlier start.` };
    return { range: { start, end: Math.min(end, nowMs) } };
  };

  // The time range applies on Enter (which also re-asks for the range's
  // events and footage) or when focus leaves the range control with an edit.
  const applyDraft = ({ refresh = false } = {}) => {
    const { problem, range } = rangeFromDraft(draft);
    if (problem) { setRangeError(problem); return; }
    applyWindow(range);
    if (!refresh) return;
    queryClient.invalidateQueries({ queryKey: ['playback', 'events', monitorId] });
    queryClient.invalidateQueries({ queryKey: ['playback', 'recordings', monitorId] });
  };

  const changeDay = (key) => {
    if (!key) return;
    const next = { ...draft, day: key };
    setDraft(next);
    const { problem, range } = rangeFromDraft(next);
    if (problem) { setRangeError(problem); return; }
    applyWindow(range);
  };

  const dirty = draft.day !== dayKey(win.start) || draft.from !== timeValue(win.start) || draft.to !== timeValue(win.end);

  const jumpToBookmark = useCallback((b) => {
    if (b.t >= span.start && b.t <= span.end) { seekTo(b.t, { preroll: true }); return; }
    applyWindow({ start: b.t - 30_000, end: Math.min(b.t + 2 * MINUTE, Date.now()) }, { play: true });
  }, [span, seekTo, applyWindow]);

  const playEvent = useCallback((e) => seekTo(e.t, { preroll: true }), [seekTo]);

  const changeExport = useCallback((r) => {
    exportTouchedRef.current = true;
    setExportRange(r);
    setExportNotice(null);
  }, []);
  const exportAround = useCallback((e) => {
    changeExport({ start: e.t - 15_000, end: Math.min(e.t + 45_000, Date.now()) });
    document.getElementById('clip-export')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [changeExport]);

  const runExport = (format) => {
    if (!camera) return;
    const start = exportRange.start;
    const end = Math.min(exportRange.end, Date.now());
    if (end - start < 1000) { setExportNotice({ tone: 'danger', text: "This clip hasn't been recorded yet." }); return; }
    const stamp = (ms) => timeValue(ms, true).replace(/:/g, '-');
    const url = playbackService.exportUrl({
      monitorId: camera.monitorId,
      start: iso(start),
      end: iso(end),
      format,
      name: `${camera.name}_${dayKey(start)}_${stamp(start)}_to_${stamp(end)}`,
    });
    playbackService.download(url, end - start, (message) => setExportNotice({ tone: 'danger', text: message }));
    setExportNotice({
      tone: 'info',
      text: `Exporting ${fmtDuration(end - start)} as ${format === 'original' ? 'the original stream' : 'MP4'}. Your browser saves it as it arrives; that takes about as long as the clip, because the NVR replays it in real time.`,
    });
  };

  const toggleLayer = useCallback((id) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  const showAllEvents = useCallback(() => setHidden((prev) => {
    const next = new Set(prev);
    for (const c of EVENT_CATEGORIES) next.delete(c);
    return next;
  }), []);

  // ── Deep links: ?monitor|camera= picks the camera; ?from&to or ?t= plays ──
  const appliedLinkRef = useRef('');
  useEffect(() => {
    if (!linkMonitor || !cameras.some((c) => c.monitorId === linkMonitor)) return undefined;
    const key = `${linkMonitor}|${linkFrom}|${linkTo}|${linkT}`;
    if (appliedLinkRef.current === key) return undefined;
    // Deferred a tick so the updates happen in a callback, not in the effect.
    const timer = setTimeout(() => {
      appliedLinkRef.current = key;
      selectCamera(linkMonitor);
      const w = linkWindow(linkFrom, linkTo, linkT);
      if (w) applyWindow(w, { play: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [cameras, linkMonitor, linkFrom, linkTo, linkT, selectCamera, applyWindow]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (el?.closest?.('[role="menu"],[role="dialog"],[role="listbox"]')) return;
      const k = e.key.toLowerCase();
      if ((k === ' ' || k === 'enter') && tag === 'BUTTON') return;   // the focused button handles it
      if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); pokeUi(); }
      else if (k === 'arrowleft' || k === 'j') { e.preventDefault(); nudge(-10); }
      else if (k === 'arrowright' || k === 'l') { e.preventDefault(); nudge(10); }
      else if (k === 'b') addBookmark();
      else if (k === 'f') toggleFullscreen();
      else if (k === '>' || k === '.') stepSpeed(1);
      else if (k === '<' || k === ',') stepSpeed(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, nudge, addBookmark, toggleFullscreen, stepSpeed, pokeUi]);

  useEffect(() => {
    if (!speedOpen) return undefined;
    const close = (e) => { if (!speedRef.current?.contains(e.target)) setSpeedOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setSpeedOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onEsc);
    };
  }, [speedOpen]);

  // ── Render ────────────────────────────────────────────────────────────────
  const shownTime = wallMs ?? win.start;
  const winSpan = Math.max(1, win.end - win.start);
  const pctOfWin = (ms) => clamp(((ms - win.start) / winSpan) * 100, 0, 100);
  const playedPct = pctOfWin(shownTime);
  const bufferedPct = bufferedMs != null ? pctOfWin(bufferedMs) : playedPct;
  const overlayOn = uiVisible || !playing;
  const pill = 'flex h-11 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 transition hover:border-line-strong';
  const timeInput = 'w-22 bg-transparent text-small font-medium tabular-nums text-fg outline-none [&::-webkit-calendar-picker-indicator]:hidden';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 pb-1">
        {/* ── Toolbar: camera, day, range, quick range ── */}
        <div className="flex flex-wrap items-center gap-2">
          <CameraPicker
            cameras={cameras}
            value={monitorId}
            onChange={selectCamera}
            thumbs={thumbs}
            loading={camerasQuery.isPending}
          />

          <div className="relative">
            <button type="button" onClick={() => openPicker(dateInputRef.current)} aria-label="Choose date" className={pill}>
              <CalendarDays className="h-4 w-4 text-fg-muted" />
              <span className="whitespace-nowrap text-small font-medium text-fg">{fmtDate(atTime(draft.day, '12:00'))}</span>
              <ChevronDown className="h-3.5 w-3.5 text-fg-subtle" />
            </button>
            <input
              ref={dateInputRef}
              type="date"
              value={draft.day}
              max={dayKey(now)}
              onChange={(e) => changeDay(e.target.value)}
              tabIndex={-1}
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
            />
          </div>

          <div
            onBlur={(e) => { if (dirty && !e.currentTarget.contains(e.relatedTarget)) applyDraft(); }}
            title="Press Enter to apply"
            className={cn(pill, 'focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15')}
          >
            <button type="button" tabIndex={-1} aria-hidden onClick={() => openPicker(fromInputRef.current)} className="text-fg-muted transition hover:text-fg">
              <Clock className="h-4 w-4" />
            </button>
            <input
              ref={fromInputRef}
              type="time"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') applyDraft({ refresh: true }); }}
              aria-label="From time"
              className={timeInput}
            />
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <input
              type="time"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') applyDraft({ refresh: true }); }}
              aria-label="To time"
              className={timeInput}
            />
          </div>

          <span aria-hidden className="mx-1 hidden h-6 w-px bg-line sm:block" />

          <div role="group" aria-label="Quick range" className="inline-flex h-11 items-center gap-0.5 rounded-lg border border-line bg-surface-sunken p-1">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={preset === p.id}
                onClick={() => applyPreset(p.id)}
                className={cn(
                  'h-full whitespace-nowrap rounded-md border px-3 text-small transition',
                  preset === p.id
                    ? 'border-brand/50 bg-brand-soft font-semibold text-brand-ink'
                    : 'border-transparent font-medium text-fg-muted hover:bg-surface/70 hover:text-fg',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {rangeError ? (
          <p className="-mt-1 flex items-center gap-1.5 text-small font-medium text-danger-ink">
            <AlertTriangle className="h-3.5 w-3.5" /> {rangeError}
          </p>
        ) : null}

        {/* Video + Timeline on the left (~71%), Events beside them (~29%),
            ending with the timeline. Stacked below xl: video, events, timeline. */}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_clamp(340px,29%,460px)] xl:grid-rows-[auto_auto]">
          <div className="order-1 min-w-0 xl:order-none xl:col-start-1 xl:row-start-1">
            {/* ── Player ── */}
            <PageCard className="overflow-hidden bg-black">
              <div
                ref={stageRef}
                onMouseMove={pokeUi}
                onMouseLeave={() => { if (playing) setUiVisible(false); }}
                className={cn('group relative aspect-video max-h-[calc(var(--app-vh)*0.62)] w-full bg-black', !overlayOn && 'cursor-none')}
              >
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  onTimeUpdate={onTimeUpdate}
                  onProgress={onTimeUpdate}
                  onPlay={onPlay}
                  onPlaying={onPlaying}
                  onPause={onPause}
                  onClick={togglePlay}
                  className="absolute inset-0 h-full w-full cursor-pointer object-contain"
                />

                <div className={cn('pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-3 transition-opacity duration-200', overlayOn ? 'opacity-100' : 'opacity-0')}>
                  <div className="min-w-0 rounded-md bg-black/55 px-2.5 py-1.5 backdrop-blur-sm">
                    <p className="truncate text-small font-semibold text-white">{camera?.name || 'No camera selected'}</p>
                    <p className="mt-0.5 text-caption tabular-nums text-white/80">
                      {fmtDate(shownTime)}<span className="ml-2">{fmtClock(shownTime)}</span>
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-black/55 px-2.5 py-1.5 text-caption font-semibold text-white backdrop-blur-sm">
                    <CirclePlay className="h-3.5 w-3.5 text-brand" />
                    {rate === 1 ? 'Normal Playback' : `${rate}× Playback`}
                  </span>
                </div>

                {toast ? (
                  <div className="pointer-events-none absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-caption font-semibold text-white">
                    {toast}
                  </div>
                ) : null}

                {phase === 'idle' ? (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/80 p-6">
                    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                      <button
                        type="button"
                        onClick={togglePlay}
                        disabled={!camera}
                        aria-label="Play"
                        className="grid h-16 w-16 place-items-center rounded-full bg-brand text-white shadow-lg transition hover:scale-105 hover:bg-brand-hover disabled:opacity-50"
                      >
                        <Play className="ml-1 h-7 w-7" fill="currentColor" />
                      </button>
                      <p className="text-body font-semibold text-white">
                        {camera ? `Play from ${fmtClock(win.start)}` : 'Pick a camera to review its footage'}
                      </p>
                      <p className="text-small text-white/60">
                        {camera
                          ? 'Or click any moment on the timeline, or an event. Footage is replayed from the NVR.'
                          : 'Cameras you add under Setup › Add cameras appear in the picker above.'}
                      </p>
                    </div>
                  </div>
                ) : null}

                {phase === 'loading' ? (
                  <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-slate-950/60">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <Loader2 className="h-8 w-8 animate-spin text-brand" />
                      <p className="text-body font-semibold text-white">Fetching footage from the NVR…</p>
                      <p className="text-small text-white/60">On-demand playback takes a few seconds to start.</p>
                    </div>
                  </div>
                ) : null}

                {phase === 'error' ? (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/85 p-6">
                    <div className="flex max-w-md flex-col items-center gap-3 text-center">
                      <AlertTriangle className="h-8 w-8 text-danger" />
                      <p className="text-body font-semibold text-white">{error}</p>
                      <button
                        type="button"
                        onClick={togglePlay}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-small font-semibold text-white transition hover:bg-white/20"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Try again
                      </button>
                    </div>
                  </div>
                ) : null}

                {phase === 'ended' ? (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/75 p-6">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <Video className="h-8 w-8 text-white/60" />
                      <p className="text-body font-semibold text-white">End of the selected range</p>
                      <button
                        type="button"
                        onClick={togglePlay}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-small font-semibold text-white transition hover:bg-brand-hover"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Play again from {fmtClock(win.start)}
                      </button>
                    </div>
                  </div>
                ) : null}

                {phase === 'playing' && !playing ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={togglePlay}
                    aria-label="Resume"
                    className="absolute inset-0 z-10 grid place-items-center"
                  >
                    <span className="grid h-16 w-16 place-items-center rounded-full bg-black/45 text-white ring-1 ring-white/20 backdrop-blur-sm">
                      <Play className="ml-1 h-7 w-7" fill="currentColor" />
                    </span>
                  </button>
                ) : null}

                {/* ── Transport ── */}
                <div
                  className={cn(
                    'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 pb-3 pt-10 transition-opacity duration-200',
                    overlayOn ? 'opacity-100' : 'pointer-events-none opacity-0',
                  )}
                >
                  <div
                    role="presentation"
                    onClick={(e) => {
                      if (!camera) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      seekTo(win.start + clamp((e.clientX - r.left) / r.width, 0, 1) * winSpan);
                    }}
                    className="group/bar relative h-4 cursor-pointer"
                    title="Click to play from here"
                  >
                    <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20 transition-[height] group-hover/bar:h-1.5">
                      <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${bufferedPct}%` }} />
                      <div className="absolute inset-y-0 left-0 bg-brand" style={{ width: `${playedPct}%` }} />
                    </div>
                    <div
                      className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-brand shadow ring-2 ring-white transition-transform group-hover/bar:scale-100"
                      style={{ left: `${playedPct}%` }}
                    />
                  </div>

                  {/* Wraps on phones, where time + transport + tools cannot share one row. */}
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 sm:grid sm:grid-cols-[1fr_auto_1fr]">
                    <div className="min-w-0 truncate text-small font-semibold tabular-nums text-white">
                      {fmtClock(shownTime)} <span className="font-medium text-white/60">/ {fmtClock(win.end)}</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <PlayerButton label="Back 10 s (←)" onClick={() => nudge(-10)} disabled={!camera}>
                        <RotateCcw className="h-4 w-4" /><span className="text-caption">10s</span>
                      </PlayerButton>
                      <button
                        type="button"
                        onClick={togglePlay}
                        disabled={!camera || phase === 'loading'}
                        aria-label={playing ? 'Pause (space)' : 'Play (space)'}
                        title={playing ? 'Pause (space)' : 'Play (space)'}
                        className="grid h-10 w-10 place-items-center rounded-full bg-white text-slate-950 shadow transition hover:scale-105 disabled:opacity-60 disabled:hover:scale-100"
                      >
                        {phase === 'loading'
                          ? <Loader2 className="h-5 w-5 animate-spin" />
                          : playing
                            ? <Pause className="h-5 w-5" fill="currentColor" />
                            : <Play className="ml-0.5 h-5 w-5" fill="currentColor" />}
                      </button>
                      <PlayerButton label="Forward 10 s (→)" onClick={() => nudge(10)} disabled={!camera}>
                        <span className="text-caption">10s</span><RotateCw className="h-4 w-4" />
                      </PlayerButton>
                    </div>

                    <div className="flex items-center justify-end gap-0.5">
                      <div ref={speedRef} className="relative">
                        <button
                          type="button"
                          onClick={() => setSpeedOpen((o) => !o)}
                          aria-haspopup="menu"
                          aria-expanded={speedOpen}
                          title="Playback speed (< >)"
                          className="inline-flex h-8 items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 text-small font-semibold tabular-nums text-white transition hover:bg-white/20"
                        >
                          {rate}x <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                        {speedOpen ? (
                          <div role="menu" className="absolute bottom-full right-0 z-30 mb-2 w-56 rounded-lg border border-white/10 bg-slate-950/95 p-1 shadow-xl backdrop-blur">
                            {SPEEDS.map((s) => (
                              <button
                                key={s}
                                type="button"
                                role="menuitemradio"
                                aria-checked={rate === s}
                                onClick={() => setSpeed(s)}
                                className={cn(
                                  'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-small font-semibold tabular-nums transition',
                                  rate === s ? 'bg-brand/20 text-white' : 'text-white/80 hover:bg-white/10',
                                )}
                              >
                                {s === 1 ? 'Normal' : `${s}×`}
                                {rate === s ? <Check className="h-3.5 w-3.5 text-brand" /> : null}
                              </button>
                            ))}
                            <p className="mt-1 border-t border-white/10 px-2.5 pb-1 pt-1.5 text-caption text-white/55">
                              The NVR replays in real time, so faster speeds pause now and then to catch up.
                            </p>
                          </div>
                        ) : null}
                      </div>
                      <span title="No audio: NVR playback carries video only">
                        <PlayerButton label="No audio in NVR playback" disabled><VolumeX className="h-4 w-4" /></PlayerButton>
                      </span>
                      <PlayerButton label="Save snapshot" onClick={snapshot} disabled={phase !== 'playing'}>
                        <CameraIcon className="h-4 w-4" />
                      </PlayerButton>
                      <PlayerButton label="Bookmark this moment (B)" onClick={addBookmark} disabled={!camera}>
                        <Bookmark className="h-4 w-4" />
                      </PlayerButton>
                      <PlayerButton label="Fullscreen (F)" onClick={toggleFullscreen}>
                        <Maximize className="h-4 w-4" />
                      </PlayerButton>
                    </div>
                  </div>
                </div>
              </div>
            </PageCard>
          </div>

          <div className="order-3 min-w-0 xl:order-none xl:col-start-1 xl:row-start-2">
            <PlaybackTimeline
              span={span}
              range={win}
              viewMode={viewMode}
              onViewMode={setViewMode}
              now={now}
              playhead={wallMs}
              recordings={recordings}
              markers={markers}
              exportRange={exportRange}
              hidden={hidden}
              onToggleLayer={toggleLayer}
              onSeek={seekTo}
            />
          </div>

          {/* Sized by the video + timeline beside it, never by its own list. */}
          <div className="relative order-2 min-h-0 xl:order-none xl:col-start-2 xl:row-span-2 xl:row-start-1">
            <EventsPanel
              className="h-112 xl:absolute xl:inset-0 xl:h-auto"
              cameraName={camera?.name || 'this camera'}
              listKey={`${monitorId}|${span.start}|${span.end}`}
              events={events}
              total={eventsTotal}
              loading={Boolean(monitorId) && eventsQuery.isPending}
              error={eventsQuery.isError && !eventsUnavailable ? (eventsQuery.error?.response?.data?.message || 'The events service did not answer.') : null}
              unavailable={eventsUnavailable}
              onRetry={eventsQuery.refetch}
              canFetchMore={Boolean(eventsQuery.hasNextPage)}
              fetchingMore={eventsQuery.isFetchingNextPage}
              onFetchMore={eventsQuery.fetchNextPage}
              hidden={hidden}
              onToggleCategory={toggleLayer}
              onShowAll={showAllEvents}
              activeId={activeId}
              onPlay={playEvent}
              onExportAround={exportAround}
              onBookmarkEvent={bookmarkEvent}
              bookmarks={bookmarks}
              onJumpBookmark={jumpToBookmark}
              onDeleteBookmark={deleteBookmark}
              onRenameBookmark={renameBookmark}
            />
          </div>
        </div>

        <ClipExport
          id="clip-export"
          range={exportRange}
          onChange={changeExport}
          playhead={wallMs}
          canExport={Boolean(camera)}
          onExport={runExport}
          notice={exportNotice}
          onDismissNotice={() => setExportNotice(null)}
        />
      </div>
    </div>
  );
}

/** A transport-bar button: white on the video, whatever the theme. */
export function PlayerButton({ label, onClick, disabled, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-small font-semibold text-white/90 transition hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
