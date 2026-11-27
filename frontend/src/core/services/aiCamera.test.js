import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FPS, activeFeatureLabels, aiSetupPath, buildDisablePayload, buildEnablePayload, cameraFeatures,
  featureSetupPath,
} from './aiCamera.js';

const row = ({ ai, ...over } = {}) => ({
  id: 'cam-1', monitorId: 'm1', name: 'Main Entrance', groupName: 'HQ',
  ai: { enabled: false, ...ai }, headcount: { enabled: false, zones: [] }, ...over,
});

test('enable payload uses one default fps and carries stored settings', () => {
  assert.equal(buildEnablePayload(row(), { faceRecognition: true }).fps, DEFAULT_FPS);
  const p = buildEnablePayload(row({ ai: { fps: 8, purpose: 'Reception', watchlistAlerts: false } }), { faceRecognition: true });
  assert.equal(p.enabled, true);
  assert.equal(p.fps, 8);
  assert.equal(p.purpose, 'Reception');
  assert.equal(p.watchlistAlerts, false);
});

test('enable payload never sends detectionZones unless asked', () => {
  const p = buildEnablePayload(row({ ai: { detectionZones: [{ id: 'z' }] } }), { faceRecognition: true });
  assert.equal('detectionZones' in p, false);
  assert.deepEqual(buildEnablePayload(row(), { detectionZones: [], faceRecognition: true }).detectionZones, []);
});

test('purpose is inferred from the camera name when never set', () => {
  assert.equal(buildEnablePayload(row(), { faceRecognition: true }).purpose, 'Main gate');
});

test('disable payload keeps choices but turns off', () => {
  const p = buildDisablePayload(row({ ai: { enabled: true, journeyMapping: false } }));
  assert.equal(p.enabled, false);
  assert.equal(p.mode, 'off');
  assert.equal(p.journeyMapping, false);
});

test('features: nothing is on while AI is off', () => {
  assert.deepEqual(activeFeatureLabels(row()), []);
});

test('features: flags and drawn shapes show when AI is on', () => {
  const r = row({
    ai: {
      enabled: true, watchlistAlerts: false,
      detectionZones: [{ shape: 'polygon', enabled: true }, { shape: 'line', enabled: true }],
    },
  });
  // No 'Journey': journey mapping is a feature built on the face model's
  // output, not a model, and Person Tracker owns the per-camera choice.
  // 'Footfall' and not 'Count': the fixture draws a LINE, which is footfall.
  // Head count needs a counting AREA, and this camera has none -- the two
  // used to be one row and could not tell you that.
  assert.deepEqual(activeFeatureLabels(r), ['Face', 'Footfall', 'Zone']);
});

test('features: head count is READY only when a gate line is drawn', () => {
  // This test used to be called "a drawn gate ..." while its fixture drew
  // nothing -- `headcount.enabled` with `zones: []` -- and asserted that the
  // bare flag counted as a drawn gate. That is the defect: the row said
  // "Ready" on cameras with no gate line at all. The flag is the row's
  // TOGGLE; a drawn zone is its setup state. They are different questions.
  const flagOnly = cameraFeatures(row({ headcount: { enabled: true, zones: [] } }));
  const bare = flagOnly.find((x) => x.key === 'head_count');
  assert.equal(bare.on, false);
  assert.equal(bare.needsSetup, false, 'a flag with nothing drawn is not a gate');
});

test('features: a drawn gate on a camera with AI off needs setup', () => {
  const f = cameraFeatures(row({ headcount: { enabled: false, zones: [{ enabled: true }] } }));
  const count = f.find((x) => x.key === 'head_count');
  assert.equal(count.on, false);
  assert.equal(count.needsSetup, true);
});

test('features: this panel lists models, so alerts and journey are not rows', () => {
  // An alert is not a model, it is what a model can tell you; journey mapping
  // is a feature built on the face model's output and Person Tracker owns it.
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  for (const key of ['unknown_alerts', 'watchlist_alerts', 'journey']) {
    assert.equal(f.find((x) => x.key === key), undefined, `${key} must not be a row`);
  }
  assert.deepEqual(f.map((x) => x.key),
    ['face', 'head_count', 'footfall', 'restricted_zone', 'zone_body']);
});

test('the flags the panel stopped showing are still carried through a save', () => {
  // Removing a row must not quietly clear the value on the camera.
  const p = buildEnablePayload(row({ ai: { unknownAlerts: false, watchlistAlerts: false, journeyMapping: false } }), { faceRecognition: true });
  assert.equal(p.unknownAlerts, false);
  assert.equal(p.watchlistAlerts, false);
  assert.equal(p.journeyMapping, false);
});

