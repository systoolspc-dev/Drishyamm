// Investigation toolkit proxy: Smart Search (I-2) over the AI track index.
//
// The browser never sends a tenant: the AI scopes every call to the org in the
// JWT minted from req.user (aiAuthHeader). On top of that the backend sends
// the caller's own camera codes as `scope_codes`, so results never come from
// a camera this user doesn't have (the AI's camera table can hold stale or
// other users' cameras), and their human names for the query parser
// ("gate 3" → that camera).
//
// Every search and track open is written to the audit log; the AI keeps its
// own audit_log rows too.
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');

const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { isIndexOff, indexOffError } = require('../utils/aiIndexOff');
const logger = require('../config/logger');
const { audit } = require('../utils/audit');
const { aiAuthHeader } = require('../utils/aiTenant');
const { Camera } = require('../models');

const BASE_URL = process.env.AI_SERVICE_URL || 'http://smart-cam-ai:8001';
const ai = axios.create({ baseURL: BASE_URL, timeout: 30_000 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const aiHeaders = (req) => ({
  ...aiAuthHeader(req.user),
  'X-User-Id': String(req.user?.id || ''),
  'X-Operator-Id': String(req.user?.id || ''),
});

/** The caller's cameras: [{ code: monitorId, name }]. */
async function ownCameras(userOrId) {
  // The organisation's cameras: the account owner's, plus any filed under the
  // caller themself. Never every camera: an empty id must match nothing.
  const user = typeof userOrId === 'object' ? userOrId : { id: userOrId };
  const ids = [...new Set([user?.id, user?.parentUserId].filter(Boolean))];
  if (!ids.length) return [];
  const cams = await Camera.findAll({ where: { userId: ids }, attributes: ['monitorId', 'name'] });
  // Imported videos (I-7) are searched like cameras: `file:<importId>`.
  let imported = [];
  try { imported = await require('./imports.controller').importCameras(user); } catch (_) { /* no imports table yet */ }
  return [...cams.filter((c) => c.monitorId).map((c) => ({ code: c.monitorId, name: c.name || null })), ...imported];
}

/** Names from MySQL, our own crop URL, nothing the browser can't use. */
function decorate(results, cameras) {
  const nameOf = Object.fromEntries(cameras.map((c) => [c.code, c.name]));
  return (results || []).map((r) => ({
    ...r,
    camera_name: (r.camera_code && nameOf[r.camera_code]) || r.camera_code || null,
    crop_url: `/api/investigate/tracks/${encodeURIComponent(r.track_id)}/crop`,
    crop_path: undefined,
  }));
}

function mapUpstreamError(err, where) {
  const status = err.response?.status || 502;
  const detail = err.response?.data?.detail || err.response?.data?.error || err.message;
  logger.warn('investigate proxy failed', { where, status, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  // Index switched off: say so plainly, whichever page asked (utils/aiIndexOff).
  if (isIndexOff(err) || (status === 404 && where.startsWith('search'))) return indexOffError();
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
    return AppError.public('Smart Search is still starting up. Try again in a minute.', 503);
  }
  return new AppError(`Smart Search ${where} failed: ${typeof detail === 'string' ? detail : 'upstream error'}`,
    status >= 400 && status < 600 ? status : 502);
}

const pickOverrides = (o = {}) => {
  const out = {};
  for (const k of ['camera_codes', 'object_class', 'since', 'until', 'top_colour', 'bottom_colour', 'vehicle_type', 'vehicle_colour', 'clear']) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
};

// ── POST /api/investigate/search ───────────────────────────────────
const search = asyncHandler(async (req, res) => {
  const { q = '', tz, overrides, top_k: topK } = req.body || {};
  if (typeof q !== 'string' || q.length > 300) throw new AppError('q must be text, at most 300 characters', 400);
  const cameras = await ownCameras(req.user);
  const body = {
    q,
    tz: typeof tz === 'string' && tz.length < 64 ? tz : 'Asia/Kolkata',
    cameras,
    overrides: pickOverrides(overrides),
    scope_codes: cameras.map((c) => c.code),
    top_k: Math.max(1, Math.min(200, Number(topK) || 50)),
  };
  let data;
  try {
    ({ data } = await ai.post('/investigate/search', body, { headers: aiHeaders(req) }));
  } catch (err) {
    audit('investigate.search', { req, targetType: 'tracks', outcome: 'failure', meta: { q } });
    throw mapUpstreamError(err, 'search');
  }
  data.results = decorate(data.results, cameras);
  audit('investigate.search', {
    req, targetType: 'tracks',
    meta: { q, filters: data.filters, count: data.results.length, model: data.model },
  });
  res.json(data);
});

// ── POST /api/investigate/search/photo (multipart: photo, filters?) ─
const searchPhoto = [
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('photo required', 400);
    const cameras = await ownCameras(req.user);
    let overrides = {};
    try { overrides = pickOverrides(JSON.parse(req.body?.filters || '{}')); } catch (_) {
      throw new AppError('filters must be JSON', 400);
    }
    const fd = new FormData();
    fd.append('photo', req.file.buffer, { filename: req.file.originalname || 'photo.jpg', contentType: req.file.mimetype });
    fd.append('filters', JSON.stringify(overrides));
    fd.append('scope_codes', JSON.stringify(cameras.map((c) => c.code)));
    fd.append('top_k', String(Math.max(1, Math.min(200, Number(req.body?.top_k) || 50))));
    let data;
    try {
      ({ data } = await ai.post('/investigate/search/photo', fd, {
        headers: { ...aiHeaders(req), ...fd.getHeaders() }, maxBodyLength: 10 * 1024 * 1024,
      }));
    } catch (err) {
      audit('investigate.search_photo', { req, targetType: 'tracks', outcome: 'failure' });
      throw mapUpstreamError(err, 'search by photo');
    }
    data.results = decorate(data.results, cameras);
    audit('investigate.search_photo', {
      req, targetType: 'tracks', meta: { filters: data.filters, count: data.results.length, bytes: req.file.size },
    });
    res.json(data);
  }),
];

// ── GET /api/investigate/tracks/:id ────────────────────────────────
const getTrack = asyncHandler(async (req, res) => {
  const cameras = await ownCameras(req.user);
  let data;
  try {
    ({ data } = await ai.get(`/investigate/tracks/${encodeURIComponent(req.params.id)}`, { headers: aiHeaders(req) }));
  } catch (err) {
    throw mapUpstreamError(err, 'track');
  }
  if (data.camera_code && !cameras.some((c) => c.code === data.camera_code)) throw new AppError('track not found', 404);
  const [row] = decorate([data], cameras);
  audit('investigate.track_open', { req, targetType: 'track', targetId: req.params.id });
  res.json(row);
});

// ── GET /api/investigate/tracks/:id/crop ───────────────────────────
const getTrackCrop = asyncHandler(async (req, res) => {
  try {
    const up = await ai.get(`/investigate/tracks/${encodeURIComponent(req.params.id)}/crop`, {
      headers: aiHeaders(req), responseType: 'arraybuffer', maxContentLength: 5 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (up.status >= 400) return res.status(up.status).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    return res.status(200).send(Buffer.from(up.data));
  } catch (err) {
    throw mapUpstreamError(err, 'crop');
  }
});

// ── GET /api/investigate/status ────────────────────────────────────
const status = asyncHandler(async (req, res) => {
  try {
    const { data } = await ai.get('/investigate/status', { headers: aiHeaders(req) });
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'status');
  }
});

// ── Click to track (I-3) ───────────────────────────────────────────

const nameMap = (cameras) => Object.fromEntries(cameras.map((c) => [c.code, c.name || c.code]));
const named = (rows, names) => (rows || []).map((r) => ({
  ...r,
  camera_name: names[r.camera_code] || r.camera_code || null,
  crop_url: `/api/investigate/tracks/${encodeURIComponent(r.track_id)}/crop`,
  crop_path: undefined,
}));

// POST /api/investigate/track-at  { camera_code, ts, x, y }  (x, y: 0-1000 across the frame)
const trackAt = asyncHandler(async (req, res) => {
  const { camera_code: cameraCode, ts, x, y } = req.body || {};
  if (!cameraCode || !ts || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw new AppError('camera_code, ts, x and y are required.', 400);
  }
  const cameras = await ownCameras(req.user);
  if (!cameras.some((c) => c.code === cameraCode)) throw new AppError('Camera not found.', 404);
  try {
    const { data } = await ai.post('/investigate/track-at', {
      camera_code: cameraCode, ts, x: Number(x), y: Number(y), scope_codes: cameras.map((c) => c.code),
    }, { headers: aiHeaders(req) });
    audit('investigate.track_at', { req, targetType: 'track', targetId: data.track_id, meta: { cameraCode, ts } });
    res.json(data);
  } catch (err) {
    if (err.response?.status === 404 && !isIndexOff(err)) throw new AppError('No one indexed at that spot. Click on a person while they are on screen.', 404);
    throw mapUpstreamError(err, 'track-at');
  }
});

// POST /api/investigate/journey  { track_id, window_s? }
const journey = asyncHandler(async (req, res) => {
  const { track_id: trackId, window_s: windowS } = req.body || {};
  if (!trackId) throw new AppError('track_id is required.', 400);
  const cameras = await ownCameras(req.user);
  const names = nameMap(cameras);
  let data;
  try {
    ({ data } = await ai.post('/investigate/journey', {
      track_id: trackId, scope_codes: cameras.map((c) => c.code),
      ...(windowS ? { window_s: Math.max(60, Math.min(48 * 3600, Number(windowS) || 0)) } : {}),
    }, { headers: aiHeaders(req) }));
  } catch (err) {
    throw mapUpstreamError(err, 'journey');
  }
  data.seed = named([data.seed], names)[0];
  data.stops = named(data.stops, names);
  data.candidates = named(data.candidates, names);
  data.route = (data.route_codes || []).map((c) => names[c] || c);
  for (const s of data.sightings || []) s.camera_name = names[s.camera_code] || s.camera_code;
  audit('investigate.journey', { req, targetType: 'track', targetId: trackId, meta: { stops: data.stops.length, proposed: data.candidates.length } });
  res.json(data);
});

// POST /api/investigate/journey/review  { seed_track_id, track_id, verdict: confirmed|rejected|clear, score? }
const review = asyncHandler(async (req, res) => {
  const { seed_track_id: seed, track_id: trackId, verdict, score } = req.body || {};
  if (!seed || !trackId || !['confirmed', 'rejected', 'clear'].includes(verdict)) {
    throw new AppError('seed_track_id, track_id and verdict (confirmed, rejected or clear) are required.', 400);
  }
  try {
    const { data } = await ai.post('/investigate/journey/review', {
      seed_track_id: seed, track_id: trackId, verdict, score: Number.isFinite(Number(score)) ? Number(score) : null,
    }, { headers: aiHeaders(req) });
    audit(`investigate.journey_${verdict}`, { req, targetType: 'track', targetId: trackId, meta: { seed, score } });
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'review');
  }
});

// Stitched journey video: the existing journey stitch job (reads local
// recordings only, never the NVR), proxied under the investigation gate.
const stitch = asyncHandler(async (req, res) => {
  const sightings = Array.isArray(req.body?.sightings) ? req.body.sightings.slice(0, 50) : [];
  if (!sightings.length) throw new AppError('Confirm at least one sighting first.', 400);
  try {
    const { data } = await ai.post('/journey/stitch', { sightings, include_overlays: true, include_intro_card: true },
      { headers: aiHeaders(req) });
    audit('investigate.journey_stitch', { req, targetType: 'journey', targetId: data.job_id, meta: { sightings: sightings.length } });
    res.status(202).json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'stitch');
  }
});

