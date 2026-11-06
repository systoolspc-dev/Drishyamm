/**
 * Restricted access — the model, and the detection logic on top of it.
 *
 * Pure functions. The one thing worth reading before the rest: a person is
 * judged by the NAME the recogniser put on their box, matched against the
 * whitelist. There is no directory service behind this app, so "role" is a
 * label an operator attaches to a name here rather than something fetched and
 * verified. That is a real limitation and the UI says so — a whitelist that
 * silently admitted anyone whose role string happened to match would be worse
 * than one that admits the names it was actually given.
 */

// ── Access modes ────────────────────────────────────────────────────────────
export const ACCESS_MODES = [
  {
    id: 'public',
    label: 'Public / Open',
    blurb: 'All staff and visitors permitted. Counting and capacity rules still apply; nobody is flagged for being here.',
  },
  {
    id: 'restricted',
    label: 'Restricted / Authorized only',
    blurb: 'Only the roles and people on the whitelist below are permitted. Anyone else raises a breach the moment they are recognised.',
  },
  {
    id: 'lockout',
    label: 'Strict lockout (max = 0)',
    blurb: 'Nobody is permitted, whitelist included. Any detected presence is an immediate breach — for a room that should be empty.',
  },
];

export const ACCESS_MODE_BY_ID = Object.fromEntries(ACCESS_MODES.map((m) => [m.id, m]));

/** Starting set of roles. Editable per zone — there is no directory to read. */
export const DEFAULT_ROLES = [
  'IT Dept',
  'Facilities Team',
  'Executive Staff',
  'Security Guards',
];

export const SCHEDULE_MODES = [
  { id: 'always', label: '24/7 access', blurb: 'The whitelist applies around the clock.' },
  { id: 'hours',  label: 'Scheduled hours only', blurb: 'Outside these hours even an authorised person is a breach.' },
];

export function defaultAccess() {
  return {
    mode: 'public',
    roles: [],
    people: [],            // [{ id, name }]
    scheduleMode: 'always',
    scheduleHours: ['09:00', '17:00'],
  };
}

// ── Authorisation ───────────────────────────────────────────────────────────

const norm = (s) => String(s || '').trim().toLowerCase();

/** Names the recogniser emits for a face it could not place. */
const UNKNOWN_LABELS = new Set(['unknown', 'unrecognised', 'unrecognized', 'unidentified', '']);

export const isUnknown = (name) => UNKNOWN_LABELS.has(norm(name));

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
};

/** Is the access schedule open at `at`? `always` is open by definition. */
export function scheduleOpen(access, at = new Date()) {
  if (!access || access.scheduleMode !== 'hours') return true;
  const start = toMinutes(access.scheduleHours?.[0]);
  const end = toMinutes(access.scheduleHours?.[1]);
  if (start == null || end == null) return true;
  const now = at.getHours() * 60 + at.getMinutes();
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

/**
 * Why one detected person is, or is not, allowed to be here.
 *
 * Returns `{ authorized, reason }`. The reason is the sentence shown on the
 * breach row, so it is written for a guard rather than for a log: it says what
 * to do about the person, not which predicate failed.
 */
export function judge(name, access, at = new Date()) {
  const mode = access?.mode || 'public';

  if (mode === 'lockout') {
    return { authorized: false, reason: 'This zone is under strict lockout — nobody is permitted inside' };
  }
  if (mode === 'public') {
    return { authorized: true, reason: 'Open zone' };
  }

  // Restricted from here down.
  if (isUnknown(name)) {
    return { authorized: false, reason: 'Face not recognised — no identity to check against the whitelist' };
  }
  if (!scheduleOpen(access, at)) {
    return {
      authorized: false,
      reason: `Outside the ${access.scheduleHours?.[0]}–${access.scheduleHours?.[1]} access window`,
    };
  }

  const onList = (access.people || []).some((p) => norm(p.name) === norm(name) || norm(p.id) === norm(name));
  if (onList) return { authorized: true, reason: 'On the individual whitelist' };

  // A role grants access when the operator has tagged this person with it.
  const role = (access.people || []).find((p) => norm(p.name) === norm(name))?.role;
  if (role && (access.roles || []).includes(role)) {
    return { authorized: true, reason: `Authorised as ${role}` };
  }

  return { authorized: false, reason: 'Recognised, but not on this zone\'s whitelist' };
}

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * Is a point inside the polygon? Ray casting, on normalised coordinates.
 *
 * A boundary with fewer than three corners is not a boundary, and the honest
 * reading of "no boundary drawn" is "the whole frame is the zone" — the same
 * default the counting area uses.
 */
export function pointInPolygon([x, y], polygon) {
  if (!polygon || polygon.length < 3) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const straddles = (yi > y) !== (yj > y);
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A detection box's anchor point.
 *
 * The FEET, not the centre: a person standing at the edge of a zone has their
 * head outside it and their feet inside, and it is where they are standing that
 * decides whether they are in the room. Centre-point tests make tall people
 * leave zones they are still in.
 */
export function anchorOf(box, frameW, frameH) {
  const w = frameW || 1920;
  const h = frameH || 1080;
  return [((box.x1 + box.x2) / 2) / w, box.y2 / h];
}

// ── Live detections -> the zone's view of who is inside ─────────────────────

/**
 * Classify every detection in a frame against one zone.
 *
 * Returns the boxes with `{ authorized, reason, inside }` attached and, where
 * a breach exists, the shape the breach log and the overlay both read from.
 */
export function classifyFrame({ detections, polygon, access, at = new Date() }) {
  const frameW = detections?.frame_w || 1920;
  const frameH = detections?.frame_h || 1080;

  const boxes = (detections?.boxes || []).map((b) => {
    const inside = pointInPolygon(anchorOf(b, frameW, frameH), polygon);
    const verdict = inside ? judge(b.name, access, at) : { authorized: true, reason: 'Outside the zone' };
    return {
      ...b,
      inside,
      unknown: isUnknown(b.name),
      authorized: verdict.authorized,
      reason: verdict.reason,
      // Normalised, so the overlay can place it without knowing the frame size.
      rect: {
        x: b.x1 / frameW, y: b.y1 / frameH,
        w: (b.x2 - b.x1) / frameW, h: (b.y2 - b.y1) / frameH,
      },
    };
  });

  const insideBoxes = boxes.filter((b) => b.inside);
  const intruders = insideBoxes.filter((b) => !b.authorized);
  const authorised = insideBoxes.filter((b) => b.authorized);

  /**
   * Tailgating: an unidentified person inside the zone at the same moment as an
   * authorised one.
   *
   * This is a DERIVED signal, not an event the platform emits — but it is
   * exactly the shape tailgating has in this data, and it is the one failure a
   * whitelist cannot catch on its own: the door opened legitimately, and
   * somebody who was never checked walked through behind it.
   */
  const tailgating = authorised.length > 0 && intruders.some((b) => b.unknown);

  return { boxes, frameW, frameH, insideBoxes, intruders, authorised, tailgating };
}
