/**
 * Tests for the admin console's account formatting rules: when a licence is
 * "near the limit" or "expiring", the CSV export escaping, and the audit-log
 * one-liners.
 *
 * Runs on Node's built-in test runner (`npm test`). Only the pure helpers are
 * exercised; downloadCsv needs a DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPIRING_DAYS, csvCell, daysUntil, describeChange, expiryTone, timeAgo, usagePct, usageTone,
} from './format.js';

test('usageTone: no limit (null/undefined) is never tinted', () => {
  assert.equal(usageTone(1000, null), null);
  assert.equal(usageTone(1000, undefined), null);
});

test('usageTone: a zero limit is danger only when something is used', () => {
  assert.equal(usageTone(0, 0), null);
  assert.equal(usageTone(1, 0), 'danger');
});

test('usageTone: at or over the limit is danger, 80 %+ is warning, below is plain', () => {
  assert.equal(usageTone(10, 10), 'danger');
  assert.equal(usageTone(11, 10), 'danger');
  assert.equal(usageTone(8, 10), 'warning');
  assert.equal(usageTone(7, 10), null);
});

test('usagePct: capped at 100 and safe for a zero or missing limit', () => {
  assert.equal(usagePct(15, 10), 100);
  assert.equal(usagePct(5, 10), 50);
  assert.equal(usagePct(1, 3), 33);
  assert.equal(usagePct(3, 0), 100);
  assert.equal(usagePct(0, 0), 0);
  assert.equal(usagePct(3, null), 0);
});

test('expiryTone: past is danger, within EXPIRING_DAYS is warning, unknown is plain', () => {
  assert.equal(expiryTone(-1), 'danger');
  assert.equal(expiryTone(0), 'warning');
  assert.equal(expiryTone(EXPIRING_DAYS), 'warning');
  assert.equal(expiryTone(EXPIRING_DAYS + 1), null);
  assert.equal(expiryTone(null), null);
});

test('csvCell: quotes cells with comma, quote or newline and doubles inner quotes', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('cr\r'), '"cr\r"');
});

test('csvCell: null/undefined become empty; numbers and 0 are kept', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(false), 'false');
});

test('timeAgo: buckets seconds, minutes, hours and days; missing is a dash', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(timeAgo(null), '—');
  assert.equal(timeAgo(ago(10_000)), 'just now');
  assert.equal(timeAgo(ago(5 * 60_000)), '5 min ago');
  assert.equal(timeAgo(ago(3 * 3600_000)), '3 h ago');
  assert.equal(timeAgo(ago(2 * 86400_000)), '2 d ago');
});

test('daysUntil: today is 0 or 1 day left (end of day), yesterday is negative, missing is null', () => {
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  assert.equal(daysUntil(null), null);
  assert.ok(daysUntil(day(0)) >= 0);
  assert.ok(daysUntil(day(-2)) < 0);
  assert.equal(daysUntil(day(10)), daysUntil(day(0)) + 10);
});

test('describeChange: plan change shows before → after with "none" for a first plan', () => {
  assert.equal(describeChange({ action: 'account.plan.changed', payload: { after: { planName: 'Pro' } } }), 'none → Pro');
});

test('describeChange: features change lists what went on and off, or "All features"', () => {
  assert.equal(describeChange({ action: 'account.features.changed', payload: { after: 'all' } }), 'All features');
  assert.equal(
    describeChange({ action: 'account.features.changed', payload: { added: ['map'], removed: ['weapon', 'fire'] } }),
    'on: map · off: weapon, fire',
  );
  assert.equal(describeChange({ action: 'account.features.changed', payload: {} }), 'No change');
});

test('describeChange: licence change shows camera limit and per-feature limits that changed', () => {
  const line = describeChange({
    action: 'account.licences.changed',
    payload: {
      before: { cameraLimit: 10, featureLimits: { face: 2, headcount: 3 } },
      after: { cameraLimit: null, featureLimits: { face: 4, headcount: 3 } },
      switchedOff: { face: ['c1', 'c2'] },
    },
  });
  assert.equal(line, 'cameras 10 → default · face 2 → 4 · switched off: 2 face');
  assert.equal(describeChange({ action: 'account.licences.changed', payload: {} }), 'No change');
});

test('describeChange: suspension shows reason and pluralised users / sessions', () => {
  assert.equal(
    describeChange({ action: 'account.suspended', payload: { reason: 'unpaid', users: 1, sessionsEnded: 3 } }),
    '“unpaid” · 1 user · 3 sessions ended',
  );
});

test('describeChange: password reset flags a failed email; unknown actions are blank', () => {
  assert.equal(describeChange({ action: 'account.user.password_reset_sent', payload: { email: 'a@b.c', sent: false } }), 'a@b.c (email failed)');
  assert.equal(describeChange({ action: 'something.else' }), '');
});
