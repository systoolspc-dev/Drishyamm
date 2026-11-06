/**
 * GateCanvas — the counting line over a camera's picture.
 *
 * Its own small surface rather than a mode of ZoneCanvas: a gate is one line
 * segment, and bolting that onto a polygon editor would give it tools --
 * corners, rectangles, undo -- that mean nothing for a line.
 *
 * The line sits at any angle, because doorways are rarely square to the
 * camera:
 *   - drag either END to turn or stretch it;
 *   - drag the LINE itself to move it without changing its angle;
 *   - press anywhere else and drag to draw a new line there.
 * Each end is also a keyboard control (arrows 1%, Shift 5%), because the line
 * has to be placeable without a mouse. Only people crossing between the two
 * ends are counted, so the line should span the doorway and no more.
 *
 * The IN side is shaded, labelled and arrowed, so "which way is in" is read
 * off the picture rather than decoded from the words right_is_in.
 *
 * The camera's zones, if any, are drawn faintly for context only: a gate
 * across a queue zone's mouth is placed against that zone.
 */
import { useCallback, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { pointsToSvg } from '@/modules/headcount/zone-geometry';
import {
  MIN_LENGTH, clampPoint, distToLine, inSidePolygon, lineLength, lineMarkers, moveLine, nudgePoint, orderedLine,
} from '../gate-model';

// Drawn over video, where theme tokens have no say over contrast -- the same
// reasoning as ZONE_COLORS. Amber reads as "a line you should not cross".
const LINE_COLOR = '#FFB703';

/** Within this distance of the line (in picture heights) a press grabs the line instead of drawing. */
const GRAB = 0.03;

const pct = ([x, y]) => ({ left: `${x * 100}%`, top: `${y * 100}%` });

export default function GateCanvas({ line, direction, onChange, media, others = [], label = 'Counting line' }) {
  const boxRef = useRef(null);
  // null | { kind: 'a' | 'b' } | { kind: 'move', start, from } | { kind: 'draw', start }
  const [drag, setDrag] = useState(null);
  const [overLine, setOverLine] = useState(false);

  const at = useCallback((e) => {
    const r = boxRef.current.getBoundingClientRect();
    return clampPoint([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
  }, []);

  const begin = (e, next) => {
    boxRef.current?.setPointerCapture?.(e.pointerId);
    setDrag(next);
  };

  const onDown = (e) => {
    if (e.button > 0) return;
    const p = at(e);
    begin(e, distToLine(p, line) <= GRAB ? { kind: 'move', start: p, from: line } : { kind: 'draw', start: p });
  };

  const onMove = (e) => {
    const p = at(e);
    if (!drag) {
      setOverLine(distToLine(p, line) <= GRAB);
      return;
    }
    let next = null;
    if (drag.kind === 'a' || drag.kind === 'b') next = { ...line, [drag.kind]: p };
    else if (drag.kind === 'move') next = moveLine(drag.from, p[0] - drag.start[0], p[1] - drag.start[1]);
    else next = orderedLine({ a: drag.start, b: p });
    // A press that has not travelled yet leaves the line where it was.
    if (lineLength(next) >= MIN_LENGTH) onChange(next);
  };

  const onUp = () => setDrag(null);

  const onEndKey = (end) => (e) => {
    const p = nudgePoint(line[end], e.key, e.shiftKey);
    if (!p) return;
    e.preventDefault();
    const next = { ...line, [end]: p };
    if (lineLength(next) >= MIN_LENGTH) onChange(next);
  };

  const marks = lineMarkers(line, direction);
  const cursor = drag ? 'cursor-grabbing' : overLine ? 'cursor-move' : 'cursor-crosshair';

  return (
    <div
      className={`relative w-full select-none overflow-hidden rounded-lg bg-black ${cursor}`}
      onPointerCancel={onUp}
      onPointerDown={onDown}
      onPointerLeave={() => setOverLine(false)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      ref={boxRef}
      style={{ aspectRatio: '16 / 9', touchAction: 'none' }}
    >
      {media ? <div className="pointer-events-none absolute inset-0">{media}</div> : (
        <div className="absolute inset-0 grid place-items-center text-body text-white/40">No camera selected</div>
      )}

      <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        {others.filter((o) => o.points?.length >= 3).map((o) => (
          <polygon
            fill="none"
            key={o.id}
            opacity="0.55"
            points={pointsToSvg(o.points)}
            stroke={o.color}
            strokeDasharray="1.2 1.2"
            strokeWidth="0.3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* The IN side, shaded, so the direction is on the picture. */}
        <polygon fill={LINE_COLOR} opacity="0.1" points={pointsToSvg(inSidePolygon(line, direction))} />
        <line
          stroke={LINE_COLOR}
          strokeDasharray="2 1.2"
          strokeLinecap="round"
          strokeWidth={overLine || drag?.kind === 'move' ? '1.1' : '0.7'}
          vectorEffect="non-scaling-stroke"
          x1={line.a[0] * 100}
          x2={line.b[0] * 100}
          y1={line.a[1] * 100}
          y2={line.b[1] * 100}
        />
      </svg>

      {/* Side labels and the arrow in DOM, so they keep their size as the frame scales. */}
      <SideTag at={marks.inAt} isIn />
      <SideTag at={marks.outAt} />
      <span
        aria-hidden
        className="pointer-events-none absolute grid h-6 w-6 place-items-center rounded-full bg-black/80 text-white"
        style={{ ...pct(marks.mid), boxShadow: `0 0 0 2px ${LINE_COLOR}`, transform: `translate(-50%, -50%) rotate(${marks.angle}deg)` }}
      >
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={3} />
      </span>

      <EndHandle
        active={drag?.kind === 'a'}
        at={line.a}
        label={`${label}: first end`}
        onKeyDown={onEndKey('a')}
        onPointerDown={(e) => { e.stopPropagation(); begin(e, { kind: 'a' }); }}
      />
      <EndHandle
        active={drag?.kind === 'b'}
        at={line.b}
        label={`${label}: second end`}
        onKeyDown={onEndKey('b')}
        onPointerDown={(e) => { e.stopPropagation(); begin(e, { kind: 'b' }); }}
      />
    </div>
  );
}

/**
 * One end of the line. Real DOM, not SVG, so it keeps a constant size and hit
 * area whatever the picture's scaling: a 12px dot inside a 24px target.
 */
function EndHandle({ at, label, active, onPointerDown, onKeyDown }) {
  const [x, y] = at;
  return (
    <button
      aria-label={`${label}, ${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down. Arrow keys move it.`}
      className="group/end absolute z-10 grid h-6 w-6 cursor-grab place-items-center rounded-full focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white active:cursor-grabbing"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      style={{ ...pct(at), transform: 'translate(-50%, -50%)' }}
      title="Drag to turn or stretch the line"
      type="button"
    >
      <span
        className={`block h-3 w-3 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.6)] transition-transform duration-150 group-hover/end:scale-150 ${active ? 'scale-150' : ''}`}
        style={{ background: LINE_COLOR }}
      />
    </button>
  );
}

/** "IN side" or "OUT side", either side of the line's middle. */
function SideTag({ at, isIn = false }) {
  return (
    <span
      className="pointer-events-none absolute whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-micro font-bold uppercase"
      style={{ ...pct(at), transform: 'translate(-50%, -50%)', color: isIn ? LINE_COLOR : 'rgba(255,255,255,.7)' }}
    >
      {isIn ? 'IN side' : 'OUT side'}
    </span>
  );
}
