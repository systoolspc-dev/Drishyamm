/**
 * The zone body-detection switch, as the feature list presents it.
 *
 * Three rules, each there to stop a specific bad control:
 *
 *   ABSENT MEANS OFF   every other flag here reads absent as ON, because they
 *                      are features a camera has always had. This one is a
 *                      second detector that costs GPU per frame, so a fleet
 *                      must not start running it because this shipped.
 *   HIDDEN WITH NO ZONE  with nothing drawn it has no effect whatever, and a
 *                      live toggle that saves and changes nothing is how an
 *                      operator learns to distrust the screen.
 *   FORCED WHEN ANONYMOUS  face off means no face pipeline, so a zone would be
 *                      armed with no producer at all. Not a choice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_FEATURES, ZONE_BODY_REQUIRED_NOTE, activeFeatureLabels, buildEnablePayload,
  cameraFeatures, hasRestrictedZone, visibleFeatures, zoneBodyRequired,
} from './aiCamera.js';

const ZONE = { shape: 'polygon', points: [[0, 0], [1, 0], [1, 1]], enabled: true };
const LINE = { shape: 'line', points: [[0, 0], [1, 1]], enabled: true };

/** A GET /ai/cameras row: AI on, a zone drawn, nothing else said. */
const row = (ai = {}, rest = {}) => ({
  id: 'cam-1',
  monitorId: 'MON1',
  ai: { enabled: true, mode: 'continuous', detectionZones: [ZONE], ...ai },
  ...rest,
});

const find = (list, key) => list.find((f) => f.key === key);
const bodyRow = (r) => find(cameraFeatures(r), 'zone_body');

/* ───────────────────── it is a child of the zone row ───────────────────── */

test('the feature is labelled for what it does, not for the service', () => {
  const f = AI_FEATURES.find((x) => x.key === 'zone_body');
  assert.equal(f.label, 'Catch people with no visible face');
  // The implementation must not leak into the label an operator reads.
  assert.ok(!/zone.?guard/i.test(f.label));
  assert.ok(!/yolo/i.test(f.label));
});

test('it sits directly under the restricted-zone row, as its child', () => {
  const keys = AI_FEATURES.map((f) => f.key);
  const f = AI_FEATURES.find((x) => x.key === 'zone_body');
  assert.equal(f.parent, 'restricted_zone');
  assert.equal(keys[keys.indexOf('restricted_zone') + 1], 'zone_body');
});

/* ──────────────────────── absent means OFF ─────────────────────────────── */

test('a camera that has never been told to run it does not', () => {
  assert.equal(bodyRow(row()).on, false);
  assert.equal(bodyRow(row({ zoneBodyDetection: undefined })).on, false);
});

test('only an explicit true turns it on', () => {
  assert.equal(bodyRow(row({ zoneBodyDetection: true })).on, true);
  assert.equal(bodyRow(row({ zoneBodyDetection: false })).on, false);
  // Not truthiness: a stored string must not light up a detector.
  assert.equal(bodyRow(row({ zoneBodyDetection: 'yes' })).on, false);
});

test('the other flag still reads absent as ON, which is the whole contrast', () => {
  // `unknown_alerts` used to stand here too. It is no longer a row: the panel
  // lists models, and an alert is not one. `face` carries the contrast alone
  // now -- absent means ON for a feature a camera has always had, and OFF for
  // a second detector that costs GPU and must be opted into.
  const f = cameraFeatures(row());
  assert.equal(find(f, 'face').on, true);
  assert.equal(find(f, 'zone_body').on, false);
});

test('the enable payload defaults it to false and carries a true through', () => {
  assert.equal(buildEnablePayload(row(), { faceRecognition: true }).zoneBodyDetection, false);
  assert.equal(buildEnablePayload(row({ zoneBodyDetection: true }), { faceRecognition: true }).zoneBodyDetection, true);
  // An override wins, which is what the zone editor's inline switch sends.
  assert.equal(
    buildEnablePayload(row(), { zoneBodyDetection: true, faceRecognition: true }).zoneBodyDetection,
    true,
  );
});

test('AI off means the feature is not on, whatever the flag says', () => {
  const off = row({ enabled: false, mode: 'off', zoneBodyDetection: true });
  assert.equal(bodyRow(off).on, false);
});

/* ───────────── hidden unless this camera has an enabled zone ───────────── */

test('no zone drawn means no control at all', () => {
  const noZone = row({ detectionZones: [] });
  assert.equal(bodyRow(noZone).hidden, true);
  assert.equal(find(visibleFeatures(noZone), 'zone_body'), undefined);
});

test('a camera with only a GATE line has no zone, so no control', () => {
  // A line is a counting gate, not a restricted zone. Showing the switch for
  // a gate would be offering a detector the gate cannot use.
  const gateOnly = row({ detectionZones: [LINE] });
  assert.equal(hasRestrictedZone(gateOnly), false);
  assert.equal(bodyRow(gateOnly).hidden, true);
});

test('a DISABLED zone does not count as a zone', () => {
  const disabled = row({ detectionZones: [{ ...ZONE, enabled: false }] });
  assert.equal(bodyRow(disabled).hidden, true);
});

test('one enabled zone is enough to show it', () => {
  const withZone = row({ detectionZones: [LINE, ZONE] });
  assert.equal(hasRestrictedZone(withZone), true);
  assert.equal(bodyRow(withZone).hidden, false);
  assert.ok(find(visibleFeatures(withZone), 'zone_body'));
});

test('a zone with no explicit enabled flag counts as enabled', () => {
  // Matches how every other drawn feature here reads a shape.
  assert.equal(hasRestrictedZone(row({ detectionZones: [{ shape: 'polygon' }] })), true);
});

