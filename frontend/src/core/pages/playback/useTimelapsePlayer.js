import { useCallback, useEffect, useRef, useState } from 'react';
import { locate } from './timelapse';

// Browsers play a <video> smoothly up to about 16×. Past that the player
// stops playing and samples frames instead: every tick it seeks to where the
// timelapse should be, which is what a timelapse is — frames at intervals.
const NATIVE_MAX_RATE = 16;
const FRAMES_PER_SEC = 8;      // seek at most this often when sampling
const PUBLISH_MS = 100;        // playhead re-render rate
const MAX_FAILED_CLIPS = 3;    // consecutive clips that fail to load before giving up

/**
 * Plays a run of recorded clips as one timelapse over `plan` =
 * { start, end, ratio }. The playhead is a wall-clock time inside the range;
 * gaps between recordings are skipped. `onDuration(key, ms)` reports each
 * clip's real length once the browser knows it.
 *
 * Mount one per generated timelapse (key it by the plan), so a new timelapse
 * starts from a clean state.
 */
export function useTimelapsePlayer({ plan, clips, onDuration, autoPlay = true }) {
  const [init] = useState(() => {
    const first = plan ? locate(clips, plan.start) : null;
    return {
      key: first?.clip.key ?? null,
      wall: first?.t ?? plan?.start ?? null,
      offset: first ? (first.t - first.clip.start) / 1000 : 0,
    };
  });

  const videoRef = useRef(null);
  const planRef = useRef(plan);
  const clipsRef = useRef(clips);
  const keyRef = useRef(init.key);
  const wallRef = useRef(init.wall);
  const pendingRef = useRef(init.offset);   // seek to apply once the loading clip's metadata arrives
  const loadingRef = useRef(Boolean(init.key));
  const rateRef = useRef(1);
  const lastSeekRef = useRef(0);
  const lastPublishRef = useRef(0);
  const failedRef = useRef(0);
  const onDurationRef = useRef(onDuration);

  useEffect(() => {
    planRef.current = plan;
    clipsRef.current = clips;
    onDurationRef.current = onDuration;
  });

  const [clipKey, setClipKey] = useState(init.key);
  const [wallMs, setWallMs] = useState(init.wall);
  const [playing, setPlaying] = useState(Boolean(autoPlay && init.key));
  const [ended, setEnded] = useState(false);
  const [waiting, setWaiting] = useState(Boolean(init.key));
  const [failure, setFailure] = useState(null);
  const [rate, setRateState] = useState(1);
  const [muted, setMuted] = useState(true);

  const publish = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastPublishRef.current < PUBLISH_MS) return;
    lastPublishRef.current = now;
    setWallMs(wallRef.current);
  }, []);

  const finish = useCallback(() => {
    videoRef.current?.pause();
    wallRef.current = planRef.current?.end ?? wallRef.current;
    setPlaying(false);
    setEnded(true);
    publish(true);
  }, [publish]);

  /** Move the playhead to `t`, loading another clip if `t` is in one. */
  const goTo = useCallback((t, force = false) => {
    const p = planRef.current;
    const loc = locate(clipsRef.current, t);
    if (!p || !loc || loc.t >= p.end) { finish(); return; }
    wallRef.current = loc.t;
    const offset = (loc.t - loc.clip.start) / 1000;

    if (loc.clip.key !== keyRef.current) {
      keyRef.current = loc.clip.key;
      loadingRef.current = true;
      pendingRef.current = offset;
      setClipKey(loc.clip.key);
      setWaiting(true);
      return;
    }
    if (loadingRef.current) { pendingRef.current = offset; return; }

    const v = videoRef.current;
    const now = performance.now();
    if (v && (force || (!v.seeking && now - lastSeekRef.current >= 1000 / FRAMES_PER_SEC))) {
      lastSeekRef.current = now;
      v.currentTime = offset;
    }
  }, [finish]);

  // ── The clock ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    let last = performance.now();
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(now - last, 250);   // a background tab must not leap ahead on return
      last = now;
      const v = videoRef.current;
      const p = planRef.current;
      if (!v || !p || loadingRef.current) return;
      const clip = clipsRef.current.find((c) => c.key === keyRef.current);
      if (!clip) return;

      const effective = p.ratio * rateRef.current;
      if (effective <= NATIVE_MAX_RATE) {
        if (v.playbackRate !== effective) v.playbackRate = effective;
        if (v.paused && !v.ended) v.play().catch(() => {});
        wallRef.current = clip.start + v.currentTime * 1000;
        if (v.ended || wallRef.current >= clip.end) goTo(clip.end, true);
        else if (wallRef.current >= p.end) finish();
      } else {
        if (!v.paused) v.pause();
        goTo(wallRef.current + dt * effective);
      }
      publish();
    };
    raf = requestAnimationFrame(frame);
    const video = videoRef.current;
    return () => {
      cancelAnimationFrame(raf);
      video?.pause();
    };
  }, [playing, goTo, finish, publish]);

  // ── Controls ─────────────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    if (failure || !keyRef.current) return;
    if (ended) {
      setEnded(false);
      goTo(planRef.current.start, true);
      publish(true);
      setPlaying(true);
      return;
    }
    setPlaying((p) => !p);
  }, [ended, failure, goTo, publish]);

  const seek = useCallback((t) => {
    if (!keyRef.current || failure) return;
    setEnded(false);
    goTo(t, true);
    publish(true);
  }, [failure, goTo, publish]);

  /** Skip by `seconds` of timelapse — `seconds × ratio` of footage. */
  const nudge = useCallback((seconds) => {
    const p = planRef.current;
    if (!p) return;
    const target = Math.max(p.start, (wallRef.current ?? p.start) + seconds * 1000 * p.ratio);
    seek(target);
  }, [seek]);

  const setSpeed = useCallback((r) => {
    rateRef.current = r;
    setRateState(r);
  }, []);

  // ── <video> events ───────────────────────────────────────────────────────
  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Number.isFinite(v.duration) && v.duration > 0) onDurationRef.current?.(keyRef.current, v.duration * 1000);
    try { v.currentTime = pendingRef.current; } catch { /* seek past the end: the clock moves on */ }
    loadingRef.current = false;
    failedRef.current = 0;
  }, []);

  const onError = useCallback(() => {
    failedRef.current += 1;
    loadingRef.current = false;
    if (failedRef.current >= MAX_FAILED_CLIPS) {
      setFailure('The recordings for this range could not be loaded.');
      setPlaying(false);
      setWaiting(false);
      return;
    }
    const clip = clipsRef.current.find((c) => c.key === keyRef.current);
    if (clip) goTo(clip.end, true);     // skip the broken clip
  }, [goTo]);

  const retry = useCallback(() => {
    failedRef.current = 0;
    setFailure(null);
    loadingRef.current = true;
    setWaiting(true);
    videoRef.current?.load();
    setPlaying(true);
  }, []);

  const videoProps = {
    ref: videoRef,
    muted,
    playsInline: true,
    preload: 'auto',
    onLoadedMetadata,
    onError,
    onSeeked: () => setWaiting(false),
    onCanPlay: () => setWaiting(false),
    onPlaying: () => setWaiting(false),
    onWaiting: () => setWaiting(true),
  };

  return {
    videoRef, videoProps, clipKey, wallMs, playing, ended, waiting, failure, rate, muted,
    toggle, seek, nudge, setSpeed, setMuted, retry,
  };
}
