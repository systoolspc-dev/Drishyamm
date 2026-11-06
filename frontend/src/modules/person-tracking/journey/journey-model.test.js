/**
 * Tests for the journey model.
 *
 * Runs on Node's built-in test runner — `npm run test:journey` — so the repo
 * gains no test dependency for this. The whole point of `journey-model.js`
 * being pure is that the cluster rules can be checked as a table of inputs and
 * expected node counts, with no DOM, no renderer and no React.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GAP_THRESHOLD_MS,
  NODE,
  ORDER,
  buildNodes,
  buildTimeAxis,
  clusterStops,
  detectGaps,
  buildPlaylist,
  cameraOf,
  clipOf,
  filterHistory,
  locateInPlaylist,
  nodeAt,
  nodeStateAt,
  orderNodes,
  terminalNodes,
  isTruncated,
  wallAt,
} from './journey-model.js';

// ── Fixture helper ──────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 8, 18, 10, 0, 0);

/** One stop, `atMin` minutes into the journey, lasting `forSec`. */
const stop = (zone, atMin, forSec = 20, extra = {}) => ({
  label: `${zone} - CAM ${String(atMin).padStart(2, '0')}`,
  zone,
  monitor_id: `mon-${zone}`,
  first_seen_at: new Date(T0 + atMin * 60_000).toISOString(),
  last_seen_at: new Date(T0 + atMin * 60_000 + forSec * 1000).toISOString(),
  duration_sec: forSec,
  type: 'normal',
  ...extra,
});

/** `n` stops one minute apart through one zone, starting at `fromMin`. */
const run = (zone, fromMin, n, extra = {}) =>
  Array.from({ length: n }, (_, i) => stop(zone, fromMin + i, 20, extra));

// ── clusterStops: the table ─────────────────────────────────────────────────

test('clusterStops: the rule table', () => {
  const cases = [
    {
      name: 'empty input yields no nodes',
      stops: [],
      expect: [],
    },
    {
      name: 'a single stop is a START anchor, never a cluster',
      stops: [stop('Entry', 0)],
      expect: [NODE.START],
    },
    {
      name: 'two stops are both anchors — there is no middle',
      stops: [stop('Entry', 0), stop('Exit', 5)],
      expect: [NODE.START, NODE.END],
    },
    {
      name: 'a run of 3 through one zone between anchors collapses to one cluster',
      stops: [stop('Entry', 0), ...run('Corridor', 1, 3), stop('Exit', 9)],
      expect: [NODE.START, NODE.CLUSTER, NODE.END],
    },
    {
      name: 'a lone middle stop stays a sighting — one card is not worth cluster chrome',
      stops: [stop('Entry', 0), stop('Lobby', 2), stop('Exit', 5)],
      expect: [NODE.START, NODE.SIGHTING, NODE.END],
    },
    {
      name: 'two zones make two clusters',
      stops: [stop('Entry', 0), ...run('Corridor', 1, 3), ...run('Atrium', 5, 3), stop('Exit', 12)],
      expect: [NODE.START, NODE.CLUSTER, NODE.CLUSTER, NODE.END],
    },
    {
      name: 'an alert inside a run splits it and is never swallowed',
      stops: [
        stop('Entry', 0),
        ...run('Corridor', 1, 3),
        stop('Server Room', 5, 0, { type: 'alert', note: 'Restricted area entry' }),
        ...run('Corridor', 7, 3),
        stop('Exit', 14),
      ],
      expect: [NODE.START, NODE.CLUSTER, NODE.ALERT, NODE.CLUSTER, NODE.END],
    },
    {
      name: 'a gap splits a run through the SAME zone into two visits',
      stops: [
        stop('Entry', 0),
        ...run('Corridor', 1, 3),
        ...run('Corridor', 40, 3),
        stop('Exit', 60),
      ],
      expect: [NODE.START, NODE.CLUSTER, NODE.CLUSTER, NODE.END],
    },
    {
      name: 'null zone falls back to the camera label, not one shared bucket',
      stops: [
        stop('Entry', 0),
        { ...stop('x', 1), zone: null, label: 'CAM A' },
        { ...stop('x', 2), zone: null, label: 'CAM B' },
        stop('Exit', 9),
      ],
      // Two different cameras, so two sightings — not one bogus cluster.
      expect: [NODE.START, NODE.SIGHTING, NODE.SIGHTING, NODE.END],
    },
    {
      name: 'null zone on the same camera twice does cluster',
      stops: [
        stop('Entry', 0),
        { ...stop('x', 1), zone: null, label: 'CAM A' },
        { ...stop('x', 2), zone: null, label: 'CAM A' },
        stop('Exit', 9),
      ],
      expect: [NODE.START, NODE.CLUSTER, NODE.END],
    },
    {
      name: 'an alert as the last stop is the END anchor, not a duplicate',
      stops: [
        stop('Entry', 0),
        ...run('Corridor', 1, 3),
        stop('Server Room', 8, 0, { type: 'alert', note: 'Restricted area entry' }),
      ],
      expect: [NODE.START, NODE.CLUSTER, NODE.END],
    },
    {
      name: 'out-of-order input is sorted before clustering',
      stops: [stop('Exit', 9), ...run('Corridor', 1, 3), stop('Entry', 0)],
      expect: [NODE.START, NODE.CLUSTER, NODE.END],
    },
    {
      name: 'stops with an unparseable timestamp are dropped, not rendered as 1970',
      stops: [stop('Entry', 0), { ...stop('Corridor', 2), first_seen_at: 'not a date' }, stop('Exit', 5)],
      expect: [NODE.START, NODE.END],
    },
  ];

  for (const c of cases) {
    const kinds = clusterStops(c.stops).map((n) => n.kind);
    assert.deepEqual(kinds, c.expect, c.name);
  }
});

