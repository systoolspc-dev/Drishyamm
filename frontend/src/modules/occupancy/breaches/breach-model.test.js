import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boxInImage, breachTrends, clipWindow, inShift, istDayStart, istHour, rangeLabel, rangeWindow, readBbox, statusOf,
} from './breach-model.js';

// 2026-09-29 15:30 IST = 10:00 UTC
const NOW = Date.UTC(2026, 8, 29, 10, 0);
const IST_MIDNIGHT = Date.UTC(2026, 8, 28, 18, 30); // 2026-09-29 00:00 IST
const DAY = 86_400_000;

test('today starts at IST midnight, open-ended', () => {
  assert.deepEqual(rangeWindow({ preset: 'today' }, NOW), { since: IST_MIDNIGHT, until: null });
});

test('last 24h is a rolling window', () => {
  assert.equal(rangeWindow({ preset: '24h' }, NOW).since, NOW - DAY);
});

test('last 7 days covers today and six whole days before it', () => {
  assert.equal(rangeWindow({ preset: '7d' }, NOW).since, IST_MIDNIGHT - 6 * DAY);
});

test('custom range is inclusive IST days and swaps a reversed pair', () => {
  const w = rangeWindow({ preset: 'custom', from: '2026-09-20', to: '2026-09-18' }, NOW);
  assert.equal(w.since, istDayStart('2026-09-18'));
  assert.equal(w.until, istDayStart('2026-09-20') + DAY);
});

test('custom range ending today stays open-ended', () => {
  assert.equal(rangeWindow({ preset: 'custom', from: '2026-09-28', to: '2026-09-29' }, NOW).until, null);
});

test('shifts use IST hours and the night shift wraps midnight', () => {
  const at = (h) => IST_MIDNIGHT + h * 3_600_000;
  assert.equal(istHour(at(23)), 23);
  assert.equal(inShift(at(7), 'morning'), true);
  assert.equal(inShift(at(14), 'morning'), false);
  assert.equal(inShift(at(14), 'evening'), true);
  assert.equal(inShift(at(23), 'night'), true);
  assert.equal(inShift(at(3), 'night'), true);
  assert.equal(inShift(at(12), 'night'), false);
  assert.equal(inShift(at(12), 'all'), true);
});

test('range label names the preset and shift', () => {
  assert.equal(rangeLabel({ preset: '7d', shift: 'night' }), 'Last 7 days · Night');
  assert.equal(rangeLabel({ preset: 'today', shift: 'all' }), 'Today');
});

test('status: resolved beats acknowledged beats open', () => {
  const ctx = { acked: new Set(['b']), resolved: { c: { at: 'x', by: 'y' } } };
  assert.equal(statusOf({ id: 'a' }, ctx), 'open');
  assert.equal(statusOf({ id: 'b' }, ctx), 'acknowledged');
  assert.equal(statusOf({ id: 'd', acknowledgedAt: 'x' }, ctx), 'acknowledged');
  assert.equal(statusOf({ id: 'c', acknowledgedAt: 'x' }, ctx), 'resolved');
});

test('trends bucket by IST hour and rank cameras', () => {
  const at = (h) => new Date(IST_MIDNIGHT + h * 3_600_000);
  const rows = [
    { when: at(14), monitorId: 'm1', cameraName: 'Gate' },
    { when: at(14.5), monitorId: 'm1', cameraName: 'Gate' },
    { when: at(2), monitorId: 'm2', cameraName: 'Vault' },
  ];
  const t = breachTrends(rows);
  assert.equal(t.peak.hour, 14);
  assert.equal(t.peak.count, 2);
  assert.deepEqual(t.topCameras.map((c) => [c.name, c.count]), [['Gate', 2], ['Vault', 1]]);
  assert.equal(breachTrends([]).peak, null);
});

test('bbox reads arrays, corner objects and x/y/w/h', () => {
  assert.deepEqual(readBbox({ bbox: [1, 2, 3, 4] }), [1, 2, 3, 4]);
  assert.deepEqual(readBbox({ payload: { bbox: { x1: 1, y1: 2, x2: 3, y2: 4 } } }), [1, 2, 3, 4]);
  assert.deepEqual(readBbox({ payload: { box: { x: 10, y: 20, w: 5, h: 6 } } }), [10, 20, 15, 26]);
  assert.equal(readBbox({}), null);
});

test('box scales from the inference frame, or from normalised values', () => {
  assert.deepEqual(boxInImage([100, 100, 200, 200], { w: 1920, h: 1080 }, { w: 960, h: 540 }), [50, 50, 100, 100]);
  assert.deepEqual(boxInImage([0.1, 0.5, 0.2, 1], null, { w: 1000, h: 500 }), [100, 250, 200, 500]);
});

test('clip is 15 s before to 45 s after, capped at now', () => {
  assert.deepEqual(clipWindow(1_000_000, 2_000_000), { start: 985_000, end: 1_045_000 });
  assert.deepEqual(clipWindow(1_000_000, 1_010_000), { start: 985_000, end: 1_010_000 });
});
