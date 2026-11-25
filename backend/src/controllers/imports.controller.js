// File import (investigation toolkit I-7): bring in a video from a phone, USB
// stick or another recorder and search it like a camera.
//
//   POST   /api/investigate/imports            multipart: video (+ title, place, source, recordedAt?, fileModifiedAt?)
//   GET    /api/investigate/imports            the account's imports (status follows the AI job)
//   GET    /api/investigate/imports/:id        one import
//   POST   /api/investigate/imports/:id/index  index it (again)
//   GET    /api/investigate/imports/:id/video  the file itself (range requests; JWT may ride as ?token=)
//   DELETE /api/investigate/imports/:id        delete the file and everything indexed from it
//
// The SHA-256 is computed while the upload is written (utils/hashingStorage).
// The AI indexes it on the GPU into the same search index as live cameras,
// under the virtual camera `file:<id>`, dated from `recorded_start`.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const axios = require('axios');
const multer = require('multer');

const asyncHandler = require('../middleware/asyncHandler');
const AppError = require('../utils/AppError');
const { INDEX_OFF, isIndexOff, indexOffError } = require('../utils/aiIndexOff');
const logger = require('../config/logger');
const config = require('../config/env');
const { audit } = require('../utils/audit');
const { aiAuthHeader, aiTenantId } = require('../utils/aiTenant');
const { hashingStorage } = require('../utils/hashingStorage');

const IMPORTS_DIR = process.env.IMPORTS_DIR || path.join(config.streamService?.recordingsDir || '/recordings', '_imports');
const MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES) || 8 * 1024 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|ts|mts|m2ts|3gp|webm|dav|h264|h265|hevc)$/i;
const ai = axios.create({ baseURL: process.env.AI_SERVICE_URL || 'http://smart-cam-ai:8001', timeout: 20_000 });
const models = () => require('../models');
const ownerId = (u) => String(u?.parentUserId || u?.id || '');
const safeName = (n) => String(n || 'video').replace(/[^\w.-]+/g, '_').replace(/^_+/, '').slice(-120) || 'video';

const upload = multer({
  storage: hashingStorage({
    destination: (req, file) => {
      req.importId = req.importId || crypto.randomUUID();
      return path.join(IMPORTS_DIR, String(aiTenantId(req.user)), req.importId, safeName(file.originalname));
    },
  }),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 20 },
  fileFilter: (_req, file, cb) => cb(null, VIDEO_EXT.test(file.originalname || '') || /^video\//.test(file.mimetype || '')),
});

function ffprobe(p) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', p], { timeout: 60_000, maxBuffer: 8 << 20 },
      (err, stdout) => {
        if (err) return resolve(null);
        try { return resolve(JSON.parse(stdout)); } catch { return resolve(null); }
      });
  });
}

/** Video facts and the recording start the file itself claims (if any). */
function videoFacts(probe) {
  const v = (probe?.streams || []).find((s) => s.codec_type === 'video');
  if (!v) return null;
  const dur = Number(probe.format?.duration || v.duration) || null;
  const created = probe.format?.tags?.creation_time || v.tags?.creation_time || null;
  const createdMs = created ? Date.parse(created) : NaN;
  return {
    durationS: dur,
    // A phone writes creation_time at the END of recording on some models and at the start on
    // others; 1970/2000 placeholders are common on DVR exports. Trust it only if plausible.
    fileStart: Number.isFinite(createdMs) && createdMs > Date.parse('2005-01-01') && createdMs < Date.now() + 86_400_000
      ? new Date(createdMs) : null,
    info: { codec: v.codec_name, width: v.width, height: v.height, fps: v.avg_frame_rate, audio: (probe.streams || []).some((s) => s.codec_type === 'audio') },
  };
}

function view(r) {
  return {
    id: r.id, title: r.title, place: r.place, source: r.source, originalName: r.originalName, size: Number(r.size),
    sha256: r.sha256, recordedStart: r.recordedStart, recordedStartSource: r.recordedStartSource, durationS: r.durationS,
    video: r.videoInfo || {}, status: r.status, progress: r.progress, tracks: r.tracks, error: r.error,
    indexedAt: r.indexedAt, indexSeconds: r.indexSeconds, uploadedBy: r.uploadedByName, createdAt: r.createdAt,
    cameraCode: `file:${r.id}`, caseId: r.caseId,
  };
}

async function ownImport(req) {
  const row = await models().VideoImport.findByPk(req.params.id);
  if (!row || row.userId !== ownerId(req.user)) throw new AppError('Import not found.', 404);
  return row;
}

async function startIndex(req, row) {
  try {
    const { data } = await ai.post('/investigate/imports', {
      import_id: row.id, path: row.path, name: row.title, recorded_start: new Date(row.recordedStart).toISOString(),
    }, { headers: aiAuthHeader(req.user) });
    await row.update({ status: data.status === 'ready' ? 'ready' : 'indexing', progress: data.progress || 0, error: null });
  } catch (e) {
    const msg = isIndexOff(e) ? INDEX_OFF : (e.response?.data?.detail || e.message);
    await row.update({ status: 'failed', error: `Could not start indexing: ${typeof msg === 'string' ? msg : 'AI error'}`.slice(0, 500) });
  }
}

