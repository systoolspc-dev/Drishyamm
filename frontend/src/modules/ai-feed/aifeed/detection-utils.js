// Shared geometry + payload normalisers for the AI Feed. Extracted from
// AiFeed.jsx so the zone editor, the overlays and the page all read the same
// definitions instead of each carrying a copy.
export const ORANGE = '#F7983A';
export const EMPTY_DETECTIONS = { boxes: [], frame_w: 1920, frame_h: 1080, running: false };

export function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Detection zones support three shapes the operator can pick from:
//   • 'line'    — a single straight line (2 points). Acts as a directional
//                 boundary: detections on the `side` half-plane are watched.
//   • 'box'     — an axis-aligned rectangle stored as its 4 corner points,
//                 so the point-in-polygon pipeline treats it like any area.
//   • 'polygon' — the original freeform outline (3..24 points).
export const ZONE_SHAPES = ['polygon', 'box', 'line'];
export const SHAPE_MIN_POINTS = { line: 2, box: 4, polygon: 3 };

export function zoneShape(value) {
  return ZONE_SHAPES.includes(value) ? value : 'polygon';
}

export function zoneSide(value) {
  return value === 'right' ? 'right' : 'left';
}

export function normalizeDetectionZones(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 8)
    .map((zone, index) => {
      const shape = zoneShape(zone?.shape);
      let points = (Array.isArray(zone?.points) ? zone.points : [])
        .slice(0, 24)
        .map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }));
      if (points.length < SHAPE_MIN_POINTS[shape]) return null;
      if (shape === 'line') points = points.slice(0, 2);
      const applyTo = Array.isArray(zone?.applyTo)
        ? zone.applyTo.filter((item) => item === 'face' || item === 'person')
        : ['face', 'person'];
      return {
        id: String(zone?.id || `zone-${index + 1}`),
        name: String(zone?.name || `Detection Zone ${index + 1}`).slice(0, 80),
        enabled: zone?.enabled !== false,
        shape,
        side: zoneSide(zone?.side),
        applyTo: applyTo.length ? [...new Set(applyTo)] : ['face', 'person'],
        points,
      };
    })
    .filter(Boolean);
}

export function draftDetectionZones(raw) {
  const zones = Array.isArray(raw) ? raw : [];
  if (!zones.length) {
    return [{
      id: `zone-${Date.now()}`,
      name: 'Detection Zone 1',
      enabled: true,
      shape: 'line',
      side: 'left',
      applyTo: ['face', 'person'],
      points: [],
    }];
  }
  return zones.map((zone, index) => ({
    id: String(zone?.id || `zone-${index + 1}`),
    name: String(zone?.name || `Detection Zone ${index + 1}`).slice(0, 80),
    enabled: zone?.enabled !== false,
    shape: zoneShape(zone?.shape),
    side: zoneSide(zone?.side),
    applyTo: Array.isArray(zone?.applyTo) && zone.applyTo.length ? zone.applyTo : ['face', 'person'],
    points: (Array.isArray(zone?.points) ? zone.points : []).map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) })),
  }));
}

// Unit normal of segment a→b pointing into the active `side` half-plane.
// Matches the pipeline's sign convention: side 'left' is cross >= 0.
export function lineInsideNormal(a, b, side) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // (-dy, dx) points toward the 'left' (cross > 0) half-plane.
  const nx = -dy / len;
  const ny = dx / len;
  return side === 'right' ? { x: -nx, y: -ny } : { x: nx, y: ny };
}

// Expand two drag corners into the 4 ordered corners of an axis-aligned box.
export function boxCorners(a, b) {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

export function normalizeGender(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value === 1 ? 'Male' : 'Female';
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'm' || text === 'male') return 'Male';
  if (text === '0' || text === 'f' || text === 'female') return 'Female';
  return String(value).trim();
}

export function normalizeDetections(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const rawBoxes = Array.isArray(raw.boxes)
    ? raw.boxes
    : Array.isArray(raw.detections)
      ? raw.detections
      : [];
  const boxes = rawBoxes.map((box, index) => {
    const bbox = Array.isArray(box.bbox) ? box.bbox : null;
    const x1 = Number(box.x1 ?? box.left ?? bbox?.[0] ?? 0);
    const y1 = Number(box.y1 ?? box.top ?? bbox?.[1] ?? 0);
    const x2 = Number(box.x2 ?? box.right ?? bbox?.[2] ?? 0);
    const y2 = Number(box.y2 ?? box.bottom ?? bbox?.[3] ?? 0);
    return {
      ...box,
      track_id: box.track_id ?? box.trackId ?? box.id ?? index,
      name: box.name || box.person_name || box.label || 'Unknown',
      conf: Number(box.conf ?? box.score ?? box.det_score ?? 0),
      gender: normalizeGender(box.gender ?? box.sex),
      x1,
      y1,
      x2,
      y2,
    };
  }).filter((box) => box.x2 > box.x1 && box.y2 > box.y1);

  return {
    ...raw,
    boxes,
    frame_w: Number(raw.frame_w ?? raw.frameW ?? raw.width ?? 1920) || 1920,
    frame_h: Number(raw.frame_h ?? raw.frameH ?? raw.height ?? 1080) || 1080,
    running: raw.running === true,
  };
}
