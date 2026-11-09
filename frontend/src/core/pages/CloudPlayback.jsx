import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Bookmark, Building2, CalendarDays, Check, ChevronDown, CirclePlay, Clock,
  LayoutGrid, Loader2, Maximize, Pause, Play, RotateCcw, RotateCw, SkipForward, Video, Volume2, VolumeX,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { PageCard } from '@/core/layout/OperationsPage';
import { useGroups } from '@/core/hooks/useQueries';
import { cameraHealthService } from '@/core/services/cameraHealth';
import { aiService } from '@/core/services/ai';
import { getCameraRecordings, getDownloadUrl, getExportUrl, getStreamUrl } from '@/core/services/recordings';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/core/ui/sheet';
import Gallery from '@/core/pages/Gallery';
import { PlayerButton } from '@/core/pages/NvrPlayback';
import CameraPicker from '@/core/pages/playback/CameraPicker';
import PlaybackTimeline from '@/core/pages/playback/PlaybackTimeline';
import EventsPanel from '@/core/pages/playback/EventsPanel';
import ClipExport from '@/core/pages/playback/ClipExport';
import {
  DAY, EVENT_CATEGORIES, MINUTE, PRESETS, PREROLL_MS, atTime, clamp, clipAround, dayEnd, dayKey, dayStart,
  fmtClock, fmtDate, fmtDuration, iso, loadBookmarks, loadThumbs, presetWindow, saveBookmarks, timeValue,
  toPlaybackEvent,
} from '@/core/pages/playback/model';

const SPEEDS = [0.5, 1, 1.5, 2, 4];
const DEFAULT_PRESET = 'today';
const LAST_KEY = 'cloudPlayback.last';
const SEGMENT_MS = 10 * MINUTE;      // RECORDING_SEGMENT_DURATION: the longest a stored clip runs
const EVENTS_PAGE = 200;             // /ai/events caps limit at 200
const EVENT_PAGES_MAX = 10;          // pages fetched on our own to reach a past range
const GAP_NOTE_MS = 2000;            // a jump between clips longer than this is announced
const DOWNLOAD_SPACING_MS = 700;     // browsers drop back-to-back downloads fired together
const MAX_DAYS = 7;
// 'mp4' = one file cut to the exact range on the server (prod's
// /groups/:id/recordings/export, 2026-10-16); 'clips' = the stored clips as
// they were recorded, downloaded one by one.
const EXPORT_FORMATS = [
  { id: 'mp4', label: 'One MP4, trimmed', hint: 'A single file cut to your exact range. Recommended.' },
  { id: 'clips', label: 'Whole clips (MP4)', hint: 'Each stored clip that overlaps the range, as recorded. Not trimmed.' },
];
const exportLimitText = (max) => `Exports are limited to ${fmtDuration(max)} at a time.`;

const draftOf = (w) => ({ day: dayKey(w.start), from: timeValue(w.start), to: timeValue(w.end) });
const readLast = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || '{}') || {}; } catch { return {}; } };
const saveLast = (groupId, monitorId) => {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ groupId, monitorId })); } catch { /* private mode */ }
};
const openPicker = (input) => { try { input?.showPicker(); } catch { input?.focus(); } };
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const isLocalKey = (key) => String(key).startsWith('cam_');
const recordingsKey = (groupId, monitorId, day) => ['cloudPlayback', 'recordings', groupId, monitorId, day];

// …/2026-10-20/14-03-22-123456.mp4, or a filename carrying date and time.
const KEY_TIME = /(\d{4}-\d{2}-\d{2})[/T_ ](\d{2})[-:]?(\d{2})[-:]?(\d{2})/;
// The end a stitched cloud clip carries in its name: "17-48-57_to_17-50-00_1m.mp4".
const NAME_END = /_to_(\d{2})-(\d{2})-(\d{2})/;

/** A stitched clip's exact end (epoch ms) from "_to_HH-MM-SS", else null. */
function clipEndFromName(rec, start) {
  const m = NAME_END.exec(rec?.filename || '');
  if (!m || start == null) return null;
  let end = atTime(rec?.date || dayKey(start), `${m[1]}:${m[2]}:${m[3]}`);
  if (end < start) end += DAY; // the clip crossed midnight
  return end;
}

/**
 * When a clip starts, in this browser's local time. `startedAt` is the
 * backend's naive local timestamp (no offset), which Date.parse reads as
 * local; then `date` + `time`; then whatever the key or filename says.
 */
function clipStart(rec) {
  const parsed = Date.parse(rec?.startedAt || '');
  if (Number.isFinite(parsed)) return parsed;
  if (rec?.date && /^\d{2}:\d{2}/.test(rec?.time || '')) return atTime(rec.date, rec.time);
  const m = KEY_TIME.exec(rec?.key || '') || KEY_TIME.exec(`${rec?.date || ''}/${rec?.filename || ''}`);
  return m ? atTime(m[1], `${m[2]}:${m[3]}:${m[4]}`) : null;
}

/** Every local day a span touches, as YYYY-MM-DD. */
function daysIn(span) {
  const out = [];
  const last = dayKey(Math.max(span.start, span.end - 1));
  let k = dayKey(span.start);
  while (out.length < MAX_DAYS) {
    out.push(k);
    if (k >= last) break;
    k = dayKey(dayEnd(k));
  }
  return out;
}