/** Bring queued/indexing rows up to date from the AI job. */
async function refresh(req, rows) {
  await Promise.all(rows.filter((r) => ['queued', 'indexing'].includes(r.status)).map(async (r) => {
    try {
      const { data } = await ai.get(`/investigate/imports/${r.id}`, { headers: aiAuthHeader(req.user), timeout: 5000 });
      if (data.status === 'unknown') {
        await r.update({ status: 'failed', error: 'Indexing stopped (the AI service restarted). Start it again.' });
      } else {
        await r.update({
          status: data.status, progress: data.progress ?? r.progress, tracks: data.tracks ?? r.tracks, error: data.error || null,
          ...(data.status === 'ready' ? { indexedAt: new Date(), indexSeconds: data.took_s ?? null } : {}),
          ...(data.duration_s && !r.durationS ? { durationS: data.duration_s } : {}),
        });
      }
    } catch (_) { /* AI busy or down: leave as is */ }
  }));
}

const create = [
  upload.single('video'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('Choose a video file (MP4, MOV, MKV, AVI, TS, DAV…).', 400);
    const { VideoImport } = models();
    const facts = videoFacts(await ffprobe(req.file.path));
    if (!facts) {
      fs.rm(path.dirname(req.file.path), { recursive: true, force: true }, () => {});
      throw new AppError('That file has no video stream that can be read.', 422);
    }
    const said = req.body?.recordedAt ? new Date(req.body.recordedAt) : null;
    const modified = req.body?.fileModifiedAt ? new Date(req.body.fileModifiedAt) : null;
    let recordedStart; let startSource;
    if (said && !Number.isNaN(said.getTime())) { recordedStart = said; startSource = 'user'; }
    else if (facts.fileStart) { recordedStart = facts.fileStart; startSource = 'file'; }
    else if (modified && !Number.isNaN(modified.getTime())) {
      // A file's modified time is usually when recording stopped.
      recordedStart = new Date(modified.getTime() - (facts.durationS || 0) * 1000); startSource = 'modified';
    } else { recordedStart = new Date(Date.now() - (facts.durationS || 0) * 1000); startSource = 'upload'; }

    const row = await VideoImport.create({
      id: req.importId, tenantId: aiTenantId(req.user), userId: ownerId(req.user),
      uploadedBy: req.user.id, uploadedByName: req.user.name || req.user.email || String(req.user.id),
      title: String(req.body?.title || req.file.originalname).trim().slice(0, 200) || req.file.originalname,
      place: req.body?.place ? String(req.body.place).slice(0, 200) : null,
      source: ['phone', 'usb', 'nvr', 'other'].includes(req.body?.source) ? req.body.source : 'other',
      originalName: String(req.file.originalname).slice(0, 255), path: req.file.path, size: req.file.size,
      sha256: req.file.sha256, mime: req.file.mimetype, recordedStart, recordedStartSource: startSource,
      durationS: facts.durationS, videoInfo: facts.info, caseId: req.body?.caseId || null,
    });
    audit('investigate.import', { req, targetType: 'import', targetId: row.id, meta: { name: row.originalName, size: row.size, sha256: row.sha256 } });
    await startIndex(req, row);
    res.status(201).json({ success: true, import: view(row) });
  }),
];

const list = asyncHandler(async (req, res) => {
  const rows = await models().VideoImport.findAll({ where: { userId: ownerId(req.user) }, order: [['created_at', 'DESC']], limit: 200 });
  await refresh(req, rows);
  res.json({ success: true, imports: rows.map(view) });
});

const get = asyncHandler(async (req, res) => {
  const row = await ownImport(req);
  await refresh(req, [row]);
  res.json({ success: true, import: view(row) });
});

const reindex = asyncHandler(async (req, res) => {
  const row = await ownImport(req);
  if (['queued', 'indexing'].includes(row.status)) return res.json({ success: true, import: view(row) });
  await row.update({ status: 'queued', progress: 0, tracks: 0, error: null });
  await startIndex(req, row);
  audit('investigate.import_reindex', { req, targetType: 'import', targetId: row.id });
  return res.json({ success: true, import: view(row) });
});

const video = asyncHandler(async (req, res) => {
  const row = await ownImport(req);
  const p = path.resolve(row.path);
  if (!p.startsWith(path.resolve(IMPORTS_DIR) + path.sep) || !fs.existsSync(p)) throw new AppError('The file is no longer on the server.', 410);
  if (!req.headers.range) audit('investigate.import_play', { req, targetType: 'import', targetId: row.id });
  res.sendFile(p, { headers: { 'Cache-Control': 'private, max-age=300', 'X-Content-SHA256': row.sha256 } });
});

const remove = asyncHandler(async (req, res) => {
  const row = await ownImport(req);
  try {
    await ai.delete(`/investigate/imports/${row.id}`, { headers: aiAuthHeader(req.user) });
  } catch (e) {
    logger.warn('imports: AI delete failed', { id: row.id, error: e.message });
    // With the index off the AI can't remove this video's people; retrying won't help until it's on.
    if (isIndexOff(e)) throw indexOffError();
    throw AppError.public('Could not remove the indexed people for this video. Try again.', 502);
  }
  fs.rmSync(path.dirname(row.path), { recursive: true, force: true });
  audit('investigate.import_delete', { req, targetType: 'import', targetId: row.id, meta: { sha256: row.sha256, name: row.originalName } });
  await row.destroy();
  res.json({ success: true });
});

/** The account's imports as cameras for search scoping: [{ code: 'file:<id>', name }]. */
async function importCameras(user) {
  const rows = await models().VideoImport.findAll({ where: { userId: ownerId(user) }, attributes: ['id', 'title'] });
  return rows.map((r) => ({ code: `file:${r.id}`, name: r.title }));
}

module.exports = { create, list, get, reindex, video, remove, importCameras, IMPORTS_DIR, _internals: { videoFacts } };
