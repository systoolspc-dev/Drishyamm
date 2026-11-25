/**
 * Tests for the Camera Status page's vocabulary: seven engine states folded
 * into four buckets, the "problems first" order, and the formatters that must
 * show a dash (not a zero) when there is no data.
 *
 * Runs on Node's built-in test runner (`npm test`). health-vocabulary.js has
 * no imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUCKETS, DASH, ENGINE_STATE, FILTER_BUCKETS,
  bucketMeta, bucketOf, engineState, fmtBps, fmtBytes, fmtDuration, fmtPercent, fmtTimestamp,
  gradeDelay, isStreaming, needsAttention, severityOf,
} from './health-vocabulary.js';

test('every engine state maps to one of the four buckets', () => {
  const ids = BUCKETS.map((b) => b.id);
  assert.equal(ids.length, 4);
  for (const [state, meta] of Object.entries(ENGINE_STATE)) assert.ok(ids.includes(meta.bucket), state);
  assert.deepEqual([...FILTER_BUCKETS].sort(), [...ids].sort());
});

test('standby, transcoding and starting count as online; wobbling is unstable', () => {
  for (const status of ['healthy', 'standby', 'transcoding', 'starting']) assert.equal(bucketOf({ status }), 'online', status);
  assert.equal(bucketOf({ status: 'wobbling' }), 'unstable');
  assert.equal(bucketOf({ status: 'offline' }), 'offline');
});

test('an unknown or missing status falls into "Needs setup", never "Online"', () => {
  assert.equal(bucketOf({ status: 'banana' }), 'setup');
  assert.equal(bucketOf({}), 'setup');
  assert.equal(bucketOf(null), 'setup');
  assert.equal(engineState(undefined), ENGINE_STATE.unknown);
  assert.equal(bucketMeta('nope').id, 'setup');
});

test('problems sort first: offline < unstable < setup < online', () => {
  const order = ['healthy', 'unknown', 'wobbling', 'offline']
    .map((status) => ({ status }))
    .sort((a, b) => severityOf(a) - severityOf(b))
    .map((c) => c.status);
  assert.deepEqual(order, ['offline', 'wobbling', 'unknown', 'healthy']);
});

test('needsAttention: everything but online needs a human', () => {
  assert.equal(needsAttention({ status: 'healthy' }), false);
  assert.equal(needsAttention({ status: 'standby' }), false);
  assert.equal(needsAttention({ status: 'wobbling' }), true);
  assert.equal(needsAttention({ status: 'offline' }), true);
  assert.equal(needsAttention({ status: 'unknown' }), true);
});

test('fmtBps: no bitrate is a dash, not "0 bps"; units scale', () => {
  assert.equal(fmtBps(0), DASH);
  assert.equal(fmtBps(null), DASH);
  assert.equal(fmtBps(-5), DASH);
  assert.equal(fmtBps(500), '500 bps');
  assert.equal(fmtBps(2_500), '3 Kbps');
  assert.equal(fmtBps(2_500_000), '2.5 Mbps');
});

test('fmtBytes scales B / KB / MB / GB on powers of 1024', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(2048), '2 KB');
  assert.equal(fmtBytes(5 * 1024 ** 2), '5.0 MB');
  assert.equal(fmtBytes(1.5 * 1024 ** 3), '1.5 GB');
});

test('fmtDuration: missing or negative is a dash; 0 is "0s"; s / m / h / d', () => {
  assert.equal(fmtDuration(null), DASH);
  assert.equal(fmtDuration(-1), DASH);
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(45), '45s');
  assert.equal(fmtDuration(120), '2m');
  assert.equal(fmtDuration(7200), '2h');
  assert.equal(fmtDuration(3 * 86400), '3d');
});

test('gradeDelay: no stream or 0 ms is "No data", not "Smooth"', () => {
  assert.equal(gradeDelay(0).label, 'No data');
  assert.equal(gradeDelay(40, { hasStream: false }).label, 'No data');
  assert.equal(gradeDelay(0).text, DASH);
  assert.equal(gradeDelay(40).text, '40 ms');
});

test('gradeDelay: <80 smooth, 80..199 slight, 200+ high', () => {
  assert.equal(gradeDelay(79).tone, 'success');
  assert.equal(gradeDelay(80).tone, 'warning');
  assert.equal(gradeDelay(199).tone, 'warning');
  assert.equal(gradeDelay(200).tone, 'danger');
});

test('isStreaming reads bpsIn, then meanBps', () => {
  assert.equal(isStreaming({ bpsIn: 10 }), true);
  assert.equal(isStreaming({ meanBps: 10 }), true);
  assert.equal(isStreaming({ bpsIn: 0 }), false);
  assert.equal(isStreaming(null), false);
});

test('fmtTimestamp: missing or invalid is a dash; fmtPercent is safe for a zero total', () => {
  assert.equal(fmtTimestamp(null), DASH);
  assert.equal(fmtTimestamp('not a date'), DASH);
  assert.equal(fmtPercent(3, 0), '0% of total');
  assert.equal(fmtPercent(1, 4), '25% of total');
});
