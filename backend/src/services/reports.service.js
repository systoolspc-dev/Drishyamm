/**
 * reports.service.js — builds the numbers behind a report.
 *
 * Three rules this service exists to enforce, because the old
 * `GET /api/ai/reports` aggregate broke all three:
 *
 *  1. COUNT PEOPLE AND INCIDENTS, NOT ROWS. One person walking past a camera
 *     produces dozens of ai_events rows. Reporting that as "6,469 unrecognised
 *     people" is not a rounding error, it is a different claim. Rows are still
 *     shown, as the smaller "from N detections" line beneath the real count.
 *     (Same doctrine as docs/DETECTION_DECISION_ALERT_FRAMEWORK.md: detect per
 *     frame, decide per track, report per identity.)
 *
 *  2. DAYS ARE LOCAL DAYS. Grouping by DATE(ts) buckets in UTC, so everything
 *     after 18:30 IST lands on tomorrow and "busiest day" is wrong for every
 *     Indian site. All day/hour grouping goes through CONVERT_TZ to REPORT_TZ.
 *
 *  3. SAY WHAT WAS NOT WATCHED. A camera that was offline produces no events,
 *     which reads as "nothing happened" — the most dangerous sentence a
 *     security report can contain. Every report carries a coverage block, and
 *     the UI leads with it.
 *
 * Everything is scoped to the ACCOUNT OWNER, never to the signed-in user: two
 * people in the same organisation must see the same report.
 */

const { QueryTypes, Op } = require('sequelize');
const { sequelize, Camera, CameraGroup, Site } = require('../models');

// Offset used for local-day and local-hour bucketing. A numeric offset works
// without MySQL's timezone tables being loaded (CONVERT_TZ with a NAME like
// 'Asia/Kolkata' silently returns NULL when they are not).
const TZ = process.env.REPORT_TZ_OFFSET || '+05:30';

// How far apart two detections of the same thing may be and still be called
// one incident. Below this, a person loitering in a doorway becomes 40
// "incidents"; far above it, two genuinely separate visits merge into one.
const INCIDENT_GAP_MS = 10 * 60 * 1000;

const MAX_EVENT_ROWS = 4000;   // ceiling on rows pulled for in-JS grouping
const MAX_INCIDENTS  = 25;

/* ───────────────────────────── vocabulary ─────────────────────────────── */

/**
 * One place that decides what an eventType MEANS. The frontend used to own
 * this, which is why the CSV export and the page could disagree.
 */
function bucketOf(eventType) {
  const t = String(eventType || '').toLowerCase();
  if (t.includes('watchlist') || t.includes('blacklist')) return 'watchlist';
  if (t.includes('intrusion') || t.includes('zone') || t.includes('restrict')) return 'zone';
  if (t.includes('weapon')) return 'weapon';
  if (t.includes('fire') || t.includes('smoke')) return 'fire';
  if (t.includes('crowd') || t.includes('occupan')) return 'crowd';
  if (t.includes('vehicle') || t.includes('anpr') || t.includes('plate')) return 'vehicle';
  if (t.includes('camera') || t.includes('offline') || t.includes('stream')) return 'camera';
  if (t.includes('unknown') || t.includes('unrecog')) return 'unknown';
  if (t.includes('recognis') || t.includes('recogniz') || t.includes('known') || t.includes('face')) return 'known';
  return 'other';
}

const BUCKET_META = {
  watchlist: { name: 'Watchlist matches',      desc: 'A person you have flagged was seen on camera.', unit: 'people' },
  zone:      { name: 'Restricted-zone entries', desc: 'Someone entered an area marked off-limits.',    unit: 'entries' },
  weapon:    { name: 'Weapon detections',       desc: 'A possible weapon was seen.',                   unit: 'incidents' },
  fire:      { name: 'Fire / smoke',            desc: 'Possible fire or smoke was detected.',          unit: 'incidents' },
  crowd:     { name: 'Crowding & capacity',     desc: 'An area got unusually busy.',                   unit: 'incidents' },
  vehicle:   { name: 'Vehicles',                desc: 'A vehicle or number plate was detected.',       unit: 'vehicles' },
  camera:    { name: 'Cameras going offline',   desc: 'Counted as a gap in this report.',              unit: 'cameras' },
  // Deliberately NOT "unrecognised people". Unknown faces have no identity
  // across time or cameras — the pipeline keys them on track id — so the same
  // person walking past twice is two sightings. Calling that "people" would
  // repeat the very overclaim this service exists to stop.
  unknown:   { name: 'Unrecognised sightings',  desc: 'A face not on file. The same person seen twice counts twice.', unit: 'sightings' },
  known:     { name: 'Recognised people',       desc: 'A person enrolled in your system was seen.',    unit: 'people' },
  other:     { name: 'Other activity',          desc: 'AI-detected activity.',                         unit: 'events' },
};