const stitchStatus = asyncHandler(async (req, res) => {
  try {
    const { data } = await ai.get(`/journey/stitch/${encodeURIComponent(req.params.jobId)}`, { headers: aiHeaders(req) });
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'stitch status');
  }
});

const stitchVideo = asyncHandler(async (req, res) => {
  try {
    const up = await ai.get(`/journey/stitch/${encodeURIComponent(req.params.jobId)}/video`, {
      headers: aiHeaders(req), responseType: 'arraybuffer', timeout: 120_000,
      maxContentLength: 250 * 1024 * 1024, validateStatus: (s) => s >= 200 && s < 500,
    });
    if (up.status >= 400) return res.status(up.status).end();
    res.set('Content-Type', 'video/mp4');
    res.set('Cache-Control', 'private, max-age=300');
    return res.status(200).send(Buffer.from(up.data));
  } catch (err) {
    throw mapUpstreamError(err, 'stitch video');
  }
});

// ── Smart Skim (I-6) ───────────────────────────────────────────────
// GET /api/investigate/activity?monitorId=&from=&to=&binS=
const activity = asyncHandler(async (req, res) => {
  const { monitorId, from, to, binS } = req.query;
  if (!monitorId || !from || !to) throw new AppError('monitorId, from and to are required.', 400);
  const cameras = await ownCameras(req.user);
  if (!cameras.some((c) => c.code === monitorId)) throw new AppError('Camera not found.', 404);
  try {
    const { data } = await ai.get('/investigate/activity', {
      headers: aiHeaders(req),
      params: { camera_code: monitorId, since: from, until: to, ...(binS ? { bin_s: binS } : {}), scope: cameras.map((c) => c.code).join(',') },
    });
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'activity');
  }
});

