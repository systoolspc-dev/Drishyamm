/**
 * Tests for the "By zone" list.
 *
 * Runs on Node's built-in test runner (`npm test`). The one thing worth
 * reading first: `saved` and `regionZones` answer DIFFERENT questions, and the
 * bug these pin was the rail asking the second one for the first one's answer.
 * buildRegionZones is live-only by design, so a zone nobody is counting is
 * absent from it -- and was therefore absent from a list of what exists. The
 * last test here pins that filter in place, because keeping the headcount
 * panel exactly as it is was the point of fixing the rail instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zoneRows } from './zone-rows.js';
import { buildRegionZones } from '../occupancy-data.js';
import { BROKEN_LABEL, BROKEN_NO_CAMERA, normalizeZones } from '../zone-model.js';

const BOX = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]];

// Inside, then outside, the 09:00-18:00 window both zones below keep.
const DAY = new Date(2026, 0, 5, 9, 30);
const NIGHT = new Date(2026, 0, 5, 23, 30);

/**
 * A site with the two shapes that matter: a lobby somebody is counting, and a
 * server room on a camera with no head-count stream at all -- drawn, named,
 * saved, armed, locked out of hours, and invisible to buildRegionZones.
 */
const SAVED = {
  lobby: {
    id: 'lobby', name: 'Lobby', maxCapacity: 50, cameras: ['m1'], boundaries: { m1: BOX },
  },
  server: {
    id: 'server', name: 'Server room', maxCapacity: 4, cameras: ['m9'], boundaries: { m9: BOX },
    profile: 'restricted', access: { mode: 'lockout' }, offHoursLock: true, hours: ['09:00', '18:00'],
  },
};

const STREAMS = [{ id: 'm1', status: 'online', name: 'Lobby cam', counts: { heads: 12 } }];

const rowsAt = (at, over = {}) => zoneRows({
  saved: SAVED,
  regionZones: buildRegionZones(STREAMS, {}, SAVED, at),
  at,
  ...over,
});

test('a saved zone whose cameras have no head-count stream is still in the list', () => {
  const ids = rowsAt(DAY).map((z) => z.id);
  // The bug: this used to be ['lobby'] only.
  assert.deepEqual(ids, ['lobby', 'server']);

  const server = rowsAt(DAY).find((z) => z.id === 'server');
  assert.equal(server.label, 'Server room');
  assert.equal(server.configured, true);
  // Its own fields, not a live card's: the capacity it was saved with, the
  // profile it was given, and the cameras it is drawn on.
  assert.equal(server.capacity, 4);
  assert.equal(server.subtitle, 'Restricted / Secure Zone');
  assert.deepEqual(server.cameras, ['m9']);
});

test('no count is null -- never 0, which would read as "nobody is in there"', () => {
  const server = rowsAt(DAY).find((z) => z.id === 'server');
  assert.equal(server.count, null);
  assert.notEqual(server.count, 0);
  // And a zone that IS counting an empty room still says 0, which is the
  // distinction the whole row exists to make.
  const empty = zoneRows({
    saved: SAVED,
    regionZones: buildRegionZones([{ id: 'm9', status: 'online', counts: { heads: 0 } }], {}, SAVED, DAY),
    at: DAY,
  }).find((z) => z.id === 'server');
  assert.equal(empty.count, 0);
});

test('an uncounted zone keeps its lock, and does not sort in with the empty ones', () => {
  assert.equal(rowsAt(DAY).find((z) => z.id === 'server').locked, false);
  // Out of hours, with nothing counting it, the lockout still shows. This is
  // the row the rail was losing, so losing its lock instead would be no fix.
  assert.equal(rowsAt(NIGHT).find((z) => z.id === 'server').locked, true);
  // Both are configured, so this is the by-name tier: the count, and the lack
  // of one, have no say in the order.
  assert.deepEqual(rowsAt(NIGHT).map((z) => z.label), ['Lobby', 'Server room']);
});

test('a zone with a live stream is unchanged in label, count, capacity and position', () => {
  const [lobby] = rowsAt(DAY);
  assert.equal(lobby.id, 'lobby');
  assert.equal(lobby.label, 'Lobby');
  assert.equal(lobby.count, 12);
  assert.equal(lobby.capacity, 50);
  assert.equal(lobby.locked, false);
  assert.equal(lobby.configured, true);
  assert.deepEqual(lobby.cameras, ['m1']);
});

