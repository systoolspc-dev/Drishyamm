/**
 * ai.controller.js — user-facing endpoints for AI features.
 *
 *   GET  /api/ai/events                — recent events for the user (paginated)
 *   GET  /api/ai/events/:id/snapshot   — signed URL for the event's S3 snapshot
 *   POST /api/ai/events/:id/ack        — mark an event acknowledged
 *
 *   GET  /api/ai/watchlist             — list known faces for this user (proxy)
 *   POST /api/ai/watchlist             — upload a face (proxy → smart-cam-ai)
 *   DELETE /api/ai/watchlist/:name     — remove a face (proxy → smart-cam-ai)
 *
 *   PUT  /api/ai/cameras/:id/settings  — update camera.settings.ai
 *
 * The /watchlist endpoints proxy to smart-cam-ai because the AI service
 * owns the face encodings — the backend just brokers JWT-authed access.
 */

const { Op, fn, col, literal } = require('sequelize');
const FormData       = require('form-data');
const multer         = require('multer');
const axios          = require('axios');
const fs             = require('fs');
const fsp            = require('fs/promises');
const os             = require('os');
const crypto         = require('crypto');
const path           = require('path');
const asyncHandler   = require('../middleware/asyncHandler');
const AppError       = require('../utils/AppError');
const logger         = require('../config/logger');
const config         = require('../config/env');
const s3Service      = require('../services/s3.service');
const { aiAuthHeader } = require('../utils/aiTenant');
const { assertAiLicence } = require('../services/entitlements.service');
const { AIEvent, Camera, CameraGroup } = require('../models');
const { getClient } = require('../config/redis');

// AI service base URL + service token (used to authenticate proxy calls)
const AI_BASE  = config.aiServiceUrl;
const AI_TOKEN = config.serviceToken;

// activity-monitor base URL (per-person productivity: who / how many / how long)
const ACTIVITY_BASE = config.activityServiceUrl;

function eventTime(evt) {
  return evt?.ts || evt?.occurred_at || evt?.timestamp || evt?.createdAt || null;
}

function normalizeVmsFaceEvent(evt) {
  const kind = String(evt.action || evt.kind || '').toLowerCase();
  const eventType = kind === 'match' ? 'person.match'
    : kind === 'unknown' ? 'person.unknown'
    : kind === 'alert' ? 'person.alert'
    : kind || 'detection';

  return {
    id: evt.id,
    source: 'vms_face',
    eventType,
    kind: kind || null,
    action: kind || null,
    severity: kind === 'alert' ? 'critical' : kind === 'unknown' ? 'warning' : 'info',
    ts: evt.timestamp || evt.occurred_at || evt.created_at || null,
    occurred_at: evt.timestamp || evt.occurred_at || evt.created_at || null,
    cameraId: evt.camera_id || null,
    camera_id: evt.camera_id || null,
    monitorId: evt.camera_code || null,
    camera_code: evt.camera_code || null,
    trackId: evt.track_id || null,
    track_id: evt.track_id || null,
    confidence: evt.similarity ?? evt.confidence ?? null,
    similarity: evt.similarity ?? null,
    bbox: evt.bbox || null,
    snapshot_uri: evt.snapshot_uri || null,
    payload: {
      ...(evt.extra || {}),
      matchedName: evt.name || evt.person_name || null,
    },
    name: evt.name || evt.person_name || null,
    person_name: evt.person_name || evt.name || null,
  };
}

async function fetchVmsFaceEvents({ limit, req }) {
  if (!AI_BASE) return [];
  try {
    const { data } = await axios.get(`${AI_BASE}/logs`, {
      params: { limit: Math.min(200, limit) },
      // Org JWT so the AI scopes /logs to THIS tenant. Without it every
      // account saw every other account's face events (cross-tenant alert
      // leak, fixed 2026-07-29 together with the tenant filter in legacy.py).
      headers: proxyHeaders(req),
      timeout: 3500,
    });
    return Array.isArray(data) ? data.map(normalizeVmsFaceEvent) : [];
  } catch (err) {
    logger.warn('vms_face event mirror unavailable', { error: err.message });
    return [];
  }
}

// Face-image upload limit. This is deliberately generous: a photo straight off
// a phone is routinely 8-12 MB, and the previous 5 MB ceiling silently rejected
// them — multer aborts before the handler runs, so nothing ever reached the AI
// service and the operator saw an unexplained failure.
//
// Recognition itself does not need the pixels (the face is downscaled to the
// detector's input size regardless); the limit exists only to bound memory,
// since these are buffered in RAM.
const FACE_IMAGE_MAX_MB = Number(process.env.FACE_IMAGE_MAX_MB) || 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: FACE_IMAGE_MAX_MB * 1024 * 1024 },
});

/**
 * Turn multer's failures into an answer the operator can act on.
 *
 * Without this, an oversized image surfaces as a generic 500 with no hint that
 * SIZE was the problem — which reads as "uploads are broken" rather than "this
 * photo is too big", and is impossible to self-diagnose from the UI.
 */
function handleUploadErrors(err, req, res, next) {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(
        `Image is too large. Maximum ${FACE_IMAGE_MAX_MB} MB per photo — try a smaller or resized image.`,
        413,
      ));
    }
    return next(new AppError(`Upload failed: ${err.message}`, 400));
  }
  return next(err);
}

/* ─────────────────────────── EVENT LIST + ACK ─────────────────────────── */

const listEvents = asyncHandler(async (req, res) => {
  const limit  = Math.min(200, parseInt(req.query.limit) || 50);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  // Playback asks for one camera's events inside a window, oldest first, so its
  // list reads along the timeline. Everything else keeps newest-first.
  const ascending = req.query.order === 'asc';
  const sinceMs = req.query.since ? new Date(req.query.since).getTime() : NaN;
  const untilMs = req.query.until ? new Date(req.query.until).getTime() : NaN;

  const where = { userId: req.user.id };
  if (req.query.monitorId) where.monitorId = req.query.monitorId;
  if (req.query.eventType) where.eventType = req.query.eventType;
  if (req.query.severity)  where.severity  = req.query.severity;
  if (Number.isFinite(sinceMs) || Number.isFinite(untilMs)) {
    where.ts = {};
    if (Number.isFinite(sinceMs)) where.ts[Op.gte] = new Date(sinceMs);
    if (Number.isFinite(untilMs)) where.ts[Op.lte] = new Date(untilMs);
  }

  const { rows, count } = await AIEvent.findAndCountAll({
    where,
    order: [['ts', ascending ? 'ASC' : 'DESC']],
    limit: Math.min(200, limit + offset),
    offset: 0,
  });
  const localEvents = rows.map((row) => {
    const e = row.toJSON();
    // The AI forwarder ships its MinIO crop as payload.snapshotUri, but the
    // Alerts UI reads the top-level snapshot_uri (same field the vms_face
    // mirror uses). Lift it so forwarded events show their snapshot too.
    if (!e.snapshotKey && !e.snapshot_uri && e.payload?.snapshotUri) {
      e.snapshot_uri = e.payload.snapshotUri;
    }
    return e;
  });
  const vmsFaceEvents = await fetchVmsFaceEvents({ limit: limit + offset, req });
  // Every filter applies to the mirrored face events too. This was an if/else
  // chain, so a monitorId filter silently skipped the time window (and the
  // type/severity filters) for them.
  const q = req.query;
  const merged = [...localEvents, ...vmsFaceEvents]
    .filter((evt) => {
      if (q.monitorId && evt.monitorId !== q.monitorId && evt.camera_code !== q.monitorId) return false;
      if (q.eventType && evt.eventType !== q.eventType && evt.kind !== q.eventType && evt.action !== q.eventType) return false;
      if (q.severity && evt.severity !== q.severity) return false;
      if (Number.isFinite(sinceMs) || Number.isFinite(untilMs)) {
        const t = new Date(eventTime(evt) || 0).getTime();
        if (!Number.isFinite(t)) return false;
        if (Number.isFinite(sinceMs) && t < sinceMs) return false;
        if (Number.isFinite(untilMs) && t > untilMs) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const newestFirst = new Date(eventTime(b) || 0) - new Date(eventTime(a) || 0);
      return ascending ? -newestFirst : newestFirst;
    });

  const page = merged.slice(offset, offset + limit);

  res.json({
    success: true,
    data:    page,
    pagination: { total: Math.max(count, merged.length), limit, offset, hasMore: offset + page.length < merged.length },
  });
});

/**
 * Aggregated security report for a date range — all computed in SQL so it
 * covers EVERY event in the window (not just the last page). Powers the
 * Reports page: totals, severity/type/camera breakdowns, and a daily trend.
 */
const getReport = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 7 * 864e5);
  const base = { userId, ts: { [Op.between]: [from, to] } };

  const [total, unacked, sevRows, typeRows, camRows, dayRows] = await Promise.all([
    AIEvent.count({ where: base }),
    AIEvent.count({ where: { ...base, acknowledgedAt: null, severity: { [Op.in]: ['warning', 'critical'] } } }),
    AIEvent.findAll({ where: base, attributes: ['severity', [fn('COUNT', col('id')), 'count']], group: ['severity'], raw: true }),
    AIEvent.findAll({ where: base, attributes: ['eventType', [fn('COUNT', col('id')), 'count']], group: ['eventType'], order: [[literal('count'), 'DESC']], limit: 8, raw: true }),
    AIEvent.findAll({ where: base, attributes: ['monitorId', [fn('COUNT', col('id')), 'count']], group: ['monitorId'], order: [[literal('count'), 'DESC']], limit: 10, raw: true }),
    AIEvent.findAll({ where: base, attributes: [[fn('DATE', col('ts')), 'day'], [fn('COUNT', col('id')), 'count']], group: [fn('DATE', col('ts'))], order: [[literal('day'), 'ASC']], raw: true }),
  ]);

  // Resolve friendly camera names for the per-camera breakdown.
  const monitorIds = camRows.map((r) => r.monitorId).filter(Boolean);
  const nameBy = {};
  if (monitorIds.length) {
    const cams = await Camera.findAll({ where: { userId, monitorId: monitorIds }, attributes: ['monitorId', 'name'] });
    for (const c of cams) if (c.monitorId) nameBy[c.monitorId] = c.name;
  }

  const bySeverity = { info: 0, warning: 0, critical: 0 };
  for (const r of sevRows) bySeverity[r.severity] = Number(r.count) || 0;

  res.json({
    success: true,
    from,
    to,
    total,
    unacked,
    bySeverity,
    byType: typeRows.map((r) => ({ type: r.eventType || 'other', count: Number(r.count) || 0 })),
    byCamera: camRows.map((r) => ({ monitorId: r.monitorId, name: nameBy[r.monitorId] || r.monitorId || 'Unknown', count: Number(r.count) || 0 })),
    daily: dayRows.map((r) => ({ day: r.day, count: Number(r.count) || 0 })),
  });
});

