/**
 * Tests for the live-tracking session store. Node's built-in runner:
 *   node --test src/modules/person-tracking/live-session.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accumulate,
  capStore,
  createStore,
  formatAgo,
  groupStops,
  mergeCandidates,
  staleAgeSec,
} from './live-session.js';

const T0 = Date.parse('2026-11-05T10:00:00Z');

// One candidate `sec` seconds after T0 on `cam`.
function cand(id, sec, { cam = 'cam-a', sim = 0.5, track = null } = {}) {
  return {
    appearance_id: id,
    camera_id: cam,
    track_id: track,
    occurred_at: new Date(T0 + sec * 1000).toISOString(),
    similarity: sim,
  };
}

const ids = (store) => [...store.keys()].sort();

// ── mergeCandidates ─────────────────────────────────────────────────────────

test('merge is idempotent', () => {
  const batch = [cand('a', 0), cand('b', 5), cand('c', 10)];
  const once = mergeCandidates(createStore(), batch);
  const twice = mergeCandidates(once, batch);
  assert.deepEqual(ids(twice), ids(once));
  assert.deepEqual([...twice.values()], [...once.values()]);
});

test('merge never shrinks — a record missing from a later poll stays', () => {
  let store = mergeCandidates(createStore(), [cand('a', 0), cand('b', 5)]);
  store = mergeCandidates(store, [cand('c', 900)]);   // window moved on: a, b aged out
  store = mergeCandidates(store, []);                 // an empty poll
  assert.deepEqual(ids(store), ['a', 'b', 'c']);
});

test('merge dedupes by appearance_id and keeps the newer copy', () => {
  let store = mergeCandidates(createStore(), [cand('a', 0, { sim: 0.4 })]);
  store = mergeCandidates(store, [cand('a', 0, { sim: 0.6 }), cand('a', 0, { sim: 0.6 })]);
  assert.equal(store.size, 1);
  assert.equal(store.get('a').similarity, 0.6);
});

test('merge does not mutate its input and skips records without an id', () => {
  const base = mergeCandidates(createStore(), [cand('a', 0)]);
  const next = mergeCandidates(base, [cand('b', 1), { camera_id: 'x' }, null]);
  assert.deepEqual(ids(base), ['a']);
  assert.deepEqual(ids(next), ['a', 'b']);
});

test('merge keys numeric and string ids the same way', () => {
  const store = mergeCandidates(mergeCandidates(createStore(), [cand(7, 0)]), [cand('7', 0)]);
  assert.equal(store.size, 1);
});

// ── groupStops ──────────────────────────────────────────────────────────────

test('stops split on a gap over the window, per camera, joined by track_id', () => {
  const stops = groupStops([
    cand('a', 0), cand('b', 20), cand('c', 100),             // cam-a: 2 stops
    cand('d', 0, { cam: 'cam-b', track: 't1' }),
    cand('e', 300, { cam: 'cam-b', track: 't1' }),            // same track: 1 stop
  ]);
  const shape = stops.map((s) => s.map((c) => c.appearance_id).join('')).sort();
  assert.deepEqual(shape, ['ab', 'c', 'de']);
});

// ── capStore ────────────────────────────────────────────────────────────────

test('cap is a no-op under the limit', () => {
  const store = mergeCandidates(createStore(), [cand('a', 0), cand('b', 1)]);
  assert.equal(capStore(store, 5), store);
});

test('cap drops the oldest unprotected records first', () => {
  // One stop, a record every second. Best is in the middle.
  const batch = Array.from({ length: 10 }, (_, i) => cand(`r${i}`, i, { sim: i === 5 ? 0.9 : 0.5 }));
  const capped = capStore(mergeCandidates(createStore(), batch), 6);
  assert.equal(capped.size, 6);
  assert.deepEqual(ids(capped), ['r0', 'r5', 'r6', 'r7', 'r8', 'r9']);
});

test('cap keeps first, last and best of every stop, and the stop count', () => {
  const batch = [];
  for (let s = 0; s < 3; s += 1) {
    const cam = `cam-${s}`;
    for (let i = 0; i < 20; i += 1) batch.push(cand(`${cam}-${i}`, s * 1000 + i, { cam, sim: i === 7 ? 0.9 : 0.5 }));
  }
  const store = mergeCandidates(createStore(), batch);
  const capped = capStore(store, 9);
  assert.equal(capped.size, 9);
  for (let s = 0; s < 3; s += 1) {
    for (const i of [0, 7, 19]) assert.ok(capped.has(`cam-${s}-${i}`), `cam-${s}-${i} kept`);
  }
  assert.equal(groupStops([...capped.values()]).length, groupStops([...store.values()]).length);
});

test('cap never splits a stop by opening a gap wider than the window', () => {
  // Records every 20 s: dropping any one leaves a 40 s hole > 30 s window.
  const batch = Array.from({ length: 6 }, (_, i) => cand(`r${i}`, i * 20));
  const store = mergeCandidates(createStore(), batch);
  const capped = capStore(store, 2);
  assert.equal(capped.size, 6);   // all protected: stay over the cap rather than split
  assert.equal(groupStops([...capped.values()]).length, 1);
});

test('cap does not mutate its input', () => {
  const store = mergeCandidates(createStore(), Array.from({ length: 10 }, (_, i) => cand(`r${i}`, i)));
  capStore(store, 3);
  assert.equal(store.size, 10);
});

test('accumulate stays idempotent with the cap applied', () => {
  const batch = Array.from({ length: 50 }, (_, i) => cand(`r${i}`, i));
  const once = accumulate(createStore(), batch, 10);
  const twice = accumulate(once, [], 10);
  assert.deepEqual(ids(twice), ids(once));
  assert.equal(once.size, 10);
});

// ── staleness ───────────────────────────────────────────────────────────────

test('a stop is stale only once its newest record leaves the live window', () => {
  const windowMs = 15 * 60_000;
  const newest = new Date(T0).toISOString();
  assert.equal(staleAgeSec(newest, T0 + 14 * 60_000, windowMs), null);
  assert.equal(staleAgeSec(newest, T0 + 20 * 60_000, windowMs), 1200);
  assert.equal(staleAgeSec('not a date', T0, windowMs), null);
});

test('formatAgo reads as minutes', () => {
  assert.equal(formatAgo(45), '45s');
  assert.equal(formatAgo(16 * 60 + 30), '16 min');
  assert.equal(formatAgo(125 * 60), '2h 5m');
});
