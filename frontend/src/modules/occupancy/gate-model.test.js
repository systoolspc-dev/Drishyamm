/**
 * Tests for the gate model — the pure half of gate setup.
 *
 * Runs on Node's built-in test runner (`npm test`). What is checked: the line
 * stays something the service can store, old level-line gates read back as
 * the same line, the keyboard and drag moves are predictable, the IN side is
 * drawn where the service counts IN, and a save sends only what changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LINE, clampLine, describeLine, directionFromCamera, distToLine, flipDirection, gatePatch,
  gatesByMonitor, inSidePolygon, lineAngle, lineFromCamera, lineMarkers, moveLine, nudgePoint, orderedLine,
} from './gate-model.js';

const LEVEL = { a: [0.1, 0.5], b: [0.9, 0.5] };

test('a line is clamped to the picture, and one too short to count is refused', () => {
  assert.deepEqual(clampLine({ a: [-0.2, 0.3], b: [1.4, 0.71234] }), { a: [0, 0.3], b: [1, 0.7123] });
  assert.equal(clampLine({ a: [0.5, 0.5], b: [0.51, 0.5] }), DEFAULT_LINE);
  assert.equal(clampLine({ a: [0.5, 'x'], b: [0.6, 0.5] }), DEFAULT_LINE);
  assert.equal(clampLine(null), DEFAULT_LINE);
});

test('an old level-line gate reads back as the same full-width line', () => {
  const line = lineFromCamera({ line_y_frac: 0.3, direction: 'down_is_in' });
  assert.deepEqual(line, { a: [0, 0.3], b: [1, 0.3] });
  assert.equal(directionFromCamera({ direction: 'down_is_in' }, line), 'right_is_in');
  assert.equal(directionFromCamera({ direction: 'up_is_in' }, line), 'left_is_in');
  // Down is the LEFT of a line drawn right to left.
  assert.equal(directionFromCamera({ direction: 'down_is_in' }, { a: [0.9, 0.5], b: [0.1, 0.5] }), 'left_is_in');
  assert.deepEqual(lineFromCamera({ line: { a: [0.2, 0.2], b: [0.8, 0.7] }, line_y_frac: 0.45 }), { a: [0.2, 0.2], b: [0.8, 0.7] });
  assert.equal(lineFromCamera({}), DEFAULT_LINE);
});

test('keyboard: arrows move one end 1%, shift 5%, and never off the picture', () => {
  assert.deepEqual(nudgePoint([0.5, 0.5], 'ArrowLeft'), [0.49, 0.5]);
  assert.deepEqual(nudgePoint([0.5, 0.5], 'ArrowDown', true), [0.5, 0.55]);
  assert.deepEqual(nudgePoint([0.02, 0.5], 'ArrowLeft', true), [0, 0.5]);
  assert.equal(nudgePoint([0.5, 0.5], 'a'), null);
});

test('a drawn line runs left to right, whichever way it was drawn', () => {
  assert.deepEqual(orderedLine({ a: [0.8, 0.2], b: [0.2, 0.6] }), { a: [0.2, 0.6], b: [0.8, 0.2] });
  assert.deepEqual(orderedLine({ a: [0.5, 0.9], b: [0.5, 0.1] }), { a: [0.5, 0.1], b: [0.5, 0.9] });
  assert.deepEqual(orderedLine(LEVEL), LEVEL);
});

test('moving the whole line stops at the edge without bending it', () => {
  assert.deepEqual(moveLine(LEVEL, 0.05, -0.1), { a: [0.15, 0.4], b: [0.95, 0.4] });
  assert.deepEqual(moveLine(LEVEL, 0.5, 0), { a: [0.2, 0.5], b: [1, 0.5] });
});

test('the IN side is shaded on the side the service counts as IN', () => {
  // Left-to-right level line: right of a->b is below it.
  const below = inSidePolygon(LEVEL, 'right_is_in');
  assert.ok(below.every(([, y]) => y >= 0.5 - 1e-9));
  const above = inSidePolygon(LEVEL, flipDirection('right_is_in'));
  assert.ok(above.every(([, y]) => y <= 0.5 + 1e-9));
  // Diagonal top-left -> bottom-right: its right is the bottom-left corner.
  const diag = inSidePolygon({ a: [0, 0], b: [1, 1] }, 'right_is_in');
  assert.deepEqual(diag.map((p) => p.map((n) => Number(n.toFixed(3)))).sort(), [[0, 0], [0, 1], [1, 1]].sort());
});

test('the IN arrow points across the line into the IN side', () => {
  assert.equal(Math.round(lineMarkers(LEVEL, 'right_is_in').angle), 90);     // straight down
  assert.equal(Math.round(lineMarkers(LEVEL, 'left_is_in').angle), -90);     // straight up
  const m = lineMarkers(LEVEL, 'right_is_in');
  assert.ok(m.inAt[1] > 0.5 && m.outAt[1] < 0.5);
  assert.deepEqual(m.mid, [0.5, 0.5]);
});

test('angle and description', () => {
  assert.equal(lineAngle(LEVEL), 0);
  assert.equal(lineAngle({ a: [0.5, 0.9], b: [0.5, 0.1] }), 90);
  assert.equal(describeLine(LEVEL), 'level line');
  assert.equal(describeLine({ a: [0.5, 0.1], b: [0.5, 0.9] }), 'upright line');
  assert.match(describeLine({ a: [0.2, 0.8], b: [0.6, 0.2] }), /^tilted \d+°$/);
  // A line sloping gently down reads as a small tilt, not as 174°.
  assert.equal(describeLine({ a: [0.18, 0.78], b: [0.86, 0.8989] }), 'tilted 6°');
});

test('distance to the line is measured to the segment, not past its ends', () => {
  assert.equal(distToLine([0.5, 0.5], LEVEL), 0);
  assert.ok(Math.abs(distToLine([0.5, 0.6], LEVEL) - 0.1) < 1e-9);
  assert.ok(distToLine([1, 0.5], LEVEL) > 0.1);     // beyond b
});

test('footfall rows are keyed by monitorId, counting or not', () => {
  const gates = gatesByMonitor({
    cameras: [
      { camera_id: 'uuid-1', camera_code: 'mon-1', footfall_enabled: true, line: { a: [0.2, 0.3], b: [0.7, 0.6] }, direction: 'left_is_in', today: { in: 7, out: 2 } },
      { camera_id: 'uuid-2', camera_code: 'mon-2', footfall_enabled: false },
      { camera_id: 'uuid-3' },
    ],
  });
  assert.deepEqual(Object.keys(gates), ['mon-1', 'mon-2']);
  assert.equal(gates['mon-1'].cameraId, 'uuid-1');
  assert.equal(gates['mon-1'].net, 5);
  assert.deepEqual(gates['mon-1'].line, { a: [0.2, 0.3], b: [0.7, 0.6] });
  assert.equal(gates['mon-1'].direction, 'left_is_in');
  assert.equal(gates['mon-2'].enabled, false);
  assert.equal(gates['mon-2'].line, DEFAULT_LINE);
  assert.equal(gates['mon-2'].direction, 'right_is_in');
});

test('a save sends only what changed; line and direction travel together', () => {
  const before = { enabled: false, line: LEVEL, direction: 'right_is_in' };
  assert.deepEqual(gatePatch(before, before), {});
  assert.deepEqual(gatePatch(before, { ...before, enabled: true }), { enabled: true });
  assert.deepEqual(
    gatePatch(before, { ...before, direction: 'left_is_in' }),
    { line: LEVEL, direction: 'left_is_in' },
  );
  const angled = { a: [0.2, 0.8], b: [0.7, 0.3] };
  assert.deepEqual(
    gatePatch(before, { enabled: true, line: angled, direction: 'right_is_in' }),
    { enabled: true, line: angled, direction: 'right_is_in' },
  );
});
