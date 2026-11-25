/**
 * Tests for the AI Feed's zone normaliser, line/box geometry and detection
 * payload normaliser.
 *
 * Runs on Node's built-in test runner (`npm test`). detection-utils.js has no
 * imports. The sign convention matters: the pipeline watches the 'left' side
 * of a line where cross >= 0, and the editor's arrow must point the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boxCorners, clamp01, draftDetectionZones, lineInsideNormal, normalizeDetectionZones,
  normalizeDetections, normalizeGender, zoneShape, zoneSide,
} from './detection-utils.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('clamp01 clamps to [0, 1] and maps junk to 0', () => {
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(1.5), 1);
  assert.equal(clamp01('0.25'), 0.25);
  assert.equal(clamp01('x'), 0);
  assert.equal(clamp01(Infinity), 0);
});

test('zoneShape / zoneSide default to polygon / left for anything unknown', () => {
  assert.equal(zoneShape('line'), 'line');
  assert.equal(zoneShape('circle'), 'polygon');
  assert.equal(zoneSide('right'), 'right');
  assert.equal(zoneSide('RIGHT'), 'left');
});

test('normalizeDetectionZones drops zones with too few points for their shape', () => {
  const p = (n) => Array.from({ length: n }, (_, i) => ({ x: i / 10, y: 0.5 }));
  const zones = normalizeDetectionZones([
    { shape: 'line', points: p(1) },
    { shape: 'line', points: p(2) },
    { shape: 'box', points: p(3) },
    { shape: 'polygon', points: p(3) },
  ]);
  assert.deepEqual(zones.map((z) => z.shape), ['line', 'polygon']);
});

test('normalizeDetectionZones caps zones at 8 and points at 24; a line keeps 2 points', () => {
  const pts = Array.from({ length: 30 }, () => ({ x: 0.5, y: 0.5 }));
  const many = normalizeDetectionZones(Array.from({ length: 10 }, () => ({ points: pts })));
  assert.equal(many.length, 8);
  assert.equal(many[0].points.length, 24);
  assert.equal(normalizeDetectionZones([{ shape: 'line', points: pts }])[0].points.length, 2);
});

test('normalizeDetectionZones clamps points and keeps only face/person in applyTo', () => {
  const [z] = normalizeDetectionZones([{
    points: [{ x: -1, y: 2 }, { x: 0.5, y: 0.5 }, { x: 0.2, y: 0.1 }],
    applyTo: ['person', 'car', 'person'],
  }]);
  assert.deepEqual(z.points[0], { x: 0, y: 1 });
  assert.deepEqual(z.applyTo, ['person']);
  assert.equal(z.enabled, true);
  assert.equal(z.id, 'zone-1');
});

test('normalizeDetectionZones: an applyTo with nothing valid falls back to both', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  assert.deepEqual(normalizeDetectionZones([{ points: pts, applyTo: ['car'] }])[0].applyTo, ['face', 'person']);
  assert.equal(normalizeDetectionZones([{ points: pts, enabled: false }])[0].enabled, false);
  assert.deepEqual(normalizeDetectionZones('nope'), []);
});

test('draftDetectionZones: no zones gives one empty line zone to draw on', () => {
  const [z] = draftDetectionZones([]);
  assert.equal(z.shape, 'line');
  assert.deepEqual(z.points, []);
  assert.equal(draftDetectionZones([{ points: [] }]).length, 1);
});

test('lineInsideNormal: unit length, perpendicular, and right is the opposite of left', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 3, y: 4 };
  const left = lineInsideNormal(a, b, 'left');
  const right = lineInsideNormal(a, b, 'right');
  near(Math.hypot(left.x, left.y), 1);
  near(left.x * 3 + left.y * 4, 0);
  near(left.x, -right.x);
  near(left.y, -right.y);
});

test('lineInsideNormal: "left" points into the cross >= 0 half-plane (pipeline convention)', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 1, y: 0 };
  const n = lineInsideNormal(a, b, 'left');
  const p = { x: 0.5 + n.x, y: n.y };
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  assert.ok(cross > 0);
});

test('lineInsideNormal: a zero-length line does not produce NaN', () => {
  const n = lineInsideNormal({ x: 1, y: 1 }, { x: 1, y: 1 }, 'left');
  assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
});

test('boxCorners orders corners clockwise from top-left whatever the drag direction', () => {
  const expected = [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.6 }, { x: 0.1, y: 0.6 }];
  assert.deepEqual(boxCorners({ x: 0.5, y: 0.6 }, { x: 0.1, y: 0.2 }), expected);
  assert.deepEqual(boxCorners({ x: 0.1, y: 0.6 }, { x: 0.5, y: 0.2 }), expected);
});

test('normalizeGender accepts 1/0, m/f, words; empty is null', () => {
  assert.equal(normalizeGender(1), 'Male');
  assert.equal(normalizeGender(0), 'Female');
  assert.equal(normalizeGender(' M '), 'Male');
  assert.equal(normalizeGender('female'), 'Female');
  assert.equal(normalizeGender(''), null);
  assert.equal(normalizeGender(null), null);
  assert.equal(normalizeGender('other'), 'other');
});

test('normalizeDetections reads boxes from x1.., left.. or bbox[] and drops empty boxes', () => {
  const out = normalizeDetections({
    detections: [
      { x1: 1, y1: 2, x2: 3, y2: 4 },
      { left: 1, top: 1, right: 5, bottom: 5, person_name: 'Asha', score: 0.9 },
      { bbox: [0, 0, 10, 10], trackId: 7 },
      { x1: 5, y1: 5, x2: 5, y2: 9 },
    ],
  });
  assert.equal(out.boxes.length, 3);
  assert.equal(out.boxes[0].name, 'Unknown');
  assert.equal(out.boxes[1].name, 'Asha');
  assert.equal(out.boxes[1].conf, 0.9);
  assert.equal(out.boxes[2].track_id, 7);
});

test('normalizeDetections: frame size defaults to 1920x1080 and running is only true when true', () => {
  const out = normalizeDetections(null);
  assert.deepEqual(out.boxes, []);
  assert.equal(out.frame_w, 1920);
  assert.equal(out.frame_h, 1080);
  assert.equal(out.running, false);
  assert.equal(normalizeDetections({ running: 'yes' }).running, false);
  assert.equal(normalizeDetections({ width: 640, height: 0, running: true }).frame_w, 640);
  assert.equal(normalizeDetections({ width: 640, height: 0 }).frame_h, 1080);
});
