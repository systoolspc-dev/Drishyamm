/**
 * Tests for the zone <-> camera model.
 *
 * Runs on Node's built-in test runner (`npm test`). The model is pure so the
 * rules that decide a zone's count, what each camera is told, and when a save
 * is refused can be checked as plain tables, without the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cameraPayload, colorsOnCamera, countOn, normalizeZone, normalizeZones, zoneProblems, zonesOnCamera,
} from './zone-model.js';
import { buildRegionZones } from './occupancy-data.js';

const BOX = [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]];
const BOX2 = [[0.5, 0.5], [0.9, 0.5], [0.9, 0.9], [0.5, 0.9]];

test('a record saved before the model keeps its key, its shape, and only the camera it was counted from', () => {
  const z = normalizeZone('cam-a', { monitorId: 'cam-a', cameras: ['cam-a', 'cam-b'], boundary: BOX, name: 'Lobby' });
  assert.equal(z.id, 'cam-a');
  assert.deepEqual(z.cameras, ['cam-a']);
  assert.deepEqual(z.boundaries, { 'cam-a': BOX });
});

test('a new-model record is kept as stored', () => {
  const z = normalizeZone('zone-1', { id: 'zone-1', cameras: ['a', 'b'], boundaries: { a: BOX, b: BOX2 } });
  assert.deepEqual(z.cameras, ['a', 'b']);
  assert.equal(z.monitorId, 'a');
  assert.deepEqual(z.boundary, BOX);
});

test('zones on a camera come back in a stable order, so colours do not move on rename', () => {
  const zones = normalizeZones({
    'zone-b': { id: 'zone-b', name: 'Aaa', cameras: ['m'], boundaries: { m: BOX } },
    'zone-a': { id: 'zone-a', name: 'Zzz', cameras: ['m'], boundaries: { m: BOX2 } },
  });
  assert.deepEqual(zonesOnCamera(zones, 'm').map((z) => z.id), ['zone-a', 'zone-b']);
  const c = colorsOnCamera(zones, 'm');
  assert.notEqual(c['zone-a'], c['zone-b']);
});

test('camera payload: a lone single-camera zone arms the camera limit; shared cameras do not', () => {
  const solo = normalizeZones({ z: { id: 'z', name: 'Z', maxCapacity: 12, cameras: ['m'], boundaries: { m: BOX } } });
  assert.equal(cameraPayload(solo, 'm').threshold, 12);
  assert.equal(cameraPayload(solo, 'm').zones.length, 1);

  const shared = normalizeZones({
    z1: { id: 'z1', name: 'Queue', maxCapacity: 12, cameras: ['m'], boundaries: { m: BOX } },
    z2: { id: 'z2', name: 'Desk', maxCapacity: 4, cameras: ['m'], boundaries: { m: BOX2 } },
  });
  const p = cameraPayload(shared, 'm');
  assert.equal(p.threshold, 0);
  assert.deepEqual(p.zones.map((z) => z.name), ['Queue', 'Desk']);

  const spanning = normalizeZones({ h: { id: 'h', name: 'Hall', maxCapacity: 200, cameras: ['a', 'b'], boundaries: { a: BOX, b: BOX2 } } });
  assert.equal(cameraPayload(spanning, 'a').threshold, 0);
  assert.equal(cameraPayload(spanning, 'b').zones[0].points, BOX2);
});

test('count: whole view, per-zone breakdown by id or name, and no double counting on a shared camera', () => {
  const stream = { id: 'm', counts: { heads: 9 }, zone_counts: { z1: 3, Desk: 2 } };
  const solo = normalizeZones({ z: { id: 'z', name: 'Z', cameras: ['m'], boundaries: { m: [] } } });
  assert.equal(countOn(stream, solo.z, solo), 9);

  const shared = normalizeZones({
    z1: { id: 'z1', name: 'Queue', cameras: ['m'], boundaries: { m: BOX } },
    z2: { id: 'z2', name: 'Desk', cameras: ['m'], boundaries: { m: BOX2 } },
    z3: { id: 'z3', name: 'Lost', cameras: ['m'], boundaries: { m: BOX2 } },
  });
  assert.equal(countOn(stream, shared.z1, shared), 3);
  assert.equal(countOn(stream, shared.z2, shared), 2);
  assert.equal(countOn(stream, shared.z3, shared), 0);
});

test('a zone spanning two cameras sums its slices; cameras in a zone lose their whole-view card', () => {
  const streams = [
    { id: 'a', status: 'online', counts: { heads: 5 }, zone_counts: { hall: 4 } },
    { id: 'b', status: 'online', counts: { heads: 7 }, zone_counts: { hall: 6 } },
    { id: 'c', status: 'online', counts: { heads: 2 } },
  ];
  const rooms = { hall: { id: 'hall', name: 'Hall', maxCapacity: 20, cameras: ['a', 'b'], boundaries: { a: BOX, b: BOX2 } } };
  const zones = buildRegionZones(streams, {}, rooms);
  const hall = zones.find((z) => z.id === 'hall');
  assert.equal(hall.count, 10);
  assert.deepEqual(hall.cameraIds, ['a', 'b']);
  assert.deepEqual(zones.map((z) => z.id).sort(), ['c', 'hall']);
});

test('save is refused for the cases that would count wrong', () => {
  const saved = normalizeZones({
    whole: { id: 'whole', name: 'Lobby', cameras: ['m'], boundaries: { m: [] } },
  });
  const draft = { id: 'new', name: 'lobby', cameras: ['m'], boundaries: { m: [] } };
  const problems = zoneProblems(draft, saved);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /already called/);
  assert.match(problems[1], /draw this zone's boundary/);
  assert.match(problems[2], /covers the whole of m/);

  const fine = zoneProblems({ id: 'new', name: 'Queue', cameras: ['m'], boundaries: { m: BOX } },
    normalizeZones({ z: { id: 'z', name: 'Lobby', cameras: ['m'], boundaries: { m: BOX2 } } }));
  assert.deepEqual(fine, []);
});
