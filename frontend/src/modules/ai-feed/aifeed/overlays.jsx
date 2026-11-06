import { useEffect, useRef } from 'react';
import { ORANGE, normalizeDetectionZones, lineInsideNormal, normalizeGender } from './detection-utils';

// Detections arrive by polling — around once a second — while the video plays
// at ~25fps. Drawing each update where it lands therefore moves a box roughly
// once per second, to a position that is already a second old: a person walking
// at 1.4 m/s has moved well over a metre by the time their box catches up. That
// is the "box isn't locked to the person" complaint.
//
// So we keep a small motion model per track — each update yields a velocity —
// and a requestAnimationFrame loop paints the PREDICTED position every display
// frame. Positions are written straight to the DOM; re-rendering the SVG at
// 60fps through React would cost far more than the problem is worth.
//
// Prediction is bounded, because prediction trusted too far is worse than none:
// extrapolation stops after EXTRAPOLATE_MAX_MS and the box simply holds, and
// velocity is both smoothed and clamped so one bad detection cannot fling a box
// across the frame.
const EXTRAPOLATE_MAX_MS = 600;   // poll gap is ~1s; predict over most of it, not past it
const VELOCITY_SMOOTHING = 0.5;
const MAX_VELOCITY_FPS = 1.0;     // frame-widths per second

