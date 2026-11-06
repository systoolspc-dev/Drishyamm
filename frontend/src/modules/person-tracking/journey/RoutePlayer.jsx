/**
 * RoutePlayer — the Route Flow card, as footage instead of a diagram.
 *
 * Plays one clip per sighting, in time order, and rolls straight into the
 * next. Where the cameras lost the subject for longer than the gap threshold
 * it stops for a beat and says so ("3m unmonitored transition — Main Gate ➔
 * Reception") before the next clip, because the hole is a finding and cutting
 * straight across it would hide it.
 *
 * Sync follows the page's rule: one clock. The player WRITES the page's `t`
 * (and `node`) as footage plays, and READS `t` back — a cursor it did not
 * write itself (a drag on the timeline, a click in Route History) is a request
 * to jump there. It never keeps a second idea of "now" that could drift.
 *
 * Seamless hand-off is two <video> elements: the one on screen, and one
 * loading the NEXT sighting underneath it. At the end of a clip the two swap
 * roles, so the next clip starts from a buffer rather than from a network
 * request.
 */
import {
  useCallback, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useMemo, useReducer,
  useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion as Motion } from 'framer-motion';
import {
  AlertTriangle, Camera, Clock3, Download, EyeOff, Film, Flag, ImageOff, Layers,
  Loader2, LogIn, MapPin, Maximize2, Minimize2, Pause, Play, RotateCcw, SkipBack, SkipForward, Video, X,
} from 'lucide-react';
import Panel from '@/core/ui/panel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/core/ui/tooltip';
import { aiService } from '@/core/services/ai';
import {
  NODE, buildPlaylist, fmtClockSec, fmtDuration, locateInPlaylist, wallAt,
} from './journey-model';

/** How long the unmonitored-gap card stays up before the next clip. */
const GAP_OVERLAY_MS = 2400;
/** How long a sighting with no playable clip holds on its snapshot. */
const HOLD_MS = 3000;
/** The timeline cursor moves in whole seconds; writing faster is noise. */
const CURSOR_WRITE_MS = 1000;
const LIGHTBOX_SPEEDS = [1, 2, 4];

const KIND_BADGE = {
  [NODE.START]: { Icon: LogIn, label: 'Entry' },
  [NODE.END]: { Icon: Flag, label: 'Last seen' },
};

// ── Playback state ──────────────────────────────────────────────────────────
// `slots` is which playlist index each of the two <video> elements holds;
// `active` is the one on screen. Kept in one reducer because a jump changes all
// three together, and three separate setStates would render a frame where the
// visible slot points at the wrong clip.

function initState(len) {
  return {
    index: 0,
    slots: [len ? 0 : null, len > 1 ? 1 : null],
    active: 0,
    transition: null, // { from, to } while the gap card is up
    ended: false,
    nonce: 0, // bumps on every jump, so re-seeking the same clip still re-runs
  };
}

function reducer(s, a) {
  switch (a.type) {
    case 'jump': {
      const { target, len } = a;
      const preload = target + 1 < len ? target + 1 : null;
      const other = 1 - s.active;
      const slots = [...s.slots];
      let active = s.active;
      if (slots[s.active] === target) {
        slots[other] = preload;
      } else if (slots[other] === target) {
        // The common case: the next clip was already buffering underneath.
        active = other;
        slots[s.active] = preload;
      } else {
        slots[s.active] = target;
        slots[other] = preload;
      }
      return { index: target, slots, active, transition: null, ended: false, nonce: s.nonce + 1 };
    }
    case 'gap':
      return { ...s, transition: { from: s.index, to: a.to } };
    case 'end':
      return { ...s, transition: null, ended: true };
    default:
      return s;
  }
}

/** The playable window of a clip once its duration is known. */
function clipBounds(video, clip) {
  const dur = Number.isFinite(video?.duration) ? video.duration : null;
  let start = clip.startSec;
  if (dur != null && start >= dur) start = 0;
  let end = clip.endSec ?? dur;
  if (dur != null && (end == null || end > dur || end <= start)) end = dur;
  return { start, end };
}