/* ───── the real zone count wins over the drawn-shape guess ────────────── */

test('the server count is the answer when it is sent', () => {
  // A restricted zone is a row in /restricted-zones, not a shape on
  // ai.detectionZones. Those are drawn on near-identical canvases on different
  // pages, and detectionZones only tells the pipeline where to look for faces.
  // A camera can easily have one and not the other, in both directions.
  const zoneButNoShape = row({ detectionZones: [] }, { restrictedZones: { armed: 1 } });
  assert.equal(hasRestrictedZone(zoneButNoShape), true);
  assert.equal(bodyRow(zoneButNoShape).hidden, false);

  const shapeButNoZone = row({ detectionZones: [ZONE] }, { restrictedZones: { armed: 0 } });
  assert.equal(hasRestrictedZone(shapeButNoZone), false);
  assert.equal(bodyRow(shapeButNoZone).hidden, true);
});

test('a payload without the count falls back to the drawn shape', () => {
  // An older backend, or a response cached across a deploy. The guess is the
  // second choice, never the first.
  assert.equal(hasRestrictedZone(row({ detectionZones: [ZONE] })), true);
  assert.equal(hasRestrictedZone(row({ detectionZones: [] })), false);
});

test('the count drives the forced case too, not just the hiding', () => {
  const anon = row(
    { faceRecognition: false, detectionZones: [] },
    { restrictedZones: { armed: 2 } },
  );
  assert.equal(zoneBodyRequired(anon), true);
  assert.equal(bodyRow(anon).forced, true);
});

test('hiding it never hides the zone row itself', () => {
  const noZone = row({ detectionZones: [] });
  assert.ok(find(visibleFeatures(noZone), 'restricted_zone'));
});

test('a hidden feature is never chipped as active', () => {
  // `activeFeatureLabels` feeds the chips on camera rows and cards. A camera
  // with the flag stored true but no zone is doing nothing with it.
  const stale = row({ detectionZones: [], zoneBodyDetection: true });
  assert.ok(!activeFeatureLabels(stale).includes('Bodies'));
  assert.ok(activeFeatureLabels(row({ zoneBodyDetection: true })).includes('Bodies'));
});

/* ────────── forced when the camera has no other producer ───────────────── */

test('face off with a zone makes it required, not optional', () => {
  const anon = row({ faceRecognition: false });
  assert.equal(zoneBodyRequired(anon), true);

  const f = bodyRow(anon);
  assert.equal(f.forced, true);
  assert.equal(f.on, true);        // reported as on even though nothing stored it
  assert.equal(f.hidden, false);   // and shown, so the reason can be read
  assert.equal(f.forcedReason, ZONE_BODY_REQUIRED_NOTE);
});

test('the reason says why, not just that', () => {
  assert.match(ZONE_BODY_REQUIRED_NOTE, /face recognition is off/i);
  assert.match(ZONE_BODY_REQUIRED_NOTE, /watching nothing/i);
});

test('face ON leaves it a free choice', () => {
  // Both answers are legitimate: a lockout zone wants this detector, an
  // allow-list zone is broken by its nameless boxes. The product must not pick.
  const f = bodyRow(row({ faceRecognition: true }));
  assert.equal(f.forced, undefined);
  assert.equal(f.on, false);
});

test('a camera saved before the face flag existed is not anonymous', () => {
  // Absent means ON for faceRecognition, so there IS a producer.
  assert.equal(zoneBodyRequired(row()), false);
});

test('face off with NO zone forces nothing', () => {
  // Anonymous counting is a legitimate setup. With no zone there is nothing
  // to arm, so nothing to protect against, and no detector to force on.
  const anonNoZone = row({ faceRecognition: false, detectionZones: [] });
  assert.equal(zoneBodyRequired(anonNoZone), false);
  assert.equal(bodyRow(anonNoZone).hidden, true);
});

test('AI off entirely is not the forced case', () => {
  // Nothing runs because the operator said so, which the list reports as
  // needsSetup on the zone row. Forcing a detector onto a camera whose AI is
  // off would start work nobody asked for.
  const dark = row({ enabled: false, mode: 'off', faceRecognition: false });
  assert.equal(zoneBodyRequired(dark), false);
  assert.equal(bodyRow(dark).forced, undefined);
  assert.equal(find(cameraFeatures(dark), 'restricted_zone').needsSetup, true);
});

test('an anonymous camera cannot be read as having the zone covered', () => {
  // The invariant, stated from the UI side: with face off and body off there
  // is no producer, so `on` must not be true for either.
  const anon = row({ faceRecognition: false, zoneBodyDetection: false });
  assert.equal(find(cameraFeatures(anon), 'face').on, false);
  // ...and the body row is forced rather than quietly off, because the server
  // will force it too.
  assert.equal(bodyRow(anon).forced, true);
});

/* ───────────────────── nothing else moved ─────────────────────────────── */

test('every other feature keeps its shape', () => {
  const f = cameraFeatures(row());
  // 'journey' and the two alert rows are deliberately absent: this panel
  // lists the models a camera runs. Journey mapping belongs to Person
  // Tracker, and an alert is not a model.
  for (const key of ['face', 'head_count', 'footfall', 'restricted_zone']) {
    assert.equal(find(f, key).hidden, false, `${key} must stay visible`);
    assert.equal(find(f, key).forced, undefined, `${key} must not be forced`);
  }
});

test('a row with no ai at all does not throw', () => {
  assert.equal(hasRestrictedZone({}), false);
  assert.equal(hasRestrictedZone(undefined), false);
  assert.equal(zoneBodyRequired(undefined), false);
  assert.equal(bodyRow({}).on, false);
  assert.equal(bodyRow({}).hidden, true);
});
