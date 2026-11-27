/**
 * Which zones have nothing to count.
 *
 * A strict lockout admits nobody, so there is no occupancy to report. Saving
 * one used to switch head counting ON for every camera it was drawn on,
 * because `enable: zone.cameras` was written for counting areas -- where a
 * zone with no number is useless -- and carried over to a kind of zone it was
 * never about.
 *
 * What that cost: converting a counting area into a no-entry zone left head
 * counting running, holding one of the detector's eight slots for a number
 * nobody would ever read, on a camera whose whole point was that nobody
 * should be there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { alarmOnlyZone } from './access-data.js';

const zone = (mode) => ({ id: 'z1', cameras: ['m1'], access: { mode } });

test('a strict lockout has nothing to count', () => {
  assert.equal(alarmOnlyZone(zone('lockout')), true);
});

test('every other mode still counts', () => {
  // Public is the ordinary counting area. Restricted is an allow-list zone,
  // which is not offered today but still counts occupancy when it returns --
  // people ARE admitted, they are just named.
  assert.equal(alarmOnlyZone(zone('public')), false);
  assert.equal(alarmOnlyZone(zone('restricted')), false);
});

test('a zone with no access record counts, rather than falling silent', () => {
  // Absent means "not a lockout". Every zone saved before access modes
  // existed carries nothing here, and reading that as a lockout would switch
  // head counting off across a deployment on the next save of each zone.
  assert.equal(alarmOnlyZone({ id: 'z1', cameras: ['m1'] }), false);
  assert.equal(alarmOnlyZone({ access: {} }), false);
  assert.equal(alarmOnlyZone({}), false);
  assert.equal(alarmOnlyZone(null), false);
  assert.equal(alarmOnlyZone(undefined), false);
});

test('it is the mode, not a truthy string', () => {
  // Guards the obvious slip: any non-empty mode reading as a lockout would
  // stop counting areas counting.
  assert.equal(alarmOnlyZone(zone('Lockout')), false);
  assert.equal(alarmOnlyZone(zone('lock')), false);
  assert.equal(alarmOnlyZone(zone(true)), false);
});