test('a setup row links to the camera it was opened from', () => {
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  const count = f.find((x) => x.key === 'head_count');
  const foot = f.find((x) => x.key === 'footfall');
  const zone = f.find((x) => x.key === 'restricted_zone');
  // Both used to link to a bare /occupancy/zone-setup, which opens on whatever
  // camera that page picks for itself.
  assert.equal(featureSetupPath(foot, row()), '/occupancy/zone-setup?gate=m1');
  // Head count is an AREA, so it opens the camera, not the line editor.
  assert.equal(featureSetupPath(count, row()), '/occupancy/zone-setup?zone=m1');
  // `zone`, NOT `cam`. ZoneSetup's zone lookup falls through to opening a
  // camera on its own whole view when no zone has that id, which is exactly
  // "draw the first zone on this camera". `cam` only picks which camera
  // inside an ALREADY-CHOSEN zone is shown, so it was silently ignored and
  // the link landed on whichever zone the page defaulted to.
  assert.equal(featureSetupPath(zone, row()), '/occupancy/zone-setup?zone=m1');
  assert.notEqual(featureSetupPath(zone, row()), '/occupancy/zone-setup?cam=m1');
});

test('a setup link falls back to the bare page rather than a broken one', () => {
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  const foot = f.find((x) => x.key === 'footfall');
  assert.equal(featureSetupPath(foot, {}), '/occupancy/zone-setup');
  assert.equal(featureSetupPath(foot, undefined), '/occupancy/zone-setup');
  assert.equal(featureSetupPath({}, row()), '');
});

test('a monitorId with URL characters is encoded', () => {
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  const foot = f.find((x) => x.key === 'footfall');
  assert.equal(
    featureSetupPath(foot, { monitorId: 'cam 1&x=2' }),
    '/occupancy/zone-setup?gate=cam%201%26x%3D2',
  );
});

test('buildEnablePayload REFUSES a caller that has not decided about faces', () => {
  // The guard this replaces read source text and said so about itself: blind
  // to a re-export, a dynamic import, or a helper calling on another module's
  // behalf. A required argument catches all three, because it is the function
  // that refuses rather than a scan of the files around it.
  assert.throws(() => buildEnablePayload(row()), /state `faceRecognition` explicitly/);
  assert.throws(() => buildEnablePayload(row(), {}), /faceRecognition/);
  assert.throws(() => buildEnablePayload(row(), { faceRecognition: undefined }), /faceRecognition/);
  assert.throws(() => buildEnablePayload(row(), { faceRecognition: null }), /faceRecognition/);
  // Not truthiness: a stored string must not be read as a decision.
  assert.throws(() => buildEnablePayload(row(), { faceRecognition: 'true' }), /faceRecognition/);
  // And the message has to say WHY, because it is the only documentation the
  // next caller will read.
  assert.throws(() => buildEnablePayload(row()), /spent a licence|spends a licence|spent\s+a\s+licence/);
});

test('it accepts either decision and sends exactly that', () => {
  assert.equal(buildEnablePayload(row(), { faceRecognition: true }).faceRecognition, true);
  assert.equal(buildEnablePayload(row(), { faceRecognition: false }).faceRecognition, false);
  // Explicit false WINS over a camera whose stored value is on, which is the
  // anonymous-counting case and the whole reason the flag is separable.
  assert.equal(
    buildEnablePayload(row({ ai: { faceRecognition: true } }), { faceRecognition: false }).faceRecognition,
    false,
  );
});

test('buildDisablePayload still needs nothing, and still preserves everything', () => {
  // Switching AI off has none of these problems and must not get harder.
  const p = buildDisablePayload(row({ ai: { enabled: true, fps: 8, detectionInputSize: 1280 } }));
  assert.equal(p.enabled, false);
  assert.equal(p.mode, 'off');
  assert.equal(p.fps, 8);
  assert.equal(p.detectionInputSize, 1280);
  // A camera matching faces keeps that across an off/on cycle.
  assert.equal(buildDisablePayload(row({ ai: { faceRecognition: true } })).faceRecognition, true);
  assert.equal(buildDisablePayload(row({ ai: { faceRecognition: false } })).faceRecognition, false);
});

test('setup path selects the camera', () => {
  assert.equal(aiSetupPath('cam-1'), '/camera-setup?tab=ai-detection&camera=cam-1');
});