// Faces coming and going are the BACKGROUND of a site, not events a guard is
// asked to act on. They stay in the breakdown; they are kept out of the
// "needs attention" headline so one genuine intrusion is not buried under
// 10,000 routine sightings.
const ROUTINE_BUCKETS = ['unknown', 'known', 'vehicle'];

// Buckets produced by the face pipeline — the only ones whose subject is a
// person's name rather than a count or a zone.
const FACE_BUCKETS = ['watchlist', 'known', 'unknown'];

// Which buckets each report type is ABOUT. A Face Detection Report that also
// listed vehicle detections would not be a face report.
const TYPE_BUCKETS = {
  ai_events:       null,                              // everything
  face:            ['known', 'unknown', 'watchlist'],
  occupancy:       ['crowd'],
  restricted_area: ['zone'],
  camera_health:   ['camera'],
  recording:       ['camera'],
  incident:        null,                              // everything, warning+ only
  custom:          null,
};

const TYPE_LABEL = {
  ai_events:       'AI Event Report',
  face:            'Face Detection Report',
  occupancy:       'Crowd & Occupancy Report',
  restricted_area: 'Restricted Area Report',
  camera_health:   'Camera Health Report',
  recording:       'Recording Report',
  incident:        'Incident Report',
  custom:          'Custom Report',
};

const REPORT_TYPES = Object.keys(TYPE_LABEL);

/* ────────────────────────────── helpers ───────────────────────────────── */

const num = (v) => Number(v) || 0;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Cameras this report covers, plus the names the report will print. Scope is
 * resolved to an explicit monitorId list so every later query filters the same
 * way — and so "47 cameras" in the header is the real number, not the length
 * of a top-10 chart (the bug in the old aggregate).
 */
async function resolveScope(ownerId, { siteId, groupId, monitorIds } = {}) {
  const where = { userId: ownerId };
  if (groupId) where.groupId = groupId;
  if (Array.isArray(monitorIds) && monitorIds.length) where.monitorId = { [Op.in]: monitorIds };

  const cameras = await Camera.findAll({
    where,
    attributes: ['id', 'monitorId', 'name', 'status', 'groupId'],
    include: [{
      model: CameraGroup, as: 'group', attributes: ['id', 'name', 'siteId'], required: false,
      include: [{ model: Site, as: 'site', attributes: ['id', 'name'], required: false }],
    }],
    order: [['name', 'ASC']],
  });

  // Site lives on the GROUP, not the camera, so it cannot be a SQL filter above.
  const inScope = siteId ? cameras.filter((c) => c.group?.siteId === siteId) : cameras;

  return inScope.map((c) => ({
    id: c.id,
    monitorId: c.monitorId,
    name: c.name,
    status: c.status,
    groupName: c.group?.name || null,
    siteId: c.group?.siteId || null,
    siteName: c.group?.site?.name || null,
  }));
}

/**
 * The WHERE shared by every aggregate below. Returns SQL text plus the
 * replacements it needs, so each query stays a one-liner.
 */
function scopeClause(ownerId, from, to, monitors, { minSeverity, types } = {}) {
  const parts = ['e.user_id = :owner', 'e.ts >= :from', 'e.ts < :to'];
  const repl = { owner: ownerId, from, to };
  // A typed report's charts must be about that type. Without this, a
  // Restricted Area Report's "where it happened" was topped by a camera whose
  // 10,814 detections were all routine faces.
  if (types) {
    if (!types.length) parts.push('1 = 0');
    else { parts.push('e.event_type IN (:scopeTypes)'); repl.scopeTypes = types; }
  }
  // An empty monitor list means "no cameras match this scope" — which must
  // return nothing, not everything. Only skip the filter when scope is "all".
  if (monitors) {
    if (!monitors.length) parts.push('1 = 0');
    else { parts.push('e.monitor_id IN (:monitors)'); repl.monitors = monitors; }
  }
  if (minSeverity === 'warning') parts.push("e.severity IN ('warning','critical')");
  return { sql: parts.join(' AND '), repl };
}

const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/* ─────────────────────────────── aggregates ───────────────────────────── */

/**
 * A SQL-side count of INCIDENTS rather than rows.
 *
 * The in-JS grouping in buildIncidents() is gap-based and exact, but it can
 * only see the rows it pulls (MAX_EVENT_ROWS). A headline number has to cover
 * the whole window, so this buckets time into fixed INCIDENT_GAP slices and
 * counts distinct (what · where · who · slice). A visit that straddles a slice
 * boundary counts twice, which is a far smaller error than counting every
 * frame — and it errs towards MORE incidents, never towards a quieter report.
 */
const INCIDENT_KEY = `CONCAT_WS('|', e.event_type, e.monitor_id,
  COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.matchedName')),'null'), e.track_id, e.id),
  FLOOR(UNIX_TIMESTAMP(e.ts) / ${INCIDENT_GAP_MS / 1000}))`;

