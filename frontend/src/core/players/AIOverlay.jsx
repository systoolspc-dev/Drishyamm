import { useEffect, useRef, useState } from 'react';
import { on as onSocket, getSocket } from '@/core/services/socket';

/**
 * AIOverlay — live bounding-box overlay rendered on top of the video.
 *
 * Subscribes to the EPHEMERAL `ai.live` socket channel. These frames are
 * display-only: never persisted, never alerted on.
 *
 * TWO PROBLEMS THIS SOLVES, BOTH OF WHICH LOOK LIKE "THE BOX ISN'T LOCKED ON"
 * ---------------------------------------------------------------------------
 *
 * 1. GEOMETRY. The video is rendered `object-contain` (PlayerFrame.jsx), which
 *    letterboxes the picture inside its element — the picture is NOT the same
 *    rectangle as the container. Positioning boxes as a percentage of the
 *    container therefore applies an affine error: correct at the centre of
 *    frame, increasingly wrong toward the edges, and the box travels at the
 *    wrong SPEED relative to the person (by the ratio of the two aspect
 *    ratios). On a 16:9 camera in an arbitrary-shaped tile that is tens of
 *    pixels of error and several percent of speed drift.
 *
 *    Fixing it by hand means recomputing the letterbox on every resize. An SVG
 *    `viewBox` with `preserveAspectRatio="xMidYMid meet"` performs exactly the
 *    same fit as `object-contain`, so the browser keeps the overlay aligned for
 *    us. We work in inference-frame coordinates and let the SVG map them. This
 *    is the pattern already used in HeadCount.jsx / Footfall.jsx / AiFeed.jsx;
 *    this overlay was the last one still doing percentage maths.
 *
 * 2. UPDATE RATE. The AI publishes overlay frames a few times a second (the
 *    forwarder throttles to `backend_overlay_min_interval_sec`), while video
 *    plays at ~25fps. Painting each update where it lands moves the box in a
 *    few visible jumps per second, always to a position that is already old.
 *
 *    So we keep a small motion model per track — each update yields a velocity —
 *    and a requestAnimationFrame loop draws the PREDICTED position every frame.
 *    The box then glides at display rate and leads toward where the subject is
 *    actually going, instead of trailing.
 *
 *    Positions are written straight to the DOM in that loop; re-rendering every
 *    box through React at 60fps would cost more than the problem is worth.
 *
 * Guard rails, because prediction trusted too far is worse than none:
 *   - extrapolation is capped (EXTRAPOLATE_MAX_MS); beyond that the box holds
 *     still rather than sailing away on a stale velocity;
 *   - velocity is smoothed, so one noisy detection cannot fling the box;
 *   - velocity is clamped, so a detection jumping across frame cannot launch it.
 */
const STALE_MS = 1200;             // no frames for this long → clear the overlay
const EXTRAPOLATE_MAX_MS = 250;    // never predict further ahead than this
const VELOCITY_SMOOTHING = 0.6;    // EMA weight on the newly observed velocity
const MAX_VELOCITY_FPS = 1.2;      // cap, in frame-widths per second