test('a counting camera with no zone drawn on it is still listed, and still unconfigured', () => {
  // buildRegionZones gives that camera a whole-view card; it has always been a
  // row here, and nothing in `saved` describes it.
  const streams = [...STREAMS, { id: 'm3', status: 'online', name: 'Dock', counts: { heads: 2 } }];
  const rows = zoneRows({ saved: SAVED, regionZones: buildRegionZones(streams, {}, SAVED, DAY), at: DAY });
  const dock = rows.find((z) => z.id === 'm3');
  assert.equal(dock.configured, false);
  assert.equal(dock.subtitle, 'Not configured');
  assert.equal(dock.count, 2);
  // Unconfigured FIRST, whatever its name -- Number(false) sorts ahead of
  // Number(true). That is the order this list has always had; it is pinned
  // here only so the rebuilt row set cannot quietly change it.
  assert.deepEqual(rows.map((z) => z.id), ['m3', 'lobby', 'server']);
});

test('an unsaved draft appears exactly once, and only while it is unsaved', () => {
  const draft = { id: 'zone-new1', name: 'Store', maxCapacity: 8, cameras: ['m9'] };
  const rows = rowsAt(DAY, { draft });
  assert.deepEqual(rows.filter((z) => z.id === draft.id).length, 1);
  const row = rows.find((z) => z.id === draft.id);
  // Deletable: the rail's `removable` rule is `saved[id] || id === pendingId`,
  // and this row is the pending one.
  assert.equal(row.configured, false);
  assert.equal(row.label, 'Store');
  assert.equal(row.capacity, 8);
  assert.equal(row.count, null);

  // A draft of a zone that IS saved is not pushed a second time: the stored
  // row above already stands for it.
  const editing = { id: 'server', name: 'Server room (renamed)', maxCapacity: 4, cameras: ['m9'] };
  const ids = rowsAt(DAY, { draft: editing }).map((z) => z.id);
  assert.deepEqual(ids, ['lobby', 'server']);

  // Nor is a draft on a camera that already has a whole-view card.
  const onCam = zoneRows({
    saved: SAVED,
    regionZones: buildRegionZones([...STREAMS, { id: 'm3', status: 'online', counts: { heads: 1 } }], {}, SAVED, DAY),
    draft: { id: 'm3', name: '', cameras: ['m3'] },
    at: DAY,
  });
  assert.deepEqual(onCam.filter((z) => z.id === 'm3').length, 1);
});

test('an unnamed draft reads as a new zone rather than blank', () => {
  const row = rowsAt(DAY, { draft: { id: 'zone-new2', name: '', cameras: ['m1'] } })
    .find((z) => z.id === 'zone-new2');
  assert.equal(row.label, 'New zone');
  assert.equal(row.capacity, 0);
});

test('the search matches labels, and keeps the order', () => {
  assert.deepEqual(rowsAt(DAY, { query: 'serv' }).map((z) => z.id), ['server']);
  assert.deepEqual(rowsAt(DAY, { query: '  LOB ' }).map((z) => z.id), ['lobby']);
  assert.deepEqual(rowsAt(DAY, { query: 'zzz' }), []);
  assert.deepEqual(rowsAt(DAY, { query: '' }).map((z) => z.id), ['lobby', 'server']);
});

test('buildRegionZones still drops a zone nothing is counting (the panel is right to)', () => {
  // The headcount panel and every site total read this array, and buildMacro
  // sums `capacity` across it: a zone that can never fill must not be in it.
  // The rail's fix must stay on the rail's side of that line.
  const zones = buildRegionZones(STREAMS, {}, SAVED, DAY);
  assert.deepEqual(zones.map((z) => z.id), ['lobby']);
  assert.equal(zones[0].count, 12);
  assert.equal(zones[0].capacity, 50);
  // Nothing in zoneRows mutates the cards it was handed.
  zoneRows({ saved: SAVED, regionZones: zones, at: DAY });
  assert.deepEqual(zones.map((z) => z.id), ['lobby']);
  assert.equal(zones[0].count, 12);
});

test('a zone with no camera left is LISTED, marked, and not called configured', () => {
  // normalizeZone keeps this record rather than deleting the zone from every
  // surface at once; the rail is the one place it can be seen and removed.
  const saved = normalizeZones({
    ...SAVED,
    'zone-x': { id: 'zone-x', name: 'Orphan', maxCapacity: 9, cameras: [], boundaries: {} },
  });
  const rows = zoneRows({ saved, regionZones: buildRegionZones(STREAMS, {}, saved, DAY), at: DAY });
  const orphan = rows.find((z) => z.id === 'zone-x');
  assert.ok(orphan, 'a zone with no camera must still be listed');
  assert.equal(orphan.label, 'Orphan');
  assert.equal(orphan.broken, BROKEN_NO_CAMERA);
  // It says what is wrong instead of a profile that no longer means anything,
  // and it does not take the green tick a working zone gets.
  assert.equal(orphan.subtitle, BROKEN_LABEL[BROKEN_NO_CAMERA]);
  assert.equal(orphan.configured, false);
  assert.deepEqual(orphan.cameras, []);
  assert.equal(orphan.count, null);

  // Unconfigured sorts first, so the row needing attention is at the top.
  assert.deepEqual(rows.map((z) => z.id), ['zone-x', 'lobby', 'server']);
  // And the working zones are untouched by its presence.
  assert.equal(rows.find((z) => z.id === 'lobby').count, 12);
  assert.equal(rows.find((z) => z.id === 'server').broken, null);
});