test('clusterStops: an alert run is never hidden behind a cluster label', () => {
  // Twelve sightings through one corridor, one of which is a violation.
  const stops = [
    stop('Entry', 0),
    ...run('Corridor', 1, 6),
    stop('Corridor', 7, 0, { type: 'alert', note: 'Tailgating' }),
    ...run('Corridor', 8, 5),
    stop('Exit', 20),
  ];
  const nodes = clusterStops(stops);
  const alerts = nodes.filter((n) => n.kind === NODE.ALERT);
  assert.equal(alerts.length, 1, 'the violation is its own node');
  assert.equal(alerts[0].count, 1, 'and it carries exactly one sighting');
  assert.ok(alerts[0].alert, 'with an alert payload attached');
  assert.equal(alerts[0].alert.structured, false, 'read from `note` until the API sends an object');
  assert.equal(alerts[0].alert.message, 'Tailgating');
});

test('clusterStops: cluster carries the run span, not just the first stop', () => {
  const nodes = clusterStops([stop('Entry', 0), ...run('Corridor', 1, 12), stop('Exit', 20)]);
  const cluster = nodes.find((n) => n.kind === NODE.CLUSTER);
  assert.equal(cluster.count, 12);
  // First stop starts at +1m, twelfth starts at +12m and runs 20s.
  assert.equal(cluster.firstSeenMs, T0 + 1 * 60_000);
  assert.equal(cluster.lastSeenMs, T0 + 12 * 60_000 + 20_000);
  assert.equal(cluster.dwellMs, 11 * 60_000 + 20_000);
});

// ── The headline claim, measured ────────────────────────────────────────────