// DATETIMEs come back as Dates, or as zone-less strings in the connection's
// timezone (UTC); either way, ISO out.
const toIso = (v) => (v instanceof Date
  ? v
  : new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(String(v)) ? v : `${String(v).replace(' ', 'T')}Z`)).toISOString();

/**
 * GET /api/ai/events/histogram?monitorId=&since=&until=&buckets=
 *
 * One camera's event counts per time bucket and type. The Playback timeline
 * draws its markers from this: the event LIST pages at most 200 rows, so on a
 * busy camera it can't show where a whole day's activity was. Each bin keeps
 * its first/last timestamp, so a marker click still lands on a real event.
 */
const eventHistogram = asyncHandler(async (req, res) => {
  const { monitorId } = req.query;
  const sinceMs = new Date(req.query.since).getTime();
  const untilMs = new Date(req.query.until).getTime();
  if (!monitorId || !Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) {
    throw new AppError('monitorId, since and until are required, and until must be after since.', 400);
  }
  if (untilMs - sinceMs > 8 * 864e5) throw new AppError('Pick a range of 8 days or less.', 400);
  const buckets = Math.min(500, Math.max(1, parseInt(req.query.buckets, 10) || 120));
  const bucketSec = Math.max(1, Math.ceil((untilMs - sinceMs) / buckets / 1000));
  const from = new Date(sinceMs);
  // Bucket index from the range start. escape() renders the Date in the
  // connection's timezone, the same one `ts` is stored in.
  const bucket = literal(`FLOOR(TIMESTAMPDIFF(SECOND, ${AIEvent.sequelize.escape(from)}, ts) / ${bucketSec})`);

  const rows = await AIEvent.findAll({
    where: { userId: req.user.id, monitorId, ts: { [Op.between]: [from, new Date(untilMs)] } },
    attributes: [
      [bucket, 'b'], 'eventType', 'severity',
      [fn('COUNT', col('id')), 'n'], [fn('MIN', col('ts')), 'first'], [fn('MAX', col('ts')), 'last'],
    ],
    group: ['b', 'eventType', 'severity'],
    raw: true,
  });
  const bins = rows.map((r) => ({
    eventType: r.eventType,
    severity: r.severity,
    count: Number(r.n) || 0,
    first: toIso(r.first),
    last: toIso(r.last),
  }));

  // Face events live in the AI service, not in ai_events: bucket the ones its
  // mirror returns (its most recent 200) the same way.
  const faceBins = new Map();
  for (const evt of await fetchVmsFaceEvents({ limit: 200, req })) {
    if (evt.monitorId !== monitorId && evt.camera_code !== monitorId) continue;
    const t = new Date(eventTime(evt) || 0).getTime();
    if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
    const key = `${Math.floor((t - sinceMs) / (bucketSec * 1000))}|${evt.eventType}|${evt.severity}`;
    const bin = faceBins.get(key);
    if (bin) {
      bin.count += 1;
      bin.first = Math.min(bin.first, t);
      bin.last = Math.max(bin.last, t);
    } else {
      faceBins.set(key, { eventType: evt.eventType, severity: evt.severity, count: 1, first: t, last: t });
    }
  }
  for (const b of faceBins.values()) {
    bins.push({ ...b, first: new Date(b.first).toISOString(), last: new Date(b.last).toISOString() });
  }

  res.json({ success: true, bucketMs: bucketSec * 1000, bins });
});

const getSnapshotUrl = asyncHandler(async (req, res) => {
  const evt = await AIEvent.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!evt) throw new AppError('Event not found', 404);
  if (!evt.snapshotKey) return res.json({ success: true, url: null });

  const url = await s3Service.getPlaybackUrl(evt.snapshotKey, 3600);
  res.json({ success: true, url });
});

const acknowledgeEvent = asyncHandler(async (req, res) => {
  const evt = await AIEvent.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!evt) throw new AppError('Event not found', 404);
  await evt.update({ acknowledgedAt: new Date(), acknowledgedBy: req.user.id });
  res.json({ success: true });
});

/* ───────────────────────── WATCHLIST (face proxy) ─────────────────────── */

/**
 * The AI service stores faces under data/known_faces/<userId>/. We don't
 * have an LS endpoint there; instead the backend keeps a mirror list by
 * recording uploads here. Practical and avoids cross-service file listing.
 */

// Base headers for every AI call. When `req` (an authenticated user) is passed,
// we also attach a per-organization JWT (Authorization: Bearer) so smart-cam-ai
// scopes the request to that org's tenant instead of the shared default one.
const proxyHeaders = (req) => ({
  'X-Service-Token': AI_TOKEN,
  ...(req?.user ? aiAuthHeader(req.user) : {}),
});
const aiOperatorHeaders = (req) => ({
  ...proxyHeaders(req),
  'X-User-Id': String(req.user?.id || ''),
  'X-Operator-Id': String(req.user?.id || ''),
});
const FACE_UPLOAD_TIMEOUT_MS = 12_000;

async function getDefaultAiTenantId() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { data } = await axios.get(`${AI_BASE}/tenants`, { timeout: 10000 });
      const tenants = Array.isArray(data) ? data : [];
      const tenant = tenants.find((t) => t.name === 'drisyam-default') || tenants[0];
      if (!tenant?.id) throw new Error('AI tenant not found');
      return tenant.id;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
  }
  throw new AppError(lastError?.message || 'AI tenant not found', 502);
}

function saveFaceLocallyFallback({ userId, name, file }) {
  const safeUser = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeName = String(name || '').replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_');
  if (!safeUser || !safeName) return null;

  const ext = path.extname(file.originalname || '').toLowerCase();
  const normalizedExt = ['.jpg', '.jpeg', '.png'].includes(ext) ? ext : '.jpg';
  const knownFacesRoot = path.resolve(__dirname, '../../../smart-cam-ai/data/known_faces');
  const userDir = path.join(knownFacesRoot, safeUser);
  fs.mkdirSync(userDir, { recursive: true });
  const target = path.join(userDir, `${safeName}${normalizedExt}`);
  fs.writeFileSync(target, file.buffer);
  return target;
}

async function mirrorFaceToAdminDatasets({ userId, userEmail, name, file }) {
  const safeName = String(name || '').replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_') || 'face';
  const ext = path.extname(file.originalname || '').toLowerCase();
  const normalizedExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
  const ts = Date.now();
  const key = `watchlist-datasets/${userId}/faces/${ts}_${safeName}${normalizedExt}`;

  await s3Service.uploadDataset(
    key,
    file.buffer,
    {
      userId,
      userEmail: userEmail || '',
      source: 'individual-watchlist-upload',
      personName: name || '',
      originalName: file.originalname || `${safeName}${normalizedExt}`,
      uploadedAt: new Date().toISOString(),
      sizeBytes: String(file.size || file.buffer?.length || 0),
    },
    file.mimetype || 'image/jpeg'
  );

  return key;
}

const uploadFace = [
  upload.single('file'),
  handleUploadErrors,
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name || !req.file) throw new AppError('name and file are required', 400);

    const form = new FormData();
    form.append('user_id', req.user.id);
    form.append('name', name);
    form.append('file', req.file.buffer, {
      filename:    req.file.originalname,
      contentType: req.file.mimetype,
    });

    try {
      const startedAt = Date.now();
      const { data } = await axios.post(`${AI_BASE}/upload`, form, {
        headers: { ...proxyHeaders(req), ...form.getHeaders() },
        timeout: FACE_UPLOAD_TIMEOUT_MS,
      });
      try {
        await mirrorFaceToAdminDatasets({
          userId: req.user.id,
          userEmail: req.user.email,
          name,
          file: req.file,
        });
      } catch (mirrorErr) {
        logger.warn('face mirrored dataset upload failed', {
          userId: req.user.id,
          name,
          error: mirrorErr.message,
        });
      }
      logger.info('face uploaded', { userId: req.user.id, name, ms: Date.now() - startedAt });
      res.json({ success: true, ...data });
    } catch (err) {
      logger.error('face upload proxy failed', {
        error: err.message,
        code: err.code,
        status: err.response?.status,
      });
      if (!err.response && ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ECONNABORTED'].includes(err.code)) {
        const localPath = saveFaceLocallyFallback({ userId: req.user.id, name, file: req.file });
        if (localPath) {
          try {
            await mirrorFaceToAdminDatasets({
              userId: req.user.id,
              userEmail: req.user.email,
              name,
              file: req.file,
            });
          } catch (mirrorErr) {
            logger.warn('fallback face mirror upload failed', {
              userId: req.user.id,
              name,
              error: mirrorErr.message,
            });
          }
          logger.warn('face saved via local fallback because AI service is unreachable', {
            userId: req.user.id,
            name,
            localPath,
          });
          return res.json({
            success: true,
            ok: true,
            fallback: 'local-known-faces',
            path: localPath,
            message: 'Saved locally. AI service will pick it up when available.',
          });
        }
      }
      if (err.code === 'ECONNABORTED') {
        throw new AppError(`Face upload timed out after ${FACE_UPLOAD_TIMEOUT_MS / 1000}s — AI service is slow or unreachable.`, 504);
      }
      throw new AppError('Failed to upload face — AI service may be offline or unreachable.', 502);
    }
  }),
];

const deleteFace = asyncHandler(async (req, res) => {
  try {
    const { data } = await axios.delete(`${AI_BASE}/faces`, {
      params:  { user_id: req.user.id, name: req.params.name },
      headers: proxyHeaders(req),
      timeout: 15_000,
    });
    res.json({ success: true, ...data });
  } catch (err) {
    if (err.response?.status === 404) throw new AppError('Face not found', 404);
    throw new AppError('Failed to delete face — AI service may be offline.', 502);
  }
});

