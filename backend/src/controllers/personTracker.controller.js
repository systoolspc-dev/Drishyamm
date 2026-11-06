// Journey proxy controller (formerly the person-tracker proxy).
//
// CENTRALIZED: the forensic journey engine now lives in smart-cam-ai under
// /journey/* (it absorbed the standalone person-tracker service). The backend
// keeps the same /api/person-tracker/* surface (so the SPA is unchanged) but
// forwards upstream to smart-cam-ai. Auth: X-Service-Token + the operator id
// header (smart-cam-ai resolves the tenant from it, or dev-bypass → default).
// See docs/JOURNEY_CENTRALIZATION.md.
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');

const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');
const { aiAuthHeader } = require('../utils/aiTenant');
const { Camera } = require('../models');

// In-memory multipart upload — same pattern as the AI face-enhance route.
// 10 MB cap: face photos are kilobytes, not megabytes; this is a generous
// safety net against a wedged client that streams junk.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const BASE_URL = process.env.AI_SERVICE_URL || 'http://smart-cam-ai:8001';
const SERVICE_TOKEN = process.env.AI_SERVICE_TOKEN || process.env.PERSON_TRACKER_SERVICE_TOKEN || '';

// Shared axios instance — connection-pooling matters for the polling
// pattern (`GET /journey/stitch/:id` every 2-3s while a job renders).
const ptaxios = axios.create({
  baseURL: BASE_URL,
  timeout: 60_000,
  headers: SERVICE_TOKEN ? { 'X-Service-Token': SERVICE_TOKEN } : {},
});

// Per-request operator header so smart-cam-ai can attribute the journey to the
// authenticated user (matches ai.controller's aiOperatorHeaders pattern).
// Per-request headers so smart-cam-ai scopes the journey to the caller's ORG
// tenant (Authorization JWT) and attributes it to the user. Applied to EVERY
// journey call so search/cluster/stitch/status all resolve the same tenant —
// a job created under one tenant must be fetched under the same one.
const opHeaders = (req) => ({
  ...aiAuthHeader(req.user),
  'X-User-Id': String(req.user?.id || ''),
  'X-Operator-Id': String(req.user?.id || ''),
});

// Cameras the operator enabled for journey tracking (per-camera
// settings.ai.journeyMapping, set in Camera Setup → AI Detection). Returns the
// enabled monitor_ids + whether ANY were turned off, so the journey search only
// scopes when the operator has actually disabled some (avoids over-filtering
// when camera lists are merely out of sync).
async function journeyEnabledCodes(userId) {
  // Scope to THIS operator's cameras — the AI's Postgres camera table holds
  // extra/stale rows (decommissioned + other-tenant cameras) whose codes leak
  // into unscoped results with wrong names. Restricting to the operator's real
  // monitor_ids is also what keeps names resolvable in MySQL.
  const where = userId ? { userId } : {};
  const cams = await Camera.findAll({ where, attributes: ['monitorId', 'settings'] });
  const codes = [];
  let disabled = 0;
  for (const c of cams) {
    const jm = c.settings?.ai?.journeyMapping;
    if (jm === false) { disabled += 1; continue; }
    if (c.monitorId) codes.push(c.monitorId);
  }
  return { codes, someDisabled: disabled > 0 };
}

// The AI service only knows cameras by monitor_id (its `camera_code`); the
// human name ("office 13 - Camera 03") lives here in MySQL. Enrich any list of
// journey rows (candidates or sightings) in place so the SPA can show real
// camera names instead of the raw id. One batched query per response.
async function attachCameraNames(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const codes = [...new Set(rows.map((r) => r?.camera_code).filter(Boolean))];
  if (!codes.length) return;
  const cams = await Camera.findAll({
    where: { monitorId: codes },
    attributes: ['monitorId', 'name'],
  });
  const nameByCode = {};
  for (const c of cams) if (c.name) nameByCode[c.monitorId] = c.name;
  for (const r of rows) {
    if (!r?.camera_code) continue;
    // MySQL is authoritative. On a miss (stale/decommissioned camera in the
    // AI's Postgres), show the honest raw code — NEVER keep the AI's obsolete
    // human name (that's how "office 13 - Camera 03" style wrong names leaked).
    r.camera_name = nameByCode[r.camera_code] || r.camera_code;
  }
}


// ── POST /api/person-tracker/search ────────────────────────────────
// Forwards the multipart photo + optional filters.
const search = [
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('face photo required', 400);

    const fd = new FormData();
    fd.append('file', req.file.buffer, {
      filename: req.file.originalname || 'face.jpg',
      contentType: req.file.mimetype || 'image/jpeg',
    });
    for (const k of ['window_start', 'window_end', 'min_similarity', 'camera_ids', 'camera_codes']) {
      if (req.body?.[k] != null && req.body[k] !== '') fd.append(k, String(req.body[k]));
    }
    // Respect the per-camera "Journey mapping" toggle: when the operator didn't
    // pick cameras explicitly (no camera_ids/camera_codes), scope the search to
    // journey-enabled cameras (only if some are turned off — else leave = all).
    if (!req.body?.camera_ids && !req.body?.camera_codes) {
      try {
        // ALWAYS scope to the operator's real cameras (not only when some are
        // disabled). This keeps stale/other-tenant cameras in the AI's Postgres
        // out of results — which is what produced wrong camera names.
        const { codes } = await journeyEnabledCodes(req.user?.id);
        if (codes.length) fd.append('camera_codes', codes.join(','));
      } catch (e) {
        logger.warn('journey camera scoping skipped', { err: e.message });
      }
    }
    try {
      const { data } = await ptaxios.post('/journey/search', fd, {
        headers: { ...fd.getHeaders(), ...opHeaders(req) },
        maxContentLength: 20 * 1024 * 1024,
        maxBodyLength: 20 * 1024 * 1024,
      });
      await attachCameraNames(data?.candidates);
      res.json(data);
    } catch (err) {
      throw mapUpstreamError(err, 'search');
    }
  }),
];


