/**
 * Tests for the Event Log's URL contract (log-query.js).
 *
 * Runs on Node's built-in test runner (`npm test`). What a link writes and
 * what the page reads are checked against each other, so the dashboard and
 * the log cannot drift apart on a parameter name or a value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  categoryOf, eventLogHref, parseEventType, parseLogParams, violationOf, viewMatches, zoneMatches,
} from './log-query.js';

const TODAY = '2026-09-26';
const parse = (href) => parseLogParams(new URL(href, 'http://x').searchParams, TODAY);

test('the dashboard link carries site, status and the chosen category', () => {
  assert.equal(
    eventLogHref({ siteId: 'st-01', status: 'UNACKNOWLEDGED', category: 'queue' }),
    '/event-logs?siteId=st-01&status=UNACKNOWLEDGED&category=QUEUE',
  );
  assert.equal(eventLogHref({ siteId: 'st-01', status: 'UNACKNOWLEDGED', category: 'all' }), '/event-logs?siteId=st-01&status=UNACKNOWLEDGED');
  assert.equal(eventLogHref(), '/event-logs');
});

test('a link round-trips into the page filter state', () => {
  const s = parse(eventLogHref({ siteId: 'g7', status: 'new', category: 'COVERAGE', severity: 'low' }));
  assert.equal(s.site, 'g7');
  assert.equal(s.status, 'new');
  assert.equal(s.category, 'coverage');
  assert.equal(s.severity, 'info', 'the dashboard LOW is this log\'s info');
  assert.equal(s.date, TODAY);
});

test('params are case-insensitive and ?site= still works', () => {
  const s = parse('/event-logs?site=g2&status=acknowledged&category=Staff&severity=High&date=2026-09-20');
  assert.deepEqual(
    { site: s.site, status: s.status, category: s.category, severity: s.severity, date: s.date },
    { site: 'g2', status: 'acknowledged', category: 'staff', severity: 'high', date: '2026-09-20' },
  );
});

test('unknown or malformed values widen to "all" / today instead of emptying the log', () => {
  const s = parse('/event-logs?status=maybe&category=weather&severity=extreme&date=1970');
  assert.equal(s.status, 'all');
  assert.equal(s.category, 'all');
  assert.equal(s.severity, 'all');
  assert.equal(s.date, TODAY);
  assert.equal(parse('/event-logs').site, 'all');
});

test('events fall into the dashboard\'s four categories by type', () => {
  assert.equal(categoryOf({ type: 'activity.counter_unattended' }), 'coverage');
  assert.equal(categoryOf({ type: 'activity.queue_exceeded' }), 'queue');
  assert.equal(categoryOf({ type: 'activity.phone_use' }), 'staff');
  assert.equal(categoryOf({ type: 'camera.offline' }), 'system');
  assert.equal(categoryOf({ type: 'vehicle.lpr' }), null);
});

// ── Zone Coverage deep links (the badge in the Live Zone Status table) ───────

test('a zone badge links with the zone, its event type and ACTIVE status', () => {
  assert.equal(
    eventLogHref({ zoneId: 'Apparel', camera: 'CAM-02', eventType: 'UNATTENDED', status: 'ACTIVE' }),
    '/event-logs?zoneId=Apparel&camera=CAM-02&eventType=UNATTENDED&status=ACTIVE',
  );
  // A healthy zone asks only "what has happened here".
  assert.equal(eventLogHref({ zoneId: 'Entrance', camera: 'CAM-01' }), '/event-logs?zoneId=Entrance&camera=CAM-01');
});

test('that link round-trips into the page filter state', () => {
  const s = parse('/event-logs?zoneId=Apparel&eventType=UNATTENDED&status=ACTIVE');
  assert.equal(s.zone, 'Apparel');
  assert.equal(s.type, 'activity.counter_unattended');
  assert.equal(s.status, 'new', 'ACTIVE on the floor is unacknowledged in the log');
});

test('event types accept a friendly word, a raw slug, or neither', () => {
  assert.equal(parseEventType('QUEUE'), 'activity.queue_exceeded');
  assert.equal(parseEventType('low-activity'), 'activity.low_activity');
  assert.equal(parseEventType('phone use'), 'activity.phone_use');
  assert.equal(parseEventType('activity.break_overstay'), 'activity.break_overstay', 'a slug passes through');
  assert.equal(parseEventType('weather'), 'all');
  assert.equal(parseEventType(''), 'all');
});

test('the shortest alias is the one a link writes, and an unknown one is dropped', () => {
  assert.equal(eventLogHref({ eventType: 'activity.counter_unattended' }), '/event-logs?eventType=UNATTENDED');
  assert.equal(eventLogHref({ eventType: 'weather' }), '/event-logs');
});

test('a zone matches on zoneName when it is set, and on the place fields when it is not', () => {
  assert.equal(zoneMatches({ zoneName: 'Apparel Zone' }, 'Apparel'), true);
  assert.equal(zoneMatches({ zoneName: 'Apparel Zone' }, 'Billing 3'), false);
  // No zoneName yet: the camera, its group and the sentence all name the place.
  assert.equal(zoneMatches({ cameraName: 'Apparel cam' }, 'apparel'), true);
  assert.equal(zoneMatches({ detail: 'Billing 3 unattended - no staff detected' }, 'Billing 3'), true);
  assert.equal(zoneMatches({ detail: 'Clock-in - on time' }, 'Apparel'), false);
  // No zone asked for: everything passes, so a link without one never empties.
  assert.equal(zoneMatches({}, 'all'), true);
  assert.equal(zoneMatches({}, ''), true);
});

test('an unknown zone or event type widens rather than empties', () => {
  const s = parse('/event-logs?eventType=nonsense');
  assert.equal(s.type, 'all');
  assert.equal(parse('/event-logs').zone, 'all');
  assert.equal(parse('/event-logs?zone=Apparel').zone, 'Apparel', '?zone= is accepted as well as ?zoneId=');
});


test('staff violations group the detector slugs into four kinds', () => {
  assert.equal(violationOf({ type: 'activity.phone_use' }).kind, 'phone');
  assert.equal(violationOf({ type: 'activity.counter_unattended' }).tone, 'danger');
  assert.equal(violationOf({ type: 'activity.break_overstay' }).badge, 'Over-Break');
  assert.equal(violationOf({ type: 'activity.low_activity' }).kind, 'idle');
  assert.equal(violationOf({ type: 'activity.group_gathering' }).label, 'Group Gathering / Loitering');
  assert.equal(violationOf({ type: 'activity.late_arrival' }), null);
  assert.equal(violationOf({ type: 'attendance.in' }), null);
});

test('quick views narrow by violation, queue and system', () => {
  assert.equal(viewMatches({ type: 'activity.phone_use' }, 'violations'), true);
  assert.equal(viewMatches({ type: 'activity.queue_exceeded' }, 'violations'), false);
  assert.equal(viewMatches({ type: 'activity.queue_exceeded' }, 'queue'), true);
  assert.equal(viewMatches({ type: 'camera.offline' }, 'system'), true);
  assert.equal(viewMatches({ type: 'face.unknown' }, 'all'), true);
});

test('view and violation round-trip, and a violation implies its view', () => {
  assert.equal(eventLogHref({ view: 'queue' }), '/event-logs?view=QUEUE');
  assert.equal(eventLogHref({ violation: 'phone' }), '/event-logs?view=VIOLATIONS&violation=PHONE');
  assert.equal(eventLogHref({ view: 'bogus', violation: 'nope' }), '/event-logs');
  const s = parse('/event-logs?violation=unattended');
  assert.equal(s.view, 'violations');
  assert.equal(s.violation, 'unattended');
  assert.equal(parse('/event-logs?view=System').view, 'system');
  assert.equal(parse('/event-logs?view=whatever').view, 'all');
});