function seekVideo(video, clip, fraction) {
  const { start, end } = clipBounds(video, clip);
  const t = end != null ? start + fraction * (end - start) : start;
  if (Math.abs(video.currentTime - t) > 0.25) video.currentTime = t;
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/**
 * `playing` and `speed` are the page's, because their buttons live in the
 * Timeline dock rather than on this card. Previous / next / play are exposed
 * through `ref`, and `onStep` reports which sighting is on screen so the dock
 * and Route History can reflect it without owning a copy of the playlist.
 */
export default function RoutePlayer({
  ref, nodes, cursorMs, selectedNodeId, onSync, floors, floor, onFloor,
  playing, onPlayingChange, speed, onSpeedChange, onStep,
}) {
  const playlist = useMemo(() => buildPlaylist(nodes), [nodes]);
  const len = playlist.length;
  const [state, dispatch] = useReducer(reducer, len, initState);
  const [fraction, setFraction] = useState(0);
  const [failed, setFailed] = useState(() => new Set());
  const [buffering, setBuffering] = useState(true);

  const videoRefs = useRef([null, null]);
  // A seek that has to wait for the target clip's metadata.
  const pendingSeek = useRef(null);
  // The last few `t` values this player wrote, so their echo back through the
  // URL is not mistaken for someone dragging the timeline.
  const recentWrites = useRef([]);
  const lastWrite = useRef(null);
  const holdElapsed = useRef({ nonce: -1, ms: 0 });

  const seg = playlist[state.index] || null;
  const isPlayable = useCallback((s) => Boolean(s?.clip) && !failed.has(s.index), [failed]);
  const still = seg ? !isPlayable(seg) : false;
  const nodeCount = nodes.length;

  // ── Writing the clock ────────────────────────────────────────────────────
  const writeCursor = useCallback((msValue, force = false) => {
    if (msValue == null) return;
    const t = Math.round(msValue);
    if (!force && lastWrite.current != null && Math.abs(t - lastWrite.current) < CURSOR_WRITE_MS) return;
    lastWrite.current = t;
    recentWrites.current = [...recentWrites.current.slice(-5), t];
    onSync({ t });
  }, [onSync]);

  const jump = useCallback((target, f = 0) => {
    if (target == null || target < 0 || target >= len) return;
    pendingSeek.current = { index: target, fraction: clamp01(f) };
    setFraction(clamp01(f));
    setBuffering(true);
    dispatch({ type: 'jump', target, len });
  }, [len]);

  /** End of the current clip: the next one, the gap card, or the end. */
  const advance = () => {
    if (!seg || state.transition || state.ended) return;
    const next = playlist[state.index + 1];
    if (!next) {
      setFraction(1);
      onPlayingChange(false);
      writeCursor(seg.lastSeenMs, true);
      dispatch({ type: 'end' });
      return;
    }
    if (next.gapBeforeMs != null) {
      writeCursor(seg.lastSeenMs, true);
      dispatch({ type: 'gap', to: next.index });
      return;
    }
    jump(next.index, 0);
  };
  // The same step, callable from the hold timer with this render's state.
  const advanceFromTimer = useEffectEvent(() => advance());

  // ── Reading the clock ────────────────────────────────────────────────────
  // A cursor this player did not write is a request to go there. The URL is
  // the external system here -- the timeline and Route History only ever talk
  // to it -- so reacting in an effect is the synchronisation, not a cascade.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (cursorMs == null) return;
    const t = Math.round(cursorMs);
    if (recentWrites.current.includes(t)) return;
    recentWrites.current = [...recentWrites.current.slice(-5), t];
    lastWrite.current = t;
    const hit = locateInPlaylist(playlist, t);
    if (hit) jump(hit.index, hit.fraction);
  }, [cursorMs, playlist, jump]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // The history panel's ring follows the clip on screen.
  const syncNode = useEffectEvent((nodeId) => {
    if (nodeId && nodeId !== selectedNodeId) onSync({ node: nodeId });
  });
  useEffect(() => { syncNode(seg?.nodeId); }, [seg?.nodeId]);

  // Tell the page which sighting is on screen: the dock enables previous /
  // next from it, and Route History highlights (and scrolls to) its node.
  useEffect(() => {
    onStep?.({ index: state.index, len, nodeId: seg?.nodeId ?? null, ended: state.ended });
  }, [onStep, state.index, len, seg?.nodeId, state.ended]);

  const autoplayRefused = useEffectEvent(() => onPlayingChange(false));

  // ── Driving the two <video> elements ─────────────────────────────────────
  // Apply a jump's seek once the target clip can seek. A clip that was already
  // buffering underneath usually can, so the swap is instant.
  useEffect(() => {
    const p = pendingSeek.current;
    if (!p || p.index !== state.index || !seg?.clip) return;
    const v = videoRefs.current[state.active];
    if (v && v.readyState >= 1) {
      seekVideo(v, seg.clip, p.fraction);
      pendingSeek.current = null;
    }
  }, [state.nonce, state.index, state.active, seg]);

  useEffect(() => {
    videoRefs.current.forEach((v, slot) => {
      if (!v) return;
      v.playbackRate = speed;
      const shouldPlay = slot === state.active && playing && !state.transition && !state.ended;
      if (shouldPlay) {
        v.play()?.catch?.((err) => {
          // Autoplay refused (a policy, not a fault): leave it to the button.
          if (err?.name === 'NotAllowedError') autoplayRefused();
        });
      } else if (!v.paused) {
        v.pause();
      }
    });
  }, [state.active, state.slots, state.transition, state.ended, state.nonce, playing, speed]);

  const onLoadedMetadata = (slot, segIndex) => (e) => {
    const v = e.currentTarget;
    const s = playlist[segIndex];
    if (!s?.clip) return;
    v.playbackRate = speed;
    const p = pendingSeek.current;
    if (p && p.index === segIndex && slot === state.active) {
      seekVideo(v, s.clip, p.fraction);
      pendingSeek.current = null;
    } else {
      // The preloading slot parks on the sighting's first frame, so the
      // bytes it buffers are the ones that will actually play.
      seekVideo(v, s.clip, 0);
    }
  };

  const onTimeUpdate = (slot, segIndex) => (e) => {
    if (slot !== state.active || segIndex !== state.index || state.transition || state.ended) return;
    const v = e.currentTarget;
    const s = playlist[segIndex];
    const { start, end } = clipBounds(v, s.clip);
    const f = end ? clamp01((v.currentTime - start) / Math.max(0.001, end - start)) : 0;
    setFraction(f);
    writeCursor(wallAt(s, f, v.currentTime));
    // A sighting bounded inside a longer recording ends before the file does.
    // Live-recorded files can report `duration = Infinity`; the bound still
    // applies then, it just cannot coincide with the file's own end.
    const boundedBeforeFileEnd = !Number.isFinite(v.duration) || end < v.duration - 0.05;
    if (end != null && boundedBeforeFileEnd && v.currentTime >= end) advance();
  };

  const onEnded = (slot) => () => {
    if (slot === state.active) advance();
  };

  const onClipError = (segIndex) => () => {
    setFailed((prev) => (prev.has(segIndex) ? prev : new Set(prev).add(segIndex)));
  };

  // ── Sightings with no footage: hold on the snapshot, then move on ────────
  useEffect(() => {
    if (!seg || !still || !playing || state.transition || state.ended) return undefined;
    if (holdElapsed.current.nonce !== state.nonce) {
      const p = pendingSeek.current;
      holdElapsed.current = {
        nonce: state.nonce,
        ms: p && p.index === state.index ? p.fraction * HOLD_MS : 0,
      };
    }
    const TICK = 200;
    const id = setInterval(() => {
      holdElapsed.current.ms += TICK * speed;
      const f = clamp01(holdElapsed.current.ms / HOLD_MS);
      setFraction(f);
      writeCursor(wallAt(seg, f));
      if (f >= 1) {
        clearInterval(id);
        advanceFromTimer();
      }
    }, TICK);
    return () => clearInterval(id);
  }, [seg, still, playing, state.transition, state.ended, state.nonce, state.index, speed, writeCursor]);

  // ── The unmonitored gap: sweep the timeline across it, then cut ──────────
  useEffect(() => {
    const tr = state.transition;
    if (!tr || !playing) return undefined;
    const from = playlist[tr.from];
    const to = playlist[tr.to];
    const started = performance.now();
    const duration = GAP_OVERLAY_MS / speed;
    const id = setInterval(() => {
      const k = Math.min(1, (performance.now() - started) / duration);
      writeCursor(from.lastSeenMs + k * (to.firstSeenMs - from.lastSeenMs));
      if (k >= 1) {
        clearInterval(id);
        jump(tr.to, 0);
      }
    }, 250);
    return () => clearInterval(id);
  }, [state.transition, playing, playlist, speed, writeCursor, jump]);

  // ── Controls (driven from the Timeline dock through `ref`) ───────────────
  const togglePlay = () => {
    if (state.ended) {
      jump(0, 0);
      onPlayingChange(true);
      return;
    }
    onPlayingChange(!playing);
  };
  const prev = () => jump(Math.max(0, state.index - 1), 0);
  const next = () => {
    if (state.index + 1 < len) jump(state.index + 1, 0);
  };
  useImperativeHandle(ref, () => ({ prev, next, togglePlay }));

  // ── Lightbox ─────────────────────────────────────────────────────────────
  // Not a second player. The lightbox is a <body> portal (a fixed overlay
  // inside the glass Panel would be clipped to it -- backdrop-filter makes the
  // Panel the containing block), and the stage's host node is moved into it.
  // Both <video> elements stay mounted, so play state, position, the clip
  // buffering underneath and the timeline sync carry straight through.
  const [expanded, setExpanded] = useState(false);
  const modalRef = useRef(null);
  const expandBtnRef = useRef(null);
  const wasExpanded = useRef(false);
  // The stage renders into this node, and the node is moved between the two
  // slots. appendChild MOVES an element in one step, and a media element that
  // is back in the document within the same task is not paused -- so the
  // footage keeps playing straight through the move.
  const [stageHost] = useState(() => {
    if (typeof document === 'undefined') return null;
    const host = document.createElement('div');
    host.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';
    return host;
  });
  const inlineSlotRef = useRef(null);
  const modalSlotRef = useRef(null);

  useLayoutEffect(() => {
    const slot = expanded ? modalSlotRef.current : inlineSlotRef.current;
    if (stageHost && slot && stageHost.parentNode !== slot) slot.appendChild(stageHost);
  }, [expanded, stageHost, len]);

  const openLightbox = () => setExpanded(true);
  const closeLightbox = () => setExpanded(false);

  const onLightboxKey = useEffectEvent((e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLightbox();
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      // A focused control keeps its own Space behaviour (press the button,
      // open the select); anywhere else Space is play / pause.
      if (e.target?.closest?.('button, a, input, select, textarea')) return;
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const focusables = modalRef.current?.querySelectorAll(
        'button:not([disabled]), a[href], select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  useEffect(() => {
    if (!expanded) {
      // Hand focus back to where the dialog was opened from.
      if (wasExpanded.current) expandBtnRef.current?.focus();
      wasExpanded.current = false;
      return undefined;
    }
    wasExpanded.current = true;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // The dialog itself takes focus, not the close button -- otherwise the
    // first Space would press "close" instead of pausing.
    modalRef.current?.focus();
    const onKey = (e) => onLightboxKey(e);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  const wallMs = seg ? wallAt(seg, fraction) : null;

  /**
   * The frame on screen, as a PNG. Falls back to the sighting's stored
   * snapshot when there is no frame to grab, or when the clip is served
   * cross-origin without CORS (the canvas is then tainted and unreadable).
   */
  const downloadSnapshot = async () => {
    if (!seg) return;
    const base = fileBaseOf(seg, wallMs);
    const v = videoRefs.current[state.active];
    if (v && isPlayable(seg) && v.readyState >= 2 && v.videoWidth) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        canvas.getContext('2d').drawImage(v, 0, 0);
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('empty frame'))), 'image/png');
        });
        saveBlob(blob, `${base}.png`);
        return;
      } catch {
        /* tainted or empty: use the stored snapshot below */
      }
    }
    const src = snapshotSrcOf(seg);
    if (src) saveUrl(src, `${base}.jpg`);
  };

  const exportClip = () => {
    if (!seg?.clip || !isPlayable(seg)) return;
    const ext = (seg.clip.src.split('?')[0].match(/\.(\w{2,4})$/) || [])[1] || 'mp4';
    saveUrl(seg.clip.src, `${fileBaseOf(seg, seg.firstSeenMs)}.${ext}`);
  };

  const canSnapshot = seg ? isPlayable(seg) || Boolean(snapshotSrcOf(seg)) : false;
  const canExport = seg ? isPlayable(seg) : false;
  // There is no server-side trimming, so a sighting that is a window inside a
  // longer recording exports the whole file -- say so rather than imply a cut.
  const exportNote = !canExport
    ? 'No recorded clip for this sighting'
    : seg.clip.startSec > 0 || seg.clip.endSec != null
      ? `Downloads the source recording — this sighting is at ${fmtOffset(seg.clip.startSec)}${seg.clip.endSec != null ? `–${fmtOffset(seg.clip.endSec)}` : ''}`
      : 'Download this sighting\'s clip';

  const transitionFrom = state.transition ? playlist[state.transition.from] : null;
  const transitionTo = state.transition ? playlist[state.transition.to] : null;
  const monitorId = seg?.stop?.monitor_id || seg?.stop?.camera_code || null;
  const seenAt = seg?.stop?.first_seen_at || '';

  return (
    <Panel
      bodyClass="flex flex-col p-0"
      className="min-h-0 flex-1"
      fill={false}
      icon={Film}
      right={
        <span className="flex items-center gap-2">
          {floors.length > 1 ? (
            <label className="inline-flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 shrink-0 text-fg-subtle" strokeWidth={2} />
              <select
                aria-label="Filter by floor"
                className="h-7 rounded-lg border border-line bg-surface px-2 text-[11px] font-semibold text-fg-secondary focus:border-brand focus:outline-none"
                onChange={(e) => onFloor(e.target.value)}
                value={floor}
              >
                <option value="all">All floors</option>
                {floors.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          ) : null}
          {len ? (
            <span className="whitespace-nowrap text-micro font-semibold tabular-nums text-fg-subtle">
              clip {state.index + 1} / {len}
            </span>
          ) : null}
          {monitorId ? (
            <Link
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[11px] font-semibold text-fg-secondary transition hover:bg-surface-sunken"
              title="Open this camera's full recording at this moment"
              to={`/playback?monitor=${encodeURIComponent(monitorId)}${seenAt ? `&t=${encodeURIComponent(seenAt)}` : ''}`}
            >
              <Play className="h-3 w-3" strokeWidth={2.5} />
              Full recording
            </Link>
          ) : null}
        </span>
      }
      title="Route flow"
    >
      {!len ? (
        <p className="px-6 py-14 text-center text-small text-fg-muted">No sightings in this journey yet.</p>
      ) : (
        // Takes all the height the card has left; the stage fills it.
        <div className="relative min-h-[180px] flex-1 bg-gray-950 text-gray-100">
          {/* The card keeps its footprint while the video is out in the
              lightbox, and says where the video went. */}
          {expanded ? <ExpandedPlaceholder onReturn={closeLightbox} segment={seg} /> : null}
          <div className="absolute inset-0" ref={inlineSlotRef} />
        </div>
      )}

      {/* ── Stage ───────────────────────────────────────────────────────────
          Rendered into its own detached host node, which is then MOVED between
          the card and the lightbox (see the layout effect above). A move keeps
          both <video> elements alive, so opening the lightbox never reloads,
          rewinds or re-buffers the footage. */}
      {len > 0 && stageHost ? createPortal(
        <div
          className={expanded
            ? 'group relative aspect-video w-full overflow-hidden rounded-xl bg-gray-950 ring-1 ring-white/10'
            : 'group relative h-full w-full overflow-hidden bg-gray-950'}
          // In the card the stage fills the whole video area edge to edge, so
          // the overlays (details, expand, time tags) sit at the card's own
          // corners; the footage keeps its native shape via object-contain on
          // the <video>. In the lightbox it is a 16:9 screen filling the
          // window's width -- the window itself is sized so that fits.
        >
          {[0, 1].map((slot) => {
            const s = playlist[state.slots[slot]];
            const shown = slot === state.active;
            return (
              <div
                aria-hidden={!shown}
                className={`absolute inset-0 transition-opacity duration-300 ${shown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                key={slot}
              >
                {s && isPlayable(s) ? (
                  <video
                    className="h-full w-full object-contain"
                    key={s.key}
                    muted
                    onCanPlay={shown ? () => setBuffering(false) : undefined}
                    onEnded={onEnded(slot)}
                    onError={onClipError(s.index)}
                    onLoadedMetadata={onLoadedMetadata(slot, s.index)}
                    onPlaying={shown ? () => setBuffering(false) : undefined}
                    onTimeUpdate={onTimeUpdate(slot, s.index)}
                    onWaiting={shown ? () => setBuffering(true) : undefined}
                    playsInline
                    preload="auto"
                    ref={(el) => { videoRefs.current[slot] = el; }}
                    src={s.clip.src}
                  />
                ) : s ? (
                  <StillFrame segment={s} />
                ) : null}
              </div>
            );
          })}

          {/* The lightbox header carries these details, so the in-video
              copy is for the inline card only. */}
          {seg && !expanded ? <SegmentHeader nodeCount={nodeCount} segment={seg} /> : null}

          {!expanded ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label="Expand View"
                  className="absolute right-2.5 top-2.5 z-20 grid h-8 w-8 place-items-center rounded-lg bg-black/60 text-white ring-1 ring-white/25 transition-all duration-200 hover:scale-105 hover:bg-black/80"
                  onClick={openLightbox}
                  ref={expandBtnRef}
                  type="button"
                >
                  <Maximize2 className="h-4 w-4" strokeWidth={2.25} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Expand View</TooltipContent>
            </Tooltip>
          ) : null}

          {/* Wall-clock burn-in, CCTV-style. Informational only: the Timeline
              dock is the one place that shows and moves playback position,
              so the card carries no progress bar of its own to disagree
              with it. */}
          {seg ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6">
              <div className="flex items-end justify-between gap-2 text-[10.5px] font-semibold tabular-nums text-gray-200">
                <span className="rounded bg-black/50 px-1.5 py-0.5">
                  {still ? 'No recorded clip · snapshot' : `${seg.camera} · recorded`}
                </span>
                <span className="rounded bg-black/50 px-1.5 py-0.5">{fmtClockSec(wallAt(seg, fraction))}</span>
              </div>
            </div>
          ) : null}

          {buffering && !still && !state.transition && !state.ended && playing ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <Loader2 className="h-7 w-7 animate-spin text-white/80" />
            </div>
          ) : null}

          <AnimatePresence>
            {transitionFrom && transitionTo ? (
              <GapOverlay
                duration={GAP_OVERLAY_MS / speed}
                from={transitionFrom}
                key={`${transitionFrom.index}-${transitionTo.index}`}
                paused={!playing}
                to={transitionTo}
              />
            ) : null}
          </AnimatePresence>

          {state.ended ? (
            <div className="absolute inset-0 grid place-items-center bg-gray-950/80 backdrop-blur-sm">
              <div className="text-center">
                <p className="text-sm font-bold text-gray-100">End of route</p>
                <p className="mt-0.5 text-[11px] text-gray-400">Last seen {fmtClockSec(seg?.lastSeenMs)} · {seg?.location}</p>
                <button
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-[11.5px] font-semibold text-white transition hover:bg-brand-hover"
                  onClick={togglePlay}
                  type="button"
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Replay route
                </button>
              </div>
            </div>
          ) : null}
        </div>,
        stageHost,
      ) : null}

      {/* ── Lightbox ────────────────────────────────────────────────────────
          Portalled to <body>: the Panel is a glass card with backdrop-filter,
          which makes it the containing block for position:fixed descendants --
          a fixed overlay inside it is clipped to the card.

          A floating window rather than a full-bleed takeover: the panel is
          sized to the footage (the largest 16:9 that leaves room for its
          header and footer), so there is never a band of empty chrome around
          the video, and the dimmed page stays visible around it. */}
      {len > 0 && expanded ? createPortal(
        <div
          className="fixed inset-0 z-[70] grid place-items-center bg-black/80 p-4 backdrop-blur-sm sm:p-6"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeLightbox(); }}
        >
          <Motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-label={`Expanded view: ${seg?.stop?.label || seg?.location || 'sighting'}`}
            aria-modal="true"
            className="flex max-h-full flex-col overflow-hidden rounded-2xl border border-gray-800 bg-[#12161f] text-gray-100 shadow-[0_32px_96px_-16px_rgba(0,0,0,0.85)] outline-none ring-1 ring-white/5"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            ref={modalRef}
            role="dialog"
            style={{ width: 'min(calc(var(--app-vw) - 3rem), 1280px, calc((var(--app-vh) - 17rem) * 16 / 9 + 1.5rem))' }}
            tabIndex={-1}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {seg ? (
              <LightboxHeader
                nodeCount={nodeCount}
                onClose={closeLightbox}
                playing={playing && !state.ended}
                segment={seg}
                wallMs={wallMs}
              />
            ) : null}

            {/* The stage host is appended here. */}
            <div className="bg-black/40 p-3" ref={modalSlotRef} />

            <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-t border-gray-800 px-5 py-3.5">
              {/* Transport: the play button is the one primary control. */}
              <div className="flex items-center gap-1.5">
                <RoundButton disabled={state.index === 0} label="Previous step" onClick={prev}>
                  <SkipBack className="h-4 w-4" strokeWidth={2.25} />
                </RoundButton>
                <button
                  aria-label={playing && !state.ended ? 'Pause (Space)' : 'Play (Space)'}
                  className="grid h-11 w-11 place-items-center rounded-full bg-amber-500 text-gray-950 shadow-[0_6px_20px_-4px_rgba(245,158,11,0.55)] transition-all duration-200 hover:scale-105 hover:bg-amber-400 active:scale-95"
                  onClick={togglePlay}
                  title={playing && !state.ended ? 'Pause (Space)' : 'Play (Space)'}
                  type="button"
                >
                  {playing && !state.ended
                    ? <Pause className="h-5 w-5" fill="currentColor" strokeWidth={1.5} />
                    : <Play className="ml-0.5 h-5 w-5" fill="currentColor" strokeWidth={1.5} />}
                </button>
                <RoundButton disabled={state.index + 1 >= len} label="Next step" onClick={next}>
                  <SkipForward className="h-4 w-4" strokeWidth={2.25} />
                </RoundButton>
              </div>

              <div aria-label="Playback speed" className="inline-flex rounded-full bg-white/5 p-0.5 ring-1 ring-white/10" role="group">
                {LIGHTBOX_SPEEDS.map((sp) => (
                  <button
                    aria-pressed={speed === sp}
                    className={`rounded-full px-2.5 py-1 text-[11.5px] font-bold tabular-nums transition-all duration-200 ${
                      speed === sp ? 'bg-amber-500 text-gray-950 shadow-sm' : 'text-gray-400 hover:text-gray-100'
                    }`}
                    key={sp}
                    onClick={() => onSpeedChange?.(sp)}
                    type="button"
                  >
                    {sp}×
                  </button>
                ))}
              </div>

              {/* Where in the route, and what comes next. */}
              <div className="min-w-0 text-[11.5px] leading-tight">
                <p className="font-semibold tabular-nums text-gray-200">
                  Step {state.index + 1} <span className="text-gray-500">of {len}</span>
                </p>
                <p className="truncate text-gray-500">
                  {playlist[state.index + 1]
                    ? <>Next: <span className="text-gray-300">{playlist[state.index + 1].location}</span></>
                    : 'Last sighting of the route'}
                </p>
              </div>

              <span className="flex-1" />

              <div className="flex items-center gap-2">
                <button
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold text-gray-200 ring-1 ring-white/10 transition-all duration-200 hover:bg-white/5 hover:ring-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!canSnapshot}
                  onClick={downloadSnapshot}
                  title={canSnapshot ? 'Save the frame on screen as an image' : 'No frame or snapshot for this sighting'}
                  type="button"
                >
                  <Camera className="h-4 w-4" strokeWidth={2} />
                  Download Snapshot
                </button>
                <button
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-[12px] font-semibold text-white ring-1 ring-white/15 transition-all duration-200 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!canExport}
                  onClick={exportClip}
                  title={exportNote}
                  type="button"
                >
                  <Download className="h-4 w-4" strokeWidth={2} />
                  Export Clip
                </button>
              </div>
            </div>
          </Motion.div>
        </div>,
        document.body,
      ) : null}
    </Panel>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function SegmentHeader({ segment, nodeCount }) {
  const badge = KIND_BADGE[segment.kind];
  const nodeLabel = segment.stopCount > 1
    ? `Node ${segment.nodeIndex + 1}/${nodeCount} · sighting ${segment.stopIndex + 1}/${segment.stopCount}`
    : `Node ${segment.nodeIndex + 1}/${nodeCount}`;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 via-black/40 to-transparent pb-8 pl-3 pr-12 pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em]">
        <span className="rounded bg-white/10 px-1.5 py-0.5 tabular-nums text-gray-200 ring-1 ring-white/15">{nodeLabel}</span>
        {badge ? (
          <span className="inline-flex items-center gap-1 rounded bg-success/25 px-1.5 py-0.5 text-green-200 ring-1 ring-success/40">
            <badge.Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
            {badge.label}
          </span>
        ) : null}
        {segment.zone ? (
          <span className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-gray-200 ring-1 ring-white/15">
            <MapPin className="h-2.5 w-2.5" strokeWidth={2.5} />
            {segment.zone}
          </span>
        ) : null}
        {segment.alert ? (
          <span className="inline-flex items-center gap-1 rounded bg-danger/30 px-1.5 py-0.5 text-red-200 ring-1 ring-danger/50">
            <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.5} />
            Violation
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-sm font-bold text-white drop-shadow">{segment.location}</span>
        <span className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-gray-100">{segment.camera}</span>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums text-gray-200">
          <Clock3 className="h-3 w-3" strokeWidth={2.5} />
          {fmtClockSec(segment.firstSeenMs)}
          {segment.lastSeenMs > segment.firstSeenMs ? ` · ${fmtDuration(segment.lastSeenMs - segment.firstSeenMs)}` : ''}
        </span>
      </div>
      {segment.alert ? (
        <p className="mt-1 text-[11px] font-semibold text-red-200">{segment.alert.message}</p>
      ) : null}
    </div>
  );
}

/** What the card shows while its video is out in the lightbox. */
function ExpandedPlaceholder({ segment, onReturn }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-gray-950">
      <div className="text-center">
        <Maximize2 className="mx-auto h-7 w-7 text-amber-400" strokeWidth={2} />
        <p className="mt-2 text-[12.5px] font-semibold text-gray-200">Playing in expanded view</p>
        {segment ? <p className="mt-0.5 text-[11px] text-gray-400">{segment.stop?.label || segment.location}</p> : null}
        <button
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-[11.5px] font-semibold text-gray-200 transition-all duration-200 hover:bg-[#161b26]"
          onClick={onReturn}
          type="button"
        >
          <Minimize2 className="h-3.5 w-3.5" strokeWidth={2.25} />
          Return to card
        </button>
      </div>
    </div>
  );
}

function LightboxHeader({ segment, nodeCount, wallMs, playing, onClose }) {
  const badge = KIND_BADGE[segment.kind];
  const date = wallMs != null
    ? new Date(wallMs).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';
  return (
    <div className="flex shrink-0 items-center gap-3.5 border-b border-gray-800 px-5 py-3.5">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ${
        segment.alert ? 'bg-red-500/15 text-red-400 ring-red-500/30' : 'bg-amber-500/15 text-amber-400 ring-amber-500/30'
      }`}
      >
        <Video className="h-5 w-5" strokeWidth={2} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate text-[17px] font-bold tracking-tight text-white">
            {segment.stop?.label || `${segment.location} - ${segment.camera}`}
          </h2>
          {segment.alert ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-red-300 ring-1 ring-red-500/40">
              <AlertTriangle className="h-3 w-3" strokeWidth={2.5} />
              {segment.alert.message}
            </span>
          ) : badge ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
              <badge.Icon className="h-3 w-3" strokeWidth={2.5} />
              {badge.label}
            </span>
          ) : null}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-gray-400">
          <span className="inline-flex items-center gap-1 font-semibold tabular-nums text-gray-200">
            <Clock3 className="h-3.5 w-3.5 text-gray-500" strokeWidth={2.25} />
            {date} · {fmtClockSec(wallMs)}
          </span>
          <span className="text-gray-600">•</span>
          <span>Node {segment.nodeIndex + 1} of {nodeCount}</span>
          {segment.zone ? (
            <>
              <span className="text-gray-600">•</span>
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" strokeWidth={2.25} />
                {segment.zone}
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="hidden items-center gap-3 md:flex">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] ring-1 ${
          playing ? 'bg-amber-500/10 text-amber-400 ring-amber-500/30' : 'bg-white/5 text-gray-400 ring-white/10'
        }`}
        >
          <span className="relative flex h-1.5 w-1.5">
            {playing ? <span className="absolute inset-0 animate-ping rounded-full bg-amber-400 opacity-75" /> : null}
            <span className={`relative h-1.5 w-1.5 rounded-full ${playing ? 'bg-amber-400' : 'bg-gray-500'}`} />
          </span>
          {playing ? 'Playing' : 'Paused'}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-gray-500">
          <Kbd>Space</Kbd> play
          <Kbd className="ml-1.5">Esc</Kbd> close
        </span>
      </div>

      <button
        aria-label="Close expanded view"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-gray-400 ring-1 ring-white/10 transition-all duration-200 hover:rotate-90 hover:bg-white/10 hover:text-white"
        onClick={onClose}
        title="Close (Esc)"
        type="button"
      >
        <X className="h-[18px] w-[18px]" strokeWidth={2.25} />
      </button>
    </div>
  );
}

function Kbd({ className = '', children }) {
  return (
    <kbd className={`rounded-md border border-white/10 bg-white/5 px-1.5 py-px font-sans text-[10px] font-semibold text-gray-300 shadow-[inset_0_-1px_0_rgba(255,255,255,0.08)] ${className}`}>
      {children}
    </kbd>
  );
}

function RoundButton({ label, onClick, disabled, children }) {
  return (
    <button
      aria-label={label}
      className="grid h-9 w-9 place-items-center rounded-full text-gray-300 transition-all duration-200 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

// ── Saving files ────────────────────────────────────────────────────────────

/** A displayable URL for the sighting's snapshot, or null. */
function snapshotSrcOf(segment) {
  const raw = segment?.snapshot;
  if (!raw) return null;
  return aiService.snapshotSrc(raw) || (/^(https?:)?\//.test(raw) ? raw : null);
}

/** "Server_Room_-_CAM_12_2026-05-08T10-29-00" */
function fileBaseOf(segment, msValue) {
  const name = String(segment.stop?.label || `${segment.location} ${segment.camera}`).replace(/[^\w-]+/g, '_');
  const at = msValue != null ? new Date(msValue).toISOString().slice(0, 19).replace(/:/g, '-') : 'unknown-time';
  return `${name}_${at}`;
}

const fmtOffset = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  saveUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * `download` is honoured for same-origin and blob URLs. A cross-origin URL
 * ignores it and opens in a new tab instead, which still lets the operator
 * save the file -- better than a silent no-op.
 */
function saveUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function StillFrame({ segment }) {
  const [broken, setBroken] = useState(false);
  const src = snapshotSrcOf(segment);
  if (src && !broken) {
    return <img alt="" className="h-full w-full object-contain" onError={() => setBroken(true)} src={src} />;
  }
  return (
    <div className="grid h-full w-full place-items-center">
      <div className="text-center text-gray-500">
        <ImageOff className="mx-auto h-8 w-8" strokeWidth={1.5} />
        <p className="mt-2 text-[11.5px] font-semibold text-gray-400">No recorded clip for this sighting</p>
        <p className="mt-0.5 text-[10.5px]">Holding {HOLD_MS / 1000}s, then continuing the route</p>
      </div>
    </div>
  );
}

function GapOverlay({ from, to, duration, paused }) {
  return (
    <Motion.div
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-10 grid place-items-center bg-gray-950/85 backdrop-blur-sm"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      role="status"
      transition={{ duration: 0.25 }}
    >
      <div className="w-[min(440px,86%)] text-center">
        <span className="mx-auto grid h-10 w-10 place-items-center rounded-full border border-dashed border-info bg-info/15 text-info">
          <EyeOff className="h-5 w-5" strokeWidth={2} />
        </span>
        <p className="mt-3 text-base font-bold text-white">
          {fmtDuration(to.gapBeforeMs)} Unmonitored Transition
        </p>
        <p className="mt-1 text-[12.5px] font-semibold text-gray-300">
          {from.location} <span className="text-info">➔</span> {to.location}
        </p>
        <p className="mt-1 text-[11px] tabular-nums text-gray-500">
          {from.camera} {fmtClockSec(from.lastSeenMs)} → {to.camera} {fmtClockSec(to.firstSeenMs)} · no camera had the subject
        </p>
        <div className="mx-auto mt-4 h-1 w-40 overflow-hidden rounded-full border-t border-dashed border-info/40 bg-white/10">
          {paused ? null : (
            <Motion.div
              animate={{ width: '100%' }}
              className="h-full bg-info"
              initial={{ width: 0 }}
              transition={{ duration: duration / 1000, ease: 'linear' }}
            />
          )}
        </div>
      </div>
    </Motion.div>
  );
}