test('clusterStops: a 400-sighting journey collapses to a readable card count', () => {
  // 9 zones, cycled, mean run 11 -> the shape the proposal assumed.
  const zones = ['Entry Hall', 'Lobby', 'Floor 1 Corridor', 'Floor 2 Corridor',
    'Canteen', 'Atrium', 'Stairwell B', 'Loading Bay', 'Car Park'];
  const stops = [];
  let minute = 0;
  let z = 0;
  while (stops.length < 400) {
    const len = Math.min(11, 400 - stops.length);
    stops.push(...run(zones[z % zones.length], minute, len));
    minute += len;
    z += 1;
  }
  assert.equal(stops.length, 400);

  const nodes = buildNodes(stops);
  // Reported rather than asserted tightly: the proposal's ~36 was arithmetic,
  // this is the measurement. Guard only the property that matters — that the
  // canvas is readable, i.e. well under a hundred cards.
  assert.ok(nodes.length < 60, `400 sightings -> ${nodes.length} cards`);
  assert.ok(nodes.length > 20, `400 sightings -> ${nodes.length} cards`);
  assert.equal(nodes[0].kind, NODE.START);
  assert.equal(nodes[nodes.length - 1].kind, NODE.END);
  assert.equal(
    nodes.reduce((n, node) => n + node.count, 0),
    400,
    'every sighting survives clustering — none are dropped',
  );
  console.log(`    400 sightings, 9 zones, mean run 11 -> ${nodes.length} cards`);
});

// ── detectGaps ──────────────────────────────────────────────────────────────

test('detectGaps: marks only holes over the threshold, and never the first node', () => {
  const nodes = clusterStops([
    stop('Entry', 0),
    stop('Lobby', 1),          // 40s after Entry ends -> under threshold
    stop('Atrium', 40),        // ~39m after Lobby ends -> over
    stop('Exit', 41),
  ]);
  const withGaps = detectGaps(nodes, GAP_THRESHOLD_MS);
  assert.equal(withGaps[0].gapBeforeMs, null, 'nothing precedes the first node');
  assert.equal(withGaps[1].gapBeforeMs, null, 'a 40-second hop is not a finding');
  assert.ok(withGaps[2].gapBeforeMs > 30 * 60_000, 'a 39-minute hole is');
  assert.equal(withGaps[3].gapBeforeMs, null);
});

test('detectGaps: is idempotent', () => {
  const once = buildNodes([stop('Entry', 0), stop('Atrium', 40), stop('Exit', 41)]);
  const twice = detectGaps(once, GAP_THRESHOLD_MS);
  assert.deepEqual(twice.map((n) => n.gapBeforeMs), once.map((n) => n.gapBeforeMs));
});

// ── buildTimeAxis ───────────────────────────────────────────────────────────

test('buildTimeAxis: bounds come from the nodes and every tick lands inside them', () => {
  const nodes = buildNodes([stop('Entry', 0), ...run('Corridor', 5, 4), stop('Exit', 30)]);
  const axis = buildTimeAxis(nodes);
  assert.ok(axis.startMs < T0, 'padded before the first sighting');
  assert.ok(axis.endMs > T0 + 30 * 60_000, 'padded after the last');
  assert.ok(axis.ticks.length > 1 && axis.ticks.length <= 8);
  for (const t of axis.ticks) {
    assert.ok(t.ms >= axis.startMs && t.ms <= axis.endMs, 'tick inside bounds');
    assert.ok(t.pct >= 0 && t.pct <= 100, 'tick position inside the track');
  }
});

test('buildTimeAxis: an empty journey has no axis rather than a zero-width one', () => {
  const axis = buildTimeAxis([]);
  assert.equal(axis.startMs, null);
  assert.equal(axis.ticks.length, 0);
});

// ── nodeStateAt / nodeAt ────────────────────────────────────────────────────

test('nodeStateAt: past, active, future — and no cursor means the journey happened', () => {
  const [node] = clusterStops([stop('Entry', 10, 120)]);
  assert.equal(nodeStateAt(node, null), 'past', 'nobody is scrubbing');
  assert.equal(nodeStateAt(node, T0 + 5 * 60_000), 'future');
  assert.equal(nodeStateAt(node, T0 + 10 * 60_000 + 60_000), 'active');
  assert.equal(nodeStateAt(node, T0 + 30 * 60_000), 'past');
});

