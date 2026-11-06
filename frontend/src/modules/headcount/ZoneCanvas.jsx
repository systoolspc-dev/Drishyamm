/**
 * ZoneCanvas — the polygon drawing surface, on its own.
 *
 * The component is CONTROLLED — it owns no points. The caller holds the zone
 * it is editing and a surface with an opinion about where the truth lives
 * would have to be fought.
 *
 * Three ways to put a shape down, because zones come in three kinds:
 *
 *   Rectangle  press and drag. Most counting areas are roughly rectangular,
 *              and this is one gesture.
 *   Polygon    click corner by corner; click the first corner (or press
 *              Enter, or double-click) to close. An L-shaped room, a bay that
 *              excludes a doorway.
 *   Freehand   trace the outline. A curved counter, a floor marking. The trace
 *              is simplified to the corners that carry its shape, so what is
 *              left is still adjustable by hand.
 *
 * Every tool hands over to EDIT once the shape is down: drag a node to move
 * it, drag the small handle in the middle of an edge to add a node there,
 * double-click a node to remove it. Edit is its own mode because in a combined
 * one every mis-click while dragging a node added a corner nobody asked for.
 *
 * Drawing with any tool over an existing shape replaces it. Undo (button or
 * Ctrl/Cmd+Z) steps back through whole edits -- a rectangle, a trace, a moved
 * node -- not single points, because that is what the operator did.
 *
 * Points are NORMALISED (0..1), so a zone keeps its meaning at any resolution
 * and survives the camera being re-profiled.
 *
 * `others` draws the OTHER zones on the same view -- outline and name, never
 * editable -- so a second zone is drawn against the first instead of blind.
 * `color` is the active zone's stroke, so it matches the swatch it was picked by.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Eraser, Hexagon, Maximize, MousePointer2, PenLine, Square, Undo2,
} from 'lucide-react';
import { MIN_CORNERS, pointsToSvg, simplifyPath } from './zone-geometry';

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const r4 = (n) => Number(n.toFixed(4));
const round = (pts) => pts.map(([x, y]) => [r4(x), r4(y)]);
const near = (a, b, d = 0.025) => Math.abs(a[0] - b[0]) < d && Math.abs(a[1] - b[1]) < d;

const TOOLS = [
  { id: 'box', label: 'Rectangle', Icon: Square, hint: 'Drag to draw a rectangle' },
  { id: 'polygon', label: 'Polygon', Icon: Hexagon, hint: 'Click each corner · click the first corner to close' },
  { id: 'freehand', label: 'Freehand', Icon: PenLine, hint: 'Hold and trace the outline' },
];
const EDIT = { id: 'adjust', label: 'Edit nodes', Icon: MousePointer2 };

export default function ZoneCanvas({
  points,
  onChange,
  src,
  media = null,
  aspect = '16 / 9',
  toolbar = true,
  footer = true,
  className = '',
  color = 'var(--brand)',
  others = [],
}) {
  const [mode, setMode] = useState(points.length ? 'adjust' : 'box');
  const [cursor, setCursor] = useState(null);      // rubber-band target
  const [dragIdx, setDragIdx] = useState(null);    // node being moved
  const [boxStart, setBoxStart] = useState(null);  // rectangle anchor
  const [boxNow, setBoxNow] = useState(null);
  const [trace, setTrace] = useState(null);        // freehand samples
  const [drawing, setDrawing] = useState(false);   // a polygon is open
  const boxRef = useRef(null);
  // Whole edits to step back through. A ref: pushing to it must not re-render.
  const historyRef = useRef([]);
  const [canUndo, setCanUndo] = useState(false);

  const commit = (next) => {
    historyRef.current = [...historyRef.current.slice(-49), points];
    setCanUndo(true);
    onChange(next);
  };

  const undo = () => {
    const prev = historyRef.current.pop();
    setCanUndo(historyRef.current.length > 0);
    if (prev) onChange(prev);
    setDrawing(false);
  };

  // The key handler reads the current undo without re-subscribing every render.
  const undoRef = useRef(undo);
  useEffect(() => { undoRef.current = undo; });

  const pickMode = (id) => {
    setMode(id);
    setBoxStart(null); setBoxNow(null); setTrace(null); setDrawing(false);
  };
  const finish = () => { setDrawing(false); setMode('adjust'); };

  const at = useCallback((e) => {
    const r = boxRef.current.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  }, []);

  const onDown = (e) => {
    if (dragIdx !== null || e.button > 0) return;
    const p = at(e);
    if (mode === 'box') {
      setBoxStart(p); setBoxNow(p);
    } else if (mode === 'freehand') {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setTrace([p]);
    }
  };

  const onMove = (e) => {
    const p = at(e);
    setCursor(p);
    if (dragIdx !== null) {
      onChange(points.map((q, i) => (i === dragIdx ? [r4(p[0]), r4(p[1])] : q)));
    } else if (boxStart) {
      setBoxNow(p);
    } else if (trace) {
      const last = trace[trace.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.004) setTrace([...trace, p]);
    }
  };

  const onUp = () => {
    if (dragIdx !== null) { setDragIdx(null); return; }
    if (boxStart && boxNow) {
      const [x1, y1] = boxStart;
      const [x2, y2] = boxNow;
      // A click without a drag shouldn't create a sliver.
      if (Math.abs(x2 - x1) > 0.02 && Math.abs(y2 - y1) > 0.02) {
        const [lx, rx] = [Math.min(x1, x2), Math.max(x1, x2)];
        const [ty, by] = [Math.min(y1, y2), Math.max(y1, y2)];
        commit(round([[lx, ty], [rx, ty], [rx, by], [lx, by]]));
        finish();
      }
      setBoxStart(null); setBoxNow(null);
    } else if (trace) {
      const shape = simplifyPath(trace);
      // The trace's two ends are the same place: keep one of them.
      if (shape.length > 3 && near(shape[0], shape[shape.length - 1], 0.03)) shape.pop();
      if (shape.length >= MIN_CORNERS) { commit(round(shape)); finish(); }
      setTrace(null);
    }
  };

  const onClick = (e) => {
    if (mode !== 'polygon' || dragIdx !== null) return;
    const p = at(e);
    if (!drawing) {
      // A new polygon replaces whatever was there.
      commit(round([p]));
      setDrawing(true);
      return;
    }
    if (points.length >= MIN_CORNERS && near(p, points[0])) { finish(); return; }
    // The first click of a double-click (which closes the shape) is not a corner.
    if (near(p, points[points.length - 1], 0.006)) return;
    commit([...points, [r4(p[0]), r4(p[1])]]);
  };

  const onDoubleClick = () => {
    if (mode === 'polygon' && drawing && points.length >= MIN_CORNERS) finish();
  };

  // Ctrl/Cmd+Z undoes the last edit; Enter closes an open polygon; Escape
  // abandons a gesture in progress. Scoped to the window because the surface
  // itself is not focusable -- the operator is drawing with the pointer.
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !typing) {
        e.preventDefault();
        undoRef.current();
      } else if (e.key === 'Enter' && drawing && points.length >= MIN_CORNERS && !typing) {
        e.preventDefault();
        setDrawing(false);
        setMode('adjust');
      } else if (e.key === 'Escape') {
        setBoxStart(null); setBoxNow(null); setTrace(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing, points.length]);

  const preview = useMemo(() => {
    if (!boxStart || !boxNow) return null;
    const [x1, y1] = boxStart;
    const [x2, y2] = boxNow;
    if (Math.abs(x2 - x1) <= 0.02 && Math.abs(y2 - y1) <= 0.02) return null;
    return {
      x: Math.min(x1, x2) * 100, y: Math.min(y1, y2) * 100,
      w: Math.abs(x2 - x1) * 100, h: Math.abs(y2 - y1) * 100,
    };
  }, [boxStart, boxNow]);

  const ready = points.length >= MIN_CORNERS;
  const open = mode === 'polygon' && drawing;
  const editing = mode === 'adjust';
  const tool = TOOLS.find((t) => t.id === mode);
  const btn = (on) => `inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-semibold transition ${
    on ? 'bg-brand-soft text-brand-ink' : 'text-fg-muted hover:bg-surface-sunken hover:text-fg'
  }`;

  return (
    <div className={className}>
      {toolbar ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <div aria-label="Shape tool" className="inline-flex overflow-hidden rounded-lg border border-line" role="group">
            {TOOLS.map((t) => (
              <button aria-pressed={mode === t.id} className={btn(mode === t.id)} key={t.id} onClick={() => pickMode(t.id)} title={t.label} type="button">
                <t.Icon size={13} /> <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
            <button
              aria-pressed={editing}
              className={`${btn(editing)} border-l border-line disabled:opacity-40`}
              disabled={!points.length}
              onClick={() => pickMode('adjust')}
              title="Drag nodes · drag an edge's midpoint to add one · double-click a node to remove it"
              type="button"
            >
              <EDIT.Icon size={13} /> <span className="hidden sm:inline">{EDIT.label}</span>
            </button>
          </div>

          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-fg-muted transition hover:bg-surface-sunken hover:text-fg disabled:opacity-40"
            disabled={!canUndo}
            onClick={undo}
            title="Undo (Ctrl+Z)"
            type="button"
          >
            <Undo2 size={13} /> <span className="hidden md:inline">Undo</span>
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-fg-muted transition hover:border-danger-line hover:bg-danger-soft hover:text-danger-ink disabled:opacity-40"
            disabled={!points.length}
            onClick={() => { commit([]); pickMode('box'); }}
            title="Clear the shape"
            type="button"
          >
            <Eraser size={13} /> <span className="hidden md:inline">Clear</span>
          </button>

          <span className="flex-1" />

          <button
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] text-fg-muted transition hover:bg-surface-sunken hover:text-fg"
            onClick={() => { commit([[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]]); finish(); }}
            type="button"
          >
            <Maximize size={13} /> Whole view
          </button>
        </div>
      ) : null}

      <div
        className={`group relative w-full select-none overflow-hidden rounded-lg bg-black ${
          dragIdx !== null ? 'cursor-grabbing' : editing ? 'cursor-default' : 'cursor-crosshair'
        }`}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onPointerDown={onDown}
        onPointerLeave={() => { setCursor(null); if (!trace) onUp(); }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        ref={boxRef}
        style={{ aspectRatio: aspect, touchAction: 'none' }}
      >
        {/* `media` is any picture of the view (a live player); `src` an image
            URL. Either way it is inert: the pointer belongs to the drawing. */}
        {media ? (
          <div className="pointer-events-none absolute inset-0">{media}</div>
        ) : src ? (
          <img alt="" className="pointer-events-none h-full w-full select-none object-contain" src={src} />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-[12px] text-white/40">
            No camera selected
          </div>
        )}

        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
        >
          {/* Everything outside the area is dimmed, so the zone reads instantly
              rather than having to trace an outline. */}
          {ready && !open ? (
            <>
              <defs>
                <mask id="zone-cut">
                  <rect fill="white" height="100" width="100" x="0" y="0" />
                  <polygon fill="black" points={pointsToSvg(points)} />
                </mask>
              </defs>
              <rect fill="rgba(0,0,0,0.55)" height="100" mask="url(#zone-cut)" width="100" x="0" y="0" />
            </>
          ) : null}

          {others.filter((o) => o.points?.length >= MIN_CORNERS).map((o) => (
            <polygon
              fill={`color-mix(in srgb, ${o.color} 10%, transparent)`}
              key={o.id}
              points={pointsToSvg(o.points)}
              stroke={o.color}
              strokeDasharray="1.6 1.2"
              strokeWidth="0.35"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* An open polygon is a line, not a shape, until it is closed. */}
          {points.length >= 2 && !trace && !preview ? (
            open ? (
              <polyline
                fill="none"
                points={pointsToSvg(points)}
                stroke={color}
                strokeWidth="0.55"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <polygon
                fill={`color-mix(in srgb, ${color} 18%, transparent)`}
                points={pointsToSvg(points)}
                stroke={color}
                strokeWidth="0.55"
                vectorEffect="non-scaling-stroke"
              />
            )
          ) : null}

          {open && points.length > 0 && cursor ? (
            <line
              opacity="0.8"
              stroke={color}
              strokeDasharray="1.5 1.2"
              strokeWidth="0.35"
              vectorEffect="non-scaling-stroke"
              x1={points[points.length - 1][0] * 100}
              x2={cursor[0] * 100}
              y1={points[points.length - 1][1] * 100}
              y2={cursor[1] * 100}
            />
          ) : null}

          {trace && trace.length > 1 ? (
            <polyline
              fill={`color-mix(in srgb, ${color} 14%, transparent)`}
              points={pointsToSvg(trace)}
              stroke={color}
              strokeLinejoin="round"
              strokeWidth="0.55"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {preview ? (
            <rect
              fill={`color-mix(in srgb, ${color} 18%, transparent)`}
              height={preview.h}
              stroke={color}
              strokeDasharray="1.5 1.2"
              strokeWidth="0.45"
              vectorEffect="non-scaling-stroke"
              width={preview.w}
              x={preview.x}
              y={preview.y}
            />
          ) : null}
        </svg>

        {/* Names in a second, unscaled layer: text inside the stretched
            viewBox above would stretch with it. Each sits at its shape's
            highest corner, the way Head Count labels its tiles. */}
        {others.length ? (
          <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
            {others.filter((o) => o.points?.length >= MIN_CORNERS).map((o) => {
              const [lx, ly] = o.points.reduce((a, p) => (p[1] < a[1] ? p : a), o.points[0]);
              return (
                <text
                  dy="-5"
                  fill={o.color}
                  key={o.id}
                  style={{ fontSize: 11, fontWeight: 700, paintOrder: 'stroke', stroke: 'rgba(0,0,0,.85)', strokeWidth: 3 }}
                  x={`${lx * 100}%`}
                  y={`${Math.max(0.04, ly) * 100}%`}
                >
                  {o.name}
                </text>
              );
            })}
          </svg>
        ) : null}

        {/* Edge midpoints: drag one to add a node there. Shown while the
            pointer is over the picture, always on touch screens. */}
        {editing && ready && !trace && dragIdx === null ? points.map((p, i) => {
          const q = points[(i + 1) % points.length];
          const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          return (
            <button
              aria-label="Add a node on this edge"
              className="absolute z-[9] grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-copy place-items-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              key={`mid-${i}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                commit([...points.slice(0, i + 1), round([mid])[0], ...points.slice(i + 1)]);
                setDragIdx(i + 1);
              }}
              style={{ left: `${mid[0] * 100}%`, top: `${mid[1] * 100}%` }}
              title="Drag to add a node here"
              type="button"
            >
              <span className="block h-2 w-2 rounded-full border-2 bg-black/60 transition-transform hover:scale-150" style={{ borderColor: color }} />
            </button>
          );
        }) : null}

        {/* Nodes are real DOM, not SVG, so they keep a constant size and hit
            area whatever the picture's scaling: a 12px dot inside a 24px
            target. The first node of an open polygon is the one that closes it. */}
        {!trace && !preview ? points.map(([x, y], i) => {
          const closer = open && i === 0 && points.length >= MIN_CORNERS;
          return (
            <button
              aria-label={closer ? 'Close the polygon' : `Node ${i + 1}`}
              className={`group/node absolute z-10 grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full ${
                editing ? 'cursor-grab active:cursor-grabbing' : closer ? 'cursor-pointer' : 'pointer-events-none'
              }`}
              key={`n-${i}`}
              onClick={(e) => {
                e.stopPropagation();
                if (closer) finish();
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (editing && points.length > MIN_CORNERS) commit(points.filter((_, j) => j !== i));
              }}
              onPointerDown={(e) => {
                if (!editing) return;
                e.stopPropagation();
                historyRef.current = [...historyRef.current.slice(-49), points];
                setCanUndo(true);
                setDragIdx(i);
              }}
              style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
              title={closer ? 'Click to close the shape' : editing ? 'Drag to move · double-click to remove' : undefined}
              type="button"
            >
              <span
                className={`block h-3 w-3 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.6)] transition-transform duration-150 group-hover/node:scale-150 ${
                  dragIdx === i ? 'scale-150' : ''
                } ${closer ? 'animate-pulse ring-4 ring-white/40' : ''}`}
                style={{ background: color }}
              />
            </button>
          );
        }) : null}

        {/* What the current tool does, on the picture while it matters. */}
        {tool && !preview && !trace && (!points.length || open) ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
            <span className="rounded-lg bg-black/75 px-3 py-1.5 text-[12px] text-white ring-1 ring-white/15">
              {open && points.length >= MIN_CORNERS ? 'Click the first corner, double-click or press Enter to close' : tool.hint}
            </span>
          </div>
        ) : null}
      </div>

      {footer ? (
        <p className="mt-2.5 text-[11.5px] text-fg-muted">
          {points.length === 0
            ? 'No boundary drawn - the whole view counts'
            : ready ? `${points.length} nodes`
              : `${points.length} of ${MIN_CORNERS} nodes minimum`}
        </p>
      ) : null}
    </div>
  );
}
