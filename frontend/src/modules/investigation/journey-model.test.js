import test from 'node:test';
import assert from 'node:assert/strict';

import { clickToGrid, groupCandidates, loadRecentPeople, routeLabel, spanMinutes, togetherLabel } from './journey-model.js';

test('a click maps onto the picture inside letterbox bars', () => {
  // 1000x1000 element showing a 16:9 picture: bars above and below.
  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  assert.deepEqual(clickToGrid(rect, 1920, 1080, 500, 500), { x: 500, y: 500 });
  assert.deepEqual(clickToGrid(rect, 1920, 1080, 500, 200), null);         // on the top bar (picture starts at 218.75)
  assert.deepEqual(clickToGrid(rect, 1920, 1080, 250, 500 - 281.25 / 2), { x: 250, y: 250 });
});

test('pillarboxed picture and page offset', () => {
  const rect = { left: 100, top: 50, width: 1600, height: 450 };   // wide element, 16:9 picture 800x450
  assert.deepEqual(clickToGrid(rect, 1920, 1080, 100 + 400 + 400, 50 + 225), { x: 500, y: 500 });
  assert.equal(clickToGrid(rect, 1920, 1080, 150, 100), null);
});

test('candidates group by likelihood and routes read left to right', () => {
  const g = groupCandidates([{ status: 'possible' }, { status: 'likely' }, { status: 'possible' }]);
  assert.equal(g.likely.length, 1);
  assert.equal(g.possible.length, 2);
  assert.equal(routeLabel(['Gate 3', 'Lobby', 'Parking']), 'Gate 3 → Lobby → Parking');
  assert.equal(spanMinutes([{ first_seen: '2026-11-24T10:00:00Z' }, { last_seen: '2026-11-24T10:12:20Z' }]), 12);
});

test('together labels read in seconds, then minutes', () => {
  assert.equal(togetherLabel(12), 'together · 12 s');
  assert.equal(togetherLabel(185), 'together · 3 min');
  assert.equal(togetherLabel(30, 'vehicle'), 'near this vehicle · 30 s');
});

// ── Click to track: "pick someone" (loadRecentPeople) ──────────────────
function fakeSvc({ status, results, statusError, searchError } = {}) {
  const calls = { status: 0, search: [] };
  return {
    calls,
    async status() { calls.status += 1; if (statusError) throw statusError; return status; },
    async search(args) { calls.search.push(args); if (searchError) throw searchError; return { results }; },
  };
}

test('index off: says so and never searches', async () => {
  const svc = fakeSvc({ status: { enabled: false, person_detection: true } });
  assert.deepEqual(await loadRecentPeople(svc), { indexOff: true, people: null });
  assert.equal(svc.calls.search.length, 0);
});

test('a missing, empty or odd status counts as off (fail closed, no search)', async () => {
  for (const status of [null, undefined, {}, { enabled: 'true' }, { enabled: 1 }]) {
    const svc = fakeSvc({ status });
    assert.equal((await loadRecentPeople(svc)).indexOff, true, JSON.stringify(status));
    assert.equal(svc.calls.search.length, 0);
  }
});

test('index on: newest first, at most 30, from one "a person" search', async () => {
  const results = Array.from({ length: 45 }, (_, i) => ({ track_id: `t${i}`, first_seen: new Date(Date.UTC(2026, 10, 24, 0, i)).toISOString() }));
  const svc = fakeSvc({ status: { enabled: true }, results: [...results].reverse() });
  const out = await loadRecentPeople(svc);
  assert.equal(out.indexOff, false);
  assert.equal(out.people.length, 30);
  assert.equal(out.people[0].track_id, 't44');
  assert.equal(out.people[29].track_id, 't15');
  assert.deepEqual(svc.calls.search, [{ q: 'a person', topK: 60 }]);
});

test('index on but nobody indexed yet: an empty list, not "off"', async () => {
  for (const results of [[], undefined]) {
    const out = await loadRecentPeople(fakeSvc({ status: { enabled: true }, results }));
    assert.deepEqual(out, { indexOff: false, people: [] });
  }
});

test('does not reorder the caller\'s results in place', async () => {
  const results = [{ track_id: 'old', first_seen: '2026-11-24T08:00:00Z' }, { track_id: 'new', first_seen: '2026-11-24T09:00:00Z' }];
  await loadRecentPeople(fakeSvc({ status: { enabled: true }, results }));
  assert.deepEqual(results.map((r) => r.track_id), ['old', 'new']);
});

test('a limit can be given', async () => {
  const results = [1, 2, 3].map((i) => ({ track_id: `t${i}`, first_seen: `2026-11-24T0${i}:00:00Z` }));
  const out = await loadRecentPeople(fakeSvc({ status: { enabled: true }, results }), 2);
  assert.deepEqual(out.people.map((p) => p.track_id), ['t3', 't2']);
});

test('errors reach the caller (the page shows them) instead of being swallowed', async () => {
  await assert.rejects(loadRecentPeople(fakeSvc({ statusError: new Error('Network Error') })), /Network Error/);
  await assert.rejects(loadRecentPeople(fakeSvc({ status: { enabled: true }, searchError: new Error('503') })), /503/);
});