// ── POST /api/person-tracker/sightings/cluster ─────────────────────
const clusterSightings = asyncHandler(async (req, res) => {
  try {
    const { data } = await ptaxios.post('/journey/cluster', req.body || {}, { headers: opHeaders(req) });
    await attachCameraNames(data?.sightings);
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'clusterSightings');
  }
});


// ── POST /api/person-tracker/stitch ────────────────────────────────
const createStitchJob = asyncHandler(async (req, res) => {
  try {
    const { data } = await ptaxios.post('/journey/stitch', req.body || {}, { headers: opHeaders(req) });
    res.status(202).json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'createStitchJob');
  }
});


// ── GET /api/person-tracker/stitch/:jobId ──────────────────────────
const getStitchJobStatus = asyncHandler(async (req, res) => {
  try {
    const { data } = await ptaxios.get(`/journey/stitch/${req.params.jobId}`, { headers: opHeaders(req) });
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'getStitchJobStatus');
  }
});


// ── GET /api/person-tracker/stitch/:jobId/video ────────────────────
// smart-cam-ai now STREAMS the MP4 bytes (it used to 302 to a presigned MinIO
// URL, but the browser can't reach the internal `minio:9000` host — that broke
// both playback and download). We relay the bytes through here, same as the
// snapshot proxy. video/mp4 content-type lets <video> play it inline.
const downloadVideo = asyncHandler(async (req, res) => {
  try {
    const upstream = await ptaxios.get(`/journey/stitch/${req.params.jobId}/video`, {
      headers: opHeaders(req),
      responseType: 'arraybuffer',
      maxContentLength: 250 * 1024 * 1024,
      maxBodyLength: 250 * 1024 * 1024,
      timeout: 120_000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (upstream.status >= 400) return res.status(upstream.status).end();
    res.set('Content-Type', upstream.headers['content-type'] || 'video/mp4');
    res.set('Content-Disposition',
      upstream.headers['content-disposition'] || `inline; filename="journey-${req.params.jobId}.mp4"`);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, max-age=300');
    return res.status(200).send(Buffer.from(upstream.data));
  } catch (err) {
    throw mapUpstreamError(err, 'downloadVideo');
  }
});


// ── GET /api/person-tracker/stitch/:jobId/report.pdf ───────────────
// Same byte-relay as the video (upstream streams the PDF, not a redirect).
const downloadReport = asyncHandler(async (req, res) => {
  try {
    const upstream = await ptaxios.get(`/journey/stitch/${req.params.jobId}/report.pdf`, {
      headers: opHeaders(req),
      responseType: 'arraybuffer',
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (upstream.status >= 400) return res.status(upstream.status).end();
    res.set('Content-Type', upstream.headers['content-type'] || 'application/pdf');
    res.set('Content-Disposition',
      upstream.headers['content-disposition'] || `inline; filename="journey-${req.params.jobId}.pdf"`);
    res.set('Cache-Control', 'private, max-age=300');
    return res.status(200).send(Buffer.from(upstream.data));
  } catch (err) {
    throw mapUpstreamError(err, 'downloadReport');
  }
});


// ── GET /api/person-tracker/stitch/:jobId/map.json ─────────────────
const getMap = asyncHandler(async (req, res) => {
  try {
    const { data } = await ptaxios.get(`/journey/stitch/${req.params.jobId}/map.json`, { headers: opHeaders(req) });
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'getMap');
  }
});


// ── GET /api/person-tracker/snapshot?uri=s3://... ──────────────────
// The sighting cards show the real matched-face crop. upstream streams the
// small image bytes (not a presigned redirect, since the browser can't
// resolve the internal `minio` host). We relay the bytes + content-type.
// A missing/expired crop comes back as a 4xx with no body so the SPA can
// fall back to the placeholder tile without surfacing a hard error.
const getSnapshot = asyncHandler(async (req, res) => {
  const { uri } = req.query;
  if (!uri) throw new AppError('snapshot uri required', 400);
  try {
    const upstream = await ptaxios.get('/journey/snapshot', {
      headers: opHeaders(req),
      params: { uri },
      responseType: 'arraybuffer',
      maxContentLength: 15 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (upstream.status >= 400) {
      return res.status(upstream.status).end();
    }
    res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=300');
    return res.status(200).send(Buffer.from(upstream.data));
  } catch (err) {
    throw mapUpstreamError(err, 'getSnapshot');
  }
});


function mapUpstreamError(err, where) {
  const status = err.response?.status || 502;
  const detail = err.response?.data?.detail || err.response?.data?.error || err.message;
  logger.warn('person-tracker proxy failed', { where, status, detail });
  return new AppError(`person-tracker ${where} failed: ${detail}`, status >= 400 && status < 600 ? status : 502);
}


module.exports = {
  search,
  clusterSightings,
  createStitchJob,
  getStitchJobStatus,
  downloadVideo,
  downloadReport,
  getMap,
  getSnapshot,
};
