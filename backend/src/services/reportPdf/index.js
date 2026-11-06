'use strict';
/**
 * reportPdf — a saved report as a PDF file.
 *
 *   renderReportPdf({ row, ownerId, exportedBy }) → { pdf: Buffer, model, snapshots }
 *
 * The saved payload supplies the frozen numbers (so the file agrees with the
 * screen); event records, evidence stills, camera status and occupancy
 * history are read back for the same period and scope (data.js). buildModel()
 * turns that into the page model layout.js draws: the same document grammar
 * for every type, with each type deciding its four numbers, its page-1 blocks
 * and its record sections —
 *
 *   ai_events / custom   needs attention · recent events with stills · evidence
 *   face                 needs attention · people seen · recent face events · evidence
 *   restricted_area      needs attention · zones table · recent entries · evidence
 *   incident             incidents (grouped, with first/last seen) · evidence
 *   occupancy            occupancy by camera · daily peak · capacity events
 *   camera_health /
 *   recording            camera status table · offline + silent cameras
 *
 * A report is a summary, not a log. The record sections are capped to the
 * newest few dozen rows and a handful of evidence cards (REPORT_PDF_MAX_*);
 * the CSV export carries the complete list.
 */

const reports = require('../reports.service');
const V = require('./vocabulary');
const layout = require('./layout');
const data = require('./data');
const { SnapshotStore } = require('./snapshots');

function envInt(name, dflt, lo, hi) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
const MAX_EVENTS = envInt('REPORT_PDF_MAX_EVENTS', 30, 10, 5000);
const MAX_EVIDENCE = envInt('REPORT_PDF_MAX_EVIDENCE', 6, 0, 200);
const SNAPSHOTS = String(process.env.REPORT_PDF_SNAPSHOTS || 'on').toLowerCase() !== 'off';

const HIGH = '#DC2626';

const tzShort = (tz) => V.tzLabel(tz).split(' · ')[0];
const plural = (n, one, many) => `${V.nf(n)} ${Number(n) === 1 ? one : (many || `${one}s`)}`;
const conf = (v) => (v > 0 ? V.pct(v) : null);

