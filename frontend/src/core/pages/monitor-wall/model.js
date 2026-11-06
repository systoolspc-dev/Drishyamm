// Monitor Wall — the rules, with no React in them: grid shapes, how cameras
// move between slots, how many streams each recorder will serve, auto fill,
// and the draft that carries an unsaved wall from the editor to the screen.
//
// A layout is { id, name, cols, rows, pages, rotate, rotateSeconds,
// skipOffline, focusAudio }, where each page is an array of cols*rows slots
// holding a camera monitorId or null. The backend validates the same shape.

export const GRID_OPTIONS = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `${n}x${n}`,
  cols: n,
  rows: n,
  label: `${n} × ${n} grid · ${n * n} tile${n === 1 ? '' : 's'}`,
}));

export const ROTATE_OPTIONS = [
  { seconds: 10, label: 'Every 10 seconds' },
  { seconds: 15, label: 'Every 15 seconds' },
  { seconds: 30, label: 'Every 30 seconds' },
  { seconds: 60, label: 'Every minute' },
  { seconds: 120, label: 'Every 2 minutes' },
  { seconds: 300, label: 'Every 5 minutes' },
];

// Streams one recorder can serve at once before it starts dropping cameras.
// On 2026-07-06, 17 concurrent pulls jammed the office Hikvision until it was
// rebooted, and six was the ceiling every NVR was held to. Raised to nine on
// 2026-09-21 (Anil: a 3 x 3 page must fill) once a tile cost one session, not
// two (see SESSIONS_PER_CAMERA) - the office NVR had 16 sessions open that
// day and coped. If a recorder starts dropping cameras again, this is the
// first number to lower.
export const NVR_PULL_LIMIT = 9;

// What one live tile costs its recorder: ONE RTSP session, the sub-stream it
// plays. This was 2 while /stream/start also woke the camera's MAIN stream
// for a grid tile (how a three-camera test wall jammed the office Hikvision
// on 2026-09-11). The backend no longer warms main for quality=low
// (stream.service.js, "NOT for grid tiles"), and on 2026-09-21 the Stream
// Service path list confirmed it: every camera with a grid tile open had its
// `_sub` path pulling and its main path idle. Back to 2 if that regresses.
export const SESSIONS_PER_CAMERA = 1;

// Stream Service keeps pulling a camera for this long after its last viewer
// leaves (sourceOnDemandCloseAfter), so when the wall changes page the
// outgoing page is still being pulled alongside the incoming one.
export const HANDOVER_SECONDS = 20;

export const MAX_PAGES = 12;

// Drag-and-drop payload types: a camera from the library, or a tile's slot.
export const DND_CAMERA = 'application/x-drishyam-camera';
export const DND_SLOT = 'application/x-drishyam-slot';

const DRAFT_KEY = 'monitorWall.draft';

export const blankPage = (cols, rows) => Array(cols * rows).fill(null);

export function newDraft(overrides = {}) {
  const cols = overrides.cols ?? 4;
  const rows = overrides.rows ?? 4;
  return {
    id: null,
    name: 'Untitled wall',
    cols,
    rows,
    pages: [blankPage(cols, rows)],
    rotate: true,
    rotateSeconds: 30,
    skipOffline: false,
    focusAudio: true,
    ...overrides,
  };
}

export function fromLayout(l) {
  return {
    id: l.id,
    name: l.name,
    cols: l.cols,
    rows: l.rows,
    pages: l.pages.map((p) => [...p]),
    rotate: l.rotate,
    rotateSeconds: l.rotateSeconds,
    skipOffline: l.skipOffline,
    focusAudio: l.focusAudio,
  };
}

// The body the API takes (everything but the id).
export function toPayload(d) {
  return {
    name: d.name.trim(),
    cols: d.cols,
    rows: d.rows,
    pages: d.pages.map((p) => p.map((id) => id ?? null)),
    rotate: d.rotate,
    rotateSeconds: d.rotateSeconds,
    skipOffline: d.skipOffline,
    focusAudio: d.focusAudio,
  };
}

export const sameLayout = (a, b) => !!a && !!b && JSON.stringify(toPayload(a)) === JSON.stringify(toPayload(b));

export const cameraIds = (d) => d.pages.flat().filter(Boolean);

export function locate(d, monitorId) {
  for (let page = 0; page < d.pages.length; page++) {
    const slot = d.pages[page].indexOf(monitorId);
    if (slot >= 0) return { page, slot };
  }
  return null;
}