const listFaceLearningSamples = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${AI_BASE}/face-learning/samples`, {
      params: {
        tenant_id: req.query.tenant_id || undefined,
        person_id: req.query.person_id || undefined,
        status: req.query.status || 'pending',
        limit: Math.min(500, parseInt(req.query.limit, 10) || 100),
        offset: Math.max(0, parseInt(req.query.offset, 10) || 0),
      },
      headers: aiOperatorHeaders(req),
      timeout: 8000,
    });
    res.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    logger.warn('face learning samples unavailable', { error: err.message, status: err.response?.status });
    throw new AppError('Failed to load face learning samples.', 502);
  }
});

const approveFaceLearningSample = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const { data } = await axios.post(
      `${AI_BASE}/face-learning/samples/${req.params.id}/approve`,
      {},
      { headers: aiOperatorHeaders(req), timeout: 12000 }
    );
    res.json({ success: true, data });
  } catch (err) {
    logger.warn('face learning approve failed', { id: req.params.id, error: err.message, status: err.response?.status });
    const status = err.response?.status === 404 ? 404 : err.response?.status === 409 ? 409 : 502;
    throw new AppError(err.response?.data?.detail || 'Failed to approve face learning sample.', status);
  }
});

const rejectFaceLearningSample = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const { data } = await axios.post(
      `${AI_BASE}/face-learning/samples/${req.params.id}/reject`,
      { reason: req.body?.reason || 'operator rejected sample' },
      { headers: aiOperatorHeaders(req), timeout: 8000 }
    );
    res.json({ success: true, data });
  } catch (err) {
    logger.warn('face learning reject failed', { id: req.params.id, error: err.message, status: err.response?.status });
    const status = err.response?.status === 404 ? 404 : err.response?.status === 409 ? 409 : 502;
    throw new AppError(err.response?.data?.detail || 'Failed to reject face learning sample.', status);
  }
});

const getFaceLearningSnapshot = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const response = await axios.get(`${AI_BASE}/face-learning/samples/${req.params.id}/snapshot`, {
      headers: aiOperatorHeaders(req),
      responseType: 'stream',
      timeout: 12000,
    });
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    response.data.pipe(res);
  } catch (err) {
    logger.warn('face learning snapshot failed', { id: req.params.id, error: err.message, status: err.response?.status });
    const status = err.response?.status === 404 ? 404 : 502;
    throw new AppError('Failed to load face learning snapshot.', status);
  }
});

/* ────────────────────── PER-CAMERA AI SETTINGS ────────────────────────── */

function readAiSettings(camera) {
  const current = camera.settings || {};
  return current.ai || {};
}

function aiEnabled(ai) {
  return ai.enabled === true && ai.mode !== 'off';
}

function aiLifecycleStatus(ai, runtime) {
  if (!aiEnabled(ai)) return 'off';
  if (runtime?.running) return runtime.detecting ? 'detecting' : 'starting';
  if (ai.lastError) return 'attention';
  return 'pending';
}

// Detection zones come in three shapes:
//   • 'line'    — a 2-point straight boundary; `side` picks the watched half.
//   • 'box'     — a rectangle stored as its 4 corner points.
//   • 'polygon' — a freeform 3..24-point outline.
const ZONE_SHAPE_MIN_POINTS = { line: 2, box: 3, polygon: 3 };

function normalizeDetectionZones(raw) {
  const source = Array.isArray(raw) ? raw : [];
  return source.slice(0, 8).map((zone, index) => {
    const shape = ['polygon', 'box', 'line'].includes(zone?.shape) ? zone.shape : 'polygon';
    const points = Array.isArray(zone?.points) ? zone.points : [];
    let cleanPoints = points
      .slice(0, 24)
      .map((point) => ({
        x: clampNumber(point?.x, 0, 1, null),
        y: clampNumber(point?.y, 0, 1, null),
      }))
      .filter((point) => point.x !== null && point.y !== null);
    if (cleanPoints.length < ZONE_SHAPE_MIN_POINTS[shape]) return null;
    if (shape === 'line') cleanPoints = cleanPoints.slice(0, 2);
    const applyTo = Array.isArray(zone?.applyTo)
      ? zone.applyTo.filter((value) => ['face', 'person'].includes(value))
      : ['face', 'person'];
    return {
      id: String(zone?.id || `zone-${index + 1}`).slice(0, 64),
      name: String(zone?.name || `Detection Zone ${index + 1}`).slice(0, 80),
      enabled: zone?.enabled !== false,
      shape,
      side: zone?.side === 'right' ? 'right' : 'left',
      applyTo: applyTo.length ? [...new Set(applyTo)] : ['face', 'person'],
      points: cleanPoints,
    };
  }).filter(Boolean);
}

async function getAiRuntimeByMonitor() {
  try {
    const { data } = await axios.get(`${AI_BASE}/status`, { timeout: 3500 });
    return data?.cameras || {};
  } catch (err) {
    logger.warn('AI runtime status unavailable', { error: err.message });
    return {};
  }
}

async function reconcileAiRuntime(camera, ai, user) {
  const enabled = aiEnabled(ai);
  const body = new URLSearchParams({ monitor_id: camera.monitorId });
  if (enabled) {
    body.set('target_fps', String(Math.max(1, Math.min(12, Number(ai.fps || 8)))));
    body.set('detection_input_size', String(Math.max(320, Math.min(1280, Number(ai.detectionInputSize || 960)))));
    body.set('detection_zones', JSON.stringify(normalizeDetectionZones(ai.detectionZones)));
  }
  const path = enabled ? '/set-camera' : '/stop-camera';

  // Attach the org JWT so smart-cam-ai creates/runs this camera under the
  // owner's tenant — this is what makes the live pipeline match faces against
  // THIS organization's gallery (Camera.tenant_id → gallery query), not the
  // shared default. `user` carries parentUserId so sub-users map to the org.
  const authUser = user || { id: camera.userId };
  try {
    const { data } = await axios.post(`${AI_BASE}${path}`, body, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Service-Token': AI_TOKEN,
        ...aiAuthHeader(authUser),
      },
      timeout: enabled ? 12_000 : 8_000,
    });
    return { ok: true, action: enabled ? 'start' : 'stop', data };
  } catch (err) {
    logger.warn('AI lifecycle reconcile failed', {
      monitorId: camera.monitorId,
      enabled,
      error: err.message,
      status: err.response?.status,
    });
    return {
      ok: false,
      action: enabled ? 'start' : 'stop',
      error: 'AI service is not reachable right now. Settings were saved and will need retry.',
    };
  }
}

function serializeAiCamera(camera, runtimeByMonitor = {}) {
  const ai = readAiSettings(camera);
  const runtime = runtimeByMonitor[camera.monitorId] || {};
  return {
    id: camera.id,
    monitorId: camera.monitorId,
    name: camera.name,
    groupName: camera.group?.name || null,
    channel: camera.channel,
    status: camera.status,
    ai: {
      enabled: aiEnabled(ai),
      mode: ai.mode || (ai.enabled ? 'continuous' : 'off'),
      fps: Number(ai.fps || 8),
      detectionInputSize: Number(ai.detectionInputSize || 960),
      purpose: ai.purpose || '',
      priority: ai.priority || 'normal',
      unknownAlerts: ai.unknownAlerts !== false,
      watchlistAlerts: ai.watchlistAlerts !== false,
      journeyMapping: ai.journeyMapping !== false,
      detectionZones: normalizeDetectionZones(ai.detectionZones),
      createdAt: ai.createdAt || null,
      updatedAt: ai.updatedAt || null,
      disabledAt: ai.disabledAt || null,
      lastError: ai.lastError || null,
    },
    headcount: {
      enabled: camera.settings?.headcount?.enabled === true,
      threshold: Number(camera.settings?.headcount?.threshold) || 0,
      // Counting areas must come back to the client, or the UI cannot show that
      // a camera is scoped, cannot draw the outline over the live tile, and the
      // editor opens blank instead of loading the shape already drawn.
      zones: Array.isArray(camera.settings?.headcount?.zones)
        ? camera.settings.headcount.zones : [],
      imgsz: Number(camera.settings?.headcount?.imgsz) || null,
    },
    runtime: {
      running: runtime.running === true,
      detecting: runtime.detecting === true,
      fps: Number(runtime.fps || 0),
      persons: Number(runtime.persons || 0),
      frames: Number(runtime.frames || 0),
      error: runtime.error || null,
    },
    lifecycle: aiLifecycleStatus(ai, runtime),
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function defaultMappingForCamera(camera, index = 0) {
  const ai = readAiSettings(camera);
  const current = camera.settings || {};
  const mapping = current.mapping || {};
  const zone = mapping.zone || ai.purpose || camera.group?.location || camera.group?.name || 'Unassigned area';
  const x = clampNumber(mapping.x, 5, 95, 14 + ((index * 19) % 74));
  const y = clampNumber(mapping.y, 10, 90, 22 + ((index * 23) % 62));
  return {
    enabled: mapping.enabled !== false,
    site: String(mapping.site || camera.group?.location || 'Primary site').slice(0, 120),
    building: String(mapping.building || camera.group?.name || 'Main block').slice(0, 120),
    floor: String(mapping.floor || 'Floor 1').slice(0, 80),
    zone: String(zone).slice(0, 120),
    risk: ['public', 'staff', 'restricted', 'outdoor'].includes(mapping.risk) ? mapping.risk : inferRisk(zone),
    coverage: String(mapping.coverage || inferCoverage(ai)).slice(0, 120),
    x,
    y,
    notes: String(mapping.notes || '').slice(0, 300),
    updatedAt: mapping.updatedAt || null,
  };
}

function inferRisk(zone) {
  const text = String(zone || '').toLowerCase();
  if (text.includes('restricted') || text.includes('server') || text.includes('cash')) return 'restricted';
  if (text.includes('parking') || text.includes('outdoor')) return 'outdoor';
  if (text.includes('staff') || text.includes('office')) return 'staff';
  return 'public';
}

function inferCoverage(ai) {
  const parts = ['Face detection'];
  if (ai.journeyMapping !== false) parts.push('journey');
  if (ai.watchlistAlerts !== false) parts.push('watchlist');
  return parts.join(' + ');
}

function serializeMappedCamera(camera, runtimeByMonitor = {}, index = 0, eventCounts = {}) {
  const ai = readAiSettings(camera);
  const runtime = runtimeByMonitor[camera.monitorId] || {};
  const mapping = defaultMappingForCamera(camera, index);
  const status = runtime.running ? 'live'
    : camera.supervisorState === 'streaming' || camera.status === 'online' ? 'ready'
    : camera.supervisorState === 'degraded' || camera.supervisorState === 'quarantined' ? 'issue'
    : 'offline';

  return {
    id: camera.id,
    monitorId: camera.monitorId,
    name: camera.name,
    groupName: camera.group?.name || null,
    channel: camera.channel,
    status,
    streamStatus: camera.supervisorState || camera.status || 'unknown',
    viewers: Number(runtime.persons || 0),
    ai: {
      enabled: aiEnabled(ai),
      lifecycle: aiLifecycleStatus(ai, runtime),
      journeyMapping: ai.journeyMapping !== false,
      watchlistAlerts: ai.watchlistAlerts !== false,
      unknownAlerts: ai.unknownAlerts !== false,
    },
    runtime: {
      running: runtime.running === true,
      detecting: runtime.detecting === true,
      fps: Number(runtime.fps || 0),
      persons: Number(runtime.persons || 0),
      error: runtime.error || null,
    },
    mapping,
    events24h: Number(eventCounts[camera.monitorId] || 0),
  };
}

async function getEventCounts24h(userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await AIEvent.findAll({
    where: { userId, ts: { [Op.gte]: since } },
    attributes: ['monitorId', [fn('COUNT', col('id')), 'count']],
    group: ['monitorId'],
    raw: true,
  });
  return rows.reduce((acc, row) => {
    acc[row.monitorId] = Number(row.count || 0);
    return acc;
  }, {});
}

// Building-wide + per-camera people-count aggregate. Polls smart-cam-ai's
// /api/people-count, which uses the cache's smoothed totals (MAX of YOLO
// person count, tracker active-tracks, and face-bbox count) so the numbers
// don't flicker.
const peopleCount = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${AI_BASE}/api/people-count`, {
      headers: aiOperatorHeaders(req),
      timeout: 5000,
    });
    // /api/people-count is a GLOBAL live snapshot (the legacy route is not
    // tenant-scoped). Restrict it to THIS operator's cameras so each
    // organization only sees its OWN headcount — mirrors journey camera scoping
    // — and recompute the roll-up totals from the scoped set.
    let out = data;
    try {
      const cams = await Camera.findAll({ where: { userId: req.user.id }, attributes: ['monitorId', 'name'] });
      const nameByCode = {};
      for (const c of cams) if (c.monitorId) nameByCode[c.monitorId] = c.name || c.monitorId;
      const mine = new Set(Object.keys(nameByCode));
      const list = Array.isArray(data?.cameras) ? data.cameras : [];
      const scoped = list
        .filter((c) => mine.has(c.monitor_id || c.code))
        .map((c) => ({ ...c, name: nameByCode[c.monitor_id || c.code] || c.name }));
      const sum = (k) => scoped.reduce((a, c) => a + (Number(c[k]) || 0), 0);
      out = {
        ...data,
        cameras: scoped,
        running_cameras: scoped.filter((c) => c.running).length,
        total: sum('total'),
        known: sum('known'),
        unknown: sum('unknown'),
        smoothed_total: sum('smoothed_total'),
      };
    } catch (e) {
      logger.warn('people-count tenant scoping skipped', { err: e.message });
    }

    // Overlay the dedicated head-count model. For every camera the user enabled
    // head counting on, use the model's live gauge: attach `heads` to rows the
    // face pipeline already returned, and ADD rows for head-count-only cameras
    // (face AI off) so the page reflects the head-count model wherever it's on.
    try {
      const redis = getClient();
      const owned = await Camera.findAll({
        where: { userId: req.user.id },
        attributes: ['monitorId', 'name', 'settings'],
      });
      const enabled = owned.filter((c) => c.monitorId && c.settings?.headcount?.enabled === true);
      if (redis && enabled.length) {
        out.cameras = Array.isArray(out.cameras) ? out.cameras : [];
        const byCode = new Map(out.cameras.map((c) => [c.monitor_id || c.code, c]));
        const gauges = await redis.mget(enabled.map((c) => `occupancy:live:${c.monitorId}`));
        let headsTotal = 0;
        let headsAny = false;
        enabled.forEach((c, i) => {
          const raw = gauges[i];
          if (!raw) return;
          let g; try { g = JSON.parse(raw); } catch { return; }
          const h = Number(g.heads) || 0;
          headsTotal += h; headsAny = true;
          const existing = byCode.get(c.monitorId);
          if (existing) {
            existing.heads = h;
          } else {
            out.cameras.push({
              monitor_id: c.monitorId, code: c.monitorId, name: c.name,
              heads: h, total: h, smoothed_total: h, known: 0, unknown: 0,
              running: g.connected !== false, headcount: true,
            });
          }
        });
        if (headsAny) out.heads_total = headsTotal;
      }
    } catch (e) {
      logger.warn('headcount model overlay skipped', { err: e.message });
    }

    res.json({ success: true, data: out });
  } catch (err) {
    logger.warn('people-count fetch failed', { error: err.message, status: err.response?.status });
    throw new AppError('Failed to load people count.', 502);
  }
});

