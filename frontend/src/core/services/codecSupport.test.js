/**
 * Tests for the H.265 decode probe. It must FAIL CLOSED: anything unexpected
 * reports "cannot decode", so the server keeps transcoding (the old, safe
 * behaviour) instead of sending a stream the browser shows as black.
 *
 * Runs on Node's built-in test runner (`npm test`). The module caches its
 * answer per page load, so each case imports a fresh copy (a unique query
 * string) after setting up a fake `window`.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let n = 0;
const fresh = () => import(`./codecSupport.js?case=${n++}`);

afterEach(() => { delete globalThis.window; });

test('no window (server-side / tests) reports cannot decode', async () => {
  delete globalThis.window;
  const m = await fresh();
  assert.equal(m.canDecodeHevc(), false);
  assert.equal(m.hevcParam(), undefined);
});

test('no MediaSource reports cannot decode', async () => {
  globalThis.window = {};
  const m = await fresh();
  assert.equal(m.canDecodeHevc(), false);
});

test('MediaSource that accepts hvc1 or hev1 reports can decode, and hevcParam is "1"', async () => {
  globalThis.window = { MediaSource: { isTypeSupported: (t) => t.includes('hev1') } };
  const m = await fresh();
  assert.equal(m.canDecodeHevc(), true);
  assert.equal(m.hevcParam(), '1');
});

test('ManagedMediaSource (Safari) is preferred over MediaSource', async () => {
  globalThis.window = {
    ManagedMediaSource: { isTypeSupported: () => true },
    MediaSource: { isTypeSupported: () => false },
  };
  const m = await fresh();
  assert.equal(m.canDecodeHevc(), true);
});

test('a throwing isTypeSupported fails closed', async () => {
  globalThis.window = { MediaSource: { isTypeSupported: () => { throw new Error('boom'); } } };
  const m = await fresh();
  assert.equal(m.canDecodeHevc(), false);
});

test('the answer is cached: later changes to window do not flip it', async () => {
  globalThis.window = { MediaSource: { isTypeSupported: () => false } };
  const m = await fresh();
  assert.equal(m.canDecodeHevc(), false);
  globalThis.window = { MediaSource: { isTypeSupported: () => true } };
  assert.equal(m.canDecodeHevc(), false);
});
