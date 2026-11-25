/**
 * Drift checks between the sidebar, the route gate and the backend catalog.
 *
 * Sidebar.jsx is JSX (and NAV_SECTIONS is not exported), so it cannot be
 * imported under plain Node. Its rows are read as TEXT instead: every
 * `{ to: '…', … feature: '…' }` / `featureAny: [...]` it declares. That is
 * enough to catch the two mistakes that hurt users:
 *   - a feature key the backend catalog does not know (the admin console can
 *     never switch it on, so the row is dead for curated accounts);
 *   - a sidebar row whose page the route gate refuses for an account that HAS
 *     the row's feature (the link shows, the click bounces to /home).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { routeAllowed } from './entitlements.js';

const require = createRequire(import.meta.url);
const catalog = require('../../../../backend/src/utils/featureCatalog.js');

const sidebarSrc = readFileSync(new URL('../layout/Sidebar.jsx', import.meta.url), 'utf8');
const entitlementsSrc = readFileSync(new URL('./entitlements.js', import.meta.url), 'utf8');

const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** Sidebar rows that carry a `to` and a feature tag on the same line. */
const ROWS = sidebarSrc.split('\n').flatMap((line) => {
  const to = line.match(/\bto:\s*'([^']+)'/);
  if (!to) return [];
  const one = line.match(/\bfeature:\s*'([^']+)'/);
  const any = line.match(/\bfeatureAny:\s*\[([^\]]*)\]/);
  if (!one && !any) return [];
  return [{ to: to[1], keys: one ? [one[1]] : quoted(any[1]) }];
});

const SIDEBAR_KEYS = new Set([
  ...[...sidebarSrc.matchAll(/\bfeature:\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...sidebarSrc.matchAll(/\bfeatureAny:\s*\[([^\]]*)\]/g)].flatMap((m) => quoted(m[1])),
]);

/** Every key named in an `any: [...]` of ROUTE_FEATURES (DEMO_KEYS spread aside). */
const ROUTE_KEYS = new Set(
  [...entitlementsSrc.matchAll(/\bany:\s*\[([^\]]*)\]/g)].flatMap((m) => quoted(m[1])),
);

test('the sidebar source was parsed (guards against a silent regex miss)', () => {
  assert.ok(ROWS.length >= 25, `only ${ROWS.length} tagged rows found`);
  assert.ok(ROUTE_KEYS.size >= 20, `only ${ROUTE_KEYS.size} route keys found`);
});

test('every sidebar feature key exists in the backend feature catalog', () => {
  const unknown = [...SIDEBAR_KEYS].filter((k) => !catalog.ALL_FEATURE_KEYS.includes(k));
  assert.deepEqual(unknown, []);
});

test('every route-gate feature key exists in the backend feature catalog', () => {
  const unknown = [...ROUTE_KEYS].filter((k) => !catalog.ALL_FEATURE_KEYS.includes(k));
  assert.deepEqual(unknown, []);
});

test('a sidebar row opens for an AI account that has exactly that row\'s feature', () => {
  const refused = ROWS.filter(({ to, keys }) => {
    const path = to.split('?')[0];
    return !keys.some((k) => routeAllowed(path, { aiEnabled: true, features: [k] }));
  });
  assert.deepEqual(refused.map((r) => `${r.to} (${r.keys.join('|')})`), []);
});

test('a sidebar row for an opt-in or demo key is refused by URL on a full account', () => {
  const listedOnly = new Set([...catalog.DEMO_KEYS, ...catalog.OPT_IN_KEYS]);
  const leaks = ROWS
    .filter(({ keys }) => keys.every((k) => listedOnly.has(k)))
    .filter(({ to }) => routeAllowed(to.split('?')[0], { features: null }));
  assert.deepEqual(leaks.map((r) => r.to), []);
});
