/**
 * Tests for per-account entitlements: what a customer can see in the sidebar
 * and open by URL.
 *
 * Runs on Node's built-in test runner (`npm test`). entitlements.js has no
 * imports, so it loads as plain ESM.
 *
 * The backend catalog (backend/src/utils/featureCatalog.js) is the other half
 * of the same rule: it is read here with createRequire so the two key lists
 * and the two isFeatureOn implementations cannot drift apart unnoticed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  DEFAULT_ON_KEYS, DEMO_KEYS, OPT_IN_KEYS, ZONE_EDIT_KEYS, WALL_MANAGER_ROLES,
  canManageWalls, featureOn, makeEntitlement, routeAllowed,
} from './entitlements.js';

const require = createRequire(import.meta.url);
const catalog = require('../../../../backend/src/utils/featureCatalog.js');

const sorted = (xs) => [...xs].sort();
const BASIC_NON_DEFAULT = ['map', 'reports'];

// ── featureOn ───────────────────────────────────────────────────────────────

test('featureOn: NULL features is a full account (ordinary and default-on keys on)', () => {
  for (const key of ['map', 'reports', 'headcount', 'face_watchlist', 'playback', 'alerts']) {
    assert.equal(featureOn(null, key), true, key);
    assert.equal(featureOn(undefined, key), true, key);
  }
});

test('featureOn: an empty list [] also means a full account', () => {
  assert.equal(featureOn([], 'map'), true);
  assert.equal(featureOn([], 'person_search'), true);
});

test('featureOn: demo keys are OFF on a full account (NULL and [])', () => {
  for (const key of DEMO_KEYS) {
    assert.equal(featureOn(null, key), false, key);
    assert.equal(featureOn([], key), false, key);
  }
});

test('featureOn: opt-in keys are OFF on a full account (NULL and [])', () => {
  for (const key of OPT_IN_KEYS) {
    assert.equal(featureOn(null, key), false, key);
    assert.equal(featureOn([], key), false, key);
  }
});

test('featureOn: demo and opt-in keys are ON only when listed', () => {
  for (const key of [...DEMO_KEYS, ...OPT_IN_KEYS]) {
    assert.equal(featureOn([key], key), true, key);
    assert.equal(featureOn(['map'], key), false, key);
  }
});

test('featureOn: on a curated list an ordinary key is ON only when listed', () => {
  assert.equal(featureOn(['headcount'], 'headcount'), true);
  assert.equal(featureOn(['headcount'], 'map'), false);
  assert.equal(featureOn(['headcount'], 'face_watchlist'), false);
});

test('featureOn: a default-on key stays ON on a curated list that does not mention it', () => {
  for (const key of DEFAULT_ON_KEYS) assert.equal(featureOn(['headcount'], key), true, key);
});

test('featureOn: "!key" switches a default-on key OFF on a curated list', () => {
  for (const key of DEFAULT_ON_KEYS) {
    assert.equal(featureOn(['headcount', `!${key}`], key), false, key);
  }
  // ...and only that one key.
  assert.equal(featureOn(['!playback'], 'alerts'), true);
});

test('featureOn: "!key" does not turn an ordinary key on (it is not listed)', () => {
  assert.equal(featureOn(['!map'], 'map'), false);
});

test('featureOn: ["_none"] turns every ordinary key off but leaves default-on keys on', () => {
  assert.equal(featureOn(['_none'], 'map'), false);
  assert.equal(featureOn(['_none'], 'headcount'), false);
  assert.equal(featureOn(['_none'], 'playback'), true);
  assert.equal(featureOn(['_none', '!playback'], 'playback'), false);
});

test('featureOn: a stored list shaped like old production lists (Sharda) keeps Live/Playback/Alerts', () => {
  const sharda = ['person_tracker', 'person_search', 'restricted_zone', 'ai_feed', 'face_watchlist', 'headcount', 'footfall', 'reports'];
  for (const key of ['playback', 'alerts', 'monitor_wall', 'camera_health']) assert.equal(featureOn(sharda, key), true, key);
  assert.equal(featureOn(sharda, 'map'), false);
  assert.equal(featureOn(sharda, 'reports'), true);
});

// ── makeEntitlement ─────────────────────────────────────────────────────────

test('makeEntitlement: AI tier is on unless aiEnabled is exactly false', () => {
  assert.equal(makeEntitlement(null).aiOn, true);
  assert.equal(makeEntitlement({}).aiOn, true);
  assert.equal(makeEntitlement({ aiEnabled: true }).aiOn, true);
  assert.equal(makeEntitlement({ aiEnabled: false }).aiOn, false);
});

test('makeEntitlement: features [] / missing / non-array is normalised to null (full account)', () => {
  assert.equal(makeEntitlement({ features: [] }).features, null);
  assert.equal(makeEntitlement({}).features, null);
  assert.equal(makeEntitlement({ features: 'map' }).features, null);
  assert.deepEqual(makeEntitlement({ features: ['map'] }).features, ['map']);
});

test('has: basic keys ignore the AI tier', () => {
  const vmsOnly = makeEntitlement({ aiEnabled: false, features: null });
  for (const key of [...BASIC_NON_DEFAULT, ...DEFAULT_ON_KEYS.filter((k) => k !== 'event_log')]) {
    assert.equal(vmsOnly.has(key), true, key);
  }
});

test('has: AI keys need the AI tier even on a full account', () => {
  const vmsOnly = makeEntitlement({ aiEnabled: false, features: null });
  for (const key of ['face_watchlist', 'person_search', 'headcount', 'restricted_zone', 'ai_feed']) {
    assert.equal(vmsOnly.has(key), false, key);
  }
  assert.equal(makeEntitlement({ features: null }).has('face_watchlist'), true);
});

test('has: event_log (Activity history) needs the AI tier though the backend files it as basic', () => {
  assert.equal(makeEntitlement({ aiEnabled: false }).has('event_log'), false);
  assert.equal(makeEntitlement({ aiEnabled: true }).has('event_log'), true);
});

test('has: an AI opt-in key needs BOTH the listing and the AI tier', () => {
  assert.equal(makeEntitlement({ features: ['investigate_search'] }).has('investigate_search'), true);
  assert.equal(makeEntitlement({ aiEnabled: false, features: ['investigate_search'] }).has('investigate_search'), false);
  assert.equal(makeEntitlement({ features: null }).has('investigate_search'), false);
});

test('has: non-AI opt-in keys (cases, evidence) work on a VMS-only account when listed', () => {
  const e = makeEntitlement({ aiEnabled: false, features: ['investigate_cases', 'evidence_export'] });
  assert.equal(e.has('investigate_cases'), true);
  assert.equal(e.has('evidence_export'), true);
});

test('has: a demo key needs the listing and the AI tier', () => {
  assert.equal(makeEntitlement({ features: ['weapon'] }).has('weapon'), true);
  assert.equal(makeEntitlement({ features: null }).has('weapon'), false);
  assert.equal(makeEntitlement({ aiEnabled: false, features: ['weapon'] }).has('weapon'), false);
});

test('hasAny: true when at least one key is on, false when none is', () => {
  const e = makeEntitlement({ features: ['!playback'] });
  assert.equal(e.hasAny(['playback', 'cloud_recordings']), true);
  const none = makeEntitlement({ features: ['!playback', '!cloud_recordings'] });
  assert.equal(none.hasAny(['playback', 'cloud_recordings']), false);
  assert.equal(e.hasAny([]), false);
});

test('allows: an optIn item is hidden on a full account and shown only when its key is listed', () => {
  const item = { feature: 'headcount', optIn: true };
  assert.equal(makeEntitlement({ features: null }).allows(item, false), false);
  assert.equal(makeEntitlement({ features: ['map'] }).allows(item, false), false);
  assert.equal(makeEntitlement({ features: ['headcount'] }).allows(item, false), true);
});

test('allows: a featureAny item is shown when any of its keys is on', () => {
  const item = { featureAny: ['playback', 'cloud_recordings'] };
  assert.equal(makeEntitlement({ features: ['!playback'] }).allows(item, false), true);
  assert.equal(makeEntitlement({ features: ['!playback', '!cloud_recordings'] }).allows(item, false), false);
});

test('allows: a tagged item follows featureOn (curated list)', () => {
  const e = makeEntitlement({ features: ['headcount'] });
  assert.equal(e.allows({ feature: 'headcount' }, true), true);
  assert.equal(e.allows({ feature: 'person_search' }, true), false);
  assert.equal(e.allows({ feature: 'alerts' }, false), true); // default-on
  assert.equal(e.allows({ feature: 'map' }, false), false);
});

test('allows: a tagged AI key outside an AI group still needs the AI tier', () => {
  const vmsOnly = makeEntitlement({ aiEnabled: false });
  assert.equal(vmsOnly.allows({ feature: 'event_log' }, false), false);
  assert.equal(vmsOnly.allows({ feature: 'investigate_search' }, false), false);
  assert.equal(vmsOnly.allows({ feature: 'alerts' }, false), true);
});

test('allows: untagged items are always shown on a full account, in either group', () => {
  const full = makeEntitlement({ features: null });
  assert.equal(full.allows({}, false), true);
  assert.equal(full.allows({}, true), true);
});

test('allows: on a curated account untagged items show in VMS groups but never in AI groups', () => {
  const curated = makeEntitlement({ features: ['headcount'] });
  assert.equal(curated.allows({}, false), true);
  assert.equal(curated.allows({}, true), false);
});

test('allows: a full account never sees a tagged demo item', () => {
  const full = makeEntitlement({ features: null });
  for (const key of DEMO_KEYS) assert.equal(full.allows({ feature: key }, true), false, key);
});

// ── canManageWalls ──────────────────────────────────────────────────────────

test('canManageWalls: admin/user/manager/owner build walls; operator and viewer do not', () => {
  for (const role of WALL_MANAGER_ROLES) assert.equal(canManageWalls({ role }), true, role);
  assert.equal(canManageWalls({ role: 'operator' }), false);
  assert.equal(canManageWalls({ role: 'viewer' }), false);
  assert.equal(canManageWalls(null), false);
});

// ── routeAllowed ────────────────────────────────────────────────────────────

const FULL = { features: null };
const VMS_ONLY = { aiEnabled: false, features: null };

test('routeAllowed: routes with no rule are always allowed', () => {
  for (const p of ['/home', '/live', '/settings', '/login', '/sites']) {
    assert.equal(routeAllowed(p, { aiEnabled: false, features: ['_none'] }), true, p);
  }
});

test('routeAllowed: a prefix matches itself and its sub-paths, not a longer word', () => {
  const user = { features: ['headcount'] };
  assert.equal(routeAllowed('/map', user), false);
  assert.equal(routeAllowed('/map/site/3', user), false);
  assert.equal(routeAllowed('/mapping', user), true); // no rule for /mapping
  assert.equal(routeAllowed('/investigatex', FULL), true);
  assert.equal(routeAllowed('/investigate', FULL), false);
});

test('routeAllowed: the longest prefix wins (/occupancy/breaches needs restricted_zone, not headcount)', () => {
  const hc = { features: ['headcount'] };
  const rz = { features: ['restricted_zone'] };
  assert.equal(routeAllowed('/occupancy', hc), true);
  assert.equal(routeAllowed('/occupancy/breaches', hc), false);
  assert.equal(routeAllowed('/occupancy', rz), false);
  assert.equal(routeAllowed('/occupancy/breaches', rz), true);
  // Zone setup is reachable with either.
  assert.equal(routeAllowed('/occupancy/zone-setup', hc), true);
  assert.equal(routeAllowed('/occupancy/zone-setup', rz), true);
});

test('routeAllowed: a full account cannot open opt-in investigation pages by URL', () => {
  for (const p of ['/investigate', '/investigate/track', '/investigate/cases', '/investigate/evidence', '/investigate/ask', '/investigate/audio']) {
    assert.equal(routeAllowed(p, FULL), false, p);
  }
});

test('routeAllowed: each investigation page opens with its own key only', () => {
  assert.equal(routeAllowed('/investigate/cases', { features: ['investigate_cases'] }), true);
  assert.equal(routeAllowed('/investigate/cases', { features: ['investigate_search'] }), false);
  assert.equal(routeAllowed('/investigate/evidence', { features: ['evidence_export'] }), true);
  assert.equal(routeAllowed('/investigate/evidence', { features: ['investigate_cases'] }), false);
  assert.equal(routeAllowed('/investigate/track', { features: ['investigate_search'] }), true);
  assert.equal(routeAllowed('/investigate/ask', { features: ['investigate_search'] }), false);
});

test('routeAllowed: Cases and Evidence open on a VMS-only account; Smart Search, Ask and Audio do not', () => {
  const all = { aiEnabled: false, features: [...OPT_IN_KEYS] };
  assert.equal(routeAllowed('/investigate/cases', all), true);
  assert.equal(routeAllowed('/investigate/evidence', all), true);
  assert.equal(routeAllowed('/investigate', all), false);
  assert.equal(routeAllowed('/investigate/ask', all), false);
  assert.equal(routeAllowed('/investigate/audio', all), false);
});

test('routeAllowed: a full account cannot open the sample-data (demo) pages', () => {
  for (const p of ['/ai-analytics/weapon', '/ai-analytics/fire', '/ai-analytics/aggression', '/ai-analytics/vehicle',
    '/activity-monitoring', '/activity-monitoring/headcount', '/attendance-report', '/ai-analytics/productivity',
    '/feature-demos', '/compute-cost', '/ai-analytics/watchlist']) {
    assert.equal(routeAllowed(p, FULL), false, p);
  }
});

test('routeAllowed: a listed demo key opens its demo page', () => {
  assert.equal(routeAllowed('/ai-analytics/weapon', { features: ['weapon'] }), true);
  assert.equal(routeAllowed('/ai-analytics/fire', { features: ['weapon'] }), false);
  assert.equal(routeAllowed('/activity-monitoring/performance', { features: ['activity'] }), true);
});

test('routeAllowed: the mock ai-analytics watchlist opens with a demo key, never with face_watchlist alone', () => {
  assert.equal(routeAllowed('/ai-analytics/watchlist', { features: ['face_watchlist'] }), false);
  assert.equal(routeAllowed('/ai-analytics/watchlist', { features: ['anpr'] }), true);
  assert.equal(routeAllowed('/watchlist', { features: ['face_watchlist'] }), true);
});

test('routeAllowed: AI pages are refused without the AI tier, even on a full account', () => {
  for (const p of ['/watchlist', '/face-learning', '/ai-event/personlsearch', '/ai-event/journeymap', '/person-tracker',
    '/live-tracker', '/occupancy', '/occupancy/breaches', '/ai-feed', '/event-logs']) {
    assert.equal(routeAllowed(p, FULL), true, `${p} (AI on)`);
    assert.equal(routeAllowed(p, VMS_ONLY), false, `${p} (AI off)`);
  }
});

test('routeAllowed: basic pages open on a VMS-only full account', () => {
  for (const p of ['/map', '/reports', '/monitor-wall', '/playback', '/camera-setup', '/health', '/alerts']) {
    assert.equal(routeAllowed(p, VMS_ONLY), true, p);
  }
});

test('routeAllowed: Recordings opens with either playback or cloud_recordings', () => {
  assert.equal(routeAllowed('/playback', { features: ['!playback'] }), true);
  assert.equal(routeAllowed('/playback', { features: ['!cloud_recordings'] }), true);
  assert.equal(routeAllowed('/playback', { features: ['!playback', '!cloud_recordings'] }), false);
});

test('routeAllowed: a default-on page switched off with "!key" is refused', () => {
  assert.equal(routeAllowed('/alerts', { features: ['!alerts'] }), false);
  assert.equal(routeAllowed('/monitor-wall', { features: ['!monitor_wall'] }), false);
  assert.equal(routeAllowed('/health', { features: ['!camera_health'] }), false);
  assert.equal(routeAllowed('/camera-setup/new', { features: ['!camera_setup'] }), false);
});

test('routeAllowed: map and reports need to be listed on a curated account', () => {
  assert.equal(routeAllowed('/map', { features: ['headcount'] }), false);
  assert.equal(routeAllowed('/reports', { features: ['headcount'] }), false);
  assert.equal(routeAllowed('/reports', { features: ['reports'] }), true);
});

test('routeAllowed: a logged-out / unknown user object is treated as a full AI account', () => {
  assert.equal(routeAllowed('/map', null), true);
  assert.equal(routeAllowed('/watchlist', undefined), true);
  assert.equal(routeAllowed('/investigate', null), false);
});

// ── Parity with the backend catalog ─────────────────────────────────────────

test('parity: DEMO_KEYS equals the backend catalog demo keys', () => {
  assert.deepEqual(sorted(DEMO_KEYS), sorted(catalog.DEMO_KEYS));
});

test('parity: OPT_IN_KEYS equals the backend catalog opt-in keys', () => {
  assert.deepEqual(sorted(OPT_IN_KEYS), sorted(catalog.OPT_IN_KEYS));
});

test('parity: DEFAULT_ON_KEYS equals the backend catalog defaultOn keys', () => {
  assert.deepEqual(sorted(DEFAULT_ON_KEYS), sorted(catalog.DEFAULT_ON_KEYS));
});

test('parity: every key the frontend names exists in the backend catalog', () => {
  for (const key of [...DEMO_KEYS, ...OPT_IN_KEYS, ...DEFAULT_ON_KEYS, ...ZONE_EDIT_KEYS, ...BASIC_NON_DEFAULT]) {
    assert.ok(catalog.ALL_FEATURE_KEYS.includes(key), key);
  }
});

test('parity: featureOn agrees with backend isFeatureOn for every catalog key and stored shape', () => {
  const shapes = [
    null, [], ['_none'], ['headcount'], ['headcount', '!playback', '!alerts'],
    ['weapon', 'investigate_search'], [...catalog.ALL_FEATURE_KEYS],
    catalog.DEFAULT_ON_KEYS.map((k) => `!${k}`),
  ];
  for (const features of shapes) {
    for (const key of catalog.ALL_FEATURE_KEYS) {
      assert.equal(featureOn(features, key), catalog.isFeatureOn(features, key), `${JSON.stringify(features)} / ${key}`);
    }
  }
});

test('parity: the frontend AI tier covers exactly the backend AI groups (+ event_log)', () => {
  const everything = [...catalog.ALL_FEATURE_KEYS];
  const vmsOnly = makeEntitlement({ aiEnabled: false, features: everything });
  const aiOn = makeEntitlement({ aiEnabled: true, features: everything });
  for (const key of catalog.ALL_FEATURE_KEYS) {
    const needsAi = catalog.AI_FEATURE_KEYS.includes(key) || key === 'event_log';
    assert.equal(aiOn.has(key), true, `${key} with AI on`);
    assert.equal(vmsOnly.has(key), !needsAi, `${key} with AI off`);
  }
});

test('parity: storedFeatures output reads back as the same set of keys on the frontend', () => {
  const chosen = ['map', 'headcount', 'investigate_cases', 'weapon',
    ...catalog.DEFAULT_ON_KEYS.filter((k) => k !== 'playback')];
  const stored = catalog.storedFeatures(chosen);
  for (const key of catalog.ALL_FEATURE_KEYS) {
    assert.equal(featureOn(stored, key), chosen.includes(key), key);
  }
});
