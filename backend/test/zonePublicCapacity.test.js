/**
 * Public zones, and capacity rules that actually reach the engine.
 *
 * Two defects sat either side of the same field. The zone editor has always
 * written `alertOnEntry: access.mode !== 'public'` and the model has always had
 * the column, but `handleFrame` never read it back — so a zone an operator had
 * explicitly marked PUBLIC still raised a `zone.intrusion` for every person who
 * walked through it. Separately, the REST route never accepted `maxOccupancy`,
 * so a zone configured by capacity reached the engine with no cap and fell
 * through to entry alerts instead of the threshold alert it was set up for.
 *
 * These tests pin the resulting behaviour, including the two cases that are
 * easy to break while fixing it:
 *
 *   - a PUBLIC zone with a capacity rule must STILL alert when it is over the
 *     limit. Public means "do not alarm on entry", not "do not alarm";
 *   - a row written before `alertOnEntry` was honoured (field absent) must keep
 *     alerting. Treating a missing field as `false` would silently mute every
 *     zone in an existing deployment.
 */

jest.mock('../src/models', () => ({
  RestrictedZone: { findAll: jest.fn() },
  AIEvent: { create: jest.fn() },
}));
jest.mock('../src/services/entitlements.service', () => ({
  getEntitlements: jest.fn(),
  allowsAny: jest.fn(() => true),
}));
jest.mock('../src/services/alertEngine', () => ({ maybeAlert: jest.fn(() => Promise.resolve()) }));

const { RestrictedZone, AIEvent } = require('../src/models');
const { getEntitlements } = require('../src/services/entitlements.service');
const { emit, EVENTS } = require('../src/events/bus');
const zoneIntrusion = require('../src/services/zoneIntrusion.service');

zoneIntrusion.init();

// Bottom-centre lands at 50% down, inside the full-frame rect below.
const box = (name, x = 50) => ({
  bbox: [x * 10 - 20, 100, x * 10 + 20, 500],
  ...(name === undefined ? {} : { name }),
});

const frameOf = (boxes) => ({ monitorId: 'cam-a', frameW: 1000, frameH: 1000, boxes });
const zoneRow = (zone) => ({ ...zone, toJSON: () => zone });

let zoneSeq = 0;
/**
 * A fresh zone and account per test — the engine caches zones by user and
 * occupancy state by zone id, so reusing either would leak between tests.
 *
 * `alertOnEntry` is passed through EXACTLY as given, including undefined, so a
 * test can describe a legacy row that predates the field.
 */
function scenario({ alertOnEntry, maxOccupancy = 0, allowed = [], dwellSec = 0 } = {}) {
  zoneSeq += 1;
  const userId = `user-${zoneSeq}`;
  const zone = {
    id: `zone-${zoneSeq}`,
    monitorId: 'cam-a',
    name: 'Lobby',
    enabled: true,
    schedule: 'always',
    priority: 'critical',
    allowed,
    dwellSec,
    maxOccupancy,
    shape: 'rectangle',
    rect: { x: 0, y: 0, w: 100, h: 100 },
    ...(alertOnEntry === undefined ? {} : { alertOnEntry }),
  };
  RestrictedZone.findAll.mockResolvedValue([zoneRow(zone)]);
  return { userId, zone };
}

async function flush() {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function sendFrame(userId, boxes) {
  emit(EVENTS.AI_LIVE_OVERLAY, { userId, frame: frameOf(boxes) });
  await flush();
}

/** Two frames a second apart: enough for the entry confirm. */
async function enter(userId, boxes) {
  await sendFrame(userId, boxes);
  jest.advanceTimersByTime(1000);
  await sendFrame(userId, boxes);
}

/** Capacity needs OCC_CONFIRM_POLLS (3) consecutive polls over the cap. */
async function pollOverCapacity(userId, boxes, polls = 3) {
  for (let i = 0; i < polls; i += 1) {
    await sendFrame(userId, boxes);
    jest.advanceTimersByTime(1000);
  }
}

const typesFired = () => AIEvent.create.mock.calls.map((c) => c[0].eventType);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-21T10:00:00Z'));
  getEntitlements.mockResolvedValue({ aiEnabled: true, features: ['restricted_zone'] });
  AIEvent.create.mockResolvedValue({ toJSON: () => ({ id: 'evt-1' }) });
});