test('nodeAt: inside a node returns it; between nodes returns the last one passed', () => {
  const nodes = buildNodes([stop('Entry', 0, 60), stop('Lobby', 10, 60), stop('Exit', 20, 60)]);
  assert.equal(nodeAt(nodes, T0 + 10 * 60_000 + 30_000).label, nodes[1].label, 'inside');
  assert.equal(nodeAt(nodes, T0 + 15 * 60_000).label, nodes[1].label, 'between -> previous');
  assert.equal(nodeAt(nodes, null), null, 'no cursor, no node');
});

// ── filterHistory ───────────────────────────────────────────────────────────

test('filterHistory: restricted and long-dwell narrow to the right nodes', () => {
  const nodes = buildNodes([
    stop('Entry', 0, 30),
    ...run('Corridor', 1, 3),
    stop('Server Room', 6, 0, { type: 'alert', note: 'Restricted area entry' }),
    stop('Canteen', 8, 20 * 60),
    stop('Exit', 40, 30),
  ]);

  assert.equal(filterHistory(nodes, 'all').length, nodes.length);

  const restricted = filterHistory(nodes, 'restricted');
  assert.equal(restricted.length, 1);
  assert.equal(restricted[0].kind, NODE.ALERT);

  const long = filterHistory(nodes, 'longDwell');
  assert.ok(long.length >= 1);
  assert.ok(long.every((n) => n.dwellMs > 5 * 60_000), 'every row really is a long dwell');
});

// ── Playlist (Route Flow player) ────────────────────────────────────────────

test('buildPlaylist: one segment per sighting, in order, tagged with its node', () => {
  const nodes = buildNodes([stop('Entry', 0), ...run('Corridor', 1, 3), stop('Exit', 9)]);
  const list = buildPlaylist(nodes);
  assert.equal(list.length, 5, 'a cluster of three is three clips');
  assert.deepEqual(list.map((s) => s.index), [0, 1, 2, 3, 4]);
  assert.equal(list[1].nodeId, list[3].nodeId, 'the cluster sightings share their card');
  assert.deepEqual([list[1].stopIndex, list[3].stopIndex, list[3].stopCount], [0, 2, 3]);
  assert.ok(list.every((s, i) => i === 0 || s.firstSeenMs >= list[i - 1].firstSeenMs));
});

test('buildPlaylist: the gap sits on the first clip after it, matching the node', () => {
  // Main Gate 00:00-00:34, Reception at 04:00 -> 3m26s unmonitored.
  const nodes = buildNodes([
    stop('Main Gate', 0, 34),
    stop('Reception', 4, 120),
    stop('Office', 7, 60),
    stop('Server Room', 9, 0, { type: 'alert', note: 'Restricted area entry' }),
  ]);
  const list = buildPlaylist(nodes);
  assert.equal(list[0].gapBeforeMs, null);
  assert.equal(list[1].gapBeforeMs, (4 * 60 - 34) * 1000);
  assert.equal(list[2].gapBeforeMs, null, 'one minute between cameras is walking, not a gap');
  assert.equal(list[3].alert?.message, 'Restricted area entry');
});

test('cameraOf splits "Location - CAM nn" and falls back sensibly', () => {
  assert.deepEqual(cameraOf({ label: 'Main Gate - CAM 01' }), { location: 'Main Gate', camera: 'CAM 01' });
  assert.deepEqual(cameraOf({ label: 'Lobby', camera_code: 'cam7' }), { location: 'Lobby', camera: 'cam7' });
  assert.deepEqual(cameraOf({ zone: 'Yard', monitor_id: 42 }), { location: 'Yard', camera: '42' });
});

test('clipOf reads the expected fields and refuses what a <video> cannot play', () => {
  assert.equal(clipOf({}), null);
  assert.equal(clipOf({ clip_url: 's3://bucket/key.mp4' }), null);
  assert.deepEqual(
    clipOf({ clip_url: '/a.mp4', clip_start_sec: 5, clip_end_sec: 9 }),
    { src: '/a.mp4', startSec: 5, endSec: 9, startedMs: null },
  );
  assert.equal(clipOf({ clip: { url: 'https://x/y.mp4' } }).src, 'https://x/y.mp4');
});