// ── Footfall (customer footfall counter) ───────────────────────────────
//
// Thin pass-throughs over smart-cam-ai's /footfall/* routes. The AI service
// owns the counter state, the persistence and tenant scoping; the Node
// backend is just an authenticated front door so the frontend doesn't have
// to talk to two different origins. Errors from the upstream surface as
// 502 + the upstream's body, mirroring the pattern peopleCount uses.

const footfallCameras = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${AI_BASE}/footfall/cameras`, {
      headers: aiOperatorHeaders(req),
      timeout: 5000,
    });
    res.json({ success: true, data });
  } catch (err) {
    logger.warn('footfall cameras fetch failed', { error: err.message, status: err.response?.status });
    throw new AppError('Failed to load footfall cameras.', 502);
  }
});

const footfallTimeseries = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    // Forward the operator-supplied query params verbatim — granularity /
    // from / to / camera_id are all validated upstream, so we don't need
    // a separate Joi schema here.
    const { data } = await axios.get(`${AI_BASE}/footfall/timeseries`, {
      headers: aiOperatorHeaders(req),
      params: req.query,
      timeout: 8000,
    });
    res.json({ success: true, data });
  } catch (err) {
    logger.warn('footfall timeseries fetch failed', { error: err.message, status: err.response?.status });
    throw new AppError('Failed to load footfall timeseries.', 502);
  }
});

const footfallGetConfig = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const { data } = await axios.get(
      `${AI_BASE}/footfall/cameras/${encodeURIComponent(req.params.id)}/config`,
      { headers: aiOperatorHeaders(req), timeout: 5000 },
    );
    res.json({ success: true, data });
  } catch (err) {
    logger.warn('footfall config fetch failed', { error: err.message, status: err.response?.status });
    throw new AppError('Failed to load footfall config.', err.response?.status === 404 ? 404 : 502);
  }
});

const footfallPutConfig = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const { data } = await axios.put(
      `${AI_BASE}/footfall/cameras/${encodeURIComponent(req.params.id)}/config`,
      req.body || {},
      { headers: aiOperatorHeaders(req), timeout: 5000 },
    );
    res.json({ success: true, data });
  } catch (err) {
    logger.warn('footfall config save failed', { error: err.message, status: err.response?.status });
    throw new AppError('Failed to save footfall config.', err.response?.status === 404 ? 404 : 502);
  }
});

// Stream the CSV through this proxy so the browser-facing URL stays under
// /api/ai/* (single origin, single auth) and we keep AI internal-only.
// Buffer-free pipe — at 30 days * 100 cams * 1440 mins = 4.3M rows max, but
// streaming means we don't allocate it client-side or in our Node memory.
const footfallExportCsv = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const upstream = await axios.get(`${AI_BASE}/footfall/export.csv`, {
      headers: aiOperatorHeaders(req),
      params: req.query,
      responseType: 'stream',
      timeout: 60_000,
    });
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'text/csv');
    if (upstream.headers['content-disposition']) {
      res.setHeader('Content-Disposition', upstream.headers['content-disposition']);
    }
    upstream.data.pipe(res);
  } catch (err) {
    logger.warn('footfall csv export failed', { error: err.message, status: err.response?.status });
    throw new AppError('Failed to export footfall CSV.', 502);
  }
});

// ── Face reconstruction (CodeFormer + Real-ESRGAN) ────────────────────
//
// Thin proxy to the separate face-reconstruct service on port 8002. We
// proxy instead of letting the browser hit :8002 directly because:
//   1. single origin = no CORS preflight on every Enhance click
//   2. consistent auth posture (authenticate middleware applies here)
//   3. operators reach it via the same /api/ai/* family they already
//      know — no new hostnames to remember
//
// Body: multipart form with `file` (image) and optional `fidelity_weight`
// (0..1, default 0.5). Upstream answers with JSON {triage, before, after}
// where before/after are base64 PNGs. We pipe the response straight back.
const FACE_RECONSTRUCT_BASE =
  process.env.FACE_RECONSTRUCT_BASE || 'http://face-reconstruct:8002';

const enhanceFace = [
  upload.single('file'),
  handleUploadErrors,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('image file is required', 400);

    const fidelity = req.body?.fidelity_weight ?? '0.5';
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname || 'face.jpg',
      contentType: req.file.mimetype || 'image/jpeg',
    });
    form.append('fidelity_weight', String(fidelity));

    try {
      const { data } = await axios.post(
        `${FACE_RECONSTRUCT_BASE}/api/reconstruct`,
        form,
        {
          headers: form.getHeaders(),
          maxContentLength: 50 * 1024 * 1024,
          maxBodyLength: 50 * 1024 * 1024,
          timeout: 30_000,
        },
      );
      res.json({ success: true, data });
    } catch (err) {
      const upstreamMsg = err.response?.data?.detail || err.message;
      logger.warn('face enhance failed', {
        error: upstreamMsg,
        status: err.response?.status,
      });
      throw new AppError(
        `Face enhancement failed: ${upstreamMsg}`,
        err.response?.status === 400 ? 400 : 502,
      );
    }
  }),
];

const listCameraMapping = asyncHandler(async (req, res) => {
  const cameras = await Camera.findAll({
    where: { userId: req.user.id },
    include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }],
    order: [[{ model: CameraGroup, as: 'group' }, 'name', 'ASC'], ['channel', 'ASC'], ['name', 'ASC']],
  });

  const [runtimeByMonitor, eventCounts] = await Promise.all([
    getAiRuntimeByMonitor(),
    getEventCounts24h(req.user.id),
  ]);

  const data = cameras.map((camera, index) => serializeMappedCamera(camera, runtimeByMonitor, index, eventCounts));
  const zones = [...new Set(data.map((camera) => camera.mapping.zone).filter(Boolean))];
  const restrictedZones = new Set(data
    .filter((camera) => camera.mapping.risk === 'restricted')
    .map((camera) => camera.mapping.zone));

  res.json({
    success: true,
    data,
    zones,
    summary: {
      total: data.length,
      mapped: data.filter((camera) => camera.mapping.enabled && camera.mapping.zone !== 'Unassigned area').length,
      live: data.filter((camera) => camera.status === 'live' || camera.status === 'ready').length,
      aiEnabled: data.filter((camera) => camera.ai.enabled).length,
      coverageGaps: data.filter((camera) => !camera.mapping.enabled || camera.mapping.zone === 'Unassigned area').length,
      restrictedZones: restrictedZones.size,
      events24h: data.reduce((sum, camera) => sum + camera.events24h, 0),
    },
  });
});

const updateCameraMapping = asyncHandler(async (req, res) => {
  const camera = await Camera.findOne({
    where: { id: req.params.id, userId: req.user.id },
    include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }],
  });
  if (!camera) throw new AppError('Camera not found', 404);

  const current = camera.settings || {};
  const previous = current.mapping || {};
  const patch = req.body || {};
  const nextMapping = {
    ...previous,
    enabled: patch.enabled !== undefined ? patch.enabled === true : previous.enabled !== false,
    site: String(patch.site ?? previous.site ?? camera.group?.location ?? 'Primary site').slice(0, 120),
    building: String(patch.building ?? previous.building ?? camera.group?.name ?? 'Main block').slice(0, 120),
    floor: String(patch.floor ?? previous.floor ?? 'Floor 1').slice(0, 80),
    zone: String(patch.zone ?? previous.zone ?? '').slice(0, 120) || 'Unassigned area',
    risk: ['public', 'staff', 'restricted', 'outdoor'].includes(patch.risk) ? patch.risk : (previous.risk || inferRisk(patch.zone || previous.zone)),
    coverage: String(patch.coverage ?? previous.coverage ?? '').slice(0, 120) || inferCoverage(readAiSettings(camera)),
    x: clampNumber(patch.x ?? previous.x, 5, 95, 50),
    y: clampNumber(patch.y ?? previous.y, 10, 90, 50),
    notes: String(patch.notes ?? previous.notes ?? '').slice(0, 300),
    updatedAt: new Date().toISOString(),
  };

  await camera.update({ settings: { ...current, mapping: nextMapping } });
  await camera.reload({ include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }] });

  const runtimeByMonitor = await getAiRuntimeByMonitor();
  res.json({
    success: true,
    data: serializeMappedCamera(camera, runtimeByMonitor, 0, {}),
  });
});

const listCameraAiSettings = asyncHandler(async (req, res) => {
  const cameras = await Camera.findAll({
    where: { userId: req.user.id },
    include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }],
    order: [[{ model: CameraGroup, as: 'group' }, 'name', 'ASC'], ['channel', 'ASC'], ['name', 'ASC']],
  });

  const runtimeByMonitor = await getAiRuntimeByMonitor();
  const data = cameras.map((camera) => serializeAiCamera(camera, runtimeByMonitor));
  res.json({
    success: true,
    data,
    summary: {
      total: data.length,
      enabled: data.filter((camera) => camera.ai.enabled).length,
      running: data.filter((camera) => camera.runtime.running).length,
      detecting: data.filter((camera) => camera.runtime.detecting).length,
    },
  });
});

const updateCameraSettings = asyncHandler(async (req, res) => {
  const camera = await Camera.findOne({
    where: { id: req.params.id, userId: req.user.id },
    include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }],
  });
  if (!camera) throw new AppError('Camera not found', 404);

  const current = camera.settings || {};
  const aiPatch = req.body?.ai || req.body || {};
  const previousAi = current.ai || {};
  const enabled = aiPatch.enabled !== undefined ? aiPatch.enabled === true : previousAi.enabled === true;
  // Switching AI ON spends one face-recognition camera licence. Only the
  // off→on edge is checked: editing an already-on camera, or switching it
  // off, must keep working even on an over-licence account.
  if (enabled && !aiEnabled(previousAi)) await assertAiLicence(req.user.id, 'face', 1);
  const now = new Date().toISOString();
  const nextAi = {
    ...previousAi,
    ...aiPatch,
    enabled,
    mode: enabled ? (aiPatch.mode || previousAi.mode || 'continuous') : 'off',
    fps: Math.max(1, Math.min(12, Number(aiPatch.fps || previousAi.fps || 8))),
    detectionInputSize: Math.max(320, Math.min(1280, Number(aiPatch.detectionInputSize || previousAi.detectionInputSize || 960))),
    detectionZones: normalizeDetectionZones(aiPatch.detectionZones !== undefined ? aiPatch.detectionZones : previousAi.detectionZones),
    unknownAlerts: aiPatch.unknownAlerts !== undefined ? aiPatch.unknownAlerts === true : previousAi.unknownAlerts !== false,
    watchlistAlerts: aiPatch.watchlistAlerts !== undefined ? aiPatch.watchlistAlerts === true : previousAi.watchlistAlerts !== false,
    journeyMapping: aiPatch.journeyMapping !== undefined ? aiPatch.journeyMapping === true : previousAi.journeyMapping !== false,
    updatedAt: now,
    createdAt: previousAi.createdAt || now,
    disabledAt: enabled ? null : now,
    lastError: null,
  };

  const reconcile = await reconcileAiRuntime(camera, nextAi, req.user);
  if (!reconcile.ok) {
    nextAi.lastError = reconcile.error;
  }

  const next    = {
    ...current,
    ai: nextAi,
  };

  await camera.update({ settings: next });

  const runtimeByMonitor = await getAiRuntimeByMonitor();
  await camera.reload({ include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }] });

  return res.json({
    success: true,
    data: {
      id: camera.id,
      settings: camera.settings,
      camera: serializeAiCamera(camera, runtimeByMonitor),
    },
    reconcile,
  });

  // Best-effort: tell smart-cam-ai to reconcile so the change is picked up
  // immediately without waiting for the next poll cycle.
  axios.post(`${AI_BASE}/reload`, null, { headers: proxyHeaders(req), timeout: 5_000 })
    .catch(() => { /* AI service not reachable — it'll catch up on next poll */ });

  res.json({ success: true, data: { id: camera.id, settings: camera.settings } });
});

// PUT /api/ai/cameras/:id/headcount — per-camera head-count toggle + threshold.
// Head-count is a product-wide feature the user turns on for whichever cameras
// they choose; the head-count service polls the camera registry and counts the
// enabled ones (settings.headcount.enabled). threshold>0 arms an occupancy alert.
const setCameraHeadcount = asyncHandler(async (req, res) => {
  const camera = await Camera.findOne({ where: { id: req.params.id, userId: req.user.id } });
  if (!camera) throw new AppError('Camera not found', 404);

  const current = camera.settings || {};
  const prev = current.headcount || {};
  const enabled = req.body?.enabled !== undefined ? req.body.enabled === true : prev.enabled === true;
  if (enabled && prev.enabled !== true) await assertAiLicence(req.user.id, 'headcount', 1);
  const threshold = req.body?.threshold !== undefined
    ? Math.max(0, Math.round(Number(req.body.threshold) || 0))
    : (Number(prev.threshold) || 0);

  // Counting zones: normalised polygons naming the area that should be counted,
  // so the number means "people in this room" rather than "people this lens can
  // see". Only replaced when the caller actually sends them — spreading `prev`
  // matters because this endpoint is also the on/off toggle, and rebuilding the
  // object from scratch would silently delete an operator's zones every time
  // they flipped the switch.
  const zones = req.body?.zones !== undefined
    ? sanitiseZones(req.body.zones)
    : (Array.isArray(prev.zones) ? prev.zones : []);

  // Detail level = the model's input size, and the strongest range control we
  // have: measured on 10 Aug 2026, raising it from 640 to 1280 found 71% more
  // people in identical footage, all of them distant ones. It costs roughly 2x
  // the processing per frame, so it is per camera rather than global — spend it
  // on the big rooms. Only sizes the model actually accepts are stored.
  const ALLOWED_DETAIL = [416, 512, 640, 800, 960, 1280];
  const detail = req.body?.imgsz !== undefined
    ? (ALLOWED_DETAIL.includes(Number(req.body.imgsz)) ? Number(req.body.imgsz) : null)
    : (prev.imgsz ?? null);

  const next = {
    ...current,
    headcount: {
      ...prev, enabled, threshold, zones,
      ...(detail ? { imgsz: detail } : { imgsz: undefined }),
      updatedAt: new Date().toISOString(),
    },
  };
  await camera.update({ settings: next });

  return res.json({ success: true, data: { id: camera.id, headcount: next.headcount } });
});

/**
 * Validate operator-drawn zones before they reach the AI service.
 *
 * Points are normalised 0..1 so a zone drawn on a preview keeps its meaning at
 * any resolution. Anything with fewer than 3 points cannot enclose an area and
 * is dropped rather than stored — a malformed zone that reached the counter
 * would either count nobody or everybody, both silently.
 */
function sanitiseZones(input) {
  if (!Array.isArray(input)) return [];
  const clamp = (n) => Math.min(1, Math.max(0, Number(n) || 0));
  return input.slice(0, 8).map((z, i) => {
    const pts = Array.isArray(z?.points) ? z.points : [];
    const points = pts
      .map((p) => (Array.isArray(p)
        ? [clamp(p[0]), clamp(p[1])]
        : [clamp(p?.x), clamp(p?.y)]))
      .slice(0, 40);
    if (points.length < 3) return null;
    return {
      id: String(z?.id || `zone-${i + 1}`).slice(0, 40),
      name: String(z?.name || `Zone ${i + 1}`).slice(0, 60),
      enabled: z?.enabled !== false,
      points,
    };
  }).filter(Boolean);
}

// Turn one or more cameras ON (or OFF) for person tracking. ON = AI detection
// enabled + journeyMapping on, so the camera produces appearances and is
// included in person-tracker/journey search. OFF = journeyMapping cleared
// (live AI detection is left as-is). Body: { cameraIds: [..], enabled?: bool }.
const setPersonTrackerCameras = asyncHandler(async (req, res) => {
  const enabled = req.body?.enabled !== false; // default true
  const ids = Array.isArray(req.body?.cameraIds) ? req.body.cameraIds : [];
  if (!ids.length) throw new AppError('cameraIds (non-empty array) is required', 400);

  // ON switches the face engine on, so the cameras that are not already
  // running it each spend a face-recognition licence. Checked up front so a
  // batch is refused whole rather than half-applied.
  if (enabled) {
    const owned = await Camera.findAll({ where: { id: ids, userId: req.user.id }, attributes: ['id', 'settings'] });
    const turningOn = owned.filter((c) => !aiEnabled(c.settings?.ai || {})).length;
    await assertAiLicence(req.user.id, 'face', turningOn);
  }

  const results = [];
  for (const id of ids) {
    const camera = await Camera.findOne({
      where: { id, userId: req.user.id },
      include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }],
    });
    if (!camera) { results.push({ id, ok: false, error: 'not found' }); continue; }

    const current = camera.settings || {};
    const previousAi = current.ai || {};
    const now = new Date().toISOString();
    const nextAi = {
      ...previousAi,
      enabled: enabled ? true : previousAi.enabled === true,
      mode: enabled ? (previousAi.mode || 'continuous') : (previousAi.mode || 'off'),
      journeyMapping: enabled,
      updatedAt: now,
      createdAt: previousAi.createdAt || now,
      disabledAt: (enabled || previousAi.enabled === true) ? null : now,
      lastError: null,
    };
    const reconcile = await reconcileAiRuntime(camera, nextAi, req.user);
    if (!reconcile.ok) nextAi.lastError = reconcile.error;
    await camera.update({ settings: { ...current, ai: nextAi } });
    results.push({ id, monitorId: camera.monitorId, ok: reconcile.ok, journeyMapping: nextAi.journeyMapping });
  }

  axios.post(`${AI_BASE}/reload`, null, { headers: proxyHeaders(req), timeout: 5_000 }).catch(() => {});
  res.json({ success: true, count: results.length, enabled, data: results });
});

const updateCameraAiLifecycle = asyncHandler(async (req, res) => {
  const camera = await Camera.findOne({
    where: { id: req.params.id, userId: req.user.id },
    include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }],
  });
  if (!camera) throw new AppError('Camera not found', 404);

  const current = camera.settings || {};
  const previousAi = current.ai || {};
  const patch = req.body || {};
  const enabled = patch.enabled === true;
  if (enabled && !aiEnabled(previousAi)) await assertAiLicence(req.user.id, 'face', 1);
  const now = new Date().toISOString();

  const nextAi = {
    ...previousAi,
    enabled,
    mode: enabled ? (patch.mode || previousAi.mode || 'continuous') : 'off',
    fps: Math.max(1, Math.min(12, Number(patch.fps || previousAi.fps || 8))),
    detectionInputSize: Math.max(320, Math.min(1280, Number(patch.detectionInputSize || previousAi.detectionInputSize || 960))),
    detectionZones: normalizeDetectionZones(patch.detectionZones !== undefined ? patch.detectionZones : previousAi.detectionZones),
    purpose: String(patch.purpose ?? previousAi.purpose ?? '').slice(0, 120),
    priority: ['normal', 'high', 'critical'].includes(patch.priority) ? patch.priority : (previousAi.priority || 'normal'),
    unknownAlerts: patch.unknownAlerts !== undefined ? patch.unknownAlerts === true : previousAi.unknownAlerts !== false,
    watchlistAlerts: patch.watchlistAlerts !== undefined ? patch.watchlistAlerts === true : previousAi.watchlistAlerts !== false,
    journeyMapping: patch.journeyMapping !== undefined ? patch.journeyMapping === true : previousAi.journeyMapping !== false,
    updatedAt: now,
    createdAt: previousAi.createdAt || now,
    disabledAt: enabled ? null : now,
    lastError: null,
  };

  const reconcile = await reconcileAiRuntime(camera, nextAi, req.user);
  if (!reconcile.ok) {
    nextAi.lastError = reconcile.error;
  }

  await camera.update({
    settings: {
      ...current,
      ai: nextAi,
    },
  });

  const runtimeByMonitor = await getAiRuntimeByMonitor();
  await camera.reload({ include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }] });

  res.json({
    success: true,
    data: serializeAiCamera(camera, runtimeByMonitor),
    reconcile,
  });
});

/* ──────────────────── BULK DATASET UPLOAD ──────────────────────────────── */

const uploadDataset = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || file.originalname.toLowerCase().endsWith('.zip');
    cb(ok ? null : new AppError('Only .zip files are accepted.', 400), ok);
  },
}).single('dataset');

const handleUploadDataset = asyncHandler(async (req, res) => {
  // Run multer manually so we can wrap in asyncHandler. Translate its errors —
  // a raw MulterError surfaces as a generic failure that gives the operator no
  // way to tell "this ZIP is too big" from "uploads are broken".
  await new Promise((resolve, reject) =>
    uploadDataset(req, res, (err) => {
      if (!err) return resolve();
      if (err.name === 'MulterError') {
        return reject(err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('ZIP is too large. Maximum 500 MB — split it into smaller batches.', 413)
          : new AppError(`Upload failed: ${err.message}`, 400));
      }
      return reject(err);
    })
  );

  if (!req.file) throw new AppError('No ZIP file received.', 400);

  return finalizeDataset(req, res, {
    buffer:       req.file.buffer,
    originalName: req.file.originalname,
    mimetype:     req.file.mimetype,
    size:         req.file.size,
  });
});

/**
 * Everything that happens once a complete ZIP is in hand, regardless of whether
 * it arrived in one request or was reassembled from chunks: archive it to S3,
 * push it to the AI service for enrollment, and answer the caller.
 *
 * Shared so the single-shot and chunked paths cannot drift — a dataset must be
 * treated identically however it got here.
 */
async function finalizeDataset(req, res, file) {
  const category  = (req.body.category || 'general').slice(0, 50);
  const batchName = (req.body.batchName || file.originalName).slice(0, 100);
  const ts        = Date.now();
  const safeName  = String(file.originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const key       = `watchlist-datasets/${req.user.id}/${ts}_${safeName}`;

  // 1) Archive the raw ZIP to S3 (audit / re-ingest backup).
  await s3Service.uploadDataset(key, file.buffer, {
    userId:      req.user.id,
    userEmail:   req.user.email,
    category,
    batchName,
    originalName: file.originalName,
    uploadedAt:  new Date().toISOString(),
    sizeBytes:   String(file.size),
  });

  // 2) Enroll every face in the ZIP into THIS organization's tenant so the live
  // pipeline starts recognising them — the AI extracts the archive (one folder
  // per person) and enrolls each image under the org tenant carried by the JWT.
  let enroll = null;
  try {
    const form = new FormData();
    form.append('file', file.buffer, {
      filename: file.originalName || 'dataset.zip',
      contentType: file.mimetype || 'application/zip',
    });
    const { data } = await axios.post(`${AI_BASE}/upload-dataset`, form, {
      headers: { ...proxyHeaders(req), ...form.getHeaders() },
      timeout: 180_000, // large archives take a while to embed
      maxContentLength: 200 * 1024 * 1024,
      maxBodyLength: 200 * 1024 * 1024,
    });
    enroll = data;
    logger.info('dataset enrolled into AI tenant', {
      userId: req.user.id, persons: data?.persons, enrolled: data?.enrolled, skipped: data?.skipped,
    });
  } catch (err) {
    logger.warn('dataset AI enrollment failed (archive still saved)', {
      userId: req.user.id, error: err.message, status: err.response?.status,
    });
  }

  res.json({
    success: true,
    dataset: {
      key,
      category,
      batchName,
      originalName: file.originalName,
      sizeBytes: file.size,
      uploadedAt: new Date().toISOString(),
    },
    enroll, // { persons, enrolled, skipped, by_person, errors } or null if AI unreachable
  });
}

/* ───────────────────── CHUNKED DATASET UPLOAD ─────────────────────
 *
 * WHY THIS EXISTS
 * The CDN in front of the app rejects any request body over 100 MB at its edge,
 * so a large training archive can never arrive as one request no matter what
 * our own limits say. The client therefore slices the file and sends parts that
 * each fit comfortably under that ceiling; we append them to a file on disk and
 * process the result exactly as if it had arrived whole.
 *
 * WHY DISK, NOT MEMORY
 * Chunks are appended straight to a temp file. Buffering a multi-hundred-MB
 * archive in RAM per concurrent upload is how a backend gets OOM-killed, and
 * this endpoint is reachable by any authenticated operator.
 *
 * SAFETY
 * Sessions live under a per-user directory keyed by a server-issued UUID, so one
 * operator cannot read or extend another's upload; the id is validated as a UUID
 * before it is ever used in a path, and the chunk index must be a plain integer,
 * so neither can escape the directory. Total size and chunk count are capped, and
 * stale sessions are swept, so an abandoned upload cannot fill the disk.
 */
const CHUNK_ROOT       = path.join(os.tmpdir(), 'drishyam-dataset-uploads');
const CHUNK_MAX_BYTES  = 25 * 1024 * 1024;         // per chunk — well under the edge limit
const DATASET_MAX_BYTES = 500 * 1024 * 1024;       // total assembled archive
const CHUNK_MAX_COUNT  = Math.ceil(DATASET_MAX_BYTES / (5 * 1024 * 1024)); // generous ceiling
const CHUNK_SESSION_TTL_MS = 6 * 60 * 60 * 1000;   // abandoned sessions swept after 6h

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const chunkUpload = multer({
  storage: multer.memoryStorage(),                 // one chunk at a time, bounded below
  limits:  { fileSize: CHUNK_MAX_BYTES },
}).single('chunk');

/** Resolve a session directory, refusing anything that isn't a plain UUID. */
function chunkSessionDir(userId, uploadId) {
  if (!UUID_RE.test(String(uploadId || ''))) throw new AppError('Invalid upload id.', 400);
  return path.join(CHUNK_ROOT, String(userId), String(uploadId));
}

/** Delete sessions older than the TTL. Best-effort; never throws into a request. */
async function sweepStaleChunkSessions() {
  try {
    const users = await fsp.readdir(CHUNK_ROOT).catch(() => []);
    const cutoff = Date.now() - CHUNK_SESSION_TTL_MS;
    for (const user of users) {
      const userDir = path.join(CHUNK_ROOT, user);
      const sessions = await fsp.readdir(userDir).catch(() => []);
      for (const s of sessions) {
        const dir = path.join(userDir, s);
        const st = await fsp.stat(dir).catch(() => null);
        if (st && st.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    logger.debug('chunk sweep failed', { error: err.message });
  }
}

/** POST /ai/watchlist/dataset/chunk/init → { uploadId } */
const initChunkedDataset = asyncHandler(async (req, res) => {
  const size = Number(req.body?.size) || 0;
  if (size > DATASET_MAX_BYTES) {
    throw new AppError(
      `Archive is too large. Maximum ${Math.floor(DATASET_MAX_BYTES / (1024 * 1024))} MB.`, 413,
    );
  }
  const uploadId = crypto.randomUUID();
  await fsp.mkdir(chunkSessionDir(req.user.id, uploadId), { recursive: true });
  sweepStaleChunkSessions();               // opportunistic, not awaited
  logger.info('chunked dataset upload started', { userId: req.user.id, uploadId, size });
  res.json({ success: true, uploadId, chunkSize: CHUNK_MAX_BYTES });
});

/** POST /ai/watchlist/dataset/chunk — fields: uploadId, index; file field: chunk */
const uploadDatasetChunk = [
  (req, res, next) => chunkUpload(req, res, (err) => {
    if (!err) return next();
    if (err.name === 'MulterError') {
      return next(err.code === 'LIMIT_FILE_SIZE'
        ? new AppError('Chunk exceeds the maximum part size.', 413)
        : new AppError(`Chunk upload failed: ${err.message}`, 400));
    }
    return next(err);
  }),
  asyncHandler(async (req, res) => {
    const { uploadId } = req.body;
    const index = Number(req.body?.index);

    if (!req.file) throw new AppError('No chunk received.', 400);
    if (!Number.isInteger(index) || index < 0 || index >= CHUNK_MAX_COUNT) {
      throw new AppError('Invalid chunk index.', 400);
    }

    const dir = chunkSessionDir(req.user.id, uploadId);
    // The session must already exist — this both proves /init ran and prevents a
    // caller inventing an id to write somewhere unexpected.
    if (!fs.existsSync(dir)) throw new AppError('Upload session not found or expired.', 410);

    await fsp.writeFile(path.join(dir, `${index}.part`), req.file.buffer);
    res.json({ success: true, index, received: req.file.size });
  }),
];

/** POST /ai/watchlist/dataset/chunk/complete — fields: uploadId, filename, totalChunks */
const completeChunkedDataset = asyncHandler(async (req, res) => {
  const { uploadId, filename } = req.body;
  const totalChunks = Number(req.body?.totalChunks);

  if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > CHUNK_MAX_COUNT) {
    throw new AppError('Invalid chunk count.', 400);
  }

  const dir = chunkSessionDir(req.user.id, uploadId);
  if (!fs.existsSync(dir)) throw new AppError('Upload session not found or expired.', 410);

  try {
    // Verify every part is present BEFORE assembling — a missing part would
    // otherwise produce a silently corrupt archive that fails much later, during
    // enrollment, where the real cause is no longer obvious.
    const parts = [];
    let total = 0;
    for (let i = 0; i < totalChunks; i += 1) {
      const p = path.join(dir, `${i}.part`);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) throw new AppError(`Upload incomplete — part ${i + 1} of ${totalChunks} is missing. Please retry.`, 400);
      total += st.size;
      parts.push(p);
    }
    if (total > DATASET_MAX_BYTES) {
      throw new AppError(`Assembled archive exceeds ${Math.floor(DATASET_MAX_BYTES / (1024 * 1024))} MB.`, 413);
    }

    // Assemble in order, then hand off to the same path a single-shot upload takes.
    const buffers = [];
    for (const p of parts) buffers.push(await fsp.readFile(p));
    const buffer = Buffer.concat(buffers);

    const originalName = String(filename || 'dataset.zip').slice(0, 200);
    if (!originalName.toLowerCase().endsWith('.zip')) {
      throw new AppError('Only .zip archives are accepted.', 400);
    }

    logger.info('chunked dataset assembled', {
      userId: req.user.id, uploadId, totalChunks, bytes: buffer.length,
    });

    return await finalizeDataset(req, res, {
      buffer,
      originalName,
      mimetype: 'application/zip',
      size: buffer.length,
    });
  } finally {
    // Always reclaim the parts, success or failure — otherwise a failed archive
    // keeps its full size on disk indefinitely.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const listDatasets = asyncHandler(async (req, res) => {
  const objects = await s3Service.listObjects(`watchlist-datasets/${req.user.id}/`);

  const datasets = await Promise.all(objects.map(async (obj) => {
    const url = await s3Service.getFileDownloadUrl(obj.Key, obj.Key.split('/').pop(), 3600);
    const parts = obj.Key.split('/');
    return {
      key:          obj.Key,
      filename:     parts[parts.length - 1],
      sizeBytes:    obj.Size,
      lastModified: obj.LastModified,
      downloadUrl:  url,
    };
  }));

  res.json({ success: true, datasets: datasets.sort((a, b) =>
    new Date(b.lastModified) - new Date(a.lastModified)
  )});
});

// GET /api/ai/watchlist → the org's enrolled watchlist people (name + image
// count), scoped to the caller's tenant by the org JWT. Powers the grid.
const listWatchlist = asyncHandler(async (req, res) => {
  if (!AI_BASE) throw new AppError('AI service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${AI_BASE}/faces`, {
      headers: proxyHeaders(req),
      timeout: 10_000,
    });
    res.json({ success: true, ...data });
  } catch (err) {
    logger.warn('watchlist list proxy failed', { error: err.message, status: err.response?.status });
    throw new AppError('Failed to load watchlist — AI service may be offline.', 502);
  }
});

