/**
 * Gates — cameras that count people crossing a line.
 *
 * A gate is not a zone. A zone counts who is standing inside a shape; a gate
 * counts who walked across a line, IN or OUT. The footfall service owns the
 * gate config and is the only place it is stored:
 *
 *   read  (footfallCameras)      footfall_enabled, line, direction,
 *                                camera_id (the service's UUID),
 *                                camera_code (the monitorId used everywhere else)
 *   write (footfallPutConfig)    enabled, line, direction -- merged
 *                                server-side, so only changed fields are sent
 *
 * Note the asymmetry: the switch reads back as `footfall_enabled` but is
 * written as `enabled`. Taken from the footfall page that shipped before this
 * one and wrote the same endpoint.
 *
 * The line is a SEGMENT at any angle: `{ a: [x, y], b: [x, y] }`, normalised
 * to the picture (0,0 top-left, 1,1 bottom-right). Only people crossing
 * between a and b count, so a short line across one doorway ignores people
 * walking past its ends. `direction` says which side is IN, relative to a->b
 * as seen on screen: `right_is_in` or `left_is_in`. For a line drawn left to
 * right, right is below it.
 *
 * Gates saved before the line could turn read back with `line_y_frac` and
 * `down_is_in` / `up_is_in`; those become a full-width level line, which is
 * exactly what the service counted on.
 *
 * Pure, with no imports, so it runs under `node --test`.
 */

/** Shorter than this (normalised) and the service refuses the line: it cannot be told from a point. */
export const MIN_LENGTH = 0.03;
/** Where a new gate's line starts: across the picture a bit below centre, both ends on screen. */
export const DEFAULT_LINE = Object.freeze({ a: [0.1, 0.6], b: [0.9, 0.6] });
export const DEFAULT_DIRECTION = 'right_is_in';
/** The editor draws the picture at 16:9; angles and arrows are worked out on that shape. */
export const FRAME_ASPECT = 16 / 9;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round4 = (n) => Number(n.toFixed(4));

export const clampPoint = ([x, y]) => [round4(clamp01(x)), round4(clamp01(y))];

export const lineLength = ({ a, b }) => Math.hypot(b[0] - a[0], b[1] - a[1]);

const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(Number(n)));

/** A line the service can store, or `fallback` when this one is malformed or too short. */
export function clampLine(line, fallback = DEFAULT_LINE) {
  if (!line || !isPoint(line.a) || !isPoint(line.b)) return fallback;
  const out = { a: clampPoint(line.a.map(Number)), b: clampPoint(line.b.map(Number)) };
  return lineLength(out) < MIN_LENGTH ? fallback : out;
}

export const sameLine = (l1, l2) => (
  l1.a[0] === l2.a[0] && l1.a[1] === l2.a[1] && l1.b[0] === l2.b[0] && l1.b[1] === l2.b[1]
);

export const flipDirection = (d) => (d === 'left_is_in' ? 'right_is_in' : 'left_is_in');

/** +1 when IN is the right of a->b, -1 when it is the left. */
export const inSign = (d) => (d === 'left_is_in' ? -1 : 1);

/** Cross product of a->b with p: positive on the right of a->b (screen y grows down). */
const cross = ({ a, b }, [x, y]) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);

/** A footfall row's line: `line` when it has one, else the old level line at `line_y_frac`. */
export function lineFromCamera(c) {
  if (c?.line) return clampLine(c.line);
  if (c?.line_y_frac != null && Number.isFinite(Number(c.line_y_frac))) {
    const y = round4(Math.min(0.95, Math.max(0.05, Number(c.line_y_frac))));
    return { a: [0, y], b: [1, y] };
  }
  return DEFAULT_LINE;
}

/** A footfall row's direction. The old down/up values are read relative to the line's own a->b. */
export function directionFromCamera(c, line) {
  const d = c?.direction;
  if (d === 'right_is_in' || d === 'left_is_in') return d;
  if (d === 'down_is_in' || d === 'up_is_in') {
    const downIsRight = line.b[0] - line.a[0] >= 0;
    return (d === 'down_is_in') === downIsRight ? 'right_is_in' : 'left_is_in';
  }
  return DEFAULT_DIRECTION;
}

/**
 * Keyboard nudge for one end of the line. Arrows move it 1% (Shift 5%).
 * Returns null for keys it does not handle.
 */
export function nudgePoint(p, key, shift = false) {
  const step = shift ? 0.05 : 0.01;
  const [x, y] = p;
  if (key === 'ArrowLeft') return clampPoint([x - step, y]);
  if (key === 'ArrowRight') return clampPoint([x + step, y]);
  if (key === 'ArrowUp') return clampPoint([x, y - step]);
  if (key === 'ArrowDown') return clampPoint([x, y + step]);
  return null;
}

/**
 * A freshly drawn line, a = its left end (top end if upright). Which way the
 * stroke went should not decide which side is IN: with this order
 * `right_is_in` is below the line, whichever way it was drawn. Dragging an
 * end keeps a and b as they are, so the IN side turns with the line.
 */
export function orderedLine({ a, b }) {
  const swap = a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  return swap ? { a: b, b: a } : { a, b };
}