// -- WHY a zone is not working --------------------------------------------
//
// The row carries a diagnosis, and the ONLY thing worth pinning about it is
// the ORDER. Several blocks can be true of one zone at once and only the
// first is shown, so these tests set up two at a time on purpose: a camera
// whose AI is off AND an account without the feature, a camera with no
// detector AND its AI off. Pass them in the wrong order and an operator is
// sent to a switch that would change nothing.

// A camera registry, keyed by monitor id, in the shape `GET /ai/cameras`
// returns: `id` is the AI camera id the fix link needs, which is NOT the
// monitor id this map is keyed by.
const REGISTRY = {
  // Counting away: master on, faces producing boxes.
  m1: { id: 'cam-1', ai: { enabled: true, mode: 'detect', faceRecognition: true } },
  // Armed, but the master switch is off.
  m9: { id: 'cam-9', ai: { enabled: false } },
};
const ok = (id) => ({ id, ai: { enabled: true, mode: 'detect', faceRecognition: true } });
const aiOff = (id) => ({ id, ai: { enabled: false } });
// enabled, but parked at mode 'off' -- off by the backend's own rule.
const parked = (id) => ({ id, ai: { enabled: true, mode: 'off', faceRecognition: true } });
// On, and nothing produces boxes: faces off, body detection not opted into.
const blind = (id) => ({ id, ai: { enabled: true, mode: 'detect', faceRecognition: false } });

const FULL = { headcount: true, restricted_zone: true };
const rowFor = (id, over = {}) => zoneRows({
  saved: SAVED,
  regionZones: buildRegionZones(STREAMS, {}, SAVED, DAY),
  at: DAY,
  ...over,
}).find((z) => z.id === id);

test('with no registry and no plan, nothing is diagnosed -- silence, not accusation', () => {
  // A rail rendered before `GET /ai/cameras` and the user have loaded. Saying
  // "Not in your plan" here would tell every customer they had not bought the
  // feature, on every first paint.
  for (const z of rowsAt(DAY)) assert.equal(z.blocked, null);
  // And an EMPTY plan object is "unknown", not "missing": only an explicit
  // false is a plan block.
  assert.equal(rowFor('server', { camByMonitor: REGISTRY, plan: {} }).blocked.code, 'ai-off');
});

test('a plan block comes FIRST, and carries no camera to go and fix', () => {
  // The server room is a no-entry zone on a camera whose AI is also off. Both
  // are true; only the one the operator cannot clear is worth saying.
  const z = rowFor('server', { camByMonitor: REGISTRY, plan: { restricted_zone: false } });
  assert.equal(z.blocked.code, 'plan');
  assert.equal(z.blocked.label, 'Not in your plan');
  // No cameraId => the rail offers no fix link. A button that cannot work is
  // the thing this whole change exists to stop.
  assert.equal(z.blocked.cameraId, null);
});

test('the two plan keys are not interchangeable: each blocks only its own kind of zone', () => {
  const noCounting = { camByMonitor: REGISTRY, plan: { headcount: false, restricted_zone: true } };
  // The lobby only counts, so losing head count blocks it...
  assert.equal(rowFor('lobby', noCounting).blocked.code, 'plan');
  // ...and the no-entry zone is untouched by it: it alarms, it does not count,
  // and its own camera's AI is off, which is what it should say instead.
  assert.equal(rowFor('server', noCounting).blocked.code, 'ai-off');

  const noZones = { camByMonitor: REGISTRY, plan: { headcount: true, restricted_zone: false } };
  assert.equal(rowFor('server', noZones).blocked.code, 'plan');
  assert.equal(rowFor('lobby', noZones).blocked, null);
});

test('AI off names the camera, so the fix link opens the right one', () => {
  const z = rowFor('server', { camByMonitor: REGISTRY, plan: FULL });
  assert.equal(z.blocked.code, 'ai-off');
  assert.equal(z.blocked.label, 'AI is off');
  // The AI camera id from the registry row, not the monitor id 'm9'.
  assert.equal(z.blocked.cameraId, 'cam-9');
});

