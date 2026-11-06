/**
 * Tests for the Reports hub's pre-generation scope check.
 *
 * Runs on Node's built-in test runner (`npm test`). scope-cameras.js is pure —
 * two catalogue lists in, a count out — so it needs no browser.
 *
 * The cases that matter are the ones where the count must come back `null`
 * rather than 0: a null leaves Generate preview enabled, and a wrong 0 locks an
 * operator out of a report they are entitled to run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NO_CAMERAS_MESSAGE, scopeCameraCount, scopeCameraWarning } from './scope-cameras.js';

/** A site row as GET /sites returns it, and a group row as GET /groups does. */
const SITES = [
  { id: 1, name: 'HQ', camerasTotal: 12, camerasOnline: 9 },
  { id: 2, name: 'New site', camerasTotal: 0, camerasOnline: 0 },
  { id: 3, name: 'No tally' },                              // server omitted camerasTotal
];
const GROUPS = [
  { id: 'g1', siteId: 1, cameras: [{}, {}, {}] },
  { id: 'g2', siteId: 1, totalChannels: 9, cameras: [] },   // provisioned, not yet synced
  { id: 'g3', siteId: 3, cameras: [{}] },
  { id: 'g4', siteId: 9, cameras: [{}, {}] },               // group whose site is gone
];

const count = (over) => scopeCameraCount({
  sites: SITES, groups: GROUPS, siteId: 'all', groupId: 'all', groupsLoaded: true, ...over,
});

test('a site with cameras is not blocked', () => {
  assert.equal(count({ siteId: '1' }), 12);
});

test('ids compare across types — /sites gives numbers, the Select gives strings', () => {
  assert.equal(count({ siteId: 1 }), 12);
});

test('a site the server tallies at zero is the case this check exists for', () => {
  assert.equal(count({ siteId: '2' }), 0);
});

test('a site with no camerasTotal falls back to its groups', () => {
  assert.equal(count({ siteId: '3' }), 1);
});

test('a site not in the list is unknown, not empty', () => {
  assert.equal(count({ siteId: '77' }), null);
});

test('a camera group answers for itself', () => {
  assert.equal(count({ groupId: 'g1' }), 3);
});

test('a group mid-setup counts its provisioned channels, not its empty array', () => {
  // cameras: [] alongside totalChannels: 9 is a recorder whose channels have
  // not synced yet. Reading that as zero would block a working site.
  assert.equal(count({ groupId: 'g2' }), 9);
});

test('a group not in the list is unknown, not empty', () => {
  assert.equal(count({ groupId: 'gX' }), null);
});

test('the group wins over the site when both are set', () => {
  assert.equal(count({ siteId: '2', groupId: 'g1' }), 3);
});

test('"all sites" takes the whole account', () => {
  assert.equal(count({}), 15);
});

test('a failed GET /groups never produces a zero on its own', () => {
  // Site 3 carries no camerasTotal, so the groups list is the only signal —
  // and it did not arrive.
  assert.equal(scopeCameraCount({
    sites: SITES, groups: [], siteId: '3', groupId: 'all', groupsLoaded: false,
  }), null);
  // The site's own tally still stands when it has one.
  assert.equal(scopeCameraCount({
    sites: SITES, groups: [], siteId: '2', groupId: 'all', groupsLoaded: false,
  }), 0);
});

test('nothing loaded yet is unknown; a loaded empty account is zero', () => {
  assert.equal(scopeCameraCount({ sites: [], groups: [], siteId: 'all', groupId: 'all', groupsLoaded: false }), null);
  assert.equal(scopeCameraCount({ sites: [], groups: [], siteId: 'all', groupId: 'all', groupsLoaded: true }), 0);
});

test('called with nothing at all, it blocks nothing', () => {
  assert.equal(scopeCameraCount(), null);
});

test('the warning names the thing that was actually selected', () => {
  assert.equal(scopeCameraWarning({ count: 0, siteId: '2', groupId: 'all' }), NO_CAMERAS_MESSAGE);
  assert.match(scopeCameraWarning({ count: 0, siteId: 'all', groupId: 'g9' }), /camera group/);
  assert.match(scopeCameraWarning({ count: 0, siteId: 'all', groupId: 'all' }), /account/);
});

test('no warning for a scope with cameras, or one that cannot be known', () => {
  assert.equal(scopeCameraWarning({ count: 12, siteId: '1', groupId: 'all' }), '');
  assert.equal(scopeCameraWarning({ count: null, siteId: '1', groupId: 'all' }), '');
  assert.equal(scopeCameraWarning(), '');
});
