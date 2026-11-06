// Shared constants and helpers for the polygon zone editor.
//
// A plain module rather than exports on ZoneCanvas.jsx: a file that exports
// both components and values breaks Fast Refresh, so the surface stays
// components-only and the maths lives here.

/** Fewer corners than this is not a shape, and is treated as "no boundary". */
export const MIN_CORNERS = 3;

/** Normalised points -> an SVG `points` string in a 0..100 viewBox. */
export const pointsToSvg = (pts) => pts.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');

const segDist = ([px, py], [ax, ay], [bx, by]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/**
 * A traced path -> the few corners that carry its shape (Ramer-Douglas-Peucker).
 * A freehand trace is hundreds of pointer samples; a zone of hundreds of nodes
 * is impossible to adjust and slow to test against, so the trace keeps only
 * the points that move the outline by more than `epsilon` (normalised units).
 */
export function simplifyPath(pts, epsilon = 0.006) {
  if (pts.length < 3) return pts;
  let idx = 0;
  let max = 0;
  const last = pts.length - 1;
  for (let i = 1; i < last; i += 1) {
    const d = segDist(pts[i], pts[0], pts[last]);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= epsilon) return [pts[0], pts[last]];
  const left = simplifyPath(pts.slice(0, idx + 1), epsilon);
  const right = simplifyPath(pts.slice(idx), epsilon);
  return [...left.slice(0, -1), ...right];
}