afterEach(() => {
  jest.useRealTimers();
});

/* ─────────────────────── A public zone stays quiet ────────────────────── */

test('a public zone does not alarm on entry', async () => {
  const { userId } = scenario({ alertOnEntry: false });
  await enter(userId, [box('Asha Patel'), box(undefined, 60)]);

  expect(AIEvent.create).not.toHaveBeenCalled();
});

test('a public zone stays quiet however many people walk through it', async () => {
  const { userId } = scenario({ alertOnEntry: false });
  await enter(userId, [box(undefined, 30), box(undefined, 50), box(undefined, 70)]);
  jest.advanceTimersByTime(60_000);
  await enter(userId, [box(undefined, 30), box(undefined, 50), box(undefined, 70)]);

  expect(AIEvent.create).not.toHaveBeenCalled();
});

/* ────────── …but public does not mean "never alert at all" ──────────── */

test('a public zone WITH a capacity rule still alerts when it is over the limit', async () => {
  const { userId } = scenario({ alertOnEntry: false, maxOccupancy: 1 });
  await pollOverCapacity(userId, [box(undefined, 40), box(undefined, 60)]);

  expect(typesFired()).toContain('occupancy.threshold');
  expect(typesFired()).not.toContain('zone.intrusion');
});

test('a public zone with a capacity rule it is under stays quiet', async () => {
  const { userId } = scenario({ alertOnEntry: false, maxOccupancy: 5 });
  await pollOverCapacity(userId, [box(undefined, 40), box(undefined, 60)]);

  expect(AIEvent.create).not.toHaveBeenCalled();
});

/* ─────────────── Restricted zones are unchanged ──────────────────────── */

test('a restricted zone still raises an intrusion', async () => {
  const { userId } = scenario({ alertOnEntry: true });
  await enter(userId, [box('Asha Patel')]);

  expect(typesFired()).toEqual(['zone.intrusion']);
});

test('a row written before alertOnEntry was honoured still raises an intrusion', async () => {
  // The field is absent entirely — every zone in an existing deployment. A
  // missing value must not read as "public", or the fix mutes the product.
  const { userId, zone } = scenario({ alertOnEntry: undefined });
  expect('alertOnEntry' in zone).toBe(false);

  await enter(userId, [box('Asha Patel')]);
  expect(typesFired()).toEqual(['zone.intrusion']);
});

/* ──────── The two rules are independent ─────────────────────────────── */

test('a restricted zone with a capacity rule alerts on BOTH', async () => {
  // This test used to assert "on the cap, NOT on entry", under a heading
  // saying a capacity zone was always meant to skip intrusion. That premise
  // was wrong, and it cost a real deployment a no-entry log that stayed
  // empty: a zone that had once been a counting area with a limit of 4 kept
  // the 4, so `cap > 0` took the capacity branch and `continue`d past the
  // entry alarm for ever. The operator saw capacity breaches and an empty
  // no-entry page, with nothing anywhere saying the limit had switched the
  // alarm off.
  //
  // They answer different questions. A capacity says HOW MANY may be in
  // here; `alertOnEntry` says WHETHER ANYONE may. A zone can need both, and
  // one must not silently cancel the other.
  const { userId } = scenario({ alertOnEntry: true, maxOccupancy: 1 });
  await pollOverCapacity(userId, [box('Asha Patel', 40), box('Ravi Kumar', 60)]);

  expect(typesFired()).toContain('occupancy.threshold');
  expect(typesFired()).toContain('zone.intrusion');
});

test('and an ordinary counting room is still not spammed on entry', async () => {
  // The reason the old premise looked right: a canteen with a limit must not
  // alarm on every person who walks in. It still does not -- but that is
  // `alertOnEntry: false`, which is what a counting area carries
  // (restricted-zones-api toApi: `alertOnEntry: access.mode !== 'public'`),
  // and NOT the capacity. The protection comes from the mode the operator
  // chose, not from a side effect of having set a number.
  const { userId } = scenario({ alertOnEntry: false, maxOccupancy: 1 });
  await pollOverCapacity(userId, [box('Asha Patel', 40), box('Ravi Kumar', 60)]);

  expect(typesFired()).toContain('occupancy.threshold');
  expect(typesFired()).not.toContain('zone.intrusion');
});