// ── Associations (phase 4): who was with this person ───────────────
// GET /api/investigate/tracks/:id/companions?journey=1
const companions = asyncHandler(async (req, res) => {
  const cameras = await ownCameras(req.user);
  const names = nameMap(cameras);
  let data;
  try {
    ({ data } = await ai.get(`/investigate/tracks/${encodeURIComponent(req.params.id)}/companions`, {
      headers: aiHeaders(req), params: { journey: req.query.journey !== '0', scope: cameras.map((c) => c.code).join(',') },
    }));
  } catch (err) {
    throw mapUpstreamError(err, 'companions');
  }
  data.companions = named(data.companions, names);
  data.stops = data.stops.map((s) => ({ ...s, camera_name: names[s.camera_code] || s.camera_code, companions: named(s.companions, names) }));
  audit('investigate.companions', { req, targetType: 'track', targetId: req.params.id, meta: { companions: data.companions.length } });
  res.json(data);
});

// ── Video synopsis (phase 4): busy stretches, sped up ──────────────
// POST /api/investigate/synopsis { monitorId, from, to, tzOffsetMin?, speed? }
const synopsis = asyncHandler(async (req, res) => {
  const { monitorId, from, to, tzOffsetMin, speed } = req.body || {};
  if (!monitorId || !from || !to) throw new AppError('monitorId, from and to are required.', 400);
  const cameras = await ownCameras(req.user);
  const cam = cameras.find((c) => c.code === monitorId);
  if (!cam) throw new AppError('Camera not found.', 404);
  try {
    const { data } = await ai.post('/investigate/synopsis', {
      camera_code: monitorId, camera_name: cam.name || monitorId, since: from, until: to,
      tz_offset_min: Number.isFinite(Number(tzOffsetMin)) ? Math.round(Number(tzOffsetMin)) : 330,
      ...(speed ? { speed: Number(speed) } : {}), scope_codes: cameras.map((c) => c.code),
    }, { headers: aiHeaders(req) });
    audit('investigate.synopsis', { req, targetType: 'camera', targetId: monitorId, meta: { from, to, speed: data.speed } });
    res.status(202).json(data);
  } catch (err) {
    if (err.response?.status === 404 && !isIndexOff(err)) throw new AppError(err.response.data?.detail || 'Nothing to make a synopsis of.', 404);
    throw mapUpstreamError(err, 'synopsis');
  }
});

