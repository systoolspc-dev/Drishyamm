import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Camera as CameraIcon, CalendarDays, Check, ChevronDown, Clock, FastForward, Film,
  Loader2, Maximize, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX,
} from 'lucide-react';
import { cn } from '@/core/lib/utils';
import { PageCard } from '@/core/layout/OperationsPage';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/core/ui/dropdown-menu';
import { StatusDot } from '@/core/ui/status-badge';
import { useGroups } from '@/core/hooks/useQueries';
import { cameraHealthService } from '@/core/services/cameraHealth';
import { aiService } from '@/core/services/ai';
import { getCameraRecordings, getStreamUrl, getThumbnailUrl } from '@/core/services/recordings';
import CameraPicker from '@/core/pages/playback/CameraPicker';
import TimelapseTimeline from '@/core/pages/playback/TimelapseTimeline';
import TimelapsePanel, { TimelapsePanelRail } from '@/core/pages/playback/TimelapsePanel';
import { useTimelapsePlayer } from '@/core/pages/playback/useTimelapsePlayer';
import {
  atTime, binToMarker, cameraState, clamp, dayKey, fmtClock, fmtDate, fmtDuration, iso, loadBookmarks, loadThumbs,
  timeValue,
} from '@/core/pages/playback/model';
import {
  DEFAULT_INTERVAL, INTERVALS, SPEEDS, buildClips, clipsInRange, intervalOf, recordingTrigger,
} from '@/core/pages/playback/timelapse';

const LAST_CAMERA_KEY = 'playback.lastCamera';   // shared with NVR Playback, so both tabs open on the same camera
const PANEL_COLLAPSED_KEY = 'playback.timelapse.panelCollapsed';
const readLastCamera = () => { try { return localStorage.getItem(LAST_CAMERA_KEY) || ''; } catch { return ''; } };
const saveLastCamera = (id) => { try { localStorage.setItem(LAST_CAMERA_KEY, id); } catch { /* private mode */ } };
const openPicker = (input) => { try { input?.showPicker(); } catch { input?.focus(); } };
const titleCase = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Playback → Timelapse. One workflow, top to bottom: pick a camera, a day, a
 * time range and an interval, Generate, then watch and export.
 *
 * The footage is the camera's cloud recordings for that day
 * (getCameraRecordings). Generating loads them; the player then walks through
 * them at the interval's speed, sampling frames, so a working day plays in a
 * few minutes. Nothing is rendered server-side.
 *
 * No page heading: the Playback tab bar already says where you are.
 */