/* ─────────────────── ACTIVITY MONITOR (productivity) ─────────────────── */
// Proxies to the activity-monitor service. That service is single-tenant — its
// store aggregates every monitored camera globally — so WITHOUT the scoping
// below, any account's attendance page showed every other account's people.
// These helpers isolate each response to the caller's OWN cameras:
//   - rows that carry a camera code (crossings.stream, alerts.camera) filter
//     directly against the caller's owned camera set;
//   - rows keyed only by person name (attendance.people, activity.people,
//     sessions, history) have no camera field, so we derive the set of names
//     seen on the caller's own cameras from the crossings feed and filter by it.
// Scoping fails CLOSED: on any error the caller gets their own (possibly empty)
// view, never the global one.

/** monitorIds (camera codes) owned by the caller's organisation. */
async function activityOwnedCodes(req) {
  const ownerId = req.user.parentUserId || req.user.id;
  const cams = await Camera.findAll({
    where: { userId: ownerId }, attributes: ['monitorId'], raw: true,
  });
  return new Set(cams.map((c) => c.monitorId).filter(Boolean));
}

/** Person names seen on the caller's own cameras (from the crossings feed). */
async function activityOwnedNames(codes) {
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/crossings`, {
      params: { limit: 5000 }, timeout: 8000,
    });
    const names = new Set();
    for (const r of (data.crossings || [])) {
      if (r && codes.has(r.stream) && r.name) names.add(r.name);
    }
    return names;
  } catch {
    return new Set();   // fail closed: no names → caller sees nothing, not everything
  }
}

// GET /api/ai/activity/people → per-person totals for today (who / count / minutes)
const activityPeople = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/people`, { timeout: 8000 });
    const names = await activityOwnedNames(await activityOwnedCodes(req));
    const people = (data.people || []).filter((p) => names.has(p.name));
    res.json({ ...data, people, total: people.length });
  } catch (err) {
    logger.warn('activity/people proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// GET /api/ai/activity/sessions → completed phone-usage sessions (evidence log)
const activitySessions = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/sessions`, {
      params: { limit: req.query.limit || 100, date: req.query.date },
      timeout: 8000,
    });
    const names = await activityOwnedNames(await activityOwnedCodes(req));
    const sessions = (data.sessions || []).filter((s) => names.has(s.name));
    res.json({ ...data, sessions, total: sessions.length });
  } catch (err) {
    logger.warn('activity/sessions proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// GET /api/ai/activity/history → per-person daily totals over the last N days (trends)
const activityHistory = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/history`, {
      params: { days: req.query.days || 7 }, timeout: 8000,
    });
    const names = await activityOwnedNames(await activityOwnedCodes(req));
    const people = (data.people || []).filter((p) => names.has(p.name || p.name));
    res.json({ ...data, people });
  } catch (err) {
    logger.warn('activity/history proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// GET /api/ai/activity/crossings → complete entry/exit feed (recognised + unknown)
const activityCrossings = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/crossings`, {
      params: { limit: req.query.limit || 200, date: req.query.date }, timeout: 8000,
    });
    const codes = await activityOwnedCodes(req);
    const crossings = (data.crossings || []).filter((r) => codes.has(r.stream));
    res.json({ ...data, crossings, total: crossings.length });
  } catch (err) {
    logger.warn('activity/crossings proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// GET /api/ai/activity/alerts → policy alerts (watchlist / stranger / after-hours) + today's counts
const activityAlerts = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/alerts`, {
      params: { limit: req.query.limit || 100, date: req.query.date, tier: req.query.tier }, timeout: 8000,
    });
    const codes = await activityOwnedCodes(req);
    // Keep alerts on the caller's cameras; keep camera-less alerts only if their
    // subject was seen on an owned camera (never blanket-pass a global alert).
    const names = await activityOwnedNames(codes);
    const alerts = (data.alerts || []).filter(
      (a) => (a.camera && codes.has(a.camera)) || (!a.camera && a.subject && names.has(a.subject)),
    );
    res.json({ ...data, alerts, total: alerts.length });
  } catch (err) {
    logger.warn('activity/alerts proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// POST /api/ai/activity/alerts/:id/ack → mark an alert acknowledged
const activityAckAlert = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.post(`${ACTIVITY_BASE}/activity/alerts/${encodeURIComponent(req.params.id)}/ack`, {}, { timeout: 8000 });
    res.json(data);
  } catch (err) {
    logger.warn('activity/alerts ack proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// POST /api/ai/notify/test-camera-offline → fire a sample camera-offline toast to
// the caller (auto-recovers after 8s) so the real-time notification path can be
// verified without waiting for an actual outage.
const notifyTestCameraOffline = asyncHandler(async (req, res) => {
  const ws = require('../services/ws.service');
  const cam = await Camera.findOne({ where: { userId: req.user.id }, order: [['createdAt', 'DESC']] });
  const monitorId = cam?.monitorId || 'test000000000000000000000000';
  ws.toUser(req.user.id, 'stream.status', {
    monitorId, status: 'offline',
    reason: 'Recorder / NVR unreachable — the site link or NVR appears down',
    reasonCode: 'nvr_unreachable',
  });
  setTimeout(() => ws.toUser(req.user.id, 'stream.status', { monitorId, status: 'online' }), 8000);
  res.json({ ok: true, monitorId, camera: cam?.name || null, note: 'offline toast sent · recovery in 8s' });
});

// ── Real-time person tracker (proxied to activity-monitor's LiveTracker) ──
// GET /api/ai/track/live[?name=] · GET /api/ai/track/graph · POST /api/ai/track/reset
const trackLive = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  const path = req.params.name
    ? `/track/live/${encodeURIComponent(req.params.name)}`
    : '/track/live';
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}${path}`, { timeout: 6000 });
    res.json(data);
  } catch (err) {
    logger.warn('track/live proxy failed', { error: err.message });
    throw new AppError('tracker service unavailable', 502);
  }
});

const trackGraph = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/track/graph`, { timeout: 6000 });
    res.json(data);
  } catch (err) {
    throw new AppError('tracker service unavailable', 502);
  }
});