/** The whole line moved by (dx, dy), stopped at the picture's edge so it keeps its length and angle. */
export function moveLine(line, dx, dy) {
  const xs = [line.a[0], line.b[0]];
  const ys = [line.a[1], line.b[1]];
  const mx = Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), dx));
  const my = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), dy));
  return { a: clampPoint([line.a[0] + mx, line.a[1] + my]), b: clampPoint([line.b[0] + mx, line.b[1] + my]) };
}

/**
 * Distance from p to the segment, measured on the 16:9 picture (in units of
 * its height), so "close to the line" means the same thing at every angle.
 */
export function distToLine(p, { a, b }, aspect = FRAME_ASPECT) {
  const [px, py] = [p[0] * aspect, p[1]];
  const [ax, ay] = [a[0] * aspect, a[1]];
  const [bx, by] = [b[0] * aspect, b[1]];
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The IN side as a polygon in the unit square: the picture cut by the line
 * (extended edge to edge), keeping the side that is IN. For shading only --
 * the count itself is limited to the segment.
 */
export function inSidePolygon(line, direction) {
  const s = inSign(direction);
  const f = (p) => s * cross(line, p);
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const out = [];
  for (let i = 0; i < square.length; i += 1) {
    const p = square[i];
    const q = square[(i + 1) % square.length];
    const fp = f(p);
    const fq = f(q);
    if (fp >= 0) out.push(p);
    // Strict sign change only: a corner ON the line is already pushed above.
    if ((fp > 0 && fq < 0) || (fp < 0 && fq > 0)) {
      const t = fp / (fp - fq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

/**
 * Where to draw the IN arrow and the side labels. The arrow sits at the
 * line's midpoint pointing into the IN side; `angle` is in degrees for a CSS
 * rotate of an arrow that points right (clockwise positive, as on screen).
 * Worked out on the 16:9 picture so the arrow looks square to the line.
 */
export function lineMarkers(line, direction, aspect = FRAME_ASPECT, offset = 0.09) {
  const s = inSign(direction);
  const dX = (line.b[0] - line.a[0]) * aspect;
  const dY = line.b[1] - line.a[1];
  const len = Math.hypot(dX, dY) || 1;
  // Right-hand normal of a->b on screen, flipped to the IN side.
  const nX = (-dY / len) * s;
  const nY = (dX / len) * s;
  const mid = [(line.a[0] + line.b[0]) / 2, (line.a[1] + line.b[1]) / 2];
  const at = (k) => [
    Math.min(0.95, Math.max(0.05, mid[0] + (nX * offset * k) / aspect)),
    Math.min(0.95, Math.max(0.05, mid[1] + nY * offset * k)),
  ];
  return {
    mid,
    angle: (Math.atan2(nY, nX) * 180) / Math.PI,
    inAt: at(1),
    outAt: at(-1),
  };
}

/** The line's slope on the picture, 0..179 degrees (0 = level, 90 = upright). */
export function lineAngle(line, aspect = FRAME_ASPECT) {
  const deg = (Math.atan2(-(line.b[1] - line.a[1]), (line.b[0] - line.a[0]) * aspect) * 180) / Math.PI;
  return Math.round(((deg % 180) + 180) % 180) % 180;
}

/**
 * "level line", "upright line" or "tilted 35°" (from level, either way -- the
 * glyph beside it shows which), for a one-line description.
 */
export function describeLine(line) {
  const deg = lineAngle(line);
  const tilt = deg <= 90 ? deg : 180 - deg;
  if (tilt <= 2) return 'level line';
  if (tilt >= 88) return 'upright line';
  return `tilted ${tilt}°`;
}

/** One footfall camera row -> the gate the editor works with. */
export function gateFromCamera(c) {
  const inCount = Number(c?.today?.in) || 0;
  const outCount = Number(c?.today?.out) || 0;
  const line = lineFromCamera(c);
  return {
    monitorId: c.camera_code,
    cameraId: c.camera_id,
    name: c.camera_name || '',
    enabled: Boolean(c.footfall_enabled),
    line,
    direction: directionFromCamera(c, line),
    in: inCount,
    out: outCount,
    net: inCount - outCount,
  };
}

/**
 * monitorId -> gate, for every camera the footfall service knows about --
 * counting or not. Cameras it has never seen are simply absent: they cannot be
 * configured until the service registers them, and the editor says so.
 */
export function gatesByMonitor(footfall) {
  const out = {};
  for (const c of footfall?.cameras || []) {
    if (c?.camera_code && c?.camera_id) out[c.camera_code] = gateFromCamera(c);
  }
  return out;
}

/**
 * The write body: only what changed. The service merges, so sending an
 * unchanged field would at best do nothing and at worst overwrite an edit made
 * elsewhere in the meantime. Line and direction travel together, though:
 * which side is IN means nothing without the a->b it is measured against.
 */
export function gatePatch(before, after) {
  const body = {};
  if (Boolean(after.enabled) !== Boolean(before.enabled)) body.enabled = Boolean(after.enabled);
  const line = clampLine(after.line);
  if (!sameLine(line, clampLine(before.line)) || after.direction !== before.direction) {
    body.line = line;
    body.direction = after.direction;
  }
  return body;
}