function durationText(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '—';
  const s = Math.round(Number(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/* ─────────────────────────── shared building blocks ─────────────────────────── */

const EVENT_COLUMNS = [
  { key: 'when', w: 28, title: 'Date & time' },
  { key: 'snap', w: 26, title: 'Snapshot', cell: 'thumb' },
  { key: 'type', w: 60, title: 'Event' },
  { key: 'camera', w: 48, title: 'Camera' },
  { key: 'sev', w: 20, title: 'Severity', cell: 'severity' },
];

/** Camera name with its location · site underneath (portrait has no room for a separate column). */
function cameraCells(cam, monitorId) {
  const name = cam?.name || String(monitorId);
  const where = [cam?.location, cam?.site].filter(Boolean).join(' · ');
  return {
    camera: { one: name, two: where || null },
  };
}

/** One events table row (the AI Event Report's table, reused by face/zone/occupancy). */
function eventRow(ctx, r, { typeCell } = {}) {
  const cam = ctx.camOf(r.monitorId);
  const snap = ctx.store.get(r.id);
  const label = V.eventLabel(r.eventType);
  const detail = V.eventDetail(r);
  const evidenceIndex = ctx.evidenceIndex.get(r.id);
  const type = typeCell ? typeCell(r, label, detail) : { one: label, two: detail };
  if (evidenceIndex != null) type.evidenceIndex = evidenceIndex;
  return {
    when: { one: V.fmtDate(r.ts, ctx.tz), two: V.fmtTime(r.ts, ctx.tz), tnum: true },
    snap: { img: snap?.thumb || null, box: snap?.thumbBox || null },
    type,
    ...cameraCells(cam, r.monitorId),
    sev: r.severity,
  };
}

function eventsSection(ctx, { heading = 'Recent events', label, typeCell, emptyText } = {}) {
  const { ev, tz } = ctx;
  const rows = ev.rows.map((r) => eventRow(ctx, r, { typeCell }));
  return {
    kind: 'records',
    heading,
    label: label || `${heading} (newest ${V.nf(rows.length)} of ${plural(ev.total, 'event')})`,
    columns: EVENT_COLUMNS,
    rows,
    asideOf: (a, b) => `Events ${V.nf(a)} – ${V.nf(b)} of ${V.nf(ev.total)} · newest first · all times ${tzShort(tz)}`,
    emptyAside: `No events · all times ${tzShort(tz)}`,
    emptyText: emptyText || 'No events were recorded in this period for the selected scope.',
    footnote: ev.total > ev.rows.length
      ? `Showing the ${V.nf(ev.rows.length)} most recent of ${V.nf(ev.total)} events in this period. The CSV export carries the complete list.`
      : null,
  };
}

/** The high-priority evidence section, or null when there is nothing to show. */
function evidenceSection(ctx) {
  const { ev, tz, ackNames } = ctx;
  if (!ev.evidence.length) return null;
  const entries = ev.evidence.map((e, i) => {
    const cam = ctx.camOf(e.monitorId);
    const snap = ctx.store.get(e.id);
    const label = V.eventLabel(e.eventType);
    const c = conf(e.confidence);
    const p = e.payload || {};
    const ackName = e.acknowledgedBy ? (ackNames.get(String(e.acknowledgedBy)) || 'an operator') : null;
    const camName = cam?.name || String(e.monitorId);
    const full = [];
    const subject = p.matchedName ? String(p.matchedName).trim() : null;
    if (subject && V.isPersonSubject(e)) {
      const bits = [subject];
      if (p.role === 'blacklist' || p.kind === 'alert') bits.push('Watchlist');
      if (p.similarity != null) bits.push(`similarity ${V.pct(p.similarity)}`);
      full.push({ dt: 'Matched', dd: bits.join(' · '), key: 'M', wrap: true });
    } else if (p.zoneName) {
      full.push({ dt: 'Zone', dd: `${p.zoneName}${subject ? ` · ${subject}` : ''}`, key: 'M', wrap: true });
    } else if (subject) {
      full.push({ dt: 'Subject', dd: subject, key: 'M', wrap: true });
    }
    return {
      severity: e.severity,
      label,
      ref: `${i + 1} of ${V.nf(ev.evidence.length)}`,
      large: snap?.large || null,
      largeBox: snap?.largeBox || null,
      boxLabel: c ? `${label} · ${c}` : label,
      left: [
        { dt: 'Date & time', dd: V.fmtDateTime(e.ts, tz), tnum: true },
        { dt: 'Camera', dd: camName, sub: cam?.location || null },
        { dt: 'Site', dd: cam?.site || '—' },
      ],
      right: [
        { dt: 'Severity', severity: e.severity },
        { dt: 'Confidence', dd: c || '—', tnum: true },
        {
          dt: 'Reviewed',
          dd: e.acknowledgedAt ? ackName : 'Not yet',
          sub: e.acknowledgedAt ? V.fmtDateTime(e.acknowledgedAt, tz, { seconds: false }) : null,
          tnum: true,
        },
        {
          dt: 'Playback',
          dd: `${V.fmtTime(new Date(e.ts.getTime() - 30000), tz)} – ${V.fmtTime(new Date(e.ts.getTime() + 60000), tz)}`,
          sub: camName,
          tnum: true,
        },
      ],
      full,
    };
  });
  return {
    kind: 'evidence',
    heading: 'High-priority evidence',
    label: `High-priority evidence (${plural(ev.totalHigh, 'event')})`,
    aside: `${plural(ev.totalHigh, 'High-severity event')} · newest first`,
    entries,
    footnote: ev.totalHigh > entries.length
      ? `Showing the ${V.nf(entries.length)} most recent of ${V.nf(ev.totalHigh)} High-severity events. The CSV export carries the complete list.`
      : null,
  };
}

/** Bar list of the payload breakdown: top 5 buckets + Other. */
function distributionBlock(ctx, { heading = 'What was detected', excludeRoutine = false } = {}) {
  const { payload, ev } = ctx;
  let items = (Array.isArray(payload.breakdown) ? payload.breakdown : [])
    .filter((b) => !(excludeRoutine && b.routine))
    .map((b) => ({ name: b.name, count: Number(b.detections ?? b.count) || 0 }))
    .filter((b) => b.count > 0);
  if (!items.length && ev.rows.length) {
    const byLabel = new Map();
    for (const r of ev.rows) byLabel.set(V.eventLabel(r.eventType), (byLabel.get(V.eventLabel(r.eventType)) || 0) + 1);
    items = [...byLabel].map(([name, count]) => ({ name, count }));
  }
  items.sort((a, b) => b.count - a.count);
  const total = items.reduce((n, b) => n + b.count, 0);
  const share = (c) => `${total ? Math.round((c / total) * 100) : 0}%`;
  const head = items.slice(0, 5).map((b) => ({ ...b, share: share(b.count) }));
  const rest = items.slice(5);
  const restCount = rest.reduce((n, b) => n + b.count, 0);
  return {
    kind: 'bars',
    heading,
    aside: `${V.nf(total)} events`,
    items: rest.length ? [...head, { name: 'Other', count: restCount, share: share(restCount), other: true }] : head,
    emptyText: 'No events in this period.',
  };
}

/** "Cameras with most events": top 5 from the payload's per-camera totals. */
function camerasBlock(ctx, { heading = 'Cameras with most events', countTitle = 'Events' } = {}) {
  const { payload, ev, camOf } = ctx;
  const byCamera = (Array.isArray(payload.byCamera) ? payload.byCamera : []).filter((c) => (c.count || 0) > 0)
    .sort((a, b) => (b.count || 0) - (a.count || 0));
  const rows = byCamera.slice(0, 5).map((c) => {
    const cam = camOf(c.monitorId);
    return {
      camera: c.name || cam?.name || String(c.monitorId),
      where: { text: cam?.location || '—', sub: c.siteName || cam?.site || null },
      events: V.nf(c.count || 0),
      high: V.nf(ev.perCamera.get(String(c.monitorId))?.high ?? 0),
    };
  });
  const tail = byCamera.slice(5);
  return {
    kind: 'table',
    heading,
    aside: `Top ${rows.length} of ${V.nf(ctx.cameraCount)} cameras`,
    columns: [
      { key: 'camera', w: 34, title: 'Camera' },
      { key: 'where', title: 'Location · Site' },
      { key: 'events', w: countTitle.length > 6 ? 22 : 18, title: countTitle, align: 'right' },
      { key: 'high', w: 14, title: 'High', align: 'right' },
    ],
    rows,
    rest: tail.length ? {
      camera: `${V.nf(tail.length)} other camera${tail.length === 1 ? '' : 's'}`,
      events: V.nf(tail.reduce((n, c) => n + (c.count || 0), 0)),
      high: V.nf(tail.reduce((n, c) => n + (ev.perCamera.get(String(c.monitorId))?.high ?? 0), 0)),
    } : null,
    emptyText: 'No camera reported events in this period.',
  };
}

// One line under the summary page, per report type. Not a legend, not a
// glossary: the one thing a reader has to know to read the numbers right.
const FOOTNOTE = {
  ai_events: 'Needs attention counts incidents, not detections: repeated detections of the same thing within 10 minutes count once. '
    + 'Alerts are raised for High and Medium events. Stills are the frames stored at detection; recordings open from Playback.',
  face: 'Recognised people are enrolled faces matched by the gallery; unrecognised sightings are faces not on file, counted per appearance. '
    + 'Watchlist matches are High severity and appear under evidence.',
  restricted_area: 'Zone entries count incidents: one person crossing a zone repeatedly within 10 minutes is one entry; detections is the raw frame count behind it. '
    + 'Awaiting review are entries nobody has acknowledged yet.',
  incident: 'An incident is one thing happening in one place: repeated detections of the same event, camera and subject within 10 minutes are grouped. '
    + 'Routine face and vehicle traffic is not an incident. Median response is the time from an event to its acknowledgement.',
  occupancy: 'Occupancy is the head count a camera measured, rolled up per minute; overlapping cameras are never summed. '
    + 'Average uses measured minutes only, and measured says how much of the period the camera was actually counting.',
  camera_health: 'Status is the stream supervisor’s view at export. Uptime history is not recorded yet, so this report shows which cameras sent data in the period and how each one is now.',
};

/* ─────────────────────────────── per-type models ─────────────────────────────── */

/**
 * "Needs attention" — the grouped incidents the on-screen report leads with:
 * one row per recurring thing (same event, camera and subject within 10
 * minutes is one occurrence) with how often it recurred. Reports saved before
 * incidents were grouped carry `count` instead of `occurrences`.
 */
function incidentsSection(ctx, { heading = 'Needs attention' } = {}) {
  const { summary, payload, tz, camOf } = ctx;
  const incidents = Array.isArray(payload.incidents) ? payload.incidents : [];
  const rows = incidents.map((inc) => {
    const cam = camOf(inc.monitorId);
    const label = V.eventLabel(inc.eventType);
    const times = inc.occurrences ?? inc.count ?? 1;
    const open = inc.openOccurrences ?? (inc.acknowledgedAt ? 0 : times);
    return {
      what: {
        one: inc.subject && inc.subject !== inc.zone ? `${inc.subject} · ${label}` : label,
        two: inc.zone ? `Zone: ${inc.zone}` : (reports.BUCKET_META[inc.bucket]?.name || null),
      },
      camera: {
        one: inc.cameraName || cam?.name || String(inc.monitorId),
        two: cam?.site ? `${cam.location ? `${cam.location} · ` : ''}${cam.site}` : cam?.location || null,
      },
      last: { one: V.fmtDate(inc.lastSeen, tz), two: V.fmtTime(inc.lastSeen, tz), tnum: true },
      // "since 16 Sep" — the year is on the Last seen cell beside it.
      times: { one: V.nf(times), two: inc.firstSeen ? `since ${V.fmtDate(inc.firstSeen, tz).replace(/ \d{4}$/, '')}` : null, tnum: true },
      sev: inc.severity,
      status: open > 0
        ? { label: `${V.nf(open)} open`, tone: inc.severity === 'critical' ? 'bad' : 'warn' }
        : { label: 'Reviewed', tone: 'ok' },
    };
  });
  return {
    kind: 'records',
    heading,
    label: `${heading} (${plural(rows.length, 'item')})`,
    columns: [
      { key: 'what', w: 46, title: 'Incident' },
      { key: 'camera', w: 42, title: 'Camera' },
      { key: 'last', w: 26, title: 'Last seen' },
      { key: 'times', w: 24, title: 'Times' },
      { key: 'sev', w: 20, title: 'Severity', cell: 'severity' },
      { key: 'status', w: 24, title: 'Status', cell: 'status' },
    ],
    rows,
    asideOf: (a, b) => `${V.nf(a)} – ${V.nf(b)} of ${V.nf(rows.length)} · grouped by what · where · who · all times ${tzShort(tz)}`,
    emptyText: 'Nothing needed attention in this period for the selected scope.',
    footnote: (summary.actionable || 0) > rows.length
      ? `The ${V.nf(rows.length)} most significant of ${V.nf(summary.actionable)} incidents; the CSV export carries the same list.`
      : null,
  };
}

/** The same section for the event-type reports, only when there is something in it. */
const attention = (ctx) => (Array.isArray(ctx.payload.incidents) && ctx.payload.incidents.length ? incidentsSection(ctx) : null);

function aiEventsModel(ctx) {
  const { summary, ev } = ctx;
  return {
    // High / alert counts are read live and type-scoped (data.js); the payload's
    // severity totals cover every event type on the account.
    stats: [
      { value: V.nf(summary.detections ?? ev.total), label: 'AI events' },
      { value: V.nf(ev.totalAlerts), label: 'Alerts raised' },
      { value: V.nf(ev.totalHigh), label: 'High severity', dot: HIGH },
      { value: V.nf(summary.actionable ?? summary.alerts ?? 0), label: 'Needs attention' },
    ],
    blocks: [distributionBlock(ctx), camerasBlock(ctx)],
    sections: [attention(ctx), eventsSection(ctx), evidenceSection(ctx)],
  };
}

function faceModel(ctx) {
  const { summary, ev, payload, tz } = ctx;
  const people = Array.isArray(payload.people) ? payload.people : [];
  const peopleBlock = {
    kind: 'table',
    heading: 'People seen',
    aside: `${plural(people.length, 'recognised person', 'recognised people')} · by sightings`,
    columns: [
      { key: 'name', title: 'Person' },
      { key: 'list', w: 24, title: 'Watchlist' },
      { key: 'sightings', w: 18, title: 'Sightings', align: 'right' },
      { key: 'cameras', w: 18, title: 'Cameras', align: 'right' },
      { key: 'last', w: 40, title: 'Last seen' },
    ],
    rows: [...people].sort((a, b) => (b.sightings || 0) - (a.sightings || 0)).slice(0, 8).map((p) => ({
      name: p.name,
      list: p.watchlisted ? { text: 'Yes', tone: 'bad' } : { text: 'No', tone: 'muted' },
      sightings: V.nf(p.sightings || 0),
      cameras: V.nf((p.cameras || []).length),
      last: V.fmtDateTime(p.lastSeen, tz, { seconds: false }),
    })),
    emptyText: 'No enrolled person was recognised in this period.',
  };
  return {
    stats: [
      { value: V.nf(summary.detections ?? ev.total), label: 'Face events' },
      { value: V.nf(summary.knownPeople ?? people.length), label: 'People recognised' },
      { value: V.nf(summary.unknownSightings ?? 0), label: 'Unrecognised sightings' },
      { value: V.nf(ev.totalHigh), label: 'Watchlist matches', dot: HIGH },
    ],
    blocks: [distributionBlock(ctx, { heading: 'Face events' }), peopleBlock],
    sections: [attention(ctx), eventsSection(ctx, { heading: 'Recent face events' }), evidenceSection(ctx)],
  };
}

function restrictedAreaModel(ctx) {
  const { summary, ev, payload } = ctx;
  const zones = Array.isArray(payload.zones) ? payload.zones : [];
  const zonesBlock = {
    kind: 'table',
    heading: 'Zones with entries',
    aside: `${plural(zones.length, 'zone')} · by entries`,
    columns: [
      { key: 'zone', title: 'Zone' },
      { key: 'camera', w: 46, title: 'Camera' },
      { key: 'entries', w: 18, title: 'Entries', align: 'right' },
      { key: 'detections', w: 22, title: 'Detections', align: 'right' },
    ],
    rows: [...zones].sort((a, b) => (b.entries || 0) - (a.entries || 0)).slice(0, 8).map((z) => ({
      zone: z.zone, camera: z.cameraName, entries: V.nf(z.entries || 0), detections: V.nf(z.detections || 0),
    })),
    emptyText: 'No restricted zone recorded an entry in this period.',
  };
  const typeCell = (r, label, detail) => {
    const zone = r.payload?.zoneName;
    return zone ? { one: zone, two: `${label}${detail && !detail.startsWith('Zone:') ? ` · ${detail}` : ''}` } : { one: label, two: detail };
  };
  return {
    stats: [
      { value: V.nf(summary.alerts ?? 0), label: 'Zone entries' },
      { value: V.nf(summary.detections ?? ev.total), label: 'Detections' },
      { value: V.nf(ev.totalHigh), label: 'High severity', dot: HIGH },
      { value: V.nf(summary.awaitingReview ?? 0), label: 'Awaiting review' },
    ],
    blocks: [zonesBlock, camerasBlock(ctx, { heading: 'Cameras with most entries', countTitle: 'Detections' })],
    sections: [
      attention(ctx),
      eventsSection(ctx, {
        heading: 'Recent zone entries',
        typeCell,
        emptyText: 'No restricted-zone entry was recorded in this period for the selected scope.',
      }),
      evidenceSection(ctx),
    ],
  };
}

function incidentModel(ctx) {
  const { summary } = ctx;
  return {
    stats: [
      { value: V.nf(summary.actionable ?? (ctx.payload.incidents || []).length), label: 'Incidents' },
      { value: V.nf(summary.actionableOpen ?? 0), label: 'Still open', dot: HIGH },
      { value: V.nf(summary.openOver24h ?? 0), label: 'Open over 24 h' },
      { value: durationText(summary.medianSeconds), label: 'Median response' },
    ],
    blocks: [distributionBlock(ctx, { heading: 'What the incidents were', excludeRoutine: true }), camerasBlock(ctx)],
    sections: [incidentsSection(ctx, { heading: 'Incidents' }), evidenceSection(ctx)],
  };
}

function occupancyModel(ctx) {
  const { ev, occ, tz, camOf } = ctx;
  const cams = (occ?.perCamera || []).filter((c) => c.peak != null || c.avg != null);
  const peakCam = cams.reduce((best, c) => (c.peak != null && (best == null || c.peak > best.peak) ? c : best), null);
  const measured = cams.reduce((n, c) => n + c.measuredMinutes, 0);
  const weightedAvg = measured ? cams.reduce((n, c) => n + (c.avg || 0) * c.measuredMinutes, 0) / measured : null;
  const coveragePct = (c) => {
    const pct = (c.measuredMinutes / Math.max(1, occ.periodMinutes)) * 100;
    return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  };

  const byCameraBlock = {
    kind: 'table',
    heading: 'Occupancy by camera',
    aside: `${plural(cams.length, 'camera')} with measurements · by peak`,
    columns: [
      { key: 'camera', title: 'Camera' },
      { key: 'avg', w: 20, title: 'Average', align: 'right' },
      { key: 'peak', w: 16, title: 'Peak', align: 'right' },
      { key: 'peakAt', w: 44, title: 'Peak time' },
      { key: 'measured', w: 22, title: 'Measured', align: 'right' },
    ],
    rows: [...cams].sort((a, b) => (b.peak || 0) - (a.peak || 0)).slice(0, 8).map((c) => {
      const cam = camOf(c.monitorId);
      return {
        camera: { text: cam?.name || c.monitorId, sub: cam?.location || cam?.site || null },
        avg: c.avg == null ? '—' : (Math.round(c.avg * 10) / 10).toString(),
        peak: c.peak == null ? '—' : V.nf(c.peak),
        peakAt: c.peakAt ? V.fmtDateTime(c.peakAt, tz, { seconds: false }) : '—',
        measured: coveragePct(c),
      };
    }),
    emptyText: 'No occupancy was measured in this period. Enable head-count on a camera to start the history.',
  };
  const days = (occ?.daily || []).filter((d) => d.peak != null);
  const dailyBlock = {
    kind: 'bars',
    heading: 'Daily peak occupancy',
    aside: 'highest camera count each day',
    labelW: 28,
    shareW: 22,
    items: days.slice(-7).map((d) => ({
      name: V.fmtDate(`${d.day}T00:00:00Z`, '+00:00'),
      count: d.peak,
      share: d.avg != null ? `avg ${Math.round(d.avg * 10) / 10}` : '',
    })),
    emptyText: 'No measured days in this period.',
  };
  return {
    stats: [
      { value: peakCam ? V.nf(peakCam.peak) : '—', label: 'Peak occupancy' },
      { value: weightedAvg == null ? '—' : (Math.round(weightedAvg * 10) / 10).toString(), label: 'Average occupancy' },
      { value: peakCam?.peakAt ? V.fmtTime(peakCam.peakAt, tz, { seconds: false }) : '—', label: peakCam?.peakAt ? `Peak time · ${V.fmtDate(peakCam.peakAt, tz)}` : 'Peak time' },
      { value: V.nf(ev.totalAlerts), label: 'Capacity events', dot: ev.totalAlerts ? HIGH : null },
    ],
    blocks: [byCameraBlock, dailyBlock],
    sections: [
      attention(ctx),
      eventsSection(ctx, { heading: 'Capacity and crowding events', emptyText: 'No occupancy threshold or crowding event was raised in this period.' }),
      evidenceSection(ctx),
    ],
  };
}

function cameraHealthModel(ctx) {
  const { ev, payload, tz, camOf, row } = ctx;
  const coverage = payload.coverage || {};
  const cameras = ev.cameras.map((c) => ({ ...c, dir: camOf(c.monitorId), stats: ev.perCamera.get(String(c.monitorId)) || null }));
  const online = cameras.filter((c) => c.status === 'online');
  const offline = cameras.filter((c) => c.status !== 'online');
  const isRecording = row.type === 'recording';
  const statusCell = (c) => (c.status === 'online' ? { label: 'Online', tone: 'ok' } : { label: c.status === 'offline' ? 'Offline' : (c.status || 'Unknown'), tone: c.status === 'offline' ? 'bad' : 'muted' });
  const order = (a, b) => (a.status === 'online') - (b.status === 'online') || String(a.name).localeCompare(String(b.name));
  const rows = [...cameras].sort(order).map((c) => ({
    ...cameraCells(c.dir, c.monitorId),
    status: statusCell(c),
    events: c.stats ? V.nf(c.stats.n) : '0',
    extra: isRecording ? (c.dir?.retentionDays != null ? `${V.nf(c.dir.retentionDays)} days` : 'Default') : (c.stats ? V.nf(c.stats.alerts) : '0'),
    lastEvent: c.stats?.last ? { one: V.fmtDate(c.stats.last, tz), two: V.fmtTime(c.stats.last, tz), tnum: true } : { one: 'No data', muted: true },
    lastSeen: c.dir?.lastSeenAt ? { one: V.fmtDate(c.dir.lastSeenAt, tz), two: V.fmtTime(c.dir.lastSeenAt, tz), tnum: true } : { one: '—', muted: true },
  }));
  const section = {
    kind: 'records',
    heading: isRecording ? 'Camera recording status' : 'Camera status',
    label: `${isRecording ? 'Camera recording status' : 'Camera status'} (${plural(rows.length, 'camera')}, offline first)`,
    columns: [
      { key: 'camera', w: 46, title: 'Camera' },
      { key: 'status', w: 22, title: 'Status', cell: 'status' },
      { key: 'events', w: 16, title: 'Events', align: 'right', cell: 'num' },
      { key: 'extra', w: 20, title: isRecording ? 'Retention' : 'Alerts', align: 'right', cell: 'num' },
      { key: 'lastEvent', w: 39, title: 'Last event' },
      { key: 'lastSeen', w: 39, title: 'Last seen' },
    ],
    rows,
    asideOf: (a, b) => `Cameras ${V.nf(a)} – ${V.nf(b)} of ${V.nf(rows.length)} · offline first · status as of export · all times ${tzShort(tz)}`,
    emptyText: 'No camera is in the selected scope.',
  };
  const offlineBlock = {
    kind: 'table',
    heading: 'Cameras offline now',
    aside: `${plural(offline.length, 'camera')} not online at export`,
    columns: [
      { key: 'camera', title: 'Camera' },
      { key: 'where', w: 60, title: 'Location · Site' },
      { key: 'lastSeen', w: 40, title: 'Last seen' },
    ],
    rows: offline.slice(0, 6).map((c) => ({
      camera: c.name,
      where: { text: c.dir?.location || '—', sub: c.dir?.site || null },
      lastSeen: c.dir?.lastSeenAt ? V.fmtDateTime(c.dir.lastSeenAt, tz, { seconds: false }) : '—',
    })),
    rest: offline.length > 6 ? { camera: `${V.nf(offline.length - 6)} more offline` } : null,
    emptyText: 'Every camera in scope is online.',
  };
  const silent = Array.isArray(coverage.silent) ? coverage.silent : [];
  const silentBlock = {
    kind: 'table',
    heading: 'Cameras that sent no data',
    aside: `${plural(coverage.silent?.length ?? (cameras.length - (coverage.reporting || 0)), 'camera')} silent in the period`,
    columns: [
      { key: 'camera', title: 'Camera' },
      { key: 'status', w: 30, title: 'Status now' },
    ],
    rows: silent.slice(0, 6).map((c) => ({ camera: c.name, status: statusCell(c) ? { text: statusCell(c).label, tone: statusCell(c).tone } : '—' })),
    emptyText: 'Every camera in scope sent data during the period.',
    note: 'Anything that happened on a silent camera is missing from this report.',
  };
  return {
    stats: [
      { value: V.nf(cameras.length), label: 'Cameras in scope' },
      { value: V.nf(online.length), label: 'Online now' },
      { value: V.nf(offline.length), label: 'Offline now', dot: offline.length ? HIGH : null },
      { value: `${coverage.percent ?? 0}%`, label: 'Coverage' },
    ],
    blocks: [offlineBlock, silentBlock],
    sections: [section],
  };
}

const BUILDERS = {
  ai_events: aiEventsModel,
  custom: aiEventsModel,
  face: faceModel,
  restricted_area: restrictedAreaModel,
  incident: incidentModel,
  occupancy: occupancyModel,
  camera_health: cameraHealthModel,
  recording: cameraHealthModel,
};

/* ─────────────────────────────── the common frame ─────────────────────────────── */

function buildModel(ctx) {
  const { row, payload, scope, ev, group, tz, from, to } = ctx;
  const typeLabel = payload.typeLabel || reports.TYPE_LABEL[row.type] || 'Report';
  const code = V.reportCode(row, tz);
  const periodText = V.fmtPeriod(from, to, tz);
  const cameraCount = ctx.cameraCount;

  const siteNames = [...new Set(ev.cameras.map((c) => c.siteName).filter(Boolean))];
  const siteText = scope.siteId
    ? (payload.scope?.siteName || ev.cameras.find((c) => c.siteId === scope.siteId)?.siteName || 'Selected site')
    : 'All sites';
  const siteSub = scope.siteId ? null : (siteNames.length ? siteNames.slice(0, 4).join(' · ') + (siteNames.length > 4 ? ' · …' : '') : null);

  let camerasText; let camerasSub;
  if (scope.monitorIds?.length) {
    camerasText = `${V.nf(cameraCount)} selected camera${cameraCount === 1 ? '' : 's'}`;
    camerasSub = ev.cameras.slice(0, 4).map((c) => c.name).join(' · ') + (ev.cameras.length > 4 ? ' · …' : '');
  } else if (scope.groupId) {
    camerasText = `${V.nf(cameraCount)} camera${cameraCount === 1 ? '' : 's'}`;
    camerasSub = group ? `Recorder: ${group}` : 'One recorder';
  } else {
    camerasText = `${V.nf(cameraCount)} camera${cameraCount === 1 ? '' : 's'}`;
    camerasSub = siteSub;
  }

  const buckets = reports.TYPE_BUCKETS[row.type];
  const eventTypeText = buckets ? buckets.map((b) => reports.BUCKET_META[b]?.name || b).join(', ') : 'All AI events';

  // What the report covers, in six lines. Provenance and filters used to be
  // two lists of five; a reader needs the period, the scope and who made it.
  const about = [
    { dt: 'Period', dd: `${V.fmtDateTime(from, tz, { seconds: false })} –\n${V.fmtDateTime(to, tz, { seconds: false })}`, wrap: true, tnum: true },
    { dt: 'Scope', dd: `${siteText} · ${camerasText}`, sub: camerasSub },
    { dt: 'Event types', dd: row.type === 'incident' ? `${eventTypeText} · High and Medium only` : eventTypeText, wrap: true },
    {
      dt: 'Generated', dd: V.fmtDateTime(payload.generatedAt || row.createdAt, tz, { seconds: false }), tnum: true,
      sub: row.createdByName ? `by ${row.createdByName}` : null,
    },
    { dt: 'Report ID', dd: code, tnum: true, sub: row.preview ? 'Preview — not saved to the library' : null },
    { dt: 'Times', dd: V.tzLabel(tz) },
  ];

  const typed = (BUILDERS[row.type] || aiEventsModel)(ctx);
  const sections = (typed.sections || []).filter(Boolean);
  const subtitleTail = [siteText, camerasText, buckets ? eventTypeText : 'All event types'].join('  ·  ');

  return {
    title: typeLabel,
    typeLabel,
    name: row.name,
    code,
    account: ctx.account,
    periodText,
    subtitleTail,
    tzShort: tzShort(tz),
    stats: typed.stats,
    about,
    blocks: typed.blocks || [],
    sections,
    footnote: FOOTNOTE[row.type] || FOOTNOTE.ai_events,
  };
}

/** Everything the builders need, gathered once. */
async function gatherContext({ row, ownerId, exportedBy }) {
  const payload = row.payload || {};
  const params = row.params || {};
  const tz = payload.timezone || reports.TZ;
  const from = new Date(row.periodFrom || payload.from);
  const to = new Date(row.periodTo || payload.to);
  const scope = params.scope || payload.scope || {};
  const wantsEvidence = !['camera_health', 'recording'].includes(row.type);
  const wantsRows = !['camera_health', 'recording'].includes(row.type);

  const [ev, dir, account, group] = await Promise.all([
    data.gatherEvents({
      ownerId, type: row.type, from, to, scope,
      maxRows: wantsRows ? MAX_EVENTS : 1,
      maxEvidence: wantsEvidence ? MAX_EVIDENCE : 0,
    }),
    data.cameraDirectory(ownerId),
    data.accountInfo(ownerId),
    data.groupName(scope.groupId),
  ]);
  if (!wantsRows) ev.rows = [];
  const occ = row.type === 'occupancy'
    ? await data.occupancyStats({ ownerId, from, to, scoped: ev.scoped, tz })
    : null;
  const ackNames = await data.userNames([...ev.rows, ...ev.evidence].map((e) => e.acknowledgedBy));

  const store = new SnapshotStore({ enabled: SNAPSHOTS });
  await store.load([...ev.evidence, ...ev.rows], new Set(ev.evidence.map((e) => e.id)));

  const byCamera = Array.isArray(payload.byCamera) ? payload.byCamera : [];
  return {
    row, payload, params, tz, from, to, scope, ev, dir, account, group, ackNames, store, occ, exportedBy,
    summary: payload.summary || {},
    camOf: (id) => dir.get(String(id)) || null,
    cameraCount: payload.scope?.cameraCount ?? ev.cameras.length,
    camerasWithEvents: byCamera.length ? byCamera.filter((c) => (c.count || 0) > 0).length : ev.perCamera.size,
    evidenceIndex: new Map(ev.evidence.map((e, i) => [e.id, i])),
  };
}

async function renderReportPdf(args) {
  const ctx = await gatherContext(args);
  const model = buildModel(ctx);
  const pdf = await layout.render(model);
  return { pdf, model, snapshots: ctx.store.stats };
}

module.exports = { renderReportPdf, buildModel, gatherContext, BUILDERS, MAX_EVENTS, MAX_EVIDENCE };