export function DetectionOverlay({ boxes, frameW, frameH }) {
  const motionRef = useRef(new Map());   // track key → {x,y,w,h,vx,vy,t}
  const elRef     = useRef(new Map());   // track key → { box, label }

  // Fold each detection update into the motion model.
  useEffect(() => {
    if (!frameW || !frameH) return;
    const now = performance.now();
    const seen = new Set();

    (boxes || []).forEach((box, index) => {
      // Identity must be stable across updates. Including the array index (as
      // this did) changes the key whenever detection order shifts, so React
      // tears down one person's element and builds another's — which reads as
      // the box teleporting.
      const key = String(box.track_id ?? `i${index}`);
      seen.add(key);

      const x = Math.max(0, Math.min(frameW, Number(box.x1) || 0)) / frameW;
      const y = Math.max(0, Math.min(frameH, Number(box.y1) || 0)) / frameH;
      const w = Math.max(1, (Number(box.x2) || 0) - (Number(box.x1) || 0)) / frameW;
      const h = Math.max(1, (Number(box.y2) || 0) - (Number(box.y1) || 0)) / frameH;

      const prev = motionRef.current.get(key);
      let vx = 0;
      let vy = 0;
      if (prev) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0.05) {
          const clamp = (v) => Math.max(-MAX_VELOCITY_FPS, Math.min(MAX_VELOCITY_FPS, v));
          vx = clamp(prev.vx * (1 - VELOCITY_SMOOTHING) + ((x - prev.x) / dt) * VELOCITY_SMOOTHING);
          vy = clamp(prev.vy * (1 - VELOCITY_SMOOTHING) + ((y - prev.y) / dt) * VELOCITY_SMOOTHING);
        } else {
          vx = prev.vx; vy = prev.vy;
        }
      }
      motionRef.current.set(key, { x, y, w, h, vx, vy, t: now });
    });

    for (const k of motionRef.current.keys()) if (!seen.has(k)) motionRef.current.delete(k);
  }, [boxes, frameW, frameH]);

  // Paint predicted positions once per display frame.
  useEffect(() => {
    if (!frameW || !frameH) return undefined;
    let raf = 0;
    const draw = () => {
      const now = performance.now();
      for (const [key, s] of motionRef.current) {
        const els = elRef.current.get(key);
        if (!els) continue;
        const dt = Math.min(now - s.t, EXTRAPOLATE_MAX_MS) / 1000;
        const x = (s.x + s.vx * dt) * frameW;
        const y = (s.y + s.vy * dt) * frameH;
        const w = s.w * frameW;
        const h = s.h * frameH;
        if (els.box) {
          els.box.setAttribute('x', x); els.box.setAttribute('y', y);
          els.box.setAttribute('width', w); els.box.setAttribute('height', h);
        }
        if (els.label) {
          const lh = els.labelH || 0;
          const ly = y > lh + 10 ? y - lh - 8 : y + h + 8;
          els.label.setAttribute('transform', `translate(${x} ${ly})`);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [frameW, frameH]);

  if (!frameW || !frameH) return null;

  const stroke = Math.max(4, frameW / 700);
  // Label sized from the text it holds. The old fixed 180-420px floor made a
  // one-word label wider than the face it belonged to on a distant subject —
  // visible in the screenshot as a chip several times the size of its box.
  const fontSize = Math.max(20, Math.round(frameW / 110));
  const labelH = Math.round(fontSize * 1.55);

  return (
    <svg
      className="absolute inset-0 z-20 h-full w-full pointer-events-none overflow-visible"
      viewBox={`0 0 ${frameW} ${frameH}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {(boxes || []).map((box, index) => {
        const key = String(box.track_id ?? `i${index}`);
        const known = box.name && box.name !== 'Unknown';
        const color = known ? '#10b981' : '#ef4444';
        const gender = normalizeGender(box.gender);
        const label = [box.name || 'Unknown', gender].filter(Boolean).join(' - ');
        const labelW = Math.round(label.length * fontSize * 0.6) + fontSize;

        const setEl = (part) => (el) => {
          const cur = elRef.current.get(key) || { labelH };
          if (el) elRef.current.set(key, { ...cur, [part]: el, labelH });
          else if (cur.box || cur.label) elRef.current.set(key, { ...cur, [part]: null, labelH });
          else elRef.current.delete(key);
        };

        return (
          <g key={key}>
            <rect
              ref={setEl('box')}
              x={0} y={0} width={0} height={0}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              rx={Math.max(8, frameW / 220)}
              vectorEffect="non-scaling-stroke"
            />
            <g ref={setEl('label')}>
              <rect
                x={0} y={0} width={labelW} height={labelH}
                fill={color} rx={Math.max(6, frameW / 300)} opacity="0.95"
              />
              <text
                x={fontSize * 0.5} y={labelH * 0.72}
                fill="white" fontSize={fontSize} fontWeight="700"
                fontFamily="Inter, system-ui, sans-serif"
              >
                {label}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export function ZoneOverlay({ zones, frameW = 1920, frameH = 1080, subtle = false }) {
  const activeZones = normalizeDetectionZones(zones);
  if (!activeZones.length || !frameW || !frameH) return null;
  const stroke = Math.max(3, frameW / 650);
  const labelSize = Math.max(18, frameW / 120);
  return (
    <svg
      className="absolute inset-0 z-[18] h-full w-full pointer-events-none"
      viewBox={`0 0 ${frameW} ${frameH}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {activeZones.map((zone, index) => {
        const color = index === 0 ? ORANGE : '#10b981';
        const label = (lx, ly) => (
          <text
            x={lx}
            y={ly}
            fill="white"
            fontSize={labelSize}
            fontWeight="800"
            fontFamily="Inter, system-ui, sans-serif"
            paintOrder="stroke"
            stroke="rgba(15,23,42,0.8)"
            strokeWidth="5"
          >
            {zone.name}
          </text>
        );

        if (zone.shape === 'line') {
          const [a, b] = zone.points;
          const mx = ((a.x + b.x) / 2) * frameW;
          const my = ((a.y + b.y) / 2) * frameH;
          const n = lineInsideNormal(a, b, zone.side);
          const arrowLen = Math.max(48, frameW / 22);
          const ax = mx + n.x * arrowLen;
          const ay = my + n.y * arrowLen;
          return (
            <g key={zone.id || index}>
              <line
                x1={a.x * frameW} y1={a.y * frameH}
                x2={b.x * frameW} y2={b.y * frameH}
                stroke={color}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={subtle ? '10 8' : 'none'}
                vectorEffect="non-scaling-stroke"
              />
              <line x1={mx} y1={my} x2={ax} y2={ay} stroke={color} strokeWidth={stroke} vectorEffect="non-scaling-stroke" />
              <circle cx={ax} cy={ay} r={stroke * 1.8} fill={color} />
              {label(a.x * frameW + 12, a.y * frameH - 10)}
            </g>
          );
        }

        // box + polygon both render as a filled outline
        const points = zone.points.map((point) => `${point.x * frameW},${point.y * frameH}`).join(' ');
        return (
          <g key={zone.id || index}>
            <polygon
              points={points}
              fill={color}
              fillOpacity={subtle ? 0.08 : 0.13}
              stroke={color}
              strokeWidth={stroke}
              strokeDasharray={subtle ? '10 8' : 'none'}
              vectorEffect="non-scaling-stroke"
            />
            {label(zone.points[0].x * frameW + 12, zone.points[0].y * frameH + 26)}
          </g>
        );
      })}
    </svg>
  );
}

