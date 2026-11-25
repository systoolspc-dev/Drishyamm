// Pure helpers for Click to track (I-3). Tested in journey-model.test.js.

/**
 * A click on an object-fit: contain <video> → a point on the 0-1000 grid of the
 * PICTURE (not the element: letterbox bars are outside the picture). null when
 * the click landed on a bar.
 */
export function clickToGrid({ left, top, width, height }, videoW, videoH, clientX, clientY) {
  if (!width || !height || !videoW || !videoH) return null;
  const scale = Math.min(width / videoW, height / videoH);
  const pw = videoW * scale;
  const ph = videoH * scale;
  const ox = left + (width - pw) / 2;
  const oy = top + (height - ph) / 2;
  const x = (clientX - ox) / pw;
  const y = (clientY - oy) / ph;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.round(x * 1000), y: Math.round(y * 1000) };
}

export const STATUS_LABEL = {
  seed: 'You picked',
  confirmed: 'Confirmed',
  same_face: 'Same face',
  likely: 'Likely',
  possible: 'Possible',
};

/** Proposed sightings split for display: likely first, then possible, each by time. */
export function groupCandidates(candidates = []) {
  const by = (s) => candidates.filter((c) => c.status === s);
  return { likely: by('likely'), possible: by('possible') };
}

/** "walked together · 3 min" / "together · 12 s" */
export function togetherLabel(seconds, objectClass) {
  const s = Math.round(Number(seconds) || 0);
  const span = s >= 90 ? `${Math.round(s / 60)} min` : `${s} s`;
  return `${objectClass === 'vehicle' ? 'near this vehicle' : 'together'} · ${span}`;
}

/** "Camera Gate2 → Lobby → Parking" */
export function routeLabel(route = []) {
  return route.join(' → ');
}

/** Minutes between the first and last stop, for "… over 12 min". */
export function spanMinutes(stops = []) {
  if (stops.length < 2) return 0;
  const a = new Date(stops[0].first_seen).getTime();
  const b = new Date(stops[stops.length - 1].last_seen).getTime();
  return Math.max(0, Math.round((b - a) / 60_000));
}

/**
 * Click to track's "pick someone" list. Asks the index's status FIRST: with the
 * index switched off there is nobody to pick, so it never searches (a search
 * would only fail) and says so instead.
 *
 * @param {{ status: () => Promise<{enabled?: boolean}>, search: (a: object) => Promise<{results?: object[]}> }} svc
 * @returns {Promise<{ indexOff: boolean, people: object[] | null }>}
 */
export async function loadRecentPeople(svc, limit = 30) {
  const st = await svc.status();
  if (!st || st.enabled !== true) return { indexOff: true, people: null };
  const d = await svc.search({ q: 'a person', topK: 60 });
  const people = [...(d?.results || [])]
    .sort((a, b) => new Date(b.first_seen) - new Date(a.first_seen))
    .slice(0, limit);
  return { indexOff: false, people };
}
