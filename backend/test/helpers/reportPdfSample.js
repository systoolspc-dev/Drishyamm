/**
 * Hand-built page models for the report PDF layout — shared by the unit test
 * and by `node scripts/render-sample-report.js`, which writes them to disk so
 * the layout can be eyeballed without a database.
 */
const sharp = require('sharp');

async function jpeg(w, h, color) {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}

const FOOTNOTE = 'Needs attention counts incidents, not detections: repeated detections of the same thing within 10 minutes count once. '
  + 'Alerts are raised for High and Medium events. Stills are the frames stored at detection; recordings open from Playback.';

const EVENT_COLUMNS = [
  { key: 'when', w: 28, title: 'Date & time' },
  { key: 'snap', w: 26, title: 'Snapshot', cell: 'thumb' },
  { key: 'type', w: 60, title: 'Event' },
  { key: 'camera', w: 48, title: 'Camera' },
  { key: 'sev', w: 20, title: 'Severity', cell: 'severity' },
];

function frame(over = {}) {
  return {
    title: 'AI Event Report',
    typeLabel: 'AI Event Report',
    name: 'AI Event Report · 11 – 18 Sep',
    code: 'DR-AER-20260918-4F2A',
    account: { name: 'Vantage Industries' },
    periodText: '11 Sep 2026 – 18 Sep 2026',
    subtitleTail: 'All sites  ·  18 cameras  ·  All event types',
    tzShort: 'IST',
    about: [
      { dt: 'Period', dd: '11 Sep 2026, 12:00 AM –\n18 Sep 2026, 06:00 PM', wrap: true, tnum: true },
      { dt: 'Scope', dd: 'All sites · 18 cameras', sub: 'Noida Campus · Gurugram Office' },
      { dt: 'Event types', dd: 'All AI events', wrap: true },
      { dt: 'Generated', dd: '18 Sep 2026, 06:12 PM', sub: 'by Rahul Verma', tnum: true },
      { dt: 'Report ID', dd: 'DR-AER-20260918-4F2A', tnum: true },
      { dt: 'Times', dd: 'IST · UTC +05:30' },
    ],
    footnote: FOOTNOTE,
    ...over,
  };
}

/** The AI Event Report: events with stills + evidence. */
async function sampleModel({ rows = 23, evidence = 3, thumb, large } = {}) {
  const thumbBuf = thumb || await jpeg(168, 95, '#808080');
  const largeBuf = large || await jpeg(880, 495, '#606060');
  const mk = (i) => ({
    when: { one: '18 Sep 2026', two: '04:03:12 PM', tnum: true },
    snap: { img: i % 4 === 3 ? null : thumbBuf, box: i % 2 ? [0.5, 0.4, 0.08, 0.25] : null },
    type: { one: i % 3 ? 'Restricted Area Entry' : 'Face Watchlist Match', two: i % 2 ? 'Zone: Loading Bay' : null, evidenceIndex: i < evidence ? i : undefined },
    camera: { one: `Camera ${i + 1}`, two: 'Loading Bay · Noida Campus' },
    sev: i < evidence ? 'critical' : (i % 2 ? 'warning' : 'info'),
    conf: '92%',
  });
  const entries = Array.from({ length: evidence }, (_, i) => ({
    severity: 'critical',
    label: i % 2 ? 'Face Watchlist Match' : 'Restricted Area Entry',
    ref: `${i + 1} of 3`,
    large: i === 1 ? null : largeBuf,
    largeBox: [0.5, 0.42, 0.07, 0.22],
    boxLabel: 'Restricted Area Entry · 92%',
    left: [
      { dt: 'Date & time', dd: '18 Sep 2026, 04:03:12 PM', tnum: true },
      { dt: 'Camera', dd: 'Loading Bay East', sub: 'Loading Bay' },
      { dt: 'Site', dd: 'Noida Campus' },
    ],
    right: [
      { dt: 'Severity', severity: 'critical' },
      { dt: 'Confidence', dd: '92%', tnum: true },
      { dt: 'Reviewed', dd: 'S. Khan', sub: '18 Sep 2026, 04:07 PM', tnum: true },
      { dt: 'Playback', dd: '04:02:42 PM – 04:04:12 PM', sub: 'Loading Bay East', tnum: true },
    ],
    full: [{ dt: 'Matched', dd: 'Vikram Sethi · Watchlist · similarity 96%', key: 'M', wrap: true }],
  }));
  return frame({
    stats: [
      { value: '1,284', label: 'AI events' }, { value: '316', label: 'Alerts raised' },
      { value: '42', label: 'High severity', dot: '#DC2626' }, { value: '27', label: 'Needs attention' },
    ],
    blocks: [
      {
        kind: 'bars', heading: 'What was detected', aside: '1,284 events',
        items: [
          { name: 'Restricted-zone entries', count: 428, share: '33%' },
          { name: 'Unrecognised sightings', count: 312, share: '24%' },
          { name: 'Crowding & capacity', count: 214, share: '17%' },
          { name: 'Recognised people', count: 156, share: '12%' },
          { name: 'Vehicles', count: 98, share: '8%' },
          { name: 'Other', count: 76, share: '6%', other: true },
        ],
      },
      {
        kind: 'table', heading: 'Cameras with most events', aside: 'Top 5 of 18 cameras',
        columns: [
          { key: 'camera', w: 34, title: 'Camera' }, { key: 'where', title: 'Location · Site' },
          { key: 'events', w: 16, title: 'Events', align: 'right' }, { key: 'high', w: 14, title: 'High', align: 'right' },
        ],
        rows: [
          { camera: 'Loading Bay East', where: { text: 'Loading Bay', sub: 'Noida Campus' }, events: '214', high: '19' },
          { camera: 'Atrium North', where: { text: 'Atrium', sub: 'Noida Campus' }, events: '186', high: '4' },
          { camera: 'Reception Desk', where: { text: 'Reception', sub: 'Noida Campus' }, events: '171', high: '11' },
          { camera: 'Cafeteria Wide', where: { text: 'Cafeteria', sub: 'Gurugram Office' }, events: '143', high: '2' },
          { camera: 'Corridor B L2', where: { text: 'Corridor B, Level 2', sub: 'Gurugram Office' }, events: '92', high: '0' },
        ],
        rest: { camera: '13 other cameras', events: '478', high: '6' },
      },
    ],
    sections: [
      {
        kind: 'records', heading: 'Recent events', label: 'Recent events (newest 23 of 1,284 events)',
        columns: EVENT_COLUMNS, rows: Array.from({ length: rows }, (_, i) => mk(i)),
        asideOf: (a, b) => `Events ${a} – ${b} of 1,284 · newest first · all times IST`,
        emptyAside: 'No events · all times IST',
        footnote: rows ? 'Showing the 23 most recent of 1,284 events in this period. The CSV export carries the complete list.' : null,
      },
      ...(entries.length ? [{
        kind: 'evidence', heading: 'High-priority evidence', label: 'High-priority evidence (42 events)',
        aside: '42 High-severity events · newest first',
        entries, footnote: 'Showing the 3 most recent of 42 High-severity events.',
      }] : []),
    ],
  });
}