const trackReset = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.post(`${ACTIVITY_BASE}/track/reset`, {}, { timeout: 6000 });
    res.json(data);
  } catch (err) {
    throw new AppError('tracker service unavailable', 502);
  }
});

// GET /api/ai/activity/events → unified event log (attendance + alerts merged)
const activityEvents = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/events`, {
      params: { types: req.query.types, camera: req.query.camera, name: req.query.name, date: req.query.date, limit: req.query.limit || 300 },
      timeout: 8000,
    });
    // Events are attendance + alerts merged; each carries a camera (or a subject
    // name). Scope to the caller's cameras / owned names.
    const codes = await activityOwnedCodes(req);
    const names = await activityOwnedNames(codes);
    const events = (data.events || []).filter(
      (e) => (e.camera && codes.has(e.camera)) || (e.stream && codes.has(e.stream))
        || (!e.camera && !e.stream && (e.name || e.subject) && names.has(e.name || e.subject)),
    );
    res.json({ ...data, events, total: events.length });
  } catch (err) {
    logger.warn('activity/events proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// GET /api/ai/activity/metrics → detection-funnel health (dedup ratio, recognition rate, sanity)
const activityMetrics = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/metrics`, {
      params: { date: req.query.date }, timeout: 8000,
    });
    // per_camera carries a camera code; scope it to the caller's cameras. The
    // global det_total/det_recog roll-ups are dropped rather than shown, since
    // they count every account's traffic.
    const codes = await activityOwnedCodes(req);
    const perCamera = (data.per_camera || []).filter((c) => codes.has(c.camera));
    res.json({
      ...data,
      per_camera: perCamera,
      det_total: perCamera.reduce((s, c) => s + (c.detections || 0), 0),
      det_recognized: perCamera.reduce((s, c) => s + (c.recognized || 0), 0),
    });
  } catch (err) {
    logger.warn('activity/metrics proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// ── Activity / phone-usage cameras (per-camera, whole-product) ─────────
//
// Phone-usage + seated/working monitoring runs on the cameras the operator
// picks — exactly like person-tracking. The per-camera flag lives in
// settings.ai.activityMonitoring; the activity-monitor is told the FULL desired
// set and reconciles its pose/phone workers at runtime (no restart). Every
// camera is pulled from Stream Service (cam_<monitorId>) — the same path vms_face
// already reads — so enabling it adds NO new NVR pull.

// Build the full activity-enabled camera set and push it to the activity-monitor.
// Best-effort: returns a status object, never throws to the request handler.
async function pushActivityCameras() {
  if (!ACTIVITY_BASE) return { ok: false, error: 'activity service not configured' };
  // The activity-monitor is one global service, so the desired set spans every
  // camera with the flag on (not just one user's). Filtered in JS — fine at this
  // scale; swap to a JSON_EXTRACT where-clause if the fleet grows large.
  const cams = await Camera.findAll({ attributes: ['id', 'name', 'monitorId', 'settings'] });
  const host = config.streamService.rtspHost;
  const port = config.streamService.rtspPort || 8554;
  const desired = [];
  for (const c of cams) {
    if (c.settings?.ai?.activityMonitoring === true && c.monitorId) {
      desired.push({
        id: c.monitorId,
        name: c.name || c.monitorId,
        source: `rtsp://${host}:${port}/cam_${c.monitorId}`,
        vms_camera: c.monitorId,
      });
    }
  }
  try {
    const { data } = await axios.post(`${ACTIVITY_BASE}/activity/cameras`, { cameras: desired }, { timeout: 8000 });
    logger.info('activity cameras pushed', { count: desired.length });
    return { ok: true, pushed: desired.length, data };
  } catch (err) {
    logger.warn('activity cameras push failed', { error: err.message });
    return { ok: false, error: err.message, pushed: desired.length };
  }
}

// POST /api/ai/activity-cameras  { cameraIds:[..], enabled?:bool }
// Turn activity/phone-usage monitoring ON or OFF for one or more cameras, then
// reconcile the activity-monitor to the new set.
const setActivityCameras = asyncHandler(async (req, res) => {
  const enabled = req.body?.enabled !== false; // default true
  const ids = Array.isArray(req.body?.cameraIds) ? req.body.cameraIds : [];
  if (!ids.length) throw new AppError('cameraIds (non-empty array) is required', 400);

  if (enabled) {
    const owned = await Camera.findAll({ where: { id: ids, userId: req.user.id }, attributes: ['id', 'settings'] });
    const turningOn = owned.filter((c) => c.settings?.ai?.activityMonitoring !== true).length;
    await assertAiLicence(req.user.id, 'activity', turningOn);
  }

  const results = [];
  for (const id of ids) {
    const camera = await Camera.findOne({ where: { id, userId: req.user.id } });
    if (!camera) { results.push({ id, ok: false, error: 'not found' }); continue; }
    const current = camera.settings || {};
    const nextAi = {
      ...(current.ai || {}),
      activityMonitoring: enabled,
      updatedAt: new Date().toISOString(),
    };
    await camera.update({ settings: { ...current, ai: nextAi } });
    results.push({ id, monitorId: camera.monitorId, ok: true, activityMonitoring: enabled });
  }

  const push = await pushActivityCameras();
  res.json({ success: true, count: results.length, enabled, data: results, push });
});

// GET /api/ai/activity-cameras → which cameras are enabled (DB truth) + live
// pipeline status (from the activity-monitor).
const getActivityCameras = asyncHandler(async (req, res) => {
  const cams = await Camera.findAll({
    where: { userId: req.user.id },
    attributes: ['id', 'name', 'monitorId', 'settings'],
    include: [{ model: CameraGroup, as: 'group', attributes: ['id', 'name', 'location'] }],
  });
  const enabled = cams
    .filter((c) => c.settings?.ai?.activityMonitoring === true)
    .map((c) => ({ id: c.id, monitorId: c.monitorId, name: c.name, group: c.group?.name || null }));

  let live = [];
  if (ACTIVITY_BASE) {
    try {
      const { data } = await axios.get(`${ACTIVITY_BASE}/activity/cameras`, { timeout: 5000 });
      live = data?.cameras || [];
    } catch (err) {
      logger.warn('activity cameras status fetch failed', { error: err.message });
    }
  }
  res.json({ success: true, data: { enabled, live } });
});

// GET /api/ai/activity/attendance → who's inside now (name + entry time) + recent in/out
const activityAttendance = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/attendance`, { timeout: 8000 });
    // Attendance people[] carry no camera field, so scope by the set of names
    // seen on the caller's OWN cameras (derived from crossings). recent[] are
    // crossings and carry a stream code, so scope those directly.
    const codes = await activityOwnedCodes(req);
    const names = await activityOwnedNames(codes);
    const people = (data.people || []).filter((p) => names.has(p.name));
    const inside = (data.inside || []).filter((p) => names.has(p.name));
    const recent = (data.recent || []).filter((r) => codes.has(r.stream));
    res.json({ ...data, people, inside, inside_count: inside.length, recent });
  } catch (err) {
    logger.warn('activity/attendance proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// GET /api/ai/activity/line → the drawn in/out line for a stream
const activityGetLine = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    // The activity-monitor keys lines by camera_code and reads the `camera`
    // query param — forward it as such (the SPA passes the monitorId as
    // `stream`/`camera`). Sending `stream=` made it fall back to the default
    // camera and report the wrong (or a null) line.
    const cam = req.query.camera || req.query.stream;
    const { data } = await axios.get(`${ACTIVITY_BASE}/activity/line`, {
      params: { camera: cam, stream: cam }, timeout: 8000,
    });
    res.json(data);
  } catch (err) {
    logger.warn('activity/line get proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// PUT /api/ai/activity/line → save the drawn in/out line
const activitySetLine = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.put(`${ACTIVITY_BASE}/activity/line`, req.body || {}, { timeout: 8000 });
    res.json(data);
  } catch (err) {
    logger.warn('activity/line set proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// GET /api/ai/activity/streams → per-stream live snapshot (people + states + fps)
const activityStreams = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  try {
    const { data } = await axios.get(`${ACTIVITY_BASE}/streams`, { timeout: 8000 });
    res.json(data);
  } catch (err) {
    logger.warn('activity/streams proxy failed', { error: err.message });
    throw new AppError('activity service unavailable', 502);
  }
});

// GET /api/ai/activity/snapshot/:streamId → latest annotated JPEG (image passthrough).
// 204 when there's no frame yet, so the polling <img> doesn't error-spam.
const activitySnapshot = asyncHandler(async (req, res) => {
  if (!ACTIVITY_BASE) throw new AppError('activity service URL is not configured', 502);
  const streamId = encodeURIComponent(req.params.streamId);
  try {
    const r = await axios.get(`${ACTIVITY_BASE}/snapshot/${streamId}`, {
      responseType: 'arraybuffer', timeout: 8000,
    });
    res.set('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(Buffer.from(r.data));
  } catch (err) {
    res.status(204).end();
  }
});

module.exports = {
  listEvents,
  eventHistogram,
  getReport,
  getSnapshotUrl,
  activityPeople,
  activitySessions,
  activityHistory,
  activityAttendance,
  activityCrossings,
  activityAlerts,
  activityAckAlert,
  activityMetrics,
  activityEvents,
  trackLive,
  trackGraph,
  trackReset,
  setActivityCameras,
  pushActivityCameras, // used by the admin console when it switches activity off on excess cameras
  getActivityCameras,
  notifyTestCameraOffline,
  activityGetLine,
  activitySetLine,
  activityStreams,
  activitySnapshot,
  acknowledgeEvent,
  uploadFace,
  deleteFace,
  listFaceLearningSamples,
  approveFaceLearningSample,
  rejectFaceLearningSample,
  getFaceLearningSnapshot,
  peopleCount,
  footfallCameras,
  footfallTimeseries,
  footfallGetConfig,
  footfallPutConfig,
  footfallExportCsv,
  enhanceFace,
  listCameraMapping,
  updateCameraMapping,
  listCameraAiSettings,
  updateCameraSettings,
  setCameraHeadcount,
  setPersonTrackerCameras,
  updateCameraAiLifecycle,
  handleUploadDataset,
  initChunkedDataset,
  uploadDatasetChunk,
  completeChunkedDataset,
  listDatasets,
  listWatchlist,
};