/** Totals for one window. Used for the period itself and for the one before it. */
async function windowTotals(ownerId, from, to, monitors, opts) {
  const { sql, repl } = scopeClause(ownerId, from, to, monitors, opts);

  const [[totals], byTypeRows, peopleRows] = await Promise.all([
    q(`SELECT COUNT(*) AS rows_total,
              SUM(e.severity = 'critical') AS critical,
              SUM(e.severity = 'warning')  AS warning,
              SUM(e.severity = 'info')     AS info,
              COUNT(DISTINCT CASE WHEN e.severity IN ('warning','critical')
                                  THEN ${INCIDENT_KEY} END) AS incidents,
              COUNT(DISTINCT CASE WHEN e.severity IN ('warning','critical')
                                   AND e.acknowledged_at IS NULL
                                  THEN ${INCIDENT_KEY} END) AS open_incidents,
              COUNT(DISTINCT CASE WHEN e.severity IN ('warning','critical')
                                   AND e.acknowledged_at IS NULL
                                   AND e.ts < DATE_SUB(:to, INTERVAL 24 HOUR)
                                  THEN ${INCIDENT_KEY} END) AS stale_incidents,
              SUM(e.acknowledged_at IS NULL AND e.severity IN ('warning','critical')) AS unacked
         FROM ai_events e WHERE ${sql}`, repl),
    // Every type, not a top-8 slice: the breakdown must add up to the total.
    q(`SELECT e.event_type, COUNT(*) AS rows_total,
              COUNT(DISTINCT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.matchedName')),'null'),
                                      e.track_id, e.id)) AS subjects,
              COUNT(DISTINCT CASE WHEN e.severity IN ('warning','critical')
                                  THEN ${INCIDENT_KEY} END) AS incidents,
              COUNT(DISTINCT CASE WHEN e.severity IN ('warning','critical')
                                   AND e.acknowledged_at IS NULL
                                  THEN ${INCIDENT_KEY} END) AS open_incidents,
              COUNT(DISTINCT CASE WHEN e.severity IN ('warning','critical')
                                   AND e.acknowledged_at IS NULL
                                   AND e.ts < DATE_SUB(:to, INTERVAL 24 HOUR)
                                  THEN ${INCIDENT_KEY} END) AS stale_incidents
         FROM ai_events e WHERE ${sql} GROUP BY e.event_type`, repl),
    q(`SELECT COUNT(DISTINCT NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.matchedName')),'null')) AS known,
              COUNT(DISTINCT e.track_id) AS tracks
         FROM ai_events e WHERE ${sql}`, repl),
  ]);

  const buckets = new Map();
  const typeList = [];
  let actionable = 0;
  let actionableOpen = 0;
  let actionableStale = 0;
  for (const r of byTypeRows) {
    const key = bucketOf(r.event_type);
    const b = buckets.get(key) || {
      bucket: key, ...BUCKET_META[key], count: 0, detections: 0, incidents: 0, open: 0, stale: 0,
      routine: ROUTINE_BUCKETS.includes(key),
    };
    b.count += num(r.subjects);
    b.detections += num(r.rows_total);
    b.incidents += num(r.incidents);
    b.open += num(r.open_incidents);
    b.stale += num(r.stale_incidents);
    buckets.set(key, b);
    typeList.push({ type: r.event_type, bucket: key });
    if (!ROUTINE_BUCKETS.includes(key)) {
      actionable += num(r.incidents);
      actionableOpen += num(r.open_incidents);
      actionableStale += num(r.stale_incidents);
    }
  }

  return {
    rows: num(totals?.rows_total),
    critical: num(totals?.critical),
    warning: num(totals?.warning),
    info: num(totals?.info),
    unacked: num(totals?.unacked),
    // The numbers a person can act on: one loiterer is one incident, not 400
    // detections. `alertRows` keeps the raw figure for the "from N detections"
    // line and for anyone reconciling against the Event Log.
    incidents: num(totals?.incidents),
    openIncidents: num(totals?.open_incidents),
    staleIncidents: num(totals?.stale_incidents),
    alertRows: num(totals?.critical) + num(totals?.warning),
    // What a person is actually being asked to look at. Sites commonly run
    // with every unknown face marked `warning`, so counting those as things
    // "needing review" buries the one restricted-zone entry that does. Routine
    // face traffic is still reported — in the breakdown, where it belongs.
    actionable,
    actionableOpen,
    actionableStale,
    buckets: [...buckets.values()],
    typeList,
    knownPeople: num(peopleRows?.[0]?.known),
    tracks: num(peopleRows?.[0]?.tracks),
  };
}