test("a camera parked at mode 'off' reads as AI off, not as a missing detector", () => {
  // The slip this pins: reading `ai.enabled` alone. The flag is true here, so
  // a naive check calls the AI on, finds no producer and says "nothing is
  // detecting here" -- pointing at the detector switch on a camera whose
  // master switch is the thing that is off.
  const z = rowFor('server', { camByMonitor: { m9: parked('cam-9') }, plan: FULL });
  assert.equal(z.blocked.code, 'ai-off');
  // And on a COUNTING zone, where no-eyes is never checked, the naive version
  // reported nothing at all.
  const lobby = rowFor('lobby', { camByMonitor: { m1: parked('cam-1') }, plan: FULL });
  assert.equal(lobby.blocked.code, 'ai-off');
});

test('an armed zone with no producer says nothing is detecting; a counting one does not', () => {
  const z = rowFor('server', { camByMonitor: { m9: blind('cam-9') }, plan: FULL });
  assert.equal(z.blocked.code, 'no-eyes');
  assert.equal(z.blocked.cameraId, 'cam-9');
  // Head counting runs off the counter, not the face or body producers, so
  // the same camera under a counting zone is not faulted for it.
  const lobby = rowFor('lobby', { camByMonitor: { m1: blind('cam-1') }, plan: FULL });
  assert.equal(lobby.blocked, null);
});

test('body detection alone is enough to feed an armed zone', () => {
  const body = { m9: { id: 'cam-9', ai: { enabled: true, mode: 'detect', faceRecognition: false, zoneBodyDetection: true } } };
  assert.equal(rowFor('server', { camByMonitor: body, plan: FULL }).blocked, null);
});

test('a working camera is not diagnosed at all', () => {
  const z = rowFor('lobby', { camByMonitor: REGISTRY, plan: FULL });
  assert.equal(z.blocked, null);
});

test('a zone whose cameras are not in the registry yet is not diagnosed', () => {
  // Known-unknown: the zone exists, the registry has no row for its camera.
  // Nothing can be said about a camera nobody has described.
  assert.equal(rowFor('server', { camByMonitor: { m1: ok('cam-1') }, plan: FULL }).blocked, null);
});

test('the diagnosis names the FIRST camera with the problem, not a tally', () => {
  // A zone spanning two cameras, the second one off. The operator fixes them
  // one at a time, so the row points at one; a count would say how much is
  // wrong without saying where to start.
  const saved = {
    pair: {
      id: 'pair', name: 'Loading bay', cameras: ['m1', 'm9'], boundaries: { m1: BOX, m9: BOX },
      access: { mode: 'lockout' },
    },
  };
  const rows = zoneRows({
    saved,
    regionZones: [],
    at: DAY,
    camByMonitor: { m1: ok('cam-1'), m9: aiOff('cam-9') },
    plan: FULL,
  });
  assert.equal(rows[0].blocked.code, 'ai-off');
  assert.equal(rows[0].blocked.cameraId, 'cam-9');
});

test('`restricted` is the access mode, not the profile -- and public is not restricted', () => {
  // The server room is saved with access.mode 'lockout'.
  assert.equal(rowFor('server', { camByMonitor: REGISTRY, plan: FULL }).restricted, true);
  // The lobby has no access record at all, as every zone saved before access
  // modes existed does. Absent must NOT read as armed.
  assert.equal(rowFor('lobby', { camByMonitor: REGISTRY, plan: FULL }).restricted, false);

  const open = { open: { id: 'open', name: 'Atrium', cameras: ['m1'], access: { mode: 'public' } } };
  const row = zoneRows({ saved: open, regionZones: [], at: DAY, camByMonitor: REGISTRY, plan: FULL })[0];
  assert.equal(row.restricted, false);
  // A public zone counts, so it is the head-count key that gates it.
  assert.equal(zoneRows({
    saved: open, regionZones: [], at: DAY, camByMonitor: REGISTRY, plan: { headcount: false },
  })[0].blocked.code, 'plan');
});

test('a draft is never diagnosed: nothing is wrong with a zone still being drawn', () => {
  const rows = zoneRows({
    saved: {},
    regionZones: [],
    draft: { id: 'draft-1', name: 'New zone', cameras: ['m9'] },
    at: DAY,
    camByMonitor: { m9: aiOff('cam-9') },
    plan: { headcount: false, restricted_zone: false },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].blocked, null);
  assert.equal(rows[0].restricted, false);
});