/** A Camera Health Report: a status table without stills, no evidence. */
function cameraHealthModel({ cameras = 18 } = {}) {
  const mk = (i) => {
    const offline = i < 3;
    return {
      camera: { one: `Camera ${i + 1}`, two: `${i % 2 ? 'Loading Bay' : 'Atrium'} · Noida Campus` },
      status: offline ? { label: 'Offline', tone: 'bad' } : { label: 'Online', tone: 'ok' },
      events: offline ? '0' : String(120 + i),
      extra: offline ? '0' : String(i),
      lastEvent: offline ? { one: 'No data', muted: true } : { one: '18 Sep 2026', two: '05:58:41 PM', tnum: true },
      lastSeen: { one: '18 Sep 2026', two: offline ? '09:12:00 AM' : '06:00:03 PM', tnum: true },
    };
  };
  return frame({
    title: 'Camera Health Report',
    typeLabel: 'Camera Health Report',
    name: 'Camera Health Report · 11 – 18 Sep',
    code: 'DR-CHR-20260918-4F2A',
    subtitleTail: 'All sites  ·  18 cameras  ·  Cameras going offline',
    stats: [
      { value: '18', label: 'Cameras in scope' }, { value: '15', label: 'Online now' },
      { value: '3', label: 'Offline now', dot: '#DC2626' }, { value: '83.3%', label: 'Coverage' },
    ],
    blocks: [
      {
        kind: 'table', heading: 'Cameras offline now', aside: '3 cameras not online at export',
        columns: [{ key: 'camera', title: 'Camera' }, { key: 'where', w: 60, title: 'Location · Site' }, { key: 'lastSeen', w: 40, title: 'Last seen' }],
        rows: [1, 2, 3].map((i) => ({ camera: `Camera ${i}`, where: { text: 'Atrium', sub: 'Noida Campus' }, lastSeen: '18 Sep 2026, 09:12 AM' })),
      },
      {
        kind: 'table', heading: 'Cameras that sent no data', aside: '3 cameras silent in the period',
        columns: [{ key: 'camera', title: 'Camera' }, { key: 'status', w: 30, title: 'Status now' }],
        rows: [1, 2, 3].map((i) => ({ camera: `Camera ${i}`, status: { text: 'Offline', tone: 'bad' } })),
        note: 'Anything that happened on a silent camera is missing from this report.',
      },
    ],
    sections: [{
      kind: 'records', heading: 'Camera status', label: 'Camera status (18 cameras, offline first)',
      columns: [
        { key: 'camera', w: 46, title: 'Camera' },
        { key: 'status', w: 22, title: 'Status now', cell: 'status' }, { key: 'events', w: 16, title: 'Events', align: 'right', cell: 'num' },
        { key: 'extra', w: 20, title: 'Alerts', align: 'right', cell: 'num' }, { key: 'lastEvent', w: 39, title: 'Last event' }, { key: 'lastSeen', w: 39, title: 'Last seen' },
      ],
      rows: Array.from({ length: cameras }, (_, i) => mk(i)),
      asideOf: (a, b) => `Cameras ${a} – ${b} of ${cameras} · offline first · all times IST`,
    }],
    footnote: 'Status is the stream supervisor’s view at export. Uptime history is not recorded yet, so this report shows which cameras sent data in the period and how each one is now.',
  });
}

module.exports = { sampleModel, cameraHealthModel, jpeg };