/** Median and average time from event to acknowledgement, in seconds. */
async function responseTimes(ownerId, from, to, monitors, opts = {}) {
  const { sql, repl } = scopeClause(ownerId, from, to, monitors, { ...opts, minSeverity: 'warning' });
  const rows = await q(
    `SELECT TIMESTAMPDIFF(SECOND, e.ts, e.acknowledged_at) AS secs
       FROM ai_events e
      WHERE ${sql} AND e.acknowledged_at IS NOT NULL
      LIMIT ${MAX_EVENT_ROWS}`, repl);
  const secs = rows.map((r) => num(r.secs)).filter((s) => s >= 0);
  return {
    acknowledged: secs.length,
    medianSeconds: median(secs),
    averageSeconds: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null,
  };
}

/** Per-camera counts for the window, keyed by monitorId. */
// The id of the newest event in the group that stored a still. GROUP_CONCAT
// skips NULLs, so the first element is the latest one WITH a snapshot; the
// screen turns it into a thumbnail through /ai/events/:id/snapshot.
const LATEST_SNAPSHOT = `SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN e.snapshot_key IS NOT NULL THEN e.id END
                                                      ORDER BY e.ts DESC SEPARATOR ','), ',', 1)`;
// Face events keep their crop in the AI service's store instead (payload
// snapshotUri = s3://…), which the console streams through the byte relay.
const LATEST_SNAPSHOT_URI = `SUBSTRING_INDEX(GROUP_CONCAT(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.snapshotUri')),'null')
                                                          ORDER BY e.ts DESC SEPARATOR '|'), '|', 1)`;

async function perCamera(ownerId, from, to, monitors, opts) {
  const { sql, repl } = scopeClause(ownerId, from, to, monitors, opts);
  const rows = await q(
    `SELECT e.monitor_id, COUNT(*) AS rows_total,
            SUM(e.severity IN ('warning','critical')) AS alerts,
            MAX(e.ts) AS last_ts,
            ${LATEST_SNAPSHOT} AS snapshot_event_id,
            ${LATEST_SNAPSHOT_URI} AS snapshot_uri
       FROM ai_events e WHERE ${sql} GROUP BY e.monitor_id`, repl);
  const map = new Map();
  for (const r of rows) {
    map.set(String(r.monitor_id), {
      rows: num(r.rows_total),
      alerts: num(r.alerts),
      last: r.last_ts ? new Date(r.last_ts).toISOString() : null,
      snapshotEventId: r.snapshot_event_id || null,
      snapshotUri: r.snapshot_uri || null,
    });
  }
  return map;
}

/** Local-day counts and the weekday × hour grid, both bucketed in REPORT_TZ. */
async function whenItHappened(ownerId, from, to, monitors, opts) {
  const { sql, repl } = scopeClause(ownerId, from, to, monitors, opts);
  const local = `CONVERT_TZ(e.ts, '+00:00', '${TZ}')`;

  const [dayRows, gridRows] = await Promise.all([
    q(`SELECT DATE(${local}) AS day, COUNT(*) AS c,
              SUM(e.severity IN ('warning','critical')) AS alerts
         FROM ai_events e WHERE ${sql} GROUP BY DATE(${local}) ORDER BY day ASC`, repl),
    // DAYOFWEEK: 1 = Sunday … 7 = Saturday. Shifted so 0 = Monday, which is
    // how the heatmap reads and how a working week is discussed.
    q(`SELECT MOD(DAYOFWEEK(${local}) + 5, 7) AS dow, HOUR(${local}) AS hr, COUNT(*) AS c
         FROM ai_events e WHERE ${sql} GROUP BY dow, hr`, repl),
  ]);

  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let afterHours = 0;
  let total = 0;
  for (const r of gridRows) {
    const d = num(r.dow); const h = num(r.hr); const c = num(r.c);
    if (d >= 0 && d < 7 && h >= 0 && h < 24) grid[d][h] = c;
    total += c;
    if (h < 7 || h >= 19) afterHours += c;
  }

  const daily = dayRows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    count: num(r.c),
    alerts: num(r.alerts),
  }));
  const busiestDay = daily.reduce((b, d) => (d.count > (b?.count ?? -1) ? d : b), null);

  let busiestHour = null;
  for (let d = 0; d < 7; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      if (!busiestHour || grid[d][h] > busiestHour.count) busiestHour = { dow: d, hour: h, count: grid[d][h] };
    }
  }

  return {
    daily,
    grid,
    busiestDay,
    busiestHour: busiestHour && busiestHour.count > 0 ? busiestHour : null,
    afterHoursShare: total ? Math.round((afterHours / total) * 100) : 0,
  };
}

/**
 * What a person is actually asked to look at — as PATTERNS, not rows.
 *
 * The first version listed every grouped incident, newest first, and on a real
 * site that meant fourteen consecutive rows reading "Restricted-zone entry ·
 * Demo Camera · Loading Bay". Fourteen rows carrying one fact. So the grouping
 * goes one level up: the same thing, in the same place, about the same subject
 * is ONE line that says how often it happened and when it last did.
 *
 * Doing it in SQL rather than over a fetched sample also removes the row cap —
 * these counts now cover the whole period instead of the newest 4,000 rows.
 */