export default function AIOverlay({ monitorId }) {
  // Which boxes exist + their labels. Changes only when a track appears or
  // leaves — never for mere movement, which the rAF loop owns.
  const [tracks, setTracks] = useState([]);
  const [dims, setDims] = useState({ w: 1920, h: 1080 });

  const stateRef = useRef(new Map());   // id → motion state, normalised 0..1
  const elRef    = useRef(new Map());   // id → { rect, label }
  const lastRef  = useRef(0);

  useEffect(() => {
    if (!monitorId) return undefined;
    stateRef.current.clear();
    elRef.current.clear();
    setTracks([]);
    lastRef.current = 0;

    // Tell the server this camera is being watched, so the AI spends full-rate
    // overlay work only where someone is looking (ws.service ai.watch/unwatch).
    // Re-sent on reconnect because the server forgets a dropped socket.
    const watch = () => { const sock = getSocket(); if (sock) sock.emit('ai.watch', { monitorId }); };
    watch();
    const offReconnect = onSocket('connect', watch);

    const off = onSocket('ai.live', (f) => {
      if (!f || f.monitorId !== monitorId) return;
      const now = performance.now();
      lastRef.current = Date.now();

      const fw = f.frameW || 640;
      const fh = f.frameH || 480;
      setDims((d) => (d.w === fw && d.h === fh ? d : { w: fw, h: fh }));

      // v2 compact frames: one positional row per box (see the AI's
      // backend_forwarder); v1 frames (and the zone-guard's) carry objects.
      const STATE = { u: 'unknown', p: 'provisional', c: 'confirmed' };
      const boxes = Array.isArray(f.b)
        ? f.b.map(([trackId, x1, y1, x2, y2, conf, name, gender, state]) => ({
            trackId, bbox: [x1, y1, x2, y2], conf: conf == null ? null : conf / 100,
            name, gender, identityState: STATE[state] || 'unknown',
          }))
        : (Array.isArray(f.boxes) ? f.boxes : []);
      const seen = new Set();
      const next = [];

      boxes.forEach((b, i) => {
        const bb = b.bbox;
        if (!Array.isArray(bb) || bb.length !== 4) return;

        // A stable identity per box matters: without one, two boxes can swap
        // slots between updates and the DOM node for person A is reused for
        // person B — which reads as the box leaping across the frame.
        // trackId is preferred; the positional fallback at least stays stable
        // for a subject who isn't moving much.
        const id = b.trackId != null && b.trackId !== ''
          ? `t${b.trackId}`
          : `p${Math.round(bb[0] / 40)}_${Math.round(bb[1] / 40)}_${i}`;
        seen.add(id);

        // Normalise so the motion model is independent of frame size.
        const x = bb[0] / fw;
        const y = bb[1] / fh;
        const w = (bb[2] - bb[0]) / fw;
        const h = (bb[3] - bb[1]) / fh;

        const prev = stateRef.current.get(id);
        let vx = 0;
        let vy = 0;

        if (prev) {
          const dt = (now - prev.t) / 1000;
          if (dt > 0.02) {                 // tiny gaps produce absurd velocities
            const clamp = (v) => Math.max(-MAX_VELOCITY_FPS, Math.min(MAX_VELOCITY_FPS, v));
            vx = clamp(prev.vx * (1 - VELOCITY_SMOOTHING) + ((x - prev.x) / dt) * VELOCITY_SMOOTHING);
            vy = clamp(prev.vy * (1 - VELOCITY_SMOOTHING) + ((y - prev.y) / dt) * VELOCITY_SMOOTHING);
          } else {
            vx = prev.vx; vy = prev.vy;
          }
        }

        stateRef.current.set(id, { x, y, w, h, vx, vy, t: now });

        const named = b.name && String(b.name).toLowerCase() !== 'unknown';
        const parts = [named ? b.name : 'Face'];
        if (b.gender) parts.push(b.gender);
        next.push({ id, named, label: parts.join(' · ') });
      });

      for (const id of stateRef.current.keys()) if (!seen.has(id)) stateRef.current.delete(id);

      setTracks((cur) => (
        cur.length === next.length && cur.every((c, i) => c.id === next[i].id && c.label === next[i].label)
          ? cur
          : next
      ));
    });

    // Staleness sweep — clear if frames dry up (detection stopped, person gone).
    const tick = setInterval(() => {
      if (lastRef.current && Date.now() - lastRef.current > STALE_MS) {
        stateRef.current.clear();
        setTracks([]);
      }
    }, 400);

    return () => {
      off();
      offReconnect();
      clearInterval(tick);
      const sock = getSocket();
      if (sock) sock.emit('ai.unwatch', { monitorId });
    };
  }, [monitorId]);

  // Draw every track at its predicted position, once per display frame.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const now = performance.now();
      const { w: fw, h: fh } = dims;
      for (const [id, s] of stateRef.current) {
        const els = elRef.current.get(id);
        if (!els) continue;
        // Hold position instead of extrapolating on a stale velocity.
        const dt = Math.min(now - s.t, EXTRAPOLATE_MAX_MS) / 1000;
        const x = (s.x + s.vx * dt) * fw;
        const y = (s.y + s.vy * dt) * fh;
        const w = s.w * fw;
        const h = s.h * fh;
        if (els.rect) {
          els.rect.setAttribute('x', x); els.rect.setAttribute('y', y);
          els.rect.setAttribute('width', Math.max(0, w)); els.rect.setAttribute('height', Math.max(0, h));
        }
        if (els.label) els.label.setAttribute('transform', `translate(${x} ${Math.max(fh * 0.022, y - fh * 0.008)})`);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [dims]);

  if (tracks.length === 0) return null;

  const fontSize = Math.round(dims.h / 42);   // scales with the picture, stays legible
  const stroke   = Math.max(2, Math.round(dims.h / 380));

  return (
    // viewBox + xMidYMid meet reproduces the video's object-contain fit exactly,
    // so boxes land on the picture rather than the padded container.
    <svg
      viewBox={`0 0 ${dims.w} ${dims.h}`}
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 w-full h-full pointer-events-none"
    >
      {tracks.map((t) => {
        // Neutral palette — emerald when recognised, sky otherwise. Deliberately
        // NOT amber/red so a routine face never reads as a warning.
        const colour = t.named ? '#34d399' : '#38bdf8';
        return (
          <g key={t.id}>
            <rect
              ref={(el) => {
                const cur = elRef.current.get(t.id) || {};
                if (el) elRef.current.set(t.id, { ...cur, rect: el });
                else if (cur.label) elRef.current.set(t.id, { ...cur, rect: null });
                else elRef.current.delete(t.id);
              }}
              x={0} y={0} width={0} height={0}
              rx={Math.round(dims.h / 150)}
              fill={colour} fillOpacity={0.10}
              stroke={colour} strokeWidth={stroke}
            />
            <g
              ref={(el) => {
                const cur = elRef.current.get(t.id) || {};
                if (el) elRef.current.set(t.id, { ...cur, label: el });
                else if (cur.rect) elRef.current.set(t.id, { ...cur, label: null });
                else elRef.current.delete(t.id);
              }}
            >
              <text
                x={0} y={0} fontSize={fontSize} fontWeight="600"
                fill={colour} stroke="rgba(0,0,0,0.65)" strokeWidth={fontSize / 5}
                paintOrder="stroke" style={{ letterSpacing: '0.02em' }}
              >
                {t.label}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