const copyPages = (d) => d.pages.map((p) => [...p]);

// Put a camera in a slot. A camera already on the wall SWAPS with whatever is
// in the target slot, so it never appears twice and nothing silently drops off.
export function place(d, page, slot, monitorId) {
  const pages = copyPages(d);
  const from = locate(d, monitorId);
  if (from) pages[from.page][from.slot] = pages[page][slot] ?? null;
  pages[page][slot] = monitorId;
  return { ...d, pages };
}

export function swapSlots(d, a, b) {
  const pages = copyPages(d);
  const tmp = pages[a.page][a.slot];
  pages[a.page][a.slot] = pages[b.page][b.slot];
  pages[b.page][b.slot] = tmp;
  return { ...d, pages };
}

export function clearSlot(d, page, slot) {
  const pages = copyPages(d);
  pages[page][slot] = null;
  return { ...d, pages };
}

export function clearPage(d, page) {
  const pages = copyPages(d);
  pages[page] = blankPage(d.cols, d.rows);
  return { ...d, pages };
}

export function addPage(d) {
  if (d.pages.length >= MAX_PAGES) return d;
  return { ...d, pages: [...copyPages(d), blankPage(d.cols, d.rows)] };
}

export function removePage(d, page) {
  if (d.pages.length <= 1) return clearPage(d, 0);
  return { ...d, pages: copyPages(d).filter((_, i) => i !== page) };
}

// How many cameras a grid can hold across every page.
export const capacity = (cols, rows) => cols * rows * MAX_PAGES;

// A new grid re-flows the cameras in order into the new page size, so 19
// cameras on 4 × 4 become three pages on 3 × 3 instead of being cut off.
// Callers must not pick a grid whose capacity is below the camera count.
export function resize(d, cols, rows) {
  const size = cols * rows;
  const ids = cameraIds(d);
  const pages = [];
  for (let i = 0; i < Math.max(ids.length, 1); i += size) {
    const page = ids.slice(i, i + size);
    while (page.length < size) page.push(null);
    pages.push(page);
  }
  return { ...d, cols, rows, pages: pages.slice(0, MAX_PAGES) };
}

// First empty slot on `fromPage`, then on the pages after it, then before.
export function firstEmpty(d, fromPage = 0) {
  const order = [...d.pages.keys()].map((i) => (fromPage + i) % d.pages.length);
  for (const page of order) {
    const slot = d.pages[page].indexOf(null);
    if (slot >= 0) return { page, slot };
  }
  return null;
}

// Add a camera wherever it fits: this page, a later page with room, or a new
// page. Returns where it landed, or null when the wall is completely full.
export function addCamera(d, monitorId, fromPage = 0) {
  const existing = locate(d, monitorId);
  if (existing) return { draft: d, at: existing };
  let next = d;
  let at = firstEmpty(d, fromPage);
  if (!at) {
    if (d.pages.length >= MAX_PAGES) return { draft: d, at: null };
    next = addPage(d);
    at = { page: next.pages.length - 1, slot: 0 };
  }
  return { draft: place(next, at.page, at.slot, monitorId), at };
}

// Fill the wall with the online cameras that are not on it yet, in library
// order: the empty tiles of this page first, then the pages after it and
// before it, then fresh pages while cameras are left and the wall is under
// MAX_PAGES. Every empty tile gets a camera - a grid that comes back part
// empty reads as broken, and holding tiles back is not what protects the
// recorders anyway: the wall plays at most NVR_PULL_LIMIT streams per
// recorder on a page and shows the rest as refreshing stills (liveBudget).
export function autoFill(d, page, orderedCameras) {
  const onWall = new Set(cameraIds(d));
  const pages = copyPages(d);
  const queue = orderedCameras.filter((c) => c.status === 'online' && !onWall.has(c.monitorId));
  let next = 0;
  let filled = 0;
  const touched = new Set();

  const fillPage = (p) => {
    for (let slot = 0; slot < pages[p].length && next < queue.length; slot++) {
      if (pages[p][slot]) continue;
      pages[p][slot] = queue[next++].monitorId;
      filled += 1;
      touched.add(p);
    }
  };

  const existing = pages.length;
  for (let i = 0; i < existing && next < queue.length; i++) fillPage((page + i) % existing);
  while (next < queue.length && pages.length < MAX_PAGES) {
    pages.push(blankPage(d.cols, d.rows));
    fillPage(pages.length - 1);
  }

  return { draft: { ...d, pages }, filled, pagesUsed: touched.size, left: queue.length - next };
}