async function buildIncidents(ownerId, from, to, monitors, cameraNames, wantedTypes) {
  if (!wantedTypes?.length) return [];
  const { sql, repl } = scopeClause(ownerId, from, to, monitors, { minSeverity: 'warning' });
  repl.types = wantedTypes;

  // What the events are ABOUT: a zone, or a named person. Not track ids —
  // those are per-appearance, which would put the grouping back where it was.
  //
  // Occupancy is excluded from the matchedName branch because its payload puts
  // a MEASUREMENT there ("4 people (limit 3)"). Treating that as an identity
  // split one camera's crowding into eleven rows, one per headcount.
  const subject = `COALESCE(
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.zoneName')),'null'),
      CASE WHEN e.event_type NOT LIKE '%occupan%' AND e.event_type NOT LIKE '%crowd%'
           THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.matchedName')),'null') END,
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.zoneId')),'null'))`;

  const rows = await q(
    `SELECT e.event_type, e.monitor_id, ${subject} AS subject,
            COUNT(DISTINCT ${INCIDENT_KEY}) AS occurrences,
            COUNT(DISTINCT CASE WHEN e.acknowledged_at IS NULL
                                THEN ${INCIDENT_KEY} END) AS open_occurrences,
            COUNT(*) AS detections,
            MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen,
            MAX(e.severity = 'critical') AS any_critical,
            ${LATEST_SNAPSHOT} AS snapshot_event_id,
            ${LATEST_SNAPSHOT_URI} AS snapshot_uri
       FROM ai_events e
      WHERE ${sql} AND e.event_type IN (:types)
      GROUP BY e.event_type, e.monitor_id, subject
      ORDER BY any_critical DESC, occurrences DESC
      LIMIT ${MAX_INCIDENTS}`, repl);

  return rows.map((r) => {
    const bucket = bucketOf(r.event_type);
    const subj = r.subject && r.subject !== 'null' ? String(r.subject) : null;
    return {
      id: `${r.event_type}|${r.monitor_id}|${subj || ''}`,
      bucket,
      eventType: r.event_type,
      severity: num(r.any_critical) ? 'critical' : 'warning',
      // A person's name reads as a name; a zone name reads as a place. Only
      // the face pipeline produces the former.
      subject: FACE_BUCKETS.includes(bucket) ? subj : null,
      zone: FACE_BUCKETS.includes(bucket) ? null : subj,
      monitorId: String(r.monitor_id),
      cameraName: cameraNames.get(String(r.monitor_id)) || String(r.monitor_id),
      occurrences: num(r.occurrences),
      openOccurrences: num(r.open_occurrences),
      detections: num(r.detections),
      firstSeen: new Date(r.first_seen).toISOString(),
      lastSeen: new Date(r.last_seen).toISOString(),
      // The newest occurrence that stored a still — the row's thumbnail.
      snapshotEventId: r.snapshot_event_id || null,
      snapshotUri: r.snapshot_uri || null,
    };
  });
}