/**
 * A camera's stored clips as playable segments, oldest first. The API gives
 * no end or duration: a clip runs to the next one's start, at most its
 * measured length (once played) or the 10-minute segment length.
 */
function buildClips(pages, monitorId, durations, nowMs) {
  const seen = new Set();
  const list = [];
  for (const page of pages) {
    for (const rec of page || []) {
      if (!rec?.key || seen.has(rec.key)) continue;
      if (rec.monitorId && rec.monitorId !== monitorId) continue;
      const start = clipStart(rec);
      if (start == null) continue;
      seen.add(rec.key);
      list.push({ key: rec.key, start, filename: rec.filename, size: rec.size, named: clipEndFromName(rec, start) });
    }
  }
  list.sort((a, b) => a.start - b.start);
  return list.map((c, i) => {
    const next = list[i + 1];
    // Measured length once played, else the end the filename names, else a full segment.
    const own = durations[c.key] != null ? c.start + durations[c.key]
      : c.named != null ? c.named
      : c.start + SEGMENT_MS;
    const end = Math.min(next ? Math.min(next.start, own) : own, Math.max(nowMs, c.start + 1000));
    return { ...c, end };
  });
}

/** Where Play starts in a range: its start if a clip covers it, else the first clip inside it. */
function firstMoment(clips, w) {
  if (clips.some((c) => w.start >= c.start && w.start < c.end)) return w.start;
  const next = clips.find((c) => c.start >= w.start && c.start < w.end);
  return next ? next.start : null;
}

const combineRecordings = (results) => ({
  pending: results.some((r) => r.isPending),
  error: results.find((r) => r.isError)?.error || null,
  pages: results.map((r) => r.data),
});