// Is there anything for Auto fill to do: an online camera that is not on the
// wall, and a tile or a page to put it on.
export function autoFillable(d, orderedCameras) {
  if (d.pages.every((p) => !p.includes(null)) && d.pages.length >= MAX_PAGES) return false;
  const onWall = new Set(cameraIds(d));
  return orderedCameras.some((c) => c.status === 'online' && !onWall.has(c.monitorId));
}

// The pages the wall actually plays: empty pages are skipped, and with "skip
// offline" on, offline cameras are left out and the rest close up.
export function playablePages(d, byId) {
  const size = d.cols * d.rows;
  let pages = d.pages;
  if (d.skipOffline) {
    const ids = cameraIds(d).filter((id) => byId.get(id)?.status === 'online');
    pages = [];
    for (let i = 0; i < ids.length; i += size) {
      const page = ids.slice(i, i + size);
      while (page.length < size) page.push(null);
      pages.push(page);
    }
  }
  const nonEmpty = pages.filter((p) => p.some(Boolean));
  return nonEmpty.length ? nonEmpty : [blankPage(d.cols, d.rows)];
}

// What the wall actually asks of each recorder, per recorder:
//   live    - streams it pulls on its busiest page (never past the limit:
//             the wall budgets each page with liveBudget)
//   preview - that page's remaining cameras, shown as refreshing stills
//   peak    - the busiest MOMENT. With rotation on the outgoing page keeps
//             pulling for HANDOVER_SECONDS after a switch, so each page is
//             counted together with the page that follows it; this is the
//             only way a wall can still put a recorder over the limit.
// Only online cameras count - an offline tile has no player.
export function recorderLoad(d, byId) {
  const pages = playablePages(d, byId);
  const playing = pages.map((ids) => liveBudget(ids, byId));
  const handover = d.rotate && pages.length > 1;
  const live = new Map();
  const preview = new Map();
  const peak = new Map();
  const bump = (m, key, n) => m.set(key, Math.max(m.get(key) || 0, n));
  const tally = (ids) => {
    const per = new Map();
    for (const id of ids) {
      const cam = byId.get(id);
      if (cam) per.set(cam.groupId, (per.get(cam.groupId) || 0) + SESSIONS_PER_CAMERA);
    }
    return per;
  };

  pages.forEach((ids, i) => {
    const online = ids.filter((id) => id && byId.get(id)?.status === 'online');
    for (const [g, n] of tally(online.filter((id) => playing[i].has(id)))) bump(live, g, n);
    for (const [g, n] of tally(online.filter((id) => !playing[i].has(id)))) bump(preview, g, n);
    const window = handover ? [...new Set([...playing[i], ...playing[(i + 1) % pages.length]])] : [...playing[i]];
    for (const [g, n] of tally(window)) bump(peak, g, n);
  });

  return { live, preview, peak, handover };
}

// Cameras from /groups, flattened and labelled with their recorder and site.
export function indexCameras(groups = [], sites = []) {
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const cameras = [];
  const groupsById = new Map();
  for (const g of groups) {
    groupsById.set(g.id, g);
    const cams = (g.cameras || []).slice().sort((a, b) => (a.channel || 0) - (b.channel || 0));
    for (const c of cams) {
      cameras.push({
        ...c,
        groupId: g.id,
        groupName: g.name,
        groupHost: g.host,
        location: g.location || '',
        siteId: g.siteId || null,
        siteName: g.siteId ? siteName.get(g.siteId) || null : null,
      });
    }
  }
  return { cameras, byId: new Map(cameras.map((c) => [c.monitorId, c])), groupsById };
}

// The editor's unsaved wall, kept locally so a reload doesn't lose it and so
// "Launch wall" and "Open in new window" can play it before it is saved.
export function isDraftShape(v) {
  if (!v || typeof v !== 'object') return false;
  const okSide = (n) => Number.isInteger(n) && n >= 1 && n <= 6;
  if (!okSide(v.cols) || !okSide(v.rows) || !Array.isArray(v.pages) || !v.pages.length) return false;
  return v.pages.every((p) => Array.isArray(p) && p.length === v.cols * v.rows);
}