/** People from the face gallery seen in the window, with where and when. */
async function watchlistPeople(ownerId, from, to, monitors, cameraNames) {
  const { sql, repl } = scopeClause(ownerId, from, to, monitors);
  // Restricted to the FACE pipeline on purpose. Zone and crowd events also
  // carry a `matchedName`, but theirs is a headcount ("3 persons"), and
  // including them listed "5 people (limit 3)" as a person on the watchlist.
  const rows = await q(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.matchedName')) AS person,
            e.event_type, e.monitor_id, COUNT(*) AS c,
            MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen,
            ${LATEST_SNAPSHOT} AS snapshot_event_id,
            ${LATEST_SNAPSHOT_URI} AS snapshot_uri
       FROM ai_events e
      WHERE ${sql} AND JSON_EXTRACT(e.payload,'$.matchedName') IS NOT NULL
        AND (e.event_type LIKE '%face%' OR e.event_type LIKE '%person%'
             OR e.event_type LIKE '%watchlist%' OR e.event_type LIKE '%recogni%'
             OR e.event_type LIKE '%known%')
      GROUP BY person, e.event_type, e.monitor_id
      LIMIT 2000`, repl);

  const people = new Map();
  for (const r of rows) {
    const name = r.person && r.person !== 'null' ? r.person : null;
    if (!name) continue;
    const p = people.get(name) || {
      name, sightings: 0, cameras: new Set(), watchlisted: false,
      firstSeen: r.first_seen, lastSeen: r.last_seen,
    };
    p.sightings += num(r.c);
    p.cameras.add(cameraNames.get(String(r.monitor_id)) || String(r.monitor_id));
    // Watchlisted because the event says so, not because it was severe — a
    // critical severity can come from any policy the site has configured.
    if (bucketOf(r.event_type) === 'watchlist') p.watchlisted = true;
    if (new Date(r.first_seen) < new Date(p.firstSeen)) p.firstSeen = r.first_seen;
    // The thumbnail follows the newest sighting that stored a still.
    if (r.snapshot_event_id && (!p.snapshotEventId || new Date(r.last_seen) >= new Date(p.lastSeen))) p.snapshotEventId = r.snapshot_event_id;
    if (r.snapshot_uri && (!p.snapshotUri || new Date(r.last_seen) >= new Date(p.lastSeen))) p.snapshotUri = r.snapshot_uri;
    if (new Date(r.last_seen) > new Date(p.lastSeen)) p.lastSeen = r.last_seen;
    people.set(name, p);
  }

  return [...people.values()]
    .sort((a, b) => (Number(b.watchlisted) - Number(a.watchlisted)) || (b.sightings - a.sightings))
    .slice(0, 50)
    .map((p) => ({
      name: p.name,
      sightings: p.sightings,
      watchlisted: p.watchlisted,
      snapshotEventId: p.snapshotEventId || null,
      snapshotUri: p.snapshotUri || null,
      cameras: [...p.cameras],
      firstSeen: new Date(p.firstSeen).toISOString(),
      lastSeen: new Date(p.lastSeen).toISOString(),
    }));
}

/** Restricted-zone entries grouped by zone. */
async function zoneBreakdown(ownerId, from, to, monitors, cameraNames) {
  const { sql, repl } = scopeClause(ownerId, from, to, monitors);
  const rows = await q(
    `SELECT COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.zoneName')),'null'),
                     NULLIF(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.zoneId')),'null'),
                     e.monitor_id) AS zone,
            e.monitor_id, COUNT(*) AS rows_total,
            COUNT(DISTINCT ${INCIDENT_KEY}) AS entries,
            ${LATEST_SNAPSHOT} AS snapshot_event_id,
            ${LATEST_SNAPSHOT_URI} AS snapshot_uri
       FROM ai_events e
      WHERE ${sql} AND (e.event_type LIKE '%zone%' OR e.event_type LIKE '%intrusion%'
                        OR e.event_type LIKE '%restrict%')
      GROUP BY zone, e.monitor_id
      ORDER BY entries DESC
      LIMIT 30`, repl);

  return rows.map((r) => ({
    zone: String(r.zone),
    cameraName: cameraNames.get(String(r.monitor_id)) || String(r.monitor_id),
    entries: num(r.entries),
    detections: num(r.rows_total),
    snapshotEventId: r.snapshot_event_id || null,
      snapshotUri: r.snapshot_uri || null,
  }));
}

/* ─────────────────────────────── the report ───────────────────────────── */

/**
 * Build a complete report payload. Pure read — callers decide whether to save
 * it. `include` switches off the expensive optional sections.
 */
async function buildReport(ownerId, {
  type = 'ai_events',
  from,
  to,
  scope = {},
  include = {},
} = {}) {
  if (!REPORT_TYPES.includes(type)) throw new Error(`Unknown report type: ${type}`);

  const fromDate = new Date(from);
  const toDate = new Date(to);
  const span = toDate.getTime() - fromDate.getTime();
  const prevFrom = new Date(fromDate.getTime() - span);

  const cameras = await resolveScope(ownerId, scope);
  const cameraNames = new Map(cameras.map((c) => [String(c.monitorId), c.name]));
  // "All cameras" is expressed as a null monitor list so events from a camera
  // that has since been deleted still count towards the account's totals.
  const scoped = (scope.siteId || scope.groupId || (scope.monitorIds || []).length) ? cameras.map((c) => String(c.monitorId)) : null;

  const buckets = TYPE_BUCKETS[type];
  const opts = type === 'incident' ? { minSeverity: 'warning' } : {};

  // Totals first: they carry the classification every other query needs.
  const [now, prev] = await Promise.all([
    windowTotals(ownerId, fromDate, toDate, scoped, opts),
    windowTotals(ownerId, prevFrom, fromDate, scoped, opts),
  ]);

  // Types this report is ABOUT (routine traffic included — it belongs in the
  // breakdown and the charts), and the narrower set that can need attention.
  const scopeTypes = buckets
    ? now.typeList.filter(({ bucket }) => buckets.includes(bucket)).map(({ type }) => type)
    : null;
  const wantedTypes = now.typeList
    .filter(({ bucket }) => !ROUTINE_BUCKETS.includes(bucket) && (!buckets || buckets.includes(bucket)))
    .map(({ type }) => type);

  const chartOpts = { ...opts, types: scopeTypes };

  const [response, prevResponse, camNow, camPrev, camAny, when, incidents, people, zones] = await Promise.all([
    responseTimes(ownerId, fromDate, toDate, scoped, chartOpts),
    responseTimes(ownerId, prevFrom, fromDate, scoped, chartOpts),
    perCamera(ownerId, fromDate, toDate, scoped, chartOpts),
    perCamera(ownerId, prevFrom, fromDate, scoped, chartOpts),
    // Coverage asks "was this camera sending anything at all", NOT "did it
    // produce events of this report's type" — a camera with no zone drawn on
    // it is not a dark camera, and type-filtering this put a Restricted Area
    // Report's coverage at 5.6%.
    perCamera(ownerId, fromDate, toDate, scoped, {}),
    whenItHappened(ownerId, fromDate, toDate, scoped, chartOpts),
    include.incidents === false
      ? [] : buildIncidents(ownerId, fromDate, toDate, scoped, cameraNames, wantedTypes),
    include.watchlist === false || (buckets && !buckets.includes('watchlist'))
      ? [] : watchlistPeople(ownerId, fromDate, toDate, scoped, cameraNames),
    (buckets && !buckets.includes('zone')) && type !== 'ai_events' && type !== 'incident'
      ? [] : zoneBreakdown(ownerId, fromDate, toDate, scoped, cameraNames),
  ]);

  // ── coverage ──
  // Uptime history is not recorded yet, so this reports what IS known: which
  // cameras sent anything at all during the window, and which are down right
  // now. Deliberately not called "uptime" — that would be a number we cannot
  // stand behind. (A camera_status_history table would let us say more.)
  const reporting = cameras.filter((c) => camAny.has(String(c.monitorId)));
  const silent = cameras.filter((c) => !camAny.has(String(c.monitorId)));
  const offlineNow = cameras.filter((c) => c.status !== 'online');

  const filtered = (list) => (buckets ? list.filter((b) => buckets.includes(b.bucket)) : list);
  const prevByBucket = new Map(prev.buckets.map((b) => [b.bucket, b]));
  const breakdown = filtered(now.buckets)
    .map((b) => {
      // Which number leads depends on what the bucket IS. Face traffic is
      // counted per subject ("11 recognised people"); everything else is
      // counted per incident ("11 zone entries"), because subject ids are not
      // dependable outside the face pipeline — zone events reuse track ids, so
      // counting subjects there reported 5 entries for 1,104 real incidents.
      const primary = b.routine ? b.count : b.incidents;
      const prevRow = prevByBucket.get(b.bucket);
      return {
        ...b,
        primary,
        primaryUnit: b.routine ? b.unit : 'incidents',
        previous: (b.routine ? prevRow?.count : prevRow?.incidents) ?? 0,
        share: now.rows ? Math.round((b.detections / now.rows) * 100) : 0,
      };
    })
    .sort((a, b) => b.primary - a.primary);

  // The headline belongs to THIS report. A Face Detection Report whose
  // "needs attention" counted restricted-zone entries would be answering a
  // question nobody asked of it — so the figures are summed from the
  // breakdown, which is already narrowed to the report's own buckets.
  const sum = (rows, field) => rows.reduce((a, b) => a + (b[field] || 0), 0);
  const actionableRows = breakdown.filter((b) => !b.routine);
  const prevActionable = filtered(prev.buckets)
    .filter((b) => !ROUTINE_BUCKETS.includes(b.bucket));

  const scopedSummary = {
    actionable: sum(actionableRows, 'incidents'),
    actionableOpen: sum(actionableRows, 'open'),
    actionableStale: sum(actionableRows, 'stale'),
    actionablePrevious: sum(prevActionable, 'incidents'),
    allIncidents: sum(breakdown, 'incidents'),
    allIncidentsPrevious: sum(filtered(prev.buckets), 'incidents'),
    detections: sum(breakdown, 'detections'),
    detectionsPrevious: sum(filtered(prev.buckets), 'detections'),
  };

  const byCamera = cameras
    .map((c) => ({
      monitorId: c.monitorId,
      name: c.name,
      siteName: c.siteName,
      count: camNow.get(String(c.monitorId))?.rows || 0,
      alerts: camNow.get(String(c.monitorId))?.alerts || 0,
      lastEvent: camNow.get(String(c.monitorId))?.last || null,
      snapshotEventId: camNow.get(String(c.monitorId))?.snapshotEventId || null,
      snapshotUri: camNow.get(String(c.monitorId))?.snapshotUri || null,
      previous: camPrev.get(String(c.monitorId))?.rows || 0,
      status: c.status,
    }))
    .sort((a, b) => b.count - a.count);

  const unknownSightings = Math.max(0, (breakdown.find((b) => b.bucket === 'unknown')?.count) || 0);

  // Caveats travel WITH the report, not in release notes. A reader has to be
  // able to tell "nothing happened" from "this is not measured yet".
  const notes = [];
  if (type === 'camera_health' || type === 'recording') {
    notes.push('Uptime and recording history are not recorded yet, so this report cannot show them over time. '
      + 'What it does show is which cameras sent data during the period and how each one is right now.');
  }

  // What the screen needs beyond events, per type. The PDF reads the same
  // things live (reportPdf/data.js); the screen replays a frozen payload, so
  // they are frozen with it. Required lazily: data.js requires this module.
  const extras = {};
  if (type === 'occupancy' || type === 'camera_health' || type === 'recording') {
    const pdfData = require('./reportPdf/data');
    if (type === 'occupancy') {
      const occ = await pdfData.occupancyStats({ ownerId, from: fromDate, to: toDate, scoped, tz: TZ });
      const known = new Set(cameras.map((c) => String(c.monitorId)));
      extras.occupancy = {
        periodMinutes: occ.periodMinutes,
        perCamera: occ.perCamera
          .filter((c) => !scoped || known.has(String(c.monitorId)))
          .map((c) => ({
            ...c,
            name: cameraNames.get(String(c.monitorId)) || String(c.monitorId),
            siteName: cameras.find((x) => String(x.monitorId) === String(c.monitorId))?.siteName || null,
          })),
        daily: occ.daily,
      };
    } else {
      const dir = await pdfData.cameraDirectory(ownerId);
      extras.cameras = cameras.map((c) => {
        const d = dir.get(String(c.monitorId)) || {};
        // Unfiltered, like coverage: "what did this camera send", not "did
        // it produce this report's event type" (camNow is type-scoped).
        const n = camAny.get(String(c.monitorId));
        return {
          monitorId: c.monitorId,
          name: c.name,
          siteName: [d.location, c.siteName].filter(Boolean).join(' · ') || null,
          status: c.status || d.status || null,
          lastSeenAt: d.lastSeenAt || null,
          retentionDays: d.retentionDays ?? null,
          events: n?.rows || 0,
          alerts: n?.alerts || 0,
          lastEvent: n?.last || null,
          snapshotEventId: n?.snapshotEventId || null,
          snapshotUri: n?.snapshotUri || null,
        };
      });
    }
  }

  return {
    version: 1,
    type,
    typeLabel: TYPE_LABEL[type],
    notes,
    ...extras,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    previousFrom: prevFrom.toISOString(),
    generatedAt: new Date().toISOString(),
    timezone: TZ,
    scope: {
      siteId: scope.siteId || null,
      groupId: scope.groupId || null,
      monitorIds: scope.monitorIds || null,
      siteName: cameras.find((c) => c.siteId === scope.siteId)?.siteName || null,
      cameraCount: cameras.length,
    },
    coverage: {
      cameras: cameras.length,
      reporting: reporting.length,
      silent: silent.slice(0, 20).map((c) => ({ name: c.name, monitorId: c.monitorId, status: c.status })),
      offlineNow: offlineNow.length,
      percent: cameras.length ? Math.round((reporting.length / cameras.length) * 1000) / 10 : 0,
    },
    summary: {
      detections: scopedSummary.detections,
      detectionsPrevious: scopedSummary.detectionsPrevious,
      detectionsAllTypes: now.rows,
      // Headline = incidents. `alertRows` is the same thing counted per row,
      // kept so the page can show "from N detections" and so these figures
      // reconcile with the Event Log.
      alerts: scopedSummary.allIncidents,
      alertsPrevious: scopedSummary.allIncidentsPrevious,
      alertRows: now.alertRows,
      // The headline pair: what needs a human, now and last period.
      actionable: scopedSummary.actionable,
      actionablePrevious: scopedSummary.actionablePrevious,
      actionableOpen: scopedSummary.actionableOpen,
      critical: now.critical,
      warning: now.warning,
      info: now.info,
      // "Awaiting review" means the same thing everywhere it is printed: the
      // incidents a person still has to look at. The wider figures are kept
      // under names that say what they are, so nothing silently swaps in.
      awaitingReview: scopedSummary.actionableOpen,
      awaitingReviewAll: now.openIncidents,
      awaitingReviewRows: now.unacked,
      // Stale counted over the SAME set as the headline, or the tile would
      // say 13,108 overdue next to a headline of 1,371.
      openOver24h: scopedSummary.actionableStale,
      // Scoped like everything else: a Restricted Area Report saying "11
      // recognised people" was reporting the account's face traffic, which is
      // not what that report is about.
      knownPeople: breakdown.find((b) => b.bucket === 'known')?.count ?? 0,
      knownPeopleAllTypes: now.knownPeople,
      unknownSightings,
      ...response,
      responsePreviousSeconds: prevResponse.medianSeconds,
    },
    breakdown,
    byCamera,
    when,
    incidents,
    people,
    zones,
  };
}

module.exports = {
  buildReport,
  resolveScope,
  scopeClause,
  bucketOf,
  BUCKET_META,
  TYPE_BUCKETS,
  REPORT_TYPES,
  TYPE_LABEL,
  TZ,
};
