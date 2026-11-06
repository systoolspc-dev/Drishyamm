/**
 * Tests for the Peak Occupancy drill-in's time windows and utilization bands.
 * Runs on Node's built-in test runner (`npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bucketEnd, bucketRange, shiftAt, utilizationLevel, windowFor } from './peak-window.js';

const HOURS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00'];
const SHIFTS = [
  { id: 'full', label: 'Full Day', start: '09:00', end: '18:00' },
  { id: 'early', label: 'Early', start: '08:00', end: '16:00' },
  { id: 'late', label: 'Late', start: '11:00', end: '20:00' },
];

test('utilization bands: normal below 80, nearing up to the limit, exceeded above it', () => {
  assert.equal(utilizationLevel(79).id, 'normal');
  assert.equal(utilizationLevel(80).id, 'nearing');
  assert.equal(utilizationLevel(100).id, 'nearing', 'exactly full is at the limit, not over it');
  assert.equal(utilizationLevel(101).id, 'exceeded');
  assert.equal(utilizationLevel(95, 90).id, 'exceeded', 'a vertical with a 90% limit breaches earlier');
});

test('a bucket ends where the next begins; the last runs one step on', () => {
  assert.equal(bucketEnd(HOURS, 5), '15:00');
  assert.equal(bucketEnd(HOURS, 11), '21:00');
  assert.equal(bucketEnd(['22:00', '00:00'], 1), '02:00');
});

test('a shift maps to the buckets that start inside it', () => {
  assert.deepEqual(bucketRange(HOURS, '11:00', '20:00'), { from: 2, to: 10 });
  assert.deepEqual(bucketRange(HOURS, '08:00', '16:00'), { from: 0, to: 6 });
  assert.equal(bucketRange(HOURS, '21:00', '23:00'), null);
  assert.deepEqual(bucketRange(['20:00', '22:00', '00:00', '02:00'], '22:00', '06:00'), { from: 1, to: 3 }, 'overnight');
});

test('with overlapping rosters, "this shift" is the crew that came on last', () => {
  assert.equal(shiftAt(SHIFTS, '13:00').id, 'late');
  assert.equal(shiftAt(SHIFTS, '08:30').id, 'early');
  assert.equal(shiftAt(SHIFTS, '23:00'), null);
});

test('each time window resolves to a bucket range (null = whole day)', () => {
  assert.equal(windowFor('today', { buckets: HOURS }), null);
  assert.equal(windowFor('yesterday', { buckets: HOURS }), null);
  assert.deepEqual(windowFor('shift', { buckets: HOURS, shift: SHIFTS[2] }), { from: 2, to: 10 });
  assert.equal(windowFor('shift', { buckets: HOURS, shift: null }), null);
  assert.deepEqual(windowFor('peak', { buckets: HOURS, peakIdx: 5 }), { from: 5, to: 5 });
  assert.deepEqual(windowFor('custom', { buckets: HOURS, custom: { from: 9, to: 3 } }), { from: 9, to: 9 }, 'a reversed custom range collapses, never inverts');
});