test('wallAt / locateInPlaylist are inverses, and a gap resolves forward', () => {
  const list = buildPlaylist(buildNodes([stop('A', 0, 60), stop('B', 10, 60)]));
  const mid = wallAt(list[0], 0.5);
  assert.equal(mid, T0 + 30_000);
  assert.deepEqual(locateInPlaylist(list, mid), { index: 0, fraction: 0.5 });
  assert.deepEqual(locateInPlaylist(list, T0 + 5 * 60_000), { index: 1, fraction: 0 }, 'inside the gap -> next clip');
  assert.deepEqual(locateInPlaylist(list, T0 - 1), { index: 0, fraction: 0 });
  assert.equal(locateInPlaylist([], T0), null);
});
// ── View order ──────────────────────────────────────────────────────────────
// The reversal is a VIEW concern, so what these check is that it stays one:
// the ends are found by time rather than by position, and the array the axis
// and the player read is never touched.

test('orderNodes: reverses for the view without mutating the shared array', () => {
  const nodes = buildNodes([stop('Entry', 0), stop('Hall', 5), stop('Desk', 10)]);
  const before = nodes.map((n) => n.id);

  const desc = orderNodes(nodes, ORDER.NEWEST_FIRST);
  assert.deepEqual(desc.map((n) => n.id), before.slice().reverse());

  // The model's own array is what buildTimeAxis and buildPlaylist read.
  assert.deepEqual(nodes.map((n) => n.id), before, 'orderNodes must not mutate');
  assert.notEqual(desc, nodes, 'must be a new array');

  assert.deepEqual(orderNodes(nodes, ORDER.OLDEST_FIRST).map((n) => n.id), before);
  assert.deepEqual(orderNodes(nodes).map((n) => n.id), before, 'ascending by default');
  assert.deepEqual(orderNodes(null, ORDER.NEWEST_FIRST), []);
});

test('terminalNodes: the same two anchors whichever way the list is read', () => {
  const nodes = buildNodes([stop('Entry', 0), stop('Hall', 5), stop('Desk', 10)]);
  const asc = terminalNodes(nodes);
  const desc = terminalNodes(orderNodes(nodes, ORDER.NEWEST_FIRST));

  assert.equal(asc.first.id, desc.first.id, 'first seen is a time, not a position');
  assert.equal(asc.last.id, desc.last.id, 'last seen is a time, not a position');
  assert.equal(asc.first.kind, NODE.START);
  assert.equal(asc.last.kind, NODE.END);
  assert.ok(asc.first.firstSeenMs < asc.last.firstSeenMs);
});

test('terminalNodes: empty and single-stop journeys', () => {
  assert.deepEqual(terminalNodes([]), { first: null, last: null });
  assert.deepEqual(terminalNodes(null), { first: null, last: null });

  const one = buildNodes([stop('Entry', 0)]);
  const { first, last } = terminalNodes(one);
  assert.equal(first.id, last.id, 'one stop is both anchors');
});

test('isTruncated: flags a journey that filled the event cap', () => {
  // The service keeps the OLDEST `limit` events, so hitting the cap means the
  // newest sightings are missing and the last card is not the latest one.
  assert.equal(isTruncated({ raw_event_count: 400 }, 400), true);
  assert.equal(isTruncated({ raw_event_count: 399 }, 400), false);
  assert.equal(isTruncated({ summary: { events: 400 } }, 400), true, 'falls back to summary.events');

  // Absent, unparseable or uncapped reads as "not truncated" — a missing
  // field must not raise a warning banner on a complete journey.
  assert.equal(isTruncated({}, 400), false);
  assert.equal(isTruncated(null, 400), false);
  assert.equal(isTruncated({ raw_event_count: 400 }, 0), false);
});