const synopsisStatus = asyncHandler(async (req, res) => {
  try {
    const { data } = await ai.get(`/investigate/synopsis/${encodeURIComponent(req.params.jobId)}`, { headers: aiHeaders(req) });
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'synopsis status');
  }
});

const synopsisVideo = asyncHandler(async (req, res) => {
  try {
    const up = await ai.get(`/investigate/synopsis/${encodeURIComponent(req.params.jobId)}/video`, {
      headers: aiHeaders(req), responseType: 'arraybuffer', timeout: 120_000, maxContentLength: 500 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (up.status >= 400) return res.status(up.status).end();
    res.set('Content-Type', 'video/mp4');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.status(200).send(Buffer.from(up.data));
  } catch (err) {
    throw mapUpstreamError(err, 'synopsis video');
  }
});

// ── Audio Search (phase 4): what was said ─────────────────────────
// POST /api/investigate/speech/transcribe { monitorId, from?, to? }  (imported video: from/to optional)
const transcribe = asyncHandler(async (req, res) => {
  const { monitorId, from, to } = req.body || {};
  if (!monitorId) throw new AppError('monitorId is required.', 400);
  const cameras = await ownCameras(req.user);
  if (!cameras.some((c) => c.code === monitorId)) throw new AppError('Camera not found.', 404);
  try {
    const { data } = await ai.post('/investigate/speech/transcribe', {
      camera_code: monitorId, ...(from ? { since: from } : {}), ...(to ? { until: to } : {}), scope_codes: cameras.map((c) => c.code),
    }, { headers: aiHeaders(req) });
    audit('investigate.speech_transcribe', { req, targetType: 'camera', targetId: monitorId, meta: { from, to } });
    res.status(202).json(data);
  } catch (err) {
    if (err.response?.status === 404 && !isIndexOff(err)) throw new AppError(err.response.data?.detail || 'Nothing to transcribe.', 404);
    throw mapUpstreamError(err, 'transcribe');
  }
});

const transcribeStatus = asyncHandler(async (req, res) => {
  try {
    const { data } = await ai.get(`/investigate/speech/jobs/${encodeURIComponent(req.params.jobId)}`, { headers: aiHeaders(req) });
    res.json(data);
  } catch (err) {
    throw mapUpstreamError(err, 'transcribe status');
  }
});

// GET /api/investigate/speech?q=
const speechSearch = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2 || q.length > 200) throw new AppError('Search for 2–200 characters.', 400);
  const cameras = await ownCameras(req.user);
  const names = nameMap(cameras);
  let data;
  try {
    ({ data } = await ai.get('/investigate/speech', { headers: aiHeaders(req), params: { q, scope: cameras.map((c) => c.code).join(','), limit: 100 } }));
  } catch (err) {
    throw mapUpstreamError(err, 'speech search');
  }
  data.results = data.results.map((r) => ({ ...r, camera_name: names[r.camera_code] || r.camera_code }));
  audit('investigate.speech_search', { req, meta: { q, count: data.results.length } });
  res.json(data);
});