export default function Timelapse() {
  // ── Cameras: the groups' cameras (their recordings live per group), with
  //    status, site and resolution from camera health where it knows them.
  const { data: groups = [], isPending: groupsLoading } = useGroups();
  const healthQuery = useQuery({
    queryKey: ['playback', 'cameras'],
    queryFn: () => cameraHealthService.list(),
    staleTime: 60_000,
  });
  const cameras = useMemo(() => {
    const health = new Map((healthQuery.data?.cameras || []).map((c) => [c.monitorId, c]));
    const out = [];
    for (const g of groups) {
      for (const c of g.cameras || []) {
        if (!c.monitorId) continue;
        const h = health.get(c.monitorId) || {};
        out.push({
          monitorId: c.monitorId,
          groupId: g.id,
          name: c.name || h.name || `Channel ${c.channel}`,
          status: h.status,
          siteName: h.siteName,
          groupName: g.name,
          location: g.location,
          cameraType: c.type
            ? titleCase(c.type)
            : g.deviceType ? `${titleCase(g.deviceType)} NVR${c.channel ? ` · Ch ${c.channel}` : ''}` : null,
          resolution: h.resolution || (c.width && c.height ? `${c.width} × ${c.height}` : null),
        });
      }
    }
    return out;
  }, [groups, healthQuery.data]);

  const [monitorId, setMonitorId] = useState('');
  const [lastCamera] = useState(readLastCamera);
  if (!monitorId && cameras.length) {
    const pick = cameras.find((c) => c.monitorId === lastCamera)
      || cameras.find((c) => cameraState(c.status).tone === 'success')
      || cameras[0];
    setMonitorId(pick.monitorId);
  }
  const camera = cameras.find((c) => c.monitorId === monitorId) || null;
  const [thumbs] = useState(loadThumbs);
  const selectCamera = useCallback((id) => { setMonitorId(id); saveLastCamera(id); }, []);

  // ── Draft settings (the toolbar) ─────────────────────────────────────────
  const [today] = useState(() => dayKey(Date.now()));
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('18:00');
  const [intervalId, setIntervalId] = useState(DEFAULT_INTERVAL);
  const interval = intervalOf(intervalId);
  const draftStart = atTime(day, from);
  const draftEnd = atTime(day, to);
  const rangeProblem = !from || !to ? 'Choose a start and end time.' : draftEnd <= draftStart ? 'End time must be after start time.' : null;
  const dateInputRef = useRef(null);
  const fromInputRef = useRef(null);

  // ── Generated timelapse ──────────────────────────────────────────────────
  const [plan, setPlan] = useState(null);     // { id, groupId, monitorId, day, start, end, ratio, recs }
  const [status, setStatus] = useState({ phase: 'idle' });   // idle | loading | error
  const [durations, setDurations] = useState({});
  const requestRef = useRef(0);

  const generate = async () => {
    if (!camera || rangeProblem) return;
    const id = ++requestRef.current;
    setStatus({ phase: 'loading' });
    try {
      const recs = await getCameraRecordings(camera.groupId, camera.monitorId, day);
      if (id !== requestRef.current) return;
      setPlan({
        id, groupId: camera.groupId, monitorId: camera.monitorId, day,
        start: draftStart, end: draftEnd, ratio: interval.ratio, recs: recs || [],
      });
      setStatus({ phase: 'idle' });
    } catch (err) {
      if (id !== requestRef.current) return;
      setStatus({ phase: 'error', message: err?.response?.data?.message || err?.message || 'Failed to load recordings.' });
    }
  };

  // The interval only changes playback speed, so it applies to the running
  // timelapse straight away; camera, day and range need a new Generate.
  const changeInterval = (idValue) => {
    setIntervalId(idValue);
    setPlan((p) => (p ? { ...p, ratio: intervalOf(idValue).ratio } : p));
  };

  const recordDuration = useCallback((key, ms) => {
    setDurations((d) => (d[key] && Math.abs(d[key] - ms) < 500 ? d : { ...d, [key]: ms }));
  }, []);

  const allClips = useMemo(() => buildClips(plan?.recs, durations), [plan, durations]);
  const clips = useMemo(() => (plan ? clipsInRange(allClips, plan.start, plan.end) : []), [allClips, plan]);

  const pill = 'flex h-11 items-center gap-2 rounded-lg border border-line bg-surface px-3 transition hover:border-line-strong';
  const timeInput = 'w-22 bg-transparent text-small font-medium tabular-nums text-fg outline-none [&::-webkit-calendar-picker-indicator]:hidden';
  const rangeHours = rangeProblem ? null : draftEnd - draftStart;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 pb-1">
        {/* ── Toolbar: camera · date · time range · interval · Generate ── */}
        <div className="flex flex-wrap items-center gap-2">
          <CameraPicker
            cameras={cameras}
            value={monitorId}
            onChange={selectCamera}
            thumbs={thumbs}
            loading={groupsLoading}
            className="sm:w-64"
          />

          <div className="relative w-full sm:w-auto">
            <button type="button" onClick={() => openPicker(dateInputRef.current)} aria-label="Choose date" className={cn(pill, 'w-full')}>
              <CalendarDays className="h-4 w-4 text-fg-muted" />
              <span className="flex-1 whitespace-nowrap text-left text-small font-medium text-fg">{fmtDate(atTime(day, '12:00'))}</span>
              <ChevronDown className="h-3.5 w-3.5 text-fg-subtle" />
            </button>
            <input
              ref={dateInputRef}
              type="date"
              value={day}
              max={today}
              onChange={(e) => { if (e.target.value) setDay(e.target.value); }}
              tabIndex={-1}
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
            />
          </div>

          <div className={cn(pill, 'w-full sm:w-auto focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15')}>
            <button type="button" tabIndex={-1} aria-hidden onClick={() => openPicker(fromInputRef.current)} className="text-fg-muted transition hover:text-fg">
              <Clock className="h-4 w-4" />
            </button>
            <input
              ref={fromInputRef}
              type="time"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="Start time"
              className={timeInput}
            />
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <input
              type="time"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="End time"
              className={timeInput}
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(pill, 'w-full sm:w-auto')} aria-label="Timelapse interval">
                <FastForward className="h-4 w-4 text-fg-muted" />
                <span className="flex-1 whitespace-nowrap text-left text-small font-medium text-fg">
                  <span className="text-fg-muted">Interval:</span> {interval.label} ({interval.ratio}×)
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-fg-subtle" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 border-line bg-surface">
              <DropdownMenuRadioGroup value={intervalId} onValueChange={changeInterval}>
                {INTERVALS.map((i) => (
                  <DropdownMenuRadioItem key={i.id} value={i.id}>
                    <span className="flex w-full items-baseline justify-between gap-3">
                      <span className="text-small font-semibold text-fg">{i.label} · {i.ratio}×</span>
                      {rangeHours ? (
                        <span className="text-caption tabular-nums text-fg-muted">
                          {fmtDuration(rangeHours)} → {fmtDuration(rangeHours / i.ratio)}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            onClick={generate}
            disabled={!camera || Boolean(rangeProblem) || status.phase === 'loading'}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 text-small font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60 sm:ml-auto sm:w-auto"
          >
            {status.phase === 'loading'
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Play className="h-4 w-4" fill="currentColor" />}
            Generate Timelapse
          </button>
        </div>
        {rangeProblem ? (
          <p className="-mt-1 flex items-center gap-1.5 text-small font-medium text-danger-ink">
            <AlertTriangle className="h-3.5 w-3.5" /> {rangeProblem}
          </p>
        ) : null}

        <Workspace
          key={plan?.id ?? 'empty'}
          plan={plan}
          clips={clips}
          allClips={allClips}
          status={status}
          onRetry={generate}
          onDuration={recordDuration}
          camera={camera}
          planCamera={cameras.find((c) => c.monitorId === plan?.monitorId) || null}
          interval={interval}
          thumbs={thumbs}
          draftRange={rangeProblem ? { start: atTime(day, '00:00'), end: atTime(day, '23:59') } : { start: draftStart, end: draftEnd }}
        />
      </div>
    </div>
  );
}

// ── Workspace: player + panel + timeline, one per generated timelapse ───────

function Workspace({ plan, clips, allClips, status, onRetry, onDuration, camera, planCamera, interval, thumbs, draftRange }) {
  const player = useTimelapsePlayer({ plan, clips, onDuration });
  const { videoRef, clipKey, wallMs, toggle, nudge, seek } = player;
  const stageRef = useRef(null);
  const [panelTab, setPanelTab] = useState('info');
  const [panelCollapsed, setPanelCollapsed] = useState(() => { try { return localStorage.getItem(PANEL_COLLAPSED_KEY) === '1'; } catch { return false; } });
  const setCollapsed = useCallback((next) => {
    setPanelCollapsed(next);
    try { localStorage.setItem(PANEL_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* private mode */ }
  }, []);
  const expandPanel = useCallback((tab) => {
    if (tab) setPanelTab(tab);
    setCollapsed(false);
  }, [setCollapsed]);
  const [hidden, setHidden] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const flash = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const current = clips.find((c) => c.key === clipKey) || null;
  const src = plan && current ? getStreamUrl(plan.groupId, current.key) : null;

  // ── Timeline layers: AI events (when the plan includes AI), motion-triggered
  //    recordings, and this browser's bookmarks for the camera.
  const histQuery = useQuery({
    queryKey: ['playback', 'histogram', plan?.monitorId, plan?.start, plan?.end],
    enabled: Boolean(plan),
    queryFn: () => aiService.eventHistogram({ monitorId: plan.monitorId, since: iso(plan.start), until: iso(plan.end), buckets: 240 }),
    staleTime: 30_000,
    retry: (n, err) => err?.response?.status !== 403 && n < 2,
  });
  const markers = useMemo(() => {
    if (!plan) return [];
    const out = (histQuery.data?.bins || []).map(binToMarker).filter(Boolean);
    for (const c of clips) {
      const trigger = recordingTrigger(c.rec);
      if (trigger === 'motion') out.push({ t: c.start, category: 'motion', title: 'Motion recording' });
    }
    for (const b of loadBookmarks(plan.monitorId)) out.push({ t: b.t, category: 'bookmark', title: b.note || 'Bookmark' });
    return out;
  }, [plan, clips, histQuery.data]);
  const toggleLayer = useCallback((id) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  let timelineNote = null;
  if (!plan) timelineNote = 'Generate a timelapse to see its footage and events here.';
  else if (histQuery.error?.response?.status === 403) timelineNote = "AI events aren't part of this account's plan; footage and bookmarks still show.";

  // ── Player actions ───────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) stageRef.current?.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }, []);

  const snapshot = useCallback(() => {
    const v = videoRef.current;
    if (!v?.videoWidth || wallMs == null) return;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const a = document.createElement('a');
      a.href = c.toDataURL('image/jpeg', 0.92);
      a.download = `${(planCamera?.name || 'camera').replace(/[^\w.-]+/g, '_')}_${dayKey(wallMs)}_${timeValue(wallMs, true).replace(/:/g, '-')}.jpg`;
      a.click();
      flash(`Snapshot saved · ${fmtClock(wallMs)}`);
    } catch {
      flash('Snapshot unavailable for this recording');
    }
  }, [videoRef, wallMs, planCamera, flash]);

  useEffect(() => {
    if (!plan) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (el?.closest?.('[role="menu"],[role="dialog"],[role="listbox"]')) return;
      const k = e.key.toLowerCase();
      if ((k === ' ' || k === 'enter') && tag === 'BUTTON') return;   // the focused button handles it
      if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
      else if (k === 'arrowleft' || k === 'j') { e.preventDefault(); nudge(-10); }
      else if (k === 'arrowright' || k === 'l') { e.preventDefault(); nudge(10); }
      else if (k === 'f') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [plan, toggle, nudge, toggleFullscreen]);

  // The panel shows the camera picked in the toolbar; its thumbnail is a real
  // frame from this timelapse's first clip when it is that camera's.
  const thumbnail = plan && clips[0] && plan.monitorId === camera?.monitorId
    ? getThumbnailUrl(plan.groupId, clips[0].key)
    : thumbs[camera?.monitorId] || null;

  return (
    <>
      <div
        className={cn(
          'grid gap-4 transition-[grid-template-columns] duration-200 ease-out',
          panelCollapsed ? 'lg:grid-cols-[minmax(0,1fr)_2.75rem]' : 'lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]',
        )}
      >
        <PageCard className="overflow-hidden bg-black">
          <div ref={stageRef} className="group relative aspect-video max-h-[62vh] w-full bg-black">
            <Stage
              player={player}
              plan={plan}
              clips={clips}
              allClips={allClips}
              src={src}
              status={status}
              onRetry={onRetry}
              camera={planCamera}
              toast={toast}
              onSnapshot={snapshot}
              onFullscreen={toggleFullscreen}
            />
          </div>
        </PageCard>

        {/* Pinned to the player's height on desktop, so the panel never out-grows the video.
            Collapsed, it folds to a rail on desktop; below `lg` it sits under the video and stays open. */}
        <div className="relative min-h-0">
          {panelCollapsed ? (
            <TimelapsePanelRail className="hidden lg:absolute lg:inset-0 lg:flex" onExpand={expandPanel} />
          ) : null}
          <TimelapsePanel
            className={cn('lg:absolute lg:inset-0', panelCollapsed && 'lg:hidden')}
            tab={panelTab}
            onTab={setPanelTab}
            onCollapse={() => setCollapsed(true)}
            camera={camera}
            thumbnail={thumbnail}
            plan={plan}
            clips={clips}
            currentKey={clipKey}
            intervalLabel={`${interval.label} (${interval.ratio}×)`}
          />
        </div>
      </div>

      <TimelapseTimeline
        range={plan ? { start: plan.start, end: plan.end } : draftRange}
        clips={clips}
        markers={markers}
        hidden={hidden}
        onToggleLayer={toggleLayer}
        playhead={plan && clips.length ? wallMs : null}
        onSeek={seek}
        disabled={!plan || !clips.length}
        note={timelineNote}
      />
    </>
  );
}

// ── The video stage: empty, loading, no footage, playing ────────────────────

function Stage({ player, plan, clips, allClips, src, status, onRetry, camera, toast, onSnapshot, onFullscreen }) {
  const {
    videoProps, wallMs, playing, ended, waiting, failure, rate, muted,
    toggle, seek, nudge, setSpeed, setMuted, retry,
  } = player;

  if (status.phase === 'loading' && !plan) {
    return (
      <StageMessage>
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="text-body font-semibold text-white">Loading recordings…</p>
      </StageMessage>
    );
  }
  if (status.phase === 'error' && !plan) {
    return (
      <StageMessage>
        <AlertTriangle className="h-8 w-8 text-danger" />
        <p className="text-body font-semibold text-white">{status.message}</p>
        <StageButton onClick={onRetry}><RotateCcw className="h-3.5 w-3.5" /> Try again</StageButton>
      </StageMessage>
    );
  }
  if (!plan) {
    return (
      <StageMessage>
        <span className="grid h-14 w-14 place-items-center rounded-xl border border-white/10 bg-white/5">
          <Film className="h-7 w-7 text-white/35" />
        </span>
        <p className="text-body font-semibold text-white/85">No timelapse selected</p>
        <p className="max-w-xs text-small text-white/50">Select a camera and time range above to generate a timelapse.</p>
      </StageMessage>
    );
  }
  if (!clips.length) {
    const first = allClips[0];
    const last = allClips[allClips.length - 1];
    return (
      <StageMessage>
        <span className="grid h-14 w-14 place-items-center rounded-xl border border-white/10 bg-white/5">
          <Film className="h-7 w-7 text-white/35" />
        </span>
        <p className="text-body font-semibold text-white/85">No recordings in this range</p>
        <p className="max-w-sm text-small text-white/50">
          {first
            ? `${camera?.name || 'This camera'} has ${allClips.length} recording${allClips.length === 1 ? '' : 's'} on ${fmtDate(plan.start)}, between ${timeValue(first.start)} and ${timeValue(last.end)}. Adjust the time range and generate again.`
            : `${camera?.name || 'This camera'} has no cloud recordings on ${fmtDate(plan.start)}. Try another day.`}
        </p>
      </StageMessage>
    );
  }

  const span = Math.max(1, plan.end - plan.start);
  const playedPct = clamp((((wallMs ?? plan.start) - plan.start) / span) * 100, 0, 100);
  const state = cameraState(camera?.status);
  const overlay = cn('transition-opacity duration-200', playing ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : 'opacity-100');

  return (
    <>
      <video
        {...videoProps}
        src={src || undefined}
        onClick={toggle}
        className="absolute inset-0 h-full w-full cursor-pointer object-contain"
      />

      {/* Camera, range and the timelapse rate */}
      <div className={cn('pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-3', overlay)}>
        <div className="min-w-0 rounded-md bg-black/55 px-2.5 py-1.5 backdrop-blur-sm">
          <p className="flex min-w-0 items-center gap-2 text-small font-semibold text-white">
            <span className="truncate">{camera?.name || 'Camera'}</span>
            <span className="inline-flex shrink-0 items-center gap-1 text-caption font-medium text-white/80">
              <StatusDot tone={state.tone} title={state.label} /> {state.label}
            </span>
          </p>
          <p className="mt-0.5 text-caption tabular-nums text-white/75">
            {fmtDate(plan.start)} · {timeValue(plan.start)} – {timeValue(plan.end)}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-black/55 px-2.5 py-1.5 text-caption font-semibold text-white backdrop-blur-sm">
          <FastForward className="h-3.5 w-3.5 text-brand" />
          Timelapse {plan.ratio}×
        </span>
      </div>

      {toast ? (
        <div className="pointer-events-none absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-caption font-semibold text-white">
          {toast}
        </div>
      ) : null}

      {waiting && !failure && !ended ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <Loader2 className="h-8 w-8 animate-spin text-brand" />
        </div>
      ) : null}

      {failure ? (
        <StageMessage overlay>
          <AlertTriangle className="h-8 w-8 text-danger" />
          <p className="text-body font-semibold text-white">{failure}</p>
          <StageButton onClick={retry}><RotateCcw className="h-3.5 w-3.5" /> Try again</StageButton>
        </StageMessage>
      ) : null}

      {ended ? (
        <StageMessage overlay>
          <Film className="h-8 w-8 text-white/60" />
          <p className="text-body font-semibold text-white">End of timelapse</p>
          <StageButton primary onClick={toggle}><RotateCcw className="h-3.5 w-3.5" /> Replay from {timeValue(plan.start)}</StageButton>
        </StageMessage>
      ) : null}

      {status.phase === 'loading' ? (
        <StageMessage overlay>
          <Loader2 className="h-8 w-8 animate-spin text-brand" />
          <p className="text-body font-semibold text-white">Loading recordings…</p>
        </StageMessage>
      ) : status.phase === 'error' ? (
        <StageMessage overlay>
          <AlertTriangle className="h-8 w-8 text-danger" />
          <p className="text-body font-semibold text-white">{status.message}</p>
          <StageButton onClick={onRetry}><RotateCcw className="h-3.5 w-3.5" /> Try again</StageButton>
        </StageMessage>
      ) : null}

      {/* ── Transport ── */}
      <div className={cn('absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-black/90 via-black/60 to-transparent px-4 pb-3 pt-10', overlay)}>
        <div
          role="presentation"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek(plan.start + clamp((e.clientX - r.left) / r.width, 0, 1) * span);
          }}
          className="group/bar relative h-4 cursor-pointer"
          title="Click to jump here"
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20 transition-[height] group-hover/bar:h-1.5">
            <div className="absolute inset-y-0 left-0 bg-brand" style={{ width: `${playedPct}%` }} />
          </div>
          <div
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-brand shadow ring-2 ring-white transition-transform group-hover/bar:scale-100"
            style={{ left: `${playedPct}%` }}
          />
        </div>

        <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="min-w-0 truncate text-small font-semibold tabular-nums text-white">
            {fmtClock(wallMs)} <span className="hidden font-medium text-white/60 sm:inline">/ {fmtClock(plan.end)}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <PlayerButton label="Back 10 s (←)" onClick={() => nudge(-10)}>
              <RotateCcw className="h-4 w-4" /><span className="text-caption">10s</span>
            </PlayerButton>
            <button
              type="button"
              onClick={toggle}
              disabled={Boolean(failure)}
              aria-label={playing ? 'Pause (space)' : 'Play (space)'}
              title={playing ? 'Pause (space)' : 'Play (space)'}
              className="grid h-10 w-10 place-items-center rounded-full bg-white text-slate-950 shadow transition hover:scale-105 disabled:opacity-60 disabled:hover:scale-100"
            >
              {playing
                ? <Pause className="h-5 w-5" fill="currentColor" />
                : <Play className="ml-0.5 h-5 w-5" fill="currentColor" />}
            </button>
            <PlayerButton label="Forward 10 s (→)" onClick={() => nudge(10)}>
              <span className="text-caption">10s</span><RotateCw className="h-4 w-4" />
            </PlayerButton>
          </div>

          <div className="flex items-center justify-end gap-0.5">
            <SpeedMenu rate={rate} ratio={plan.ratio} onChange={setSpeed} />
            <PlayerButton label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)}>
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </PlayerButton>
            <PlayerButton label="Save snapshot" onClick={onSnapshot} disabled={Boolean(failure)}>
              <CameraIcon className="h-4 w-4" />
            </PlayerButton>
            <PlayerButton label="Fullscreen (F)" onClick={onFullscreen}>
              <Maximize className="h-4 w-4" />
            </PlayerButton>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Viewer speed on top of the interval. Drawn inline rather than portalled so
 * it still opens in fullscreen, where a portal would sit outside the stage.
 */
function SpeedMenu({ rate, ratio, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Playback speed"
        className="inline-flex h-8 items-center gap-1 rounded-md border border-white/15 bg-white/10 px-2 text-small font-semibold tabular-nums text-white transition hover:bg-white/20"
      >
        {rate}x <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div role="menu" className="absolute bottom-full right-0 z-30 mb-2 w-52 rounded-lg border border-white/10 bg-slate-950/95 p-1 shadow-xl backdrop-blur">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={rate === s}
              onClick={() => { onChange(s); setOpen(false); }}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-small font-semibold tabular-nums transition',
                rate === s ? 'bg-brand/20 text-white' : 'text-white/80 hover:bg-white/10',
              )}
            >
              <span>{s === 1 ? 'Normal' : `${s}×`} <span className="font-medium text-white/50">· {s * ratio}× real time</span></span>
              {rate === s ? <Check className="h-3.5 w-3.5 text-brand" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StageMessage({ overlay, children }) {
  return (
    <div className={cn('absolute inset-0 z-10 grid place-items-center p-6', overlay ? 'bg-slate-950/75' : 'bg-slate-950')}>
      <div className="flex max-w-md flex-col items-center gap-3 text-center">{children}</div>
    </div>
  );
}

function StageButton({ primary, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-small font-semibold text-white transition',
        primary ? 'bg-brand hover:bg-brand-hover' : 'border border-white/20 bg-white/10 hover:bg-white/20',
      )}
    >
      {children}
    </button>
  );
}

/** A transport-bar button: white on the video, whatever the theme. */
function PlayerButton({ label, onClick, disabled, children }) {
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
