/**
 * Tests for the Monitor Wall rules: slot moves, re-flow, auto fill, and the
 * per-recorder stream budget that keeps a wall from jamming an NVR.
 *
 * Runs on Node's built-in test runner (`npm test`). model.js has no imports;
 * the localStorage / window helpers are not exercised here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PAGES, NVR_PULL_LIMIT, SESSIONS_PER_CAMERA,
  addCamera, addPage, autoFill, autoFillable, blankPage, buildAutoWall, cameraIds, capacity,
  clearSlot, firstEmpty, fromLayout, indexCameras, isDraftShape, liveBudget, locate, newDraft,
  place, playablePages, recorderLoad, removePage, resize, sameLayout, swapSlots, toPayload, wallUrl,
} from './model.js';

const cam = (monitorId, groupId = 'g1', status = 'online') => ({ monitorId, groupId, status });
const byIdOf = (cams) => new Map(cams.map((c) => [c.monitorId, c]));

test('newDraft: a 4 x 4 single blank page by default; overrides win', () => {
  const d = newDraft();
  assert.equal(d.cols, 4);
  assert.equal(d.pages.length, 1);
  assert.deepEqual(d.pages[0], blankPage(4, 4));
  assert.equal(newDraft({ cols: 2, rows: 2 }).pages[0].length, 4);
});

test('place: a camera already on the wall swaps with the target slot (never appears twice)', () => {
  const d = newDraft({ cols: 2, rows: 1, pages: [['a', 'b']] });
  const next = place(d, 0, 1, 'a');
  assert.deepEqual(next.pages[0], ['b', 'a']);
  assert.equal(cameraIds(next).filter((id) => id === 'a').length, 1);
});

test('place: dropping a camera on an empty slot moves it there and frees its old slot', () => {
  const d = newDraft({ cols: 2, rows: 1, pages: [['a', null]] });
  assert.deepEqual(place(d, 0, 1, 'a').pages[0], [null, 'a']);
});

test('place: a new camera on a taken slot replaces it and does not mutate the input', () => {
  const d = newDraft({ cols: 2, rows: 1, pages: [['a', 'b']] });
  const next = place(d, 0, 0, 'c');
  assert.deepEqual(next.pages[0], ['c', 'b']);
  assert.deepEqual(d.pages[0], ['a', 'b']);
});

test('swapSlots works across pages; clearSlot empties one slot', () => {
  const d = newDraft({ cols: 1, rows: 1, pages: [['a'], ['b']] });
  const s = swapSlots(d, { page: 0, slot: 0 }, { page: 1, slot: 0 });
  assert.deepEqual(s.pages, [['b'], ['a']]);
  assert.deepEqual(clearSlot(s, 1, 0).pages, [['b'], [null]]);
});

test('addPage stops at MAX_PAGES', () => {
  let d = newDraft({ cols: 1, rows: 1 });
  for (let i = 0; i < MAX_PAGES + 3; i++) d = addPage(d);
  assert.equal(d.pages.length, MAX_PAGES);
});

test('removePage on the last page clears it instead of leaving a wall with no pages', () => {
  const d = newDraft({ cols: 1, rows: 1, pages: [['a']] });
  assert.deepEqual(removePage(d, 0).pages, [[null]]);
  const two = newDraft({ cols: 1, rows: 1, pages: [['a'], ['b']] });
  assert.deepEqual(removePage(two, 0).pages, [['b']]);
});

test('resize re-flows cameras in order instead of cutting them off', () => {
  const ids = Array.from({ length: 19 }, (_, i) => `c${i}`);
  const d = newDraft({ cols: 4, rows: 4, pages: [ids.slice(0, 16), [...ids.slice(16), ...Array(13).fill(null)]] });
  const r = resize(d, 3, 3);
  assert.equal(r.pages.length, 3);
  assert.deepEqual(cameraIds(r), ids);
  assert.ok(r.pages.every((p) => p.length === 9));
});

test('resize of an empty wall still leaves one blank page', () => {
  const r = resize(newDraft(), 2, 2);
  assert.deepEqual(r.pages, [[null, null, null, null]]);
});

test('capacity is cols x rows x MAX_PAGES', () => {
  assert.equal(capacity(3, 3), 9 * MAX_PAGES);
});

test('firstEmpty searches from the given page, then later pages, then wraps', () => {
  const d = newDraft({ cols: 1, rows: 1, pages: [[null], ['a'], ['b'], [null]] });
  assert.deepEqual(firstEmpty(d, 1), { page: 3, slot: 0 });
  assert.deepEqual(firstEmpty(d, 0), { page: 0, slot: 0 });
  assert.equal(firstEmpty(newDraft({ cols: 1, rows: 1, pages: [['a']] })), null);
});

test('addCamera: an already-placed camera is not added again', () => {
  const d = newDraft({ cols: 2, rows: 1, pages: [['a', null]] });
  const { draft, at } = addCamera(d, 'a');
  assert.equal(draft, d);
  assert.deepEqual(at, { page: 0, slot: 0 });
});

test('addCamera: a full wall grows a page; a full wall at MAX_PAGES returns at=null', () => {
  const d = newDraft({ cols: 1, rows: 1, pages: [['a']] });
  const r = addCamera(d, 'b');
  assert.deepEqual(r.at, { page: 1, slot: 0 });
  assert.deepEqual(r.draft.pages, [['a'], ['b']]);

  const full = newDraft({ cols: 1, rows: 1, pages: Array.from({ length: MAX_PAGES }, (_, i) => [`x${i}`]) });
  const none = addCamera(full, 'new');
  assert.equal(none.at, null);
  assert.equal(none.draft, full);
});

test('autoFill: only online cameras not yet on the wall, current page first, then new pages', () => {
  const d = newDraft({ cols: 2, rows: 1, pages: [['a', null], [null, null]] });
  const cams = [cam('a'), cam('b'), cam('off', 'g1', 'offline'), cam('c'), cam('d'), cam('e')];
  const r = autoFill(d, 1, cams);
  assert.deepEqual(r.draft.pages, [['a', 'd'], ['b', 'c'], ['e', null]]);
  assert.equal(r.filled, 4);
  assert.equal(r.left, 0);
  assert.ok(!cameraIds(r.draft).includes('off'));
});

test('autoFill: stops at MAX_PAGES and reports what was left over', () => {
  const d = newDraft({ cols: 1, rows: 1, pages: [[null]] });
  const cams = Array.from({ length: MAX_PAGES + 2 }, (_, i) => cam(`c${i}`));
  const r = autoFill(d, 0, cams);
  assert.equal(r.draft.pages.length, MAX_PAGES);
  assert.equal(r.filled, MAX_PAGES);
  assert.equal(r.left, 2);
});

test('autoFillable: false when every online camera is already on the wall or the wall is maxed out', () => {
  const d = newDraft({ cols: 1, rows: 1, pages: [['a']] });
  assert.equal(autoFillable(d, [cam('a'), cam('b', 'g1', 'offline')]), false);
  assert.equal(autoFillable(d, [cam('a'), cam('b')]), true);
  const full = newDraft({ cols: 1, rows: 1, pages: Array.from({ length: MAX_PAGES }, (_, i) => [`x${i}`]) });
  assert.equal(autoFillable(full, [cam('b')]), false);
});

test('playablePages: empty pages are skipped; an all-empty wall plays one blank page', () => {
  const d = newDraft({ cols: 1, rows: 1, pages: [[null], ['a'], [null]] });
  assert.deepEqual(playablePages(d, byIdOf([cam('a')])), [['a']]);
  assert.deepEqual(playablePages(newDraft({ cols: 1, rows: 1 }), new Map()), [[null]]);
});

test('playablePages: skipOffline drops offline cameras and closes up the gaps', () => {
  const cams = [cam('a'), cam('b', 'g1', 'offline'), cam('c')];
  const d = newDraft({ cols: 2, rows: 1, skipOffline: true, pages: [['a', 'b'], ['c', null]] });
  assert.deepEqual(playablePages(d, byIdOf(cams)), [['a', 'c']]);
});

test('liveBudget: one recorder never serves more than NVR_PULL_LIMIT live tiles on a page', () => {
  const n = Math.floor(NVR_PULL_LIMIT / SESSIONS_PER_CAMERA) + 5;
  const cams = Array.from({ length: n }, (_, i) => cam(`c${i}`, 'nvr1'));
  const live = liveBudget(cams.map((c) => c.monitorId), byIdOf(cams));
  assert.equal(live.size * SESSIONS_PER_CAMERA <= NVR_PULL_LIMIT, true);
  assert.equal(live.size, Math.floor(NVR_PULL_LIMIT / SESSIONS_PER_CAMERA));
  // Slot order decides who plays live: the first ones.
  assert.ok(live.has('c0'));
  assert.ok(!live.has(`c${n - 1}`));
});

test('liveBudget: the limit is per recorder, and offline / unknown / empty slots never play', () => {
  const cams = [cam('a', 'g1'), cam('b', 'g2'), cam('x', 'g1', 'offline')];
  const live = liveBudget(['a', 'b', 'x', null, 'ghost'], byIdOf(cams));
  assert.deepEqual([...live].sort(), ['a', 'b']);
});

test('recorderLoad: with rotation the peak counts a page together with the one after it', () => {
  const cams = [cam('a'), cam('b'), cam('c')];
  const d = newDraft({ cols: 2, rows: 1, rotate: true, pages: [['a', 'b'], ['c', null]] });
  const load = recorderLoad(d, byIdOf(cams));
  assert.equal(load.handover, true);
  assert.equal(load.live.get('g1'), 2 * SESSIONS_PER_CAMERA);
  assert.equal(load.peak.get('g1'), 3 * SESSIONS_PER_CAMERA);
});

test('recorderLoad: without rotation the peak is the busiest single page', () => {
  const cams = [cam('a'), cam('b'), cam('c')];
  const d = newDraft({ cols: 2, rows: 1, rotate: false, pages: [['a', 'b'], ['c', null]] });
  const load = recorderLoad(d, byIdOf(cams));
  assert.equal(load.handover, false);
  assert.equal(load.peak.get('g1'), 2 * SESSIONS_PER_CAMERA);
});

test('buildAutoWall: online cameras first, rotation off, capped at MAX_PAGES', () => {
  const cams = [cam('off', 'g1', 'offline'), cam('a'), cam('b')];
  const w = buildAutoWall(cams, { cols: 2, rows: 1 });
  assert.deepEqual(w.pages, [['a', 'b'], ['off', null]]);
  assert.equal(w.rotate, false);
  const many = Array.from({ length: 9 * MAX_PAGES + 4 }, (_, i) => cam(`c${i}`));
  assert.equal(buildAutoWall(many).pages.length, MAX_PAGES);
  assert.deepEqual(buildAutoWall([], { cols: 1, rows: 1 }).pages, [[null]]);
});

test('toPayload / sameLayout: trims the name and ignores the id', () => {
  const a = newDraft({ id: 1, name: '  Lobby ' });
  const b = { ...a, id: 2, name: 'Lobby' };
  assert.equal(toPayload(a).name, 'Lobby');
  assert.ok(!('id' in toPayload(a)));
  assert.equal(sameLayout(a, b), true);
  assert.equal(sameLayout(a, place(b, 0, 0, 'x')), false);
  assert.equal(sameLayout(a, null), false);
});

test('fromLayout copies pages so editing the draft cannot mutate the saved layout', () => {
  const saved = { id: 7, name: 'x', cols: 1, rows: 1, pages: [['a']], rotate: true, rotateSeconds: 30, skipOffline: false, focusAudio: true };
  const d = fromLayout(saved);
  d.pages[0][0] = 'b';
  assert.equal(saved.pages[0][0], 'a');
});

test('isDraftShape rejects grids outside 1..6 and pages of the wrong size', () => {
  assert.equal(isDraftShape(newDraft()), true);
  assert.equal(isDraftShape(newDraft({ cols: 7, rows: 1, pages: [Array(7).fill(null)] })), false);
  assert.equal(isDraftShape({ cols: 2, rows: 2, pages: [[null]] }), false);
  assert.equal(isDraftShape({ cols: 2, rows: 2, pages: [] }), false);
  assert.equal(isDraftShape(null), false);
  assert.equal(isDraftShape({ cols: 1.5, rows: 1, pages: [[null]] }), false);
});

test('wallUrl: saved and clean plays the saved layout; dirty or unsaved plays the draft; fs flag kept', () => {
  assert.equal(wallUrl({ id: 'a b' }, false), '/monitor-wall/live?layout=a%20b');
  assert.equal(wallUrl({ id: 5 }, true), '/monitor-wall/live?draft=1');
  assert.equal(wallUrl({ id: null }, false), '/monitor-wall/live?draft=1');
  assert.equal(wallUrl({ id: 5 }, false, true), '/monitor-wall/live?layout=5&fs=1');
});

test('indexCameras orders each recorder by channel and labels its site', () => {
  const groups = [{ id: 'g', name: 'NVR', siteId: 1, cameras: [{ monitorId: 'b', channel: 2 }, { monitorId: 'a', channel: 1 }] }];
  const { cameras, byId } = indexCameras(groups, [{ id: 1, name: 'HQ' }]);
  assert.deepEqual(cameras.map((c) => c.monitorId), ['a', 'b']);
  assert.equal(byId.get('a').siteName, 'HQ');
  assert.equal(byId.get('a').groupId, 'g');
  assert.equal(locate(newDraft({ cols: 1, rows: 1, pages: [['z']] }), 'nope'), null);
});