// ── Ask Drishyam (I-8) and AI Summaries (I-9) ─────────────────────
const askSvc = require('../services/ask');
const safeTz = (tz) => (typeof tz === 'string' && /^[A-Za-z_/+-]{1,64}$/.test(tz) ? tz : 'Asia/Kolkata');

// POST /api/investigate/ask  { question, tz }
const ask = asyncHandler(async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (question.length < 3 || question.length > 500) throw new AppError('Ask a question (3–500 characters).', 400);
  const cameras = await ownCameras(req.user);
  let out;
  try {
    out = await askSvc.ask({ user: req.user, cameras, question, tz: safeTz(req.body?.tz) });
  } catch (err) {
    audit('investigate.ask', { req, outcome: 'failure', meta: { question } });
    throw mapUpstreamError(err, 'ask');
  }
  audit('investigate.ask', { req, meta: { question, mode: out.mode, tools: out.tools, citations: out.citations.length } });
  res.json(out);
});

// GET /api/investigate/summary?period=last_night|today|yesterday|last_24h&tz=&camera=Name
const summary = asyncHandler(async (req, res) => {
  const cameras = await ownCameras(req.user);
  const period = ['last_night', 'today', 'yesterday', 'last_24h'].includes(req.query.period) ? req.query.period : 'last_night';
  const names = [].concat(req.query.camera || []).map(String).slice(0, 20);
  let out;
  try {
    out = await askSvc.summary({ user: req.user, cameras, tz: safeTz(req.query.tz), period, cameraNames: names });
  } catch (err) {
    throw mapUpstreamError(err, 'summary');
  }
  audit('investigate.summary', { req, meta: { period, cameras: names } });
  res.json(out);
});

module.exports = {
  ask, summary, companions, synopsis, synopsisStatus, synopsisVideo, transcribe, transcribeStatus, speechSearch,
  search, searchPhoto, getTrack, getTrackCrop, status,
  trackAt, journey, review, stitch, stitchStatus, stitchVideo, activity,
  _internals: { decorate, pickOverrides, ownCameras },
};