export function readLocalDraft() {
  try {
    const v = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return isDraftShape(v) ? newDraft(v) : null;
  } catch {
    return null;
  }
}

export function writeLocalDraft(d) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode */ }
}

// Where the wall plays this layout from: the saved copy when there is nothing
// unsaved, otherwise the local draft. `fs` marks a wall that was LAUNCHED full
// screen, so it can put itself back there after a reload (see MonitorWallLive).
export function wallUrl(d, dirty, fs = false) {
  const base = d.id && !dirty ? `/monitor-wall/live?layout=${encodeURIComponent(d.id)}` : '/monitor-wall/live?draft=1';
  return fs ? `${base}&fs=1` : base;
}

// ── Quick walls ──────────────────────────────────────────────────────────
// A wall built on the spot from the cameras, for an operator who has no
// saved layout (or just wants "everything"). It lives under its own key so
// opening one never overwrites an admin's unsaved draft in the editor.
const QUICK_KEY = 'monitorWall.quick';

export function readQuickDraft() {
  try {
    const v = JSON.parse(localStorage.getItem(QUICK_KEY) || 'null');
    return isDraftShape(v) ? newDraft(v) : null;
  } catch {
    return null;
  }
}

export function writeQuickDraft(d) {
  try { localStorage.setItem(QUICK_KEY, JSON.stringify(d)); } catch { /* private mode */ }
}

// The default wall: every camera, online ones first, on full pages of
// cols × rows. Pages are filled regardless of recorder load — the tiles
// decide live vs still with liveBudget below, so a 3 × 3 never jams an NVR.
// Rotation is OFF: with the 20 s handover two pages pull at once.
export const AUTO_WALL_NAME = 'All cameras';

export function buildAutoWall(cameras, { name = AUTO_WALL_NAME, cols = 3, rows = 3 } = {}) {
  const ids = [
    ...cameras.filter((c) => c.status === 'online'),
    ...cameras.filter((c) => c.status !== 'online'),
  ].map((c) => c.monitorId);
  const size = cols * rows;
  const pages = [];
  for (let i = 0; i < ids.length && pages.length < MAX_PAGES; i += size) {
    const page = ids.slice(i, i + size);
    while (page.length < size) page.push(null);
    pages.push(page);
  }
  return newDraft({ name, cols, rows, pages: pages.length ? pages : [blankPage(cols, rows)], rotate: false, skipOffline: false });
}

// Which cameras on one page get a live player: in slot order, each recorder
// serves at most NVR_PULL_LIMIT streams; the rest are shown as stills.
export function liveBudget(ids, byId) {
  const perGroup = new Map();
  const live = new Set();
  for (const id of ids) {
    const cam = id && byId.get(id);
    if (!cam || cam.status !== 'online') continue;
    const n = (perGroup.get(cam.groupId) || 0) + SESSIONS_PER_CAMERA;
    if (n > NVR_PULL_LIMIT) continue;
    perGroup.set(cam.groupId, n);
    live.add(id);
  }
  return live;
}

// ── Per-user memory ──────────────────────────────────────────────────────
// Which wall this person starred as theirs and the last one they opened,
// kept in this browser until the backend carries a default-for-role field.
const ME_KEY = (uid) => `monitorWall.me.${uid || 'anon'}`;

export function readMe(uid) {
  try {
    const v = JSON.parse(localStorage.getItem(ME_KEY(uid)) || 'null');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function rememberMe(uid, patch) {
  try { localStorage.setItem(ME_KEY(uid), JSON.stringify({ ...readMe(uid), ...patch })); } catch { /* private mode */ }
}

// The screen this page is on, in device pixels: the wall will fill it.
export function displayInfo() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round((window.screen?.width || 1920) * dpr);
  const h = Math.round((window.screen?.height || 1080) * dpr);
  return { w, h, aspect: w / h };
}

export function ago(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

// Built by hand rather than with toLocaleDateString: newer ICU data spells
// September "Sept" in en-GB, and a control-room clock shouldn't change its
// width with the month.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "Fri 11 Sep"
export const shortDate = (d) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;

// "09:41" today, "10 Sep, 09:41" before that.
export function lastSeen(iso) {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return t.toDateString() === new Date().toDateString()
    ? time
    : `${t.getDate()} ${MONTHS[t.getMonth()]}, ${time}`;
}

export const pad2 = (n) => String(n).padStart(2, '0');