function triggerDownload(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Cloud Recordings: replay the clips this system stored for a camera, laid
 * out like NVR Playback (toolbar, player, events and bookmarks, timeline,
 * clip export).
 *
 * The clips are MP4 files (10-minute segments at most) streamed with HTTP
 * Range from the backend. One <video> plays them back to back: a moment maps
 * to the clip that covers it (or the next one after a gap), and the wall
 * clock is the clip's start plus the media time. The Gallery drawer browses
 * every clip in the library and hands the chosen one back to this player.
 */
export default function CloudPlayback() {
  const queryClient = useQueryClient();

  // ── Sites & cameras ───────────────────────────────────────────────────────
  const groupsQuery = useGroups();
  const groups = useMemo(() => groupsQuery.data || [], [groupsQuery.data]);
  // Health status for the picker's dot, shared with NVR Playback's cache.
  const healthQuery = useQuery({
    queryKey: ['playback', 'cameras'],
    queryFn: () => cameraHealthService.list(),
    staleTime: 60_000,
  });
  const statusById = useMemo(() => {
    const m = new Map();
    for (const c of healthQuery.data?.cameras || []) m.set(c.monitorId, c.status);
    return m;
  }, [healthQuery.data]);

  const [last] = useState(readLast);
  const [groupId, setGroupId] = useState(null);
  const [monitorId, setMonitorId] = useState('');
  if (groupId == null && groups.length) {
    // First site: the last one used here, then the first with cameras.
    const pick = groups.find((g) => sameId(g.id, last.groupId)) || groups.find((g) => g.cameras?.length) || groups[0];
    setGroupId(pick.id);
  }
  const group = groups.find((g) => sameId(g.id, groupId)) || null;
  const cameras = useMemo(() => (group?.cameras || []).filter((c) => c.monitorId).map((c) => ({
    monitorId: c.monitorId, name: c.name, status: statusById.get(c.monitorId), siteName: group.name,
  })), [group, statusById]);
  if (cameras.length && !cameras.some((c) => c.monitorId === monitorId)) {
    const pick = cameras.find((c) => c.monitorId === last.monitorId) || cameras[0];
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
  const sessionRef = useRef(null);    // { gen, clip, limit, offset }: the clip in the <video>
  const failedRef = useRef(null);     // the session that errored, for Try again / Skip
  const genRef = useRef(0);
  const clipsRef = useRef([]);
  const winRef = useRef(win);
  const spanRef = useRef(span);
  const groupRef = useRef(groupId);
  const monitorRef = useRef(monitorId);
  const phaseRef = useRef('idle');
  const rateRef = useRef(1);
  const mutedRef = useRef(true);
  const wallRef = useRef(null);
  const hideTimer = useRef(null);
  const toastTimer = useRef(null);
  const exportTouchedRef = useRef(false);

  const [phase, setPhaseState] = useState('idle');   // idle | loading | playing | ended | gap | error
  const [error, setError] = useState(null);
  const [gapAt, setGapAt] = useState(null);
  const [pending, setPending] = useState(null);      // { monitorId, t, key?, quiet? }: play once the clips load
  const [wallMs, setWallMs] = useState(null);
  const [bufferedMs, setBufferedMs] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [rate, setRateState] = useState(1);
  const [muted, setMuted] = useState(true);
  const [uiVisible, setUiVisible] = useState(true);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [thumbs] = useState(loadThumbs);
  const [durations, setDurations] = useState({});    // clip key → measured length (ms)
  const [bookmarkVersion, setBookmarkVersion] = useState(0);
  const [hidden, setHidden] = useState(() => new Set());
  const [exportRange, setExportRange] = useState(() => clipAround(win.start + 45_000));
  const [exportNotice, setExportNotice] = useState(null);
  const [exporting, setExporting] = useState(false);
  // ?view=gallery (prod's Timeline / Gallery switch) opens the library drawer.
  const [galleryOpen, setGalleryOpen] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('view') === 'gallery'; } catch { return false; }
  });

  useEffect(() => { winRef.current = win; }, [win]);
  useEffect(() => { spanRef.current = span; }, [span]);
  useEffect(() => { groupRef.current = groupId; }, [groupId]);
  useEffect(() => { monitorRef.current = monitorId; }, [monitorId]);

  const setPhase = useCallback((p) => { phaseRef.current = p; setPhaseState(p); }, []);

  // ── Recordings ────────────────────────────────────────────────────────────
  const days = useMemo(() => daysIn(span), [span]);
  const today = dayKey(now);
  const recResult = useQueries({
    queries: days.map((d) => ({
      queryKey: recordingsKey(groupId, monitorId, d),
      queryFn: () => getCameraRecordings(groupId, monitorId, d),
      enabled: Boolean(groupId != null && monitorId),
      staleTime: 60_000,
      refetchInterval: d === today ? 60_000 : false,
      retry: 1,
    })),
    combine: combineRecordings,
  });
  const clips = useMemo(
    () => buildClips(recResult.pages, monitorId, durations, now),
    [recResult.pages, monitorId, durations, now],
  );
  useEffect(() => { clipsRef.current = clips; }, [clips]);

  const recordings = useMemo(() => {
    if (!monitorId) return { status: 'idle', segments: [] };
    if (recResult.pending) return { status: 'loading', segments: [] };
    if (recResult.error) {
      return { status: 'error', segments: [], message: recResult.error?.response?.data?.message || 'could not load the cloud recordings.' };
    }
    return { status: 'ok', segments: clips.map((c) => ({ start: c.start, end: c.end, kind: 'continuous' })) };
  }, [monitorId, recResult.pending, recResult.error, clips]);

  const rangeClips = useMemo(() => clips.filter((c) => c.end > win.start && c.start < win.end), [clips, win]);
  const playFrom = useMemo(() => firstMoment(clips, win), [clips, win]);

  const retryRecordings = () => queryClient.refetchQueries({ queryKey: ['cloudPlayback', 'recordings', groupId, monitorId] });

  // ── Events ────────────────────────────────────────────────────────────────
  // /ai/events filters by `since` but answers newest first whatever the range
  // asks, so a past range is reached by paging back; the list is cut to the
  // span here.
  const eventsQuery = useInfiniteQuery({
    queryKey: ['cloudPlayback', 'events', monitorId, span.start, span.end],
    enabled: Boolean(monitorId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => aiService.listEvents({
      monitorId, since: iso(span.start), until: iso(span.end), limit: EVENTS_PAGE, offset: pageParam,
    }),
    getNextPageParam: (lastPage, pages) => (
      lastPage?.pagination?.hasMore ? pages.reduce((n, p) => n + (p?.data?.length || 0), 0) : undefined
    ),
    staleTime: 30_000,
    refetchInterval: span.end > now ? 60_000 : false,
    retry: (n, err) => err?.response?.status !== 403 && n < 2,
  });
  const { events, oldest } = useMemo(() => {
    const seen = new Set();
    const out = [];
    let min = null;
    for (const page of eventsQuery.data?.pages || []) {
      for (const raw of page?.data || []) {
        const e = toPlaybackEvent(raw);
        if (!e) continue;
        if (min == null || e.t < min) min = e.t;
        if (e.t < span.start || e.t > span.end || seen.has(e.id)) continue;
        seen.add(e.id);
        out.push(e);
      }
    }
    return { events: out.sort((a, b) => a.t - b.t), oldest: min };
  }, [eventsQuery.data, span]);
  const pagesLoaded = eventsQuery.data?.pages?.length || 0;
  // Everything loaded is still newer than the range: keep paging back, and
  // keep saying "loading" so the empty state never flashes meanwhile.
  const autoFetching = Boolean(eventsQuery.hasNextPage) && pagesLoaded < EVENT_PAGES_MAX
    && (oldest == null || oldest > span.end);
  const { fetchNextPage, isFetching: eventsFetching } = eventsQuery;
  useEffect(() => {
    if (autoFetching && !eventsFetching) fetchNextPage();
  }, [autoFetching, eventsFetching, fetchNextPage]);
  // Older pages can only add to this range while what's loaded hasn't reached its start.
  const canFetchMoreEvents = Boolean(eventsQuery.hasNextPage) && !autoFetching && oldest != null && oldest >= span.start;
  const eventsUnavailable = eventsQuery.error?.response?.status === 403
    ? "AI events aren't part of this account's plan. Playback, the timeline and clip downloads still work."
    : null;

  const bookmarks = useMemo(
    () => (monitorId ? loadBookmarks(monitorId) : []),
    // bookmarkVersion re-reads the store after a change.
    [monitorId, bookmarkVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const markers = useMemo(() => {
    const out = events.map((e) => ({ t: e.t, category: e.category, title: e.title }));
    for (const b of bookmarks) out.push({ t: b.t, category: 'bookmark', title: b.note || 'Bookmark' });
    return out;
  }, [events, bookmarks]);

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

  // ── Player ────────────────────────────────────────────────────────────────
  const flash = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const pokeUi = useCallback(() => {
    setUiVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) { setUiVisible(false); setSpeedOpen(false); }
    }, 2800);
  }, []);

  const stopVideo = useCallback(() => {
    sessionRef.current = null;
    const v = videoRef.current;
    if (v) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
    }
  }, []);

  const goIdle = useCallback(() => {
    genRef.current += 1;
    stopVideo();
    wallRef.current = null;
    setWallMs(null);
    setBufferedMs(null);
    setPlaying(false);
    setBuffering(false);
    setError(null);
    setGapAt(null);
    setPending(null);
    setPhase('idle');
  }, [setPhase, stopVideo]);

  // Reached the end of the range (or of the footage): keep the last frame up.
  const finish = useCallback(() => {
    genRef.current += 1;
    sessionRef.current = null;
    try { videoRef.current?.pause(); } catch { /* ignore */ }
    setPlaying(false);
    setBuffering(false);
    setPhase('ended');
  }, [setPhase]);

  // Put `clip` in the player at `offset` seconds; play up to `limit` (epoch ms).
  const loadClip = useCallback((clip, offset, limit) => {
    const v = videoRef.current;
    const gid = groupRef.current;
    if (!v || gid == null) return;
    const gen = ++genRef.current;
    const wall = clip.start + offset * 1000;
    const prev = sessionRef.current;
    sessionRef.current = { gen, clip, limit, offset };
    failedRef.current = null;
    wallRef.current = wall;
    setWallMs(wall);
    setError(null);
    setGapAt(null);
    setSpeedOpen(false);
    if (!exportTouchedRef.current) setExportRange(clipAround(wall));
    // Already loaded: just move inside it.
    if (prev?.clip.key === clip.key && v.readyState >= 1) {
      v.currentTime = offset;
      v.play().catch(() => {});
      setPhase('playing');
      return;
    }
    setBufferedMs(null);
    setPhase('loading');
    v.src = getStreamUrl(gid, clip.key);
  }, [setPhase]);

  // The clip ended: on to the next one, across any gap, until the limit.
  const advance = useCallback((s) => {
    if (!s || sessionRef.current !== s) return;
    const list = clipsRef.current;
    const i = list.findIndex((c) => c.key === s.clip.key);
    const next = i >= 0 ? list[i + 1] : list.find((c) => c.start > s.clip.start);
    if (!next || next.start >= s.limit) { finish(); return; }
    const dur = videoRef.current?.duration;
    const endedAt = Number.isFinite(dur) ? s.clip.start + dur * 1000 : s.clip.end;
    if (next.start - endedAt > GAP_NOTE_MS) flash(`No recording ${fmtClock(endedAt)}–${fmtClock(next.start)} · skipped`);
    loadClip(next, 0, s.limit);
  }, [finish, flash, loadClip]);

  // Play from `target`: the clip that covers it, else the next one after the
  // gap. Inside the range it plays to the range's end; outside it (day view)
  // to the end of that day.
  const playAt = useCallback((target, { window: w = winRef.current, quiet = false } = {}) => {
    const list = clipsRef.current;
    const t = Math.round(Math.min(target, Date.now() - 1000));
    const limit = t >= w.start && t < w.end ? w.end : dayEnd(dayKey(t));
    setPending(null);
    let clip = list.find((c) => t >= c.start && t < c.end) || null;
    const offset = clip ? (t - clip.start) / 1000 : 0;
    if (!clip) {
      clip = list.find((c) => c.start > t && c.start < limit) || null;
      if (clip && !quiet) flash(`No recording at ${fmtClock(t)} · playing from ${fmtClock(clip.start)}`);
    }
    if (!clip) {
      genRef.current += 1;
      stopVideo();
      wallRef.current = t;
      setWallMs(t);
      setBufferedMs(null);
      setPlaying(false);
      setBuffering(false);
      setError(null);
      setGapAt(t);
      setPhase('gap');
      return;
    }
    loadClip(clip, offset, limit);
  }, [flash, loadClip, setPhase, stopVideo]);

  // Play `t` once `monitor`'s clips for the shown days have loaded.
  const playWhenLoaded = useCallback((t, monitor, { key = null, quiet = true } = {}) => {
    genRef.current += 1;
    stopVideo();
    setPlaying(false);
    setBuffering(false);
    setError(null);
    setGapAt(null);
    wallRef.current = t;
    setWallMs(t);
    setPending({ monitorId: monitor, t, key, quiet });
    setPhase('loading');
  }, [setPhase, stopVideo]);

  useEffect(() => {
    if (!pending || pending.monitorId !== monitorId) return undefined;
    if (recordings.status === 'loading' || recordings.status === 'idle') return undefined;
    // Deferred a tick so the updates happen in a callback, not in the effect.
    const timer = setTimeout(() => {
      if (recordings.status === 'error') { goIdle(); return; }     // the idle overlay explains, with Retry
      const clip = pending.key ? clipsRef.current.find((c) => c.key === pending.key) : null;
      playAt(clip ? clip.start : pending.t, { quiet: clip ? true : pending.quiet });
    }, 0);
    return () => clearTimeout(timer);
  }, [pending, monitorId, recordings.status, playAt, goIdle]);

  useEffect(() => () => { genRef.current += 1; stopVideo(); }, [stopVideo]);

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    const s = sessionRef.current;
    if (!v || !s) return;
    const dur = v.duration;
    if (Number.isFinite(dur) && dur > 0) {
      const ms = Math.round(dur * 1000);
      setDurations((prev) => (prev[s.clip.key] === ms ? prev : { ...prev, [s.clip.key]: ms }));
      // The clip turned out shorter than assumed: the moment is in the gap after it.
      if (s.offset >= dur - 0.5) { advance(s); return; }
    }
    if (s.offset > 0) v.currentTime = s.offset;
    v.playbackRate = rateRef.current;
    v.muted = mutedRef.current;
    v.play().catch(() => {});
    setPhase('playing');
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    const s = sessionRef.current;
    if (!v || !s || phaseRef.current !== 'playing') return;
    const wall = s.clip.start + v.currentTime * 1000;
    if (wall >= s.limit) { finish(); return; }
    wallRef.current = wall;
    // Re-render once a second, not on every timeupdate.
    setWallMs((prev) => (prev != null && Math.floor(prev / 1000) === Math.floor(wall / 1000) ? prev : wall));
    try {
      for (let i = 0; i < v.buffered.length; i += 1) {
        if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) {
          const end = s.clip.start + v.buffered.end(i) * 1000;
          setBufferedMs((prev) => (prev != null && Math.abs(prev - end) < 1000 ? prev : end));
          break;
        }
      }
    } catch { /* ignore */ }
  };

  const onVideoError = () => {
    const v = videoRef.current;
    const s = sessionRef.current;
    if (!s || !v?.error) return;     // a removed src raises no MediaError
    sessionRef.current = null;
    failedRef.current = s;
    setPlaying(false);
    setBuffering(false);
    setPhase('error');
    setError(v.error.code === 4
      ? "This clip couldn't be played. It may have been removed by the retention policy, or this browser can't decode it."
      : 'The clip stopped loading. Check your connection and try again.');
  };

  const onPlay = () => { setPlaying(true); pokeUi(); };
  const onPause = () => { setPlaying(false); setUiVisible(true); };

  // ── Controls ──────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const ph = phaseRef.current;
    if (ph === 'loading') return;
    if (ph === 'error') {
      const f = failedRef.current;
      playAt(wallRef.current ?? f?.clip.start ?? winRef.current.start, { quiet: true });
      return;
    }
    if (ph === 'idle' || ph === 'ended' || ph === 'gap') {
      const m = firstMoment(clipsRef.current, winRef.current);
      if (m != null) playAt(m, { quiet: true });
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) v.pause();
    else v.play().catch(() => {});
  }, [playAt]);

  const skipFailed = useCallback(() => {
    const f = failedRef.current;
    if (!f) return;
    const list = clipsRef.current;
    const next = list.find((c) => c.start > f.clip.start);
    if (next && next.start < f.limit) loadClip(next, 0, f.limit);
    else finish();
  }, [finish, loadClip]);

  const seekTo = useCallback((target, { preroll = false } = {}) => {
    playAt(target - (preroll ? PREROLL_MS : 0));
  }, [playAt]);

  const nudge = useCallback((sec) => {
    seekTo((wallRef.current ?? winRef.current.start) + sec * 1000);
    pokeUi();
  }, [seekTo, pokeUi]);

  const setSpeed = useCallback((r) => {
    rateRef.current = r;
    setRateState(r);
    // defaultPlaybackRate too: loading the next clip resets playbackRate to it.
    if (videoRef.current) { videoRef.current.defaultPlaybackRate = r; videoRef.current.playbackRate = r; }
    setSpeedOpen(false);
  }, []);
  const stepSpeed = useCallback((dir) => {
    const i = SPEEDS.indexOf(rateRef.current);
    setSpeed(SPEEDS[clamp(i + dir, 0, SPEEDS.length - 1)]);
  }, [setSpeed]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (videoRef.current) videoRef.current.muted = next;
  }, []);

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

  // ── Range, site & camera changes ──────────────────────────────────────────
  const applyWindow = useCallback((w, { presetId = null, playFrom: from = null, key = null } = {}) => {
    winRef.current = w;
    setWin(w);
    setPreset(presetId);
    setDraft(draftOf(w));
    setRangeError(null);
    exportTouchedRef.current = false;
    setExportRange(clipAround(w.start + 45_000));
    const ph = phaseRef.current;
    if (from != null) playWhenLoaded(from, monitorRef.current, { key });
    else if (ph === 'playing' || ph === 'loading') playWhenLoaded(w.start, monitorRef.current);
    else goIdle();          // idle, ended or failed: the new range waits for Play
  }, [goIdle, playWhenLoaded]);

  // The whole local day around `t`, up to now.
  const openDayAt = useCallback((t, opts) => {
    const k = dayKey(t);
    const nowMs = Date.now();
    applyWindow({ start: dayStart(k), end: Math.min(dayEnd(k), nowMs) }, {
      presetId: k === dayKey(nowMs) ? 'today' : null, playFrom: t, ...opts,
    });
  }, [applyWindow]);

  const selectCamera = useCallback((id) => {
    if (!id || id === monitorRef.current) return;
    monitorRef.current = id;
    setMonitorId(id);
    saveLast(groupRef.current, id);
    const ph = phaseRef.current;
    // Watching: the same moment on the other camera. Otherwise wait for Play.
    if (ph === 'playing' || ph === 'loading') playWhenLoaded(wallRef.current ?? winRef.current.start, id);
    else goIdle();
  }, [goIdle, playWhenLoaded]);

  const selectGroup = (value) => {
    const g = groups.find((x) => sameId(x.id, value));
    if (!g || sameId(g.id, groupRef.current)) return;
    const first = (g.cameras || []).find((c) => c.monitorId)?.monitorId || '';
    groupRef.current = g.id;
    monitorRef.current = first;
    setGroupId(g.id);
    setMonitorId(first);
    saveLast(g.id, first);
    goIdle();
  };

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
  // events and clips) or when focus leaves the range control with an edit.
  const applyDraft = ({ refresh = false } = {}) => {
    const { problem, range } = rangeFromDraft(draft);
    if (problem) { setRangeError(problem); return; }
    applyWindow(range);
    if (!refresh) return;
    queryClient.invalidateQueries({ queryKey: ['cloudPlayback', 'events', monitorId] });
    queryClient.invalidateQueries({ queryKey: ['cloudPlayback', 'recordings', groupId, monitorId] });
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
    const s = spanRef.current;
    if (b.t >= s.start && b.t <= s.end) { seekTo(b.t, { preroll: true }); return; }
    openDayAt(b.t - PREROLL_MS);
  }, [seekTo, openDayAt]);

  const playEvent = useCallback((e) => seekTo(e.t, { preroll: true }), [seekTo]);

  // A clip chosen in the Gallery: its camera, its day, its start.
  const playFromGallery = useCallback((rec) => {
    setGalleryOpen(false);
    const all = groups.flatMap((g) => (g.cameras || []).map((c) => ({ g, c })));
    const hit = (rec.monitorId && all.find((x) => x.c.monitorId === rec.monitorId))
      || all.find((x) => x.c.name === rec.cameraName && sameId(x.g.id, groupRef.current))
      || all.find((x) => x.c.name === rec.cameraName);
    const t = clipStart(rec);
    if (!hit?.c.monitorId || t == null) { flash("Couldn't place this clip on the timeline"); return; }
    const mon = hit.c.monitorId;
    if (!sameId(hit.g.id, groupRef.current)) { groupRef.current = hit.g.id; setGroupId(hit.g.id); }
    if (mon !== monitorRef.current) { monitorRef.current = mon; setMonitorId(mon); }
    saveLast(hit.g.id, mon);
    const s = spanRef.current;
    if (t >= s.start && t < s.end) playWhenLoaded(t, mon, { key: rec.key });
    else openDayAt(t, { key: rec.key });
  }, [groups, flash, playWhenLoaded, openDayAt]);

  // ── Clip export: whole stored clips ───────────────────────────────────────
  const changeExport = useCallback((r) => {
    exportTouchedRef.current = true;
    setExportRange(r);
    setExportNotice(null);
  }, []);
  const exportAround = useCallback((e) => {
    changeExport({ start: e.t - 15_000, end: Math.min(e.t + 45_000, Date.now()) });
    document.getElementById('clip-export')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [changeExport]);

  // One trimmed MP4, cut on the server from the cloud + local clips over the range.
  const runTrimmedExport = () => {
    const start = Math.round(exportRange.start);
    const end = Math.round(Math.min(exportRange.end, Date.now()));
    if (end - start < 1000) { setExportNotice({ tone: 'danger', text: "This range hasn't been recorded yet." }); return; }
    const name = `${(camera.name || 'clip').replace(/[^\w.-]+/g, '_')}_${dayKey(start)}_${timeValue(start, true).replace(/:/g, '-')}_to_${timeValue(end, true).replace(/:/g, '-')}`;
    triggerDownload(getExportUrl(groupId, camera.monitorId, start, end, name), `${name}.mp4`);
    setExportNotice({ tone: 'info', text: `Building ${fmtClock(start)} → ${fmtClock(end)} from the recordings — the download starts in a few seconds.` });
  };

  const runExport = async (format) => {
    if (!camera || groupId == null || exporting) return;
    if (format !== 'clips') { runTrimmedExport(); return; }
    const gid = groupId;
    const mon = camera.monitorId;
    const start = exportRange.start;
    const end = Math.min(exportRange.end, Date.now());
    if (end - start < 1000) { setExportNotice({ tone: 'danger', text: "This range hasn't been recorded yet." }); return; }
    setExporting(true);
    try {
      // The export range may sit on a day the timeline isn't showing.
      const pages = await Promise.all(daysIn({ start, end }).map((d) => queryClient.fetchQuery({
        queryKey: recordingsKey(gid, mon, d),
        queryFn: () => getCameraRecordings(gid, mon, d),
        staleTime: 60_000,
      })));
      const list = buildClips(pages, mon, durations, Date.now()).filter((c) => c.end > start && c.start < end);
      if (!list.length) { setExportNotice({ tone: 'danger', text: 'No cloud recordings overlap this range.' }); return; }
      const n = list.length;
      setExportNotice({
        tone: 'info',
        // Start times only: a clip's end is a guess until it has been played.
        text: `Downloading ${n} clip${n === 1 ? '' : 's'} starting ${n === 1 ? fmtClock(list[0].start) : `${fmtClock(list[0].start)}–${fmtClock(list[n - 1].start)}`}. Clips download whole, as recorded, not trimmed to ${fmtClock(start)}–${fmtClock(end)}.${n > 1 ? ' Your browser may ask to allow multiple downloads.' : ''}`,
      });
      const stem = (camera.name || 'camera').replace(/[^\w.-]+/g, '_');
      let failed = 0;
      for (let i = 0; i < n; i += 1) {
        if (i) await sleep(DOWNLOAD_SPACING_MS);
        const c = list[i];
        const name = `${stem}_${dayKey(c.start)}_${timeValue(c.start, true).replace(/:/g, '-')}.mp4`;
        try {
          if (isLocalKey(c.key)) {
            triggerDownload(`${getStreamUrl(gid, c.key)}&download=1`, name);
          } else {
            const { downloadUrl } = await getDownloadUrl(gid, c.key, name);
            if (!downloadUrl) throw new Error('no url');
            triggerDownload(downloadUrl, name);
          }
        } catch {
          failed += 1;
        }
      }
      if (failed) setExportNotice({ tone: 'danger', text: `${failed} of ${n} clip${n === 1 ? '' : 's'} couldn't be downloaded. Try again.` });
    } catch (e) {
      setExportNotice({ tone: 'danger', text: e?.response?.data?.message || "Couldn't list the clips in this range." });
    } finally {
      setExporting(false);
    }
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

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (galleryOpen) return undefined;
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
  }, [galleryOpen, togglePlay, nudge, addBookmark, toggleFullscreen, stepSpeed, pokeUi]);

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
  const canPlay = Boolean(camera) && playFrom != null;
  const pill = 'flex h-11 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 transition hover:border-line-strong';
  const timeInput = 'w-22 bg-transparent text-small font-medium tabular-nums text-fg outline-none [&::-webkit-calendar-picker-indicator]:hidden';
  const overlayButton = 'inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-small font-semibold text-white transition hover:bg-white/20';
  const primaryOverlayButton = 'inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-small font-semibold text-white transition hover:bg-brand-hover';
  const nClips = rangeClips.length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 pb-1">
        {/* ── Toolbar: site, camera, day, range, quick range · Gallery ── */}
        <div className="flex flex-wrap items-center gap-2">
          <label className={cn(pill, 'relative w-full focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15 sm:w-auto sm:min-w-48')}>
            <Building2 className="h-4 w-4 shrink-0 text-fg-muted" />
            <select
              value={groupId != null ? String(groupId) : ''}
              onChange={(e) => selectGroup(e.target.value)}
              disabled={!groups.length}
              aria-label="Site"
              className="h-full min-w-0 flex-1 cursor-pointer appearance-none bg-transparent pr-5 text-small font-medium text-fg outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {groups.length
                ? groups.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)
                : <option value="">{groupsQuery.isPending ? 'Loading sites…' : 'No sites yet'}</option>}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-fg-subtle" />
          </label>

          <CameraPicker
            cameras={cameras}
            value={monitorId}
            onChange={selectCamera}
            thumbs={thumbs}
            loading={groupsQuery.isPending}
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

          <button
            type="button"
            onClick={() => setGalleryOpen(true)}
            title="Browse every stored clip"
            className={cn(pill, 'ml-auto text-small font-semibold text-fg-secondary hover:text-fg')}
          >
            <LayoutGrid className="h-4 w-4 text-fg-muted" />
            Gallery
          </button>
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
                  muted={muted}
                  preload="auto"
                  onLoadedMetadata={onLoadedMetadata}
                  onTimeUpdate={onTimeUpdate}
                  onProgress={onTimeUpdate}
                  onPlay={onPlay}
                  onPause={onPause}
                  onWaiting={() => setBuffering(true)}
                  onPlaying={() => setBuffering(false)}
                  onCanPlay={() => setBuffering(false)}
                  onEnded={() => advance(sessionRef.current)}
                  onError={onVideoError}
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
                  <div className="pointer-events-none absolute left-1/2 top-16 z-30 max-w-[90%] -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-center text-caption font-semibold text-white">
                    {toast}
                  </div>
                ) : null}

                {phase === 'idle' ? (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/80 p-6">
                    <IdleState
                      camera={camera}
                      noSites={!groupsQuery.isPending && !groups.length}
                      status={recordings.status}
                      message={recordings.message}
                      playFrom={playFrom}
                      clipCount={nClips}
                      onPlay={togglePlay}
                      onRetry={retryRecordings}
                      onGallery={() => setGalleryOpen(true)}
                      overlayButton={overlayButton}
                    />
                  </div>
                ) : null}

                {phase === 'loading' ? (
                  <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-slate-950/60">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <Loader2 className="h-8 w-8 animate-spin text-brand" />
                      <p className="text-body font-semibold text-white">{pending ? 'Loading clips…' : 'Loading clip…'}</p>
                      <p className="text-small text-white/60">Clips stream from cloud storage.</p>
                    </div>
                  </div>
                ) : null}

                {phase === 'playing' && buffering ? (
                  <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
                    <Loader2 className="h-8 w-8 animate-spin text-white/80" />
                  </div>
                ) : null}

                {phase === 'error' ? (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/85 p-6">
                    <div className="flex max-w-md flex-col items-center gap-3 text-center">
                      <AlertTriangle className="h-8 w-8 text-danger" />
                      <p className="text-body font-semibold text-white">{error}</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <button type="button" onClick={togglePlay} className={overlayButton}>
                          <RotateCcw className="h-3.5 w-3.5" /> Try again
                        </button>
                        <button type="button" onClick={skipFailed} className={overlayButton}>
                          <SkipForward className="h-3.5 w-3.5" /> Skip to next clip
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {phase === 'gap' ? (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/80 p-6">
                    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                      <Video className="h-8 w-8 text-white/60" />
                      <p className="text-body font-semibold text-white">No cloud recording at {fmtClock(gapAt)}</p>
                      <p className="text-small text-white/60">Nothing was stored from this moment to the end of the range.</p>
                      {playFrom != null ? (
                        <button type="button" onClick={togglePlay} className={primaryOverlayButton}>
                          <Play className="h-3.5 w-3.5" fill="currentColor" /> Play from {fmtClock(playFrom)}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {phase === 'ended' ? (
                  <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/75 p-6">
                    <div className="flex flex-col items-center gap-3 text-center">
                      <Video className="h-8 w-8 text-white/60" />
                      <p className="text-body font-semibold text-white">End of the selected range</p>
                      {playFrom != null ? (
                        <button type="button" onClick={togglePlay} className={primaryOverlayButton}>
                          <RotateCcw className="h-3.5 w-3.5" /> Play again from {fmtClock(playFrom)}
                        </button>
                      ) : null}
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
                      <PlayerButton label="Back 10 s (←)" onClick={() => nudge(-10)} disabled={!canPlay}>
                        <RotateCcw className="h-4 w-4" /><span className="text-caption">10s</span>
                      </PlayerButton>
                      <button
                        type="button"
                        onClick={togglePlay}
                        disabled={!canPlay || phase === 'loading'}
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
                      <PlayerButton label="Forward 10 s (→)" onClick={() => nudge(10)} disabled={!canPlay}>
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
                              Clips stream from storage; on a slow connection faster speeds may pause to buffer.
                            </p>
                          </div>
                        ) : null}
                      </div>
                      <PlayerButton label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
                        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
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
              emptyNote="No cloud recordings for this camera in this range."
            />
          </div>

          {/* Sized by the video + timeline beside it, never by its own list. */}
          <div className="relative order-2 min-h-0 xl:order-none xl:col-start-2 xl:row-span-2 xl:row-start-1">
            <EventsPanel
              className="h-112 xl:absolute xl:inset-0 xl:h-auto"
              cameraName={camera?.name || 'this camera'}
              listKey={`${monitorId}|${span.start}|${span.end}`}
              events={events}
              total={events.length}
              loading={Boolean(monitorId) && (eventsQuery.isPending || autoFetching)}
              error={eventsQuery.isError && !eventsUnavailable ? (eventsQuery.error?.response?.data?.message || 'The events service did not answer.') : null}
              unavailable={eventsUnavailable}
              onRetry={eventsQuery.refetch}
              canFetchMore={canFetchMoreEvents}
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
          canExport={Boolean(camera) && !exporting}
          onExport={runExport}
          notice={exportNotice}
          onDismissNotice={() => setExportNotice(null)}
          formats={EXPORT_FORMATS}
          limitText={exportLimitText}
          actionLabel={exporting ? 'Downloading…' : 'Export'}
        />
      </div>

      {/* ── Gallery drawer: the whole library; Play hands a clip to the player ── */}
      <Sheet open={galleryOpen} onOpenChange={setGalleryOpen}>
        <SheetContent side="right" className="w-[min(1080px,calc(var(--app-vw)*0.94))] max-w-none">
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-4 pr-12">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-brand-line bg-brand-soft text-brand">
              <LayoutGrid className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="text-heading font-bold text-fg">Recording Gallery</SheetTitle>
              <SheetDescription className="mt-1 text-small">
                Every clip stored for your sites. Play one to watch it in the player, on its timeline.
              </SheetDescription>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-4">
            {galleryOpen ? (
              <Gallery
                onPlay={playFromGallery}
                initialGroupId={groupId}
                initialCamera={camera?.name || 'all'}
                initialDate={day}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** What the player says before anything plays: why it can't, or where Play starts. */
function IdleState({ camera, noSites, status, message, playFrom, clipCount, onPlay, onRetry, onGallery, overlayButton }) {
  if (!camera) {
    return (
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Video className="h-8 w-8 text-white/60" />
        <p className="text-body font-semibold text-white">{noSites ? 'No sites yet' : 'Pick a camera to review its recordings'}</p>
        <p className="text-small text-white/60">Cameras added in Camera Setup appear in the pickers above.</p>
      </div>
    );
  }
  if (status === 'loading') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="text-body font-semibold text-white">Loading cloud recordings…</p>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <AlertTriangle className="h-8 w-8 text-danger" />
        <p className="text-body font-semibold text-white">Couldn't load cloud recordings</p>
        <p className="text-small text-white/60">{message}</p>
        <button type="button" onClick={onRetry} className={overlayButton}>
          <RotateCcw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }
  if (playFrom == null) {
    return (
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Video className="h-8 w-8 text-white/60" />
        <p className="text-body font-semibold text-white">No cloud recordings in this range</p>
        <p className="text-small text-white/60">Pick another day or range, or browse every stored clip in the Gallery.</p>
        <button type="button" onClick={onGallery} className={overlayButton}>
          <LayoutGrid className="h-3.5 w-3.5" /> Open Gallery
        </button>
      </div>
    );
  }
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <button
        type="button"
        onClick={onPlay}
        aria-label="Play"
        className="grid h-16 w-16 place-items-center rounded-full bg-brand text-white shadow-lg transition hover:scale-105 hover:bg-brand-hover"
      >
        <Play className="ml-1 h-7 w-7" fill="currentColor" />
      </button>
      <p className="text-body font-semibold text-white">
        Play from {fmtClock(playFrom)} · {clipCount} clip{clipCount === 1 ? '' : 's'}
      </p>
      <p className="text-small text-white/60">Or click any moment on the timeline, or an event.</p>
    </div>
  );
}
