// The wall itself — full screen, no app chrome, one page of live tiles at a
// time. Plays a saved layout (?layout=<id>), the editor's unsaved draft
// (?draft=1) or a quick wall built on the operator page (?quick=1). When it
// runs in its own window the draft is re-read whenever the editor changes it,
// so a second monitor follows along while you edit.
//
// The control strip floats OVER the video and hides after a few seconds
// without the pointer moving, so the tiles never resize when it comes and goes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Maximize2, Minimize2, X } from 'lucide-react';
import DirectStreamPlayer from '@/core/players/DirectStreamPlayer';
import { useGroups } from '@/core/hooks/useQueries';
import { useAuthStore } from '@/core/store/authStore';
import { wallLayoutService } from '@/core/services/wallLayouts';
import { releaseAllStreams } from '@/core/services/streamCache';
import { toast } from '@/core/store/toastStore';
import { OfflineBody, WallTile } from './monitor-wall/WallTile';
import {
  cameraIds, indexCameras, liveBudget, playablePages, readLocalDraft, readQuickDraft, rememberMe, shortDate,
} from './monitor-wall/model';

const STRIP_HIDE_MS = 4000;
const DRAFT_KEY = 'monitorWall.draft';

export default function MonitorWallLive() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const layoutId = params.get('layout');
  const quick = params.get('quick') === '1';
  const userId = useAuthStore((s) => s.user?.id);

  const { data: groups = [] } = useGroups({ refetchInterval: 30_000 });
  const { byId } = useMemo(() => indexCameras(groups, []), [groups]);

  const layoutQ = useQuery({
    queryKey: ['wall-layout', layoutId],
    queryFn: () => wallLayoutService.get(layoutId),
    enabled: !!layoutId,
    refetchInterval: 60_000,
    retry: 1,
  });
  // The account's other walls, for "Switch wall" without leaving the screen.
  const layoutsQ = useQuery({ queryKey: ['wall-layouts'], queryFn: () => wallLayoutService.list(), staleTime: 60_000 });
  const otherWalls = useMemo(() => (layoutsQ.data ?? []).filter((l) => l.id !== layoutId), [layoutsQ.data, layoutId]);

  const [draft, setDraft] = useState(() => (layoutId ? null : quick ? readQuickDraft() : readLocalDraft()));
  useEffect(() => {
    if (layoutId || quick) return undefined;
    const onStorage = (e) => { if (e.key === DRAFT_KEY) setDraft(readLocalDraft()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [layoutId, quick]);

  // The operator page puts the last wall opened first next time.
  useEffect(() => { if (layoutId) rememberMe(userId, { lastOpenedId: layoutId }); }, [layoutId, userId]);

  const layout = layoutId ? layoutQ.data : draft;
  const pages = useMemo(() => (layout ? playablePages(layout, byId) : []), [layout, byId]);
  const pageCount = pages.length;

  // Which page is up and how many seconds it has left live in ONE state, so
  // the once-a-second tick advances both in a single update instead of an
  // effect reacting to its own output. `left` is clamped to the interval
  // because the layout (and its interval) can arrive after the first render.
  const total = layout?.rotateSeconds || 30;
  // ?page=N: the in-app view hands over the page it was showing.
  const [rot, setRot] = useState({ page: Math.max(0, parseInt(params.get('page'), 10) || 0), left: total });
  const current = Math.min(rot.page, Math.max(0, pageCount - 1));
  const left = Math.min(rot.left, total);
  const rotating = !!layout?.rotate && pageCount > 1;
  const [paused, setPaused] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [isFs, setIsFs] = useState(() => !!document.fullscreenElement);
  const [fsPrompt, setFsPrompt] = useState(() => !document.fullscreenElement);
  const [stripShown, setStripShown] = useState(true);
  const overStrip = useRef(false);
  const hideTimer = useRef(null);

  const goTo = useCallback(
    (i) => setRot({ page: ((i % pageCount) + pageCount) % pageCount, left: total }),
    [pageCount, total],
  );
  // Switching walls stays on this route, so start the new one from page 1.
  // `left` is clamped to the new interval once its layout arrives.
  const switchTo = (id) => {
    setRot({ page: 0, left: total });
    navigate(`/monitor-wall/live?layout=${encodeURIComponent(id)}`, { replace: true });
  };

  useEffect(() => {
    if (!rotating || paused || expandedId) return undefined;
    const t = setInterval(() => setRot((s) => {
      const l = Math.min(s.left, total);
      return l > 1
        ? { ...s, left: l - 1 }
        : { page: (Math.min(s.page, pageCount - 1) + 1) % pageCount, left: total };
    }), 1000);
    return () => clearInterval(t);
  }, [rotating, paused, expandedId, pageCount, total]);

  const hideSoon = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (!overStrip.current) setStripShown(false); }, STRIP_HIDE_MS);
  }, []);
  const showStrip = useCallback(() => { setStripShown(true); hideSoon(); }, [hideSoon]);
  useEffect(() => { hideSoon(); return () => clearTimeout(hideTimer.current); }, [hideSoon]);

  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement;
      setIsFs(on);
      // Once the wall has actually been full screen, the prompt below has
      // done its job: from then on leaving is a choice, not something lost.
      if (on) setFsPrompt(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  // Asking for full screen used to swallow the browser's refusal, so a
  // refused request looked exactly like a button that does nothing. Say so
  // instead, and keep the prompt up: the wall is still not full screen.
  const goFullscreen = useCallback(() => {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!req) { toast.error('Full screen unavailable', 'This browser has no Fullscreen API.'); return; }
    Promise.resolve(req.call(el)).catch((err) => {
      setFsPrompt(true);
      toast.error('The browser refused full screen', err?.message || String(err));
    });
  }, []);
  // Leaving is a choice, so the prompt stops asking - but only on a real
  // exit. Clearing it on the way IN would hide the prompt even when the
  // request was refused and the wall never went full screen.
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      setFsPrompt(false);
      document.exitFullscreen().catch(() => {});
    } else {
      goFullscreen();
    }
  };

  // A reload drops fullscreen — a refresh, a crash recovery, or the dev
  // server's hot reload — and the page cannot ask for it back on its own: the
  // browser only grants fullscreen inside a user gesture. So a wall that was
  // LAUNCHED full screen (fs=1) puts itself back on the operator's next click
  // or key press, then stops asking. Escape is left alone: that is how they
  // leave the wall, not a request to re-enter it.
  const wantFs = params.get('fs') === '1';
  useEffect(() => {
    if (!wantFs) return undefined;
    const cleanup = () => {
      window.removeEventListener('pointerdown', rearm);
      window.removeEventListener('keydown', rearm);
    };
    // The full-screen button and F already toggle on their own. Answering
    // the same gesture here too entered full screen on pointerdown and the
    // button's own click then read that as "already full screen" and left
    // again - one click in, one click straight back out. Those two carry
    // the intent themselves; this only stands in for every OTHER gesture.
    const isOwnControl = (e) => (
      e.type === 'keydown'
        ? e.key === 'f' || e.key === 'F'
        : !!e.target?.closest?.('[data-fs-toggle]')
    );
    function rearm(e) {
      if (e.type === 'keydown' && e.key === 'Escape') return;
      if (!isOwnControl(e) && !document.fullscreenElement) goFullscreen();
      cleanup();
    }
    if (document.fullscreenElement) return undefined;
    window.addEventListener('pointerdown', rearm);
    window.addEventListener('keydown', rearm);
    return cleanup;
  }, [wantFs, goFullscreen]);

  // Leaving the wall drops every stream it opened, so the recorders aren't
  // left serving a screen nobody is looking at.
  useEffect(() => () => releaseAllStreams(), []);

  // The key handler is bound once; it reads the latest values through a ref
  // that is refreshed after every render.
  // Leaving: back to the operator page, or close the popup a second monitor
  // opened. In fullscreen the browser takes the first Esc itself (to leave
  // fullscreen) and the next one lands here.
  const exitWall = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (window.opener && !window.opener.closed) { window.close(); return; }
    navigate('/monitor-wall');
  };

  const keys = useRef({});
  useEffect(() => {
    keys.current = { current, expandedId, goTo, toggleFullscreen, showStrip, exitWall };
  });
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.activeElement?.tagName === 'SELECT') return;
      const k = keys.current;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); k.toggleFullscreen(); }
      else if (e.key === 'ArrowRight') k.goTo(k.current + 1);
      else if (e.key === 'ArrowLeft') k.goTo(k.current - 1);
      else if (e.key === ' ') { e.preventDefault(); setPaused((v) => !v); }
      else if (e.key === 'Escape') { if (k.expandedId) setExpandedId(null); else k.exitWall(); }
      k.showStrip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (layoutId && layoutQ.isLoading) {
    return (
      <div className="fixed inset-0 z-40 grid place-items-center bg-black">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  if (!layout) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center text-white">
        <h1 className="text-section text-white">{layoutId ? 'This layout isn’t available' : 'There’s no wall to show yet'}</h1>
        <p className="max-w-md text-body text-white/60">
          {layoutId
            ? 'It may have been deleted, or it belongs to another account.'
            : 'Build one on the Video wall page, then launch it from there.'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/monitor-wall')}
          className="mt-2 inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 text-body font-semibold text-white hover:bg-brand-hover"
        >
          <ArrowLeft className="h-4 w-4" />
          Open Monitor Wall
        </button>
      </div>
    );
  }

  const lostFs = wantFs && fsPrompt && !isFs;
  const known = cameraIds(layout).map((id) => byId.get(id)).filter(Boolean);
  const online = known.filter((c) => c.status === 'online').length;
  const slots = pages[current] || [];
  const expanded = expandedId ? byId.get(expandedId) : null;
  // Every wall budgets its pulls the same way, quick or saved: a page plays
  // at most NVR_PULL_LIMIT streams per recorder and shows that recorder's
  // remaining cameras as refreshing stills. That is what lets a page be full
  // - a 4 × 4 off one NVR is 9 live and 7 stills, not 16 pulls and a jammed
  // recorder (see the 2026-07-06 incident in monitor-wall/model.js).
  const live = liveBudget(slots, byId);

  return (
    <div
      onMouseMove={showStrip}
      className={`fixed inset-0 z-40 overflow-hidden bg-black text-white ${stripShown ? '' : 'cursor-none'}`}
    >
      <div
        className="absolute inset-0 grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
        }}
      >
        {slots.map((id, i) => (
          <WallTile
            key={id || `empty-${current}-${i}`}
            slot={i}
            monitorId={id}
            camera={id ? byId.get(id) : null}
            still={!!id && !live.has(id)}
            focused={focusedId === id}
            audible={!!layout.focusAudio && focusedId === id}
            onFocus={() => setFocusedId((f) => (f === id ? null : id))}
            onExpand={() => setExpandedId(id)}
          />
        ))}
      </div>

      <div
        onMouseEnter={() => { overStrip.current = true; }}
        onMouseLeave={() => { overStrip.current = false; showStrip(); }}
        className={`absolute inset-x-0 top-0 z-10 flex h-[52px] items-center gap-4 border-b border-white/10 bg-neutral-950/85 pl-2.5 pr-3 backdrop-blur-md transition-opacity duration-300 ${stripShown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        <button
          type="button"
          onClick={exitWall}
          title="Back to Video wall (Esc)"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-2.5 text-body font-semibold text-white transition hover:bg-white/10"
        >
          <X className="h-4 w-4" />
          Exit wall
          <Key>Esc</Key>
        </button>
        <span className="h-5 w-px bg-white/15" aria-hidden />
        <span className="max-w-[28ch] truncate text-heading text-white">{layout.name}</span>
        {otherWalls.length > 0 && (
          <label className="relative" title="Switch to another wall">
            <select
              value=""
              onChange={(e) => {
                // Blur first: the key handler ignores arrows while a select
                // has focus, so leaving it focused killed ← / → for good.
                e.target.blur();
                if (e.target.value) switchTo(e.target.value);
              }}
              className="h-8 cursor-pointer appearance-none rounded-lg border border-white/15 bg-white/5 pl-2.5 pr-7 text-small font-semibold text-white outline-none transition hover:bg-white/10 [&>option]:bg-neutral-900 [&>option]:text-white"
            >
              <option value="">Switch wall…</option>
              {otherWalls.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/60" />
          </label>
        )}
        {/* ONE page control: the label and its two arrows. The clickable page
            dots that used to sit here were a second way to change page in the
            same bar - one control, in one place. */}
        <span className="flex items-center gap-2 text-body text-white/70">
          Page {current + 1} of {pageCount}
          {pageCount > 1 && (
            <span className="flex items-center gap-1">
              <PagerButton onClick={() => goTo(current - 1)} label="Previous page (←)">
                <ChevronLeft className="h-4 w-4" />
              </PagerButton>
              <PagerButton onClick={() => goTo(current + 1)} label="Next page (→)">
                <ChevronRight className="h-4 w-4" />
              </PagerButton>
            </span>
          )}
        </span>
        {rotating && <Countdown remaining={Math.max(0, left)} total={total} paused={paused} />}

        <span className="flex-1" />

        <span className="hidden items-center gap-1 text-small text-white/40 2xl:flex">
          <Key>F</Key> fullscreen · <Key>Space</Key> pause
        </span>
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-success/35 bg-success/15 px-2.5 text-small font-semibold text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {online} online
        </span>
        {known.length - online > 0 && (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-danger/35 bg-danger/15 px-2.5 text-small font-semibold text-danger">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            {known.length - online} offline
          </span>
        )}
        <Clock />
        <button
          type="button"
          onClick={toggleFullscreen}
          data-fs-toggle
          title={isFs ? 'Exit full screen (F)' : 'Full screen (F)'}
          className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border transition ${lostFs
            ? 'border-brand bg-brand px-2.5 text-white hover:bg-brand-hover'
            : 'w-9 border-white/15 bg-white/5 text-white hover:bg-white/10'}`}
        >
          {isFs ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          {lostFs && <span className="text-small font-semibold">Full screen</span>}
        </button>
      </div>

      {expanded && (
        <div className="absolute inset-0 z-20 bg-black">
          {expanded.status === 'online' ? (
            <DirectStreamPlayer
              monitorId={expanded.monitorId}
              mode="webrtc"
              quality="high"
              muted={!layout.focusAudio}
              controls={false}
              qualityControl={false}
              protocolBadge={false}
              aiOverlay={false}
              digitalZoom={false}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <OfflineBody camera={expanded} large />
          )}
          <div className="absolute left-3 top-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setExpandedId(null)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/15 bg-black/60 px-2.5 text-body font-semibold text-white backdrop-blur hover:bg-black/80"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to wall
              <Key>Esc</Key>
            </button>
            <span className="text-heading text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">{expanded.name}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PagerButton({ onClick, label, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-7 w-7 place-items-center rounded-lg border border-white/15 bg-white/5 text-white transition hover:bg-white/15"
    >
      {children}
    </button>
  );
}

function Countdown({ remaining, total, paused }) {
  const C = 2 * Math.PI * 9;
  const frac = Math.max(0, Math.min(1, remaining / total));
  return (
    <span className="flex items-center gap-2 text-body text-white/70">
      <svg viewBox="0 0 22 22" className="h-[22px] w-[22px]" aria-hidden>
        <circle cx="11" cy="11" r="9" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
        <circle
          cx="11" cy="11" r="9" fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={`${(frac * C).toFixed(2)} ${C.toFixed(2)}`}
          transform="rotate(-90 11 11)"
        />
      </svg>
      {paused
        ? <>Paused · <Key>Space</Key> to resume</>
        : <>next page in <b className="font-semibold tabular-nums text-white">{remaining} s</b></>}
    </span>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="text-heading tabular-nums text-white">
      {now.toLocaleTimeString('en-GB')}
      <span className="font-medium text-white/55"> · {shortDate(now)}</span>
    </span>
  );
}

function Key({ children }) {
  return (
    <kbd className="inline-grid h-5 min-w-5 place-items-center rounded border border-white/15 px-1 text-caption font-semibold text-white/60">
      {children}
    </kbd>
  );
}
